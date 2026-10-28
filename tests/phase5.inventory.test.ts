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
let propBOnlyAgent: ReturnType<typeof request.agent>;

let adminUserId = '';
let receptionistUserId = '';
let propBOnlyUserId = '';

let propAId = '';
let propAToday = '';
let propBId = '';

let dlxTypeId = '';
let room101Id = '';
let propBRoomId = '';
let guestAId = '';

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
      food_menu_item_ingredients,
      inventory_receipt_items,
      stock_movements,
      inventory_receipts,
      property_inventory_receipt_counters,
      inventory_products,
      inventory_categories,
      suppliers,
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
     VALUES ('admin@phase5.test', $1, 'Vikram Admin', 'admin') RETURNING id`,
    [adminHash]
  );
  const uRec = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('frontdesk@phase5.test', $1, 'Neha Receptionist', 'receptionist') RETURNING id`,
    [recHash]
  );
  const uPropB = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('propb@phase5.test', $1, 'Arjun PropB', 'receptionist') RETURNING id`,
    [recHash]
  );

  adminUserId = uAdmin.rows[0].id;
  receptionistUserId = uRec.rows[0].id;
  propBOnlyUserId = uPropB.rows[0].id;

  const pA = await pool.query(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, state_region, postal_code, country,
       timezone, currency, default_tax_rate, tax_name
     ) VALUES (
       'KHB', 'Ganges Heritage Hotel', 'billing@ganges.example', '+91-542-2200111',
       'Assi Ghat Road', 'Varanasi', 'Uttar Pradesh', '221005', 'IN',
       'Asia/Kolkata', 'INR', 5.00, 'GST'
     ) RETURNING id`
  );
  const pB = await pool.query(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, state_region, postal_code, country,
       timezone, currency, default_tax_rate, tax_name
     ) VALUES (
       'GOA', 'Goa Coastal Retreat', 'stay@goa.example', '+91-832-5550199',
       'Candolim Beach Rd', 'Panaji', 'Goa', '403515', 'IN',
       'Asia/Kolkata', 'INR', 12.00, 'GST'
     ) RETURNING id`
  );

  propAId = pA.rows[0].id;
  propBId = pB.rows[0].id;
  propAToday = getPropertyLocalDate('Asia/Kolkata');

  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id) VALUES
      ($1, $3), ($1, $4),
      ($2, $3),
      ($5, $4)`,
    [adminUserId, receptionistUserId, propAId, propBId, propBOnlyUserId]
  );

  const rtA = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'DLX', 'Deluxe River View', 2, 3, 5000.00) RETURNING id`,
    [propAId]
  );
  const rtB = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'STD', 'Coastal Standard', 2, 2, 4200.00) RETURNING id`,
    [propBId]
  );
  dlxTypeId = rtA.rows[0].id;

  const r101 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
     VALUES ($1, $2, '101', '1', 'inspected', 'available') RETURNING id`,
    [propAId, dlxTypeId]
  );
  const rB = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
     VALUES ($1, $2, '401', '4', 'inspected', 'available') RETURNING id`,
    [propBId, rtB.rows[0].id]
  );
  room101Id = r101.rows[0].id;
  propBRoomId = rB.rows[0].id;

  const gA = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'Ananya', 'Sharma', 'ananya@example.com', '+919811100222') RETURNING id`,
    [propAId]
  );
  guestAId = gA.rows[0].id;
  expect(propBRoomId).toBeTruthy();

  adminAgent = request.agent(app);
  receptionistAgent = request.agent(app);
  propBOnlyAgent = request.agent(app);

  const loginAdmin = await adminAgent
    .post('/api/auth/login')
    .send({ email: 'admin@phase5.test', password: 'Admin@12345' });
  expect(loginAdmin.status).toBe(200);

  const loginRec = await receptionistAgent
    .post('/api/auth/login')
    .send({ email: 'frontdesk@phase5.test', password: 'FrontDesk@123' });
  expect(loginRec.status).toBe(200);

  const loginPropB = await propBOnlyAgent
    .post('/api/auth/login')
    .send({ email: 'propb@phase5.test', password: 'FrontDesk@123' });
  expect(loginPropB.status).toBe(200);
});

afterAll(async () => {
  const pool = getPool();
  const dbCheck = await pool.query('SELECT current_database() AS db_name');
  if (String(dbCheck.rows[0]?.db_name ?? '') === 'staycraft_pms_test') {
    await pool.query(`
      TRUNCATE TABLE
        food_menu_item_ingredients,
        inventory_receipt_items,
        stock_movements,
        inventory_receipts,
        property_inventory_receipt_counters,
        inventory_products,
        inventory_categories,
        suppliers,
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
  }
  await closePool();
});

describe('Phase 5: Inventory, Suppliers, Stock Ledger & Kitchen Recipe Integration', () => {
  let supplierDairyId = '';
  let supplierLinenId = '';
  let propBSupplierId = '';

  let catKitchenId = '';
  let catHousekeepingId = '';
  let propBCatId = '';

  let paneerItemId = '';
  let gravyItemId = '';
  let milkItemId = '';
  let towelItemId = '';
  let propBItemId = '';

  let foodCatMainsId = '';
  let dishPaneerId = '';
  let dishChaiId = '';
  let dishNaanNoRecipeId = '';

  it('1. enforces authentication, RBAC, property context, and malformed UUID/query handling', async () => {
    // Unauthenticated -> 401 AUTH_TOKEN_MISSING
    const unauthInv = await request(app)
      .get('/api/inventory/summary')
      .set('X-Property-Id', propAId);
    expect(unauthInv.status).toBe(401);
    expect(unauthInv.body.error.code).toBe('AUTH_TOKEN_MISSING');

    const unauthSup = await request(app)
      .get('/api/suppliers')
      .set('X-Property-Id', propAId);
    expect(unauthSup.status).toBe(401);

    // Cross-property unauthorized staff -> 403
    const crossProp = await propBOnlyAgent
      .get('/api/inventory/items')
      .set('X-Property-Id', propAId);
    expect(crossProp.status).toBe(403);

    // Receptionist forbidden on Admin catalog & adjustment endpoints (403)
    const recSup = await receptionistAgent
      .post('/api/suppliers')
      .set('X-Property-Id', propAId)
      .send({ name: 'Unauthorized Vendor' });
    expect(recSup.status).toBe(403);

    const recCat = await receptionistAgent
      .post('/api/inventory/categories')
      .set('X-Property-Id', propAId)
      .send({ code: 'UNAUTH', name: 'Unauthorized Cat' });
    expect(recCat.status).toBe(403);

    const recItem = await receptionistAgent
      .post('/api/inventory/items')
      .set('X-Property-Id', propAId)
      .send({ categoryId: NONEXISTENT_UUID, sku: 'SKU-1', name: 'Item 1' });
    expect(recItem.status).toBe(403);

    const recAdj = await receptionistAgent
      .post('/api/inventory/adjustments')
      .set('X-Property-Id', propAId)
      .send({
        productId: NONEXISTENT_UUID,
        operation: 'increase',
        quantity: 5,
        reason: 'Unauthorized increase',
      });
    expect(recAdj.status).toBe(403);

    // Malformed UUID route params -> 400 INVALID_IDENTIFIER
    for (const badPath of [
      '/api/suppliers/not-a-uuid',
      '/api/inventory/items/not-a-uuid',
      '/api/inventory/receipts/not-a-uuid',
      '/api/restaurant/menu-items/not-a-uuid/ingredients',
    ]) {
      const res = await adminAgent.get(badPath).set('X-Property-Id', propAId);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_IDENTIFIER');
    }

    // Malformed query params -> 400 validation error
    for (const badUrl of [
      '/api/inventory/items?categoryId=invalid',
      '/api/inventory/items?supplierId=invalid',
      '/api/inventory/items?stockFilter=bogus',
      '/api/inventory/receipts?page=abc',
      '/api/inventory/receipts?pageSize=101',
      '/api/inventory/movements?productId=bad',
      '/api/inventory/movements?movementType=bogus',
      '/api/inventory/movements?movementSource=bogus',
      '/api/inventory/movements?dateFrom=2026-13-45',
    ]) {
      const res = await receptionistAgent.get(badUrl).set('X-Property-Id', propAId);
      expect(res.status, `Expected 400 for ${badUrl}`).toBe(400);
    }
  });

  it('2. manages property-isolated suppliers with contact details and active status', async () => {
    const sup1 = await adminAgent
      .post('/api/suppliers')
      .set('X-Property-Id', propAId)
      .send({
        code: 'VND-KASHI',
        name: 'Kashi Fresh Dairy & Agro',
        contactPerson: 'Suresh Mishra',
        email: 'orders@kashidairy.example',
        phone: '+91 98390 11223',
        address: 'Industrial Estate, Varanasi',
        taxIdentifier: '09AABCK1122F1Z9',
        paymentTerms: 'Net 15',
      });
    expect(sup1.status).toBe(201);
    expect(sup1.body.supplier.code).toBe('VND-KASHI');
    expect(sup1.body.supplier.isActive).toBe(true);
    supplierDairyId = sup1.body.supplier.id;

    const sup2 = await adminAgent
      .post('/api/suppliers')
      .set('X-Property-Id', propAId)
      .send({
        code: 'VND-LINEN',
        name: 'Banaras Hospitality Linens',
        contactPerson: 'Kavita Rao',
        phone: '+91 98390 44556',
      });
    expect(sup2.status).toBe(201);
    supplierLinenId = sup2.body.supplier.id;

    // Duplicate supplier name (case-insensitive) within Property A -> 409
    const dupSup = await adminAgent
      .post('/api/suppliers')
      .set('X-Property-Id', propAId)
      .send({ name: 'kashi fresh dairy & agro' });
    expect(dupSup.status).toBe(409);

    // Same supplier name & code in Property B -> 201 (property-isolated)
    const supB = await adminAgent
      .post('/api/suppliers')
      .set('X-Property-Id', propBId)
      .send({ code: 'VND-KASHI', name: 'Kashi Fresh Dairy & Agro' });
    expect(supB.status).toBe(201);
    propBSupplierId = supB.body.supplier.id;

    // Property B supplier is not visible in Property A
    const crossGet = await receptionistAgent
      .get(`/api/suppliers/${propBSupplierId}`)
      .set('X-Property-Id', propAId);
    expect(crossGet.status).toBe(404);
  });

  it('3. creates inventory categories & items, tracks opening stock movements, and enforces ledger invariant', async () => {
    const cKitchen = await adminAgent
      .post('/api/inventory/categories')
      .set('X-Property-Id', propAId)
      .send({
        code: 'KITCHEN',
        name: 'Kitchen Ingredients',
        description: 'Perishables, dairy, gravies, spices',
        displayOrder: 1,
      });
    expect(cKitchen.status).toBe(201);
    catKitchenId = cKitchen.body.category.id;

    const cHk = await adminAgent
      .post('/api/inventory/categories')
      .set('X-Property-Id', propAId)
      .send({
        code: 'HK-LINEN',
        name: 'Housekeeping & Linen',
        displayOrder: 2,
      });
    expect(cHk.status).toBe(201);
    catHousekeepingId = cHk.body.category.id;

    const cPropB = await adminAgent
      .post('/api/inventory/categories')
      .set('X-Property-Id', propBId)
      .send({ code: 'KITCHEN', name: 'Kitchen Ingredients' });
    expect(cPropB.status).toBe(201);
    propBCatId = cPropB.body.category.id;

    // Reject cross-property supplier when creating item in Property A
    const crossSupItem = await adminAgent
      .post('/api/inventory/items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catKitchenId,
        supplierId: propBSupplierId,
        sku: 'ING-CROSS',
        name: 'Cross Property Test',
        unit: 'kg',
      });
    expect(crossSupItem.status).toBe(400);

    // Create Paneer with openingStock 2.00 kg, reorderLevel 3.00 kg -> immediately low_stock!
    const itPaneer = await adminAgent
      .post('/api/inventory/items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catKitchenId,
        supplierId: supplierDairyId,
        sku: 'ING-PANEER',
        name: 'Fresh Malai Paneer',
        unit: 'kg',
        openingStock: 2.0,
        reorderLevel: 3.0,
        unitCost: 380.0,
      });
    expect(itPaneer.status).toBe(201);
    expect(itPaneer.body.item.currentStock).toBe(2);
    expect(itPaneer.body.item.stockStatus).toBe('low_stock');
    expect(itPaneer.body.item.isLowStock).toBe(true);
    paneerItemId = itPaneer.body.item.id;

    // Create Gravy Base with 0 opening stock, reorderLevel 2.00 l -> out_of_stock
    const itGravy = await adminAgent
      .post('/api/inventory/items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catKitchenId,
        supplierId: supplierDairyId,
        sku: 'ING-GRAVY',
        name: 'Makhani Gravy Base',
        unit: 'l',
        openingStock: 0,
        reorderLevel: 2.0,
        unitCost: 220.0,
      });
    expect(itGravy.status).toBe(201);
    expect(itGravy.body.item.stockStatus).toBe('out_of_stock');
    gravyItemId = itGravy.body.item.id;

    // Create Milk with 10.00 l opening stock, reorderLevel 2.00 l -> in_stock
    const itMilk = await adminAgent
      .post('/api/inventory/items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catKitchenId,
        supplierId: supplierDairyId,
        sku: 'ING-MILK',
        name: 'Full Cream Milk',
        unit: 'l',
        openingStock: 10.0,
        reorderLevel: 2.0,
        unitCost: 68.0,
      });
    expect(itMilk.status).toBe(201);
    expect(itMilk.body.item.stockStatus).toBe('in_stock');
    milkItemId = itMilk.body.item.id;

    // Create Bath Towel with 10 pcs opening stock (no supplier initially)
    const itTowel = await adminAgent
      .post('/api/inventory/items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catHousekeepingId,
        sku: 'HK-TOWEL-BATH',
        name: 'Egyptian Cotton Bath Towel',
        unit: 'pcs',
        openingStock: 10,
        reorderLevel: 4,
        unitCost: 450,
      });
    expect(itTowel.status).toBe(201);
    towelItemId = itTowel.body.item.id;

    // Property B item with same SKU ING-PANEER -> allowed & isolated
    const itPropB = await adminAgent
      .post('/api/inventory/items')
      .set('X-Property-Id', propBId)
      .send({
        categoryId: propBCatId,
        sku: 'ING-PANEER',
        name: 'Goa Paneer Stock',
        unit: 'kg',
        openingStock: 25,
        reorderLevel: 5,
        unitCost: 400,
      });
    expect(itPropB.status).toBe(201);
    propBItemId = itPropB.body.item.id;

    // PUT /api/inventory/items/:id updates metadata without allowing silent currentStock override
    const editTowel = await adminAgent
      .put(`/api/inventory/items/${towelItemId}`)
      .set('X-Property-Id', propAId)
      .send({
        supplierId: supplierLinenId,
        reorderLevel: 5,
        currentStock: 9999, // must be ignored so movement ledger stays authoritative
      });
    expect(editTowel.status).toBe(200);
    expect(editTowel.body.item.currentStock).toBe(10);
    expect(editTowel.body.item.supplierId).toBe(supplierLinenId);

    // Summary & Dashboard notifications reflect exact low-stock & out-of-stock counts (2 low: Paneer + Gravy, 1 out: Gravy)
    const sumRes = await receptionistAgent
      .get('/api/inventory/summary')
      .set('X-Property-Id', propAId);
    expect(sumRes.status).toBe(200);
    expect(sumRes.body.summary.totalActiveItems).toBe(4);
    expect(sumRes.body.summary.lowStockCount).toBe(2);
    expect(sumRes.body.summary.outOfStockCount).toBe(1);

    const dashRes = await receptionistAgent
      .get('/api/dashboard')
      .set('X-Property-Id', propAId);
    expect(dashRes.status).toBe(200);
    expect(
      dashRes.body.notifications.some((n: any) => n.id === 'low-stock-inventory')
    ).toBe(true);
  });

  it('4. processes purchase/stock receipts transactionally with idempotency and atomic rollback', async () => {
    const idemKey = 'rcv-kashi-batch-001';
    const receiptPayload = {
      supplierId: supplierDairyId,
      vendorInvoiceNumber: 'KASHI-INV-771',
      receiptDate: propAToday,
      notes: 'Morning chilled delivery',
      idempotencyKey: idemKey,
      items: [
        { productId: paneerItemId, quantity: 3.0, unitCost: 390.0 },
        { productId: gravyItemId, quantity: 5.0, unitCost: 225.0 },
      ],
    };

    // Fire 2 concurrent submissions with the exact same idempotencyKey -> 1 receipt, stock added ONCE
    const [r1, r2] = await Promise.all([
      receptionistAgent
        .post('/api/inventory/receipts')
        .set('X-Property-Id', propAId)
        .send(receiptPayload),
      receptionistAgent
        .post('/api/inventory/receipts')
        .set('X-Property-Id', propAId)
        .send(receiptPayload),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 201]);
    expect(r1.body.receipt.id).toBe(r2.body.receipt.id);
    expect(r1.body.receipt.receiptNumber).toBe('KHB-RCV-1001');
    // 3 * 390 + 5 * 225 = 1170 + 1125 = 2295.00
    expect(r1.body.receipt.totalAmount).toBe(2295);

    // Reusing the same idempotencyKey with a modified payload -> 409 Conflict
    const mismatchedRetry = await receptionistAgent
      .post('/api/inventory/receipts')
      .set('X-Property-Id', propAId)
      .send({
        ...receiptPayload,
        items: [{ productId: paneerItemId, quantity: 9.0, unitCost: 390.0 }],
      });
    expect(mismatchedRetry.status).toBe(409);

    // Verify stock updated ONCE: Paneer 2 + 3 = 5.00 kg, Gravy 0 + 5 = 5.00 l
    const paneerAfter = await receptionistAgent
      .get(`/api/inventory/items/${paneerItemId}`)
      .set('X-Property-Id', propAId);
    expect(paneerAfter.body.item.currentStock).toBe(5);
    expect(paneerAfter.body.item.unitCost).toBe(390);
    expect(paneerAfter.body.item.stockStatus).toBe('in_stock');

    // Transactional rollback test: line 1 valid (Milk), line 2 cross-property item -> entire receipt rolls back
    const badBatch = await receptionistAgent
      .post('/api/inventory/receipts')
      .set('X-Property-Id', propAId)
      .send({
        supplierId: supplierDairyId,
        items: [
          { productId: milkItemId, quantity: 10, unitCost: 70 },
          { productId: propBItemId, quantity: 5, unitCost: 400 },
        ],
      });
    expect(badBatch.status).toBe(400);

    const milkCheck = await receptionistAgent
      .get(`/api/inventory/items/${milkItemId}`)
      .set('X-Property-Id', propAId);
    expect(milkCheck.body.item.currentStock).toBe(10); // Rolled back cleanly

    // Inactive supplier check: deactivating Linen supplier blocks new receipts against it
    await adminAgent
      .put(`/api/suppliers/${supplierLinenId}`)
      .set('X-Property-Id', propAId)
      .send({ isActive: false });

    const inactiveSupRcv = await receptionistAgent
      .post('/api/inventory/receipts')
      .set('X-Property-Id', propAId)
      .send({
        supplierId: supplierLinenId,
        items: [{ productId: towelItemId, quantity: 5, unitCost: 450 }],
      });
    expect(inactiveSupRcv.status).toBe(409);

    await adminAgent
      .put(`/api/suppliers/${supplierLinenId}`)
      .set('X-Property-Id', propAId)
      .send({ isActive: true });
  });

  it('5. enforces controlled stock adjustments, concurrent non-negative race safety, and DB ledger immutability', async () => {
    // Missing/short reason -> 400
    const badReason = await adminAgent
      .post('/api/inventory/adjustments')
      .set('X-Property-Id', propAId)
      .send({
        productId: towelItemId,
        operation: 'wastage',
        quantity: 1,
        reason: 'x',
      });
    expect(badReason.status).toBe(400);

    // Insufficient stock deduction (Towel has 10 pcs, requesting 15 pcs wastage) -> 409
    const overDeduct = await adminAgent
      .post('/api/inventory/adjustments')
      .set('X-Property-Id', propAId)
      .send({
        productId: towelItemId,
        operation: 'wastage',
        quantity: 15,
        reason: 'Damaged batch inspection',
      });
    expect(overDeduct.status).toBe(409);

    // Concurrency race test on Towel (10 pcs on hand):
    // Fire 5 parallel deductions of 4 pcs each -> exactly 2 succeed (10 -> 6 -> 2), 3 fail with 409!
    const raceResults = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        adminAgent
          .post('/api/inventory/adjustments')
          .set('X-Property-Id', propAId)
          .send({
            productId: towelItemId,
            operation: 'department_issue',
            quantity: 4,
            reason: `Floor linen issue batch #${idx + 1}`,
          })
      )
    );

    const okCount = raceResults.filter((r) => r.status === 201).length;
    const conflictCount = raceResults.filter((r) => r.status === 409).length;
    expect(okCount).toBe(2);
    expect(conflictCount).toBe(3);

    const towelCheck = await adminAgent
      .get(`/api/inventory/items/${towelItemId}`)
      .set('X-Property-Id', propAId);
    expect(towelCheck.body.item.currentStock).toBe(2);
    expect(towelCheck.body.item.stockStatus).toBe('low_stock'); // 2 <= reorderLevel 5

    // Adjustment idempotency check
    const adjIdem = 'adj-wastage-milk-01';
    const [adj1, adj2] = await Promise.all([
      adminAgent
        .post('/api/inventory/adjustments')
        .set('X-Property-Id', propAId)
        .send({
          productId: milkItemId,
          operation: 'wastage',
          quantity: 1.0,
          reason: 'Opened carton expired at shift close',
          idempotencyKey: adjIdem,
        }),
      adminAgent
        .post('/api/inventory/adjustments')
        .set('X-Property-Id', propAId)
        .send({
          productId: milkItemId,
          operation: 'wastage',
          quantity: 1.0,
          reason: 'Opened carton expired at shift close',
          idempotencyKey: adjIdem,
        }),
    ]);
    expect([adj1.status, adj2.status].sort()).toEqual([200, 201]);

    const milkAfterAdj = await adminAgent
      .get(`/api/inventory/items/${milkItemId}`)
      .set('X-Property-Id', propAId);
    expect(milkAfterAdj.body.item.currentStock).toBe(9); // 10 - 1 = 9.00 l

    // Database-level immutability trigger check on stock_movements
    const pool = getPool();
    await expect(
      pool.query("UPDATE stock_movements SET reason = 'tampered' WHERE id = $1", [
        adj1.body.movement.id,
      ])
    ).rejects.toThrow(/immutable/i);

    await expect(
      pool.query('DELETE FROM stock_movements WHERE id = $1', [adj1.body.movement.id])
    ).rejects.toThrow(/immutable/i);
  });

  it('6. integrates menu recipes, deducts transactionally on pending->preparing, rolls back insufficient stock, and enforces explicit cancellation/reversal policy', async () => {
    // Setup Food Category & 3 Menu Items (Paneer Tikka Masala, Masala Chai, Plain Naan)
    const fCat = await adminAgent
      .post('/api/restaurant/categories')
      .set('X-Property-Id', propAId)
      .send({ code: 'KITCHEN-SPEC', name: 'Signature Kitchen', displayOrder: 1 });
    expect(fCat.status).toBe(201);
    foodCatMainsId = fCat.body.category.id;

    const mPaneer = await adminAgent
      .post('/api/restaurant/menu-items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: foodCatMainsId,
        sku: 'FD-PANEER-MASALA',
        name: 'Paneer Tikka Masala',
        price: 420,
        dietaryTag: 'veg',
      });
    expect(mPaneer.status).toBe(201);
    dishPaneerId = mPaneer.body.menuItem.id;

    const mChai = await adminAgent
      .post('/api/restaurant/menu-items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: foodCatMainsId,
        sku: 'FD-CHAI',
        name: 'Banarasi Masala Chai',
        price: 120,
        dietaryTag: 'beverage',
      });
    expect(mChai.status).toBe(201);
    dishChaiId = mChai.body.menuItem.id;

    const mNaan = await adminAgent
      .post('/api/restaurant/menu-items')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: foodCatMainsId,
        sku: 'FD-NAAN',
        name: 'Tandoori Butter Naan',
        price: 90,
        dietaryTag: 'veg',
      });
    expect(mNaan.status).toBe(201);
    dishNaanNoRecipeId = mNaan.body.menuItem.id;

    // Receptionist forbidden from editing menu recipes (403)
    const recRecipe = await receptionistAgent
      .put(`/api/restaurant/menu-items/${dishPaneerId}/ingredients`)
      .set('X-Property-Id', propAId)
      .send({ ingredients: [{ productId: paneerItemId, quantityRequired: 0.25 }] });
    expect(recRecipe.status).toBe(403);

    // Cross-property ingredient rejected (400)
    const crossIng = await adminAgent
      .put(`/api/restaurant/menu-items/${dishPaneerId}/ingredients`)
      .set('X-Property-Id', propAId)
      .send({ ingredients: [{ productId: propBItemId, quantityRequired: 0.25 }] });
    expect(crossIng.status).toBe(400);

    // Duplicate ingredient in same recipe rejected (400)
    const dupIng = await adminAgent
      .put(`/api/restaurant/menu-items/${dishPaneerId}/ingredients`)
      .set('X-Property-Id', propAId)
      .send({
        ingredients: [
          { productId: paneerItemId, quantityRequired: 0.2 },
          { productId: paneerItemId, quantityRequired: 0.1 },
        ],
      });
    expect(dupIng.status).toBe(400);

    // Map valid recipes:
    // 1x Paneer Tikka Masala = 0.50 kg Paneer + 0.30 l Gravy Base
    const savePaneerRecipe = await adminAgent
      .put(`/api/restaurant/menu-items/${dishPaneerId}/ingredients`)
      .set('X-Property-Id', propAId)
      .send({
        ingredients: [
          { productId: paneerItemId, quantityRequired: 0.5 },
          { productId: gravyItemId, quantityRequired: 0.3 },
        ],
      });
    expect(savePaneerRecipe.status).toBe(200);
    expect(savePaneerRecipe.body.menuItem.ingredientCount).toBe(2);

    // 1x Masala Chai = 0.20 l Milk
    const saveChaiRecipe = await adminAgent
      .put(`/api/restaurant/menu-items/${dishChaiId}/ingredients`)
      .set('X-Property-Id', propAId)
      .send({
        ingredients: [{ productId: milkItemId, quantityRequired: 0.2 }],
      });
    expect(saveChaiRecipe.status).toBe(200);

    // Current stock before orders: Paneer = 5.00 kg, Gravy = 5.00 l, Milk = 9.00 l

    // Case A: Place Pending Order -> Cancel BEFORE Prep ('pending -> cancelled')
    // Must deduct 0 stock and restore 0 stock!
    const prePrepOrder = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'restaurant',
        tableLabel: 'Table 2',
        items: [{ menuItemId: dishPaneerId, quantity: 2 }],
      });
    expect(prePrepOrder.status).toBe(201);
    expect(prePrepOrder.body.order.inventoryDeductedAt).toBeNull();

    const cancelPrePrep = await receptionistAgent
      .post(`/api/restaurant/orders/${prePrepOrder.body.order.id}/cancel`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Guest changed order before kitchen started' });
    expect(cancelPrePrep.status).toBe(200);
    expect(cancelPrePrep.body.order.stockMovements).toHaveLength(0);

    // Duplicate cancel attempt -> 409, stock still 5.00 kg
    const dupCancelPre = await receptionistAgent
      .post(`/api/restaurant/orders/${prePrepOrder.body.order.id}/cancel`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Duplicate cancel attempt' });
    expect(dupCancelPre.status).toBe(409);

    // Case B: Multi-ingredient Insufficient Stock Atomic Rollback!
    // Order 12x Paneer (needs 6.00 kg Paneer, only 5.00 kg available!) + 2x Chai (needs 0.40 l Milk, 9.00 l available)
    const oversizeOrder = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'takeaway',
        customerName: 'Banquet Enquiry',
        items: [
          { menuItemId: dishPaneerId, quantity: 12 },
          { menuItemId: dishChaiId, quantity: 2 },
        ],
      });
    expect(oversizeOrder.status).toBe(201);

    const blockedPrep = await receptionistAgent
      .post(`/api/restaurant/orders/${oversizeOrder.body.order.id}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'preparing' });
    expect(blockedPrep.status).toBe(409);
    expect(blockedPrep.body.error.details.reason).toBe('INSUFFICIENT_STOCK');

    // Verify NEITHER Paneer NOR Milk was deducted, and order remained 'pending'!
    const [paneerCheckB, milkCheckB, oversizeDetail] = await Promise.all([
      receptionistAgent
        .get(`/api/inventory/items/${paneerItemId}`)
        .set('X-Property-Id', propAId),
      receptionistAgent
        .get(`/api/inventory/items/${milkItemId}`)
        .set('X-Property-Id', propAId),
      receptionistAgent
        .get(`/api/restaurant/orders/${oversizeOrder.body.order.id}`)
        .set('X-Property-Id', propAId),
    ]);
    expect(paneerCheckB.body.item.currentStock).toBe(5);
    expect(milkCheckB.body.item.currentStock).toBe(9);
    expect(oversizeDetail.body.order.status).toBe('pending');

    // Cleanly cancel the unstarted oversize order
    await receptionistAgent
      .post(`/api/restaurant/orders/${oversizeOrder.body.order.id}/cancel`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Insufficient banquet stock' });

    // Case C: Concurrent 'pending -> preparing' race + full lifecycle through 'served' + Room Service Folio Reversal
    // Create an in-house checked-in reservation for Room 101
    const resCreate = await receptionistAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestAId,
        roomTypeId: dlxTypeId,
        roomId: room101Id,
        arrivalDate: propAToday,
        departureDate: addDays(propAToday, 2),
        adults: 2,
        children: 0,
        status: 'confirmed',
      });
    expect(resCreate.status).toBe(201);
    const reservationId = resCreate.body.reservation.id as string;

    const checkIn = await receptionistAgent
      .post(`/api/reservations/${reservationId}/check-in`)
      .set('X-Property-Id', propAId)
      .send({ roomId: room101Id });
    expect(checkIn.status).toBe(200);

    // Place Room Service order: 2x Paneer (1.00 kg Paneer, 0.60 l Gravy) + 2x Chai (0.40 l Milk) + 2x Plain Naan (no recipe)
    const rsOrderRes = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'room_service',
        reservationId,
        items: [
          { menuItemId: dishPaneerId, quantity: 2 },
          { menuItemId: dishChaiId, quantity: 2 },
          { menuItemId: dishNaanNoRecipeId, quantity: 2 },
        ],
      });
    expect(rsOrderRes.status).toBe(201);
    const rsOrderId = rsOrderRes.body.order.id as string;

    // Fire 2 concurrent 'preparing' transitions -> only 1 succeeds (200), the other rejects (400), stock deducted ONCE!
    const [prepA, prepB] = await Promise.all([
      receptionistAgent
        .post(`/api/restaurant/orders/${rsOrderId}/status`)
        .set('X-Property-Id', propAId)
        .send({ status: 'preparing' }),
      receptionistAgent
        .post(`/api/restaurant/orders/${rsOrderId}/status`)
        .set('X-Property-Id', propAId)
        .send({ status: 'preparing' }),
    ]);
    expect([prepA.status, prepB.status].sort()).toEqual([200, 400]);

    const winnerPrep = prepA.status === 200 ? prepA : prepB;
    expect(winnerPrep.body.order.inventoryDeductedAt).toBeTruthy();
    expect(winnerPrep.body.order.stockMovements).toHaveLength(3);

    // Advance 'preparing -> ready -> served' -> ZERO extra deductions!
    const toReady = await receptionistAgent
      .post(`/api/restaurant/orders/${rsOrderId}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'ready' });
    expect(toReady.status).toBe(200);

    const toServed = await receptionistAgent
      .post(`/api/restaurant/orders/${rsOrderId}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'served' });
    expect(toServed.status).toBe(200);

    // Expected stock: Paneer = 5 - 1 = 4.00 kg, Gravy = 5 - 0.60 = 4.40 l, Milk = 9 - 0.40 = 8.60 l
    const [pAfterServed, gAfterServed, mAfterServed] = await Promise.all([
      receptionistAgent.get(`/api/inventory/items/${paneerItemId}`).set('X-Property-Id', propAId),
      receptionistAgent.get(`/api/inventory/items/${gravyItemId}`).set('X-Property-Id', propAId),
      receptionistAgent.get(`/api/inventory/items/${milkItemId}`).set('X-Property-Id', propAId),
    ]);
    expect(pAfterServed.body.item.currentStock).toBe(4);
    expect(gAfterServed.body.item.currentStock).toBe(4.4);
    expect(mAfterServed.body.item.currentStock).toBe(8.6);

    // Post Room Service order to Invoice -> invoice NEVER auto-marked paid; reverse charge -> stock NEVER restored!
    const postFolio = await receptionistAgent
      .post(`/api/restaurant/orders/${rsOrderId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({ createDraftInvoiceIfMissing: true });
    expect(postFolio.status).toBe(200);
    expect(postFolio.body.invoice.status).not.toBe('paid');

    const revFolio = await adminAgent
      .post(`/api/restaurant/orders/${rsOrderId}/reverse-charge`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Complimentary welcome dinner courtesy of GM' });
    expect(revFolio.status).toBe(200);
    expect(revFolio.body.order.billingStatus).toBe('reversed');

    // Case D: Post-prep cancellation ('preparing -> cancelled') -> stock NOT auto-restored!
    const postPrepOrder = await receptionistAgent
      .post('/api/restaurant/orders')
      .set('X-Property-Id', propAId)
      .send({
        orderType: 'restaurant',
        tableLabel: 'Table 9',
        items: [{ menuItemId: dishChaiId, quantity: 3 }], // deducts 0.60 l Milk -> 8.60 - 0.60 = 8.00 l
      });
    expect(postPrepOrder.status).toBe(201);

    const startChaiPrep = await receptionistAgent
      .post(`/api/restaurant/orders/${postPrepOrder.body.order.id}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'preparing' });
    expect(startChaiPrep.status).toBe(200);

    const cancelAfterPrep = await receptionistAgent
      .post(`/api/restaurant/orders/${postPrepOrder.body.order.id}/cancel`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Guest walked out mid-preparation' });
    expect(cancelAfterPrep.status).toBe(200);
    expect(cancelAfterPrep.body.order.status).toBe('cancelled');

    // Verify Milk remains at 8.00 l (no unintended auto-restoration of brewed tea!)
    const milkFinal = await receptionistAgent
      .get(`/api/inventory/items/${milkItemId}`)
      .set('X-Property-Id', propAId);
    expect(milkFinal.body.item.currentStock).toBe(8);
  });

  it('7. delivers accurate inventory movement reports & preserves SUM(quantity_delta) === current_stock across all items', async () => {
    const movAll = await receptionistAgent
      .get('/api/inventory/movements')
      .set('X-Property-Id', propAId);
    expect(movAll.status).toBe(200);
    expect(movAll.body.total).toBeGreaterThanOrEqual(9);
    expect(movAll.body.summary.orderConsumptionCount).toBe(4); // 3 from rsOrder + 1 from postPrepOrder
    expect(movAll.body.summary.receiptsMovementCount).toBe(2); // Paneer + Gravy on KHB-RCV-1001

    // Filter strictly to order_consumption movements
    const movOrdersOnly = await receptionistAgent
      .get('/api/inventory/movements?movementSource=order_consumption')
      .set('X-Property-Id', propAId);
    expect(movOrdersOnly.status).toBe(200);
    expect(movOrdersOnly.body.total).toBe(4);
    expect(
      movOrdersOnly.body.items.every(
        (m: any) => m.movementSource === 'order_consumption' && m.quantityDelta < 0
      )
    ).toBe(true);

    // Mathematical ledger invariant check in PostgreSQL:
    // For EVERY product in EVERY property, SUM(stock_movements.quantity_delta) MUST equal inventory_products.current_stock!
    const pool = getPool();
    const ledgerAudit = await pool.query(`
      SELECT ip.id,
             ip.sku,
             ip.current_stock::numeric(12,2) AS current_stock,
             COALESCE(SUM(sm.quantity_delta), 0)::numeric(12,2) AS sum_delta
      FROM inventory_products ip
      LEFT JOIN stock_movements sm
        ON sm.product_id = ip.id AND sm.property_id = ip.property_id
      GROUP BY ip.id, ip.sku, ip.current_stock
    `);

    expect(ledgerAudit.rowCount).toBe(5);
    for (const row of ledgerAudit.rows) {
      expect(
        Number(row.current_stock),
        `Ledger mismatch on ${row.sku}: current_stock=${row.current_stock}, sum_delta=${row.sum_delta}`
      ).toBe(Number(row.sum_delta));
    }
  });
});
