import crypto from 'node:crypto';
import { canTransitionServiceRequestStatus, SERVICE_BILLING_STATUSES, SERVICE_CATEGORIES, SERVICE_REQUEST_STATUSES, } from '../../../shared/constants.js';
import { getPropertyLocalDate, isValidIsoDate } from '../../../shared/dates.js';
import { roundCurrency } from '../../../shared/pricing.js';
import { serviceCatalogCreateSchema, serviceCatalogUpdateSchema, serviceRequestCancelSchema, serviceRequestCreateSchema, serviceRequestPostToInvoiceSchema, serviceRequestStatusUpdateSchema, serviceRequestUpdateSchema, } from '../../../shared/schemas.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import { ensureAndSyncReservationInvoiceInTx, getInvoiceDetail, recomputeAndPersistInvoiceInTx, } from '../invoices/invoices.service.js';
function computeServiceRequestAmounts(quantity, unitPrice, taxRate) {
    const subtotal = roundCurrency(quantity * unitPrice);
    const taxAmount = roundCurrency((subtotal * taxRate) / 100);
    const totalAmount = roundCurrency(subtotal + taxAmount);
    return { subtotal, taxAmount, totalAmount };
}
function buildRequestFingerprint(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
async function allocateNextServiceRequestNumber(client, property) {
    const res = await client.query(`INSERT INTO property_service_request_counters (property_id, next_number)
     VALUES ($1, 1002)
     ON CONFLICT (property_id)
     DO UPDATE SET next_number = property_service_request_counters.next_number + 1
     RETURNING (next_number - 1)::text AS next_number`, [property.id]);
    const seq = Number(res.rows[0]?.next_number ?? 1001);
    return `${property.code}-SVC-${seq}`;
}
function mapServiceCatalogRow(row, propertyDefaultTaxRate) {
    const usePropTax = Boolean(row.use_property_tax_rate ?? true);
    const storedTax = Number(row.tax_rate ?? 0);
    const effectiveTaxRate = usePropTax ? propertyDefaultTaxRate : storedTax;
    return {
        id: String(row.id),
        propertyId: String(row.property_id),
        code: String(row.code),
        name: String(row.name),
        description: String(row.description ?? ''),
        category: row.category,
        unitPrice: Number(row.unit_price),
        pricingUnit: (row.pricing_unit ?? 'per_request'),
        usePropertyTaxRate: usePropTax,
        taxRate: storedTax,
        effectiveTaxRate,
        isActive: Boolean(row.is_active),
        totalRequestsCount: Number(row.total_requests_count ?? 0),
        openRequestsCount: Number(row.open_requests_count ?? 0),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
function mapServiceRequestRow(row) {
    const guestFull = [row.guest_first_name, row.guest_last_name]
        .filter(Boolean)
        .join(' ')
        .trim();
    const staffName = row.staff_full_name ??
        (row.assigned_staff_name_snapshot
            ? String(row.assigned_staff_name_snapshot)
            : null);
    return {
        id: String(row.id),
        propertyId: String(row.property_id),
        requestNumber: String(row.request_number),
        serviceId: String(row.service_id),
        serviceCodeSnapshot: String(row.service_code_snapshot),
        serviceNameSnapshot: String(row.service_name_snapshot),
        categorySnapshot: row.category_snapshot,
        pricingUnitSnapshot: (row.pricing_unit_snapshot ??
            'per_request'),
        serviceIsActive: Boolean(row.service_is_active ?? true),
        reservationId: row.reservation_id ? String(row.reservation_id) : null,
        bookingReference: row.booking_reference ? String(row.booking_reference) : null,
        reservationStatus: row.reservation_status ?? null,
        guestId: row.guest_id ? String(row.guest_id) : null,
        guestName: guestFull || null,
        guestPhone: row.guest_phone ? String(row.guest_phone) : null,
        roomId: row.room_id ? String(row.room_id) : null,
        roomNumber: row.room_number ? String(row.room_number) : null,
        assignedStaffId: row.assigned_staff_id ? String(row.assigned_staff_id) : null,
        assignedStaffName: staffName || null,
        assignedStaffDepartment: row.staff_department ?? null,
        assignedStaffEmploymentStatus: row.staff_employment_status ?? null,
        quantity: Number(row.quantity),
        unitPrice: Number(row.unit_price),
        subtotal: Number(row.subtotal),
        taxName: String(row.tax_name ?? 'GST'),
        taxRate: Number(row.tax_rate ?? 0),
        taxAmount: Number(row.tax_amount ?? 0),
        totalAmount: Number(row.total_amount ?? 0),
        currency: String(row.currency ?? 'INR').trim(),
        status: row.status,
        requestedFor: new Date(row.requested_for).toISOString(),
        notes: String(row.notes ?? ''),
        billingStatus: row.billing_status,
        postedInvoiceId: row.posted_invoice_id ? String(row.posted_invoice_id) : null,
        postedInvoiceNumber: row.posted_invoice_number
            ? String(row.posted_invoice_number)
            : null,
        postedInvoiceStatus: row.posted_invoice_status ?? null,
        postedLineItemId: row.posted_line_item_id ? String(row.posted_line_item_id) : null,
        postedServiceChargeId: row.posted_service_charge_id
            ? String(row.posted_service_charge_id)
            : null,
        postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
        postedByName: row.posted_by_name ? String(row.posted_by_name) : null,
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        startedByName: row.started_by_name ? String(row.started_by_name) : null,
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        completedByName: row.completed_by_name ? String(row.completed_by_name) : null,
        cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
        cancelledByName: row.cancelled_by_name ? String(row.cancelled_by_name) : null,
        cancelReason: String(row.cancel_reason ?? ''),
        createdByName: row.created_by_name ? String(row.created_by_name) : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
function mapServiceRequestHistoryRow(row) {
    return {
        id: String(row.id),
        serviceRequestId: String(row.service_request_id),
        propertyId: String(row.property_id),
        action: row.action,
        fromStatus: row.from_status ?? null,
        toStatus: row.to_status ?? null,
        note: String(row.note ?? ''),
        metadata: row.metadata ?? {},
        actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
        actorName: row.actor_name ? String(row.actor_name) : null,
        createdAt: new Date(row.created_at).toISOString(),
    };
}
const SERVICE_REQUEST_SELECT_SQL = `
  SELECT sr.*,
         sc.is_active AS service_is_active,
         r.booking_reference,
         r.status AS reservation_status,
         g.first_name AS guest_first_name,
         g.last_name AS guest_last_name,
         g.phone AS guest_phone,
         rm.room_number,
         sp.full_name AS staff_full_name,
         sp.department AS staff_department,
         sp.employment_status AS staff_employment_status,
         inv.invoice_number AS posted_invoice_number,
         inv.status AS posted_invoice_status,
         u_post.full_name AS posted_by_name,
         u_start.full_name AS started_by_name,
         u_comp.full_name AS completed_by_name,
         u_canc.full_name AS cancelled_by_name,
         u_create.full_name AS created_by_name
  FROM service_requests sr
  JOIN service_catalog sc
    ON sc.id = sr.service_id AND sc.property_id = sr.property_id
  LEFT JOIN reservations r
    ON r.id = sr.reservation_id AND r.property_id = sr.property_id
  LEFT JOIN guests g
    ON g.id = sr.guest_id AND g.property_id = sr.property_id
  LEFT JOIN rooms rm
    ON rm.id = sr.room_id AND rm.property_id = sr.property_id
  LEFT JOIN property_staff_profiles sp
    ON sp.id = sr.assigned_staff_id AND sp.property_id = sr.property_id
  LEFT JOIN invoices inv
    ON inv.id = sr.posted_invoice_id AND inv.property_id = sr.property_id
  LEFT JOIN users u_post ON u_post.id = sr.posted_by
  LEFT JOIN users u_start ON u_start.id = sr.started_by
  LEFT JOIN users u_comp ON u_comp.id = sr.completed_by
  LEFT JOIN users u_canc ON u_canc.id = sr.cancelled_by
  LEFT JOIN users u_create ON u_create.id = sr.created_by
`;
export async function listServiceCatalog(property, filter = {}) {
    const pool = getPool();
    const params = [property.id];
    const conditions = ['sc.property_id = $1'];
    if (!filter.includeInactive) {
        conditions.push('sc.is_active = TRUE');
    }
    if (filter.category) {
        if (!SERVICE_CATEGORIES.includes(filter.category)) {
            throw AppError.badRequest(`Invalid service category filter: "${filter.category}"`);
        }
        params.push(filter.category);
        conditions.push(`sc.category = $${params.length}`);
    }
    if (filter.search && filter.search.trim().length > 0) {
        const q = `%${filter.search.trim()}%`;
        params.push(q);
        conditions.push(`(sc.name ILIKE $${params.length} OR sc.code ILIKE $${params.length} OR sc.description ILIKE $${params.length})`);
    }
    const res = await pool.query(`SELECT sc.*,
            COUNT(sr.id)::int AS total_requests_count,
            COUNT(sr.id) FILTER (WHERE sr.status IN ('requested', 'in_progress'))::int AS open_requests_count
     FROM service_catalog sc
     LEFT JOIN service_requests sr
       ON sr.service_id = sc.id AND sr.property_id = sc.property_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY sc.id
     ORDER BY sc.is_active DESC, sc.category ASC, sc.name ASC
     LIMIT 300`, params);
    return res.rows.map((r) => mapServiceCatalogRow(r, property.defaultTaxRate));
}
export async function getServiceCatalogItemById(property, serviceId, db = getPool()) {
    const res = await db.query(`SELECT sc.*,
            COUNT(sr.id)::int AS total_requests_count,
            COUNT(sr.id) FILTER (WHERE sr.status IN ('requested', 'in_progress'))::int AS open_requests_count
     FROM service_catalog sc
     LEFT JOIN service_requests sr
       ON sr.service_id = sc.id AND sr.property_id = sc.property_id
     WHERE sc.property_id = $1 AND sc.id = $2
     GROUP BY sc.id`, [property.id, serviceId]);
    if (res.rowCount === 0) {
        throw AppError.notFound('Hotel service not found in this property');
    }
    return mapServiceCatalogRow(res.rows[0], property.defaultTaxRate);
}
export async function createServiceCatalogItem(property, actorUser, rawInput) {
    const input = serviceCatalogCreateSchema.parse(rawInput);
    const serviceId = await withTransaction(async (client) => {
        const effectiveTax = input.usePropertyTaxRate
            ? property.defaultTaxRate
            : input.taxRate;
        const ins = await client.query(`INSERT INTO service_catalog (
         property_id, code, name, description, category,
         unit_price, pricing_unit, use_property_tax_rate, tax_rate,
         is_active, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $11
       ) RETURNING id`, [
            property.id,
            input.code,
            input.name,
            input.description,
            input.category,
            roundCurrency(input.unitPrice).toFixed(2),
            input.pricingUnit,
            input.usePropertyTaxRate,
            roundCurrency(effectiveTax).toFixed(2),
            input.isActive,
            actorUser.id,
        ]);
        const id = ins.rows[0].id;
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'service_catalog',
            entityId: id,
            action: 'created',
            summary: `Created hotel service "${input.name}" (${input.code})`,
            payload: {
                code: input.code,
                category: input.category,
                unitPrice: roundCurrency(input.unitPrice),
                pricingUnit: input.pricingUnit,
                usePropertyTaxRate: input.usePropertyTaxRate,
                taxRate: roundCurrency(effectiveTax),
                isActive: input.isActive,
            },
        }, client);
        return id;
    });
    return getServiceCatalogItemById(property, serviceId);
}
export async function updateServiceCatalogItem(property, serviceId, actorUser, rawInput) {
    const input = serviceCatalogUpdateSchema.parse(rawInput);
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM service_catalog WHERE id = $1 AND property_id = $2 FOR UPDATE', [serviceId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Hotel service not found in this property');
        }
        const existing = existingRes.rows[0];
        const nextCode = input.code ?? String(existing.code);
        const nextName = input.name ?? String(existing.name);
        const nextDescription = input.description !== undefined ? input.description : String(existing.description ?? '');
        const nextCategory = input.category ?? String(existing.category);
        const nextPrice = input.unitPrice !== undefined ? roundCurrency(input.unitPrice) : Number(existing.unit_price);
        const nextPricingUnit = input.pricingUnit ?? String(existing.pricing_unit ?? 'per_request');
        const nextUsePropTax = input.usePropertyTaxRate !== undefined
            ? input.usePropertyTaxRate
            : Boolean(existing.use_property_tax_rate ?? true);
        const nextTaxRate = nextUsePropTax
            ? property.defaultTaxRate
            : input.taxRate !== undefined
                ? roundCurrency(input.taxRate)
                : Number(existing.tax_rate ?? 0);
        const nextIsActive = input.isActive !== undefined ? input.isActive : Boolean(existing.is_active);
        await client.query(`UPDATE service_catalog
       SET code = $1,
           name = $2,
           description = $3,
           category = $4,
           unit_price = $5,
           pricing_unit = $6,
           use_property_tax_rate = $7,
           tax_rate = $8,
           is_active = $9,
           updated_by = $10,
           updated_at = NOW()
       WHERE id = $11 AND property_id = $12`, [
            nextCode,
            nextName,
            nextDescription,
            nextCategory,
            nextPrice.toFixed(2),
            nextPricingUnit,
            nextUsePropTax,
            nextTaxRate.toFixed(2),
            nextIsActive,
            actorUser.id,
            serviceId,
            property.id,
        ]);
        const statusChanged = Boolean(existing.is_active) !== nextIsActive;
        const action = statusChanged
            ? nextIsActive
                ? 'activated'
                : 'deactivated'
            : 'updated';
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'service_catalog',
            entityId: serviceId,
            action,
            summary: statusChanged
                ? `${nextIsActive ? 'Activated' : 'Deactivated'} hotel service "${nextName}" (${nextCode})`
                : `Updated hotel service "${nextName}" (${nextCode})`,
            payload: {
                previousPrice: Number(existing.unit_price),
                unitPrice: nextPrice,
                previousActive: Boolean(existing.is_active),
                isActive: nextIsActive,
                usePropertyTaxRate: nextUsePropTax,
                taxRate: nextTaxRate,
            },
        }, client);
    });
    return getServiceCatalogItemById(property, serviceId);
}
// ============================================================================
// 2. ELIGIBLE STAYS & SAME-PROPERTY REFERENCE VALIDATION
// ============================================================================
export async function listEligibleServiceStays(propertyId) {
    const pool = getPool();
    const res = await pool.query(`SELECT r.id AS reservation_id,
            r.booking_reference,
            r.status,
            r.room_id,
            rm.room_number,
            rt.name AS room_type_name,
            r.guest_id,
            g.first_name,
            g.last_name,
            g.phone AS guest_phone,
            r.arrival_date::text AS arrival_date,
            r.departure_date::text AS departure_date,
            inv.id AS active_invoice_id,
            inv.invoice_number AS active_invoice_number,
            inv.status AS active_invoice_status
     FROM reservations r
     JOIN room_types rt ON rt.id = r.room_type_id
     JOIN guests g ON g.id = r.guest_id AND g.property_id = r.property_id
     LEFT JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = r.property_id
     LEFT JOIN invoices inv
       ON inv.property_id = r.property_id
      AND inv.reservation_id = r.id
      AND inv.status != 'void'
     WHERE r.property_id = $1
       AND r.status IN ('checked_in', 'confirmed', 'pending')
     ORDER BY
       CASE r.status WHEN 'checked_in' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END ASC,
       r.arrival_date ASC,
       r.booking_reference ASC
     LIMIT 200`, [propertyId]);
    return res.rows.map((row) => ({
        reservationId: String(row.reservation_id),
        bookingReference: String(row.booking_reference),
        status: row.status,
        roomId: row.room_id ? String(row.room_id) : null,
        roomNumber: row.room_number ? String(row.room_number) : null,
        roomTypeName: String(row.room_type_name),
        guestId: String(row.guest_id),
        guestName: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
        guestPhone: String(row.guest_phone ?? ''),
        arrivalDate: String(row.arrival_date).slice(0, 10),
        departureDate: String(row.departure_date).slice(0, 10),
        activeInvoiceId: row.active_invoice_id ? String(row.active_invoice_id) : null,
        activeInvoiceNumber: row.active_invoice_number
            ? String(row.active_invoice_number)
            : null,
        activeInvoiceStatus: row.active_invoice_status ?? null,
    }));
}
async function resolveAndValidateAssignedStaffInTx(client, propertyId, assignedStaffId) {
    if (!assignedStaffId) {
        return { staffId: null, staffName: '' };
    }
    const staffRes = await client.query(`SELECT id, full_name, employment_status
     FROM property_staff_profiles
     WHERE id = $1 AND property_id = $2
     LIMIT 1`, [assignedStaffId, propertyId]);
    if (staffRes.rowCount === 0) {
        throw AppError.badRequest('Selected staff member does not exist in this property.');
    }
    const staff = staffRes.rows[0];
    if (staff.employment_status !== 'active') {
        throw AppError.badRequest(`Staff member "${staff.full_name}" is currently ${staff.employment_status} and cannot be assigned new service requests.`);
    }
    return {
        staffId: String(staff.id),
        staffName: String(staff.full_name),
    };
}
export async function listServiceRequests(property, filter = {}) {
    const pool = getPool();
    const params = [property.id];
    const conditions = ['sr.property_id = $1'];
    if (filter.status) {
        if (!SERVICE_REQUEST_STATUSES.includes(filter.status)) {
            throw AppError.badRequest(`Invalid service request status filter: "${filter.status}"`);
        }
        params.push(filter.status);
        conditions.push(`sr.status = $${params.length}`);
    }
    if (filter.category) {
        if (!SERVICE_CATEGORIES.includes(filter.category)) {
            throw AppError.badRequest(`Invalid service category filter: "${filter.category}"`);
        }
        params.push(filter.category);
        conditions.push(`sr.category_snapshot = $${params.length}`);
    }
    if (filter.billingStatus) {
        if (!SERVICE_BILLING_STATUSES.includes(filter.billingStatus)) {
            throw AppError.badRequest(`Invalid billing status filter: "${filter.billingStatus}"`);
        }
        params.push(filter.billingStatus);
        conditions.push(`sr.billing_status = $${params.length}`);
    }
    if (filter.serviceId) {
        params.push(filter.serviceId);
        conditions.push(`sr.service_id = $${params.length}`);
    }
    if (filter.reservationId) {
        params.push(filter.reservationId);
        conditions.push(`sr.reservation_id = $${params.length}`);
    }
    if (filter.assignedStaffId) {
        if (filter.assignedStaffId === 'unassigned') {
            conditions.push('sr.assigned_staff_id IS NULL');
        }
        else {
            params.push(filter.assignedStaffId);
            conditions.push(`sr.assigned_staff_id = $${params.length}`);
        }
    }
    if (filter.dateFrom) {
        if (!isValidIsoDate(filter.dateFrom)) {
            throw AppError.badRequest('Invalid dateFrom (must be YYYY-MM-DD)');
        }
        params.push(filter.dateFrom);
        params.push(property.timezone);
        conditions.push(`(sr.requested_for AT TIME ZONE $${params.length})::date >= $${params.length - 1}::date`);
    }
    if (filter.dateTo) {
        if (!isValidIsoDate(filter.dateTo)) {
            throw AppError.badRequest('Invalid dateTo (must be YYYY-MM-DD)');
        }
        params.push(filter.dateTo);
        params.push(property.timezone);
        conditions.push(`(sr.requested_for AT TIME ZONE $${params.length})::date <= $${params.length - 1}::date`);
    }
    if (filter.search && filter.search.trim().length > 0) {
        const q = `%${filter.search.trim()}%`;
        params.push(q);
        conditions.push(`(sr.request_number ILIKE $${params.length}
        OR sr.service_name_snapshot ILIKE $${params.length}
        OR r.booking_reference ILIKE $${params.length}
        OR rm.room_number ILIKE $${params.length}
        OR (COALESCE(g.first_name, '') || ' ' || COALESCE(g.last_name, '')) ILIKE $${params.length})`);
    }
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));
    const offset = (page - 1) * pageSize;
    const whereClause = conditions.join(' AND ');
    const countSql = `
    SELECT COUNT(*)::int AS total
    FROM service_requests sr
    LEFT JOIN reservations r ON r.id = sr.reservation_id AND r.property_id = sr.property_id
    LEFT JOIN guests g ON g.id = sr.guest_id AND g.property_id = sr.property_id
    LEFT JOIN rooms rm ON rm.id = sr.room_id AND rm.property_id = sr.property_id
    WHERE ${whereClause}
  `;
    const listParams = [...params, pageSize, offset];
    const listSql = `
    ${SERVICE_REQUEST_SELECT_SQL}
    WHERE ${whereClause}
    ORDER BY
      CASE sr.status
        WHEN 'requested' THEN 0
        WHEN 'in_progress' THEN 1
        WHEN 'completed' THEN 2
        ELSE 3
      END ASC,
      sr.requested_for DESC,
      sr.created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;
    const propertyToday = getPropertyLocalDate(property.timezone);
    const summarySql = `
    SELECT
      COUNT(*) FILTER (WHERE status = 'requested')::int AS requested_count,
      COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_count,
      COUNT(*) FILTER (
        WHERE status = 'completed'
          AND (completed_at AT TIME ZONE $2)::date = $3::date
      )::int AS completed_today_count,
      COUNT(*) FILTER (
        WHERE status = 'cancelled'
          AND (cancelled_at AT TIME ZONE $2)::date = $3::date
      )::int AS cancelled_today_count,
      COUNT(*) FILTER (
        WHERE status = 'completed'
          AND billing_status = 'unbilled'
          AND reservation_id IS NOT NULL
          AND total_amount > 0
      )::int AS unbilled_completed_count,
      COALESCE(SUM(total_amount) FILTER (
        WHERE status = 'completed'
          AND billing_status = 'unbilled'
          AND reservation_id IS NOT NULL
          AND total_amount > 0
      ), 0) AS unbilled_completed_amount,
      COALESCE(SUM(total_amount) FILTER (WHERE billing_status = 'posted'), 0) AS posted_amount_total,
      (SELECT COUNT(*)::int FROM service_catalog WHERE property_id = $1 AND is_active = TRUE) AS active_catalog_count
    FROM service_requests
    WHERE property_id = $1
  `;
    const [countRes, listRes, summaryRes] = await Promise.all([
        pool.query(countSql, params),
        pool.query(listSql, listParams),
        pool.query(summarySql, [property.id, property.timezone, propertyToday]),
    ]);
    const total = Number(countRes.rows[0]?.total ?? 0);
    const sumRow = summaryRes.rows[0] ?? {};
    return {
        items: listRes.rows.map(mapServiceRequestRow),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        summary: {
            requestedCount: Number(sumRow.requested_count ?? 0),
            inProgressCount: Number(sumRow.in_progress_count ?? 0),
            completedTodayCount: Number(sumRow.completed_today_count ?? 0),
            cancelledTodayCount: Number(sumRow.cancelled_today_count ?? 0),
            unbilledCompletedCount: Number(sumRow.unbilled_completed_count ?? 0),
            unbilledCompletedAmount: roundCurrency(Number(sumRow.unbilled_completed_amount ?? 0)),
            postedAmountTotal: roundCurrency(Number(sumRow.posted_amount_total ?? 0)),
            activeCatalogCount: Number(sumRow.active_catalog_count ?? 0),
            currency: property.currency,
        },
    };
}
export async function getServiceRequestDetail(propertyId, requestId) {
    const pool = getPool();
    const [reqRes, histRes] = await Promise.all([
        pool.query(`${SERVICE_REQUEST_SELECT_SQL}
       WHERE sr.property_id = $1 AND sr.id = $2`, [propertyId, requestId]),
        pool.query(`SELECT h.*, u.full_name AS actor_name
       FROM service_request_history h
       LEFT JOIN users u ON u.id = h.actor_user_id
       WHERE h.property_id = $1 AND h.service_request_id = $2
       ORDER BY h.created_at ASC`, [propertyId, requestId]),
    ]);
    if (reqRes.rowCount === 0) {
        throw AppError.notFound('Service request not found in this property');
    }
    return {
        ...mapServiceRequestRow(reqRes.rows[0]),
        history: histRes.rows.map(mapServiceRequestHistoryRow),
    };
}
export async function createServiceRequest(property, actorUser, rawInput) {
    const input = serviceRequestCreateSchema.parse(rawInput);
    const fingerprint = buildRequestFingerprint({
        serviceId: input.serviceId,
        reservationId: input.reservationId,
        guestId: input.guestId,
        roomId: input.roomId,
        quantity: input.quantity,
    });
    const outcome = await withTransaction(async (client) => {
        if (input.idempotencyKey) {
            const existingIdem = await client.query(`SELECT id, service_id, reservation_id, guest_id, room_id, quantity
         FROM service_requests
         WHERE property_id = $1 AND idempotency_key = $2
         FOR UPDATE`, [property.id, input.idempotencyKey]);
            if ((existingIdem.rowCount ?? 0) > 0) {
                const row = existingIdem.rows[0];
                const existingFp = buildRequestFingerprint({
                    serviceId: String(row.service_id),
                    reservationId: row.reservation_id ? String(row.reservation_id) : null,
                    guestId: row.guest_id ? String(row.guest_id) : null,
                    roomId: row.room_id ? String(row.room_id) : null,
                    quantity: Number(row.quantity),
                });
                if (existingFp !== fingerprint) {
                    throw AppError.conflict('Idempotency key was already used with a different service request payload.');
                }
                return { requestId: String(row.id), idempotentReplay: true };
            }
        }
        // 1. Validate catalog service in same property and active status
        const svcRes = await client.query('SELECT * FROM service_catalog WHERE id = $1 AND property_id = $2 FOR SHARE', [input.serviceId, property.id]);
        if (svcRes.rowCount === 0) {
            throw AppError.notFound('Selected hotel service does not exist in this property.');
        }
        const service = svcRes.rows[0];
        if (!service.is_active) {
            throw AppError.badRequest(`Hotel service "${service.name}" is inactive and cannot be used for new service requests.`);
        }
        // 2. Validate reservation, guest, and room belong to the same property
        const resolvedReservationId = input.reservationId ?? null;
        let resolvedGuestId = input.guestId ?? null;
        let resolvedRoomId = input.roomId ?? null;
        if (resolvedReservationId) {
            const resCheck = await client.query(`SELECT id, guest_id, room_id, status, booking_reference
         FROM reservations
         WHERE id = $1 AND property_id = $2`, [resolvedReservationId, property.id]);
            if (resCheck.rowCount === 0) {
                throw AppError.badRequest('Selected reservation does not exist in this property.');
            }
            const resRow = resCheck.rows[0];
            if (resRow.status === 'cancelled') {
                throw AppError.badRequest(`Cannot create a service request for cancelled reservation ${resRow.booking_reference}.`);
            }
            if (resRow.status === 'checked_out') {
                throw AppError.badRequest(`Cannot create a new service request for checked-out reservation ${resRow.booking_reference}.`);
            }
            const resGuestId = String(resRow.guest_id);
            if (resolvedGuestId && resolvedGuestId !== resGuestId) {
                throw AppError.badRequest('Provided guest does not match the primary guest on the selected reservation.');
            }
            resolvedGuestId = resGuestId;
            if (resolvedRoomId) {
                const roomCheck = await client.query('SELECT id FROM rooms WHERE id = $1 AND property_id = $2', [resolvedRoomId, property.id]);
                if (roomCheck.rowCount === 0) {
                    throw AppError.badRequest('Selected room does not exist in this property.');
                }
                if (resRow.room_id && String(resRow.room_id) !== resolvedRoomId) {
                    throw AppError.badRequest('Provided room does not match the room assigned to the selected reservation.');
                }
            }
            else if (resRow.room_id) {
                resolvedRoomId = String(resRow.room_id);
            }
        }
        else {
            if (!resolvedGuestId) {
                throw AppError.badRequest('Either a reservation or a registered guest in this property is required.');
            }
            const guestCheck = await client.query('SELECT id FROM guests WHERE id = $1 AND property_id = $2', [resolvedGuestId, property.id]);
            if (guestCheck.rowCount === 0) {
                throw AppError.badRequest('Selected guest does not exist in this property.');
            }
            if (resolvedRoomId) {
                const roomCheck = await client.query('SELECT id FROM rooms WHERE id = $1 AND property_id = $2', [resolvedRoomId, property.id]);
                if (roomCheck.rowCount === 0) {
                    throw AppError.badRequest('Selected room does not exist in this property.');
                }
            }
        }
        // 3. Validate assigned staff belongs to same property and is active
        const { staffId, staffName } = await resolveAndValidateAssignedStaffInTx(client, property.id, input.assignedStaffId);
        const unitPrice = Number(service.unit_price);
        const effectiveTaxRate = (service.use_property_tax_rate ?? true)
            ? property.defaultTaxRate
            : Number(service.tax_rate ?? 0);
        const amounts = computeServiceRequestAmounts(input.quantity, unitPrice, effectiveTaxRate);
        const billingStatus = resolvedReservationId && amounts.totalAmount > 0 ? 'unbilled' : 'not_billable';
        const requestNumber = await allocateNextServiceRequestNumber(client, property);
        const requestedFor = input.requestedFor ?? new Date().toISOString();
        const ins = await client.query(`INSERT INTO service_requests (
         property_id, request_number, service_id,
         service_code_snapshot, service_name_snapshot, category_snapshot, pricing_unit_snapshot,
         reservation_id, guest_id, room_id,
         assigned_staff_id, assigned_staff_name_snapshot,
         quantity, unit_price, subtotal, tax_name, tax_rate, tax_amount, total_amount,
         currency, status, requested_for, notes, billing_status,
         idempotency_key, created_by, updated_by
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6, $7,
         $8, $9, $10,
         $11, $12,
         $13, $14, $15, $16, $17, $18, $19,
         $20, 'requested', $21, $22, $23,
         $24, $25, $25
       ) RETURNING id`, [
            property.id,
            requestNumber,
            service.id,
            service.code,
            service.name,
            service.category,
            service.pricing_unit ?? 'per_request',
            resolvedReservationId,
            resolvedGuestId,
            resolvedRoomId,
            staffId,
            staffName,
            input.quantity.toFixed(2),
            unitPrice.toFixed(2),
            amounts.subtotal.toFixed(2),
            property.taxName,
            effectiveTaxRate.toFixed(2),
            amounts.taxAmount.toFixed(2),
            amounts.totalAmount.toFixed(2),
            property.currency,
            requestedFor,
            input.notes,
            billingStatus,
            input.idempotencyKey ?? null,
            actorUser.id,
        ]);
        const requestId = ins.rows[0].id;
        await client.query(`INSERT INTO service_request_history (
         service_request_id, property_id, action, from_status, to_status, note, metadata, actor_user_id
       ) VALUES ($1, $2, 'created', NULL, 'requested', $3, $4::jsonb, $5)`, [
            requestId,
            property.id,
            staffName
                ? `Service requested and assigned to ${staffName}`
                : 'Service request logged',
            JSON.stringify({
                serviceCode: service.code,
                quantity: input.quantity,
                totalAmount: amounts.totalAmount,
                assignedStaffId: staffId,
            }),
            actorUser.id,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'service_request',
            entityId: requestId,
            action: 'created',
            summary: `Created service request ${requestNumber} (${service.name})`,
            payload: {
                requestNumber,
                serviceId: service.id,
                reservationId: resolvedReservationId,
                guestId: resolvedGuestId,
                roomId: resolvedRoomId,
                assignedStaffId: staffId,
                quantity: input.quantity,
                totalAmount: amounts.totalAmount,
            },
        }, client);
        return { requestId, idempotentReplay: false };
    });
    const serviceRequest = await getServiceRequestDetail(property.id, outcome.requestId);
    return { serviceRequest, idempotentReplay: outcome.idempotentReplay };
}
export async function updateServiceRequest(property, requestId, actorUser, rawInput) {
    const input = serviceRequestUpdateSchema.parse(rawInput);
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM service_requests WHERE id = $1 AND property_id = $2 FOR UPDATE', [requestId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Service request not found in this property');
        }
        const existing = existingRes.rows[0];
        const currentStatus = existing.status;
        if (currentStatus === 'cancelled') {
            throw AppError.conflict('Cancelled service requests cannot be modified.');
        }
        if (input.quantity !== undefined &&
            (currentStatus === 'completed' || existing.billing_status === 'posted')) {
            throw AppError.conflict('Cannot change quantity on a completed or already billed service request.');
        }
        let nextStaffId = existing.assigned_staff_id
            ? String(existing.assigned_staff_id)
            : null;
        let nextStaffName = String(existing.assigned_staff_name_snapshot ?? '');
        if (input.assignedStaffId !== undefined) {
            const resolved = await resolveAndValidateAssignedStaffInTx(client, property.id, input.assignedStaffId);
            nextStaffId = resolved.staffId;
            nextStaffName = resolved.staffName;
        }
        const nextQuantity = input.quantity !== undefined ? input.quantity : Number(existing.quantity);
        const unitPrice = Number(existing.unit_price);
        const taxRate = Number(existing.tax_rate);
        const amounts = computeServiceRequestAmounts(nextQuantity, unitPrice, taxRate);
        let nextBillingStatus = existing.billing_status;
        if (nextBillingStatus !== 'posted') {
            nextBillingStatus =
                existing.reservation_id && amounts.totalAmount > 0 ? 'unbilled' : 'not_billable';
        }
        const nextRequestedFor = input.requestedFor
            ? input.requestedFor
            : new Date(existing.requested_for).toISOString();
        const nextNotes = input.notes !== undefined ? input.notes : String(existing.notes ?? '');
        await client.query(`UPDATE service_requests
       SET assigned_staff_id = $1,
           assigned_staff_name_snapshot = $2,
           quantity = $3,
           subtotal = $4,
           tax_amount = $5,
           total_amount = $6,
           billing_status = $7,
           requested_for = $8,
           notes = $9,
           updated_by = $10,
           updated_at = NOW()
       WHERE id = $11 AND property_id = $12`, [
            nextStaffId,
            nextStaffName,
            nextQuantity.toFixed(2),
            amounts.subtotal.toFixed(2),
            amounts.taxAmount.toFixed(2),
            amounts.totalAmount.toFixed(2),
            nextBillingStatus,
            nextRequestedFor,
            nextNotes,
            actorUser.id,
            requestId,
            property.id,
        ]);
        const staffChanged = (existing.assigned_staff_id ? String(existing.assigned_staff_id) : null) !==
            nextStaffId;
        await client.query(`INSERT INTO service_request_history (
         service_request_id, property_id, action, from_status, to_status, note, metadata, actor_user_id
       ) VALUES ($1, $2, $3, $4, $4, $5, $6::jsonb, $7)`, [
            requestId,
            property.id,
            staffChanged ? 'assigned' : 'updated',
            currentStatus,
            staffChanged
                ? nextStaffName
                    ? `Assigned to ${nextStaffName}`
                    : 'Staff assignment cleared'
                : 'Updated service request details',
            JSON.stringify({
                quantity: nextQuantity,
                totalAmount: amounts.totalAmount,
                assignedStaffId: nextStaffId,
            }),
            actorUser.id,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'service_request',
            entityId: requestId,
            action: staffChanged ? 'assigned' : 'updated',
            summary: `Updated service request ${existing.request_number}`,
            payload: {
                assignedStaffId: nextStaffId,
                quantity: nextQuantity,
                totalAmount: amounts.totalAmount,
            },
        }, client);
    });
    return getServiceRequestDetail(property.id, requestId);
}
export async function transitionServiceRequestStatus(property, requestId, actorUser, rawInput) {
    const input = serviceRequestStatusUpdateSchema.parse(rawInput);
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM service_requests WHERE id = $1 AND property_id = $2 FOR UPDATE', [requestId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Service request not found in this property');
        }
        const existing = existingRes.rows[0];
        const currentStatus = existing.status;
        if (!canTransitionServiceRequestStatus(currentStatus, input.status)) {
            throw AppError.badRequest(`Invalid service request status transition from "${currentStatus}" to "${input.status}".`);
        }
        let nextStaffId = existing.assigned_staff_id
            ? String(existing.assigned_staff_id)
            : null;
        let nextStaffName = String(existing.assigned_staff_name_snapshot ?? '');
        if (input.assignedStaffId !== undefined) {
            const resolved = await resolveAndValidateAssignedStaffInTx(client, property.id, input.assignedStaffId);
            nextStaffId = resolved.staffId;
            nextStaffName = resolved.staffName;
        }
        if (input.status === 'in_progress') {
            await client.query(`UPDATE service_requests
         SET status = 'in_progress',
             assigned_staff_id = $1,
             assigned_staff_name_snapshot = $2,
             started_at = COALESCE(started_at, NOW()),
             started_by = $3,
             updated_by = $3,
             updated_at = NOW()
         WHERE id = $4 AND property_id = $5`, [nextStaffId, nextStaffName, actorUser.id, requestId, property.id]);
        }
        else {
            await client.query(`UPDATE service_requests
         SET status = 'completed',
             assigned_staff_id = $1,
             assigned_staff_name_snapshot = $2,
             completed_at = NOW(),
             completed_by = $3,
             updated_by = $3,
             updated_at = NOW()
         WHERE id = $4 AND property_id = $5`, [nextStaffId, nextStaffName, actorUser.id, requestId, property.id]);
        }
        const historyAction = input.status === 'in_progress' ? 'status_in_progress' : 'status_completed';
        await client.query(`INSERT INTO service_request_history (
         service_request_id, property_id, action, from_status, to_status, note, metadata, actor_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`, [
            requestId,
            property.id,
            historyAction,
            currentStatus,
            input.status,
            input.note || `Marked ${input.status.replace('_', ' ')} by ${actorUser.fullName}`,
            JSON.stringify({ assignedStaffId: nextStaffId }),
            actorUser.id,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'service_request',
            entityId: requestId,
            action: historyAction,
            summary: `Service request ${existing.request_number} transitioned ${currentStatus} → ${input.status}`,
            payload: {
                fromStatus: currentStatus,
                toStatus: input.status,
                assignedStaffId: nextStaffId,
            },
        }, client);
    });
    return getServiceRequestDetail(property.id, requestId);
}
export async function cancelServiceRequest(property, requestId, actorUser, rawInput) {
    const input = serviceRequestCancelSchema.parse(rawInput);
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM service_requests WHERE id = $1 AND property_id = $2 FOR UPDATE', [requestId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Service request not found in this property');
        }
        const existing = existingRes.rows[0];
        const currentStatus = existing.status;
        if (!canTransitionServiceRequestStatus(currentStatus, 'cancelled')) {
            throw AppError.conflict(`Cannot cancel a service request once its status is "${currentStatus}".`);
        }
        if (existing.billing_status === 'posted') {
            throw AppError.conflict('Cannot cancel a service request that has already been posted to a guest invoice.');
        }
        await client.query(`UPDATE service_requests
       SET status = 'cancelled',
           billing_status = 'not_billable',
           cancelled_at = NOW(),
           cancelled_by = $1,
           cancel_reason = $2,
           updated_by = $1,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`, [actorUser.id, input.reason, requestId, property.id]);
        await client.query(`INSERT INTO service_request_history (
         service_request_id, property_id, action, from_status, to_status, note, metadata, actor_user_id
       ) VALUES ($1, $2, 'cancelled', $3, 'cancelled', $4, $5::jsonb, $6)`, [
            requestId,
            property.id,
            currentStatus,
            `Cancelled: ${input.reason}`,
            JSON.stringify({ reason: input.reason }),
            actorUser.id,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'service_request',
            entityId: requestId,
            action: 'cancelled',
            summary: `Cancelled service request ${existing.request_number}: ${input.reason}`,
            payload: {
                fromStatus: currentStatus,
                reason: input.reason,
            },
        }, client);
    });
    return getServiceRequestDetail(property.id, requestId);
}
/**
 * Explicitly posts an eligible completed service request onto the reservation's active folio/invoice
 * using Phase 3 billing primitives with transactional locking and DB-enforced deduplication.
 */
export async function postServiceRequestToInvoice(property, requestId, actorUser, rawInput) {
    const input = serviceRequestPostToInvoiceSchema.parse(rawInput ?? {});
    const result = await withTransaction(async (client) => {
        const preCheck = await client.query(`SELECT id, reservation_id, status, billing_status, posted_invoice_id, posting_idempotency_key
       FROM service_requests
       WHERE id = $1 AND property_id = $2`, [requestId, property.id]);
        if (preCheck.rowCount === 0) {
            throw AppError.notFound('Service request not found in this property');
        }
        const pre = preCheck.rows[0];
        const reservationId = pre.reservation_id ? String(pre.reservation_id) : null;
        if (!reservationId) {
            throw AppError.badRequest('Only reservation-linked service requests can be posted to a reservation folio.');
        }
        // 1. Lock reservation first (consistent with Phase 3 & Phase 4 lock ordering)
        const resCheck = await client.query(`SELECT r.*, rm.room_number
       FROM reservations r
       LEFT JOIN rooms rm ON rm.id = r.room_id
       WHERE r.id = $1 AND r.property_id = $2
       FOR UPDATE OF r`, [reservationId, property.id]);
        if (resCheck.rowCount === 0) {
            throw AppError.notFound('Linked reservation not found in this property');
        }
        const reservation = resCheck.rows[0];
        if (reservation.status === 'cancelled') {
            throw AppError.conflict('Cannot post service charges to a cancelled reservation.');
        }
        // 2. Lock service_request and verify status / idempotency before touching invoice
        const srRes = await client.query('SELECT * FROM service_requests WHERE id = $1 AND property_id = $2 FOR UPDATE', [requestId, property.id]);
        const sr = srRes.rows[0];
        if (sr.billing_status === 'posted' &&
            input.idempotencyKey &&
            sr.posting_idempotency_key === input.idempotencyKey &&
            sr.posted_invoice_id) {
            return {
                invoiceId: String(sr.posted_invoice_id),
                idempotentReplay: true,
            };
        }
        if (sr.billing_status === 'posted') {
            throw AppError.conflict('This completed service request charge has already been posted to a guest invoice.');
        }
        if (sr.status !== 'completed') {
            throw AppError.conflict(`Only completed service requests can be posted to an invoice (current status: "${sr.status}").`);
        }
        if (Number(sr.total_amount) <= 0) {
            throw AppError.badRequest('Complimentary zero-amount service requests do not generate billable folio charges.');
        }
        // 3. Locate explicit target invoice or active non-void invoice for this reservation
        let invRes;
        if (input.invoiceId) {
            invRes = await client.query('SELECT * FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE', [input.invoiceId, property.id]);
            if (invRes.rowCount === 0) {
                throw AppError.notFound('Target invoice not found in this property');
            }
            const targetInv = invRes.rows[0];
            if (String(targetInv.reservation_id ?? '') !== reservationId) {
                throw AppError.badRequest('Target invoice does not belong to this service request’s reservation.');
            }
            if (targetInv.status === 'void') {
                throw AppError.conflict(`Cannot post service charges onto voided Invoice ${targetInv.invoice_number}.`);
            }
        }
        else {
            invRes = await client.query(`SELECT * FROM invoices
         WHERE property_id = $1 AND reservation_id = $2 AND status != 'void'
         LIMIT 1
         FOR UPDATE`, [property.id, reservationId]);
            if (invRes.rowCount === 0) {
                if (!input.createDraftInvoiceIfMissing) {
                    throw AppError.conflict(`No active invoice exists for reservation ${reservation.booking_reference} yet.`, { reason: 'NO_ACTIVE_INVOICE', reservationId });
                }
                const synced = await ensureAndSyncReservationInvoiceInTx(client, property, reservationId, actorUser.id, { issueImmediately: false });
                invRes = await client.query('SELECT * FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE', [synced.invoiceId, property.id]);
            }
        }
        const invoiceRow = invRes.rows[0];
        const invoiceId = String(invoiceRow.id);
        if (reservation.status === 'checked_out' && invoiceRow.status === 'paid') {
            throw AppError.conflict(`Reservation ${reservation.booking_reference} is already checked out and Invoice ${invoiceRow.invoice_number} is Paid in full.`);
        }
        const roomTag = reservation.room_number ? ` (Room ${reservation.room_number})` : '';
        const rawDesc = `${sr.service_name_snapshot} — ${sr.request_number}${roomTag}`;
        const description = rawDesc.length > 250 ? `${rawDesc.slice(0, 247)}...` : rawDesc;
        // 4. Insert reservation_service_charges row (DB-unique on active service_request_id)
        const scInsert = await client.query(`INSERT INTO reservation_service_charges (
         property_id, reservation_id, service_id, service_request_id, description,
         quantity, unit_price, tax_amount, total_amount, status, posted_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'billed', $10)
       RETURNING id`, [
            property.id,
            reservationId,
            sr.service_id,
            requestId,
            description,
            Number(sr.quantity).toFixed(2),
            Number(sr.unit_price).toFixed(2),
            Number(sr.tax_amount).toFixed(2),
            Number(sr.total_amount).toFixed(2),
            actorUser.id,
        ]);
        const serviceChargeId = scInsert.rows[0].id;
        // 5. Insert invoice_line_items row with DB-enforced unique source_key 'service_request:<requestId>'
        const sortRes = await client.query('SELECT COALESCE(MAX(sort_order), 20)::int AS max_sort FROM invoice_line_items WHERE invoice_id = $1', [invoiceId]);
        const nextSort = Number(sortRes.rows[0]?.max_sort ?? 20) + 10;
        const sourceKey = `service_request:${requestId}`;
        const liInsert = await client.query(`INSERT INTO invoice_line_items (
         invoice_id, service_charge_id, source_key, item_type, description,
         quantity, unit_price, net_amount, tax_rate, tax_amount, line_total,
         sort_order, metadata, created_by
       ) VALUES ($1, $2, $3, 'service_charge', $4, $5, $6, 0, $7, 0, 0, $8, $9::jsonb, $10)
       RETURNING id`, [
            invoiceId,
            serviceChargeId,
            sourceKey,
            description,
            Number(sr.quantity).toFixed(2),
            Number(sr.unit_price).toFixed(2),
            Number(sr.tax_rate).toFixed(2),
            nextSort,
            JSON.stringify({
                serviceRequestId: requestId,
                requestNumber: sr.request_number,
                serviceId: sr.service_id,
                reservationId,
                note: input.note || undefined,
            }),
            actorUser.id,
        ]);
        const lineItemId = liInsert.rows[0].id;
        // 6. Recompute invoice totals & balance via Phase 3 billing engine
        await recomputeAndPersistInvoiceInTx(client, invoiceId, actorUser.id);
        await client.query(`UPDATE service_requests
       SET billing_status = 'posted',
           posted_invoice_id = $1,
           posted_line_item_id = $2,
           posted_service_charge_id = $3,
           posted_at = NOW(),
           posted_by = $4,
           posting_idempotency_key = $5,
           updated_by = $4,
           updated_at = NOW()
       WHERE id = $6 AND property_id = $7`, [
            invoiceId,
            lineItemId,
            serviceChargeId,
            actorUser.id,
            input.idempotencyKey ?? null,
            requestId,
            property.id,
        ]);
        await client.query(`INSERT INTO service_request_history (
         service_request_id, property_id, action, from_status, to_status, note, metadata, actor_user_id
       ) VALUES ($1, $2, 'posted_to_invoice', 'completed', 'completed', $3, $4::jsonb, $5)`, [
            requestId,
            property.id,
            input.note
                ? `Posted to invoice ${invoiceRow.invoice_number} — ${input.note}`
                : `Posted charge to invoice ${invoiceRow.invoice_number}`,
            JSON.stringify({
                invoiceId,
                invoiceNumber: invoiceRow.invoice_number,
                lineItemId,
                totalAmount: Number(sr.total_amount),
            }),
            actorUser.id,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'service_request',
            entityId: requestId,
            action: 'posted_to_invoice',
            summary: `Posted service request ${sr.request_number} (${sr.service_name_snapshot}) to invoice ${invoiceRow.invoice_number}`,
            payload: {
                invoiceId,
                invoiceNumber: invoiceRow.invoice_number,
                lineItemId,
                totalAmount: Number(sr.total_amount),
            },
        }, client);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'invoice',
            entityId: invoiceId,
            action: 'service_request_posted',
            summary: `Posted service charge ${sr.request_number} (${Number(sr.total_amount).toFixed(2)} ${property.currency})`,
            payload: {
                serviceRequestId: requestId,
                requestNumber: sr.request_number,
            },
        }, client);
        return { invoiceId, idempotentReplay: false };
    });
    const [serviceRequest, invoice] = await Promise.all([
        getServiceRequestDetail(property.id, requestId),
        getInvoiceDetail(property.id, result.invoiceId),
    ]);
    return {
        serviceRequest,
        invoice,
        idempotentReplay: result.idempotentReplay,
    };
}
