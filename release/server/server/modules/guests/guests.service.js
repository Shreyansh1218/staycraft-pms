import { guestCreateSchema, guestUpdateSchema } from '../../../shared/schemas.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import { mapGuestRow, mapReservationRow } from '../../services/mappers.js';
export async function listGuests(propertyId, query = {}) {
    const pool = getPool();
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 20)));
    const offset = (page - 1) * pageSize;
    const params = [propertyId];
    const conditions = ['g.property_id = $1'];
    if (query.vipOnly) {
        conditions.push('g.vip_status = TRUE');
    }
    if (query.search && query.search.trim().length > 0) {
        params.push(`%${query.search.trim()}%`);
        const idx = params.length;
        conditions.push(`(CONCAT(g.first_name, ' ', g.last_name) ILIKE $${idx}
        OR g.email ILIKE $${idx}
        OR g.phone ILIKE $${idx}
        OR g.city ILIKE $${idx}
        OR g.notes ILIKE $${idx})`);
    }
    const whereSql = conditions.join(' AND ');
    const countRes = await pool.query(`SELECT COUNT(*)::text AS total FROM guests g WHERE ${whereSql}`, params);
    const total = Number(countRes.rows[0]?.total ?? 0);
    params.push(pageSize, offset);
    const dataRes = await pool.query(`SELECT g.*,
            COUNT(r.id) FILTER (WHERE r.status != 'cancelled')::int AS total_reservations,
            COUNT(r.id) FILTER (WHERE r.status = 'checked_in')::int AS active_stays
     FROM guests g
     LEFT JOIN reservations r ON r.guest_id = g.id
     WHERE ${whereSql}
     GROUP BY g.id
     ORDER BY g.created_at DESC, g.last_name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return {
        items: dataRes.rows.map(mapGuestRow),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
}
export async function getGuestDetail(propertyId, guestId) {
    const pool = getPool();
    const guestRes = await pool.query(`SELECT g.*,
            COUNT(r.id) FILTER (WHERE r.status != 'cancelled')::int AS total_reservations,
            COUNT(r.id) FILTER (WHERE r.status = 'checked_in')::int AS active_stays
     FROM guests g
     LEFT JOIN reservations r ON r.guest_id = g.id
     WHERE g.id = $1 AND g.property_id = $2
     GROUP BY g.id`, [guestId, propertyId]);
    if (guestRes.rowCount === 0) {
        throw AppError.notFound('Guest record not found');
    }
    const guest = mapGuestRow(guestRes.rows[0]);
    const reservationsRes = await pool.query(`SELECT r.*,
            g.first_name AS guest_first_name,
            g.last_name AS guest_last_name,
            g.email AS guest_email,
            g.phone AS guest_phone,
            rt.name AS room_type_name,
            rt.code AS room_type_code,
            rm.room_number,
            rm.floor AS room_floor,
            rm.housekeeping_status AS room_housekeeping_status,
            rm.operational_status AS room_operational_status,
            rm.cleaning_started_at AS room_cleaning_started_at
     FROM reservations r
     JOIN guests g ON g.id = r.guest_id
     JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN rooms rm ON rm.id = r.room_id
     WHERE r.guest_id = $1 AND r.property_id = $2
     ORDER BY r.arrival_date DESC, r.created_at DESC`, [guestId, propertyId]);
    return {
        ...guest,
        reservations: reservationsRes.rows.map(mapReservationRow),
    };
}
export async function createGuest(propertyId, actorUserId, rawInput) {
    const input = guestCreateSchema.parse(rawInput);
    return withTransaction(async (client) => {
        const res = await client.query(`INSERT INTO guests (
         property_id, first_name, last_name, email, phone,
         address_line1, city, state_region, postal_code, country,
         id_document_type, id_document_number, vip_status, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *, 0 AS total_reservations, 0 AS active_stays`, [
            propertyId,
            input.firstName,
            input.lastName,
            input.email,
            input.phone,
            input.addressLine1,
            input.city,
            input.stateRegion,
            input.postalCode,
            input.country,
            input.idDocumentType,
            input.idDocumentNumber,
            input.vipStatus,
            input.notes,
        ]);
        const guest = mapGuestRow(res.rows[0]);
        await recordAuditEvent({
            propertyId,
            actorUserId,
            entityType: 'guest',
            entityId: guest.id,
            action: 'created',
            summary: `Registered guest ${guest.fullName}`,
        }, client);
        return guest;
    });
}
export async function updateGuest(propertyId, guestId, actorUserId, rawInput) {
    const input = guestUpdateSchema.parse(rawInput);
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM guests WHERE id = $1 AND property_id = $2 FOR UPDATE', [guestId, propertyId]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Guest record not found');
        }
        const existing = existingRes.rows[0];
        await client.query(`UPDATE guests
       SET first_name = $1,
           last_name = $2,
           email = $3,
           phone = $4,
           address_line1 = $5,
           city = $6,
           state_region = $7,
           postal_code = $8,
           country = $9,
           id_document_type = $10,
           id_document_number = $11,
           vip_status = $12,
           notes = $13,
           updated_at = NOW()
       WHERE id = $14 AND property_id = $15`, [
            input.firstName ?? existing.first_name,
            input.lastName ?? existing.last_name,
            input.email ?? existing.email,
            input.phone ?? existing.phone,
            input.addressLine1 ?? existing.address_line1,
            input.city ?? existing.city,
            input.stateRegion ?? existing.state_region,
            input.postalCode ?? existing.postal_code,
            input.country ?? existing.country,
            input.idDocumentType ?? existing.id_document_type,
            input.idDocumentNumber ?? existing.id_document_number,
            input.vipStatus ?? existing.vip_status,
            input.notes ?? existing.notes,
            guestId,
            propertyId,
        ]);
        await recordAuditEvent({
            propertyId,
            actorUserId,
            entityType: 'guest',
            entityId: guestId,
            action: 'updated',
            summary: `Updated guest profile ${input.firstName ?? existing.first_name} ${input.lastName ?? existing.last_name}`,
        }, client);
    });
    const detail = await getGuestDetail(propertyId, guestId);
    const { reservations: _res, ...guestSummary } = detail;
    return guestSummary;
}
