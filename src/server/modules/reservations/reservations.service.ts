import crypto from 'node:crypto';
import type pg from 'pg';
import {
  canTransitionReservationStatus,
  type ReservationStatus,
} from '../../../shared/constants.js';
import { addDays, diffDays, getPropertyLocalDate, isValidIsoDate } from '../../../shared/dates.js';
import { calculateReservationFinancials } from '../../../shared/pricing.js';
import {
  checkInActionSchema,
  checkOutActionSchema,
  reservationCancelSchema,
  reservationCreateSchema,
  reservationUpdateSchema,
} from '../../../shared/schemas.js';
import type {
  CalendarMaintenanceBlock,
  PaginatedResult,
  Property,
  ReservationDetail,
  ReservationListItem,
  RoomCalendarPayload,
} from '../../../shared/types.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import {
  mapGuestRow,
  mapReservationHistoryRow,
  mapReservationRow,
} from '../../services/mappers.js';
import { ensureAndSyncReservationInvoiceInTx } from '../invoices/invoices.service.js';
import { listRooms } from '../rooms/rooms.service.js';

async function generateUniqueBookingRef(
  client: pg.PoolClient,
  propertyCode: string,
  localToday: string
): Promise<string> {
  const datePart = localToday.replace(/-/g, '').slice(2); // YYMMDD
  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = crypto.randomInt(1000, 9999);
    const candidate = `${propertyCode}-${datePart}-${suffix}`;
    const exists = await client.query(
      'SELECT 1 FROM reservations WHERE booking_reference = $1 LIMIT 1',
      [candidate]
    );
    if (exists.rowCount === 0) return candidate;
  }
  return `${propertyCode}-${datePart}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function lockAndValidateRoomForStay(
  client: pg.PoolClient,
  params: {
    propertyId: string;
    roomId: string;
    arrivalDate: string;
    departureDate: string;
    numGuests: number;
    excludeReservationId?: string;
    requireCleanForCheckIn?: boolean;
  }
) {
  // Row-level lock on the room serializes concurrent booking attempts for this room
  const roomRes = await client.query(
    `SELECT r.*,
            rt.name AS room_type_name,
            rt.code AS room_type_code,
            rt.max_capacity,
            rt.base_rate,
            rt.is_active AS room_type_active
     FROM rooms r
     JOIN room_types rt ON rt.id = r.room_type_id
     WHERE r.id = $1 AND r.property_id = $2
     FOR UPDATE OF r`,
    [params.roomId, params.propertyId]
  );

  if (roomRes.rowCount === 0) {
    throw AppError.notFound('Selected room was not found in this property');
  }

  const room = roomRes.rows[0];

  if (!room.is_active || !room.room_type_active) {
    throw AppError.badRequest(
      `Room ${room.room_number} or its category is deactivated and cannot accept reservations.`
    );
  }

  if (room.operational_status !== 'available') {
    throw AppError.badRequest(
      `Room ${room.room_number} is currently marked "${room.operational_status}" and is unavailable for booking.`
    );
  }

  if (room.housekeeping_status === 'out_of_service') {
    throw AppError.badRequest(
      `Room ${room.room_number} is marked Out of Service in housekeeping and cannot accept reservations.`
    );
  }

  // Block bookings or check-ins overlapping active maintenance / out-of-service windows
  const maintBlockRes = await client.query(
    `SELECT id, title, operational_impact, unavailable_from, unavailable_to
     FROM maintenance_requests
     WHERE room_id = $1
       AND status IN ('open', 'in_progress')
       AND blocks_inventory = TRUE
       AND daterange(unavailable_from, COALESCE(unavailable_to, '9999-12-31'::date), '[)')
           && daterange($2::date, $3::date, '[)')
     ORDER BY unavailable_from ASC
     LIMIT 1`,
    [params.roomId, params.arrivalDate, params.departureDate]
  );

  if ((maintBlockRes.rowCount ?? 0) > 0) {
    const maint = maintBlockRes.rows[0];
    throw AppError.conflict(
      `Room ${room.room_number} is unavailable during ${maint.unavailable_from} to ${maint.unavailable_to ?? 'until restored'} due to active maintenance ("${maint.title}").`,
      { conflictingMaintenanceId: maint.id, conflictingMaintenanceTitle: maint.title }
    );
  }

  const maxCap = Number(room.max_capacity);
  if (params.numGuests > maxCap) {
    throw AppError.badRequest(
      `Guest count (${params.numGuests}) exceeds Room ${room.room_number} (${room.room_type_name}) maximum capacity of ${maxCap}.`
    );
  }

  if (params.requireCleanForCheckIn) {
    if (room.housekeeping_status === 'dirty') {
      throw AppError.conflict(
        room.cleaning_started_at
          ? `Room ${room.room_number} is currently in Cleaning in Progress (Dirty). Complete cleaning to Clean or Inspected before checking in.`
          : `Room ${room.room_number} is currently marked Dirty. Update housekeeping status to Clean or Inspected before checking in.`
      );
    }
    const occupiedCheck = await client.query(
      `SELECT booking_reference
       FROM reservations
       WHERE room_id = $1
         AND status = 'checked_in'
         AND ($2::uuid IS NULL OR id != $2::uuid)
       LIMIT 1`,
      [params.roomId, params.excludeReservationId ?? null]
    );
    if ((occupiedCheck.rowCount ?? 0) > 0) {
      throw AppError.conflict(
        `Room ${room.room_number} is still occupied by checked-in booking ${occupiedCheck.rows[0].booking_reference}.`
      );
    }
  }

  // Overlap check on active reservations using half-open [arrival_date, departure_date)
  const overlapRes = await client.query(
    `SELECT booking_reference, arrival_date, departure_date, status
     FROM reservations
     WHERE room_id = $1
       AND status IN ('pending', 'confirmed', 'checked_in')
       AND ($2::uuid IS NULL OR id != $2::uuid)
       AND daterange(arrival_date, departure_date, '[)') && daterange($3::date, $4::date, '[)')
     ORDER BY arrival_date ASC
     LIMIT 1`,
    [
      params.roomId,
      params.excludeReservationId ?? null,
      params.arrivalDate,
      params.departureDate,
    ]
  );

  if ((overlapRes.rowCount ?? 0) > 0) {
    const conflict = overlapRes.rows[0];
    throw AppError.conflict(
      `Room ${room.room_number} is already booked (${conflict.booking_reference}: ${conflict.arrival_date} to ${conflict.departure_date}).`,
      { conflictingBookingReference: conflict.booking_reference }
    );
  }

  return room;
}

export interface ListReservationsFilter {
  search?: string;
  status?: string;
  source?: string;
  roomTypeId?: string;
  arrivalFrom?: string;
  arrivalTo?: string;
  quickFilter?:
    | 'arrivals_today'
    | 'departures_today'
    | 'overdue_checkouts'
    | 'in_house'
    | 'upcoming'
    | 'cancelled';
  sortBy?: 'arrival_date' | 'departure_date' | 'created_at' | 'estimated_total' | 'booking_reference';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export async function listReservations(
  property: Property,
  filter: ListReservationsFilter = {}
): Promise<PaginatedResult<ReservationListItem>> {
  const pool = getPool();
  const propertyToday = getPropertyLocalDate(property.timezone);
  const page = Math.max(1, Math.trunc(filter.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(filter.pageSize ?? 15)));
  const offset = (page - 1) * pageSize;

  const params: unknown[] = [property.id];
  const conditions: string[] = ['r.property_id = $1'];

  if (filter.status) {
    params.push(filter.status);
    conditions.push(`r.status = $${params.length}`);
  }

  if (filter.source) {
    params.push(filter.source);
    conditions.push(`r.source = $${params.length}`);
  }

  if (filter.roomTypeId) {
    params.push(filter.roomTypeId);
    conditions.push(`r.room_type_id = $${params.length}`);
  }

  if (filter.arrivalFrom && isValidIsoDate(filter.arrivalFrom)) {
    params.push(filter.arrivalFrom);
    conditions.push(`r.arrival_date >= $${params.length}::date`);
  }

  if (filter.arrivalTo && isValidIsoDate(filter.arrivalTo)) {
    params.push(filter.arrivalTo);
    conditions.push(`r.arrival_date <= $${params.length}::date`);
  }

  if (filter.quickFilter) {
    switch (filter.quickFilter) {
      case 'arrivals_today':
        params.push(propertyToday);
        conditions.push(
          `r.arrival_date = $${params.length}::date AND r.status IN ('pending', 'confirmed', 'checked_in')`
        );
        break;
      case 'departures_today':
        params.push(propertyToday);
        conditions.push(
          `r.departure_date = $${params.length}::date AND r.status IN ('checked_in', 'checked_out')`
        );
        break;
      case 'overdue_checkouts':
        params.push(propertyToday);
        conditions.push(
          `r.departure_date < $${params.length}::date AND r.status = 'checked_in'`
        );
        break;
      case 'in_house':
        conditions.push(`r.status = 'checked_in'`);
        break;
      case 'upcoming':
        params.push(propertyToday);
        conditions.push(
          `r.arrival_date >= $${params.length}::date AND r.status IN ('pending', 'confirmed')`
        );
        break;
      case 'cancelled':
        conditions.push(`r.status = 'cancelled'`);
        break;
    }
  }

  if (filter.search && filter.search.trim().length > 0) {
    params.push(`%${filter.search.trim()}%`);
    const idx = params.length;
    conditions.push(
      `(r.booking_reference ILIKE $${idx}
        OR CONCAT(g.first_name, ' ', g.last_name) ILIKE $${idx}
        OR g.email ILIKE $${idx}
        OR g.phone ILIKE $${idx}
        OR COALESCE(rm.room_number, '') ILIKE $${idx})`
    );
  }

  const allowedSortColumns: Record<string, string> = {
    arrival_date: 'r.arrival_date',
    departure_date: 'r.departure_date',
    created_at: 'r.created_at',
    estimated_total: 'r.estimated_total',
    booking_reference: 'r.booking_reference',
  };
  const sortCol = allowedSortColumns[filter.sortBy ?? 'arrival_date'] ?? 'r.arrival_date';
  const sortDir = filter.sortDir === 'asc' ? 'ASC' : 'DESC';

  const whereSql = conditions.join(' AND ');

  const countRes = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
     FROM reservations r
     JOIN guests g ON g.id = r.guest_id
     LEFT JOIN rooms rm ON rm.id = r.room_id
     WHERE ${whereSql}`,
    params
  );
  const total = Number(countRes.rows[0]?.total ?? 0);

  params.push(pageSize, offset);
  const dataRes = await pool.query(
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
            rm.cleaning_started_at AS room_cleaning_started_at,
            (
              SELECT COUNT(*)::int FROM maintenance_requests mr_cnt
              WHERE mr_cnt.room_id = rm.id AND mr_cnt.status IN ('open', 'in_progress')
            ) AS room_open_maintenance_count,
            (
              rm.id IS NOT NULL AND (
                rm.operational_status != 'available'
                OR rm.housekeeping_status = 'out_of_service'
                OR EXISTS (
                  SELECT 1 FROM maintenance_requests mr_blk
                  WHERE mr_blk.room_id = rm.id
                    AND mr_blk.status IN ('open', 'in_progress')
                    AND mr_blk.blocks_inventory = TRUE
                    AND daterange(mr_blk.unavailable_from, COALESCE(mr_blk.unavailable_to, '9999-12-31'::date), '[)')
                        && daterange(r.arrival_date, r.departure_date, '[)')
                )
              )
            ) AS room_has_inventory_block
     FROM reservations r
     JOIN guests g ON g.id = r.guest_id
     JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN rooms rm ON rm.id = r.room_id
     WHERE ${whereSql}
     ORDER BY ${sortCol} ${sortDir}, r.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: dataRes.rows.map(mapReservationRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getReservationDetail(
  propertyId: string,
  reservationId: string
): Promise<ReservationDetail> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT r.*,
            g.first_name AS guest_first_name,
            g.last_name AS guest_last_name,
            g.email AS guest_email,
            g.phone AS guest_phone,
            rt.name AS room_type_name,
            rt.code AS room_type_code,
            rt.max_capacity,
            rm.room_number,
            rm.floor AS room_floor,
            rm.housekeeping_status AS room_housekeeping_status,
            rm.operational_status AS room_operational_status,
            rm.cleaning_started_at AS room_cleaning_started_at,
            (
              SELECT COUNT(*)::int FROM maintenance_requests mr_cnt
              WHERE mr_cnt.room_id = rm.id AND mr_cnt.status IN ('open', 'in_progress')
            ) AS room_open_maintenance_count,
            (
              rm.id IS NOT NULL AND (
                rm.operational_status != 'available'
                OR rm.housekeeping_status = 'out_of_service'
                OR EXISTS (
                  SELECT 1 FROM maintenance_requests mr_blk
                  WHERE mr_blk.room_id = rm.id
                    AND mr_blk.status IN ('open', 'in_progress')
                    AND mr_blk.blocks_inventory = TRUE
                    AND daterange(mr_blk.unavailable_from, COALESCE(mr_blk.unavailable_to, '9999-12-31'::date), '[)')
                        && daterange(r.arrival_date, r.departure_date, '[)')
                )
              )
            ) AS room_has_inventory_block
     FROM reservations r
     JOIN guests g ON g.id = r.guest_id
     JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN rooms rm ON rm.id = r.room_id
     WHERE r.id = $1 AND r.property_id = $2
     LIMIT 1`,
    [reservationId, propertyId]
  );

  if (res.rowCount === 0) {
    throw AppError.notFound('Reservation not found');
  }

  const row = res.rows[0];
  const base = mapReservationRow(row);

  const guestRes = await pool.query(
    `SELECT g.*,
            COUNT(r.id) FILTER (WHERE r.status != 'cancelled')::int AS total_reservations,
            COUNT(r.id) FILTER (WHERE r.status = 'checked_in')::int AS active_stays
     FROM guests g
     LEFT JOIN reservations r ON r.guest_id = g.id
     WHERE g.id = $1 AND g.property_id = $2
     GROUP BY g.id`,
    [row.guest_id, propertyId]
  );

  const historyRes = await pool.query(
    `SELECT h.*,
            u.full_name AS changed_by_name,
            u.role AS changed_by_role
     FROM reservation_status_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.reservation_id = $1
     ORDER BY h.created_at DESC`,
    [reservationId]
  );

  return {
    ...base,
    maxCapacity: Number(row.max_capacity),
    guest: mapGuestRow(guestRes.rows[0]),
    history: historyRes.rows.map(mapReservationHistoryRow),
  };
}

export async function createReservation(
  property: Property,
  actorUserId: string,
  rawInput: unknown,
  referenceDate: Date = new Date()
): Promise<ReservationDetail> {
  const input = reservationCreateSchema.parse(rawInput);
  const propertyToday = getPropertyLocalDate(property.timezone, referenceDate);

  if (input.arrivalDate < propertyToday) {
    throw AppError.badRequest(
      `Arrival date (${input.arrivalDate}) cannot be earlier than the property's current local date (${propertyToday} in ${property.timezone}).`,
      {
        reason: 'PAST_ARRIVAL_DATE',
        arrivalDate: input.arrivalDate,
        propertyToday,
        timezone: property.timezone,
      }
    );
  }

  const createdId = await withTransaction(async (client) => {
    const guestRes = await client.query(
      'SELECT id, first_name, last_name FROM guests WHERE id = $1 AND property_id = $2',
      [input.guestId, property.id]
    );
    if (guestRes.rowCount === 0) {
      throw AppError.badRequest('Selected guest does not belong to this property');
    }

    const numGuests = input.adults + input.children;
    const isWalkIn = Boolean(input.isWalkIn || input.source === 'walk_in');
    const checkInNow = Boolean(input.checkInImmediately);

    if (checkInNow && input.arrivalDate !== propertyToday) {
      throw AppError.badRequest(
        `Immediate check-in requires arrival date (${input.arrivalDate}) to match today's property date (${propertyToday}).`
      );
    }

    const room = await lockAndValidateRoomForStay(client, {
      propertyId: property.id,
      roomId: input.roomId,
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      numGuests,
      requireCleanForCheckIn: checkInNow,
    });

    const nights = diffDays(input.arrivalDate, input.departureDate);
    const nightlyRate =
      input.nightlyRate !== undefined ? input.nightlyRate : Number(room.base_rate);

    let financials;
    try {
      financials = calculateReservationFinancials({
        nights,
        nightlyRate,
        discountAmount: input.discountAmount,
        taxRate: property.defaultTaxRate,
      });
    } catch (e) {
      throw AppError.badRequest((e as Error).message);
    }

    const bookingReference = await generateUniqueBookingRef(
      client,
      property.code,
      propertyToday
    );

    const initialStatus: ReservationStatus = checkInNow ? 'checked_in' : input.status;
    const source = isWalkIn ? 'walk_in' : input.source;

    const insertRes = await client.query(
      `INSERT INTO reservations (
         property_id, booking_reference, guest_id, room_type_id, room_id,
         arrival_date, departure_date, adults, children, num_guests,
         nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
         currency, source, is_walk_in, status, special_requests, internal_notes,
         checked_in_at, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
         $22,$23,$23
       ) RETURNING id`,
      [
        property.id,
        bookingReference,
        input.guestId,
        room.room_type_id,
        room.id,
        input.arrivalDate,
        input.departureDate,
        input.adults,
        input.children,
        numGuests,
        financials.nightlyRate,
        financials.discountAmount,
        financials.taxRate,
        financials.taxAmount,
        financials.estimatedTotal,
        property.currency,
        source,
        isWalkIn,
        initialStatus,
        input.specialRequests,
        input.internalNotes,
        checkInNow ? new Date().toISOString() : null,
        actorUserId,
      ]
    );

    const reservationId = insertRes.rows[0].id as string;

    await client.query(
      `INSERT INTO reservation_status_history (
         reservation_id, property_id, from_status, to_status, action, note, metadata, changed_by
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, $7)`,
      [
        reservationId,
        property.id,
        initialStatus,
        checkInNow ? 'walk_in_checked_in' : isWalkIn ? 'walk_in_created' : 'created',
        checkInNow
          ? `Walk-in reservation created and checked into Room ${room.room_number}`
          : `Reservation created for Room ${room.room_number} (${nights} night${nights === 1 ? '' : 's'})`,
        JSON.stringify({
          roomNumber: room.room_number,
          arrivalDate: input.arrivalDate,
          departureDate: input.departureDate,
          estimatedTotal: financials.estimatedTotal,
        }),
        actorUserId,
      ]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId,
        entityType: 'reservation',
        entityId: reservationId,
        action: checkInNow ? 'walk_in_checked_in' : 'created',
        summary: `Created booking ${bookingReference} for ${guestRes.rows[0].first_name} ${guestRes.rows[0].last_name} in Room ${room.room_number}`,
      },
      client
    );

    return reservationId;
  });

  return getReservationDetail(property.id, createdId);
}

export async function updateReservation(
  property: Property,
  reservationId: string,
  actorUserId: string,
  rawInput: unknown
): Promise<ReservationDetail> {
  const input = reservationUpdateSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      'SELECT * FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [reservationId, property.id]
    );

    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Reservation not found');
    }

    const existing = existingRes.rows[0];
    const currentStatus = existing.status as ReservationStatus;

    if (currentStatus === 'cancelled' || currentStatus === 'checked_out') {
      throw AppError.badRequest(
        `Cannot modify a ${currentStatus.replace('_', ' ')} reservation.`
      );
    }

    // Disallow bypassing explicit check-in / check-out / cancel flows via generic update
    const nextStatus = (input.status ?? currentStatus) as ReservationStatus;
    if (nextStatus !== currentStatus) {
      if (nextStatus === 'checked_in' || nextStatus === 'checked_out') {
        throw AppError.badRequest(
          `Use the dedicated Check-In or Check-Out action to transition a reservation to ${nextStatus.replace('_', ' ')}.`
        );
      }
      if (nextStatus === 'cancelled') {
        throw AppError.badRequest('Use the Cancel Reservation action to cancel a booking.');
      }
      if (!canTransitionReservationStatus(currentStatus, nextStatus)) {
        throw AppError.badRequest(
          `Invalid reservation status transition from "${currentStatus}" to "${nextStatus}".`
        );
      }
    }

    const nextArrival = input.arrivalDate ?? existing.arrival_date;
    const nextDeparture = input.departureDate ?? existing.departure_date;

    if (diffDays(nextArrival, nextDeparture) < 1) {
      throw AppError.badRequest('Departure date must be after arrival date (minimum 1 night)');
    }

    // If reservation is already checked in, arrival date is locked unless kept valid
    if (currentStatus === 'checked_in' && nextArrival !== existing.arrival_date) {
      if (nextArrival > property.localToday) {
        throw AppError.badRequest(
          'Cannot move arrival date into the future for a guest who is already checked in.'
        );
      }
    }

    const nextAdults = input.adults ?? Number(existing.adults);
    const nextChildren = input.children ?? Number(existing.children);
    const nextGuests = nextAdults + nextChildren;
    const nextRoomId = input.roomId ?? existing.room_id;

    if (!nextRoomId) {
      throw AppError.badRequest('A valid room must be assigned to the reservation');
    }

    const room = await lockAndValidateRoomForStay(client, {
      propertyId: property.id,
      roomId: nextRoomId,
      arrivalDate: nextArrival,
      departureDate: nextDeparture,
      numGuests: nextGuests,
      excludeReservationId: reservationId,
      requireCleanForCheckIn:
        currentStatus === 'checked_in' && nextRoomId !== existing.room_id,
    });

    const nights = diffDays(nextArrival, nextDeparture);
    const nextNightlyRate =
      input.nightlyRate !== undefined ? input.nightlyRate : Number(existing.nightly_rate);
    const nextDiscount =
      input.discountAmount !== undefined
        ? input.discountAmount
        : Number(existing.discount_amount);

    let financials;
    try {
      financials = calculateReservationFinancials({
        nights,
        nightlyRate: nextNightlyRate,
        discountAmount: nextDiscount,
        taxRate: Number(existing.tax_rate ?? property.defaultTaxRate),
      });
    } catch (e) {
      throw AppError.badRequest((e as Error).message);
    }

    await client.query(
      `UPDATE reservations
       SET room_type_id = $1,
           room_id = $2,
           arrival_date = $3,
           departure_date = $4,
           adults = $5,
           children = $6,
           num_guests = $7,
           nightly_rate = $8,
           discount_amount = $9,
           tax_amount = $10,
           estimated_total = $11,
           source = $12,
           status = $13,
           special_requests = $14,
           internal_notes = $15,
           updated_by = $16,
           updated_at = NOW()
       WHERE id = $17 AND property_id = $18`,
      [
        room.room_type_id,
        room.id,
        nextArrival,
        nextDeparture,
        nextAdults,
        nextChildren,
        nextGuests,
        financials.nightlyRate,
        financials.discountAmount,
        financials.taxAmount,
        financials.estimatedTotal,
        input.source ?? existing.source,
        nextStatus,
        input.specialRequests ?? existing.special_requests,
        input.internalNotes ?? existing.internal_notes,
        actorUserId,
        reservationId,
        property.id,
      ]
    );

    // If an in-house guest changed rooms, mark previous room as dirty
    if (currentStatus === 'checked_in' && existing.room_id && existing.room_id !== room.id) {
      await client.query(
        `UPDATE rooms SET housekeeping_status = 'dirty', updated_at = NOW()
         WHERE id = $1 AND property_id = $2 AND housekeeping_status != 'out_of_service'`,
        [existing.room_id, property.id]
      );
    }

    const changeParts: string[] = [];
    if (nextArrival !== existing.arrival_date || nextDeparture !== existing.departure_date) {
      changeParts.push(
        `dates ${existing.arrival_date}→${existing.departure_date} to ${nextArrival}→${nextDeparture}`
      );
    }
    if (room.id !== existing.room_id) {
      changeParts.push(`assigned to Room ${room.room_number}`);
    }
    if (nextStatus !== currentStatus) {
      changeParts.push(`status ${currentStatus} → ${nextStatus}`);
    }
    if (input.editReason) {
      changeParts.push(`reason: ${input.editReason}`);
    }

    await client.query(
      `INSERT INTO reservation_status_history (
         reservation_id, property_id, from_status, to_status, action, note, metadata, changed_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        reservationId,
        property.id,
        currentStatus,
        nextStatus,
        nextStatus !== currentStatus ? 'status_updated' : 'updated',
        changeParts.length > 0 ? `Updated ${changeParts.join('; ')}` : 'Updated reservation details',
        JSON.stringify({
          previousArrival: existing.arrival_date,
          previousDeparture: existing.departure_date,
          arrivalDate: nextArrival,
          departureDate: nextDeparture,
          roomNumber: room.room_number,
          estimatedTotal: financials.estimatedTotal,
        }),
        actorUserId,
      ]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId,
        entityType: 'reservation',
        entityId: reservationId,
        action: 'updated',
        summary: `Updated booking ${existing.booking_reference}`,
      },
      client
    );

    // Keep any active non-void invoice synchronized with stay dates, room, rate, and stay discount
    await ensureAndSyncReservationInvoiceInTx(client, property, reservationId, actorUserId, {
      onlyIfExisting: true,
    });
  });

  return getReservationDetail(property.id, reservationId);
}

export async function cancelReservation(
  property: Property,
  reservationId: string,
  actorUserId: string,
  rawInput: unknown
): Promise<ReservationDetail> {
  const input = reservationCancelSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      'SELECT * FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [reservationId, property.id]
    );

    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Reservation not found');
    }

    const existing = existingRes.rows[0];
    const currentStatus = existing.status as ReservationStatus;

    if (!canTransitionReservationStatus(currentStatus, 'cancelled')) {
      throw AppError.badRequest(
        currentStatus === 'checked_in'
          ? 'Cannot cancel a reservation that is already Checked In. Use Check-Out instead.'
          : `Reservation in "${currentStatus}" status cannot be cancelled.`
      );
    }

    await client.query(
      `UPDATE reservations
       SET status = 'cancelled',
           cancellation_reason = $1,
           cancelled_at = NOW(),
           updated_by = $2,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`,
      [input.reason, actorUserId, reservationId, property.id]
    );

    await client.query(
      `INSERT INTO reservation_status_history (
         reservation_id, property_id, from_status, to_status, action, note, metadata, changed_by
       ) VALUES ($1, $2, $3, 'cancelled', 'cancelled', $4, $5::jsonb, $6)`,
      [
        reservationId,
        property.id,
        currentStatus,
        `Cancelled: ${input.reason}`,
        JSON.stringify({ reason: input.reason }),
        actorUserId,
      ]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId,
        entityType: 'reservation',
        entityId: reservationId,
        action: 'cancelled',
        summary: `Cancelled booking ${existing.booking_reference}: ${input.reason}`,
      },
      client
    );
  });

  return getReservationDetail(property.id, reservationId);
}

export async function checkInReservation(
  property: Property,
  reservationId: string,
  actorUserId: string,
  rawInput: unknown
): Promise<ReservationDetail> {
  const input = checkInActionSchema.parse(rawInput ?? {});

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      'SELECT * FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [reservationId, property.id]
    );

    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Reservation not found');
    }

    const existing = existingRes.rows[0];
    const currentStatus = existing.status as ReservationStatus;

    if (!canTransitionReservationStatus(currentStatus, 'checked_in')) {
      throw AppError.badRequest(
        `Reservation in "${currentStatus}" status cannot be checked in.`
      );
    }

    // Require arrival_date to match property's today unless deliberately edited first
    if (existing.arrival_date !== property.localToday) {
      throw AppError.badRequest(
        `Scheduled arrival date (${existing.arrival_date}) does not match today's property date (${property.localToday}). To check in early or adjust stay dates, edit and validate the reservation dates first.`,
        {
          reason: 'ARRIVAL_DATE_MISMATCH',
          arrivalDate: existing.arrival_date,
          propertyToday: property.localToday,
        }
      );
    }

    const targetRoomId = input.roomId ?? existing.room_id;
    if (!targetRoomId) {
      throw AppError.badRequest('Assign a room before checking in the guest.');
    }

    const room = await lockAndValidateRoomForStay(client, {
      propertyId: property.id,
      roomId: targetRoomId,
      arrivalDate: existing.arrival_date,
      departureDate: existing.departure_date,
      numGuests: Number(existing.num_guests),
      excludeReservationId: reservationId,
      requireCleanForCheckIn: true,
    });

    await client.query(
      `UPDATE reservations
       SET status = 'checked_in',
           room_id = $1,
           room_type_id = $2,
           checked_in_at = NOW(),
           updated_by = $3,
           updated_at = NOW()
       WHERE id = $4 AND property_id = $5`,
      [room.id, room.room_type_id, actorUserId, reservationId, property.id]
    );

    await client.query(
      `INSERT INTO reservation_status_history (
         reservation_id, property_id, from_status, to_status, action, note, metadata, changed_by
       ) VALUES ($1, $2, $3, 'checked_in', 'checked_in', $4, $5::jsonb, $6)`,
      [
        reservationId,
        property.id,
        currentStatus,
        input.note
          ? `Checked into Room ${room.room_number} — ${input.note}`
          : `Guest checked into Room ${room.room_number}`,
        JSON.stringify({ roomNumber: room.room_number }),
        actorUserId,
      ]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId,
        entityType: 'reservation',
        entityId: reservationId,
        action: 'checked_in',
        summary: `Checked in ${existing.booking_reference} (Room ${room.room_number})`,
      },
      client
    );
  });

  return getReservationDetail(property.id, reservationId);
}

export async function checkOutReservation(
  property: Property,
  reservationId: string,
  actorUserId: string,
  rawInput: unknown
): Promise<ReservationDetail> {
  const input = checkOutActionSchema.parse(rawInput ?? {});

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      'SELECT * FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [reservationId, property.id]
    );

    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Reservation not found');
    }

    const existing = existingRes.rows[0];
    const currentStatus = existing.status as ReservationStatus;

    if (currentStatus !== 'checked_in') {
      throw AppError.badRequest(
        `Only Checked-In reservations can be checked out (current status: "${currentStatus}").`
      );
    }

    // Require departure_date to match property's today unless deliberately edited first
    if (existing.departure_date !== property.localToday) {
      throw AppError.badRequest(
        `Scheduled departure date (${existing.departure_date}) does not match today's property date (${property.localToday}). For an early or late departure, edit and validate the departure date first so stay nights and availability stay accurate.`,
        {
          reason: 'DEPARTURE_DATE_MISMATCH',
          departureDate: existing.departure_date,
          propertyToday: property.localToday,
        }
      );
    }

    await client.query(
      `UPDATE reservations
       SET status = 'checked_out',
           checked_out_at = NOW(),
           updated_by = $1,
           updated_at = NOW()
       WHERE id = $2 AND property_id = $3`,
      [actorUserId, reservationId, property.id]
    );

    let roomNumber = '';
    if (existing.room_id) {
      const roomUpdate = await client.query(
        `UPDATE rooms
         SET housekeeping_status = CASE
               WHEN housekeeping_status = 'out_of_service' THEN 'out_of_service'
               ELSE 'dirty'
             END,
             cleaning_started_at = NULL,
             cleaning_started_by = NULL,
             updated_at = NOW()
         WHERE id = $1 AND property_id = $2
         RETURNING room_number, housekeeping_status`,
        [existing.room_id, property.id]
      );
      roomNumber = roomUpdate.rows[0]?.room_number ?? '';

      // Automatically queue a Pending turnover cleaning task for today if none is open on this room
      if (roomUpdate.rows[0]?.housekeeping_status === 'dirty') {
        const existingOpenTurnover = await client.query(
          `SELECT id FROM housekeeping_tasks
           WHERE property_id = $1
             AND room_id = $2
             AND status IN ('pending', 'in_progress')
             AND task_type != 'inspection'
           LIMIT 1`,
          [property.id, existing.room_id]
        );
        if (existingOpenTurnover.rowCount === 0) {
          await client.query(
            `INSERT INTO housekeeping_tasks (
               property_id, room_id, reservation_id, task_type, priority, status,
               scheduled_for, notes, created_by, updated_by
             ) VALUES (
               $1, $2, $3, 'turnover_clean', 'high', 'pending',
               $4, $5, $6, $6
             )`,
            [
              property.id,
              existing.room_id,
              reservationId,
              property.localToday,
              `Post-checkout turnover clean (${existing.booking_reference})`,
              actorUserId,
            ]
          );
        }
      }
    }

    await client.query(
      `INSERT INTO reservation_status_history (
         reservation_id, property_id, from_status, to_status, action, note, metadata, changed_by
       ) VALUES ($1, $2, 'checked_in', 'checked_out', 'checked_out', $3, $4::jsonb, $5)`,
      [
        reservationId,
        property.id,
        input.note
          ? `Checked out of Room ${roomNumber} — ${input.note}`
          : `Guest checked out of Room ${roomNumber}; room marked Dirty for turnover`,
        JSON.stringify({ roomNumber, markedDirty: true }),
        actorUserId,
      ]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId,
        entityType: 'reservation',
        entityId: reservationId,
        action: 'checked_out',
        summary: `Checked out ${existing.booking_reference} (Room ${roomNumber})`,
      },
      client
    );

    // Ensure & issue the reservation's invoice on checkout without blocking checkout or auto-marking paid
    await ensureAndSyncReservationInvoiceInTx(client, property, reservationId, actorUserId, {
      issueImmediately: true,
    });
  });

  return getReservationDetail(property.id, reservationId);
}

export interface RoomCalendarFilter {
  startDate?: string;
  endDate?: string;
  days?: number;
  roomTypeId?: string;
  floor?: string;
  search?: string;
  includeCheckedOut?: boolean;
}

export async function getRoomCalendar(
  property: Property,
  filter: RoomCalendarFilter = {},
  referenceDate: Date = new Date()
): Promise<RoomCalendarPayload> {
  const pool = getPool();
  const propertyToday = getPropertyLocalDate(property.timezone, referenceDate);

  const startDate = filter.startDate ?? propertyToday;
  if (!isValidIsoDate(startDate)) {
    throw AppError.badRequest('Invalid calendar startDate (must be YYYY-MM-DD)');
  }

  let days: number;
  if (filter.days === undefined) {
    days = 14;
  } else {
    if (
      !Number.isFinite(filter.days) ||
      !Number.isInteger(filter.days) ||
      filter.days < 1 ||
      filter.days > 45
    ) {
      throw AppError.badRequest('Calendar days must be between 1 and 45');
    }
    days = filter.days;
  }

  let endDate: string;

  if (filter.endDate) {
    if (!isValidIsoDate(filter.endDate)) {
      throw AppError.badRequest('Invalid calendar endDate (must be YYYY-MM-DD)');
    }
    const span = diffDays(startDate, filter.endDate);
    if (span < 1 || span > 45) {
      throw AppError.badRequest('Calendar date range must span between 1 and 45 days');
    }
    days = span;
    endDate = filter.endDate;
  } else {
    endDate = addDays(startDate, days);
  }

  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(addDays(startDate, i));
  }

  const rooms = await listRooms(property.id, {
    includeInactive: false,
    roomTypeId: filter.roomTypeId,
    floor: filter.floor,
    search: filter.search,
  });

  const roomIds = rooms.map((r) => r.id);
  if (roomIds.length === 0) {
    return {
      property: { ...property, localToday: propertyToday },
      propertyToday,
      startDate,
      endDate,
      days,
      dates,
      rooms: [],
      reservations: [],
      maintenanceBlocks: [],
    };
  }

  const includeCheckedOut = filter.includeCheckedOut !== false;
  const allowedStatuses = includeCheckedOut
    ? ['pending', 'confirmed', 'checked_in', 'checked_out']
    : ['pending', 'confirmed', 'checked_in'];

  const [resQuery, maintQuery] = await Promise.all([
    pool.query(
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
         AND r.room_id = ANY($2::uuid[])
         AND r.status = ANY($3::text[])
         AND daterange(r.arrival_date, r.departure_date, '[)')
             && daterange($4::date, $5::date, '[)')
       ORDER BY r.arrival_date ASC, r.created_at ASC`,
      [property.id, roomIds, allowedStatuses, startDate, endDate]
    ),
    pool.query(
      `SELECT mr.id,
              mr.room_id,
              rm.room_number,
              mr.title,
              mr.priority,
              mr.status,
              mr.operational_impact,
              mr.unavailable_from,
              mr.unavailable_to
       FROM maintenance_requests mr
       JOIN rooms rm ON rm.id = mr.room_id
       WHERE mr.property_id = $1
         AND mr.room_id = ANY($2::uuid[])
         AND mr.status IN ('open', 'in_progress')
         AND mr.blocks_inventory = TRUE
         AND daterange(mr.unavailable_from, COALESCE(mr.unavailable_to, '9999-12-31'::date), '[)')
             && daterange($3::date, $4::date, '[)')
       ORDER BY mr.unavailable_from ASC`,
      [property.id, roomIds, startDate, endDate]
    ),
  ]);

  const maintenanceBlocks: CalendarMaintenanceBlock[] = maintQuery.rows.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    roomNumber: row.room_number,
    title: row.title,
    priority: row.priority,
    status: row.status,
    operationalImpact: row.operational_impact,
    unavailableFrom: row.unavailable_from,
    unavailableTo: row.unavailable_to ?? null,
  }));

  return {
    property: { ...property, localToday: propertyToday },
    propertyToday,
    startDate,
    endDate,
    days,
    dates,
    rooms,
    reservations: resQuery.rows.map(mapReservationRow),
    maintenanceBlocks,
  };
}
