import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { calculateFoodOrderTotals } from '../../../shared/pricing.js';
import { guestFoodOrderCreateSchema, guestFoodQrConfigUpdateSchema, } from '../../../shared/schemas.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { hashSessionToken } from '../../security/password.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import { mapPropertyRow } from '../../services/mappers.js';
import { allocateNextFoodOrderReference, resolveAndValidateOrderItemsInTx, } from './restaurant.service.js';
export const GUEST_TRACKING_TTL_HOURS = 48;
export const GENERIC_ROOM_INELIGIBLE_MESSAGE = 'Unable to place an order for the entered room number. Please verify your room number or contact the front desk for assistance.';
export const PAYMENT_AT_HOTEL_NOTICE = 'No online payment required — charges are settled at the hotel or through your room folio.';
const QR_TOKEN_REGEX = /^[a-fA-F0-9]{24,64}$/;
const TRACKING_TOKEN_REGEX = /^[a-fA-F0-9]{64}$/;
const ROOM_ORDER_WINDOW_MS = 10 * 60 * 1000;
const MAX_ORDERS_PER_ROOM_WINDOW = 6;
const roomOrderTimestamps = new Map();
export function resetRoomOrderRateBuckets() {
    roomOrderTimestamps.clear();
}
function checkRoomOrderBurst(roomKey, now = Date.now()) {
    const existing = roomOrderTimestamps.get(roomKey) ?? [];
    const active = existing.filter((ts) => now - ts < ROOM_ORDER_WINDOW_MS);
    if (active.length === 0) {
        roomOrderTimestamps.delete(roomKey);
    }
    else {
        roomOrderTimestamps.set(roomKey, active);
    }
    if (active.length >= MAX_ORDERS_PER_ROOM_WINDOW) {
        return Math.max(1, Math.ceil((ROOM_ORDER_WINDOW_MS - (now - active[0])) / 1000));
    }
    return null;
}
function recordRoomOrderPlaced(roomKey, now = Date.now()) {
    if (!roomOrderTimestamps.has(roomKey) && roomOrderTimestamps.size >= 5000) {
        const oldest = roomOrderTimestamps.keys().next().value;
        if (oldest !== undefined)
            roomOrderTimestamps.delete(oldest);
    }
    const active = (roomOrderTimestamps.get(roomKey) ?? []).filter((ts) => now - ts < ROOM_ORDER_WINDOW_MS);
    active.push(now);
    roomOrderTimestamps.set(roomKey, active);
}
async function buildQrConfigResponse(row, urlContext) {
    const qrToken = String(row.guest_qr_token).trim().toLowerCase();
    const guestMenuPath = `/guest/menu/${qrToken}`;
    let guestMenuUrl = null;
    let qrSvg = null;
    if (urlContext.qrReady && urlContext.baseUrl) {
        guestMenuUrl = `${urlContext.baseUrl}${guestMenuPath}`;
        qrSvg = await QRCode.toString(guestMenuUrl, {
            type: 'svg',
            margin: 2,
            width: 280,
            errorCorrectionLevel: 'M',
            color: {
                dark: '#0f172a',
                light: '#ffffff',
            },
        });
    }
    return {
        propertyId: String(row.id),
        propertyName: String(row.name),
        propertyCode: String(row.code),
        enabled: Boolean(row.guest_qr_enabled),
        qrToken,
        guestMenuPath,
        urlMode: urlContext.urlMode,
        qrReady: urlContext.qrReady,
        guestMenuUrl,
        qrSvg,
        configurationNotice: urlContext.configurationNotice,
        configurationError: urlContext.configurationError,
        configuredPublicAppUrl: urlContext.configuredPublicAppUrl,
        canConfigureDevUrl: urlContext.canConfigureDevUrl,
    };
}
export async function getPropertyQrFoodConfig(propertyId, urlContext) {
    const pool = getPool();
    const res = await pool.query(`SELECT id, name, code, guest_qr_token, guest_qr_enabled
     FROM properties
     WHERE id = $1 AND is_active = TRUE
     LIMIT 1`, [propertyId]);
    if (res.rowCount === 0) {
        throw AppError.notFound('Property not found');
    }
    return buildQrConfigResponse(res.rows[0], urlContext);
}
export async function updatePropertyQrFoodConfig(property, actorUser, rawInput, urlContext) {
    if (actorUser.role !== 'admin') {
        throw AppError.forbidden('Administrator role is required to update guest QR ordering settings.');
    }
    const input = guestFoodQrConfigUpdateSchema.parse(rawInput);
    const updatedRow = await withTransaction(async (client) => {
        const updRes = await client.query(`UPDATE properties
       SET guest_qr_enabled = $1,
           updated_at = NOW()
       WHERE id = $2 AND is_active = TRUE
       RETURNING id, name, code, guest_qr_token, guest_qr_enabled`, [input.enabled, property.id]);
        if (updRes.rowCount === 0) {
            throw AppError.notFound('Property not found');
        }
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'property',
            entityId: property.id,
            action: 'guest_qr_updated',
            summary: `${input.enabled ? 'Enabled' : 'Disabled'} guest QR food ordering for ${property.name}`,
            payload: { enabled: input.enabled },
        }, client);
        return updRes.rows[0];
    });
    return buildQrConfigResponse(updatedRow, urlContext);
}
export async function regeneratePropertyQrFoodToken(property, actorUser, urlContext) {
    if (actorUser.role !== 'admin') {
        throw AppError.forbidden('Administrator role is required to rotate the hotel QR ordering link.');
    }
    const nextToken = crypto.randomBytes(16).toString('hex');
    const updatedRow = await withTransaction(async (client) => {
        const updRes = await client.query(`UPDATE properties
       SET guest_qr_token = $1,
           updated_at = NOW()
       WHERE id = $2 AND is_active = TRUE
       RETURNING id, name, code, guest_qr_token, guest_qr_enabled`, [nextToken, property.id]);
        if (updRes.rowCount === 0) {
            throw AppError.notFound('Property not found');
        }
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'property',
            entityId: property.id,
            action: 'guest_qr_regenerated',
            summary: `Rotated common guest QR food ordering link for ${property.name}`,
        }, client);
        return updRes.rows[0];
    });
    return buildQrConfigResponse(updatedRow, urlContext);
}
function normalizeAndValidateQrToken(rawQrToken) {
    if (typeof rawQrToken !== 'string') {
        throw AppError.notFound('Hotel menu link is invalid or no longer active.');
    }
    const trimmed = rawQrToken.trim().toLowerCase();
    if (!QR_TOKEN_REGEX.test(trimmed)) {
        throw AppError.notFound('Hotel menu link is invalid or no longer active.');
    }
    return trimmed;
}
export async function getPublicGuestMenuByQrToken(rawQrToken) {
    const qrToken = normalizeAndValidateQrToken(rawQrToken);
    const pool = getPool();
    const propRes = await pool.query(`SELECT *
     FROM properties
     WHERE LOWER(guest_qr_token) = $1
       AND is_active = TRUE
     LIMIT 1`, [qrToken]);
    if (propRes.rowCount === 0) {
        throw AppError.notFound('Hotel menu link is invalid or no longer active.');
    }
    const propRow = propRes.rows[0];
    if (!propRow.guest_qr_enabled) {
        throw AppError.forbidden('Self-service QR food ordering is currently paused for this hotel. Please contact the front desk or room service.');
    }
    const propertyId = String(propRow.id);
    const [catRes, itemsRes] = await Promise.all([
        pool.query(`SELECT c.id, c.name, c.description, c.display_order
       FROM food_categories c
       WHERE c.property_id = $1
         AND c.is_active = TRUE
         AND EXISTS (
           SELECT 1
           FROM food_menu_items m
           WHERE m.category_id = c.id
             AND m.property_id = c.property_id
             AND m.is_active = TRUE
             AND m.is_available = TRUE
         )
       ORDER BY c.display_order ASC, c.name ASC`, [propertyId]),
        pool.query(`SELECT m.id,
              m.category_id,
              c.name AS category_name,
              m.name,
              m.description,
              m.price,
              m.dietary_tag,
              m.prep_time_minutes,
              m.display_order
       FROM food_menu_items m
       JOIN food_categories c
         ON c.id = m.category_id AND c.property_id = m.property_id
       WHERE m.property_id = $1
         AND m.is_active = TRUE
         AND m.is_available = TRUE
         AND c.is_active = TRUE
       ORDER BY c.display_order ASC, m.display_order ASC, m.name ASC`, [propertyId]),
    ]);
    return {
        hotel: {
            name: String(propRow.name),
            code: String(propRow.code),
            city: String(propRow.city ?? ''),
            currency: String(propRow.currency ?? 'INR').trim(),
            taxName: String(propRow.tax_name ?? 'GST'),
            defaultTaxRate: Number(propRow.default_tax_rate ?? 0),
            phone: String(propRow.phone ?? ''),
        },
        categories: catRes.rows.map((row) => ({
            id: String(row.id),
            name: String(row.name),
            description: String(row.description ?? ''),
            displayOrder: Number(row.display_order ?? 0),
        })),
        items: itemsRes.rows.map((row) => ({
            id: String(row.id),
            categoryId: String(row.category_id),
            categoryName: String(row.category_name ?? ''),
            name: String(row.name),
            description: String(row.description ?? ''),
            price: Number(row.price),
            dietaryTag: row.dietary_tag,
            prepTimeMinutes: row.prep_time_minutes !== null && row.prep_time_minutes !== undefined
                ? Number(row.prep_time_minutes)
                : null,
            displayOrder: Number(row.display_order ?? 0),
        })),
    };
}
function mapPublicOrderView(orderRow, itemRows, hotelName, roomNumber) {
    const items = itemRows.map((row) => ({
        itemName: String(row.item_name_snapshot),
        categoryName: String(row.category_name_snapshot ?? ''),
        quantity: Number(row.quantity),
        unitPrice: Number(row.unit_price),
        lineSubtotal: Number(row.line_subtotal),
        specialInstructions: String(row.special_instructions ?? ''),
    }));
    return {
        hotelName,
        orderReference: String(orderRow.order_reference),
        status: orderRow.status,
        roomNumber,
        items,
        subtotal: Number(orderRow.subtotal),
        taxName: String(orderRow.tax_name ?? 'GST'),
        taxRate: Number(orderRow.tax_rate ?? 0),
        taxAmount: Number(orderRow.tax_amount ?? 0),
        totalAmount: Number(orderRow.total_amount ?? 0),
        currency: String(orderRow.currency ?? 'INR').trim(),
        notes: String(orderRow.notes ?? ''),
        paymentNotice: PAYMENT_AT_HOTEL_NOTICE,
        placedAt: new Date(orderRow.placed_at).toISOString(),
        preparingAt: orderRow.preparing_at
            ? new Date(orderRow.preparing_at).toISOString()
            : null,
        readyAt: orderRow.ready_at
            ? new Date(orderRow.ready_at).toISOString()
            : null,
        servedAt: orderRow.served_at
            ? new Date(orderRow.served_at).toISOString()
            : null,
        cancelledAt: orderRow.cancelled_at
            ? new Date(orderRow.cancelled_at).toISOString()
            : null,
    };
}
export async function createPublicGuestFoodOrder(rawQrToken, rawInput, options = {}) {
    const qrToken = normalizeAndValidateQrToken(rawQrToken);
    const input = guestFoodOrderCreateSchema.parse(rawInput);
    return withTransaction(async (client) => {
        const propRes = await client.query(`SELECT *
       FROM properties
       WHERE LOWER(guest_qr_token) = $1
         AND is_active = TRUE
       LIMIT 1`, [qrToken]);
        if (propRes.rowCount === 0) {
            throw AppError.notFound('Hotel menu link is invalid or no longer active.');
        }
        const propRow = propRes.rows[0];
        if (!propRow.guest_qr_enabled) {
            throw AppError.forbidden('Self-service QR food ordering is currently paused for this hotel. Please contact the front desk or room service.');
        }
        const property = mapPropertyRow(propRow);
        // 1. Resolve physical room strictly within the QR-authenticated property
        const roomRes = await client.query(`SELECT id, room_number, is_active, operational_status
       FROM rooms
       WHERE property_id = $1
         AND UPPER(BTRIM(room_number)) = UPPER(BTRIM($2))
       LIMIT 1`, [property.id, input.roomNumber]);
        const roomRow = roomRes.rows[0];
        if (!roomRow ||
            !roomRow.is_active ||
            roomRow.operational_status !== 'available') {
            options.onRoomValidationFailure?.();
            throw new AppError(403, GENERIC_ROOM_INELIGIBLE_MESSAGE, 'ROOM_NOT_ELIGIBLE');
        }
        // 2. Verify active in-house Checked-In occupancy on this room (rejects vacant,
        //    pending/confirmed pre-arrival, checked-out, or cancelled stays identically)
        const occRes = await client.query(`SELECT r.id AS reservation_id,
              r.guest_id,
              g.first_name,
              g.last_name
       FROM reservations r
       JOIN guests g ON g.id = r.guest_id AND g.property_id = r.property_id
       WHERE r.property_id = $1
         AND r.room_id = $2
         AND r.status = 'checked_in'
       ORDER BY r.checked_in_at DESC NULLS LAST, r.created_at DESC
       LIMIT 1
       FOR UPDATE OF r`, [property.id, roomRow.id]);
        if (occRes.rowCount === 0) {
            options.onRoomValidationFailure?.();
            throw new AppError(403, GENERIC_ROOM_INELIGIBLE_MESSAGE, 'ROOM_NOT_ELIGIBLE');
        }
        const activeStay = occRes.rows[0];
        const roomBurstKey = `${property.id}:${roomRow.id}`;
        const retryAfterSec = checkRoomOrderBurst(roomBurstKey);
        if (retryAfterSec !== null) {
            throw new AppError(429, 'Too many orders submitted for this room in a short period. Please wait a few minutes or contact room service.', 'RATE_LIMITED', { retryAfterSeconds: retryAfterSec });
        }
        const scopedIdempotencyKey = input.idempotencyKey
            ? `gqr:${roomRow.id}:${input.idempotencyKey}`.slice(0, 100)
            : null;
        if (scopedIdempotencyKey) {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))', [property.id, scopedIdempotencyKey]);
            const dupRes = await client.query(`SELECT *
         FROM food_orders
         WHERE property_id = $1 AND idempotency_key = $2
         LIMIT 1`, [property.id, scopedIdempotencyKey]);
            if ((dupRes.rowCount ?? 0) > 0) {
                const existingOrder = dupRes.rows[0];
                const existingItemsRes = await client.query(`SELECT *
           FROM food_order_items
           WHERE order_id = $1
           ORDER BY sort_order ASC`, [existingOrder.id]);
                const normIncoming = [...input.items]
                    .map((i) => `${i.menuItemId.toLowerCase()}:${i.quantity}:${i.specialInstructions.trim()}`)
                    .sort()
                    .join('|');
                const normExisting = existingItemsRes.rows
                    .map((r) => `${String(r.menu_item_id).toLowerCase()}:${Number(r.quantity)}:${String(r.special_instructions ?? '').trim()}`)
                    .sort()
                    .join('|');
                const samePayload = String(existingOrder.room_id) === String(roomRow.id) &&
                    String(existingOrder.reservation_id) ===
                        String(activeStay.reservation_id) &&
                    String(existingOrder.notes ?? '').trim() === input.notes.trim() &&
                    normIncoming === normExisting;
                if (!samePayload) {
                    throw AppError.conflict('This order submission token was already used for a different order.');
                }
                const freshTrackingToken = crypto.randomBytes(32).toString('hex');
                const freshTrackingHash = hashSessionToken(freshTrackingToken);
                const freshExpiresAt = new Date(Date.now() + GUEST_TRACKING_TTL_HOURS * 3600 * 1000);
                await client.query(`UPDATE food_orders
           SET guest_tracking_token_hash = $1,
               guest_tracking_expires_at = $2
           WHERE id = $3 AND property_id = $4`, [
                    freshTrackingHash,
                    freshExpiresAt.toISOString(),
                    existingOrder.id,
                    property.id,
                ]);
                return {
                    created: false,
                    payload: {
                        order: mapPublicOrderView(existingOrder, existingItemsRes.rows, property.name, String(roomRow.room_number)),
                        trackingToken: freshTrackingToken,
                        trackingExpiresAt: freshExpiresAt.toISOString(),
                    },
                };
            }
        }
        // 3. Server-authoritative menu item validation & pricing calculation
        const resolvedItems = await resolveAndValidateOrderItemsInTx(client, property.id, input.items);
        const totals = calculateFoodOrderTotals(resolvedItems.map((it) => ({
            quantity: it.quantity,
            unitPrice: it.unitPrice,
        })), property.defaultTaxRate);
        const orderReference = await allocateNextFoodOrderReference(client, property);
        const rawTrackingToken = crypto.randomBytes(32).toString('hex');
        const trackingHash = hashSessionToken(rawTrackingToken);
        const trackingExpiresAt = new Date(Date.now() + GUEST_TRACKING_TTL_HOURS * 3600 * 1000);
        const internalCustomerName = `${activeStay.first_name ?? ''} ${activeStay.last_name ?? ''}`.trim();
        const insertOrder = await client.query(`INSERT INTO food_orders (
         property_id, order_reference, order_type, order_source, status,
         table_label, customer_name, reservation_id, room_id, guest_id,
         subtotal, tax_name, tax_rate, tax_amount, total_amount, currency,
         notes, billing_status, idempotency_key,
         guest_tracking_token_hash, guest_tracking_expires_at,
         created_by, updated_by
       ) VALUES (
         $1, $2, 'room_service', 'guest_qr', 'pending',
         '', $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12,
         $13, 'unbilled', $14,
         $15, $16,
         NULL, NULL
       ) RETURNING *`, [
            property.id,
            orderReference,
            internalCustomerName,
            activeStay.reservation_id,
            roomRow.id,
            activeStay.guest_id,
            totals.subtotal.toFixed(2),
            property.taxName,
            totals.taxRate.toFixed(2),
            totals.taxAmount.toFixed(2),
            totals.totalAmount.toFixed(2),
            property.currency,
            input.notes,
            scopedIdempotencyKey,
            trackingHash,
            trackingExpiresAt.toISOString(),
        ]);
        const createdOrderRow = insertOrder.rows[0];
        const newOrderId = String(createdOrderRow.id);
        const insertedItems = [];
        for (let idx = 0; idx < resolvedItems.length; idx++) {
            const item = resolvedItems[idx];
            const itemRes = await client.query(`INSERT INTO food_order_items (
           order_id, menu_item_id, item_name_snapshot, category_name_snapshot,
           quantity, unit_price, line_subtotal, special_instructions, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`, [
                newOrderId,
                item.menuItemId,
                item.itemNameSnapshot,
                item.categoryNameSnapshot,
                item.quantity,
                item.unitPrice.toFixed(2),
                totals.lineSubtotals[idx].toFixed(2),
                item.specialInstructions,
                (idx + 1) * 10,
            ]);
            insertedItems.push(itemRes.rows[0]);
        }
        await client.query(`INSERT INTO food_order_status_history (
         order_id, property_id, from_status, to_status, note, changed_by
       ) VALUES ($1, $2, NULL, 'pending', $3, NULL)`, [
            newOrderId,
            property.id,
            `Order ${orderReference} placed via Guest QR Menu (Room ${roomRow.room_number})`,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: null,
            entityType: 'food_order',
            entityId: newOrderId,
            action: 'created_guest_qr',
            summary: `Guest QR self-service order ${orderReference} placed for Room ${roomRow.room_number} (${totals.totalAmount.toFixed(2)} ${property.currency})`,
            payload: {
                orderReference,
                orderType: 'room_service',
                orderSource: 'guest_qr',
                roomId: roomRow.id,
                roomNumber: roomRow.room_number,
                reservationId: activeStay.reservation_id,
                totalAmount: totals.totalAmount,
            },
        }, client);
        recordRoomOrderPlaced(roomBurstKey);
        return {
            created: true,
            payload: {
                order: mapPublicOrderView(createdOrderRow, insertedItems, property.name, String(roomRow.room_number)),
                trackingToken: rawTrackingToken,
                trackingExpiresAt: trackingExpiresAt.toISOString(),
            },
        };
    });
}
export async function getPublicGuestOrderTracking(rawTrackingToken) {
    if (typeof rawTrackingToken !== 'string' ||
        !TRACKING_TOKEN_REGEX.test(rawTrackingToken.trim())) {
        throw AppError.notFound('Order tracking link is invalid or has expired.');
    }
    const tokenHash = hashSessionToken(rawTrackingToken.trim().toLowerCase());
    const pool = getPool();
    const orderRes = await pool.query(`SELECT o.*,
            p.name AS property_name,
            p.is_active AS property_is_active,
            rm.room_number,
            r.status AS reservation_status,
            r.checked_out_at
     FROM food_orders o
     JOIN properties p ON p.id = o.property_id
     LEFT JOIN rooms rm ON rm.id = o.room_id
     LEFT JOIN reservations r ON r.id = o.reservation_id
     WHERE o.guest_tracking_token_hash = $1
       AND o.order_source = 'guest_qr'
     LIMIT 1`, [tokenHash]);
    if (orderRes.rowCount === 0) {
        throw AppError.notFound('Order tracking link is invalid or has expired.');
    }
    const row = orderRes.rows[0];
    const now = Date.now();
    const expiresAtMs = row.guest_tracking_expires_at
        ? new Date(row.guest_tracking_expires_at).getTime()
        : 0;
    // Expire tracking links after configured TTL OR 6 hours after stay check-out
    const checkedOutExpired = row.reservation_status === 'checked_out' &&
        row.checked_out_at &&
        now - new Date(row.checked_out_at).getTime() > 6 * 3600 * 1000;
    if (!row.property_is_active || expiresAtMs <= now || checkedOutExpired) {
        throw AppError.notFound('Order tracking link is invalid or has expired.');
    }
    const itemsRes = await pool.query(`SELECT item_name_snapshot,
            category_name_snapshot,
            quantity,
            unit_price,
            line_subtotal,
            special_instructions
     FROM food_order_items
     WHERE order_id = $1
     ORDER BY sort_order ASC, created_at ASC`, [row.id]);
    return {
        order: mapPublicOrderView(row, itemsRes.rows, String(row.property_name), String(row.room_number ?? '')),
        trackingExpiresAt: new Date(row.guest_tracking_expires_at).toISOString(),
    };
}
