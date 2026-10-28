import QRCode from 'qrcode';
import type { Request } from 'express';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, diffDays, getPropertyLocalDate } from '../src/shared/dates.js';
import { calculateReservationFinancials } from '../src/shared/pricing.js';
import { createApiApp } from '../src/server/app.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { closePool, getPool } from '../src/server/db/pool.js';
import { resetLoginRateLimiter } from '../src/server/modules/auth/auth.routes.js';
import { resetPublicGuestOrderRateLimiter } from '../src/server/modules/restaurant/guest-food.routes.js';
import {
  hashPassword,
  hashPasswordResetToken,
  hashSessionToken,
} from '../src/server/security/password.js';
import {
  clearTestMailOutbox,
  getTestMailOutbox,
  resolveGuestQrUrlContext,
  resolveSafeAppBaseUrl,
} from '../src/server/services/mailer.service.js';

const app = createApiApp();

async function assertTestDatabaseOnly(): Promise<void> {
  const pool = getPool();
  const dbCheck = await pool.query<{ db_name: string }>(
    'SELECT current_database() AS db_name'
  );
  const connectedDb = String(dbCheck.rows[0]?.db_name ?? '');
  if (connectedDb !== 'staycraft_pms_test') {
    throw new Error(
      `ABORTING FEATURE A/B TEST SUITE: Expected isolated staycraft_pms_test database, got "${connectedDb}"`
    );
  }
}

let propAId = '';
let propBId = '';
let propAQrToken = '';
let propBQrToken = '';

let roomCheckedInNumber = '101';
let roomVacantNumber = '102';
let roomConfirmedNumber = '103';
let roomMaintenanceNumber = '104';
let roomPropBCheckedInNumber = '201';

let menuItemAvailableId = '';
let menuItemSecondId = '';
let menuItemUnavailableId = '';
let menuItemInactiveCatId = '';
let menuItemPropBId = '';

let adminUserId = '';
let peerAdminUserId = '';
let recUserId = '';

let adminEmail = '';
let peerAdminEmail = '';
let recEmail = '';

const initialAdminPass = 'FeatureABAdmin#2026';
const initialRecPass = 'FeatureABRec#2026';

let adminAgent: ReturnType<typeof supertest.agent>;
let recAgent: ReturnType<typeof supertest.agent>;

beforeAll(async () => {
  await assertTestDatabaseOnly();
  await runMigrations();

  const pool = getPool();
  const suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(
    Math.random() * 90 + 10
  )}`.toUpperCase();

  adminEmail = `fab.admin.${suffix.toLowerCase()}@staycraft.local`;
  peerAdminEmail = `fab.peeradmin.${suffix.toLowerCase()}@staycraft.local`;
  recEmail = `fab.rec.${suffix.toLowerCase()}@staycraft.local`;

  const [adminHash, recHash] = await Promise.all([
    hashPassword(initialAdminPass),
    hashPassword(initialRecPass),
  ]);

  const uAdmin = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role, phone)
     VALUES ($1, $2, 'Feature AB Admin', 'admin', '+91 91000 80001')
     RETURNING id`,
    [adminEmail, adminHash]
  );
  adminUserId = String(uAdmin.rows[0].id);

  const uPeerAdmin = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role, phone)
     VALUES ($1, $2, 'Feature AB Peer Admin', 'admin', '+91 91000 80009')
     RETURNING id`,
    [peerAdminEmail, adminHash]
  );
  peerAdminUserId = String(uPeerAdmin.rows[0].id);

  const uRec = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role, phone)
     VALUES ($1, $2, 'Feature AB Receptionist', 'receptionist', '+91 91000 80002')
     RETURNING id`,
    [recEmail, recHash]
  );
  recUserId = String(uRec.rows[0].id);

  const propARes = await pool.query(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name, invoice_settings
     ) VALUES (
       $1, $2, 'faba@staycraft.local', '+91 542 250 8001', '12 Dashashwamedh Ghat', 'Varanasi', 'India',
       'Asia/Kolkata', 'INR', 12.00, 'GST',
       '{"prefix": "FAB-INV", "next_number": 9001, "tax_id": "09AABCF8001M1Z5", "footer_note": "Thank you"}'::jsonb
     ) RETURNING id, guest_qr_token`,
    [`FA${suffix.slice(0, 6)}`, `Kashi Heritage QR Hotel ${suffix}`]
  );
  propAId = String(propARes.rows[0].id);
  propAQrToken = String(propARes.rows[0].guest_qr_token);

  const propBRes = await pool.query(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name
     ) VALUES (
       $1, $2, 'fabb@staycraft.local', '+91 22 4090 8002', '44 Colaba Causeway', 'Mumbai', 'India',
       'Asia/Kolkata', 'INR', 18.00, 'GST'
     ) RETURNING id, guest_qr_token`,
    [`FB${suffix.slice(0, 6)}`, `Bombay Harbour QR Hotel ${suffix}`]
  );
  propBId = String(propBRes.rows[0].id);
  propBQrToken = String(propBRes.rows[0].guest_qr_token);

  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id, is_default)
     VALUES
       ($1, $3, TRUE),
       ($1, $4, FALSE),
       ($2, $3, TRUE)`,
    [adminUserId, recUserId, propAId, propBId]
  );

  // Room types & rooms for Property A and Property B
  const rtARes = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'DLX', 'Deluxe Heritage', 2, 3, 4500)
     RETURNING id`,
    [propAId]
  );
  const rtAId = String(rtARes.rows[0].id);

  roomCheckedInNumber = `101-${suffix.slice(0, 3)}`;
  roomVacantNumber = `102-${suffix.slice(0, 3)}`;
  roomConfirmedNumber = `103-${suffix.slice(0, 3)}`;
  roomMaintenanceNumber = `104-${suffix.slice(0, 3)}`;
  roomPropBCheckedInNumber = `201-${suffix.slice(0, 3)}`;

  const r101 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, $3, '1', 'available', 'clean') RETURNING id`,
    [propAId, rtAId, roomCheckedInNumber]
  );
  await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, $3, '1', 'available', 'clean')`,
    [propAId, rtAId, roomVacantNumber]
  );
  const r103 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, $3, '1', 'available', 'clean') RETURNING id`,
    [propAId, rtAId, roomConfirmedNumber]
  );
  const r104 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, $3, '1', 'maintenance', 'clean') RETURNING id`,
    [propAId, rtAId, roomMaintenanceNumber]
  );

  const rtBRes = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'SEA', 'Sea View Club', 2, 3, 6200)
     RETURNING id`,
    [propBId]
  );
  const r201 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, $3, '2', 'available', 'clean') RETURNING id`,
    [propBId, rtBRes.rows[0].id, roomPropBCheckedInNumber]
  );

  // Guests & reservations
  const today = getPropertyLocalDate('Asia/Kolkata');
  const tomorrow = addDays(today, 2);
  const futureStart = addDays(today, 5);
  const futureEnd = addDays(today, 7);
  const nights = diffDays(today, tomorrow);
  const finA = calculateReservationFinancials({
    nights,
    nightlyRate: 4500,
    discountAmount: 0,
    taxRate: 12,
  });

  const guestARes = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'Ananya', 'Verma', 'ananya.secret@guest.example', '+91 98111 22334')
     RETURNING id`,
    [propAId]
  );
  const guestAId = String(guestARes.rows[0].id);

  // Active checked-in stay on Room 101
  await pool.query(
    `INSERT INTO reservations (
       property_id, booking_reference, guest_id, room_type_id, room_id,
       arrival_date, departure_date, adults, children, num_guests,
       nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
       currency, source, status, checked_in_at, internal_notes, created_by
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::date, $7::date, 2, 0, 2,
       4500, 0, 12, $8, $9,
       'INR', 'direct', 'checked_in', NOW(), 'CONFIDENTIAL_VIP_INTERNAL_NOTE', $10
     )`,
    [
      propAId,
      `FA-RES-${suffix}1`,
      guestAId,
      rtAId,
      r101.rows[0].id,
      today,
      tomorrow,
      finA.taxAmount,
      finA.estimatedTotal,
      adminUserId,
    ]
  );

  // Pre-arrival confirmed stay on Room 103 (must NOT be eligible for QR room service)
  await pool.query(
    `INSERT INTO reservations (
       property_id, booking_reference, guest_id, room_type_id, room_id,
       arrival_date, departure_date, adults, children, num_guests,
       nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
       currency, source, status, created_by
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::date, $7::date, 2, 0, 2,
       4500, 0, 12, $8, $9,
       'INR', 'direct', 'confirmed', $10
     )`,
    [
      propAId,
      `FA-RES-${suffix}2`,
      guestAId,
      rtAId,
      r103.rows[0].id,
      futureStart,
      futureEnd,
      finA.taxAmount,
      finA.estimatedTotal,
      adminUserId,
    ]
  );

  // Checked-in stay on maintenance Room 104 (must NOT be eligible because operational_status != available)
  await pool.query(
    `INSERT INTO reservations (
       property_id, booking_reference, guest_id, room_type_id, room_id,
       arrival_date, departure_date, adults, children, num_guests,
       nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
       currency, source, status, checked_in_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::date, $7::date, 1, 0, 1,
       4500, 0, 12, $8, $9,
       'INR', 'direct', 'checked_in', NOW(), $10
     )`,
    [
      propAId,
      `FA-RES-${suffix}3`,
      guestAId,
      rtAId,
      r104.rows[0].id,
      today,
      tomorrow,
      finA.taxAmount,
      finA.estimatedTotal,
      adminUserId,
    ]
  );

  // Checked-in stay on Property B Room 201 (cross-property isolation test)
  const guestBRes = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'Rohan', 'Kapoor', 'rohan@guest.example', '+91 98222 33445')
     RETURNING id`,
    [propBId]
  );
  await pool.query(
    `INSERT INTO reservations (
       property_id, booking_reference, guest_id, room_type_id, room_id,
       arrival_date, departure_date, adults, children, num_guests,
       nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
       currency, source, status, checked_in_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::date, $7::date, 2, 0, 2,
       6200, 0, 18, 2232, 14632,
       'INR', 'direct', 'checked_in', NOW(), $8
     )`,
    [
      propBId,
      `FB-RES-${suffix}1`,
      guestBRes.rows[0].id,
      rtBRes.rows[0].id,
      r201.rows[0].id,
      today,
      tomorrow,
      adminUserId,
    ]
  );

  // Menu categories & items for Property A and Property B
  const catActiveRes = await pool.query(
    `INSERT INTO food_categories (property_id, code, name, description, display_order, is_active)
     VALUES ($1, 'BANARASI', 'Banarasi Classics', 'Freshly prepared signatures', 1, TRUE)
     RETURNING id`,
    [propAId]
  );
  const catInactiveRes = await pool.query(
    `INSERT INTO food_categories (property_id, code, name, description, display_order, is_active)
     VALUES ($1, 'WINTER_ARCH', 'Seasonal Winter Archive', 'Hidden inactive category', 2, FALSE)
     RETURNING id`,
    [propAId]
  );

  const item1Res = await pool.query(
    `INSERT INTO food_menu_items (
       property_id, category_id, sku, name, description, price, dietary_tag, prep_time_minutes, is_available, is_active
     ) VALUES ($1, $2, $3, 'Paneer Lababdar Bowl', 'Rich tomato cashew gravy with jeera rice', 350.00, 'veg', 20, TRUE, TRUE)
     RETURNING id`,
    [propAId, catActiveRes.rows[0].id, `SKU-A1-${suffix}`]
  );
  menuItemAvailableId = String(item1Res.rows[0].id);

  const item2Res = await pool.query(
    `INSERT INTO food_menu_items (
       property_id, category_id, sku, name, description, price, dietary_tag, prep_time_minutes, is_available, is_active
     ) VALUES ($1, $2, $3, 'Masala Kulhad Chai', 'Cardamom ginger brewed tea', 120.00, 'beverage', 10, TRUE, TRUE)
     RETURNING id`,
    [propAId, catActiveRes.rows[0].id, `SKU-A2-${suffix}`]
  );
  menuItemSecondId = String(item2Res.rows[0].id);

  const itemUnavailRes = await pool.query(
    `INSERT INTO food_menu_items (
       property_id, category_id, sku, name, description, price, dietary_tag, is_available, is_active
     ) VALUES ($1, $2, $3, 'Sold Out Thali', 'Unavailable today', 490.00, 'veg', FALSE, TRUE)
     RETURNING id`,
    [propAId, catActiveRes.rows[0].id, `SKU-A3-${suffix}`]
  );
  menuItemUnavailableId = String(itemUnavailRes.rows[0].id);

  const itemInactCatRes = await pool.query(
    `INSERT INTO food_menu_items (
       property_id, category_id, sku, name, description, price, dietary_tag, is_available, is_active
     ) VALUES ($1, $2, $3, 'Archived Halwa', 'In inactive category', 210.00, 'veg', TRUE, TRUE)
     RETURNING id`,
    [propAId, catInactiveRes.rows[0].id, `SKU-A4-${suffix}`]
  );
  menuItemInactiveCatId = String(itemInactCatRes.rows[0].id);

  const catBRes = await pool.query(
    `INSERT INTO food_categories (property_id, code, name, description, display_order, is_active)
     VALUES ($1, 'COASTAL', 'Coastal Grill', 'Mumbai specials', 1, TRUE)
     RETURNING id`,
    [propBId]
  );
  const itemBRes = await pool.query(
    `INSERT INTO food_menu_items (
       property_id, category_id, sku, name, description, price, dietary_tag, is_available, is_active
     ) VALUES ($1, $2, $3, 'Bombay Masala Toast', 'Grilled club sandwich', 280.00, 'veg', TRUE, TRUE)
     RETURNING id`,
    [propBId, catBRes.rows[0].id, `SKU-B1-${suffix}`]
  );
  menuItemPropBId = String(itemBRes.rows[0].id);

  // Authenticate admin and receptionist agents
  adminAgent = supertest.agent(app);
  const adminLogin = await adminAgent
    .post('/api/auth/login')
    .send({ email: adminEmail, password: initialAdminPass });
  expect(adminLogin.status).toBe(200);

  recAgent = supertest.agent(app);
  const recLogin = await recAgent
    .post('/api/auth/login')
    .send({ email: recEmail, password: initialRecPass });
  expect(recLogin.status).toBe(200);
});

beforeEach(async () => {
  await assertTestDatabaseOnly();
  resetLoginRateLimiter();
  resetPublicGuestOrderRateLimiter();
  clearTestMailOutbox();
});

afterAll(async () => {
  await closePool();
});

describe('Feature A: Guest Self-Service QR Food Ordering & PMS Fulfillment', () => {
  it('provides a common per-hotel QR code config to authorized staff and restricts toggle/regeneration to admins', async () => {
    // Unauthenticated access rejected
    const unauthRes = await supertest(app)
      .get('/api/restaurant/qr-config')
      .set('X-Property-Id', propAId);
    expect(unauthRes.status).toBe(401);

    // Receptionist with Property A access can read Property A QR config
    const recRead = await recAgent
      .get('/api/restaurant/qr-config')
      .set('X-Property-Id', propAId);
    expect(recRead.status).toBe(200);
    expect(recRead.body.config.propertyId).toBe(propAId);
    expect(recRead.body.config.qrToken).toBe(propAQrToken);
    expect(recRead.body.config.enabled).toBe(true);
    expect(recRead.body.config.qrSvg).toContain('<svg');
    expect(recRead.body.config.guestMenuPath).toBe(`/guest/menu/${propAQrToken}`);

    // Receptionist without Property B access cannot read Property B QR config
    const recCrossProp = await recAgent
      .get('/api/restaurant/qr-config')
      .set('X-Property-Id', propBId);
    expect(recCrossProp.status).toBe(403);

    // Receptionist cannot pause or rotate QR token
    const recToggle = await recAgent
      .put('/api/restaurant/qr-config')
      .set('X-Property-Id', propAId)
      .send({ enabled: false });
    expect(recToggle.status).toBe(403);

    const recRotate = await recAgent
      .post('/api/restaurant/qr-config/regenerate')
      .set('X-Property-Id', propAId);
    expect(recRotate.status).toBe(403);

    // Admin can pause QR ordering -> public guest menu returns 403 -> Admin re-enables
    const pauseRes = await adminAgent
      .put('/api/restaurant/qr-config')
      .set('X-Property-Id', propAId)
      .send({ enabled: false });
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.config.enabled).toBe(false);

    const pausedMenuRes = await supertest(app).get(
      `/api/public/guest-food/menu/${propAQrToken}`
    );
    expect(pausedMenuRes.status).toBe(403);

    const resumeRes = await adminAgent
      .put('/api/restaurant/qr-config')
      .set('X-Property-Id', propAId)
      .send({ enabled: true });
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.config.enabled).toBe(true);

    // Admin rotates QR token -> old token returns 404, new token serves menu
    const oldToken = propAQrToken;
    const rotateRes = await adminAgent
      .post('/api/restaurant/qr-config/regenerate')
      .set('X-Property-Id', propAId);
    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.config.qrToken).not.toBe(oldToken);
    propAQrToken = String(rotateRes.body.config.qrToken);

    const oldMenuRes = await supertest(app).get(
      `/api/public/guest-food/menu/${oldToken}`
    );
    expect(oldMenuRes.status).toBe(404);
  });

  it('serves strictly property-scoped active/available menu items publicly without guest login or internal data leakage', async () => {
    const res = await supertest(app).get(
      `/api/public/guest-food/menu/${propAQrToken}`
    );
    expect(res.status).toBe(200);
    expect(res.body.hotel.name).toContain('Kashi Heritage QR Hotel');
    expect(res.body.hotel.currency).toBe('INR');
    expect(res.body.hotel.taxName).toBe('GST');
    expect(res.body.hotel.defaultTaxRate).toBe(12);

    const returnedIds = res.body.items.map((i: { id: string }) => i.id);
    expect(returnedIds).toContain(menuItemAvailableId);
    expect(returnedIds).toContain(menuItemSecondId);
    expect(returnedIds).not.toContain(menuItemUnavailableId);
    expect(returnedIds).not.toContain(menuItemInactiveCatId);
    expect(returnedIds).not.toContain(menuItemPropBId);

    // Ensure SKU or internal cost metadata is not exposed on public menu items
    const rawJson = JSON.stringify(res.body);
    expect(rawJson).not.toContain('SKU-A1');
    expect(rawJson).not.toContain('ananya.secret@guest.example');
    expect(rawJson).not.toContain('CONFIDENTIAL_VIP_INTERNAL_NOTE');

    // Property B's QR token resolves strictly to Property B's menu
    const resB = await supertest(app).get(
      `/api/public/guest-food/menu/${propBQrToken}`
    );
    expect(resB.status).toBe(200);
    expect(resB.body.hotel.name).toContain('Bombay Harbour QR Hotel');
    const propBReturnedIds = resB.body.items.map((i: { id: string }) => i.id);
    expect(propBReturnedIds).toContain(menuItemPropBId);
    expect(propBReturnedIds).not.toContain(menuItemAvailableId);
  });

  it('rejects vacant, non-existent, pre-arrival, maintenance, cross-property, and price-tampered orders with non-enumerating errors', async () => {
    const validItems = [{ menuItemId: menuItemAvailableId, quantity: 1 }];

    // 1. Vacant room
    const vacantRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({ roomNumber: roomVacantNumber, items: validItems });
    expect(vacantRes.status).toBe(403);
    expect(vacantRes.body.error.code).toBe('ROOM_NOT_ELIGIBLE');

    // 2. Non-existent room
    const missingRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({ roomNumber: '9999', items: validItems });
    expect(missingRes.status).toBe(403);
    expect(missingRes.body.error.code).toBe('ROOM_NOT_ELIGIBLE');
    // Identical message prevents room/guest enumeration!
    expect(missingRes.body.error.message).toBe(vacantRes.body.error.message);

    // 3. Pre-arrival confirmed room (not checked in yet)
    const preArrivalRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({ roomNumber: roomConfirmedNumber, items: validItems });
    expect(preArrivalRes.status).toBe(403);
    expect(preArrivalRes.body.error.message).toBe(vacantRes.body.error.message);

    // 4. Maintenance room (even with checked-in row)
    const maintRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({ roomNumber: roomMaintenanceNumber, items: validItems });
    expect(maintRes.status).toBe(403);
    expect(maintRes.body.error.message).toBe(vacantRes.body.error.message);

    // 5. Cross-property checked-in room submitted to Property A's QR
    const crossPropRoomRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({ roomNumber: roomPropBCheckedInNumber, items: validItems });
    expect(crossPropRoomRes.status).toBe(403);
    expect(crossPropRoomRes.body.error.message).toBe(vacantRes.body.error.message);

    // 6. Cross-property menu item submitted on Property A's valid room
    const crossPropItemRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({
        roomNumber: roomCheckedInNumber,
        items: [{ menuItemId: menuItemPropBId, quantity: 1 }],
      });
    expect(crossPropItemRes.status).toBe(404);

    // 7. Client price tampering rejected by strict Zod schema
    const tamperedPriceRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({
        roomNumber: roomCheckedInNumber,
        items: [{ menuItemId: menuItemAvailableId, quantity: 2, unitPrice: 1 }],
        totalAmount: 2,
      });
    expect(tamperedPriceRes.status).toBe(400);
  });

  it('places a verified Guest QR order with server-authoritative totals, idempotency, restricted tracking, Dashboard & Kitchen surfacing, and folio posting', async () => {
    const idemKey = `idem-guest-${Date.now()}`;
    const createRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({
        roomNumber: `  ${roomCheckedInNumber.toLowerCase()}  `,
        items: [
          {
            menuItemId: menuItemAvailableId, // 2 x 350 = 700
            quantity: 2,
            specialInstructions: 'Less spicy please',
          },
          {
            menuItemId: menuItemSecondId, // 1 x 120 = 120
            quantity: 1,
          },
        ],
        notes: 'Please knock gently',
        idempotencyKey: idemKey,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.trackingToken).toMatch(/^[a-f0-9]{64}$/);
    let trackingToken = String(createRes.body.trackingToken);
    const orderRef = String(createRes.body.order.orderReference);

    // Verify server-authoritative pricing: 700 + 120 = 820 subtotal; 12% GST = 98.40; total = 918.40
    expect(createRes.body.order.subtotal).toBe(820);
    expect(createRes.body.order.taxAmount).toBe(98.4);
    expect(createRes.body.order.totalAmount).toBe(918.4);
    expect(createRes.body.order.status).toBe('pending');
    expect(createRes.body.order.roomNumber).toBe(roomCheckedInNumber);

    // Public response must NEVER expose guest PII, reservation IDs, or internal notes
    const publicJson = JSON.stringify(createRes.body);
    expect(publicJson).not.toContain('Ananya');
    expect(publicJson).not.toContain('Verma');
    expect(publicJson).not.toContain('ananya.secret@guest.example');
    expect(publicJson).not.toContain('CONFIDENTIAL_VIP_INTERNAL_NOTE');
    expect(publicJson).not.toContain('reservationId');

    // Replaying identical idempotencyKey + payload returns 200 with the exact same order (no duplicate)
    const replayRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({
        roomNumber: roomCheckedInNumber,
        items: [
          {
            menuItemId: menuItemAvailableId,
            quantity: 2,
            specialInstructions: 'Less spicy please',
          },
          {
            menuItemId: menuItemSecondId,
            quantity: 1,
          },
        ],
        notes: 'Please knock gently',
        idempotencyKey: idemKey,
      });
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.order.orderReference).toBe(orderRef);
    trackingToken = String(replayRes.body.trackingToken);

    // Reusing same idempotencyKey with a DIFFERENT cart payload is rejected with 409 Conflict
    const conflictReplayRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({
        roomNumber: roomCheckedInNumber,
        items: [{ menuItemId: menuItemAvailableId, quantity: 1 }],
        idempotencyKey: idemKey,
      });
    expect(conflictReplayRes.status).toBe(409);

    // Verify raw tracking token is NEVER stored in PostgreSQL (only SHA-256 hash)
    const pool = getPool();
    const dbRowRes = await pool.query(
      `SELECT id, order_source, order_type, billing_status, guest_tracking_token_hash
       FROM food_orders
       WHERE order_reference = $1 AND property_id = $2`,
      [orderRef, propAId]
    );
    expect(dbRowRes.rowCount).toBe(1);
    const orderId = String(dbRowRes.rows[0].id);
    expect(dbRowRes.rows[0].order_source).toBe('guest_qr');
    expect(dbRowRes.rows[0].order_type).toBe('room_service');
    expect(dbRowRes.rows[0].billing_status).toBe('unbilled');
    expect(dbRowRes.rows[0].guest_tracking_token_hash).toBe(
      hashSessionToken(trackingToken)
    );
    expect(dbRowRes.rows[0].guest_tracking_token_hash).not.toBe(trackingToken);

    // Verify main PMS Dashboard surfaces active Guest QR order & summary counts + alert
    const dashRes = await recAgent
      .get('/api/dashboard')
      .set('X-Property-Id', propAId);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.foodOrdersSummary.activeGuestQrCount).toBeGreaterThanOrEqual(1);
    expect(dashRes.body.foodOrdersSummary.pendingCount).toBeGreaterThanOrEqual(1);
    const dashOrder = dashRes.body.activeFoodOrders.find(
      (o: { orderReference: string }) => o.orderReference === orderRef
    );
    expect(dashOrder).toBeDefined();
    expect(dashOrder.orderSource).toBe('guest_qr');
    expect(
      dashRes.body.notifications.some(
        (n: { id: string }) => n.id === 'active-food-orders'
      )
    ).toBe(true);

    // Verify Restaurant Orders list supports orderSource=guest_qr filter
    const listQrRes = await recAgent
      .get('/api/restaurant/orders?orderSource=guest_qr')
      .set('X-Property-Id', propAId);
    expect(listQrRes.status).toBe(200);
    expect(
      listQrRes.body.items.some(
        (o: { orderReference: string }) => o.orderReference === orderRef
      )
    ).toBe(true);

    // Receptionist advances status: pending -> preparing -> ready -> served
    for (const nextStatus of ['preparing', 'ready', 'served'] as const) {
      const advRes = await recAgent
        .post(`/api/restaurant/orders/${orderId}/status`)
        .set('X-Property-Id', propAId)
        .send({ status: nextStatus });
      expect(advRes.status).toBe(200);
      expect(advRes.body.order.status).toBe(nextStatus);

      // Guest single-order tracking immediately reflects live status without PII
      const trackRes = await supertest(app).get(
        `/api/public/guest-food/orders/${trackingToken}`
      );
      expect(trackRes.status).toBe(200);
      expect(trackRes.body.order.status).toBe(nextStatus);
      expect(JSON.stringify(trackRes.body)).not.toContain('Ananya');
    }

    // Receptionist posts Guest QR order to room folio using existing billing workflow
    const folioRes = await recAgent
      .post(`/api/restaurant/orders/${orderId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({ createDraftInvoiceIfMissing: true });
    expect(folioRes.status).toBe(200);
    expect(folioRes.body.order.billingStatus).toBe('posted');
    expect(folioRes.body.invoice.id).toBeTruthy();

    // Expiring the tracking token blocks public lookup with 404
    await pool.query(
      `UPDATE food_orders
       SET guest_tracking_expires_at = NOW() - INTERVAL '1 minute'
       WHERE id = $1`,
      [orderId]
    );
    const expiredTrackRes = await supertest(app).get(
      `/api/public/guest-food/orders/${trackingToken}`
    );
    expect(expiredTrackRes.status).toBe(404);
  });

  it('rate-limits repeated invalid room verification attempts on public order endpoint', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await supertest(app)
        .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
        .send({
          roomNumber: `INVALID-${i}`,
          items: [{ menuItemId: menuItemAvailableId, quantity: 1 }],
        });
      expect(res.status).toBe(403);
    }

    const blockedRes = await supertest(app)
      .post(`/api/public/guest-food/menu/${propAQrToken}/orders`)
      .send({
        roomNumber: roomCheckedInNumber,
        items: [{ menuItemId: menuItemAvailableId, quantity: 1 }],
      });
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.headers['retry-after']).toBeDefined();
  });
});

describe('Feature B: Self-Service Account Management, Admin User Controls & Password Recovery', () => {
  it('allows Receptionists and Admins to update their own email and password securely while preserving RBAC and rotating other sessions', async () => {
    // Open a second session for Receptionist to verify session rotation on other devices
    const recDevice2 = supertest.agent(app);
    const login2 = await recDevice2
      .post('/api/auth/login')
      .send({ email: recEmail, password: initialRecPass });
    expect(login2.status).toBe(200);

    // Wrong current password rejected with 401 INVALID_CURRENT_PASSWORD without revoking session
    const wrongPassEmailRes = await recAgent
      .put('/api/auth/account/email')
      .send({
        newEmail: `updated.${recEmail}`,
        currentPassword: 'WrongPassword#999',
      });
    expect(wrongPassEmailRes.status).toBe(401);
    expect(wrongPassEmailRes.body.error.code).toBe('INVALID_CURRENT_PASSWORD');

    // Duplicate email (admin's email, uppercase) rejected with 409
    const dupEmailRes = await recAgent.put('/api/auth/account/email').send({
      newEmail: adminEmail.toUpperCase(),
      currentPassword: initialRecPass,
    });
    expect(dupEmailRes.status).toBe(409);

    // Valid self-service email update succeeds
    const newRecEmail = `self.${recEmail}`;
    const emailUpdRes = await recAgent.put('/api/auth/account/email').send({
      newEmail: newRecEmail,
      currentPassword: initialRecPass,
    });
    expect(emailUpdRes.status).toBe(200);
    expect(emailUpdRes.body.user.email).toBe(newRecEmail);
    recEmail = newRecEmail;

    // Active device 1 stays authenticated; device 2 session was revoked!
    const meDevice1 = await recAgent.get('/api/auth/me');
    expect(meDevice1.status).toBe(200);
    expect(meDevice1.body.user.email).toBe(newRecEmail);

    const meDevice2 = await recDevice2.get('/api/auth/me');
    expect(meDevice2.status).toBe(401);

    // Receptionist still CANNOT modify property settings or admin user management (RBAC intact!)
    const forbiddenPropRes = await recAgent
      .put('/api/properties/current')
      .set('X-Property-Id', propAId)
      .send({ name: 'Unauthorized Rename' });
    expect(forbiddenPropRes.status).toBe(403);

    const forbiddenUsersRes = await recAgent
      .get('/api/users')
      .set('X-Property-Id', propAId);
    expect(forbiddenUsersRes.status).toBe(403);

    // Self-service password change
    const newRecPassword = 'NewRecSecurePass#2026!';
    const pwChangeRes = await recAgent.put('/api/auth/account/password').send({
      currentPassword: initialRecPass,
      newPassword: newRecPassword,
    });
    expect(pwChangeRes.status).toBe(200);

    // Old password rejected; new password + new email succeeds
    const oldLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: recEmail, password: initialRecPass });
    expect(oldLogin.status).toBe(401);

    const freshLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: recEmail, password: newRecPassword });
    expect(freshLogin.status).toBe(200);
  });

  it('allows Admins to update Receptionist emails (blocking peer-admin email edits) and initiate single-use password reset links', async () => {
    // Admin updates Receptionist's email via /api/users/:id
    const adminAssignedRecEmail = `desk.${recEmail}`;
    const updRes = await adminAgent
      .put(`/api/users/${recUserId}`)
      .set('X-Property-Id', propAId)
      .send({ email: adminAssignedRecEmail });
    expect(updRes.status).toBe(200);
    expect(updRes.body.user.email).toBe(adminAssignedRecEmail);
    recEmail = adminAssignedRecEmail;

    // Receptionist's previous session was revoked upon admin email change
    const revokedRecCheck = await recAgent.get('/api/auth/me');
    expect(revokedRecCheck.status).toBe(401);

    // Admin CANNOT overwrite another peer Administrator's email via /api/users/:id
    const peerEditRes = await adminAgent
      .put(`/api/users/${peerAdminUserId}`)
      .set('X-Property-Id', propAId)
      .send({ email: `hijack.${peerAdminEmail}` });
    expect(peerEditRes.status).toBe(403);

    // Admin initiates a single-use password reset link for Receptionist
    const initLinkRes = await adminAgent
      .post(`/api/users/${recUserId}/send-reset-link`)
      .set('X-Property-Id', propAId);
    expect(initLinkRes.status).toBe(200);
    expect(initLinkRes.body.success).toBe(true);
    expect(initLinkRes.body.deliveryMode).toBe('manual_link_fallback');
    expect(initLinkRes.body.resetUrl).toContain('/reset-password?token=');

    const urlObj = new URL(String(initLinkRes.body.resetUrl));
    const rawAdminIssuedToken = String(urlObj.searchParams.get('token') ?? '');
    expect(rawAdminIssuedToken).toMatch(/^[a-f0-9]{64}$/);

    // Verify raw token is NOT stored in password_reset_tokens (only SHA-256 hash)
    const pool = getPool();
    const tokenRows = await pool.query(
      `SELECT token_hash, used_at, invalidated_at
       FROM password_reset_tokens
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [recUserId]
    );
    expect(tokenRows.rowCount).toBe(1);
    expect(tokenRows.rows[0].token_hash).toBe(
      hashPasswordResetToken(rawAdminIssuedToken)
    );
    expect(tokenRows.rows[0].token_hash).not.toBe(rawAdminIssuedToken);

    // Verify token via GET /api/auth/reset-password/verify
    const verifyRes = await supertest(app).get(
      `/api/auth/reset-password/verify?token=${rawAdminIssuedToken}`
    );
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(true);
  });

  it('executes non-enumerating forgot-password flow, enforces single-use & expiry on reset tokens, and revokes all user sessions on completion', async () => {
    // Public forgot-password for unknown email returns identical 200 shape with NO token leak
    const unknownRes = await supertest(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody.unknown@staycraft.local' });
    expect(unknownRes.status).toBe(200);
    expect(unknownRes.body.success).toBe(true);
    expect(JSON.stringify(unknownRes.body)).not.toContain('token');
    expect(getTestMailOutbox()).toHaveLength(0);

    // Public forgot-password for active receptionist returns identical 200 shape & dispatches outbox email
    const knownRes = await supertest(app)
      .post('/api/auth/forgot-password')
      .send({ email: recEmail });
    expect(knownRes.status).toBe(200);
    expect(knownRes.body).toEqual(unknownRes.body);

    const outbox = getTestMailOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe(recEmail);

    const match = outbox[0].textBody.match(/token=([a-f0-9]{64})/);
    expect(match).not.toBeNull();
    const firstToken = match![1];

    // Requesting a SECOND reset link invalidates the first unused token!
    clearTestMailOutbox();
    const secondReq = await supertest(app)
      .post('/api/auth/forgot-password')
      .send({ email: recEmail });
    expect(secondReq.status).toBe(200);
    const secondToken = getTestMailOutbox()[0].textBody.match(
      /token=([a-f0-9]{64})/
    )![1];
    expect(secondToken).not.toBe(firstToken);

    const supersededVerify = await supertest(app).get(
      `/api/auth/reset-password/verify?token=${firstToken}`
    );
    expect(supersededVerify.status).toBe(400);

    // Consume the fresh secondToken to set a new password
    const recoveredPassword = 'RecoveredRec#2026!Safe';
    const completeRes = await supertest(app)
      .post('/api/auth/reset-password')
      .send({
        token: secondToken,
        newPassword: recoveredPassword,
      });
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.success).toBe(true);

    // Reusing the consumed token immediately fails with 400 (single-use enforcement)
    const reuseRes = await supertest(app)
      .post('/api/auth/reset-password')
      .send({
        token: secondToken,
        newPassword: 'AnotherAttempt#2026!',
      });
    expect(reuseRes.status).toBe(400);

    // Receptionist signs in cleanly with recovered password
    const loginRecovered = await recAgent
      .post('/api/auth/login')
      .send({ email: recEmail, password: recoveredPassword });
    expect(loginRecovered.status).toBe(200);
    expect(loginRecovered.body.user.email).toBe(recEmail);
  });

  it('separates local_dev, preview sandbox, and production PUBLIC_APP_URL cleanly, never encodes sandbox URLs or tokens, and fails closed on invalid PUBLIC_APP_URL', async () => {
    await assertTestDatabaseOnly();
    const originalPublicAppUrl = process.env.PUBLIC_APP_URL;

    try {
      delete process.env.PUBLIC_APP_URL;

      // 1. Local development / test on loopback uses local_dev URL and NEVER falls back to *.e2b.app
      const localRes = await adminAgent.get('/api/restaurant/qr-config');
      expect(localRes.status).toBe(200);
      expect(localRes.body.config.urlMode).toBe('local_dev');
      expect(localRes.body.config.qrReady).toBe(true);
      expect(localRes.body.config.guestMenuUrl).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/guest\/menu\/[a-f0-9]+$/
      );
      expect(localRes.body.config.guestMenuUrl).not.toContain('.e2b.app');
      expect(localRes.body.config.qrSvg).toContain('<svg');

      // 2. Sandbox preview request (X-Forwarded-Host: *.e2b.app without PUBLIC_APP_URL) withholds QR SVG/URL
      //    rather than generating an inaccessible token-gated sandbox QR code
      const sandboxHeaderRes = await adminAgent
        .get('/api/restaurant/qr-config')
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-Host', '3000-previewtest.e2b.app');
      expect(sandboxHeaderRes.status).toBe(200);
      expect(sandboxHeaderRes.body.config.urlMode).toBe('preview_unconfigured');
      expect(sandboxHeaderRes.body.config.qrReady).toBe(false);
      expect(sandboxHeaderRes.body.config.guestMenuUrl).toBeNull();
      expect(sandboxHeaderRes.body.config.qrSvg).toBeNull();
      expect(sandboxHeaderRes.body.config.configurationNotice).toContain(
        'PUBLIC_APP_URL'
      );

      // Same when Origin is a sandbox preview host behind a loopback proxy
      const sandboxOriginRes = await adminAgent
        .get('/api/restaurant/qr-config')
        .set('Origin', 'https://3000-previeworigin.e2b.app');
      expect(sandboxOriginRes.status).toBe(200);
      expect(sandboxOriginRes.body.config.urlMode).toBe('preview_unconfigured');
      expect(sandboxOriginRes.body.config.qrReady).toBe(false);
      expect(sandboxOriginRes.body.config.guestMenuUrl).toBeNull();
      expect(sandboxOriginRes.body.config.qrSvg).toBeNull();

      // 3. Production runtime without PUBLIC_APP_URL NEVER silently falls back to sandbox or internal host
      const fakeProdReq = {
        headers: { host: 'internal-app:3000' },
        secure: false,
      } as unknown as Request;
      const unconfiguredProdCtx = resolveGuestQrUrlContext(fakeProdReq, {
        NODE_ENV: 'production',
        E2B_SANDBOX_ID: 'sneaky-sandbox-id',
      });
      expect(unconfiguredProdCtx.urlMode).toBe('production_unconfigured');
      expect(unconfiguredProdCtx.qrReady).toBe(false);
      expect(unconfiguredProdCtx.baseUrl).toBeNull();

      expect(() =>
        resolveSafeAppBaseUrl(fakeProdReq, {
          NODE_ENV: 'production',
          E2B_SANDBOX_ID: 'sneaky-sandbox-id',
        })
      ).toThrow(/PUBLIC_APP_URL/);

      // 4. Configured production PUBLIC_APP_URL generates verified HTTPS production QR and ignores header spoofing
      process.env.PUBLIC_APP_URL = 'https://dining.staycraft-hotel.example/';
      const prodRes = await adminAgent
        .get('/api/restaurant/qr-config')
        .set('X-Forwarded-Host', '3000-sandbox.e2b.app')
        .set('Origin', 'https://3000-sandbox.e2b.app');
      expect(prodRes.status).toBe(200);
      expect(prodRes.body.config.urlMode).toBe('production');
      expect(prodRes.body.config.qrReady).toBe(true);
      expect(prodRes.body.config.guestMenuUrl).toBe(
        `https://dining.staycraft-hotel.example/guest/menu/${prodRes.body.config.qrToken}`
      );
      const expectedProdSvg = await QRCode.toString(
        prodRes.body.config.guestMenuUrl,
        {
          type: 'svg',
          margin: 2,
          width: 280,
          errorCorrectionLevel: 'M',
          color: { dark: '#0f172a', light: '#ffffff' },
        }
      );
      expect(prodRes.body.config.qrSvg).toBe(expectedProdSvg);

      // Guest order POST with Origin matching PUBLIC_APP_URL passes CSRF/Origin check even behind proxy
      const prodOriginOrderRes = await supertest(app)
        .post(`/api/public/guest-food/menu/${prodRes.body.config.qrToken}/orders`)
        .set('Origin', 'https://dining.staycraft-hotel.example')
        .send({
          roomNumber: roomCheckedInNumber,
          items: [{ menuItemId: menuItemAvailableId, quantity: 1 }],
        });
      expect(prodOriginOrderRes.status).toBe(201);

      // 5. Invalid PUBLIC_APP_URL values fail closed (503 PUBLIC_APP_URL_INVALID) — never falling back to sandbox
      const invalidCandidates = [
        'https://3000-i18k780zx750y6tc0o55e.e2b.app',
        'https://preview.arena.ai',
        'https://dining.staycraft-hotel.example?e2b-traffic-access-token=secret123',
        'http://dining.staycraft-hotel.example',
        'https://localhost:3000',
        'https://127.0.0.1:3000',
        'https://192.168.1.50',
        'https://dining.staycraft-hotel.example/subpath',
        'not-a-valid-url',
      ];

      for (const badUrl of invalidCandidates) {
        process.env.PUBLIC_APP_URL = badUrl;
        const badRes = await adminAgent
          .get('/api/restaurant/qr-config')
          .set('X-Forwarded-Host', '3000-sandbox.e2b.app');
        expect(badRes.status).toBe(503);
        expect(badRes.body.error?.code).toBe('PUBLIC_APP_URL_INVALID');
        expect(JSON.stringify(badRes.body)).not.toContain('secret123');
      }
    } finally {
      if (originalPublicAppUrl === undefined) {
        delete process.env.PUBLIC_APP_URL;
      } else {
        process.env.PUBLIC_APP_URL = originalPublicAppUrl;
      }
    }
  });
});
