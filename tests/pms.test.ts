import http from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiClientError,
  apiFetch,
  getStoredPropertyId,
  getStoredSessionToken,
  isUsingRpcTransport,
  resetApiTransportState,
  setStoredPropertyId,
  setStoredSessionToken,
  setUnauthorizedHandler,
} from '../src/client/lib/api.js';
import {
  getRoomStatusBucket,
  summarizeRoomStatusBuckets,
} from '../src/shared/constants.js';
import { addDays, diffDays, getPropertyLocalDate, isValidIsoDate, rangesOverlap } from '../src/shared/dates.js';
import { calculateReservationFinancials } from '../src/shared/pricing.js';
import { createApiApp } from '../src/server/app.js';
import { ensureInitialAdminAccount } from '../src/server/db/ensure-admin.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { closePool, getPool } from '../src/server/db/pool.js';
import { getDashboardSummary } from '../src/server/modules/dashboard/dashboard.routes.js';
import { createReservation } from '../src/server/modules/reservations/reservations.service.js';
import { hashPassword, hashSessionToken } from '../src/server/security/password.js';
import { mapPropertyRow } from '../src/server/services/mappers.js';

const app = createApiApp();

let adminToken = '';
let receptionistToken = '';
let propertyAId = '';
let propertyBId = '';
let propertyAToday = '';
let stdTypeId = '';
let suiteTypeId = '';
let room101Id = '';
let room102Id = '';
let roomMaintId = '';
let guest1Id = '';
let guest2Id = '';

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

  // Clean test tables before suite
  await pool.query(`
    TRUNCATE TABLE
      audit_events,
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

  const adminHash = await hashPassword('TestAdmin#2026');
  const recHash = await hashPassword('TestRec#2026');

  const uAdmin = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('admin@test.local', $1, 'Test Admin', 'admin') RETURNING id`,
    [adminHash]
  );
  const uRec = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('rec@test.local', $1, 'Test Receptionist', 'receptionist') RETURNING id`,
    [recHash]
  );

  const propA = await pool.query(
    `INSERT INTO properties (code, name, email, phone, address_line1, city, country, timezone, currency, default_tax_rate, tax_name)
     VALUES ('TST', 'Test Heritage Hotel', 'info@test.local', '+91 90000 00001', '12 Ghat Rd', 'Varanasi', 'India', 'Asia/Kolkata', 'INR', 12.00, 'GST')
     RETURNING id`
  );
  const propB = await pool.query(
    `INSERT INTO properties (code, name, email, phone, address_line1, city, country, timezone, currency, default_tax_rate, tax_name)
     VALUES ('OTR', 'Other City Hotel', 'info@other.local', '+91 90000 00002', '88 Park St', 'Mumbai', 'India', 'Asia/Kolkata', 'INR', 18.00, 'GST')
     RETURNING id`
  );

  propertyAId = propA.rows[0].id;
  propertyBId = propB.rows[0].id;
  propertyAToday = getPropertyLocalDate('Asia/Kolkata');

  // Grant Admin access to both, Receptionist ONLY to Property A
  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id, is_default)
     VALUES ($1, $3, TRUE), ($1, $4, FALSE), ($2, $3, TRUE)`,
    [uAdmin.rows[0].id, uRec.rows[0].id, propertyAId, propertyBId]
  );

  // Login both users via real auth endpoint
  const adminLogin = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@test.local', password: 'TestAdmin#2026' })
    .expect(200);
  adminToken = adminLogin.body.sessionToken;

  const recLogin = await request(app)
    .post('/api/auth/login')
    .send({ email: 'rec@test.local', password: 'TestRec#2026' })
    .expect(200);
  receptionistToken = recLogin.body.sessionToken;
});

afterAll(async () => {
  await closePool();
});

describe('1. Shared Date, Timezone & Pricing Utilities', () => {
  it('validates ISO calendar dates accurately and rejects impossible dates', () => {
    expect(isValidIsoDate('2026-10-22')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true); // leap year
    expect(isValidIsoDate('2026-02-29')).toBe(false); // non-leap year
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(diffDays('2026-10-22', '2026-10-25')).toBe(3);
  });

  it('treats arrival as inclusive and departure as exclusive in overlap checks', () => {
    expect(rangesOverlap('2026-10-20', '2026-10-22', '2026-10-22', '2026-10-25')).toBe(false);
    expect(rangesOverlap('2026-10-20', '2026-10-23', '2026-10-22', '2026-10-25')).toBe(true);
  });

  it('computes property local date using configured IANA timezone across UTC midnight', () => {
    // 2026-10-22T20:30:00Z is 2026-10-23 02:00 in Asia/Kolkata (+05:30), while still 2026-10-22 in America/New_York (-04:00)
    const refInstant = new Date('2026-10-22T20:30:00Z');
    expect(getPropertyLocalDate('Asia/Kolkata', refInstant)).toBe('2026-10-23');
    expect(getPropertyLocalDate('America/New_York', refInstant)).toBe('2026-10-22');
  });

  it('calculates financials accurately and rejects discount exceeding subtotal', () => {
    const res = calculateReservationFinancials({
      nights: 3,
      nightlyRate: 5000,
      discountAmount: 1000,
      taxRate: 12,
    });
    expect(res.roomSubtotal).toBe(15000);
    expect(res.taxableAmount).toBe(14000);
    expect(res.taxAmount).toBe(1680);
    expect(res.estimatedTotal).toBe(15680);

    expect(() =>
      calculateReservationFinancials({
        nights: 1,
        nightlyRate: 4000,
        discountAmount: 4500,
        taxRate: 12,
      })
    ).toThrow(/cannot exceed/i);
  });
});

describe('2. Authentication & Role Authorization (Admin vs Receptionist)', () => {
  it('blocks unauthenticated access to protected endpoints', async () => {
    await request(app).get('/api/dashboard').expect(401);
    await request(app).get('/api/guests').expect(401);
    await request(app).get('/api/reservations').expect(401);
  });

  it('rejects wrong password on login', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'WrongPassword!' })
      .expect(401);
  });

  it('forbids receptionist from modifying property settings or creating room types/rooms', async () => {
    await request(app)
      .put('/api/properties/current')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        name: 'Unauthorized Rename',
        email: 'a@b.com',
        phone: '123456',
        addressLine1: '1 St',
        city: 'City',
        country: 'India',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        defaultTaxRate: 12,
        taxName: 'GST',
        standardCheckInTime: '14:00',
        standardCheckOutTime: '11:00',
      })
      .expect(403);

    await request(app)
      .post('/api/room-types')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        code: 'STD',
        name: 'Standard Room',
        baseCapacity: 2,
        maxCapacity: 2,
        baseRate: 4000,
      })
      .expect(403);

    await request(app)
      .get('/api/properties/users')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .expect(403);
  });

  it('forbids receptionist from accessing an unassigned property', async () => {
    await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyBId)
      .expect(403);
  });
});

describe('3. Room Categories, Duplicate Room Prevention & Operational Status', () => {
  it('allows administrator to create room categories and rooms', async () => {
    const stdRes = await request(app)
      .post('/api/room-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        code: 'STD',
        name: 'Standard Queen',
        baseCapacity: 2,
        maxCapacity: 2,
        baseRate: 4000,
        amenities: ['Wi-Fi', 'AC'],
      })
      .expect(201);
    stdTypeId = stdRes.body.roomType.id;

    const steRes = await request(app)
      .post('/api/room-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        code: 'STE',
        name: 'Family Suite',
        baseCapacity: 2,
        maxCapacity: 4,
        baseRate: 8500,
      })
      .expect(201);
    suiteTypeId = steRes.body.roomType.id;

    const r101 = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        roomTypeId: stdTypeId,
        roomNumber: '101',
        floor: '1',
        operationalStatus: 'available',
        housekeepingStatus: 'inspected',
      })
      .expect(201);
    room101Id = r101.body.room.id;

    const r102 = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        roomTypeId: suiteTypeId,
        roomNumber: '102',
        floor: '1',
        operationalStatus: 'available',
        housekeepingStatus: 'clean',
      })
      .expect(201);
    room102Id = r102.body.room.id;

    const rMaint = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        roomTypeId: stdTypeId,
        roomNumber: '109',
        floor: '1',
        operationalStatus: 'maintenance',
        housekeepingStatus: 'out_of_service',
      })
      .expect(201);
    roomMaintId = rMaint.body.room.id;
  });

  it('prevents duplicate room numbers within the same property while allowing in another property', async () => {
    await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        roomTypeId: stdTypeId,
        roomNumber: '101',
        floor: '1',
      })
      .expect(409);

    // Property B can independently have Room 101
    const propBType = await request(app)
      .post('/api/room-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyBId)
      .send({
        code: 'STD',
        name: 'Standard',
        baseCapacity: 2,
        maxCapacity: 2,
        baseRate: 5000,
      })
      .expect(201);

    await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyBId)
      .send({
        roomTypeId: propBType.body.roomType.id,
        roomNumber: '101',
        floor: '1',
      })
      .expect(201);
  });
});

describe('4. Guest CRM & Reservation Validation (Dates, Capacity, Maintenance, Overlaps, Concurrency)', () => {
  it('allows receptionist to create and search guests', async () => {
    const g1 = await request(app)
      .post('/api/guests')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        firstName: 'Aditi',
        lastName: 'Sharma',
        phone: '+91 98100 11111',
        email: 'aditi@example.com',
        vipStatus: true,
      })
      .expect(201);
    guest1Id = g1.body.guest.id;

    const g2 = await request(app)
      .post('/api/guests')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        firstName: 'Karan',
        lastName: 'Verma',
        phone: '+91 98100 22222',
      })
      .expect(201);
    guest2Id = g2.body.guest.id;

    const searchRes = await request(app)
      .get('/api/guests?search=Aditi')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .expect(200);
    expect(searchRes.body.items).toHaveLength(1);
    expect(searchRes.body.items[0].fullName).toBe('Aditi Sharma');
  });

  it('rejects invalid date ranges (departure <= arrival)', async () => {
    const arr = addDays(propertyAToday, 5);
    await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: room101Id,
        arrivalDate: arr,
        departureDate: arr, // 0 nights
        adults: 2,
      })
      .expect(400);

    await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: room101Id,
        arrivalDate: addDays(arr, 2),
        departureDate: arr, // negative nights
        adults: 2,
      })
      .expect(400);
  });

  it('rejects guest count exceeding room maximum capacity', async () => {
    // Room 101 maxCapacity is 2
    const res = await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: room101Id,
        arrivalDate: addDays(propertyAToday, 5),
        departureDate: addDays(propertyAToday, 7),
        adults: 2,
        children: 1, // total 3 > 2
      })
      .expect(400);
    expect(res.body.error.message).toMatch(/capacity/i);
  });

  it('rejects booking a room in maintenance / out_of_service', async () => {
    await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: roomMaintId,
        arrivalDate: addDays(propertyAToday, 5),
        departureDate: addDays(propertyAToday, 7),
        adults: 2,
      })
      .expect(400);
  });

  it('prevents overlapping active reservations while allowing inclusive-arrival / exclusive-departure turnover', async () => {
    const d10 = addDays(propertyAToday, 10);
    const d12 = addDays(propertyAToday, 12);
    const d14 = addDays(propertyAToday, 14);
    const d16 = addDays(propertyAToday, 16);

    // Base booking [d10, d14)
    const baseRes = await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: room101Id,
        arrivalDate: d10,
        departureDate: d14,
        adults: 2,
      })
      .expect(201);

    const baseBookingId = baseRes.body.reservation.id;

    // Overlapping [d12, d16) -> 409 Conflict
    await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest2Id,
        roomId: room101Id,
        arrivalDate: d12,
        departureDate: d16,
        adults: 2,
      })
      .expect(409);

    // Back-to-back starting on exact departure day [d14, d16) -> ALLOWED (201)
    await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest2Id,
        roomId: room101Id,
        arrivalDate: d14,
        departureDate: d16,
        adults: 2,
      })
      .expect(201);

    // Cancel base booking [d10, d14) -> Cancelled reservations MUST NOT block availability
    await request(app)
      .post(`/api/reservations/${baseBookingId}/cancel`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ reason: 'Guest cancelled prior to arrival' })
      .expect(200);

    // Now [d10, d14) can be booked again cleanly!
    await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest2Id,
        roomId: room101Id,
        arrivalDate: d10,
        departureDate: d14,
        adults: 1,
      })
      .expect(201);
  });

  it('prevents double-booking under simultaneous concurrent requests', async () => {
    const cStart = addDays(propertyAToday, 25);
    const cEnd = addDays(propertyAToday, 28);

    const concurrentRequests = Array.from({ length: 5 }, () =>
      request(app)
        .post('/api/reservations')
        .set('Authorization', `Bearer ${receptionistToken}`)
        .set('X-Property-Id', propertyAId)
        .send({
          guestId: guest1Id,
          roomId: room102Id,
          arrivalDate: cStart,
          departureDate: cEnd,
          adults: 2,
        })
    );

    const responses = await Promise.all(concurrentRequests);
    const created = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(4);
  });
});

describe('5. Check-In, Check-Out, Early Departure Edit & Housekeeping Separation', () => {
  it('enforces room cleanliness, arrival/departure date validation, occupancy updates, and status history', async () => {
    // Set Room 102 dirty first
    await request(app)
      .patch(`/api/rooms/${room102Id}/housekeeping`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ housekeepingStatus: 'dirty' })
      .expect(200);

    // Create reservation arriving TODAY for 3 nights in Room 102
    const resCreate = await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: room102Id,
        arrivalDate: propertyAToday,
        departureDate: addDays(propertyAToday, 3),
        adults: 2,
        children: 1,
      })
      .expect(201);

    const resId = resCreate.body.reservation.id as string;

    // 1. Check-in blocked while room is Dirty
    await request(app)
      .post(`/api/reservations/${resId}/check-in`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({})
      .expect(409);

    // 2. Clean the room via canonical Phase 2 workflow -> Check-in succeeds!
    await request(app)
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ action: 'start_cleaning' })
      .expect(200);
    await request(app)
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ action: 'complete_cleaning' })
      .expect(200);
    await request(app)
      .patch(`/api/rooms/${room102Id}/housekeeping`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ housekeepingStatus: 'inspected' })
      .expect(200);

    const checkedIn = await request(app)
      .post(`/api/reservations/${resId}/check-in`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ note: 'Passport verified' })
      .expect(200);

    expect(checkedIn.body.reservation.status).toBe('checked_in');
    // Housekeeping remains separate ('inspected') while reservation is 'checked_in'
    expect(checkedIn.body.reservation.roomHousekeepingStatus).toBe('inspected');

    // 3. Dashboard reflects occupied room & active guest count
    const dash = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .expect(200);
    expect(dash.body.metrics.occupiedRooms).toBe(1);
    expect(dash.body.metrics.inHouseGuestsCount).toBe(3);

    // 4. Checked-in reservation cannot be cancelled
    await request(app)
      .post(`/api/reservations/${resId}/cancel`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ reason: 'Try cancel after check-in' })
      .expect(400);

    // 5. Direct early check-out today (when scheduled departure is today+3) is blocked until dates are deliberately edited!
    const earlyAttempt = await request(app)
      .post(`/api/reservations/${resId}/check-out`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({})
      .expect(400);
    expect(earlyAttempt.body.error.message).toMatch(/departure date/i);

    // Move arrival to yesterday and departure to today via deliberate validated edit, then check out!
    await request(app)
      .put(`/api/reservations/${resId}`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        arrivalDate: addDays(propertyAToday, -1),
        departureDate: propertyAToday,
        editReason: 'Early departure confirmed with guest',
      })
      .expect(200);

    const checkedOut = await request(app)
      .post(`/api/reservations/${resId}/check-out`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ note: 'Settled room charges' })
      .expect(200);

    expect(checkedOut.body.reservation.status).toBe('checked_out');
    // Room housekeeping transitions to 'dirty' for turnover
    expect(checkedOut.body.reservation.roomHousekeepingStatus).toBe('dirty');
    // Status history recorded all transitions
    expect(checkedOut.body.reservation.history.length).toBeGreaterThanOrEqual(4);
  });

  it('blocks check-in when arrival date does not match property today until deliberately edited', async () => {
    const futureRes = await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest2Id,
        roomId: room101Id,
        arrivalDate: addDays(propertyAToday, 2),
        departureDate: addDays(propertyAToday, 4),
        adults: 1,
      })
      .expect(201);

    const futureId = futureRes.body.reservation.id as string;

    const prematureCheckIn = await request(app)
      .post(`/api/reservations/${futureId}/check-in`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({})
      .expect(400);
    expect(prematureCheckIn.body.error.message).toMatch(/arrival date/i);

    // Deliberate edit to today -> check-in succeeds
    await request(app)
      .put(`/api/reservations/${futureId}`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        arrivalDate: propertyAToday,
        departureDate: addDays(propertyAToday, 2),
        editReason: 'Guest arrived early; room 101 verified available',
      })
      .expect(200);

    const nowCheckedIn = await request(app)
      .post(`/api/reservations/${futureId}/check-in`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({})
      .expect(200);
    expect(nowCheckedIn.body.reservation.status).toBe('checked_in');
  });

  it('supports walk-in immediate check-in, list search/filtering/pagination, and admin property settings updates', async () => {
    // Clean room 102 after previous checkout via canonical Phase 2 workflow
    await request(app)
      .post(`/api/rooms/${room102Id}/housekeeping-workflow`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ action: 'start_cleaning' })
      .expect(200);
    await request(app)
      .patch(`/api/rooms/${room102Id}/housekeeping`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ housekeepingStatus: 'clean' })
      .expect(200);

    // Admin updates property tax rate to 18%
    await request(app)
      .put('/api/properties/current')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        name: 'Test Heritage Hotel Updated',
        email: 'info@test.local',
        phone: '+91 90000 00001',
        addressLine1: '12 Ghat Rd',
        city: 'Varanasi',
        country: 'India',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        defaultTaxRate: 18,
        taxName: 'GST',
        standardCheckInTime: '14:00',
        standardCheckOutTime: '11:00',
      })
      .expect(200);

    // Create Walk-in reservation with immediate check-in
    const walkIn = await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: room102Id,
        arrivalDate: propertyAToday,
        departureDate: addDays(propertyAToday, 1),
        adults: 2,
        source: 'walk_in',
        isWalkIn: true,
        checkInImmediately: true,
      })
      .expect(201);

    expect(walkIn.body.reservation.status).toBe('checked_in');
    expect(walkIn.body.reservation.isWalkIn).toBe(true);
    expect(walkIn.body.reservation.taxRate).toBe(18);

    // Search & filter pagination check
    const listRes = await request(app)
      .get('/api/reservations?quickFilter=in_house&pageSize=1&page=1')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .expect(200);

    expect(listRes.body.total).toBe(2);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.totalPages).toBe(2);
  });
});

describe('6. Authentication Regression Suite (Iframe Storage Blocking, Cookie/Bearer Sync, Expiry, Logout & Admin Setup)', () => {
  it('retains session token & property context in memory when window.sessionStorage/localStorage throw SecurityError in cross-site iframes', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    // Simulate cross-site iframe where accessing window.sessionStorage or window.localStorage throws SecurityError
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const restrictedWindow = {};
    Object.defineProperty(restrictedWindow, 'sessionStorage', {
      get() {
        throw new Error(
          "SecurityError: Failed to read the 'sessionStorage' property from 'Window': Access is denied for this document."
        );
      },
    });
    Object.defineProperty(restrictedWindow, 'localStorage', {
      get() {
        throw new Error(
          "SecurityError: Failed to read the 'localStorage' property from 'Window': Access is denied for this document."
        );
      },
    });
    (globalThis as Record<string, unknown>).window = restrictedWindow;

    const unauthorizedMessages: string[] = [];
    setUnauthorizedHandler((msg) => unauthorizedMessages.push(msg));

    try {
      resetApiTransportState();
      const loginRes = await apiFetch<{
        sessionToken?: string;
        defaultPropertyId: string;
        user: { fullName: string; role: string };
      }>(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        body: { email: 'admin@test.local', password: 'TestAdmin#2026' },
        skipUnauthorizedHandling: true,
      });

      expect(loginRes.sessionToken).toBeTruthy();
      setStoredSessionToken(loginRes.sessionToken ?? null);
      setStoredPropertyId(propertyAId);

      expect(getStoredSessionToken()).toBe(loginRes.sessionToken);
      expect(getStoredPropertyId()).toBe(propertyAId);

      // Verify Guest CRM, Rooms, Reservations, Dashboard, and /api/auth/me all succeed with zero cookies & blocked Web Storage
      const meRes = await apiFetch<{ user: { email: string }; sessionToken?: string }>(
        `${baseUrl}/api/auth/me`
      );
      expect(meRes.user.email).toBe('admin@test.local');
      expect(meRes.sessionToken).toBe(loginRes.sessionToken);

      const guestsRes = await apiFetch<{ items: unknown[] }>(`${baseUrl}/api/guests`);
      expect(guestsRes.items.length).toBeGreaterThanOrEqual(2);

      const roomsRes = await apiFetch<{ items: unknown[] }>(`${baseUrl}/api/rooms`);
      expect(roomsRes.items.length).toBeGreaterThanOrEqual(2);

      const reservationsRes = await apiFetch<{ items: unknown[] }>(`${baseUrl}/api/reservations`);
      expect(reservationsRes.items.length).toBeGreaterThanOrEqual(1);

      const dashRes = await apiFetch<{ property: { id: string } }>(`${baseUrl}/api/dashboard`);
      expect(dashRes.property.id).toBe(propertyAId);
      expect(unauthorizedMessages).toHaveLength(0);

      // Verify 403 Forbidden (role error) does NOT trigger unauthorized session wipe
      setStoredSessionToken(receptionistToken);
      await expect(
        apiFetch(`${baseUrl}/api/room-types`, {
          method: 'POST',
          body: { code: 'NOPE', name: 'Denied', baseCapacity: 1, maxCapacity: 1, baseRate: 1000 },
        })
      ).rejects.toMatchObject({ status: 403 });
      expect(unauthorizedMessages).toHaveLength(0);

      // Verify genuine 401 triggers unauthorizedHandler AND still throws ApiClientError(401)
      setStoredSessionToken('invalid_expired_token_value');
      await expect(apiFetch(`${baseUrl}/api/guests`)).rejects.toBeInstanceOf(ApiClientError);
      expect(unauthorizedMessages).toHaveLength(1);
    } finally {
      resetApiTransportState();
      setStoredSessionToken(null);
      setStoredPropertyId(null);
      setUnauthorizedHandler(null);
      (globalThis as Record<string, unknown>).window = originalWindow;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('distinguishes invalid login credentials (INVALID_CREDENTIALS) from missing auth (AUTH_TOKEN_MISSING) and expired sessions (SESSION_EXPIRED)', async () => {
    const badLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'WrongPassword123!' })
      .expect(401);
    expect(badLogin.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(badLogin.body.error.message).toMatch(/invalid email or password/i);
    expect(badLogin.body.error.message).not.toMatch(/please sign in to access this resource/i);

    const unauthProtected = await request(app).get('/api/guests').expect(401);
    expect(unauthProtected.body.error.code).toBe('AUTH_TOKEN_MISSING');

    const bogusTokenProtected = await request(app)
      .get('/api/guests')
      .set('Authorization', 'Bearer dead_nonexistent_token')
      .expect(401);
    expect(bogusTokenProtected.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('succeeds seamlessly behind header-stripping preview proxies (both Authorization+Cookie stripped and strict all-custom-headers stripped via POST /api/rpc)', async () => {
    const upstream = http.createServer(app);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const upAddr = upstream.address();
    const upstreamPort = typeof upAddr === 'object' && upAddr ? upAddr.port : 0;

    // Mode 1: Proxy strips Authorization + Cookie + Set-Cookie, keeps X-Session-Token & X-Property-Id
    // Mode 2: Proxy strips ALL custom headers (only forwards accept, content-type, content-length, user-agent)
    let strictAllowlistOnly = false;

    const gatewayProxy = http.createServer((clientReq, clientRes) => {
      const forwardedHeaders: http.OutgoingHttpHeaders = {
        host: `127.0.0.1:${upstreamPort}`,
      };

      for (const [k, v] of Object.entries(clientReq.headers)) {
        const lower = k.toLowerCase();
        if (strictAllowlistOnly) {
          if (['accept', 'content-type', 'content-length', 'user-agent'].includes(lower)) {
            forwardedHeaders[lower] = v;
          }
        } else {
          if (!['host', 'authorization', 'cookie'].includes(lower)) {
            forwardedHeaders[lower] = v;
          }
        }
      }

      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: upstreamPort,
          method: clientReq.method,
          path: clientReq.url,
          headers: forwardedHeaders,
        },
        (upRes) => {
          const outHeaders = { ...upRes.headers };
          delete outHeaders['set-cookie']; // Simulate proxy stripping Set-Cookie
          clientRes.writeHead(upRes.statusCode ?? 500, outHeaders);
          upRes.pipe(clientRes);
        }
      );
      clientReq.pipe(proxyReq);
    });

    await new Promise<void>((resolve) => gatewayProxy.listen(0, '127.0.0.1', () => resolve()));
    const gwAddr = gatewayProxy.address();
    const proxyUrl = `http://127.0.0.1:${typeof gwAddr === 'object' && gwAddr ? gwAddr.port : 0}`;

    try {
      // --- Subtest A: Proxy strips Authorization + Cookie (X-Session-Token works directly) ---
      resetApiTransportState();
      setStoredSessionToken(null);
      setStoredPropertyId(propertyAId);

      const loginA = await apiFetch<{ sessionToken?: string }>(`${proxyUrl}/api/auth/login`, {
        method: 'POST',
        body: { email: 'admin@test.local', password: 'TestAdmin#2026' },
        skipUnauthorizedHandling: true,
      });
      setStoredSessionToken(loginA.sessionToken ?? null);

      const meA = await apiFetch<{ user: { email: string } }>(`${proxyUrl}/api/auth/me`, {
        skipUnauthorizedHandling: true,
      });
      expect(meA.user.email).toBe('admin@test.local');
      expect(isUsingRpcTransport()).toBe(false);

      const guestsA = await apiFetch<{ items: Array<{ fullName: string }> }>(
        `${proxyUrl}/api/guests?search=Aditi`
      );
      expect(guestsA.items).toHaveLength(1);
      expect(guestsA.items[0].fullName).toBe('Aditi Sharma');

      // --- Subtest B: Strict Proxy strips ALL custom headers (auto-switches to POST /api/rpc) ---
      strictAllowlistOnly = true;
      resetApiTransportState();
      setStoredSessionToken(null);
      setStoredPropertyId(propertyAId);

      const loginB = await apiFetch<{ sessionToken?: string }>(`${proxyUrl}/api/auth/login`, {
        method: 'POST',
        body: { email: 'admin@test.local', password: 'TestAdmin#2026' },
        skipUnauthorizedHandling: true,
      });
      const tokenB = loginB.sessionToken!;
      setStoredSessionToken(tokenB);

      const meB = await apiFetch<{ user: { email: string } }>(`${proxyUrl}/api/auth/me`, {
        skipUnauthorizedHandling: true,
      });
      expect(meB.user.email).toBe('admin@test.local');
      expect(isUsingRpcTransport()).toBe(true);

      // Query string parsing + property context via POST /api/rpc
      const guestsB = await apiFetch<{ items: Array<{ fullName: string }> }>(
        `${proxyUrl}/api/guests?search=Aditi`
      );
      expect(guestsB.items).toHaveLength(1);
      expect(guestsB.items[0].fullName).toBe('Aditi Sharma');

      const roomsB = await apiFetch<{ items: unknown[] }>(`${proxyUrl}/api/rooms`);
      expect(roomsB.items.length).toBeGreaterThanOrEqual(2);

      const resB = await apiFetch<{ total: number; items: unknown[] }>(
        `${proxyUrl}/api/reservations?quickFilter=in_house&pageSize=1&page=1`
      );
      expect(resB.total).toBe(2);
      expect(resB.items).toHaveLength(1);

      const dashB = await apiFetch<{ property: { id: string } }>(`${proxyUrl}/api/dashboard`);
      expect(dashB.property.id).toBe(propertyAId);

      // Unauthenticated POST /api/rpc remains strictly blocked (401)
      await request(app)
        .post('/api/rpc')
        .send({ method: 'GET', path: '/api/guests' })
        .expect(401);

      // Receptionist role restriction remains strictly enforced via POST /api/rpc (403)
      setStoredSessionToken(receptionistToken);
      await expect(
        apiFetch(`${proxyUrl}/api/room-types`, {
          method: 'POST',
          body: { code: 'DENY', name: 'Denied', baseCapacity: 1, maxCapacity: 1, baseRate: 900 },
        })
      ).rejects.toMatchObject({ status: 403 });

      // Logout via POST /api/rpc invalidates session in PostgreSQL
      setStoredSessionToken(tokenB);
      await apiFetch(`${proxyUrl}/api/auth/logout`, {
        method: 'POST',
        skipUnauthorizedHandling: true,
      });

      await expect(
        apiFetch(`${proxyUrl}/api/guests`, { skipUnauthorizedHandling: true })
      ).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
    } finally {
      resetApiTransportState();
      setStoredSessionToken(null);
      setStoredPropertyId(null);
      await new Promise<void>((resolve) => gatewayProxy.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('sets Partitioned SameSite=None Secure cookies behind multi-hop HTTPS proxies and coordinates Cookie + Bearer carriers cleanly', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-Proto', 'https, http')
      .send({ email: 'admin@test.local', password: 'TestAdmin#2026' })
      .expect(200);

    const setCookieHeader = loginRes.headers['set-cookie']?.[0] ?? '';
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('SameSite=None');
    expect(setCookieHeader).toContain('Secure');
    expect(setCookieHeader).toContain('Partitioned');

    const freshToken = loginRes.body.sessionToken as string;
    const cookiePair = setCookieHeader.split(';')[0];

    // Cookie-only /api/auth/me works (page refresh) and returns sessionToken to synchronize client memory
    const meViaCookie = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookiePair)
      .expect(200);
    expect(meViaCookie.body.user.email).toBe('admin@test.local');
    expect(meViaCookie.body.sessionToken).toBe(freshToken);

    // Stale cookie + valid Bearer token resolves cleanly to the valid active session
    const guestsWithStaleCookie = await request(app)
      .get('/api/guests')
      .set('Cookie', 'staycraft_session=stale_deleted_cookie_token')
      .set('Authorization', `Bearer ${freshToken}`)
      .set('X-Property-Id', propertyAId)
      .expect(200);
    expect(guestsWithStaleCookie.body.items.length).toBeGreaterThan(0);

    // Valid cookie + stale Bearer token also resolves cleanly to the valid active session
    const roomsWithValidCookie = await request(app)
      .get('/api/rooms')
      .set('Cookie', cookiePair)
      .set('Authorization', 'Bearer stale_deleted_bearer_token')
      .set('X-Property-Id', propertyAId)
      .expect(200);
    expect(roomsWithValidCookie.body.items.length).toBeGreaterThan(0);
  });

  it('invalidates server session on logout and rejects expired sessions with 401', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'TestAdmin#2026' })
      .expect(200);

    const tempToken = loginRes.body.sessionToken as string;
    const cookiePair = (loginRes.headers['set-cookie']?.[0] ?? '').split(';')[0];

    // Expire session in DB and verify 401 rejection
    await getPool().query(
      `UPDATE user_sessions SET expires_at = NOW() - INTERVAL '5 minutes' WHERE token_hash = $1`,
      [hashSessionToken(tempToken)]
    );

    const expiredRes = await request(app)
      .get('/api/guests')
      .set('Authorization', `Bearer ${tempToken}`)
      .set('X-Property-Id', propertyAId)
      .expect(401);
    expect(expiredRes.body.error.message).toMatch(/expired or invalid/i);

    await request(app)
      .get('/api/guests')
      .set('Cookie', cookiePair)
      .set('X-Property-Id', propertyAId)
      .expect(401);

    // Fresh login followed by explicit logout invalidates both Bearer and Cookie access
    const login2 = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'TestAdmin#2026' })
      .expect(200);
    const token2 = login2.body.sessionToken as string;
    const cookie2 = (login2.headers['set-cookie']?.[0] ?? '').split(';')[0];

    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token2}`)
      .set('Cookie', cookie2)
      .expect(200);

    await request(app)
      .get('/api/guests')
      .set('Authorization', `Bearer ${token2}`)
      .set('X-Property-Id', propertyAId)
      .expect(401);

    await request(app)
      .get('/api/guests')
      .set('Cookie', cookie2)
      .set('X-Property-Id', propertyAId)
      .expect(401);
  });

  it('creates and resets initial administrator account safely via ensureInitialAdminAccount', async () => {
    const created = await ensureInitialAdminAccount({
      email: 'initial.admin@test.local',
      password: 'InitAdminPassword#1',
      fullName: 'Initial Admin',
    });
    expect(created.action).toBe('created');

    const firstLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'initial.admin@test.local', password: 'InitAdminPassword#1' })
      .expect(200);
    const firstSessionToken = firstLogin.body.sessionToken as string;

    // Resetting password updates credentials and revokes prior active sessions
    const reset = await ensureInitialAdminAccount({
      email: 'initial.admin@test.local',
      password: 'ResetAdminPassword#2',
      resetPassword: true,
    });
    expect(reset.action).toBe('password_reset');

    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${firstSessionToken}`)
      .expect(401);

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'initial.admin@test.local', password: 'ResetAdminPassword#2' })
      .expect(200);
  });
});

describe('7. Fix 1 Regression: Dashboard & Housekeeping Room Status Partitioning', () => {
  it('never counts maintenance or out-of-service rooms as clean/dirty/inspected and reconciles exact room totals', async () => {
    const propRes = await request(app)
      .post('/api/properties')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'HKP',
        name: 'Housekeeping Partition Hotel',
        email: 'hkp@test.local',
        phone: '+91 90000 00104',
        addressLine1: '104 Riverfront',
        city: 'Varanasi',
        country: 'India',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        defaultTaxRate: 12,
        taxName: 'GST',
        standardCheckInTime: '14:00',
        standardCheckOutTime: '11:00',
      })
      .expect(201);

    const hkpId = propRes.body.property.id as string;
    const hkpToday = propRes.body.property.localToday as string;

    const catRes = await request(app)
      .post('/api/room-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({
        code: 'STD',
        name: 'Standard Room',
        baseCapacity: 2,
        maxCapacity: 2,
        baseRate: 4200,
      })
      .expect(201);
    const catId = catRes.body.roomType.id as string;

    // 101: operational + inspected
    const r101 = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({
        roomTypeId: catId,
        roomNumber: '101',
        floor: '1',
        operationalStatus: 'available',
        housekeepingStatus: 'inspected',
      })
      .expect(201);

    // 102: operational + clean
    await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({
        roomTypeId: catId,
        roomNumber: '102',
        floor: '1',
        operationalStatus: 'available',
        housekeepingStatus: 'clean',
      })
      .expect(201);

    // 103: operational + dirty
    await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({
        roomTypeId: catId,
        roomNumber: '103',
        floor: '1',
        operationalStatus: 'available',
        housekeepingStatus: 'dirty',
      })
      .expect(201);

    // 104: Room 104 regression fixture — operational_status='maintenance', then housekeeping set to 'clean'
    const r104 = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({
        roomTypeId: catId,
        roomNumber: '104',
        floor: '1',
        operationalStatus: 'maintenance',
        housekeepingStatus: 'out_of_service',
      })
      .expect(201);

    await request(app)
      .patch(`/api/rooms/${r104.body.room.id}/housekeeping`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({ housekeepingStatus: 'clean' })
      .expect(200);

    // 105: operational_status='out_of_service', housekeeping changed to 'inspected'
    const r105 = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({
        roomTypeId: catId,
        roomNumber: '105',
        floor: '1',
        operationalStatus: 'out_of_service',
        housekeepingStatus: 'out_of_service',
      })
      .expect(201);

    await request(app)
      .patch(`/api/rooms/${r105.body.room.id}/housekeeping`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({ housekeepingStatus: 'inspected' })
      .expect(200);

    // 106: operational_status='available', housekeeping_status='out_of_service'
    await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({
        roomTypeId: catId,
        roomNumber: '106',
        floor: '1',
        operationalStatus: 'available',
        housekeepingStatus: 'out_of_service',
      })
      .expect(201);

    // 107: deactivated room (excluded from active inventory)
    await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({
        roomTypeId: catId,
        roomNumber: '107',
        floor: '1',
        operationalStatus: 'available',
        housekeepingStatus: 'clean',
        isActive: false,
      })
      .expect(201);

    // Check a guest into Room 101 to verify occupancy & sellable-room calculations remain intact
    const guestRes = await request(app)
      .post('/api/guests')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({ firstName: 'Riya', lastName: 'Sen', phone: '+91 98111 00104' })
      .expect(201);

    await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .send({
        guestId: guestRes.body.guest.id,
        roomId: r101.body.room.id,
        arrivalDate: hkpToday,
        departureDate: addDays(hkpToday, 2),
        adults: 2,
        isWalkIn: true,
        checkInImmediately: true,
      })
      .expect(201);

    const dashRes = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hkpId)
      .expect(200);

    const { metrics, housekeepingCounts, roomRack } = dashRes.body;

    // Underlying fields remain distinct on Room 104
    const rack104 = roomRack.find((r: { roomNumber: string }) => r.roomNumber === '104');
    expect(rack104.operationalStatus).toBe('maintenance');
    expect(rack104.housekeepingStatus).toBe('clean');
    expect(getRoomStatusBucket(rack104)).toBe('out_of_service');

    // Exact partition: 1 inspected (101), 1 clean (102), 1 dirty (103), 3 out_of_service (104, 105, 106)
    expect(housekeepingCounts).toEqual({
      inspected: 1,
      clean: 1,
      dirty: 1,
      out_of_service: 3,
    });

    // Shared helper used by HousekeepingPage produces identical counts
    expect(summarizeRoomStatusBuckets(roomRack)).toEqual(housekeepingCounts);

    // Zero double-counting: sum of buckets === totalRooms
    const bucketSum =
      housekeepingCounts.inspected +
      housekeepingCounts.clean +
      housekeepingCounts.dirty +
      housekeepingCounts.out_of_service;
    expect(bucketSum).toBe(metrics.totalRooms);
    expect(metrics.totalRooms).toBe(6);

    // Occupancy & sellable-room calculations preserved
    expect(metrics.sellableRooms).toBe(3);
    expect(metrics.unavailableOperationalRooms).toBe(3);
    expect(metrics.occupiedRooms).toBe(1);
    expect(metrics.availableRooms).toBe(2);
    expect(metrics.occupancyPercentage).toBe(33.3);
  });
});

describe('8. Fix 2 Regression: Reject Past Arrival Dates for New Reservations & Timezone Boundaries', () => {
  it('rejects past arrival dates on create while allowing today, future, and legitimate edits to existing in-house stays', async () => {
    // 1. Yesterday's arrival rejected on create (400 PAST_ARRIVAL_DATE)
    const past1 = await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: room101Id,
        arrivalDate: addDays(propertyAToday, -1),
        departureDate: addDays(propertyAToday, 2),
        adults: 1,
      })
      .expect(400);
    expect(past1.body.error.details?.reason).toBe('PAST_ARRIVAL_DATE');
    expect(past1.body.error.message).toMatch(/cannot be earlier/i);

    // 2. Older past arrival also rejected
    await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: room101Id,
        arrivalDate: addDays(propertyAToday, -30),
        departureDate: addDays(propertyAToday, -28),
        adults: 1,
      })
      .expect(400);

    // 3. Create dedicated clean room on Property A to verify today's arrival + future arrival + in-house edit
    const r108Res = await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        roomTypeId: stdTypeId,
        roomNumber: '108',
        floor: '1',
        operationalStatus: 'available',
        housekeepingStatus: 'inspected',
      })
      .expect(201);
    const room108Id = r108Res.body.room.id as string;

    // Today's arrival succeeds (201)
    const todayCreate = await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: room108Id,
        arrivalDate: propertyAToday,
        departureDate: addDays(propertyAToday, 2),
        adults: 2,
      })
      .expect(201);
    const todayBookingId = todayCreate.body.reservation.id as string;

    // Future arrival starting on exact departure day (same-day turnover) succeeds (201)
    await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest2Id,
        roomId: room108Id,
        arrivalDate: addDays(propertyAToday, 2),
        departureDate: addDays(propertyAToday, 5),
        adults: 1,
      })
      .expect(201);

    // Check in today's booking, then verify legitimate edits on an in-house stay (including past arrival date) remain allowed
    await request(app)
      .post(`/api/reservations/${todayBookingId}/check-in`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({})
      .expect(200);

    const editedInHouse = await request(app)
      .put(`/api/reservations/${todayBookingId}`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        arrivalDate: addDays(propertyAToday, -2),
        departureDate: addDays(propertyAToday, 2),
        internalNotes: 'Adjusted historical check-in date and verified billing',
        editReason: 'Front-desk audit adjustment',
      })
      .expect(200);

    expect(editedInHouse.body.reservation.arrivalDate).toBe(addDays(propertyAToday, -2));
    expect(editedInHouse.body.reservation.nights).toBe(4);

    // Subsequent edit keeping the past arrival date (e.g. updating specialRequests) also succeeds
    await request(app)
      .put(`/api/reservations/${todayBookingId}`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        specialRequests: 'Extra pillows delivered',
      })
      .expect(200);
  });

  it('enforces past-arrival rejection using each property configured timezone across date boundaries', async () => {
    // Pacific/Kiritimati (+14:00) is always 24 hours ahead of Pacific/Honolulu (-10:00)
    const kirProp = await request(app)
      .post('/api/properties')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'KIR',
        name: 'Kiritimati Atoll Lodge',
        email: 'kir@test.local',
        phone: '+686 70001',
        addressLine1: '1 Lagoon Way',
        city: 'London',
        country: 'Kiribati',
        timezone: 'Pacific/Kiritimati',
        currency: 'USD',
        defaultTaxRate: 10,
        taxName: 'VAT',
        standardCheckInTime: '14:00',
        standardCheckOutTime: '11:00',
      })
      .expect(201);

    const hnlProp = await request(app)
      .post('/api/properties')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'HNL',
        name: 'Honolulu Surf Hotel',
        email: 'hnl@test.local',
        phone: '+1 808 555 0100',
        addressLine1: '200 Kalakaua Ave',
        city: 'Honolulu',
        country: 'USA',
        timezone: 'Pacific/Honolulu',
        currency: 'USD',
        defaultTaxRate: 10,
        taxName: 'TAT',
        standardCheckInTime: '15:00',
        standardCheckOutTime: '11:00',
      })
      .expect(201);

    const kirId = kirProp.body.property.id as string;
    const hnlId = hnlProp.body.property.id as string;
    const hnlToday = getPropertyLocalDate('Pacific/Honolulu');
    const kirToday = getPropertyLocalDate('Pacific/Kiritimati');
    expect(diffDays(hnlToday, kirToday)).toBe(1);

    // Setup category, room, and guest on both properties
    const setupPropAssets = async (propId: string) => {
      const rt = await request(app)
        .post('/api/room-types')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Property-Id', propId)
        .send({ code: 'STD', name: 'Standard', baseCapacity: 2, maxCapacity: 2, baseRate: 200 })
        .expect(201);
      const rm = await request(app)
        .post('/api/rooms')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Property-Id', propId)
        .send({ roomTypeId: rt.body.roomType.id, roomNumber: '101', floor: '1' })
        .expect(201);
      const g = await request(app)
        .post('/api/guests')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Property-Id', propId)
        .send({ firstName: ' Alex', lastName: 'Ray', phone: '+1 808 555 0199' })
        .expect(201);
      return { roomId: rm.body.room.id as string, guestId: g.body.guest.id as string };
    };

    const kirAssets = await setupPropAssets(kirId);
    const hnlAssets = await setupPropAssets(hnlId);

    // Same calendar date (hnlToday) is rejected as past in Kiritimati (400) while accepted as today in Honolulu (201)
    const kirReject = await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', kirId)
      .send({
        guestId: kirAssets.guestId,
        roomId: kirAssets.roomId,
        arrivalDate: hnlToday,
        departureDate: addDays(hnlToday, 2),
        adults: 1,
      })
      .expect(400);
    expect(kirReject.body.error.details?.reason).toBe('PAST_ARRIVAL_DATE');

    await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', hnlId)
      .send({
        guestId: hnlAssets.guestId,
        roomId: hnlAssets.roomId,
        arrivalDate: hnlToday,
        departureDate: addDays(hnlToday, 2),
        adults: 1,
      })
      .expect(201);

    // Also verify exact UTC midnight instant (2026-10-22T20:30:00Z -> Oct 23 in Asia/Kolkata, Oct 22 in America/New_York)
    const adminUserRes = await getPool().query("SELECT id FROM users WHERE email = 'admin@test.local'");
    const adminUserId = adminUserRes.rows[0].id as string;
    const kirRow = (await getPool().query('SELECT * FROM properties WHERE id = $1', [kirId])).rows[0];
    const kolkataProp = { ...mapPropertyRow(kirRow), timezone: 'Asia/Kolkata' };
    const nyProp = { ...mapPropertyRow(kirRow), timezone: 'America/New_York' };
    const refInstant = new Date('2026-10-22T20:30:00Z');

    await expect(
      createReservation(
        kolkataProp,
        adminUserId,
        {
          guestId: kirAssets.guestId,
          roomId: kirAssets.roomId,
          arrivalDate: '2026-10-22',
          departureDate: '2026-10-24',
          adults: 1,
        },
        refInstant
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    const nyCreated = await createReservation(
      nyProp,
      adminUserId,
      {
        guestId: kirAssets.guestId,
        roomId: kirAssets.roomId,
        arrivalDate: '2026-10-22',
        departureDate: '2026-10-24',
        adults: 1,
      },
      refInstant
    );
    expect(nyCreated.arrivalDate).toBe('2026-10-22');
  });
});

describe('9. Fix 3 Regression: Overdue Check-Outs, Departures Due Today, Completed Check-Outs & Timezone Boundaries', () => {
  it('surfaces overdue stays in overdueCheckOuts and urgent notifications without auto-checking-out, distinct from today departures and completed check-outs', async () => {
    const ovdPropRes = await request(app)
      .post('/api/properties')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'OVD',
        name: 'Overdue Tracking Hotel',
        email: 'ovd@test.local',
        phone: '+91 90000 00999',
        addressLine1: '99 Cantonment',
        city: 'Varanasi',
        country: 'India',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        defaultTaxRate: 12,
        taxName: 'GST',
        standardCheckInTime: '14:00',
        standardCheckOutTime: '11:00',
      })
      .expect(201);

    const ovdId = ovdPropRes.body.property.id as string;
    const ovdToday = ovdPropRes.body.property.localToday as string;

    const rtRes = await request(app)
      .post('/api/room-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .send({ code: 'DLX', name: 'Deluxe', baseCapacity: 2, maxCapacity: 3, baseRate: 5000 })
      .expect(201);
    const rtId = rtRes.body.roomType.id as string;

    const createOvdRoom = async (num: string) => {
      const r = await request(app)
        .post('/api/rooms')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Property-Id', ovdId)
        .send({ roomTypeId: rtId, roomNumber: num, floor: '2', housekeepingStatus: 'inspected' })
        .expect(201);
      return r.body.room.id as string;
    };

    const rm201 = await createOvdRoom('201');
    const rm202 = await createOvdRoom('202');
    const rm203 = await createOvdRoom('203');

    const gRes = await request(app)
      .post('/api/guests')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .send({ firstName: 'Dev', lastName: 'Kapoor', phone: '+91 98999 11111' })
      .expect(201);
    const gId = gRes.body.guest.id as string;

    // Create 3 bookings starting today, check them in, then backdate stay ranges via PUT to represent:
    // - resOverdue (Room 201): [today-3, today-1), still checked_in (overdue!)
    // - resDueToday (Room 202): [today-1, today), still checked_in (normal departure due today!)
    // - resCompleted (Room 203): [today-2, today), checked_out (completed check-out today!)
    const makeCheckedInBooking = async (roomId: string) => {
      const created = await request(app)
        .post('/api/reservations')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Property-Id', ovdId)
        .send({
          guestId: gId,
          roomId,
          arrivalDate: ovdToday,
          departureDate: addDays(ovdToday, 1),
          adults: 2,
          isWalkIn: true,
          checkInImmediately: true,
        })
        .expect(201);
      return created.body.reservation.id as string;
    };

    const overdueId = await makeCheckedInBooking(rm201);
    const dueTodayId = await makeCheckedInBooking(rm202);
    const completedId = await makeCheckedInBooking(rm203);

    await request(app)
      .put(`/api/reservations/${overdueId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .send({
        arrivalDate: addDays(ovdToday, -3),
        departureDate: addDays(ovdToday, -1),
        editReason: 'Simulate stay whose departure passed yesterday',
      })
      .expect(200);

    await request(app)
      .put(`/api/reservations/${dueTodayId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .send({
        arrivalDate: addDays(ovdToday, -1),
        departureDate: ovdToday,
        editReason: 'Scheduled to depart today',
      })
      .expect(200);

    await request(app)
      .put(`/api/reservations/${completedId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .send({
        arrivalDate: addDays(ovdToday, -2),
        departureDate: ovdToday,
        editReason: 'Departing today and completing check-out',
      })
      .expect(200);

    await request(app)
      .post(`/api/reservations/${completedId}/check-out`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .send({ note: 'Completed morning check-out' })
      .expect(200);

    // Inspect Dashboard
    const dashBefore = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .expect(200);

    // 1. Overdue stay is NOT auto-checked-out and Room 201 is NOT released
    expect(dashBefore.body.overdueCheckOuts).toHaveLength(1);
    expect(dashBefore.body.overdueCheckOuts[0].id).toBe(overdueId);
    expect(dashBefore.body.overdueCheckOuts[0].status).toBe('checked_in');
    expect(dashBefore.body.metrics.overdueCheckOutsCount).toBe(1);

    const rack201 = dashBefore.body.roomRack.find((r: { roomNumber: string }) => r.roomNumber === '201');
    expect(rack201.isOccupied).toBe(true);
    expect(dashBefore.body.metrics.occupiedRooms).toBe(2); // Room 201 (overdue) + Room 202 (due today)

    // 2. Normal departures due today are clearly distinguished from overdue check-outs
    expect(dashBefore.body.todayDepartures).toHaveLength(2); // dueToday + completedToday
    expect(dashBefore.body.todayDepartures.map((r: { id: string }) => r.id)).not.toContain(overdueId);
    expect(dashBefore.body.metrics.departuresTodayTotal).toBe(2);
    expect(dashBefore.body.metrics.departuresPendingCheckOut).toBe(1);
    expect(dashBefore.body.metrics.departuresCheckedOut).toBe(1);

    // 3. Urgent 'overdue-checkouts' notification + separate warning 'departures-due' notification
    const overdueNotif = dashBefore.body.notifications.find(
      (n: { id: string }) => n.id === 'overdue-checkouts'
    );
    const dueTodayNotif = dashBefore.body.notifications.find(
      (n: { id: string }) => n.id === 'departures-due'
    );
    expect(overdueNotif).toBeDefined();
    expect(overdueNotif.severity).toBe('urgent');
    expect(dueTodayNotif).toBeDefined();
    expect(dueTodayNotif.severity).toBe('warning');

    // 4. Reservations quickFilter=overdue_checkouts returns only the overdue stay
    const filteredOverdue = await request(app)
      .get('/api/reservations?quickFilter=overdue_checkouts')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .expect(200);
    expect(filteredOverdue.body.total).toBe(1);
    expect(filteredOverdue.body.items[0].id).toBe(overdueId);

    // 5. Midnight & timezone boundary check via getDashboardSummary(property, referenceDate)
    // dueTodayId has departureDate === ovdToday.
    // Right after midnight on ovdToday+1 in Asia/Kolkata, dueTodayId ALSO becomes overdue in Asia/Kolkata,
    // while at that same UTC instant in America/New_York (still ovdToday) it is NOT overdue yet!
    const nextDayKolkata = addDays(ovdToday, 1);
    // 19:00 UTC on ovdToday is 00:30 local on ovdToday+1 in Asia/Kolkata (+05:30),
    // while still 14:00/15:00 local on ovdToday in America/New_York (-04:00/-05:00).
    const postKolkataMidnightUtc = new Date(`${ovdToday}T19:00:00Z`);
    const ovdRow = (await getPool().query('SELECT * FROM properties WHERE id = $1', [ovdId])).rows[0];
    const kolkataProp = mapPropertyRow(ovdRow);
    const nyProp = { ...kolkataProp, timezone: 'America/New_York' };

    const dashKolkataAfterMidnight = await getDashboardSummary(kolkataProp, postKolkataMidnightUtc);
    expect(dashKolkataAfterMidnight.propertyToday).toBe(nextDayKolkata);
    expect(dashKolkataAfterMidnight.metrics.overdueCheckOutsCount).toBe(2); // overdueId + dueTodayId!
    expect(dashKolkataAfterMidnight.metrics.departuresPendingCheckOut).toBe(0);

    const dashNySameInstant = await getDashboardSummary(nyProp, postKolkataMidnightUtc);
    expect(dashNySameInstant.propertyToday).toBe(ovdToday);
    expect(dashNySameInstant.metrics.overdueCheckOutsCount).toBe(1); // only overdueId; dueTodayId is still due today in NY!
    expect(dashNySameInstant.metrics.departuresPendingCheckOut).toBe(1);

    // 6. Explicitly resolve overdueId (update departureDate -> ovdToday, then check out) & check out dueTodayId
    await request(app)
      .put(`/api/reservations/${overdueId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .send({
        departureDate: ovdToday,
        editReason: 'Guest settled late departure through today',
      })
      .expect(200);

    await request(app)
      .post(`/api/reservations/${overdueId}/check-out`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .send({ note: 'Resolved overdue check-out' })
      .expect(200);

    await request(app)
      .post(`/api/reservations/${dueTodayId}/check-out`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .send({ note: 'Checked out on time' })
      .expect(200);

    const dashAfter = await request(app)
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', ovdId)
      .expect(200);

    expect(dashAfter.body.metrics.overdueCheckOutsCount).toBe(0);
    expect(dashAfter.body.overdueCheckOuts).toHaveLength(0);
    expect(dashAfter.body.metrics.departuresPendingCheckOut).toBe(0);
    expect(dashAfter.body.metrics.departuresCheckedOut).toBe(3);
    expect(dashAfter.body.metrics.occupiedRooms).toBe(0);
    expect(
      dashAfter.body.notifications.find((n: { id: string }) => n.id === 'overdue-checkouts')
    ).toBeUndefined();
    expect(
      dashAfter.body.notifications.find((n: { id: string }) => n.id === 'departures-due')
    ).toBeUndefined();
  });
});

describe('10. Guest Updates & Room / Category Update Guards (Active Reservation Protection)', () => {
  it('updates guest CRM records and returns full guest profile with linked reservations', async () => {
    const updatedRes = await request(app)
      .put(`/api/guests/${guest1Id}`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        phone: '+91 98100 99999',
        email: 'aditi.updated@example.com',
        city: 'Jaipur',
        country: 'India',
        vipStatus: false,
        notes: 'Prefers quiet upper-floor room',
      })
      .expect(200);

    expect(updatedRes.body.guest.phone).toBe('+91 98100 99999');
    expect(updatedRes.body.guest.email).toBe('aditi.updated@example.com');
    expect(updatedRes.body.guest.city).toBe('Jaipur');
    expect(updatedRes.body.guest.vipStatus).toBe(false);
    expect(updatedRes.body.guest.notes).toBe('Prefers quiet upper-floor room');

    const detailRes = await request(app)
      .get(`/api/guests/${guest1Id}`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .expect(200);

    expect(detailRes.body.guest.email).toBe('aditi.updated@example.com');
    expect(Array.isArray(detailRes.body.guest.reservations)).toBe(true);
    expect(detailRes.body.guest.reservations.length).toBeGreaterThanOrEqual(1);
  });

  it('enforces admin RBAC and blocks room/category deactivation, maintenance, or capacity drops that conflict with active bookings', async () => {
    // Receptionist forbidden from POST /api/rooms and PUT /api/rooms/:id
    await request(app)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ roomTypeId: stdTypeId, roomNumber: '999', floor: '9' })
      .expect(403);

    await request(app)
      .put(`/api/rooms/${room101Id}`)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ notes: 'Receptionist attempt' })
      .expect(403);

    // Create a 3-guest confirmed booking on Suite Room 102 (suiteTypeId maxCapacity = 4)
    const futureSuiteRes = await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({
        guestId: guest1Id,
        roomId: room102Id,
        arrivalDate: addDays(propertyAToday, 40),
        departureDate: addDays(propertyAToday, 43),
        adults: 2,
        children: 1, // numGuests = 3
      })
      .expect(201);
    expect(futureSuiteRes.body.reservation.numGuests).toBe(3);

    // Safe metadata update on Room 102 succeeds (200)
    const safeRoomUpdate = await request(app)
      .put(`/api/rooms/${room102Id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ notes: 'Balcony furniture inspected' })
      .expect(200);
    expect(safeRoomUpdate.body.room.notes).toBe('Balcony furniture inspected');

    // Blocking Room 102 via maintenance, out_of_service, or deactivation fails (409) while active booking exists
    await request(app)
      .put(`/api/rooms/${room102Id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ operationalStatus: 'maintenance' })
      .expect(409);

    await request(app)
      .put(`/api/rooms/${room102Id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ isActive: false })
      .expect(409);

    // Reassigning Room 102 to stdTypeId (maxCapacity = 2 < 3 guests) fails (409)
    await request(app)
      .put(`/api/rooms/${room102Id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ roomTypeId: stdTypeId })
      .expect(409);

    // Lowering suiteTypeId maxCapacity to 2 (< 3 guests on active booking) fails (409)
    await request(app)
      .put(`/api/room-types/${suiteTypeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ maxCapacity: 2 })
      .expect(409);

    // Deactivating suiteTypeId while active booking uses it fails (409)
    await request(app)
      .put(`/api/room-types/${suiteTypeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ isActive: false })
      .expect(409);

    // Legitimate category rate & amenities update succeeds (200)
    const updatedCat = await request(app)
      .put(`/api/room-types/${suiteTypeId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propertyAId)
      .send({ baseRate: 8900, amenities: ['Wi-Fi', 'AC', 'Living Area'] })
      .expect(200);
    expect(updatedCat.body.roomType.baseRate).toBe(8900);
  });
});
