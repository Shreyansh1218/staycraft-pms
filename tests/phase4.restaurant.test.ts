import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, getPropertyLocalDate } from '../src/shared/dates.js';
import { calculateFoodOrderTotals } from '../src/shared/pricing.js';
import { createApiApp } from '../src/server/app.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { closePool, getPool } from '../src/server/db/pool.js';
import { hashPassword } from '../src/server/security/password.js';

const app = createApiApp();

let adminAgent: ReturnType<typeof request.agent>;
let receptionistAgent: ReturnType<typeof request.agent>;
let propBOnlyAgent: ReturnType<typeof request.agent>;

let adminUserId = '';
let receptionistUserId = '';
let propBOnlyUserId = '';

let propAId = '';
let propAToday = '';
let propBId = '';

let dlxTypeId = '';
let room101Id = '';
let room102Id = '';
let room103Id = '';
let propBRoomId = '';

let guestAId = '';
let guestBId = '';

beforeAll(async () => {
  const pool = getPool();

  // Hard safeguard: verify test DB is strictly isolated from production staycraft_pms before any mutation
  const dbCheck = await pool.query('SELECT current_database() AS db_name');
  const connectedDb = String(dbCheck.rows[0]?.db_name ?? '');
  if (connectedDb !== 'staycraft_pms_test') {
    throw new Error(
      `ABORTING TEST SUITE: Expected isolated staycraft_pms_test database, got "${connectedDb}"`
    );
  }

  await runMigrations();

  await pool.query(`
    TRUNCATE TABLE
      food_order_status_history,
      food_order_items,
      food_orders,
      property_food_order_counters,
      food_menu_items,
      food_categories,
      reservation_service_charges,
      payments,
      invoice_line_items,
      invoices,
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
     VALUES ('admin@phase4.test', $1, 'Vikram DiningAdmin', 'admin') RETURNING id`,
    [adminHash]
  );
  const uRec = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('frontdesk@phase4.test', $1, 'Neha POSDesk', 'receptionist') RETURNING id`,
    [recHash]
  );
  const uPropB = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('propb@phase4.test', $1, 'Rohan PropBDesk', 'receptionist') RETURNING id`,
    [recHash]
  );

  adminUserId = uAdmin.rows[0].id;
  receptionistUserId = uRec.rows[0].id;
  propBOnlyUserId = uPropB.rows[0].id;

  // Property A: 12% GST
  const pA = await pool.query(
    `INSERT INTO properties (code, name, email, phone, address_line1, city, state_region, country, currency, timezone, default_tax_rate, tax_name)
     VALUES ('P4A', 'StayCraft Varanasi Dining Wing', 'dining@p4a.test', '+91 542 240 1100', 'Dashashwamedh Rd', 'Varanasi', 'Uttar Pradesh', 'India', 'INR', 'Asia/Kolkata', 12.00, 'GST')
     RETURNING id`
  );
  // Property B: 18% GST
  const pB = await pool.query(
    `INSERT INTO properties (code, name, email, phone, address_line1, city, state_region, country, currency, timezone, default_tax_rate, tax_name)
     VALUES ('P4B', 'StayCraft Goa Coastal Bistro', 'bistro@p4b.test', '+91 832 240 2200', 'Miramar Beach Rd', 'Panaji', 'Goa', 'India', 'INR', 'Asia/Kolkata', 18.00, 'Luxury GST')
     RETURNING id`
  );

  propAId = pA.rows[0].id;
  propBId = pB.rows[0].id;
  propAToday = getPropertyLocalDate('Asia/Kolkata');

  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id, is_default) VALUES
      ($1, $2, true),
      ($1, $3, false),
      ($4, $2, true),
      ($5, $3, true)`,
    [adminUserId, propAId, propBId, receptionistUserId, propBOnlyUserId]
  );

  const rtDlx = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'DLX', 'Deluxe King', 2, 3, 4000.00) RETURNING id`,
    [propAId]
  );
  const rtB = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'BSTD', 'Coastal Room', 2, 2, 5000.00) RETURNING id`,
    [propBId]
  );

  dlxTypeId = rtDlx.rows[0].id;
  const propBTypeId = rtB.rows[0].id;

  const r101 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
     VALUES ($1, $2, '101', '1', 'clean', 'available') RETURNING id`,
    [propAId, dlxTypeId]
  );
  const r102 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
     VALUES ($1, $2, '102', '1', 'clean', 'available') RETURNING id`,
    [propAId, dlxTypeId]
  );
  const r103 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
     VALUES ($1, $2, '103', '1', 'clean', 'available') RETURNING id`,
    [propAId, dlxTypeId]
  );
  const rB = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
     VALUES ($1, $2, '301', '3', 'clean', 'available') RETURNING id`,
    [propBId, propBTypeId]
  );

  room101Id = r101.rows[0].id;
  room102Id = r102.rows[0].id;
  room103Id = r103.rows[0].id;
  propBRoomId = rB.rows[0].id;

  const gA = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'Aditi', 'Kulkarni', 'aditi@example.com', '+919811122233') RETURNING id`,
    [propAId]
  );
  const gB = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'Kabir', 'Menon', 'kabir@example.com', '+919844455566') RETURNING id`,
    [propBId]
  );

  guestAId = gA.rows[0].id;
  guestBId = gB.rows[0].id;

  adminAgent = request.agent(app);
  receptionistAgent = request.agent(app);
  propBOnlyAgent = request.agent(app);

  const loginAdmin = await adminAgent
    .post('/api/auth/login')
    .send({ email: 'admin@phase4.test', password: 'Admin@12345' });
  expect(loginAdmin.status).toBe(200);

  const loginRec = await receptionistAgent
    .post('/api/auth/login')
    .send({ email: 'frontdesk@phase4.test', password: 'FrontDesk@123' });
  expect(loginRec.status).toBe(200);

  const loginPropB = await propBOnlyAgent
    .post('/api/auth/login')
    .send({ email: 'propb@phase4.test', password: 'FrontDesk@123' });
  expect(loginPropB.status).toBe(200);
});

afterAll(async () => {
  await closePool();
});

describe('Phase 4: Food Ordering & Restaurant Management', () => {
  let mainsCatId = '';
  let bevCatId = '';
  let propBCatId = '';

  let paneerItemId = '';
  let chaiItemId = '';
  let seasonalItemId = '';
  let propBItemId = '';

  it('1. enforces authentication, property context, and Admin RBAC on Menu CRUD', async () => {
    // Unauthenticated API access -> 401 AUTH_TOKEN_MISSING (distinct from INVALID_CREDENTIALS)
    const unauth = await request(app)
      .get('/api/restaurant/categories')
      .set('X-Property-Id', propAId);
    expect(unauth.status).toBe(401);
    expect(unauth.body.error.code).toBe('AUTH_TOKEN_MISSING');
    expect(unauth.body.error.code).not.toBe('INVALID_CREDENTIALS');

    // Receptionist cannot create categories or menu items (403)
    const recCreateCat = await receptionistAgent
      .post('/api/restaurant/categories')
      .set('X-Property-Id', propAId)
      .send({ code: 'MAINS', name: 'North Indian Mains', displayOrder: 1 });
    expect(recCreateCat.status).toBe(403);

    // Admin creates categories on Property A
    const cMains = await adminAgent
      .post('/api/restaurant/categories')
      .set('X-Property-Id', propAId)
      .send({
        code: 'mains',
        name: 'North Indian Mains',
        description: 'Signature curries and breads',
        displayOrder: 1,
      });
    expect(cMains.status).toBe(201);
    expect(cMains.body.category.code).toBe('MAINS');
    mainsCatId = cMains.body.category.id;

    const cBev = await adminAgent
      .post('/api/restaurant/categories')
      .set('X-Property-Id', propAId)
      .send({
        code: 'BEV',
        name: 'Hot Beverages',
        displayOrder: 2,
      });
    expect(cBev.status).toBe(201);
    bevCatId = cBev.body.category.id;

    // Duplicate category code in same property -> 409
    const dupCat = await adminAgent
      .post('/api/restaurant/categories')
      .set('X-Property-Id', propAId)
      .send({ code: 'MAINS', name: 'Another Mains', displayOrder: 3 });
    expect(dupCat.status).toBe(409);

    // Same category code in Property B is allowed (property-scoped uniqueness)
    const cPropB = await adminAgent
      .post('/api/restaurant/categories')
      .set('X-Property-Id', propBId)
      .send({ code: 'MAINS', name: 'Coastal Seafood Mains', displayOrder: 1 });
    expect(cPropB.status).toBe(201);
    propBCatId = cPropB.body.category.id;
  });

  it('2. validates menu prices, stores exact NUMERIC money, and supports edit/deactivate', async () => {
    // Reject zero or negative prices (400)
    const zeroPrice = await adminAgent
      .post('/api/restaurant/menu-items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: mainsCatId,
        sku: 'BAD-00',
        name: 'Zero Dish',
        price: 0,
      });
    expect(zeroPrice.status).toBe(400);

    const negPrice = await adminAgent
      .post('/api/restaurant/menu-items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: mainsCatId,
        sku: 'BAD-NEG',
        name: 'Negative Dish',
        price: -120,
      });
    expect(negPrice.status).toBe(400);

    // Reject cross-property category linkage
    const crossPropItem = await adminAgent
      .post('/api/restaurant/menu-items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: propBCatId,
        sku: 'CROSS-01',
        name: 'Cross Property Dish',
        price: 250,
      });
    expect(crossPropItem.status).toBe(400);

    // Create valid menu items with exact decimal pricing
    const mPaneer = await adminAgent
      .post('/api/restaurant/menu-items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: mainsCatId,
        sku: 'mn-pnr-01',
        name: 'Paneer Lababdar',
        description: 'Spiced cottage cheese curry',
        price: 425.5,
        dietaryTag: 'veg',
        prepTimeMinutes: 18,
      });
    expect(mPaneer.status).toBe(201);
    expect(mPaneer.body.menuItem.sku).toBe('MN-PNR-01');
    expect(mPaneer.body.menuItem.price).toBe(425.5);
    paneerItemId = mPaneer.body.menuItem.id;

    const mChai = await adminAgent
      .post('/api/restaurant/menu-items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: bevCatId,
        sku: 'BV-CHAI-01',
        name: 'Banarasi Masala Chai',
        price: 95.25,
        dietaryTag: 'beverage',
        prepTimeMinutes: 8,
      });
    expect(mChai.status).toBe(201);
    chaiItemId = mChai.body.menuItem.id;

    const mSeasonal = await adminAgent
      .post('/api/restaurant/menu-items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: bevCatId,
        sku: 'BV-MAL-01',
        name: 'Winter Malaiyyo',
        price: 150,
        dietaryTag: 'veg',
        isAvailable: true,
        isActive: true,
      });
    expect(mSeasonal.status).toBe(201);
    seasonalItemId = mSeasonal.body.menuItem.id;

    // Deactivate seasonal item & verify Receptionist cannot edit it
    const recEdit = await receptionistAgent
      .put(`/api/restaurant/menu-items/${seasonalItemId}`)
      .set('X-Property-Id', propAId)
      .send({ isActive: false });
    expect(recEdit.status).toBe(403);

    const adminDeactivate = await adminAgent
      .put(`/api/restaurant/menu-items/${seasonalItemId}`)
      .set('X-Property-Id', propAId)
      .send({ isActive: false });
    expect(adminDeactivate.status).toBe(200);
    expect(adminDeactivate.body.menuItem.isActive).toBe(false);

    // Create Property B menu item
    const mPropB = await adminAgent
      .post('/api/restaurant/menu-items')
      .set('X-Property-Id', propBId)
      .send({
        categoryId: propBCatId,
        sku: 'GOA-CURRY-01',
        name: 'Goan Prawn Curry',
        price: 680,
        dietaryTag: 'non_veg',
      });
    expect(mPropB.status).toBe(201);
    propBItemId = mPropB.body.menuItem.id;
  });

  it('3. creates Restaurant & Takeaway orders, calculates property taxes, and preserves historical item name & price snapshots', async () => {
    // Ordering inactive item -> rejected (400/409)
    const badInactive = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'restaurant',
        tableLabel: 'Table 2',
        items: [{ menuItemId: seasonalItemId, quantity: 1 }],
      });
    expect([400, 409]).toContain(badInactive.status);

    // Place valid Restaurant Dine-In order (2x 425.50 + 3x 95.25 = 851.00 + 285.75 = 1136.75; 12% GST = 136.41; Total = 1273.16)
    const expectedMath = calculateFoodOrderTotals(
      [
        { quantity: 2, unitPrice: 425.5 },
        { quantity: 3, unitPrice: 95.25 },
      ],
      12
    );
    expect(expectedMath.subtotal).toBe(1136.75);
    expect(expectedMath.taxAmount).toBe(136.41);
    expect(expectedMath.totalAmount).toBe(1273.16);

    const dineInRes = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'restaurant',
        tableLabel: 'Table 5',
        customerName: 'Sharma Family',
        notes: 'Serve starters and chai together',
        items: [
          {
            menuItemId: paneerItemId,
            quantity: 2,
            specialInstructions: 'Medium spice, extra ginger',
          },
          {
            menuItemId: chaiItemId,
            quantity: 3,
            specialInstructions: 'Less sugar',
          },
        ],
        idempotencyKey: 'idem-dinein-001',
      });
    expect(dineInRes.status).toBe(201);
    const dineInOrder = dineInRes.body.order;
    expect(dineInOrder.orderReference).toBe('P4A-FD-1001');
    expect(dineInOrder.status).toBe('pending');
    expect(dineInOrder.billingStatus).toBe('not_applicable');
    expect(dineInOrder.subtotal).toBe(1136.75);
    expect(dineInOrder.taxRate).toBe(12);
    expect(dineInOrder.taxName).toBe('GST');
    expect(dineInOrder.taxAmount).toBe(136.41);
    expect(dineInOrder.totalAmount).toBe(1273.16);

    // Place Takeaway order (no tableLabel required)
    const takeawayRes = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'takeaway',
        customerName: 'Raghav Parcel',
        items: [{ menuItemId: chaiItemId, quantity: 2 }],
      });
    expect(takeawayRes.status).toBe(201);
    expect(takeawayRes.body.order.orderReference).toBe('P4A-FD-1002');
    expect(takeawayRes.body.order.orderType).toBe('takeaway');

    // Now Admin updates Paneer Lababdar name & price (425.50 -> 520.00)!
    const updateMenu = await adminAgent
      .put(`/api/restaurant/menu-items/${paneerItemId}`)
      .set('X-Property-Id', propAId)
      .send({
        name: 'Royal Paneer Lababdar',
        price: 520.0,
      });
    expect(updateMenu.status).toBe(200);

    // Verify historical order P4A-FD-1001 STILL retains snapshotted name "Paneer Lababdar" and unitPrice 425.50!
    const refetchOld = await receptionistAgent
      .get(`/api/restaurant/orders/${dineInOrder.id}`)
      .set('X-Property-Id', propAId);
    expect(refetchOld.status).toBe(200);
    const paneerLine = refetchOld.body.order.items.find(
      (i: { menuItemId: string }) => i.menuItemId === paneerItemId
    );
    expect(paneerLine.itemNameSnapshot).toBe('Paneer Lababdar');
    expect(paneerLine.unitPrice).toBe(425.5);
    expect(refetchOld.body.order.totalAmount).toBe(1273.16);
  });

  it('4. prevents duplicate orders under concurrent retries and generates unique sequential order references', async () => {
    // 5 concurrent retries with the same idempotencyKey -> must create ONLY 1 order
    const idemPayload = {
      orderType: 'takeaway',
      customerName: 'Idempotent Retry Guest',
      items: [{ menuItemId: paneerItemId, quantity: 1 }],
      idempotencyKey: 'concurrent-idem-key-999',
    };

    const retryResponses = await Promise.all(
      Array.from({ length: 5 }, () =>
        receptionistAgent
          .post('/api/restaurant/orders')
          .set('X-Property-Id', propAId)
          .send(idemPayload)
      )
    );

    for (const r of retryResponses) {
      expect([200, 201]).toContain(r.status);
    }
    const uniqueOrderIds = new Set(retryResponses.map((r) => r.body.order.id));
    expect(uniqueOrderIds.size).toBe(1);

    // 4 concurrent distinct orders -> must receive 4 distinct sequential orderReferences with 0 collisions
    const distinctResponses = await Promise.all(
      Array.from({ length: 4 }, (_, idx) =>
        receptionistAgent
          .post('/api/restaurant/orders')
          .set('X-Property-Id', propAId)
          .send({
            orderType: 'restaurant',
            tableLabel: ` Patio-${idx + 1} `,
            items: [{ menuItemId: chaiItemId, quantity: 1 }],
          })
      )
    );

    for (const r of distinctResponses) {
      expect(r.status).toBe(201);
    }
    const refs = distinctResponses.map((r) => r.body.order.orderReference);
    expect(new Set(refs).size).toBe(4);
  });

  it('5. enforces Kitchen Workflow state transitions, timestamps, attribution, and cancellation restrictions', async () => {
    const created = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'restaurant',
        tableLabel: 'Table 9',
        notes: 'Initial note',
        items: [{ menuItemId: paneerItemId, quantity: 1 }],
      });
    expect(created.status).toBe(201);
    const orderId = created.body.order.id;

    // Invalid jump: pending -> ready (must go through preparing first)
    const invalidJump = await receptionistAgent
      .post(`/api/restaurant/orders/${orderId}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'ready' });
    expect([400, 409]).toContain(invalidJump.status);

    // Valid edit while pending
    const editPending = await receptionistAgent
      .put(`/api/restaurant/orders/${orderId}`)
      .set('X-Property-Id', propAId)
      .send({ notes: 'Updated nut-free instruction', tableLabel: 'Table 9B' });
    expect(editPending.status).toBe(200);
    expect(editPending.body.order.notes).toBe('Updated nut-free instruction');
    expect(editPending.body.order.tableLabel).toBe('Table 9B');

    // Valid transition: pending -> preparing
    const toPrep = await receptionistAgent
      .post(`/api/restaurant/orders/${orderId}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'preparing', note: 'Chef started tandoor' });
    expect(toPrep.status).toBe(200);
    expect(toPrep.body.order.status).toBe('preparing');
    expect(toPrep.body.order.preparingAt).toBeTruthy();

    // Edit must now be blocked once preparing (409)
    const editAfterPrep = await receptionistAgent
      .put(`/api/restaurant/orders/${orderId}`)
      .set('X-Property-Id', propAId)
      .send({ notes: 'Too late edit' });
    expect(editAfterPrep.status).toBe(409);

    // Valid transitions: preparing -> ready -> served
    const toReady = await receptionistAgent
      .post(`/api/restaurant/orders/${orderId}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'ready' });
    expect(toReady.status).toBe(200);
    expect(toReady.body.order.readyAt).toBeTruthy();

    const toServed = await adminAgent
      .post(`/api/restaurant/orders/${orderId}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'served' });
    expect(toServed.status).toBe(200);
    expect(toServed.body.order.status).toBe('served');
    expect(toServed.body.order.servedAt).toBeTruthy();
    expect(toServed.body.order.statusHistory.length).toBe(4);
    expect(toServed.body.order.statusHistory[3].changedBy).toBe(adminUserId);
    expect(toServed.body.order.servedByName).toBe('Vikram DiningAdmin');

    // Cannot cancel an already served order!
    const cancelServed = await adminAgent
      .post(`/api/restaurant/orders/${orderId}/cancel`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Trying to cancel after serving' });
    expect(cancelServed.status).toBe(409);

    // Create another order and cancel while preparing -> succeeds and blocks further transitions
    const c2 = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'takeaway',
        items: [{ menuItemId: chaiItemId, quantity: 1 }],
      });
    const cancelRes = await receptionistAgent
      .post(`/api/restaurant/orders/${c2.body.order.id}/cancel`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Customer walked out' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.order.status).toBe('cancelled');
    expect(cancelRes.body.order.cancelledByName).toBe('Neha POSDesk');
    expect(cancelRes.body.order.statusHistory[1].changedBy).toBe(receptionistUserId);

    const transitionCancelled = await receptionistAgent
      .post(`/api/restaurant/orders/${c2.body.order.id}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'preparing' });
    expect([400, 409]).toContain(transitionCancelled.status);
  });

  it('6. enforces strict Property Isolation across all restaurant endpoints', async () => {
    // Property B staff cannot access Property A categories, menu items, eligible stays, or orders
    const forbiddenList = await propBOnlyAgent
      .get('/api/restaurant/orders')
      .set('X-Property-Id', propAId);
    expect(forbiddenList.status).toBe(403);

    // Property B order gets independent sequence P4B-FD-1001 and 18% Luxury GST
    const propBOrder = await propBOnlyAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propBId)
      .send({
        orderType: 'restaurant',
        tableLabel: 'Beach Deck 1',
        items: [{ menuItemId: propBItemId, quantity: 1 }],
      });
    expect(propBOrder.status).toBe(201);
    expect(propBOrder.body.order.orderReference).toBe('P4B-FD-1001');
    expect(propBOrder.body.order.taxRate).toBe(18);
    expect(propBOrder.body.order.taxName).toBe('Luxury GST');

    // Property A order list does NOT leak P4B-FD-1001
    const propAOrders = await adminAgent
      .get('/api/restaurant/orders')
      .set('X-Property-Id', propAId);
    expect(propAOrders.status).toBe(200);
    expect(
      propAOrders.body.items.some(
        (o: { orderReference: string }) => o.orderReference === 'P4B-FD-1001'
      )
    ).toBe(false);

    // Ordering Property B menu item on Property A -> 404
    const crossMenuOrder = await adminAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'takeaway',
        items: [{ menuItemId: propBItemId, quantity: 1 }],
      });
    expect(crossMenuOrder.status).toBe(404);
  });

  it('7. enforces Room-Service checked_in eligibility, posts to Phase 3 folio idempotently, blocks silent deletion, supports auditable charge reversal, and preserves checkout rules', async () => {
    // 7a. Create a CONFIRMED (not yet checked-in) reservation on Room 101 and a CHECKED-IN stay on Room 102
    const confirmedBooking = await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestAId,
        roomTypeId: dlxTypeId,
        roomId: room101Id,
        arrivalDate: addDays(propAToday, 1),
        departureDate: addDays(propAToday, 3),
        adults: 2,
        children: 0,
        nightlyRate: 4000,
        status: 'confirmed',
        source: 'direct',
      });
    expect(confirmedBooking.status).toBe(201);
    const confirmedResId = confirmedBooking.body.reservation.id;

    // Room service for non-checked-in reservation -> rejected!
    const rejectFutureStay = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: confirmedResId,
        items: [{ menuItemId: paneerItemId, quantity: 1 }],
      });
    expect([400, 409]).toContain(rejectFutureStay.status);

    // Seed a checked-in 2-night stay on Room 102 departing today (2 nights @ 4000 = 8000 + 12% GST 960 = 8960)
    const inHouseIns = await getPool().query(
      `INSERT INTO reservations (
         property_id, booking_reference, guest_id, room_type_id, room_id,
         status, source, arrival_date, departure_date, adults, children, num_guests,
         nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total, currency,
         checked_in_at, created_by, updated_by
       ) VALUES (
         $1, 'BK-P4-102', $2, $3, $4,
         'checked_in', 'walk_in', $5, $6, 2, 0, 2,
         4000.00, 0.00, 12.00, 960.00, 8960.00, 'INR',
         NOW() - INTERVAL '2 days', $7, $7
       ) RETURNING id`,
      [
        propAId,
        guestAId,
        dlxTypeId,
        room102Id,
        addDays(propAToday, -2),
        propAToday,
        receptionistUserId,
      ]
    );
    const inHouseResId = inHouseIns.rows[0].id as string;

    // Cross-property reservation linkage check: create checked-in stay on Property B and try ordering from Property A -> 404
    const propBStay = await adminAgent
      .post('/api/reservations')
      .set('X-Property-Id', propBId)
      .send({
        guestId: guestBId,
        roomTypeId: (
          await getPool().query(
            `SELECT id FROM room_types WHERE property_id = $1 LIMIT 1`,
            [propBId]
          )
        ).rows[0].id,
        roomId: propBRoomId,
        arrivalDate: propAToday,
        departureDate: addDays(propAToday, 1),
        adults: 1,
        children: 0,
        nightlyRate: 5000,
        status: 'confirmed',
        source: 'direct',
      });
    await adminAgent
      .post(`/api/reservations/${propBStay.body.reservation.id}/check-in`)
      .set('X-Property-Id', propBId)
      .send({ assignRoomId: propBRoomId });

    const crossPropRoomService = await adminAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: propBStay.body.reservation.id,
        items: [{ menuItemId: paneerItemId, quantity: 1 }],
      });
    expect(crossPropRoomService.status).toBe(404);

    // 7b. Place TWO valid Room Service orders for Room 102:
    // Order 1 (to be posted & kept): 1x Royal Paneer Lababdar @ 520.00 -> subtotal 520, GST 12% = 62.40, total = 582.40
    const rsOrder1Res = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: inHouseResId,
        notes: 'Deliver to Room 102 with warm rotis',
        items: [{ menuItemId: paneerItemId, quantity: 1 }],
      });
    expect(rsOrder1Res.status).toBe(201);
    const rsOrder1 = rsOrder1Res.body.order;
    expect(rsOrder1.roomNumber).toBe('102');
    expect(rsOrder1.billingStatus).toBe('unbilled');
    expect(rsOrder1.totalAmount).toBe(582.4);

    // Order 2 (to be posted and then reversed via auditable reversal): 2x Chai @ 95.25 -> subtotal 190.50, GST 12% = 22.86, total = 213.36
    const rsOrder2Res = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: inHouseResId,
        items: [{ menuItemId: chaiItemId, quantity: 2 }],
      });
    expect(rsOrder2Res.status).toBe(201);
    const rsOrder2 = rsOrder2Res.body.order;
    expect(rsOrder2.totalAmount).toBe(213.36);

    // 7c. Post Order 1 CONCURRENTLY (3 parallel requests) -> exactly 1 succeeds (200) and duplicates are rejected (409)!
    const postResponses = await Promise.all(
      Array.from({ length: 3 }, () =>
        receptionistAgent
          .post(`/api/restaurant/orders/${rsOrder1.id}/post-to-invoice`)
          .set('X-Property-Id', propAId)
          .send({ createDraftInvoiceIfMissing: true })
      )
    );
    const succeededPosts = postResponses.filter((r) => r.status === 200);
    const rejectedDupPosts = postResponses.filter((r) => r.status === 409);
    expect(succeededPosts.length).toBe(1);
    expect(rejectedDupPosts.length).toBe(2);

    const invoiceAfterPost1 = succeededPosts[0].body.invoice;
    const invoiceId = invoiceAfterPost1.id;
    // Room 8960.00 + RS1 582.40 = 9542.40; status must NOT be 'paid'!
    expect(invoiceAfterPost1.grandTotal).toBe(9542.4);
    expect(invoiceAfterPost1.balanceDue).toBe(9542.4);
    expect(invoiceAfterPost1.status).not.toBe('paid');

    const foodLinesForOrder1 = invoiceAfterPost1.lineItems.filter(
      (li: { sourceKey: string | null }) => li.sourceKey === `food_order:${rsOrder1.id}`
    );
    expect(foodLinesForOrder1.length).toBe(1);

    // Advance Order 1 through Kitchen to SERVED -> invoice MUST STILL NOT be marked paid!
    await receptionistAgent
      .post(`/api/restaurant/orders/${rsOrder1.id}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'preparing' });
    await receptionistAgent
      .post(`/api/restaurant/orders/${rsOrder1.id}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'ready' });
    const servedRes = await receptionistAgent
      .post(`/api/restaurant/orders/${rsOrder1.id}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'served' });
    expect(servedRes.status).toBe(200);

    const invCheckAfterServe = await receptionistAgent
      .get(`/api/invoices/${invoiceId}`)
      .set('X-Property-Id', propAId);
    expect(invCheckAfterServe.body.invoice.status).toBe('draft');
    expect(invCheckAfterServe.body.invoice.amountPaid).toBe(0);

    // 7d. Post Order 2 to the same invoice -> Grand total = 9542.40 + 213.36 = 9755.76
    const post2Res = await receptionistAgent
      .post(`/api/restaurant/orders/${rsOrder2.id}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({});
    expect(post2Res.status).toBe(200);
    expect(post2Res.body.invoice.grandTotal).toBe(9755.76);

    // Direct cancellation of posted Order 2 MUST be blocked (409) to preserve accounting consistency
    const blockedCancel = await receptionistAgent
      .post(`/api/restaurant/orders/${rsOrder2.id}/cancel`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Guest cancelled tea' });
    expect(blockedCancel.status).toBe(409);

    // Silent deletion of posted food_order line item via DELETE /api/invoices/:id/items/:itemId MUST be rejected (409)!
    const order2Line = post2Res.body.invoice.lineItems.find(
      (li: { sourceKey: string | null }) => li.sourceKey === `food_order:${rsOrder2.id}`
    );
    expect(order2Line).toBeTruthy();

    const silentDeleteAttempt = await adminAgent
      .delete(`/api/invoices/${invoiceId}/items/${order2Line.id}`)
      .set('X-Property-Id', propAId);
    expect([400, 409]).toContain(silentDeleteAttempt.status);

    // Receptionist cannot reverse a posted charge (403 Admin-only)
    const recReverse = await receptionistAgent
      .post(`/api/restaurant/orders/${rsOrder2.id}/reverse-charge`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Guest cancelled tea', cancelOrder: true });
    expect(recReverse.status).toBe(403);

    // Admin performs auditable charge reversal on Order 2 (with cancelOrder: true)
    const adminReverse = await adminAgent
      .post(`/api/restaurant/orders/${rsOrder2.id}/reverse-charge`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Guest cancelled tea before delivery', cancelOrder: true });
    expect(adminReverse.status).toBe(200);
    expect(adminReverse.body.order.billingStatus).toBe('reversed');
    expect(adminReverse.body.order.status).toBe('cancelled');

    // Original food_order line AND auditable food_order_reversal line BOTH remain in invoice ledger; grandTotal returns to 9542.40!
    const reversedInvoice = adminReverse.body.invoice;
    expect(reversedInvoice.grandTotal).toBe(9542.4);
    expect(reversedInvoice.balanceDue).toBe(9542.4);
    expect(
      reversedInvoice.lineItems.some(
        (li: { sourceKey: string | null }) => li.sourceKey === `food_order:${rsOrder2.id}`
      )
    ).toBe(true);
    expect(
      reversedInvoice.lineItems.some(
        (li: { sourceKey: string | null }) =>
          li.sourceKey === `food_order_reversal:${rsOrder2.id}`
      )
    ).toBe(true);

    // 7e. Issue invoice, record partial payment (5000), and Check Out guest -> Checkout succeeds without auto-marking paid!
    await receptionistAgent
      .post(`/api/invoices/${invoiceId}/issue`)
      .set('X-Property-Id', propAId)
      .send({});

    const partialPay = await receptionistAgent
      .post(`/api/invoices/${invoiceId}/payments`)
      .set('X-Property-Id', propAId)
      .send({
        amount: 5000,
        paymentMethod: 'upi',
        referenceNumber: 'UPI-P4-5000',
        idempotencyKey: 'pay-p4-partial-1',
      });
    expect(partialPay.status).toBe(201);
    expect(partialPay.body.invoice.status).toBe('partially_paid');
    expect(partialPay.body.invoice.balanceDue).toBe(4542.4);

    // Check Out guest on Room 102 with unpaid food + room balance (4542.40)
    const checkOutRes = await receptionistAgent
      .post(`/api/reservations/${inHouseResId}/check-out`)
      .set('X-Property-Id', propAId)
      .send({});
    expect(checkOutRes.status).toBe(200);
    expect(checkOutRes.body.reservation.status).toBe('checked_out');

    // Verify invoice was NOT auto-marked paid by checkout, and Food Order 1 line item was preserved during checkout sync!
    const invAfterCheckout = await receptionistAgent
      .get(`/api/invoices/${invoiceId}`)
      .set('X-Property-Id', propAId);
    expect(invAfterCheckout.body.invoice.status).toBe('partially_paid');
    expect(invAfterCheckout.body.invoice.grandTotal).toBe(9542.4);
    expect(invAfterCheckout.body.invoice.balanceDue).toBe(4542.4);

    // Checked-out reservation is no longer eligible for new Room Service orders!
    const rsAfterCheckout = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: inHouseResId,
        items: [{ menuItemId: chaiItemId, quantity: 1 }],
      });
    expect([400, 409]).toContain(rsAfterCheckout.status);

    // Settle remaining balance (4542.40) -> Invoice becomes Paid with 0 balance!
    const finalPay = await receptionistAgent
      .post(`/api/invoices/${invoiceId}/payments`)
      .set('X-Property-Id', propAId)
      .send({
        amount: 4542.4,
        paymentMethod: 'card',
        referenceNumber: 'CARD-P4-FINAL',
        idempotencyKey: 'pay-p4-final-1',
      });
    expect(finalPay.status).toBe(201);
    expect(finalPay.body.invoice.status).toBe('paid');
    expect(finalPay.body.invoice.balanceDue).toBe(0);

    // Reversing Order 1 now that invoice is paid in full MUST be rejected (400/409) because payments > post-reversal total
    const overpaidReversalAttempt = await adminAgent
      .post(`/api/restaurant/orders/${rsOrder1.id}/reverse-charge`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Late comp attempt on already settled invoice' });
    expect([400, 409]).toContain(overpaidReversalAttempt.status);

    // Unused room103Id sanity check so lint stays clean
    expect(room103Id).toBeTruthy();
  });

  it('8. [DEFECT-01] voiding an unpaid invoice atomically releases posted room-service orders for cancellation or replacement-folio reposting while preserving history and already-reversed orders', async () => {
    const pool = getPool();
    const dbCheck = await pool.query('SELECT current_database() AS db_name');
    expect(dbCheck.rows[0]?.db_name).toBe('staycraft_pms_test');

    // Create a checked-in 2-night reservation on Room 103 (2 * 4000 = 8000 + 12% GST 960 = 8960)
    const stayIns = await pool.query(
      `INSERT INTO reservations (
         property_id, booking_reference, guest_id, room_type_id, room_id,
         status, source, arrival_date, departure_date, adults, children, num_guests,
         nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total, currency,
         checked_in_at, created_by, updated_by
       ) VALUES (
         $1, 'BK-P4-DEF01', $2, $3, $4,
         'checked_in', 'direct', $5, $6, 2, 0, 2,
         4000.00, 0.00, 12.00, 960.00, 8960.00, 'INR',
         NOW() - INTERVAL '1 day', $7, $7
       ) RETURNING id`,
      [
        propAId,
        guestAId,
        dlxTypeId,
        room103Id,
        addDays(propAToday, -1),
        addDays(propAToday, 1),
        receptionistUserId,
      ]
    );
    const stayId = stayIns.rows[0].id as string;

    // Place 3 room-service orders on BK-P4-DEF01:
    // A: orderRepost (1x Royal Paneer @ 520 + 12% = 582.40) -> posted -> invoice voided -> reposted to replacement folio
    // B: orderCancel (1x Chai @ 95.25 + 12% = 106.68) -> posted -> invoice voided -> cancelled while unbilled
    // C: orderReversedBeforeVoid (2x Chai = 213.36) -> posted -> reversed BEFORE invoice voided -> must stay reversed!
    const [oRepostRes, oCancelRes, oRevRes] = await Promise.all([
      receptionistAgent
        .post('/api/restaurant/orders')
        .set('X-Property-Id', propAId)
        .send({
          orderType: 'room_service',
          reservationId: stayId,
          notes: 'Order A to repost after void',
          items: [{ menuItemId: paneerItemId, quantity: 1 }],
        }),
      receptionistAgent
        .post('/api/restaurant/orders')
        .set('X-Property-Id', propAId)
        .send({
          orderType: 'room_service',
          reservationId: stayId,
          notes: 'Order B to cancel after void',
          items: [{ menuItemId: chaiItemId, quantity: 1 }],
        }),
      receptionistAgent
        .post('/api/restaurant/orders')
        .set('X-Property-Id', propAId)
        .send({
          orderType: 'room_service',
          reservationId: stayId,
          notes: 'Order C reversed prior to void',
          items: [{ menuItemId: chaiItemId, quantity: 2 }],
        }),
    ]);
    expect(oRepostRes.status).toBe(201);
    expect(oCancelRes.status).toBe(201);
    expect(oRevRes.status).toBe(201);

    const orderRepostId = oRepostRes.body.order.id as string;
    const orderCancelId = oCancelRes.body.order.id as string;
    const orderAlreadyReversedId = oRevRes.body.order.id as string;

    // Post all 3 orders onto Initial Folio (inv1)
    const p1 = await receptionistAgent
      .post(`/api/restaurant/orders/${orderRepostId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({ createDraftInvoiceIfMissing: true });
    expect(p1.status).toBe(200);
    const inv1Id = p1.body.invoice.id as string;

    const p2 = await receptionistAgent
      .post(`/api/restaurant/orders/${orderCancelId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({});
    expect(p2.status).toBe(200);

    const p3 = await receptionistAgent
      .post(`/api/restaurant/orders/${orderAlreadyReversedId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({});
    expect(p3.status).toBe(200);

    // Reverse Order C BEFORE voiding inv1
    const revBeforeVoid = await adminAgent
      .post(`/api/restaurant/orders/${orderAlreadyReversedId}/reverse-charge`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Reversed prior to voiding folio', cancelOrder: false });
    expect(revBeforeVoid.status).toBe(200);
    expect(revBeforeVoid.body.order.billingStatus).toBe('reversed');

    // Rollback-on-failure check: simulate mid-transaction failure on food_orders update and verify inv1 stays non-void
    await pool.query(`
      CREATE OR REPLACE FUNCTION pg_temp_fail_void_release() RETURNS trigger AS $$
      BEGIN
        IF OLD.billing_status = 'posted' AND NEW.billing_status = 'unbilled' THEN
          RAISE EXCEPTION 'Simulated mid-void food_orders failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_temp_fail_void_release
        BEFORE UPDATE ON food_orders
        FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_void_release();
    `);

    try {
      const failedVoid = await adminAgent
        .post(`/api/invoices/${inv1Id}/void`)
        .set('X-Property-Id', propAId)
        .send({ reason: 'Void attempt during simulated DB error' });
      expect(failedVoid.status).toBeGreaterThanOrEqual(500);

      // Verify atomic rollback: inv1 is still draft, and Order A is still posted
      const invAfterFail = await adminAgent
        .get(`/api/invoices/${inv1Id}`)
        .set('X-Property-Id', propAId);
      expect(invAfterFail.body.invoice.status).toBe('draft');

      const orderAAfterFail = await adminAgent
        .get(`/api/restaurant/orders/${orderRepostId}`)
        .set('X-Property-Id', propAId);
      expect(orderAAfterFail.body.order.billingStatus).toBe('posted');
      expect(orderAAfterFail.body.order.postedInvoiceId).toBe(inv1Id);
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS trg_temp_fail_void_release ON food_orders;
        DROP FUNCTION IF EXISTS pg_temp_fail_void_release();
      `);
    }

    // Now void unpaid inv1 cleanly
    const voidRes = await adminAgent
      .post(`/api/invoices/${inv1Id}/void`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Reissuing guest folio after billing split' });
    expect(voidRes.status).toBe(200);
    expect(voidRes.body.invoice.status).toBe('void');
    // Historical line items on voided inv1 MUST remain preserved for audit
    expect(voidRes.body.invoice.lineItems.length).toBe(5); // room + 3 food charges + 1 reversal

    // Orders A and B must now be released back to 'unbilled' with cleared invoice links
    const [orderAAfterVoid, orderBAfterVoid, orderCAfterVoid] = await Promise.all([
      receptionistAgent
        .get(`/api/restaurant/orders/${orderRepostId}`)
        .set('X-Property-Id', propAId),
      receptionistAgent
        .get(`/api/restaurant/orders/${orderCancelId}`)
        .set('X-Property-Id', propAId),
      receptionistAgent
        .get(`/api/restaurant/orders/${orderAlreadyReversedId}`)
        .set('X-Property-Id', propAId),
    ]);

    expect(orderAAfterVoid.body.order.billingStatus).toBe('unbilled');
    expect(orderAAfterVoid.body.order.postedInvoiceId).toBeNull();
    expect(orderAAfterVoid.body.order.postedInvoiceNumber).toBeNull();
    expect(orderAAfterVoid.body.order.postedInvoiceStatus).toBeNull();
    expect(orderAAfterVoid.body.order.postedAt).toBeNull();
    expect(orderAAfterVoid.body.order.postedByName).toBeNull();

    const dbOrderACols = await pool.query(
      `SELECT posted_invoice_id, posted_line_item_id, posted_service_charge_id, posted_at, posted_by
       FROM food_orders WHERE id = $1`,
      [orderRepostId]
    );
    expect(dbOrderACols.rows[0]).toEqual({
      posted_invoice_id: null,
      posted_line_item_id: null,
      posted_service_charge_id: null,
      posted_at: null,
      posted_by: null,
    });

    expect(orderBAfterVoid.body.order.billingStatus).toBe('unbilled');
    expect(orderBAfterVoid.body.order.postedInvoiceId).toBeNull();

    // Order C was ALREADY reversed before voiding — must remain 'reversed', NEVER reset to 'unbilled'!
    expect(orderCAfterVoid.body.order.billingStatus).toBe('reversed');

    // Underlying reservation_service_charges for Orders A, B, C must all be 'voided' prior to reposting
    const scCheckAfterVoid = await pool.query(
      `SELECT food_order_id, status FROM reservation_service_charges WHERE reservation_id = $1`,
      [stayId]
    );
    expect(scCheckAfterVoid.rows.length).toBe(3);
    for (const row of scCheckAfterVoid.rows) {
      expect(row.status).toBe('voided');
    }

    // Order B can now be cancelled cleanly since it is unbilled, and once cancelled cannot be reposted
    const cancelOrderB = await receptionistAgent
      .post(`/api/restaurant/orders/${orderCancelId}/cancel`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Guest declined chai before prep' });
    expect(cancelOrderB.status).toBe(200);
    expect(cancelOrderB.body.order.status).toBe('cancelled');

    // Generate Replacement Folio (inv2) for BK-P4-DEF01
    const replacementFolioRes = await receptionistAgent
      .post(`/api/invoices/from-reservation/${stayId}`)
      .set('X-Property-Id', propAId)
      .send({});
    expect([200, 201]).toContain(replacementFolioRes.status);
    const inv2Id = replacementFolioRes.body.invoice.id as string;
    expect(inv2Id).not.toBe(inv1Id);
    expect(replacementFolioRes.body.invoice.grandTotal).toBe(8960);

    // Cancelled Order B and already-reversed Order C CANNOT be reposted to inv2
    const repostCancelled = await receptionistAgent
      .post(`/api/restaurant/orders/${orderCancelId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({});
    expect(repostCancelled.status).toBe(409);

    const repostAlreadyReversed = await receptionistAgent
      .post(`/api/restaurant/orders/${orderAlreadyReversedId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({});
    expect(repostAlreadyReversed.status).toBe(409);

    // Repost eligible Order A concurrently (3 parallel requests) -> exactly 1 succeeds (200), 2 reject (409), no double billing!
    const repostAResponses = await Promise.all(
      Array.from({ length: 3 }, () =>
        receptionistAgent
          .post(`/api/restaurant/orders/${orderRepostId}/post-to-invoice`)
          .set('X-Property-Id', propAId)
          .send({})
      )
    );
    expect(repostAResponses.filter((r) => r.status === 200).length).toBe(1);
    expect(repostAResponses.filter((r) => r.status === 409).length).toBe(2);

    const inv2Final = await receptionistAgent
      .get(`/api/invoices/${inv2Id}`)
      .set('X-Property-Id', propAId);
    // Room 8960.00 + Order A 582.40 = 9542.40 (no duplicate charges!)
    expect(inv2Final.body.invoice.grandTotal).toBe(9542.4);
    expect(inv2Final.body.invoice.lineItems.length).toBe(2);

    // Verify voiding a partially-paid invoice is rejected and does NOT release Order A
    await receptionistAgent
      .post(`/api/invoices/${inv2Id}/issue`)
      .set('X-Property-Id', propAId)
      .send({});
    const payInv2 = await receptionistAgent
      .post(`/api/invoices/${inv2Id}/payments`)
      .set('X-Property-Id', propAId)
      .send({
        amount: 1000,
        paymentMethod: 'cash',
        referenceNumber: 'CASH-DEF01',
        idempotencyKey: 'pay-def01-1',
      });
    expect(payInv2.status).toBe(201);

    const rejectPaidVoid = await adminAgent
      .post(`/api/invoices/${inv2Id}/void`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Should fail because partially paid' });
    expect(rejectPaidVoid.status).toBe(409);

    const orderAStillPosted = await receptionistAgent
      .get(`/api/restaurant/orders/${orderRepostId}`)
      .set('X-Property-Id', propAId);
    expect(orderAStillPosted.body.order.billingStatus).toBe('posted');
    expect(orderAStillPosted.body.order.postedInvoiceId).toBe(inv2Id);
  });

  it('9. [DEFECT-02] enforces invoice payment floor on charge reversals even when post-reversal grandTotal reaches 0.00', async () => {
    const pool = getPool();
    const dbCheck = await pool.query('SELECT current_database() AS db_name');
    expect(dbCheck.rows[0]?.db_name).toBe('staycraft_pms_test');

    // Create dedicated room 104 for DEFECT-02 isolation
    const r104 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
       VALUES ($1, $2, '104', '1', 'clean', 'available') RETURNING id`,
      [propAId, dlxTypeId]
    );
    const room104Id = r104.rows[0].id as string;

    // Case A: 100%-discounted complimentary stay (room net = 0.00) + posted food order (582.40) + partial payment (200.00)
    // Reversing the food order would drop grandTotal to 0.00 < amountPaid (200.00) -> MUST fail (409) and roll back!
    const zeroRoomStay = await pool.query(
      `INSERT INTO reservations (
         property_id, booking_reference, guest_id, room_type_id, room_id,
         status, source, arrival_date, departure_date, adults, children, num_guests,
         nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total, currency,
         checked_in_at, created_by, updated_by
       ) VALUES (
         $1, 'BK-P4-DEF02-Z', $2, $3, $4,
         'checked_in', 'direct', $5, $6, 1, 0, 1,
         4000.00, 4000.00, 12.00, 0.00, 0.00, 'INR',
         NOW() - INTERVAL '1 day', $7, $7
       ) RETURNING id`,
      [
        propAId,
        guestAId,
        dlxTypeId,
        room104Id,
        addDays(propAToday, -1),
        propAToday,
        receptionistUserId,
      ]
    );
    const zeroRoomStayId = zeroRoomStay.rows[0].id as string;

    const foodOnZeroStay = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: zeroRoomStayId,
        items: [{ menuItemId: paneerItemId, quantity: 1 }],
      });
    expect(foodOnZeroStay.status).toBe(201);
    const zeroStayOrderId = foodOnZeroStay.body.order.id as string;

    const postZeroStay = await receptionistAgent
      .post(`/api/restaurant/orders/${zeroStayOrderId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({ createDraftInvoiceIfMissing: true });
    expect(postZeroStay.status).toBe(200);
    const zeroStayInvId = postZeroStay.body.invoice.id as string;
    expect(postZeroStay.body.invoice.grandTotal).toBe(582.4);

    await receptionistAgent
      .post(`/api/invoices/${zeroStayInvId}/issue`)
      .set('X-Property-Id', propAId)
      .send({});

    const pay200 = await receptionistAgent
      .post(`/api/invoices/${zeroStayInvId}/payments`)
      .set('X-Property-Id', propAId)
      .send({
        amount: 200,
        paymentMethod: 'upi',
        referenceNumber: 'UPI-ZERO-FLOOR-200',
        idempotencyKey: 'pay-def02-zero-200',
      });
    expect(pay200.status).toBe(201);
    expect(pay200.body.invoice.amountPaid).toBe(200);
    expect(pay200.body.invoice.balanceDue).toBe(382.4);

    // Attempt reversal that would reduce grandTotal to 0.00 while amountPaid is 200.00 -> MUST reject with 409!
    const zeroFloorReversal = await adminAgent
      .post(`/api/restaurant/orders/${zeroStayOrderId}/reverse-charge`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Attempted comp that would strand 200 payment at 0 total' });
    expect(zeroFloorReversal.status).toBe(409);

    // Verify full atomic rollback across invoice, payments, reservation_service_charges, and food_orders
    const invCheckAfterReject = await adminAgent
      .get(`/api/invoices/${zeroStayInvId}`)
      .set('X-Property-Id', propAId);
    expect(invCheckAfterReject.body.invoice.grandTotal).toBe(582.4);
    expect(invCheckAfterReject.body.invoice.amountPaid).toBe(200);
    expect(invCheckAfterReject.body.invoice.balanceDue).toBe(382.4);
    expect(invCheckAfterReject.body.invoice.status).toBe('partially_paid');
    expect(invCheckAfterReject.body.invoice.payments.length).toBe(1);
    expect(
      invCheckAfterReject.body.invoice.lineItems.some(
        (li: { sourceKey: string | null }) =>
          li.sourceKey === `food_order_reversal:${zeroStayOrderId}`
      )
    ).toBe(false);

    const orderCheckAfterReject = await adminAgent
      .get(`/api/restaurant/orders/${zeroStayOrderId}`)
      .set('X-Property-Id', propAId);
    expect(orderCheckAfterReject.body.order.billingStatus).toBe('posted');

    const scAfterReject = await pool.query(
      `SELECT status FROM reservation_service_charges WHERE food_order_id = $1`,
      [zeroStayOrderId]
    );
    expect(scAfterReject.rows[0]?.status).toBe('billed');

    // Case B: Valid reversal when post-reversal grandTotal (582.40) >= amountPaid (200.00)
    const secondFood = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: zeroRoomStayId,
        items: [{ menuItemId: chaiItemId, quantity: 2 }],
      });
    expect(secondFood.status).toBe(201);
    const secondFoodId = secondFood.body.order.id as string;

    const postSecond = await receptionistAgent
      .post(`/api/restaurant/orders/${secondFoodId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({});
    expect(postSecond.status).toBe(200);
    expect(postSecond.body.invoice.grandTotal).toBe(795.76);

    const validReversal = await adminAgent
      .post(`/api/restaurant/orders/${secondFoodId}/reverse-charge`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Valid reversal keeping grandTotal 582.40 >= 200.00 paid' });
    expect(validReversal.status).toBe(200);
    expect(validReversal.body.invoice.grandTotal).toBe(582.4);
    expect(validReversal.body.invoice.amountPaid).toBe(200);
    expect(validReversal.body.invoice.balanceDue).toBe(382.4);
    expect(validReversal.body.invoice.status).toBe('partially_paid');

    // Case C: Reversal to grandTotal === 0.00 when amountPaid === 0.00 IS allowed and stays draft (not paid!)
    const r105 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
       VALUES ($1, $2, '105', '1', 'clean', 'available') RETURNING id`,
      [propAId, dlxTypeId]
    );
    const unpaidZeroStay = await pool.query(
      `INSERT INTO reservations (
         property_id, booking_reference, guest_id, room_type_id, room_id,
         status, source, arrival_date, departure_date, adults, children, num_guests,
         nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total, currency,
         checked_in_at, created_by, updated_by
       ) VALUES (
         $1, 'BK-P4-DEF02-U', $2, $3, $4,
         'checked_in', 'direct', $5, $6, 1, 0, 1,
         4000.00, 4000.00, 12.00, 0.00, 0.00, 'INR',
         NOW() - INTERVAL '1 day', $7, $7
       ) RETURNING id`,
      [
        propAId,
        guestAId,
        dlxTypeId,
        r105.rows[0].id,
        addDays(propAToday, -1),
        propAToday,
        receptionistUserId,
      ]
    );
    const unpaidZeroOrder = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: unpaidZeroStay.rows[0].id,
        items: [{ menuItemId: chaiItemId, quantity: 1 }],
      });
    await receptionistAgent
      .post(`/api/restaurant/orders/${unpaidZeroOrder.body.order.id}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({ createDraftInvoiceIfMissing: true });

    const unpaidZeroRev = await adminAgent
      .post(`/api/restaurant/orders/${unpaidZeroOrder.body.order.id}/reverse-charge`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Unpaid folio reversal to zero total' });
    expect(unpaidZeroRev.status).toBe(200);
    expect(unpaidZeroRev.body.invoice.grandTotal).toBe(0);
    expect(unpaidZeroRev.body.invoice.amountPaid).toBe(0);
    expect(unpaidZeroRev.body.invoice.status).toBe('draft');
  });

  it('10. [DEFECT-05] verifies idempotencyKey request payload equivalence and returns 409 Conflict on mismatched reuse while preserving property isolation', async () => {
    const idemKey = 'idem-payload-guard-001';
    const basePayload = {
      orderType: 'restaurant',
      tableLabel: 'Table 14',
      customerName: 'Ananya Rao',
      notes: 'Serve starters first',
      items: [
        { menuItemId: paneerItemId, quantity: 2, specialInstructions: 'less oil' },
        { menuItemId: chaiItemId, quantity: 1, specialInstructions: '' },
      ],
      idempotencyKey: idemKey,
    };

    const initialCreate = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send(basePayload);
    expect(initialCreate.status).toBe(201);
    const originalOrderId = initialCreate.body.order.id as string;

    // 10a. Exact retry -> 200 with original order
    const exactRetry = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send(basePayload);
    expect(exactRetry.status).toBe(200);
    expect(exactRetry.body.order.id).toBe(originalOrderId);

    // 10b. Equivalent retry with reordered items & surrounding whitespace -> 200 with original order
    const reorderedRetry = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'restaurant',
        tableLabel: '  Table 14  ',
        customerName: 'Ananya Rao',
        notes: 'Serve starters first',
        items: [
          { menuItemId: chaiItemId, quantity: 1 },
          { menuItemId: paneerItemId, quantity: 2, specialInstructions: ' less oil ' },
        ],
        idempotencyKey: idemKey,
      });
    expect(reorderedRetry.status).toBe(200);
    expect(reorderedRetry.body.order.id).toBe(originalOrderId);

    // 10c. Mismatched quantity -> 409 Conflict
    const diffQty = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        ...basePayload,
        items: [
          { menuItemId: paneerItemId, quantity: 3, specialInstructions: 'less oil' },
          { menuItemId: chaiItemId, quantity: 1 },
        ],
      });
    expect(diffQty.status).toBe(409);

    // 10d. Mismatched items -> 409 Conflict
    const diffItems = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        ...basePayload,
        items: [{ menuItemId: paneerItemId, quantity: 2, specialInstructions: 'less oil' }],
      });
    expect(diffItems.status).toBe(409);

    // 10e. Mismatched tableLabel -> 409 Conflict
    const diffTable = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        ...basePayload,
        tableLabel: 'Table 99',
      });
    expect(diffTable.status).toBe(409);

    // 10f. Mismatched orderType -> 409 Conflict
    const diffType = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'takeaway',
        customerName: 'Ananya Rao',
        notes: 'Serve starters first',
        items: basePayload.items,
        idempotencyKey: idemKey,
      });
    expect(diffType.status).toBe(409);

    // 10g. Room-service idempotency: exact retry with omitted customerName succeeds (200), different reservationId -> 409
    const activeStays = await getPool().query(
      `SELECT id FROM reservations WHERE property_id = $1 AND status = 'checked_in' ORDER BY created_at ASC LIMIT 2`,
      [propAId]
    );
    expect(activeStays.rows.length).toBeGreaterThanOrEqual(2);
    const stay1Id = activeStays.rows[0].id as string;
    const stay2Id = activeStays.rows[1].id as string;

    const rsIdemKey = 'idem-rs-guard-002';
    const rsCreate = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: stay1Id,
        items: [{ menuItemId: chaiItemId, quantity: 1 }],
        idempotencyKey: rsIdemKey,
      });
    expect(rsCreate.status).toBe(201);

    const rsExactRetry = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: stay1Id,
        items: [{ menuItemId: chaiItemId, quantity: 1 }],
        idempotencyKey: rsIdemKey,
      });
    expect(rsExactRetry.status).toBe(200);
    expect(rsExactRetry.body.order.id).toBe(rsCreate.body.order.id);

    const rsDiffStay = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId: stay2Id,
        items: [{ menuItemId: chaiItemId, quantity: 1 }],
        idempotencyKey: rsIdemKey,
      });
    expect(rsDiffStay.status).toBe(409);

    // 10h. Property B reusing the exact same idempotencyKey string is completely isolated -> 201 Created
    const propBSameKey = await propBOnlyAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propBId)
      .send({
        orderType: 'takeaway',
        customerName: 'Goa Walk-in',
        items: [{ menuItemId: propBItemId, quantity: 1 }],
        idempotencyKey: idemKey,
      });
    expect(propBSameKey.status).toBe(201);
  });

  it('11. [DEFECT-06] validates dietaryTag and orders pagination query parameters with 400 BAD_REQUEST instead of leaking INVALID_IDENTIFIER', async () => {
    // 11a. Valid & empty dietaryTag on GET /api/restaurant/menu-items
    const validVeg = await receptionistAgent
      .get('/api/restaurant/menu-items?dietaryTag=veg')
      .set('X-Property-Id', propAId);
    expect(validVeg.status).toBe(200);
    expect(validVeg.body.items.length).toBeGreaterThan(0);
    expect(
      validVeg.body.items.every((m: { dietaryTag: string }) => m.dietaryTag === 'veg')
    ).toBe(true);

    const emptyDietary = await receptionistAgent
      .get('/api/restaurant/menu-items?dietaryTag=')
      .set('X-Property-Id', propAId);
    expect(emptyDietary.status).toBe(200);

    // Unknown dietaryTag -> 400 BAD_REQUEST (not 200 empty array and not INVALID_IDENTIFIER)
    for (const badTag of ['keto', 'gluten_free', 'INVALID']) {
      const badDietary = await receptionistAgent
        .get(`/api/restaurant/menu-items?dietaryTag=${badTag}`)
        .set('X-Property-Id', propAId);
      expect(badDietary.status).toBe(400);
      expect(badDietary.body.error.code).not.toBe('INVALID_IDENTIFIER');
    }

    // 11b. Valid defaults and explicit bounds on GET /api/restaurant/orders
    const defaultOrders = await receptionistAgent
      .get('/api/restaurant/orders')
      .set('X-Property-Id', propAId);
    expect(defaultOrders.status).toBe(200);
    expect(defaultOrders.body.page).toBe(1);
    expect(defaultOrders.body.pageSize).toBe(30);

    const explicitValid = await receptionistAgent
      .get('/api/restaurant/orders?page=1&pageSize=100')
      .set('X-Property-Id', propAId);
    expect(explicitValid.status).toBe(200);
    expect(explicitValid.body.page).toBe(1);
    expect(explicitValid.body.pageSize).toBe(100);

    // 11c. Invalid page and pageSize query values -> 400 validation error, NEVER INVALID_IDENTIFIER
    const invalidPaginationQueries = [
      'page=abc',
      'pageSize=abc',
      'page=1.5',
      'pageSize=10.5',
      'page=-1',
      'pageSize=-10',
      'page=0',
      'pageSize=0',
      'page=99999999999999999999',
      'page=9999999',
      'pageSize=101',
      'pageSize=5000',
    ];

    for (const qs of invalidPaginationQueries) {
      const res = await receptionistAgent
        .get(`/api/restaurant/orders?${qs}`)
        .set('X-Property-Id', propAId);
      expect(res.status, `Expected 400 for query ?${qs}, got ${res.status}`).toBe(400);
      expect(res.body.error.code, `Unexpected INVALID_IDENTIFIER for ?${qs}`).not.toBe(
        'INVALID_IDENTIFIER'
      );
    }
  });
});
