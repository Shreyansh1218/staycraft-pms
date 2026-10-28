import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, getPropertyLocalDate } from '../src/shared/dates.js';
import { createApiApp } from '../src/server/app.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { closePool, getPool } from '../src/server/db/pool.js';
import { hashPassword } from '../src/server/security/password.js';

const app = createApiApp();

const NONEXISTENT_UUID = '00000000-0000-4000-8000-000000000999';

let adminAgent: ReturnType<typeof request.agent>;
let receptionistAgent: ReturnType<typeof request.agent>;
let adminId = '';
let receptionistId = '';

let propKolkataId = '';
let propHonoluluId = '';
let kolkataToday = '';
let honoluluToday = '';

let stdTypeId = '';
let activeRoomAId = '';
let activeRoomBId = '';
let inactiveRoomId = '';
let honoluluRoomId = '';
let guestId = '';

beforeAll(async () => {
  const pool = getPool();

  // Strictly isolated staycraft_pms_test fixture setup (NODE_ENV === 'test')
  const dbCheck = await pool.query('SELECT current_database() AS db');
  if (dbCheck.rows[0].db !== 'staycraft_pms_test') {
    throw new Error(`Refusing to run destructive test setup on database: ${dbCheck.rows[0].db}`);
  }

  await runMigrations();

  await pool.query(`
    TRUNCATE TABLE
      audit_events,
      maintenance_requests,
      housekeeping_tasks,
      reservation_status_history,
      reservations,
      guests,
      rooms,
      room_types,
      user_sessions,
      user_property_access,
      users,
      properties
    RESTART IDENTITY CASCADE;
  `);

  const adminHash = await hashPassword('Admin@12345');
  const recHash = await hashPassword('FrontDesk@123');

  const uAdmin = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('audit-admin@staycraft.test', $1, 'Audit Admin', 'admin') RETURNING id`,
    [adminHash]
  );
  const uRec = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('audit-rec@staycraft.test', $1, 'Audit Receptionist', 'receptionist') RETURNING id`,
    [recHash]
  );
  adminId = uAdmin.rows[0].id as string;
  receptionistId = uRec.rows[0].id as string;

  const pKol = await pool.query(
    `INSERT INTO properties (code, name, email, phone, address_line1, city, country, timezone, currency, default_tax_rate, tax_name)
     VALUES ('AUD1', 'Audit Kolkata Property', 'kol@audit.test', '+91 542 000 0001', 'Assi Ghat', 'Varanasi', 'India', 'Asia/Kolkata', 'INR', 12.00, 'GST')
     RETURNING id`
  );
  const pHnl = await pool.query(
    `INSERT INTO properties (code, name, email, phone, address_line1, city, country, timezone, currency, default_tax_rate, tax_name)
     VALUES ('AUD2', 'Audit Honolulu Property', 'hnl@audit.test', '+1 808 000 0002', 'Kalakaua Ave', 'Honolulu', 'USA', 'Pacific/Honolulu', 'USD', 10.00, 'TAT')
     RETURNING id`
  );
  propKolkataId = pKol.rows[0].id as string;
  propHonoluluId = pHnl.rows[0].id as string;
  kolkataToday = getPropertyLocalDate('Asia/Kolkata');
  honoluluToday = getPropertyLocalDate('Pacific/Honolulu');

  // Admin has access to both; Receptionist ONLY has access to AUD1
  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id, is_default)
     VALUES ($1, $3, TRUE), ($1, $4, FALSE), ($2, $3, TRUE)`,
    [adminId, receptionistId, propKolkataId, propHonoluluId]
  );

  const rtKol = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'KSTD', 'Kolkata Standard', 2, 2, 4500) RETURNING id`,
    [propKolkataId]
  );
  const rtHnl = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'HSTD', 'Honolulu Ocean', 2, 2, 250) RETURNING id`,
    [propHonoluluId]
  );
  stdTypeId = rtKol.rows[0].id as string;

  const rA = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
     VALUES ($1, $2, '301', '3', 'available', 'inspected', TRUE) RETURNING id`,
    [propKolkataId, stdTypeId]
  );
  const rB = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
     VALUES ($1, $2, '302', '3', 'available', 'clean', TRUE) RETURNING id`,
    [propKolkataId, stdTypeId]
  );
  const rInact = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
     VALUES ($1, $2, '399', '3', 'available', 'dirty', FALSE) RETURNING id`,
    [propKolkataId, stdTypeId]
  );
  const rHnl = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
     VALUES ($1, $2, 'H101', '1', 'available', 'inspected', TRUE) RETURNING id`,
    [propHonoluluId, rtHnl.rows[0].id]
  );

  activeRoomAId = rA.rows[0].id as string;
  activeRoomBId = rB.rows[0].id as string;
  inactiveRoomId = rInact.rows[0].id as string;
  honoluluRoomId = rHnl.rows[0].id as string;

  const g = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, phone, email)
     VALUES ($1, 'Kabir', 'Sen', '+91 98300 11223', 'kabir@audit.test') RETURNING id`,
    [propKolkataId]
  );
  guestId = g.rows[0].id as string;

  adminAgent = request.agent(app);
  receptionistAgent = request.agent(app);

  await adminAgent
    .post('/api/auth/login')
    .send({ email: 'audit-admin@staycraft.test', password: 'Admin@12345' })
    .expect(200);
  await receptionistAgent
    .post('/api/auth/login')
    .send({ email: 'audit-rec@staycraft.test', password: 'FrontDesk@123' })
    .expect(200);
});

afterAll(async () => {
  await closePool();
});

describe('Phase 2 Audit — Deactivated Rooms, Input Validation & Concurrent Check-Out Safety', () => {
  it('consistently excludes deactivated rooms from active boards/calendar/totals and rejects tasks, workflow transitions, maintenance, and bookings on inactive rooms', async () => {
    // Excluded from default /api/rooms, /api/dashboard, and /api/reservations/calendar
    const roomsRes = await receptionistAgent
      .get('/api/rooms')
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    expect(roomsRes.body.items.map((r: { id: string }) => r.id)).not.toContain(inactiveRoomId);

    const dashRes = await receptionistAgent
      .get('/api/dashboard')
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    expect(dashRes.body.metrics.totalRooms).toBe(2);
    const hc = dashRes.body.housekeepingCounts;
    expect(hc.inspected + hc.clean + hc.dirty + hc.out_of_service).toBe(2);

    const calRes = await receptionistAgent
      .get('/api/reservations/calendar')
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    expect(calRes.body.rooms.map((r: { id: string }) => r.id)).not.toContain(inactiveRoomId);

    // Rejects housekeeping task creation, cleaning workflow, maintenance, and reservation on inactive room
    await receptionistAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: inactiveRoomId,
        taskType: 'turnover_clean',
        priority: 'normal',
        dueDate: kolkataToday,
      })
      .expect(400);

    await receptionistAgent
      .post(`/api/rooms/${inactiveRoomId}/housekeeping-workflow`)
      .set('X-Property-Id', propKolkataId)
      .send({ action: 'start_cleaning' })
      .expect(400);

    await receptionistAgent
      .post('/api/maintenance')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: inactiveRoomId,
        category: 'general',
        title: 'Inactive room check',
        description: 'Should reject inactive room',
        priority: 'normal',
        operationalImpact: 'none',
      })
      .expect(400);

    await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propKolkataId)
      .send({
        guestId,
        roomId: inactiveRoomId,
        arrivalDate: kolkataToday,
        departureDate: addDays(kolkataToday, 1),
        adults: 1,
        children: 0,
        source: 'direct',
      })
      .expect(400);
  });

  it('rejects invalid task/maintenance/calendar inputs, nonexistent UUIDs (404), and cross-property entity mutations', async () => {
    // Invalid task inputs: missing roomId, invalid enum, impossible calendar date
    await receptionistAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propKolkataId)
      .send({ taskType: 'turnover_clean', priority: 'normal', dueDate: kolkataToday })
      .expect(400);

    await receptionistAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: activeRoomAId,
        taskType: 'invalid_type',
        priority: 'normal',
        dueDate: kolkataToday,
      })
      .expect(400);

    await receptionistAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: activeRoomAId,
        taskType: 'turnover_clean',
        priority: 'normal',
        dueDate: '2026-02-30',
      })
      .expect(400);

    // Invalid maintenance inputs: missing title, unavailableTo <= unavailableFrom, resolve without resolutionNotes
    await adminAgent
      .post('/api/maintenance')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: activeRoomAId,
        category: 'hvac',
        title: '',
        description: 'Missing title',
        priority: 'high',
        operationalImpact: 'none',
      })
      .expect(400);

    await adminAgent
      .post('/api/maintenance')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: activeRoomAId,
        category: 'hvac',
        title: 'Bad window',
        description: 'End before start',
        priority: 'high',
        operationalImpact: 'out_of_service',
        unavailableFrom: addDays(kolkataToday, 5),
        unavailableTo: addDays(kolkataToday, 5),
      })
      .expect(400);

    const createdMaint = await receptionistAgent
      .post('/api/maintenance')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: activeRoomAId,
        category: 'appliance',
        title: 'Kettle switch loose',
        description: 'Replace electric kettle base',
        priority: 'low',
        operationalImpact: 'none',
      })
      .expect(201);

    // Resolving without resolutionNotes -> 400
    await receptionistAgent
      .put(`/api/maintenance/${createdMaint.body.maintenanceRequest.id}`)
      .set('X-Property-Id', propKolkataId)
      .send({ status: 'resolved', resolutionNotes: '' })
      .expect(400);

    // Resolve properly, then verify resolved ticket cannot be reopened -> 400
    await receptionistAgent
      .put(`/api/maintenance/${createdMaint.body.maintenanceRequest.id}`)
      .set('X-Property-Id', propKolkataId)
      .send({ status: 'resolved', resolutionNotes: 'Replaced kettle base' })
      .expect(200);

    await receptionistAgent
      .put(`/api/maintenance/${createdMaint.body.maintenanceRequest.id}`)
      .set('X-Property-Id', propKolkataId)
      .send({ status: 'open' })
      .expect(400);

    // Invalid calendar parameters: bad startDate, days > 45, days < 0
    await receptionistAgent
      .get('/api/reservations/calendar?startDate=2026-02-29&days=7')
      .set('X-Property-Id', propKolkataId)
      .expect(400);
    await receptionistAgent
      .get('/api/reservations/calendar?days=90')
      .set('X-Property-Id', propKolkataId)
      .expect(400);
    await receptionistAgent
      .get('/api/reservations/calendar?days=-5')
      .set('X-Property-Id', propKolkataId)
      .expect(400);

    // Nonexistent valid UUIDs -> 404
    await receptionistAgent
      .get(`/api/housekeeping/tasks/${NONEXISTENT_UUID}`)
      .set('X-Property-Id', propKolkataId)
      .expect(404);
    await receptionistAgent
      .put(`/api/housekeeping/tasks/${NONEXISTENT_UUID}`)
      .set('X-Property-Id', propKolkataId)
      .send({ notes: 'Missing' })
      .expect(404);
    await receptionistAgent
      .get(`/api/maintenance/${NONEXISTENT_UUID}`)
      .set('X-Property-Id', propKolkataId)
      .expect(404);

    // Cross-property isolation: Honolulu task is invisible and immutable from Kolkata context (404)
    const hnlTask = await adminAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propHonoluluId)
      .send({
        roomId: honoluluRoomId,
        taskType: 'turndown',
        priority: 'normal',
        dueDate: honoluluToday,
        notes: 'Honolulu private task',
      })
      .expect(201);

    await adminAgent
      .get(`/api/housekeeping/tasks/${hnlTask.body.task.id}`)
      .set('X-Property-Id', propKolkataId)
      .expect(404);
    await adminAgent
      .post(`/api/housekeeping/tasks/${hnlTask.body.task.id}/start`)
      .set('X-Property-Id', propKolkataId)
      .send({})
      .expect(404);
  });

  it('prevents duplicate turnover task creation and double-checkout under simultaneous check-out requests', async () => {
    const walkIn = await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propKolkataId)
      .send({
        guestId,
        roomId: activeRoomAId,
        arrivalDate: kolkataToday,
        departureDate: addDays(kolkataToday, 1),
        adults: 1,
        children: 0,
        source: 'walk_in',
        checkInImmediately: true,
      })
      .expect(201);
    const resId = walkIn.body.reservation.id;

    // Adjust dates to [today-1, today) for checkout today
    await receptionistAgent
      .put(`/api/reservations/${resId}`)
      .set('X-Property-Id', propKolkataId)
      .send({
        arrivalDate: addDays(kolkataToday, -1),
        departureDate: kolkataToday,
        editReason: 'Scheduled departure today',
      })
      .expect(200);

    // Fire two concurrent check-outs
    const [co1, co2] = await Promise.all([
      receptionistAgent
        .post(`/api/reservations/${resId}/check-out`)
        .set('X-Property-Id', propKolkataId)
        .send({ note: 'Concurrent 1' }),
      receptionistAgent
        .post(`/api/reservations/${resId}/check-out`)
        .set('X-Property-Id', propKolkataId)
        .send({ note: 'Concurrent 2' }),
    ]);

    const statuses = [co1.status, co2.status].sort();
    expect(statuses).toEqual([200, 400]);

    const tasks = await receptionistAgent
      .get(`/api/housekeeping/tasks?roomId=${activeRoomAId}&status=pending`)
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    expect(tasks.body.items).toHaveLength(1);
  });
});

describe('Phase 2 Audit — Future Maintenance Date-Window Blocking & Calendar Month/Year/Timezone Integrity', () => {
  it('blocks overlapping bookings on future scheduled maintenance windows while permitting adjacent non-overlapping stays', async () => {
    const mStart = addDays(kolkataToday, 12);
    const mEnd = addDays(kolkataToday, 15);

    // Admin schedules a FUTURE out-of-service window [today+12, today+15) on Room 302
    const futureMaint = await adminAgent
      .post('/api/maintenance')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: activeRoomBId,
        category: 'furniture',
        title: 'Scheduled wardrobe refinishing',
        description: 'Varnish & cure period',
        priority: 'normal',
        operationalImpact: 'out_of_service',
        unavailableFrom: mStart,
        unavailableTo: mEnd,
      })
      .expect(201);
    expect(futureMaint.body.maintenanceRequest.blocksInventory).toBe(true);

    // Room 302 remains physically 'available' TODAY, because the maintenance window starts in 12 days!
    const roomToday = await receptionistAgent
      .get('/api/rooms')
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    const r302 = roomToday.body.items.find((r: { id: string }) => r.id === activeRoomBId);
    expect(r302.operationalStatus).toBe('available');

    // Booking ending ON mStart [today+10, today+12) SUCCEEDS (exclusive departure!)
    await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propKolkataId)
      .send({
        guestId,
        roomId: activeRoomBId,
        arrivalDate: addDays(kolkataToday, 10),
        departureDate: mStart,
        adults: 2,
        children: 0,
        source: 'direct',
      })
      .expect(201);

    // Booking starting ON mEnd [today+15, today+17) SUCCEEDS (exclusive unavailableTo!)
    await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propKolkataId)
      .send({
        guestId,
        roomId: activeRoomBId,
        arrivalDate: mEnd,
        departureDate: addDays(kolkataToday, 17),
        adults: 2,
        children: 0,
        source: 'direct',
      })
      .expect(201);

    // Booking overlapping [today+11, today+13) or [today+14, today+16) is REJECTED server-side with 409!
    await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propKolkataId)
      .send({
        guestId,
        roomId: activeRoomBId,
        arrivalDate: addDays(kolkataToday, 11),
        departureDate: addDays(kolkataToday, 13),
        adults: 2,
        children: 0,
        source: 'direct',
      })
      .expect(409);

    await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propKolkataId)
      .send({
        guestId,
        roomId: activeRoomBId,
        arrivalDate: addDays(kolkataToday, 14),
        departureDate: addDays(kolkataToday, 16),
        adults: 2,
        children: 0,
        source: 'direct',
      })
      .expect(409);

    // Date-range availability lookup on /api/rooms accurately marks Room 302 unavailable for [mStart, mEnd)
    const availCheck = await receptionistAgent
      .get(`/api/rooms?availableFrom=${mStart}&availableTo=${mEnd}`)
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    const r302Avail = availCheck.body.items.find((r: { id: string }) => r.id === activeRoomBId);
    expect(r302Avail.availableForDates).toBe(false);
    expect(r302Avail.conflictingMaintenanceTitle).toBe('Scheduled wardrobe refinishing');
  });

  it('handles month/year/February calendar boundaries, respects per-property timezone, and never mutates reservations when viewing the calendar', async () => {
    // Book a stay spanning New Year's Eve [2026-12-30, 2027-01-02) on Room 302
    const nyeStay = await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propKolkataId)
      .send({
        guestId,
        roomId: activeRoomBId,
        arrivalDate: '2026-12-30',
        departureDate: '2027-01-02',
        adults: 2,
        children: 0,
        source: 'website',
        status: 'confirmed',
      })
      .expect(201);

    const pool = getPool();
    const beforeSnap = await pool.query(
      'SELECT id, status, room_id, arrival_date, departure_date, updated_at FROM reservations WHERE property_id = $1 ORDER BY id',
      [propKolkataId]
    );

    // 1. Year boundary [2026-12-28, 2027-01-04) (7 nights)
    const yearBoundaryCal = await receptionistAgent
      .get('/api/reservations/calendar?startDate=2026-12-28&days=7')
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    expect(yearBoundaryCal.body.dates).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
    expect(yearBoundaryCal.body.endDate).toBe('2027-01-04');
    expect(
      yearBoundaryCal.body.reservations.some(
        (r: { id: string }) => r.id === nyeStay.body.reservation.id
      )
    ).toBe(true);

    // 2. Non-leap February -> March boundary [2027-02-26, 2027-03-05) (7 nights)
    const febBoundaryCal = await receptionistAgent
      .get('/api/reservations/calendar?startDate=2027-02-26&days=7')
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    expect(febBoundaryCal.body.dates).toEqual([
      '2027-02-26',
      '2027-02-27',
      '2027-02-28',
      '2027-03-01',
      '2027-03-02',
      '2027-03-03',
      '2027-03-04',
    ]);

    // 3. Property timezone check: AUD1 (Asia/Kolkata) vs AUD2 (Pacific/Honolulu)
    const hnlCal = await adminAgent
      .get('/api/reservations/calendar')
      .set('X-Property-Id', propHonoluluId)
      .expect(200);
    expect(hnlCal.body.propertyToday).toBe(honoluluToday);
    expect(yearBoundaryCal.body.propertyToday).toBe(kolkataToday);

    // 4. Confirm viewing/navigating calendar NEVER alters existing reservations or updated_at timestamps
    const afterSnap = await pool.query(
      'SELECT id, status, room_id, arrival_date, departure_date, updated_at FROM reservations WHERE property_id = $1 ORDER BY id',
      [propKolkataId]
    );
    expect(afterSnap.rows).toEqual(beforeSnap.rows);
  });
});

describe('Phase 2 Hardening Patch — Regression Verification for Audit Fixes #1–#5', () => {
  let hardeningRoomId = '';

  beforeAll(async () => {
    const createdRoom = await adminAgent
      .post('/api/rooms')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomTypeId: stdTypeId,
        roomNumber: '304',
        floor: '3',
        operationalStatus: 'available',
        housekeepingStatus: 'dirty',
      })
      .expect(201);
    hardeningRoomId = createdRoom.body.room.id;
  });

  it('Fix #1: blocks receptionist PATCH state-machine bypass & out_of_service override while preserving valid workflows and admin controls', async () => {
    // Receptionist cannot jump dirty -> inspected or dirty -> clean via legacy PATCH
    await receptionistAgent
      .patch(`/api/rooms/${hardeningRoomId}/housekeeping`)
      .set('X-Property-Id', propKolkataId)
      .send({ housekeepingStatus: 'inspected' })
      .expect(400);

    await receptionistAgent
      .patch(`/api/rooms/${hardeningRoomId}/housekeeping`)
      .set('X-Property-Id', propKolkataId)
      .send({ housekeepingStatus: 'clean' })
      .expect(400);

    // Receptionist cannot set out_of_service through legacy PATCH (403)
    await receptionistAgent
      .patch(`/api/rooms/${hardeningRoomId}/housekeeping`)
      .set('X-Property-Id', propKolkataId)
      .send({ housekeepingStatus: 'out_of_service' })
      .expect(403);

    // Even admin cannot set split-state out_of_service via legacy PATCH without maintenance/operational sync (400)
    await adminAgent
      .patch(`/api/rooms/${hardeningRoomId}/housekeeping`)
      .set('X-Property-Id', propKolkataId)
      .send({ housekeepingStatus: 'out_of_service' })
      .expect(400);

    // Invalid workflow transition on canonical endpoint remains rejected
    await receptionistAgent
      .post(`/api/rooms/${hardeningRoomId}/housekeeping-workflow`)
      .set('X-Property-Id', propKolkataId)
      .send({ action: 'inspect_room' })
      .expect(400);

    // Step-by-step cleaning transitions work for receptionist across workflow + legacy PATCH
    await receptionistAgent
      .post(`/api/rooms/${hardeningRoomId}/housekeeping-workflow`)
      .set('X-Property-Id', propKolkataId)
      .send({ action: 'start_cleaning' })
      .expect(200);

    // Cannot jump cleaning_in_progress -> inspected directly
    await receptionistAgent
      .patch(`/api/rooms/${hardeningRoomId}/housekeeping`)
      .set('X-Property-Id', propKolkataId)
      .send({ housekeepingStatus: 'inspected' })
      .expect(400);

    const cleaned = await receptionistAgent
      .patch(`/api/rooms/${hardeningRoomId}/housekeeping`)
      .set('X-Property-Id', propKolkataId)
      .send({ housekeepingStatus: 'clean' })
      .expect(200);
    expect(cleaned.body.room.housekeepingStatus).toBe('clean');
    expect(cleaned.body.room.operationalStatus).toBe('available');

    const inspected = await receptionistAgent
      .patch(`/api/rooms/${hardeningRoomId}/housekeeping`)
      .set('X-Property-Id', propKolkataId)
      .send({ housekeepingStatus: 'inspected' })
      .expect(200);
    expect(inspected.body.room.housekeepingStatus).toBe('inspected');

    // Admin supervisory override (dirty -> inspected) continues to work
    await adminAgent
      .patch(`/api/rooms/${hardeningRoomId}/housekeeping`)
      .set('X-Property-Id', propKolkataId)
      .send({ housekeepingStatus: 'dirty' })
      .expect(200);

    const adminInspected = await adminAgent
      .patch(`/api/rooms/${hardeningRoomId}/housekeeping`)
      .set('X-Property-Id', propKolkataId)
      .send({ housekeepingStatus: 'inspected' })
      .expect(200);
    expect(adminInspected.body.room.housekeepingStatus).toBe('inspected');
  });

  it('Fix #2: blocks receptionist from resolving/cancelling admin inventory-blocking tickets and enforces atomic restore-service on active OOS rooms', async () => {
    // 1. Admin creates a FUTURE inventory-blocking maintenance ticket
    const futureBlock = await adminAgent
      .post('/api/maintenance')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: hardeningRoomId,
        category: 'hvac',
        title: 'Scheduled chiller valve replacement',
        description: 'Requires 2-day room closure',
        priority: 'high',
        operationalImpact: 'out_of_service',
        unavailableFrom: addDays(kolkataToday, 24),
        unavailableTo: addDays(kolkataToday, 26),
      })
      .expect(201);
    const futureTicketId = futureBlock.body.maintenanceRequest.id as string;
    expect(futureBlock.body.maintenanceRequest.blocksInventory).toBe(true);

    // Receptionist cannot resolve, cancel, or edit an admin inventory-blocking ticket (even when omitting dates)
    await receptionistAgent
      .put(`/api/maintenance/${futureTicketId}`)
      .set('X-Property-Id', propKolkataId)
      .send({ status: 'resolved', resolutionNotes: 'Unauthorized front desk close' })
      .expect(403);

    await receptionistAgent
      .put(`/api/maintenance/${futureTicketId}`)
      .set('X-Property-Id', propKolkataId)
      .send({ status: 'cancelled' })
      .expect(403);

    await receptionistAgent
      .put(`/api/maintenance/${futureTicketId}`)
      .set('X-Property-Id', propKolkataId)
      .send({ priority: 'low' })
      .expect(403);

    // Confirm ticket remains open and inventory block remains intact
    const stillBlocking = await receptionistAgent
      .get(`/api/maintenance/${futureTicketId}`)
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    expect(stillBlocking.body.maintenanceRequest.status).toBe('open');
    expect(stillBlocking.body.maintenanceRequest.blocksInventory).toBe(true);

    // Admin CAN resolve the future scheduled ticket (room is currently physically available)
    const adminResolvedFuture = await adminAgent
      .put(`/api/maintenance/${futureTicketId}`)
      .set('X-Property-Id', propKolkataId)
      .send({
        status: 'resolved',
        resolutionNotes: 'Completed valve replacement ahead of schedule',
      })
      .expect(200);
    expect(adminResolvedFuture.body.maintenanceRequest.status).toBe('resolved');
    expect(adminResolvedFuture.body.maintenanceRequest.blocksInventory).toBe(false);

    // 2. Admin places room ACTIVELY Out of Service covering today
    const activeOos = await adminAgent
      .post(`/api/rooms/${hardeningRoomId}/out-of-service`)
      .set('X-Property-Id', propKolkataId)
      .send({
        operationalStatus: 'out_of_service',
        category: 'plumbing',
        title: 'Active shower mixer leak',
        description: 'Immediate shutoff',
        priority: 'urgent',
        unavailableFrom: kolkataToday,
        unavailableTo: addDays(kolkataToday, 2),
      })
      .expect(201);
    const activeTicketId = activeOos.body.maintenanceRequest.id as string;
    expect(activeOos.body.room.operationalStatus).toBe('out_of_service');

    // Receptionist cannot close active OOS ticket (403)
    await receptionistAgent
      .put(`/api/maintenance/${activeTicketId}`)
      .set('X-Property-Id', propKolkataId)
      .send({ status: 'resolved', resolutionNotes: 'Unauthorized' })
      .expect(403);

    // Closing active OOS ticket directly via PUT without restore-service is rejected (409) so room cannot be stranded OOS
    const directPutActive = await adminAgent
      .put(`/api/maintenance/${activeTicketId}`)
      .set('X-Property-Id', propKolkataId)
      .send({ status: 'resolved', resolutionNotes: 'Tried closing without restoring room' })
      .expect(409);
    expect(directPutActive.body.error.details?.reason).toBe('ACTIVE_ROOM_RESTORE_REQUIRED');

    // Authorized admin restore-service atomically restores room AND resolves ticket
    const restored = await adminAgent
      .post(`/api/rooms/${hardeningRoomId}/restore-service`)
      .set('X-Property-Id', propKolkataId)
      .send({
        housekeepingStatus: 'clean',
        resolutionNotes: 'Replaced mixer cartridge, pressure-tested, and sanitized',
      })
      .expect(200);
    expect(restored.body.room.operationalStatus).toBe('available');
    expect(restored.body.room.housekeepingStatus).toBe('clean');

    const closedTicket = await adminAgent
      .get(`/api/maintenance/${activeTicketId}`)
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    expect(closedTicket.body.maintenanceRequest.status).toBe('resolved');
    expect(closedTicket.body.maintenanceRequest.blocksInventory).toBe(false);

    // Receptionist permission to create and resolve ordinary non-blocking issues remains intact
    const nonBlocking = await receptionistAgent
      .post('/api/maintenance')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: hardeningRoomId,
        category: 'furniture',
        title: 'Desk lamp bulb dim',
        description: 'Swap warm LED bulb',
        priority: 'low',
        operationalImpact: 'none',
      })
      .expect(201);
    await receptionistAgent
      .put(`/api/maintenance/${nonBlocking.body.maintenanceRequest.id}`)
      .set('X-Property-Id', propKolkataId)
      .send({ status: 'resolved', resolutionNotes: 'Installed new LED bulb' })
      .expect(200);
  });

  it('Fix #3: returns 400 INVALID_IDENTIFIER for malformed UUID path and query parameters without leaking SQL internals, and 404 for nonexistent UUIDs', async () => {
    const malformedTargets: Array<{
      method: 'get' | 'put' | 'post' | 'patch';
      url: string;
      body?: Record<string, unknown>;
    }> = [
      { method: 'get', url: '/api/housekeeping/tasks/not-a-uuid' },
      { method: 'put', url: '/api/housekeeping/tasks/not-a-uuid', body: { notes: 'x' } },
      { method: 'post', url: '/api/housekeeping/tasks/not-a-uuid/start', body: {} },
      { method: 'post', url: '/api/housekeeping/tasks/not-a-uuid/complete', body: {} },
      { method: 'get', url: '/api/housekeeping/tasks?roomId=not-a-uuid' },
      { method: 'get', url: '/api/housekeeping/tasks?assignedTo=not-a-uuid' },
      { method: 'get', url: '/api/maintenance/not-a-uuid' },
      { method: 'put', url: '/api/maintenance/not-a-uuid', body: { priority: 'high' } },
      { method: 'get', url: '/api/maintenance?roomId=not-a-uuid' },
      { method: 'get', url: '/api/maintenance?assignedTo=not-a-uuid' },
      { method: 'get', url: '/api/reservations/not-a-uuid' },
      { method: 'put', url: '/api/reservations/not-a-uuid', body: { internalNotes: 'x' } },
      { method: 'post', url: '/api/reservations/not-a-uuid/check-in', body: {} },
      { method: 'post', url: '/api/reservations/not-a-uuid/check-out', body: {} },
      { method: 'post', url: '/api/reservations/not-a-uuid/cancel', body: { reason: 'test' } },
      { method: 'get', url: '/api/reservations?roomTypeId=not-a-uuid' },
      { method: 'get', url: '/api/reservations/calendar?roomTypeId=not-a-uuid' },
      { method: 'get', url: '/api/rooms/not-a-uuid' },
      { method: 'patch', url: '/api/rooms/not-a-uuid/housekeeping', body: { housekeepingStatus: 'dirty' } },
      { method: 'post', url: '/api/rooms/not-a-uuid/housekeeping-workflow', body: { action: 'start_cleaning' } },
      { method: 'get', url: '/api/rooms/not-a-uuid/affected-reservations' },
      { method: 'get', url: '/api/rooms/not-a-uuid/maintenance' },
      { method: 'get', url: '/api/rooms?roomTypeId=not-a-uuid' },
      { method: 'get', url: '/api/rooms?excludeReservationId=not-a-uuid' },
      { method: 'put', url: '/api/room-types/not-a-uuid', body: { name: 'Updated' } },
      { method: 'get', url: '/api/guests/not-a-uuid' },
      { method: 'put', url: '/api/guests/not-a-uuid', body: { firstName: 'Test' } },
    ];

    for (const target of malformedTargets) {
      const reqBuilder = adminAgent[target.method](target.url).set('X-Property-Id', propKolkataId);
      const res = target.body ? await reqBuilder.send(target.body) : await reqBuilder;
      expect(res.status, `Expected 400 on ${target.method.toUpperCase()} ${target.url}`).toBe(400);
      expect(res.body.error.code).toBe('INVALID_IDENTIFIER');
      const rawJson = JSON.stringify(res.body);
      expect(rawJson).not.toContain('22P02');
      expect(rawJson).not.toContain('string_to_uuid');
      expect(rawJson).not.toContain('SELECT ');
    }

    // Malformed 36-char X-Property-Id header also returns 400 INVALID_IDENTIFIER
    const badPropHeader = await adminAgent
      .get('/api/rooms')
      .set('X-Property-Id', '00000000-0000-0000-0000-00000000000-')
      .expect(400);
    expect(badPropHeader.body.error.code).toBe('INVALID_IDENTIFIER');

    // Valid literal 'unassigned' filter and valid UUID filter continue to return 200
    await receptionistAgent
      .get('/api/housekeeping/tasks?assignedTo=unassigned')
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    await receptionistAgent
      .get('/api/maintenance?assignedTo=unassigned')
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    await receptionistAgent
      .get(`/api/rooms/${hardeningRoomId}`)
      .set('X-Property-Id', propKolkataId)
      .expect(200);

    // Syntactically valid nonexistent UUIDs continue returning 404
    await receptionistAgent
      .get(`/api/reservations/${NONEXISTENT_UUID}`)
      .set('X-Property-Id', propKolkataId)
      .expect(404);
    await receptionistAgent
      .get(`/api/rooms/${NONEXISTENT_UUID}`)
      .set('X-Property-Id', propKolkataId)
      .expect(404);
    await receptionistAgent
      .get(`/api/guests/${NONEXISTENT_UUID}`)
      .set('X-Property-Id', propKolkataId)
      .expect(404);
  });

  it('Fix #4: defaults omitted calendar days to 14, accepts valid 1..45 values, and rejects days=0, days=abc, negative, fractional, and >45 values with 400', async () => {
    // Omitted days -> defaults to 14
    const omittedRes = await receptionistAgent
      .get('/api/reservations/calendar')
      .set('X-Property-Id', propKolkataId)
      .expect(200);
    expect(omittedRes.body.days).toBe(14);
    expect(omittedRes.body.dates).toHaveLength(14);

    // Valid boundary and mid-range values
    for (const validDays of [1, 7, 30, 45]) {
      const okRes = await receptionistAgent
        .get(`/api/reservations/calendar?days=${validDays}`)
        .set('X-Property-Id', propKolkataId)
        .expect(200);
      expect(okRes.body.days).toBe(validDays);
      expect(okRes.body.dates).toHaveLength(validDays);
    }

    // Invalid days values -> 400
    for (const badDays of ['0', 'abc', '-1', '-10', '46', '90', '14.5', '']) {
      await receptionistAgent
        .get(`/api/reservations/calendar?days=${encodeURIComponent(badDays)}`)
        .set('X-Property-Id', propKolkataId)
        .expect(400);
    }
  });

  it('Fix #5: prevents concurrent duplicate open manual housekeeping tasks while permitting legitimate distinct tasks', async () => {
    const targetDueDate = addDays(kolkataToday, 3);
    const payload = {
      roomId: hardeningRoomId,
      taskType: 'linen_refresh',
      priority: 'normal',
      dueDate: targetDueDate,
      notes: 'Deliver extra bath towels',
    };

    // 5 simultaneous identical requests -> 1 created (201) + 4 conflicts (409)
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        receptionistAgent
          .post('/api/housekeeping/tasks')
          .set('X-Property-Id', propKolkataId)
          .send(payload)
      )
    );
    const created = concurrent.filter((r) => r.status === 201);
    const conflicts = concurrent.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(4);

    // Legitimate distinct tasks on the SAME room ARE permitted:
    // (a) Different taskType on the same dueDate
    const turndownRes = await receptionistAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: hardeningRoomId,
        taskType: 'turndown',
        priority: 'normal',
        dueDate: targetDueDate,
        notes: 'Evening turndown service',
      })
      .expect(201);

    // (b) Same taskType on a DIFFERENT dueDate
    await receptionistAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propKolkataId)
      .send({
        ...payload,
        dueDate: addDays(kolkataToday, 4),
      })
      .expect(201);

    // (c) Distinct guest linen_refresh purpose on the same room & dueDate
    await receptionistAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: hardeningRoomId,
        taskType: 'linen_refresh',
        priority: 'high',
        dueDate: targetDueDate,
        notes: 'Deliver baby crib blanket and hypoallergenic pillow',
      })
      .expect(201);

    // (d) Once an open task is completed, a new task of that same type/room/dueDate can be created
    await receptionistAgent
      .post(`/api/housekeeping/tasks/${turndownRes.body.task.id}/complete`)
      .set('X-Property-Id', propKolkataId)
      .send({ notes: 'Completed turndown' })
      .expect(200);

    await receptionistAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propKolkataId)
      .send({
        roomId: hardeningRoomId,
        taskType: 'turndown',
        priority: 'normal',
        dueDate: targetDueDate,
        notes: 'Second requested turndown check',
      })
      .expect(201);
  });
});
