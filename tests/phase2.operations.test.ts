import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, getPropertyLocalDate } from '../src/shared/dates.js';
import { createApiApp } from '../src/server/app.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { closePool, getPool } from '../src/server/db/pool.js';
import { hashPassword } from '../src/server/security/password.js';

const app = createApiApp();

let adminAgent: ReturnType<typeof request.agent>;
let receptionistAgent: ReturnType<typeof request.agent>;
let adminUserId = '';
let receptionistUserId = '';
let otherPropStaffId = '';

let propAId = '';
let propAToday = '';
let propBId = '';

let stdTypeId = '';
let dlxTypeId = '';
let room101Id = '';
let room102Id = '';
let room103Id = '';
let room104Id = '';
let room201Id = '';
let propBRoomId = '';

let guestAId = '';
let guestBId = '';

beforeAll(async () => {
  const pool = getPool();
  const dbCheck = await pool.query('SELECT current_database() AS db_name');
  const connectedDb = String(dbCheck.rows[0]?.db_name ?? '');
  if (connectedDb !== 'staycraft_pms_test') {
    throw new Error(
      `ABORTING TEST SUITE: Expected isolated staycraft_pms_test database, got "${connectedDb}"`
    );
  }

  await runMigrations();

  // Isolated test DB cleanup ONLY (staycraft_pms_test)
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
     VALUES ('admin@phase2.test', $1, 'Aarav Admin', 'admin') RETURNING id`,
    [adminHash]
  );
  const uRec = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('frontdesk@phase2.test', $1, 'Priya FrontDesk', 'receptionist') RETURNING id`,
    [recHash]
  );
  const uOther = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('propb-only@phase2.test', $1, 'Riya PropBOnly', 'receptionist') RETURNING id`,
    [recHash]
  );

  adminUserId = uAdmin.rows[0].id as string;
  receptionistUserId = uRec.rows[0].id as string;
  otherPropStaffId = uOther.rows[0].id as string;

  const pA = await pool.query(
    `INSERT INTO properties (code, name, email, phone, address_line1, city, country, timezone, currency, default_tax_rate, tax_name)
     VALUES ('P2A', 'Phase 2 Heritage Hotel', 'desk@p2a.test', '+91 542 100 1000', 'Ghat Rd', 'Varanasi', 'India', 'Asia/Kolkata', 'INR', 12.00, 'GST')
     RETURNING id`
  );
  const pB = await pool.query(
    `INSERT INTO properties (code, name, email, phone, address_line1, city, country, timezone, currency, default_tax_rate, tax_name)
     VALUES ('P2B', 'Phase 2 Sister Annex', 'desk@p2b.test', '+91 542 100 2000', 'Cantt Rd', 'Varanasi', 'India', 'Asia/Kolkata', 'INR', 12.00, 'GST')
     RETURNING id`
  );
  propAId = pA.rows[0].id as string;
  propBId = pB.rows[0].id as string;
  propAToday = getPropertyLocalDate('Asia/Kolkata');

  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id, is_default)
     VALUES ($1, $4, TRUE), ($1, $5, FALSE), ($2, $4, TRUE), ($3, $5, TRUE)`,
    [adminUserId, receptionistUserId, otherPropStaffId, propAId, propBId]
  );

  const rtStd = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'STD', 'Standard Room', 2, 2, 4000) RETURNING id`,
    [propAId]
  );
  const rtDlx = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'DLX', 'Deluxe Suite', 2, 3, 6500) RETURNING id`,
    [propAId]
  );
  const rtB = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'BST', 'Annex Standard', 2, 2, 3500) RETURNING id`,
    [propBId]
  );
  stdTypeId = rtStd.rows[0].id as string;
  dlxTypeId = rtDlx.rows[0].id as string;

  const r101 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, '101', '1', 'available', 'dirty') RETURNING id`,
    [propAId, stdTypeId]
  );
  const r102 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, '102', '1', 'available', 'clean') RETURNING id`,
    [propAId, stdTypeId]
  );
  const r103 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, '103', '1', 'available', 'inspected') RETURNING id`,
    [propAId, stdTypeId]
  );
  const r104 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, '104', '1', 'available', 'inspected') RETURNING id`,
    [propAId, dlxTypeId]
  );
  const r201 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, '201', '2', 'available', 'inspected') RETURNING id`,
    [propAId, dlxTypeId]
  );
  const rB = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, 'B01', '1', 'available', 'clean') RETURNING id`,
    [propBId, rtB.rows[0].id]
  );

  room101Id = r101.rows[0].id as string;
  room102Id = r102.rows[0].id as string;
  room103Id = r103.rows[0].id as string;
  room104Id = r104.rows[0].id as string;
  room201Id = r201.rows[0].id as string;
  propBRoomId = rB.rows[0].id as string;

  const g1 = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, phone, email)
     VALUES ($1, 'Ananya', 'Verma', '+91 98111 22334', 'ananya@example.com') RETURNING id`,
    [propAId]
  );
  const g2 = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, phone, email)
     VALUES ($1, 'Vikram', 'Rao', '+91 98222 33445', 'vikram@example.com') RETURNING id`,
    [propAId]
  );
  guestAId = g1.rows[0].id as string;
  guestBId = g2.rows[0].id as string;

  adminAgent = request.agent(app);
  receptionistAgent = request.agent(app);

  await adminAgent
    .post('/api/auth/login')
    .send({ email: 'admin@phase2.test', password: 'Admin@12345' })
    .expect(200);

  await receptionistAgent
    .post('/api/auth/login')
    .send({ email: 'frontdesk@phase2.test', password: 'FrontDesk@123' })
    .expect(200);
});

afterAll(async () => {
  await closePool();
});

describe('Phase 2.1 — Auth, Property Isolation & Real Staff Options', () => {
  it('protects all Phase 2 endpoints from unauthenticated requests with 401 and cross-property access with 403', async () => {
    await request(app).get('/api/housekeeping/tasks').set('X-Property-Id', propAId).expect(401);
    await request(app).get('/api/maintenance').set('X-Property-Id', propAId).expect(401);
    await request(app).get('/api/reservations/calendar').set('X-Property-Id', propAId).expect(401);
    await request(app).get('/api/properties/staff').set('X-Property-Id', propAId).expect(401);

    // Receptionist does not have access to Property B -> 403
    await receptionistAgent.get('/api/housekeeping/tasks').set('X-Property-Id', propBId).expect(403);
    await receptionistAgent.get('/api/maintenance').set('X-Property-Id', propBId).expect(403);
    await receptionistAgent.get('/api/reservations/calendar').set('X-Property-Id', propBId).expect(403);
  });

  it('returns only real property-assigned staff accounts without sensitive fields', async () => {
    const res = await receptionistAgent
      .get('/api/properties/staff')
      .set('X-Property-Id', propAId)
      .expect(200);

    expect(res.body.items).toHaveLength(2);
    const ids = res.body.items.map((s: { id: string }) => s.id);
    expect(ids).toContain(adminUserId);
    expect(ids).toContain(receptionistUserId);
    expect(ids).not.toContain(otherPropStaffId);
    expect(JSON.stringify(res.body)).not.toContain('password');
  });
});

describe('Phase 2.2 — Housekeeping Tasks Lifecycle, Filtering & Staff Validation', () => {
  let cleaningTaskId = '';
  let inspectionTaskId = '';

  it('rejects assigning a task to staff without access to the property or a room in another property', async () => {
    await receptionistAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propAId)
      .send({
        roomId: room101Id,
        taskType: 'turnover_clean',
        priority: 'high',
        dueDate: propAToday,
        assignedTo: otherPropStaffId,
      })
      .expect(400);

    await adminAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propAId)
      .send({
        roomId: propBRoomId,
        taskType: 'turnover_clean',
        priority: 'normal',
        dueDate: propAToday,
      })
      .expect(400);
  });

  it('supports task create, edit, assign, start, complete, search/filtering, and syncs room cleanliness + audit logs', async () => {
    // 1. Create unassigned task on Dirty Room 101
    const created = await receptionistAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propAId)
      .send({
        roomId: room101Id,
        taskType: 'deep_clean',
        priority: 'urgent',
        dueDate: propAToday,
        notes: 'Sanitize balcony and refresh linens',
      })
      .expect(201);

    cleaningTaskId = created.body.task.id;
    expect(created.body.task.status).toBe('pending');
    expect(created.body.task.assignedTo).toBeNull();
    expect(created.body.task.createdBy).toBe(receptionistUserId);

    // Filter unassigned + urgent
    const unassignedList = await receptionistAgent
      .get('/api/housekeeping/tasks?assignedTo=unassigned&priority=urgent&search=balcony')
      .set('X-Property-Id', propAId)
      .expect(200);
    expect(unassignedList.body.items).toHaveLength(1);
    expect(unassignedList.body.items[0].id).toBe(cleaningTaskId);

    // 2. Edit & assign task to receptionistUserId
    const assigned = await adminAgent
      .put(`/api/housekeeping/tasks/${cleaningTaskId}`)
      .set('X-Property-Id', propAId)
      .send({
        assignedTo: receptionistUserId,
        notes: 'Sanitize balcony, refresh linens, and restock tea tray',
      })
      .expect(200);
    expect(assigned.body.task.assignedTo).toBe(receptionistUserId);
    expect(assigned.body.task.assignedToName).toBe('Priya FrontDesk');

    // 3. Start task -> task becomes in_progress, Room 101 becomes cleaning_in_progress
    const started = await receptionistAgent
      .post(`/api/housekeeping/tasks/${cleaningTaskId}/start`)
      .set('X-Property-Id', propAId)
      .send({})
      .expect(200);
    expect(started.body.task.status).toBe('in_progress');
    expect(started.body.task.startedAt).toBeTruthy();
    expect(started.body.task.startedBy).toBe(receptionistUserId);
    expect(started.body.task.roomCleaningInProgress).toBe(true);
    expect(started.body.task.roomCleaningStage).toBe('cleaning_in_progress');

    // Supervisor inspection task cannot be completed while Room 101 is still dirty/cleaning_in_progress
    const inspRes = await adminAgent
      .post('/api/housekeeping/tasks')
      .set('X-Property-Id', propAId)
      .send({
        roomId: room101Id,
        taskType: 'inspection',
        priority: 'normal',
        dueDate: propAToday,
        assignedTo: adminUserId,
      })
      .expect(201);
    inspectionTaskId = inspRes.body.task.id;

    await adminAgent
      .post(`/api/housekeeping/tasks/${inspectionTaskId}/complete`)
      .set('X-Property-Id', propAId)
      .send({})
      .expect(400);

    // 4. Complete cleaning task -> task becomes completed, Room 101 becomes Clean
    const completed = await receptionistAgent
      .post(`/api/housekeeping/tasks/${cleaningTaskId}/complete`)
      .set('X-Property-Id', propAId)
      .send({ notes: 'Completed full deep clean' })
      .expect(200);
    expect(completed.body.task.status).toBe('completed');
    expect(completed.body.task.completedAt).toBeTruthy();
    expect(completed.body.task.roomHousekeepingStatus).toBe('clean');
    expect(completed.body.task.roomCleaningInProgress).toBe(false);

    // Completed task cannot be restarted
    await receptionistAgent
      .post(`/api/housekeeping/tasks/${cleaningTaskId}/start`)
      .set('X-Property-Id', propAId)
      .send({})
      .expect(400);

    // 5. Complete supervisor inspection task -> Room 101 becomes Inspected
    const inspCompleted = await adminAgent
      .post(`/api/housekeeping/tasks/${inspectionTaskId}/complete`)
      .set('X-Property-Id', propAId)
      .send({})
      .expect(200);
    expect(inspCompleted.body.task.status).toBe('completed');
    expect(inspCompleted.body.task.roomHousekeepingStatus).toBe('inspected');
    expect(inspCompleted.body.task.roomCleaningStage).toBe('inspected');

    // Audit trail recorded
    const pool = getPool();
    const audits = await pool.query(
      `SELECT action FROM audit_events WHERE property_id = $1 AND entity_type = 'housekeeping_task'`,
      [propAId]
    );
    const actions = audits.rows.map((r) => r.action);
    expect(actions).toContain('created');
    expect(actions).toContain('started');
    expect(actions).toContain('completed');
  });
});

describe('Phase 2.3 — Cleaning & Inspection Workflow, Occupancy Separation & Check-In/Out Integration', () => {
  let stayId = '';

  it('enforces dirty -> cleaning_in_progress -> clean -> inspected transitions and blocks dirty/in-progress check-ins', async () => {
    // Mark Room 102 dirty via workflow
    const markedDirty = await receptionistAgent
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('X-Property-Id', propAId)
      .send({ action: 'mark_dirty' })
      .expect(200);
    expect(markedDirty.body.room.cleaningStage).toBe('dirty');

    // Invalid jump: cannot complete_cleaning before start_cleaning, nor inspect_room directly from dirty
    await receptionistAgent
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('X-Property-Id', propAId)
      .send({ action: 'complete_cleaning' })
      .expect(400);
    await receptionistAgent
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('X-Property-Id', propAId)
      .send({ action: 'inspect_room' })
      .expect(400);

    // Book Room 102 for [today, today+1)
    const booking = await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestAId,
        roomId: room102Id,
        arrivalDate: propAToday,
        departureDate: addDays(propAToday, 1),
        adults: 2,
        children: 0,
        source: 'direct',
        status: 'confirmed',
      })
      .expect(201);
    stayId = booking.body.reservation.id;

    // Check-in blocked while Dirty
    await receptionistAgent
      .post(`/api/reservations/${stayId}/check-in`)
      .set('X-Property-Id', propAId)
      .send({})
      .expect(409);

    // Move Room 102 to Cleaning in Progress
    const started = await receptionistAgent
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('X-Property-Id', propAId)
      .send({ action: 'start_cleaning' })
      .expect(200);
    expect(started.body.room.cleaningStage).toBe('cleaning_in_progress');
    expect(started.body.room.cleaningInProgress).toBe(true);

    // Check-in MUST STILL BE BLOCKED while Cleaning in Progress!
    const blockedInProgress = await receptionistAgent
      .post(`/api/reservations/${stayId}/check-in`)
      .set('X-Property-Id', propAId)
      .send({})
      .expect(409);
    expect(blockedInProgress.body.error.message).toContain('Cleaning in Progress');

    // Cannot inspect_room before complete_cleaning
    await receptionistAgent
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('X-Property-Id', propAId)
      .send({ action: 'inspect_room' })
      .expect(400);

    // Complete cleaning -> Clean -> Inspect -> Inspected
    const cleaned = await receptionistAgent
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('X-Property-Id', propAId)
      .send({ action: 'complete_cleaning' })
      .expect(200);
    expect(cleaned.body.room.cleaningStage).toBe('clean');

    const inspected = await receptionistAgent
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('X-Property-Id', propAId)
      .send({ action: 'inspect_room' })
      .expect(200);
    expect(inspected.body.room.cleaningStage).toBe('inspected');
    expect(inspected.body.room.lastInspectedAt).toBeTruthy();

    // Check-in now succeeds!
    const checkedIn = await receptionistAgent
      .post(`/api/reservations/${stayId}/check-in`)
      .set('X-Property-Id', propAId)
      .send({ note: 'Checked into inspected room' })
      .expect(200);
    expect(checkedIn.body.reservation.status).toBe('checked_in');
  });

  it('never alters reservation status or marks an occupied room vacant during stayover housekeeping, and queues dirty turnover on checkout', async () => {
    // Stayover housekeeping transitions on occupied Room 102
    const dirtyStayover = await receptionistAgent
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('X-Property-Id', propAId)
      .send({ action: 'mark_dirty' })
      .expect(200);
    expect(dirtyStayover.body.room.isOccupied).toBe(true);
    expect(dirtyStayover.body.room.currentOccupancy.reservationId).toBe(stayId);

    await receptionistAgent
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('X-Property-Id', propAId)
      .send({ action: 'start_cleaning' })
      .expect(200);
    const cleanStayover = await receptionistAgent
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('X-Property-Id', propAId)
      .send({ action: 'complete_cleaning' })
      .expect(200);

    expect(cleanStayover.body.room.isOccupied).toBe(true);
    expect(cleanStayover.body.room.operationalStatus).toBe('available');

    // Verify reservation status is still 'checked_in'
    const resDetail = await receptionistAgent
      .get(`/api/reservations/${stayId}`)
      .set('X-Property-Id', propAId)
      .expect(200);
    expect(resDetail.body.reservation.status).toBe('checked_in');

    // Adjust arrival/departure to [today-1, today) so we can check out today cleanly
    await receptionistAgent
      .put(`/api/reservations/${stayId}`)
      .set('X-Property-Id', propAId)
      .send({
        arrivalDate: addDays(propAToday, -1),
        departureDate: propAToday,
        editReason: 'Set departure to today for checkout test',
      })
      .expect(200);

    // Check out -> Room 102 MUST become Dirty (never auto-clean!) AND a pending turnover_clean task is auto-queued
    const checkedOut = await receptionistAgent
      .post(`/api/reservations/${stayId}/check-out`)
      .set('X-Property-Id', propAId)
      .send({ note: 'Normal checkout' })
      .expect(200);
    expect(checkedOut.body.reservation.status).toBe('checked_out');
    expect(checkedOut.body.reservation.roomHousekeepingStatus).toBe('dirty');
    expect(checkedOut.body.reservation.roomCleaningInProgress).toBe(false);

    const tasksAfterCheckout = await receptionistAgent
      .get(`/api/housekeeping/tasks?roomId=${room102Id}&status=pending`)
      .set('X-Property-Id', propAId)
      .expect(200);
    expect(
      tasksAfterCheckout.body.items.some(
        (t: { taskType: string; reservationId: string | null }) =>
          t.taskType === 'turnover_clean' && t.reservationId === stayId
      )
    ).toBe(true);
  });
});

describe('Phase 2.4 — Maintenance Management, Out-of-Service Conflicts, Explicit Resolution & Restoration', () => {
  it('enforces admin RBAC for out-of-service transitions while allowing receptionists to report minor issues', async () => {
    // Receptionist can report non-blocking maintenance issue
    const minor = await receptionistAgent
      .post('/api/maintenance')
      .set('X-Property-Id', propAId)
      .send({
        roomId: room103Id,
        category: 'electrical',
        title: 'Bedside reading lamp flicker',
        description: 'Left bedside LED bulb flickers intermittently',
        priority: 'low',
        operationalImpact: 'none',
      })
      .expect(201);
    expect(minor.body.maintenanceRequest.blocksInventory).toBe(false);

    // Receptionist CANNOT place room out of service or restore room
    await receptionistAgent
      .post('/api/maintenance')
      .set('X-Property-Id', propAId)
      .send({
        roomId: room103Id,
        category: 'hvac',
        title: 'Major HVAC failure',
        description: 'Blower failed',
        priority: 'urgent',
        operationalImpact: 'out_of_service',
        unavailableFrom: propAToday,
      })
      .expect(403);

    await receptionistAgent
      .post(`/api/rooms/${room103Id}/out-of-service`)
      .set('X-Property-Id', propAId)
      .send({
        category: 'hvac',
        title: 'Major HVAC failure',
        description: 'Blower failed',
        priority: 'urgent',
        operationalImpact: 'out_of_service',
        unavailableFrom: propAToday,
      })
      .expect(403);

    await receptionistAgent
      .post(`/api/rooms/${room103Id}/restore-service`)
      .set('X-Property-Id', propAId)
      .send({ housekeepingStatus: 'dirty', resolutionNotes: 'Attempted unauthorized restore' })
      .expect(403);
  });

  it('never silently cancels/alters existing stays on OOS, blocks conflicting bookings/check-ins, never double-counts dashboard buckets, and restores cleanly', async () => {
    // 1. Create a checked-in stay on Room 201 [today, today+2)
    const checkedInBooking = await adminAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestAId,
        roomId: room201Id,
        arrivalDate: propAToday,
        departureDate: addDays(propAToday, 2),
        adults: 2,
        children: 0,
        source: 'walk_in',
        checkInImmediately: true,
      })
      .expect(201);
    const occupiedResId = checkedInBooking.body.reservation.id;

    // Admin attempting to place occupied Room 201 out of service -> 409 OCCUPIED_ROOM_CONFLICT (even with acknowledgeAffectedStays)
    const occConflict = await adminAgent
      .post(`/api/rooms/${room201Id}/out-of-service`)
      .set('X-Property-Id', propAId)
      .send({
        category: 'plumbing',
        title: 'Pipe burst',
        description: 'Main riser leak',
        priority: 'urgent',
        operationalImpact: 'out_of_service',
        unavailableFrom: propAToday,
        acknowledgeAffectedStays: true,
      })
      .expect(409);
    expect(occConflict.body.error.details.reason).toBe('OCCUPIED_ROOM_CONFLICT');
    expect(occConflict.body.error.details.affectedReservations[0].id).toBe(occupiedResId);

    // 2. Create an upcoming confirmed booking on Room 104 [today, today+2) (not checked in yet)
    const upcomingBooking = await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestBId,
        roomId: room104Id,
        arrivalDate: propAToday,
        departureDate: addDays(propAToday, 2),
        adults: 2,
        children: 0,
        source: 'direct',
        status: 'confirmed',
      })
      .expect(201);
    const affectedResId = upcomingBooking.body.reservation.id;

    // 3. Admin attempts OOS on Room 104 WITHOUT acknowledgeAffectedStays -> 409 AFFECTED_RESERVATIONS_CONFLICT
    const unack = await adminAgent
      .post(`/api/rooms/${room104Id}/out-of-service`)
      .set('X-Property-Id', propAId)
      .send({
        category: 'hvac',
        title: 'Chiller coil replacement',
        description: 'Requires crane replacement',
        priority: 'urgent',
        operationalImpact: 'out_of_service',
        unavailableFrom: propAToday,
        unavailableTo: addDays(propAToday, 3),
      })
      .expect(409);
    expect(unack.body.error.details.reason).toBe('AFFECTED_RESERVATIONS_CONFLICT');
    expect(unack.body.error.details.affectedReservations).toHaveLength(1);
    expect(unack.body.error.details.affectedReservations[0].id).toBe(affectedResId);

    // Confirm affected reservation was NOT cancelled or modified
    const checkUntouched = await receptionistAgent
      .get(`/api/reservations/${affectedResId}`)
      .set('X-Property-Id', propAId)
      .expect(200);
    expect(checkUntouched.body.reservation.status).toBe('confirmed');
    expect(checkUntouched.body.reservation.roomId).toBe(room104Id);

    // 4. Admin places Room 104 OOS with explicit acknowledgeAffectedStays: true
    const oosRes = await adminAgent
      .post(`/api/rooms/${room104Id}/out-of-service`)
      .set('X-Property-Id', propAId)
      .send({
        category: 'hvac',
        title: 'Chiller coil replacement',
        description: 'Requires coil swap',
        priority: 'urgent',
        operationalImpact: 'out_of_service',
        unavailableFrom: propAToday,
        unavailableTo: addDays(propAToday, 3),
        acknowledgeAffectedStays: true,
      })
      .expect(201);
    expect(oosRes.body.room.operationalStatus).toBe('out_of_service');
    // Room 104 still had housekeepingStatus 'inspected' -> verify dashboard NEVER double-counts!
    const dash = await adminAgent.get('/api/dashboard').set('X-Property-Id', propAId).expect(200);
    const hc = dash.body.housekeepingCounts;
    expect(hc.inspected + hc.clean + hc.dirty + hc.out_of_service).toBe(5);
    expect(hc.out_of_service).toBe(1);
    expect(dash.body.metrics.affectedStaysOnUnavailableRoomsCount).toBe(1);

    // Affected reservation is STILL 'confirmed' (never silently cancelled!), and check-in on Room 104 is BLOCKED!
    const detailWhileBlocked = await receptionistAgent
      .get(`/api/reservations/${affectedResId}`)
      .set('X-Property-Id', propAId)
      .expect(200);
    expect(detailWhileBlocked.body.reservation.status).toBe('confirmed');
    expect(detailWhileBlocked.body.reservation.roomHasInventoryBlock).toBe(true);

    await receptionistAgent
      .post(`/api/reservations/${affectedResId}/check-in`)
      .set('X-Property-Id', propAId)
      .send({})
      .expect(400);

    // New booking on Room 104 is also blocked!
    await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestAId,
        roomId: room104Id,
        arrivalDate: addDays(propAToday, 1),
        departureDate: addDays(propAToday, 2),
        adults: 2,
        children: 0,
        source: 'direct',
      })
      .expect(400);

    // 5. Explicit resolution: Reassign affected reservation to available Room 103 (`inspected`)
    const reassigned = await receptionistAgent
      .put(`/api/reservations/${affectedResId}`)
      .set('X-Property-Id', propAId)
      .send({
        roomId: room103Id,
        editReason: 'Moved guest away from out-of-service Room 104 to Room 103',
      })
      .expect(200);
    expect(reassigned.body.reservation.roomId).toBe(room103Id);

    const dashResolved = await adminAgent
      .get('/api/dashboard')
      .set('X-Property-Id', propAId)
      .expect(200);
    expect(dashResolved.body.metrics.affectedStaysOnUnavailableRoomsCount).toBe(0);

    // 6. Admin restores Room 104 to service -> operationalStatus = 'available', maintenance resolved with history
    const restored = await adminAgent
      .post(`/api/rooms/${room104Id}/restore-service`)
      .set('X-Property-Id', propAId)
      .send({
        housekeepingStatus: 'clean',
        resolutionNotes: 'New chiller coil installed, pressure-tested, and room cleaned.',
      })
      .expect(200);
    expect(restored.body.room.operationalStatus).toBe('available');
    expect(restored.body.room.housekeepingStatus).toBe('clean');

    const maintHistory = await receptionistAgent
      .get(`/api/rooms/${room104Id}/maintenance`)
      .set('X-Property-Id', propAId)
      .expect(200);
    expect(maintHistory.body.items).toHaveLength(1);
    expect(maintHistory.body.items[0].status).toBe('resolved');
    expect(maintHistory.body.items[0].resolvedAt).toBeTruthy();
    expect(maintHistory.body.items[0].resolutionNotes).toContain('New chiller coil installed');
  });
});

describe('Phase 2.5 — Room-by-Date Reservation Calendar Half-Open Date Boundaries', () => {
  it('accurately queries [arrivalDate, departureDate) boundaries, allows back-to-back turnover, and excludes cancelled stays', async () => {
    const d5 = addDays(propAToday, 5);
    const d7 = addDays(propAToday, 7);
    const d9 = addDays(propAToday, 9);

    // Stay 1: [d5, d7) on Room 101
    const stay1 = await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestAId,
        roomId: room101Id,
        arrivalDate: d5,
        departureDate: d7,
        adults: 2,
        children: 0,
        source: 'direct',
        status: 'confirmed',
      })
      .expect(201);

    // Stay 2: [d7, d9) on Room 101 (same-day turnover on d7 — arrival inclusive, departure exclusive)
    const stay2 = await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestBId,
        roomId: room101Id,
        arrivalDate: d7,
        departureDate: d9,
        adults: 2,
        children: 0,
        source: 'website',
        status: 'pending',
      })
      .expect(201);

    // Stay 3: Cancelled stay on [d9, d9+2) -> must NOT appear on calendar
    const stay3 = await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestAId,
        roomId: room101Id,
        arrivalDate: d9,
        departureDate: addDays(propAToday, 11),
        adults: 1,
        children: 0,
        source: 'phone',
      })
      .expect(201);
    await receptionistAgent
      .post(`/api/reservations/${stay3.body.reservation.id}/cancel`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Guest cancelled trip' })
      .expect(200);

    // Calendar window [d5, d5+2) => [d5, d7): MUST include Stay 1 and MUST NOT include Stay 2 (starts at d7, exclusive end!)
    const calWindow1 = await receptionistAgent
      .get(`/api/reservations/calendar?startDate=${d5}&days=2`)
      .set('X-Property-Id', propAId)
      .expect(200);
    expect(calWindow1.body.startDate).toBe(d5);
    expect(calWindow1.body.endDate).toBe(d7);
    expect(calWindow1.body.dates).toEqual([d5, addDays(d5, 1)]);
    const w1Ids = calWindow1.body.reservations.map((r: { id: string }) => r.id);
    expect(w1Ids).toContain(stay1.body.reservation.id);
    expect(w1Ids).not.toContain(stay2.body.reservation.id);
    expect(w1Ids).not.toContain(stay3.body.reservation.id);

    // Calendar window [d7, d7+4) => [d7, d11): MUST include Stay 2 and MUST NOT include Stay 1 (departed on d7!) or Cancelled Stay 3
    const calWindow2 = await receptionistAgent
      .get(`/api/reservations/calendar?startDate=${d7}&days=4`)
      .set('X-Property-Id', propAId)
      .expect(200);
    const w2Ids = calWindow2.body.reservations.map((r: { id: string }) => r.id);
    expect(w2Ids).toContain(stay2.body.reservation.id);
    expect(w2Ids).not.toContain(stay1.body.reservation.id);
    expect(w2Ids).not.toContain(stay3.body.reservation.id);
  });
});
