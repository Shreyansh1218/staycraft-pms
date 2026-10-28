import { getRoomCleaningStage, } from '../../../shared/constants.js';
import { diffDays, isValidIsoDate } from '../../../shared/dates.js';
import { cleaningWorkflowActionSchema, housekeepingUpdateSchema, roomCreateSchema, roomTypeCreateSchema, roomTypeUpdateSchema, roomUpdateSchema, } from '../../../shared/schemas.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import { mapRoomRow, mapRoomTypeRow } from '../../services/mappers.js';
export async function listRoomTypes(propertyId, includeInactive = false) {
    const pool = getPool();
    const res = await pool.query(`SELECT rt.*,
            COUNT(r.id)::int AS total_rooms_count,
            COUNT(r.id) FILTER (WHERE r.is_active = TRUE)::int AS active_rooms_count
     FROM room_types rt
     LEFT JOIN rooms r ON r.room_type_id = rt.id
     WHERE rt.property_id = $1
       AND ($2::boolean = TRUE OR rt.is_active = TRUE)
     GROUP BY rt.id
     ORDER BY rt.base_rate ASC, rt.name ASC`, [propertyId, includeInactive]);
    return res.rows.map(mapRoomTypeRow);
}
export async function createRoomType(propertyId, actorUserId, rawInput) {
    const input = roomTypeCreateSchema.parse(rawInput);
    return withTransaction(async (client) => {
        const res = await client.query(`INSERT INTO room_types (
         property_id, code, name, description, base_capacity, max_capacity, base_rate, amenities, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING *, 0 AS total_rooms_count, 0 AS active_rooms_count`, [
            propertyId,
            input.code,
            input.name,
            input.description,
            input.baseCapacity,
            input.maxCapacity,
            input.baseRate,
            JSON.stringify(input.amenities),
            input.isActive,
        ]);
        const created = mapRoomTypeRow(res.rows[0]);
        await recordAuditEvent({
            propertyId,
            actorUserId,
            entityType: 'room_type',
            entityId: created.id,
            action: 'created',
            summary: `Created room category ${created.name} (${created.code})`,
        }, client);
        return created;
    });
}
export async function updateRoomType(propertyId, roomTypeId, actorUserId, rawInput) {
    const input = roomTypeUpdateSchema.parse(rawInput);
    return withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM room_types WHERE id = $1 AND property_id = $2 FOR UPDATE', [roomTypeId, propertyId]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Room category not found');
        }
        const existing = existingRes.rows[0];
        const nextBaseCap = input.baseCapacity ?? Number(existing.base_capacity);
        const nextMaxCap = input.maxCapacity ?? Number(existing.max_capacity);
        if (nextMaxCap < nextBaseCap) {
            throw AppError.badRequest('Maximum capacity must be greater than or equal to base capacity');
        }
        // Prevent reducing maxCapacity below guest counts of active reservations
        if (input.maxCapacity !== undefined && input.maxCapacity < Number(existing.max_capacity)) {
            const activeExceeding = await client.query(`SELECT booking_reference, num_guests
         FROM reservations
         WHERE property_id = $1
           AND room_type_id = $2
           AND status IN ('pending', 'confirmed', 'checked_in')
           AND num_guests > $3
         LIMIT 1`, [propertyId, roomTypeId, nextMaxCap]);
            if ((activeExceeding.rowCount ?? 0) > 0) {
                const ref = activeExceeding.rows[0].booking_reference;
                throw AppError.conflict(`Cannot lower max capacity to ${nextMaxCap}: active reservation ${ref} has ${activeExceeding.rows[0].num_guests} guests.`);
            }
        }
        // Prevent deactivating category if active reservations exist
        if (input.isActive === false && existing.is_active === true) {
            const activeRes = await client.query(`SELECT booking_reference FROM reservations
         WHERE property_id = $1 AND room_type_id = $2 AND status IN ('pending', 'confirmed', 'checked_in')
         LIMIT 1`, [propertyId, roomTypeId]);
            if ((activeRes.rowCount ?? 0) > 0) {
                throw AppError.conflict(`Cannot deactivate category while active reservation ${activeRes.rows[0].booking_reference} uses it.`);
            }
        }
        await client.query(`UPDATE room_types
       SET code = $1,
           name = $2,
           description = $3,
           base_capacity = $4,
           max_capacity = $5,
           base_rate = $6,
           amenities = $7::jsonb,
           is_active = $8,
           updated_at = NOW()
       WHERE id = $9 AND property_id = $10`, [
            input.code ?? existing.code,
            input.name ?? existing.name,
            input.description ?? existing.description,
            nextBaseCap,
            nextMaxCap,
            input.baseRate ?? Number(existing.base_rate),
            JSON.stringify(input.amenities ?? existing.amenities ?? []),
            input.isActive ?? existing.is_active,
            roomTypeId,
            propertyId,
        ]);
        const refreshed = await client.query(`SELECT rt.*,
              COUNT(r.id)::int AS total_rooms_count,
              COUNT(r.id) FILTER (WHERE r.is_active = TRUE)::int AS active_rooms_count
       FROM room_types rt
       LEFT JOIN rooms r ON r.room_type_id = rt.id
       WHERE rt.id = $1
       GROUP BY rt.id`, [roomTypeId]);
        const updated = mapRoomTypeRow(refreshed.rows[0]);
        await recordAuditEvent({
            propertyId,
            actorUserId,
            entityType: 'room_type',
            entityId: updated.id,
            action: 'updated',
            summary: `Updated room category ${updated.name}`,
        }, client);
        return updated;
    });
}
export async function listRooms(propertyId, filter = {}) {
    const pool = getPool();
    const params = [propertyId];
    const conditions = ['r.property_id = $1'];
    if (!filter.includeInactive) {
        conditions.push('r.is_active = TRUE');
    }
    if (filter.roomTypeId) {
        params.push(filter.roomTypeId);
        conditions.push(`r.room_type_id = $${params.length}`);
    }
    if (filter.operationalStatus) {
        params.push(filter.operationalStatus);
        conditions.push(`r.operational_status = $${params.length}`);
    }
    if (filter.housekeepingStatus) {
        params.push(filter.housekeepingStatus);
        conditions.push(`r.housekeeping_status = $${params.length}`);
    }
    if (filter.floor) {
        params.push(filter.floor);
        conditions.push(`r.floor = $${params.length}`);
    }
    if (filter.minCapacity && filter.minCapacity > 0) {
        params.push(filter.minCapacity);
        conditions.push(`rt.max_capacity >= $${params.length}`);
    }
    if (filter.search && filter.search.trim().length > 0) {
        params.push(`%${filter.search.trim()}%`);
        const idx = params.length;
        conditions.push(`(r.room_number ILIKE $${idx} OR rt.name ILIKE $${idx} OR rt.code ILIKE $${idx} OR r.notes ILIKE $${idx})`);
    }
    let dateSelectSql = '';
    let dateJoinSql = '';
    if (filter.availableFrom && filter.availableTo) {
        if (!isValidIsoDate(filter.availableFrom) || !isValidIsoDate(filter.availableTo)) {
            throw AppError.badRequest('Invalid availability date range');
        }
        if (diffDays(filter.availableFrom, filter.availableTo) < 1) {
            throw AppError.badRequest('Departure date must be after arrival date');
        }
        params.push(filter.availableFrom);
        const fromIdx = params.length;
        params.push(filter.availableTo);
        const toIdx = params.length;
        let excludeClause = '';
        if (filter.excludeReservationId) {
            params.push(filter.excludeReservationId);
            excludeClause = `AND res_conf.id != $${params.length}::uuid`;
        }
        dateJoinSql = `
      LEFT JOIN LATERAL (
        SELECT res_conf.booking_reference
        FROM reservations res_conf
        WHERE res_conf.room_id = r.id
          AND res_conf.status IN ('pending', 'confirmed', 'checked_in')
          ${excludeClause}
          AND daterange(res_conf.arrival_date, res_conf.departure_date, '[)') && daterange($${fromIdx}::date, $${toIdx}::date, '[)')
        ORDER BY res_conf.arrival_date ASC
        LIMIT 1
      ) conflict_res ON TRUE
      LEFT JOIN LATERAL (
        SELECT mr_conf.title
        FROM maintenance_requests mr_conf
        WHERE mr_conf.room_id = r.id
          AND mr_conf.status IN ('open', 'in_progress')
          AND mr_conf.blocks_inventory = TRUE
          AND daterange(mr_conf.unavailable_from, COALESCE(mr_conf.unavailable_to, '9999-12-31'::date), '[)')
              && daterange($${fromIdx}::date, $${toIdx}::date, '[)')
        ORDER BY mr_conf.reported_at DESC
        LIMIT 1
      ) conflict_maint ON TRUE
    `;
        dateSelectSql = `,
      (r.is_active = TRUE
        AND r.operational_status = 'available'
        AND r.housekeeping_status != 'out_of_service'
        AND conflict_res.booking_reference IS NULL
        AND conflict_maint.title IS NULL
      ) AS available_for_dates,
      conflict_res.booking_reference AS conflicting_booking_ref,
      conflict_maint.title AS conflicting_maintenance_title
    `;
    }
    const sql = `
    SELECT r.*,
           rt.name AS room_type_name,
           rt.code AS room_type_code,
           rt.base_capacity,
           rt.max_capacity,
           rt.base_rate,
           COALESCE(hk_agg.open_tasks_count, 0)::int AS open_tasks_count,
           COALESCE(mr_agg.open_maintenance_count, 0)::int AS open_maintenance_count,
           mr_agg.active_maintenance_summary,
           occ.id AS occ_reservation_id,
           occ.booking_reference AS occ_booking_reference,
           occ.guest_name AS occ_guest_name,
           occ.arrival_date AS occ_arrival_date,
           occ.departure_date AS occ_departure_date,
           occ.status AS occ_status
           ${dateSelectSql}
    FROM rooms r
    JOIN room_types rt ON rt.id = r.room_type_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS open_tasks_count
      FROM housekeeping_tasks ht
      WHERE ht.room_id = r.id
        AND ht.status IN ('pending', 'in_progress')
    ) hk_agg ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS open_maintenance_count,
             (ARRAY_AGG(mr.title ORDER BY
               CASE mr.priority
                 WHEN 'urgent' THEN 0
                 WHEN 'high' THEN 1
                 WHEN 'normal' THEN 2
                 ELSE 3
               END ASC,
               mr.reported_at DESC))[1] AS active_maintenance_summary
      FROM maintenance_requests mr
      WHERE mr.room_id = r.id
        AND mr.status IN ('open', 'in_progress')
    ) mr_agg ON TRUE
    LEFT JOIN LATERAL (
      SELECT res.id,
             res.booking_reference,
             CONCAT(g.first_name, ' ', g.last_name) AS guest_name,
             res.arrival_date,
             res.departure_date,
             res.status
      FROM reservations res
      JOIN guests g ON g.id = res.guest_id
      WHERE res.room_id = r.id
        AND res.status = 'checked_in'
      LIMIT 1
    ) occ ON TRUE
    ${dateJoinSql}
    WHERE ${conditions.join(' AND ')}
    ORDER BY r.floor ASC, LENGTH(r.room_number) ASC, r.room_number ASC
  `;
    const result = await pool.query(sql, params);
    return result.rows.map(mapRoomRow);
}
export async function getRoomById(propertyId, roomId) {
    const rooms = await listRooms(propertyId, { includeInactive: true });
    const found = rooms.find((r) => r.id === roomId);
    if (!found) {
        throw AppError.notFound('Room not found');
    }
    return found;
}
export async function createRoom(propertyId, actorUserId, rawInput) {
    const input = roomCreateSchema.parse(rawInput);
    const createdId = await withTransaction(async (client) => {
        const rtRes = await client.query('SELECT id, name, is_active FROM room_types WHERE id = $1 AND property_id = $2', [input.roomTypeId, propertyId]);
        if (rtRes.rowCount === 0) {
            throw AppError.badRequest('Selected room category does not belong to this property');
        }
        if (!rtRes.rows[0].is_active) {
            throw AppError.badRequest('Cannot assign a new room to an inactive room category');
        }
        const dupCheck = await client.query('SELECT id FROM rooms WHERE property_id = $1 AND LOWER(room_number) = LOWER($2) LIMIT 1', [propertyId, input.roomNumber]);
        if ((dupCheck.rowCount ?? 0) > 0) {
            throw AppError.conflict(`Room number "${input.roomNumber}" already exists in this property.`);
        }
        const effectiveHousekeeping = input.operationalStatus === 'out_of_service' ? 'out_of_service' : input.housekeepingStatus;
        const insertRes = await client.query(`INSERT INTO rooms (
         property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, notes, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`, [
            propertyId,
            input.roomTypeId,
            input.roomNumber,
            input.floor,
            input.operationalStatus,
            effectiveHousekeeping,
            input.notes,
            input.isActive,
        ]);
        const newId = insertRes.rows[0].id;
        await recordAuditEvent({
            propertyId,
            actorUserId,
            entityType: 'room',
            entityId: newId,
            action: 'created',
            summary: `Created Room ${input.roomNumber} (Floor ${input.floor})`,
        }, client);
        return newId;
    });
    return getRoomById(propertyId, createdId);
}
export async function updateRoom(propertyId, roomId, actorUserId, rawInput) {
    const input = roomUpdateSchema.parse(rawInput);
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE', [roomId, propertyId]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Room not found');
        }
        const existing = existingRes.rows[0];
        if (input.roomNumber &&
            input.roomNumber.toLowerCase() !== String(existing.room_number).toLowerCase()) {
            const dupCheck = await client.query('SELECT id FROM rooms WHERE property_id = $1 AND LOWER(room_number) = LOWER($2) AND id != $3 LIMIT 1', [propertyId, input.roomNumber, roomId]);
            if ((dupCheck.rowCount ?? 0) > 0) {
                throw AppError.conflict(`Room number "${input.roomNumber}" already exists in this property.`);
            }
        }
        if (input.roomTypeId && input.roomTypeId !== existing.room_type_id) {
            const rtRes = await client.query('SELECT id, max_capacity, is_active FROM room_types WHERE id = $1 AND property_id = $2', [input.roomTypeId, propertyId]);
            if (rtRes.rowCount === 0 || !rtRes.rows[0].is_active) {
                throw AppError.badRequest('Target room category is invalid or inactive');
            }
            const capConflict = await client.query(`SELECT booking_reference, num_guests
         FROM reservations
         WHERE room_id = $1 AND status IN ('pending', 'confirmed', 'checked_in') AND num_guests > $2
         LIMIT 1`, [roomId, Number(rtRes.rows[0].max_capacity)]);
            if ((capConflict.rowCount ?? 0) > 0) {
                throw AppError.conflict(`Cannot change room category: active reservation ${capConflict.rows[0].booking_reference} exceeds new capacity.`);
            }
        }
        const nextOpStatus = input.operationalStatus ?? existing.operational_status;
        const nextIsActive = input.isActive ?? existing.is_active;
        const nextHkStatus = input.housekeepingStatus ?? existing.housekeeping_status;
        if (!nextIsActive || nextOpStatus !== 'available' || nextHkStatus === 'out_of_service') {
            const activeBookings = await client.query(`SELECT booking_reference, status
         FROM reservations
         WHERE room_id = $1 AND status IN ('pending', 'confirmed', 'checked_in')
         ORDER BY CASE WHEN status = 'checked_in' THEN 0 ELSE 1 END
         LIMIT 1`, [roomId]);
            if ((activeBookings.rowCount ?? 0) > 0) {
                const b = activeBookings.rows[0];
                throw AppError.conflict(`Cannot mark room unavailable or inactive while active reservation ${b.booking_reference} (${b.status}) is assigned to it. Reassign or complete the booking first.`);
            }
        }
        await client.query(`UPDATE rooms
       SET room_type_id = $1,
           room_number = $2,
           floor = $3,
           operational_status = $4,
           housekeeping_status = $5,
           notes = $6,
           is_active = $7,
           updated_at = NOW()
       WHERE id = $8 AND property_id = $9`, [
            input.roomTypeId ?? existing.room_type_id,
            input.roomNumber ?? existing.room_number,
            input.floor ?? existing.floor,
            nextOpStatus,
            nextHkStatus,
            input.notes ?? existing.notes,
            nextIsActive,
            roomId,
            propertyId,
        ]);
        // If room category changed, keep future pending/confirmed reservations' room_type_id aligned
        if (input.roomTypeId && input.roomTypeId !== existing.room_type_id) {
            await client.query(`UPDATE reservations
         SET room_type_id = $1, updated_at = NOW()
         WHERE room_id = $2 AND status IN ('pending', 'confirmed')`, [input.roomTypeId, roomId]);
        }
        await recordAuditEvent({
            propertyId,
            actorUserId,
            entityType: 'room',
            entityId: roomId,
            action: 'updated',
            summary: `Updated Room ${input.roomNumber ?? existing.room_number}`,
            payload: { operationalStatus: nextOpStatus, housekeepingStatus: nextHkStatus, isActive: nextIsActive },
        }, client);
    });
    return getRoomById(propertyId, roomId);
}
export async function updateRoomHousekeeping(propertyId, roomId, actorUser, rawInput) {
    const input = housekeepingUpdateSchema.parse(rawInput);
    if (input.housekeepingStatus === 'out_of_service') {
        if (actorUser.role !== 'admin') {
            throw AppError.forbidden('Administrator role is required to place a room Out of Service.');
        }
        throw AppError.badRequest('Use POST /api/rooms/:id/out-of-service or POST /api/maintenance to place a room Out of Service so operational status and maintenance audit records stay synchronized.');
    }
    // Non-admin staff must follow the canonical Phase 2 cleaning & inspection state machine
    if (actorUser.role !== 'admin') {
        const workflowActionMap = {
            dirty: 'mark_dirty',
            clean: 'complete_cleaning',
            inspected: 'inspect_room',
        };
        return executeRoomCleaningWorkflow(propertyId, roomId, actorUser.id, {
            action: workflowActionMap[input.housekeepingStatus],
            notes: input.notes,
        });
    }
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE', [roomId, propertyId]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Room not found');
        }
        const existing = existingRes.rows[0];
        if (!existing.is_active) {
            throw AppError.badRequest(`Room ${existing.room_number} is deactivated and cannot undergo housekeeping updates.`);
        }
        await client.query(`UPDATE rooms
       SET housekeeping_status = $1::varchar(30),
           cleaning_started_at = NULL,
           cleaning_started_by = NULL,
           last_cleaned_at = CASE WHEN $1::text = 'clean' THEN NOW() ELSE last_cleaned_at END,
           last_cleaned_by = CASE WHEN $1::text = 'clean' THEN $5::uuid ELSE last_cleaned_by END,
           last_inspected_at = CASE WHEN $1::text = 'inspected' THEN NOW() ELSE last_inspected_at END,
           last_inspected_by = CASE WHEN $1::text = 'inspected' THEN $5::uuid ELSE last_inspected_by END,
           notes = COALESCE($2, notes),
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`, [input.housekeepingStatus, input.notes ?? null, roomId, propertyId, actorUser.id]);
        await recordAuditEvent({
            propertyId,
            actorUserId: actorUser.id,
            entityType: 'housekeeping',
            entityId: roomId,
            action: 'housekeeping_status_changed',
            summary: `Room ${existing.room_number} housekeeping changed from ${existing.housekeeping_status} to ${input.housekeepingStatus} (admin override)`,
            payload: {
                from: existing.housekeeping_status,
                to: input.housekeepingStatus,
                adminOverride: true,
            },
        }, client);
    });
    return getRoomById(propertyId, roomId);
}
/**
 * Validated step-by-step Cleaning & Inspection Workflow:
 * Dirty -> Cleaning in Progress -> Clean -> Inspected (plus Mark Dirty for turnover/re-clean).
 * Never modifies operational_status or reservation occupancy/status.
 */
export async function executeRoomCleaningWorkflow(propertyId, roomId, actorUserId, rawInput) {
    const input = cleaningWorkflowActionSchema.parse(rawInput);
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE', [roomId, propertyId]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Room not found');
        }
        const existing = existingRes.rows[0];
        if (!existing.is_active) {
            throw AppError.badRequest(`Room ${existing.room_number} is deactivated and cannot undergo housekeeping workflow transitions.`);
        }
        if (existing.housekeeping_status === 'out_of_service') {
            throw AppError.badRequest(`Room ${existing.room_number} is marked Out of Service in housekeeping. Restore it before starting cleaning transitions.`);
        }
        const currentStage = getRoomCleaningStage({
            housekeepingStatus: existing.housekeeping_status,
            cleaningInProgress: Boolean(existing.cleaning_started_at),
        });
        let nextStage = currentStage;
        switch (input.action) {
            case 'mark_dirty': {
                if (currentStage === 'dirty') {
                    throw AppError.badRequest(`Room ${existing.room_number} is already marked Dirty.`);
                }
                await client.query(`UPDATE rooms
           SET housekeeping_status = 'dirty',
               cleaning_started_at = NULL,
               cleaning_started_by = NULL,
               notes = COALESCE($1, notes),
               updated_at = NOW()
           WHERE id = $2 AND property_id = $3`, [input.notes ?? null, roomId, propertyId]);
                nextStage = 'dirty';
                break;
            }
            case 'start_cleaning': {
                if (currentStage !== 'dirty') {
                    throw AppError.badRequest(`Invalid housekeeping transition: Room ${existing.room_number} must be "dirty" to start cleaning (current stage: "${currentStage}").`);
                }
                await client.query(`UPDATE rooms
           SET housekeeping_status = 'dirty',
               cleaning_started_at = NOW(),
               cleaning_started_by = $1,
               notes = COALESCE($2, notes),
               updated_at = NOW()
           WHERE id = $3 AND property_id = $4`, [actorUserId, input.notes ?? null, roomId, propertyId]);
                await client.query(`UPDATE housekeeping_tasks
           SET status = 'in_progress',
               started_at = COALESCE(started_at, NOW()),
               started_by = COALESCE(started_by, $1),
               updated_by = $1,
               updated_at = NOW()
           WHERE id = (
             SELECT id FROM housekeeping_tasks
             WHERE property_id = $2
               AND room_id = $3
               AND status = 'pending'
               AND task_type != 'inspection'
             ORDER BY scheduled_for ASC, created_at ASC
             LIMIT 1
           )`, [actorUserId, propertyId, roomId]);
                nextStage = 'cleaning_in_progress';
                break;
            }
            case 'complete_cleaning': {
                if (currentStage !== 'cleaning_in_progress') {
                    throw AppError.badRequest(`Invalid housekeeping transition: Room ${existing.room_number} must be in "cleaning_in_progress" before marking Clean (current stage: "${currentStage}").`);
                }
                await client.query(`UPDATE rooms
           SET housekeeping_status = 'clean',
               cleaning_started_at = NULL,
               cleaning_started_by = NULL,
               last_cleaned_at = NOW(),
               last_cleaned_by = $1,
               notes = COALESCE($2, notes),
               updated_at = NOW()
           WHERE id = $3 AND property_id = $4`, [actorUserId, input.notes ?? null, roomId, propertyId]);
                await client.query(`UPDATE housekeeping_tasks
           SET status = 'completed',
               completed_at = NOW(),
               completed_by = $1,
               updated_by = $1,
               updated_at = NOW()
           WHERE property_id = $2
             AND room_id = $3
             AND status = 'in_progress'
             AND task_type != 'inspection'`, [actorUserId, propertyId, roomId]);
                nextStage = 'clean';
                break;
            }
            case 'inspect_room': {
                if (currentStage !== 'clean') {
                    throw AppError.badRequest(`Invalid housekeeping transition: Room ${existing.room_number} must be "clean" before supervisor inspection (current stage: "${currentStage}").`);
                }
                await client.query(`UPDATE rooms
           SET housekeeping_status = 'inspected',
               cleaning_started_at = NULL,
               cleaning_started_by = NULL,
               last_inspected_at = NOW(),
               last_inspected_by = $1,
               notes = COALESCE($2, notes),
               updated_at = NOW()
           WHERE id = $3 AND property_id = $4`, [actorUserId, input.notes ?? null, roomId, propertyId]);
                await client.query(`UPDATE housekeeping_tasks
           SET status = 'completed',
               started_at = COALESCE(started_at, NOW()),
               started_by = COALESCE(started_by, $1),
               completed_at = NOW(),
               completed_by = $1,
               updated_by = $1,
               updated_at = NOW()
           WHERE property_id = $2
             AND room_id = $3
             AND status IN ('pending', 'in_progress')
             AND task_type = 'inspection'`, [actorUserId, propertyId, roomId]);
                nextStage = 'inspected';
                break;
            }
        }
        await recordAuditEvent({
            propertyId,
            actorUserId,
            entityType: 'housekeeping',
            entityId: roomId,
            action: `workflow_${input.action}`,
            summary: `Room ${existing.room_number} cleaning workflow transitioned from ${currentStage} to ${nextStage}`,
            payload: {
                action: input.action,
                fromStage: currentStage,
                toStage: nextStage,
                notes: input.notes ?? '',
            },
        }, client);
    });
    return getRoomById(propertyId, roomId);
}
