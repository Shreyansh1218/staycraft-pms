import { getPropertyLocalDate, isValidIsoDate } from '../../../shared/dates.js';
import {
  maintenanceCreateSchema,
  maintenanceUpdateSchema,
  roomOutOfServiceSchema,
  roomRestoreServiceSchema,
} from '../../../shared/schemas.js';
import type {
  MaintenanceRequest,
  Property,
  ReservationListItem,
  Room,
  UserSummary,
} from '../../../shared/types.js';
import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import { mapMaintenanceRequestRow, mapReservationRow } from '../../services/mappers.js';
import { validatePropertyStaffAssignee } from '../properties/properties.routes.js';
import { getRoomById } from '../rooms/rooms.service.js';

const MAINTENANCE_SELECT = `
  SELECT mr.*,
         rm.room_number,
         rm.floor AS room_floor,
         rm.operational_status AS room_operational_status,
         rm.housekeeping_status AS room_housekeeping_status,
         rt.name AS room_type_name,
         u_rep.full_name AS reported_by_name,
         u_ass.full_name AS assigned_to_name,
         u_ass.role AS assigned_to_role,
         u_res.full_name AS resolved_by_name,
         EXISTS (
           SELECT 1 FROM reservations r_occ
           WHERE r_occ.room_id = rm.id AND r_occ.status = 'checked_in'
         ) AS is_room_occupied
  FROM maintenance_requests mr
  JOIN rooms rm ON rm.id = mr.room_id
  JOIN room_types rt ON rt.id = rm.room_type_id
  LEFT JOIN users u_rep ON u_rep.id = mr.reported_by
  LEFT JOIN users u_ass ON u_ass.id = mr.assigned_to
  LEFT JOIN users u_res ON u_res.id = mr.resolved_by
`;

export async function findAffectedReservationsForRoom(
  db: Queryable,
  propertyId: string,
  roomId: string,
  fromDate: string,
  toDate: string | null = null
): Promise<ReservationListItem[]> {
  const res = await db.query(
    `SELECT r.*,
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
     WHERE r.property_id = $1
       AND r.room_id = $2
       AND r.status IN ('pending', 'confirmed', 'checked_in')
       AND daterange(r.arrival_date, r.departure_date, '[)')
           && daterange($3::date, COALESCE($4::date, '9999-12-31'::date), '[)')
     ORDER BY CASE WHEN r.status = 'checked_in' THEN 0 ELSE 1 END ASC, r.arrival_date ASC`,
    [propertyId, roomId, fromDate, toDate]
  );

  return res.rows.map(mapReservationRow);
}

export interface ListMaintenanceFilter {
  status?: string;
  priority?: string;
  category?: string;
  roomId?: string;
  assignedTo?: string;
  blocksInventory?: boolean;
  search?: string;
}

export async function listMaintenanceRequests(
  propertyId: string,
  filter: ListMaintenanceFilter = {}
): Promise<MaintenanceRequest[]> {
  const pool = getPool();
  const params: unknown[] = [propertyId];
  const conditions: string[] = ['mr.property_id = $1'];

  if (filter.status) {
    if (filter.status === 'active') {
      conditions.push(`mr.status IN ('open', 'in_progress')`);
    } else {
      params.push(filter.status);
      conditions.push(`mr.status = $${params.length}`);
    }
  }

  if (filter.priority) {
    params.push(filter.priority);
    conditions.push(`mr.priority = $${params.length}`);
  }

  if (filter.category) {
    params.push(filter.category);
    conditions.push(`mr.category = $${params.length}`);
  }

  if (filter.roomId) {
    params.push(filter.roomId);
    conditions.push(`mr.room_id = $${params.length}`);
  }

  if (filter.assignedTo) {
    if (filter.assignedTo === 'unassigned') {
      conditions.push('mr.assigned_to IS NULL');
    } else {
      params.push(filter.assignedTo);
      conditions.push(`mr.assigned_to = $${params.length}`);
    }
  }

  if (filter.blocksInventory !== undefined) {
    params.push(filter.blocksInventory);
    conditions.push(`mr.blocks_inventory = $${params.length}`);
  }

  if (filter.search && filter.search.trim().length > 0) {
    params.push(`%${filter.search.trim()}%`);
    const idx = params.length;
    conditions.push(
      `(rm.room_number ILIKE $${idx}
        OR rt.name ILIKE $${idx}
        OR mr.title ILIKE $${idx}
        OR mr.description ILIKE $${idx}
        OR mr.resolution_notes ILIKE $${idx}
        OR COALESCE(u_ass.full_name, '') ILIKE $${idx})`
    );
  }

  const sql = `
    ${MAINTENANCE_SELECT}
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE mr.status
        WHEN 'open' THEN 0
        WHEN 'in_progress' THEN 1
        WHEN 'resolved' THEN 2
        ELSE 3
      END ASC,
      CASE mr.priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        ELSE 3
      END ASC,
      mr.reported_at DESC
  `;

  const res = await pool.query(sql, params);
  return res.rows.map(mapMaintenanceRequestRow);
}

export async function getMaintenanceRequestById(
  propertyId: string,
  requestId: string,
  db: Queryable = getPool()
): Promise<MaintenanceRequest> {
  const res = await db.query(
    `${MAINTENANCE_SELECT}
     WHERE mr.id = $1 AND mr.property_id = $2
     LIMIT 1`,
    [requestId, propertyId]
  );
  if (res.rowCount === 0) {
    throw AppError.notFound('Maintenance request not found');
  }
  return mapMaintenanceRequestRow(res.rows[0]);
}

export async function createMaintenanceRequest(
  property: Property,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<{
  maintenanceRequest: MaintenanceRequest;
  affectedReservations: ReservationListItem[];
}> {
  const input = maintenanceCreateSchema.parse(rawInput);
  const propertyToday = getPropertyLocalDate(property.timezone);

  if (input.operationalImpact !== 'none' && actorUser.role !== 'admin') {
    throw AppError.forbidden(
      'Administrator role is required to place a room into Maintenance or Out of Service.'
    );
  }

  const result = await withTransaction(async (client) => {
    const roomRes = await client.query(
      'SELECT * FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [input.roomId, property.id]
    );
    if (roomRes.rowCount === 0) {
      throw AppError.badRequest('Selected room does not belong to this property');
    }
    const room = roomRes.rows[0];
    if (!room.is_active) {
      throw AppError.badRequest('Cannot open maintenance on a deactivated room');
    }

    await validatePropertyStaffAssignee(client, property.id, input.assignedTo);

    const blocksInventory = input.operationalImpact !== 'none';
    const unavailableFrom = blocksInventory ? (input.unavailableFrom ?? propertyToday) : null;
    const unavailableTo = blocksInventory ? (input.unavailableTo ?? null) : null;

    if (unavailableFrom && unavailableTo && unavailableTo <= unavailableFrom) {
      throw AppError.badRequest('Unavailable end date must be after unavailable start date');
    }

    let affectedReservations: ReservationListItem[] = [];
    if (blocksInventory && unavailableFrom) {
      affectedReservations = await findAffectedReservationsForRoom(
        client,
        property.id,
        input.roomId,
        unavailableFrom,
        unavailableTo
      );

      const checkedInConflicts = affectedReservations.filter((r) => r.status === 'checked_in');
      if (checkedInConflicts.length > 0) {
        throw AppError.conflict(
          `Cannot place Room ${room.room_number} Out of Service while in-house booking ${checkedInConflicts[0].bookingReference} (${checkedInConflicts[0].guestName}) is Checked In. Reassign the guest to another available room or complete Check-Out first.`,
          {
            reason: 'OCCUPIED_ROOM_CONFLICT',
            affectedReservations,
          }
        );
      }

      if (affectedReservations.length > 0 && !input.acknowledgeAffectedStays) {
        throw AppError.conflict(
          `Room ${room.room_number} has ${affectedReservations.length} upcoming reservation${affectedReservations.length === 1 ? '' : 's'} overlapping this unavailable period (${affectedReservations.map((r) => r.bookingReference).join(', ')}). Reassign affected stays first or explicitly confirm an out-of-service hold.`,
          {
            reason: 'AFFECTED_RESERVATIONS_CONFLICT',
            affectedReservations,
          }
        );
      }

      // Apply immediate physical operational status if the unavailable period covers today
      if (
        unavailableFrom <= propertyToday &&
        (unavailableTo === null || unavailableTo > propertyToday)
      ) {
        await client.query(
          `UPDATE rooms
           SET operational_status = $1,
               notes = CASE WHEN $2 != '' THEN $2 ELSE notes END,
               updated_at = NOW()
           WHERE id = $3 AND property_id = $4`,
          [input.operationalImpact, input.title, input.roomId, property.id]
        );
      }
    }

    const insertRes = await client.query(
      `INSERT INTO maintenance_requests (
         property_id, room_id, category, title, description, priority,
         status, operational_impact, blocks_inventory, unavailable_from, unavailable_to,
         reported_by, assigned_to
       ) VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        property.id,
        input.roomId,
        input.category,
        input.title,
        input.description,
        input.priority,
        input.operationalImpact,
        blocksInventory,
        unavailableFrom,
        unavailableTo,
        actorUser.id,
        input.assignedTo,
      ]
    );

    const requestId = insertRes.rows[0].id as string;

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'maintenance_request',
        entityId: requestId,
        action: blocksInventory ? 'created_out_of_service' : 'created',
        summary: `Reported maintenance on Room ${room.room_number}: ${input.title}`,
        payload: {
          roomId: input.roomId,
          roomNumber: room.room_number,
          priority: input.priority,
          operationalImpact: input.operationalImpact,
          unavailableFrom,
          unavailableTo,
          affectedBookingReferences: affectedReservations.map((r) => r.bookingReference),
        },
      },
      client
    );

    return { requestId, affectedReservations };
  });

  const maintenanceRequest = await getMaintenanceRequestById(property.id, result.requestId);
  return {
    maintenanceRequest,
    affectedReservations: result.affectedReservations,
  };
}

export async function updateMaintenanceRequest(
  property: Property,
  requestId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<MaintenanceRequest> {
  const input = maintenanceUpdateSchema.parse(rawInput);
  const propertyToday = getPropertyLocalDate(property.timezone);

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT mr.*,
              rm.room_number,
              rm.operational_status AS room_operational_status,
              rm.housekeeping_status AS room_housekeeping_status
       FROM maintenance_requests mr
       JOIN rooms rm ON rm.id = mr.room_id
       WHERE mr.id = $1 AND mr.property_id = $2
       FOR UPDATE OF mr, rm`,
      [requestId, property.id]
    );
    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Maintenance request not found');
    }
    const existing = existingRes.rows[0];

    const affectsInventoryOrAvailability =
      Boolean(existing.blocks_inventory) || existing.operational_impact !== 'none';

    if (affectsInventoryOrAvailability && actorUser.role !== 'admin') {
      throw AppError.forbidden(
        'Administrator role is required to modify, resolve, or cancel maintenance requests that block inventory or affect room operational availability.'
      );
    }

    if (
      (input.unavailableFrom !== undefined || input.unavailableTo !== undefined) &&
      actorUser.role !== 'admin'
    ) {
      throw AppError.forbidden(
        'Administrator role is required to modify room unavailable periods.'
      );
    }

    if (
      (existing.status === 'resolved' || existing.status === 'cancelled') &&
      input.status &&
      input.status !== existing.status
    ) {
      throw AppError.badRequest(
        'Resolved or cancelled maintenance requests cannot be reopened. Record a new maintenance request instead.'
      );
    }

    if (input.assignedTo !== undefined) {
      await validatePropertyStaffAssignee(client, property.id, input.assignedTo);
    }

    const nextStatus = input.status ?? existing.status;
    const nextResolutionNotes =
      input.resolutionNotes !== undefined ? input.resolutionNotes : existing.resolution_notes;

    if (nextStatus === 'resolved' && nextResolutionNotes.trim().length < 2) {
      throw AppError.badRequest(
        'Resolution notes are required when marking a maintenance request Resolved.'
      );
    }

    if (
      (nextStatus === 'resolved' || nextStatus === 'cancelled') &&
      affectsInventoryOrAvailability &&
      (existing.room_operational_status !== 'available' ||
        existing.room_housekeeping_status === 'out_of_service')
    ) {
      const otherActiveBlockRes = await client.query(
        `SELECT id
         FROM maintenance_requests
         WHERE property_id = $1
           AND room_id = $2
           AND id != $3
           AND status IN ('open', 'in_progress')
           AND blocks_inventory = TRUE
           AND unavailable_from <= $4::date
           AND (unavailable_to IS NULL OR unavailable_to > $4::date)
         LIMIT 1`,
        [property.id, existing.room_id, requestId, propertyToday]
      );
      if (otherActiveBlockRes.rowCount === 0) {
        throw AppError.conflict(
          `Room ${existing.room_number} is currently Out of Service / under Maintenance. Use Restore Room to Service (POST /api/rooms/${existing.room_id}/restore-service) so the room's operational and housekeeping states are restored atomically.`,
          { reason: 'ACTIVE_ROOM_RESTORE_REQUIRED', roomId: existing.room_id }
        );
      }
    }

    const nextUnavailableFrom =
      input.unavailableFrom !== undefined ? input.unavailableFrom : existing.unavailable_from;
    const nextUnavailableTo =
      input.unavailableTo !== undefined ? input.unavailableTo : existing.unavailable_to;

    if (nextUnavailableFrom && nextUnavailableTo && nextUnavailableTo <= nextUnavailableFrom) {
      throw AppError.badRequest('Unavailable end date must be after unavailable start date');
    }

    const nextBlocksInventory =
      nextStatus === 'resolved' || nextStatus === 'cancelled'
        ? false
        : Boolean(existing.blocks_inventory);

    if (
      nextBlocksInventory &&
      nextUnavailableFrom &&
      (input.unavailableFrom !== undefined || input.unavailableTo !== undefined)
    ) {
      const affected = await findAffectedReservationsForRoom(
        client,
        property.id,
        existing.room_id,
        nextUnavailableFrom,
        nextUnavailableTo
      );
      const checkedIn = affected.filter((r) => r.status === 'checked_in');
      if (checkedIn.length > 0) {
        throw AppError.conflict(
          `Unavailable window conflicts with checked-in stay ${checkedIn[0].bookingReference}.`,
          { reason: 'OCCUPIED_ROOM_CONFLICT', affectedReservations: affected }
        );
      }

      if (
        existing.operational_impact !== 'none' &&
        nextUnavailableFrom <= propertyToday &&
        (nextUnavailableTo === null || nextUnavailableTo > propertyToday)
      ) {
        await client.query(
          `UPDATE rooms
           SET operational_status = $1,
               updated_at = NOW()
           WHERE id = $2 AND property_id = $3`,
          [existing.operational_impact, existing.room_id, property.id]
        );
      }
    }

    let startedAt = existing.started_at;
    let resolvedAt = existing.resolved_at;
    let resolvedBy = existing.resolved_by;

    if (nextStatus === 'in_progress' && !startedAt) {
      startedAt = new Date().toISOString();
    }
    if (
      (nextStatus === 'resolved' || nextStatus === 'cancelled') &&
      existing.status !== nextStatus
    ) {
      resolvedAt = new Date().toISOString();
      resolvedBy = actorUser.id;
    }

    await client.query(
      `UPDATE maintenance_requests
       SET category = $1,
           title = $2,
           description = $3,
           priority = $4,
           status = $5,
           blocks_inventory = $6,
           unavailable_from = $7,
           unavailable_to = $8,
           assigned_to = $9,
           resolution_notes = $10,
           started_at = $11,
           resolved_at = $12,
           resolved_by = $13,
           updated_at = NOW()
       WHERE id = $14 AND property_id = $15`,
      [
        input.category ?? existing.category,
        input.title ?? existing.title,
        input.description ?? existing.description,
        input.priority ?? existing.priority,
        nextStatus,
        nextBlocksInventory,
        nextUnavailableFrom,
        nextUnavailableTo,
        input.assignedTo !== undefined ? input.assignedTo : existing.assigned_to,
        nextResolutionNotes,
        startedAt,
        resolvedAt,
        resolvedBy,
        requestId,
        property.id,
      ]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'maintenance_request',
        entityId: requestId,
        action: nextStatus !== existing.status ? `status_${nextStatus}` : 'updated',
        summary: `Updated maintenance request on Room ${existing.room_number} (${nextStatus})`,
        payload: {
          fromStatus: existing.status,
          toStatus: nextStatus,
          assignedTo: input.assignedTo !== undefined ? input.assignedTo : existing.assigned_to,
          resolutionNotes: nextResolutionNotes,
        },
      },
      client
    );
  });

  return getMaintenanceRequestById(property.id, requestId);
}

export async function placeRoomOutOfService(
  property: Property,
  roomId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<{
  room: Room;
  maintenanceRequest: MaintenanceRequest;
  affectedReservations: ReservationListItem[];
}> {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden('Administrator role is required to place a room Out of Service.');
  }
  const input = roomOutOfServiceSchema.parse(rawInput);

  const created = await createMaintenanceRequest(property, actorUser, {
    roomId,
    category: input.category,
    title: input.title,
    description: input.description || input.title,
    priority: input.priority,
    assignedTo: input.assignedTo,
    operationalImpact: input.operationalStatus,
    unavailableFrom: input.unavailableFrom ?? getPropertyLocalDate(property.timezone),
    unavailableTo: input.unavailableTo ?? null,
    acknowledgeAffectedStays: input.acknowledgeAffectedStays,
  });

  const room = await getRoomById(property.id, roomId);
  return {
    room,
    maintenanceRequest: created.maintenanceRequest,
    affectedReservations: created.affectedReservations,
  };
}

export async function restoreRoomToService(
  property: Property,
  roomId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<Room> {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden('Administrator role is required to restore a room to service.');
  }
  const input = roomRestoreServiceSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const roomRes = await client.query(
      'SELECT * FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [roomId, property.id]
    );
    if (roomRes.rowCount === 0) {
      throw AppError.notFound('Room not found');
    }
    const existing = roomRes.rows[0];

    await client.query(
      `UPDATE rooms
       SET operational_status = 'available',
           housekeeping_status = $1::varchar(30),
           cleaning_started_at = NULL,
           cleaning_started_by = NULL,
           last_cleaned_at = CASE WHEN $1::text = 'clean' THEN NOW() ELSE last_cleaned_at END,
           last_cleaned_by = CASE WHEN $1::text = 'clean' THEN $2::uuid ELSE last_cleaned_by END,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`,
      [input.housekeepingStatus, actorUser.id, roomId, property.id]
    );

    // Resolve all active maintenance requests on this room and release inventory blocks
    await client.query(
      `UPDATE maintenance_requests
       SET status = 'resolved',
           blocks_inventory = FALSE,
           resolved_at = NOW(),
           resolved_by = $1,
           resolution_notes = CASE
             WHEN resolution_notes = '' THEN $2
             ELSE resolution_notes || E'\n' || $2
           END,
           updated_at = NOW()
       WHERE property_id = $3
         AND room_id = $4
         AND status IN ('open', 'in_progress')`,
      [actorUser.id, input.resolutionNotes, property.id, roomId]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'room',
        entityId: roomId,
        action: 'restored_to_service',
        summary: `Restored Room ${existing.room_number} to operational service (housekeeping: ${input.housekeepingStatus})`,
        payload: {
          previousOperationalStatus: existing.operational_status,
          previousHousekeepingStatus: existing.housekeeping_status,
          housekeepingStatus: input.housekeepingStatus,
          resolutionNotes: input.resolutionNotes,
        },
      },
      client
    );
  });

  return getRoomById(property.id, roomId);
}

export async function getAffectedReservationsForRoomQuery(
  property: Property,
  roomId: string,
  fromQuery?: string,
  toQuery?: string
): Promise<ReservationListItem[]> {
  const fromDate =
    fromQuery && isValidIsoDate(fromQuery)
      ? fromQuery
      : getPropertyLocalDate(property.timezone);
  const toDate = toQuery && isValidIsoDate(toQuery) ? toQuery : null;
  if (toDate && toDate <= fromDate) {
    throw AppError.badRequest('End date must be after start date');
  }
  return findAffectedReservationsForRoom(getPool(), property.id, roomId, fromDate, toDate);
}
