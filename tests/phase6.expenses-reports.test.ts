import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, diffDays, getPropertyLocalDate } from '../src/shared/dates.js';
import { createApiApp } from '../src/server/app.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { getPool } from '../src/server/db/pool.js';
import { hashPassword } from '../src/server/security/password.js';

const app = createApiApp();

let propAId = '';
let propBId = '';
let roomTypeAId = '';
let roomA1Id = '';
let roomA2Id = '';
let guestAId = '';

let catUtilitiesId = '';
let catMaintenanceId = '';
let supplierActiveId = '';
let supplierInactiveId = '';
let propBSupplierId = '';
let propBCategoryId = '';

let adminAgent: ReturnType<typeof supertest.agent>;
let recAgent: ReturnType<typeof supertest.agent>;
let propBOnlyAdminAgent: ReturnType<typeof supertest.agent>;

async function assertTestDatabaseOnly(): Promise<void> {
  const pool = getPool();
  const dbCheck = await pool.query<{ db_name: string }>(
    'SELECT current_database() AS db_name'
  );
  const connectedDb = String(dbCheck.rows[0]?.db_name ?? '');
  if (connectedDb !== 'staycraft_pms_test') {
    throw new Error(
      `ABORTING PHASE 6 TEST SUITE: Expected isolated staycraft_pms_test database, got "${connectedDb}"`
    );
  }
}

beforeAll(async () => {
  await assertTestDatabaseOnly();
  await runMigrations();

  const pool = getPool();
  const suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`.toUpperCase();

  const adminEmail = `p6.admin.${suffix.toLowerCase()}@staycraft.local`;
  const recEmail = `p6.rec.${suffix.toLowerCase()}@staycraft.local`;
  const propBAdminEmail = `p6.badmin.${suffix.toLowerCase()}@staycraft.local`;

  const adminHash = await hashPassword('Phase6Admin#2026');
  const recHash = await hashPassword('Phase6Rec#2026');

  const uAdmin = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, 'Phase 6 Admin', 'admin')
     RETURNING id`,
    [adminEmail, adminHash]
  );
  const uRec = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, 'Phase 6 Receptionist', 'receptionist')
     RETURNING id`,
    [recEmail, recHash]
  );
  const uPropBAdmin = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, 'Prop B Only Admin', 'admin')
     RETURNING id`,
    [propBAdminEmail, adminHash]
  );

  const adminId = String(uAdmin.rows[0].id);
  const recId = String(uRec.rows[0].id);
  const propBAdminId = String(uPropBAdmin.rows[0].id);

  const propARes = await pool.query(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name
     ) VALUES (
       $1, $2, 'p6a@staycraft.local', '+91 91111 00001', '10 Assi Ghat', 'Varanasi', 'India',
       'Asia/Kolkata', 'INR', 12.00, 'GST'
     ) RETURNING id`,
    [`P6A${suffix.slice(0, 5)}`, `Phase 6 Heritage Hotel ${suffix}`]
  );
  propAId = String(propARes.rows[0].id);

  const propBRes = await pool.query(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name
     ) VALUES (
       $1, $2, 'p6b@staycraft.local', '+91 91111 00002', '22 Marine Lines', 'Mumbai', 'India',
       'Asia/Kolkata', 'INR', 18.00, 'GST'
     ) RETURNING id`,
    [`P6B${suffix.slice(0, 5)}`, `Phase 6 Coastal Suites ${suffix}`]
  );
  propBId = String(propBRes.rows[0].id);

  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id, is_default)
     VALUES
       ($1, $2, TRUE),
       ($1, $3, FALSE),
       ($4, $2, TRUE),
       ($5, $3, TRUE)`,
    [adminId, propAId, propBId, recId, propBAdminId]
  );

  // Create 2 active sellable rooms in Property A for deterministic occupancy calculations
  const rtRes = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'DLX', 'Deluxe Courtyard', 2, 3, 5000.00)
     RETURNING id`,
    [propAId]
  );
  roomTypeAId = String(rtRes.rows[0].id);

  const r1 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status, is_active)
     VALUES ($1, $2, '101', '1', 'clean', 'available', TRUE)
     RETURNING id`,
    [propAId, roomTypeAId]
  );
  roomA1Id = String(r1.rows[0].id);

  const r2 = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status, is_active)
     VALUES ($1, $2, '102', '1', 'inspected', 'available', TRUE)
     RETURNING id`,
    [propAId, roomTypeAId]
  );
  roomA2Id = String(r2.rows[0].id);

  const gRes = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'Vikram', 'Sethi', 'vikram.p6@example.com', '+91 98100 77889')
     RETURNING id`,
    [propAId]
  );
  guestAId = String(gRes.rows[0].id);

  // Create active + inactive suppliers in Property A, plus a supplier in Property B
  const supActive = await pool.query(
    `INSERT INTO suppliers (property_id, code, name, contact_person, is_active, created_by, updated_by)
     VALUES ($1, 'SUP-PWR', 'Varanasi Power & Electricals', 'Manoj Verma', TRUE, $2, $2)
     RETURNING id`,
    [propAId, adminId]
  );
  supplierActiveId = String(supActive.rows[0].id);

  const supInactive = await pool.query(
    `INSERT INTO suppliers (property_id, code, name, contact_person, is_active, created_by, updated_by)
     VALUES ($1, 'SUP-OLD', 'Legacy Plumbing Co', 'Rakesh Singh', FALSE, $2, $2)
     RETURNING id`,
    [propAId, adminId]
  );
  supplierInactiveId = String(supInactive.rows[0].id);

  const supPropB = await pool.query(
    `INSERT INTO suppliers (property_id, code, name, contact_person, is_active, created_by, updated_by)
     VALUES ($1, 'SUP-MUM', 'Mumbai Linen Services', 'Kiran Shah', TRUE, $2, $2)
     RETURNING id`,
    [propBId, propBAdminId]
  );
  propBSupplierId = String(supPropB.rows[0].id);

  // Sign in all 3 test agents via real session auth
  adminAgent = supertest.agent(app);
  const loginAdmin = await adminAgent
    .post('/api/auth/login')
    .send({ email: adminEmail, password: 'Phase6Admin#2026' });
  expect(loginAdmin.status).toBe(200);

  recAgent = supertest.agent(app);
  const loginRec = await recAgent
    .post('/api/auth/login')
    .send({ email: recEmail, password: 'Phase6Rec#2026' });
  expect(loginRec.status).toBe(200);

  propBOnlyAdminAgent = supertest.agent(app);
  const loginPropB = await propBOnlyAdminAgent
    .post('/api/auth/login')
    .send({ email: propBAdminEmail, password: 'Phase6Admin#2026' });
  expect(loginPropB.status).toBe(200);
});

describe('Phase 6 — Operating Expenses, Expense Categories & Financial/Operational Reports', () => {
  it('1. enforces authentication (401) and role-based permissions (403) across expenses and reports', async () => {
    const unauthExpenses = await supertest(app).get('/api/expenses');
    expect(unauthExpenses.status).toBe(401);

    const unauthCats = await supertest(app).get('/api/expenses/categories');
    expect(unauthCats.status).toBe(401);

    const unauthReport = await supertest(app).get('/api/reports/overview');
    expect(unauthReport.status).toBe(401);

    // Receptionist cannot create expense categories (admin-only)
    const recCreateCat = await recAgent
      .post('/api/expenses/categories')
      .set('X-Property-Id', propAId)
      .send({
        code: 'UNAUTH_CAT',
        name: 'Unauthorized Category',
      });
    expect(recCreateCat.status).toBe(403);
  });

  it('2. manages property-scoped expense categories, blocks duplicates, and preserves history on deactivation', async () => {
    await assertTestDatabaseOnly();

    const createUtil = await adminAgent
      .post('/api/expenses/categories')
      .set('X-Property-Id', propAId)
      .send({
        code: 'utilities',
        name: 'Electricity & Water Utilities',
        description: 'Monthly power, diesel generator, and municipal water bills.',
        displayOrder: 10,
      });
    expect(createUtil.status).toBe(201);
    expect(createUtil.body.category.code).toBe('UTILITIES');
    catUtilitiesId = createUtil.body.category.id;

    const createMaint = await adminAgent
      .post('/api/expenses/categories')
      .set('X-Property-Id', propAId)
      .send({
        code: 'MAINTENANCE',
        name: 'Facility Repairs & AMC',
        description: 'HVAC, plumbing, electrical, and carpentry upkeep.',
        displayOrder: 20,
      });
    expect(createMaint.status).toBe(201);
    catMaintenanceId = createMaint.body.category.id;

    // Duplicate code in same property -> 409
    const dupCode = await adminAgent
      .post('/api/expenses/categories')
      .set('X-Property-Id', propAId)
      .send({
        code: 'UTILITIES',
        name: 'Different Name',
      });
    expect(dupCode.status).toBe(409);

    // Duplicate case-insensitive name in same property -> 409
    const dupName = await adminAgent
      .post('/api/expenses/categories')
      .set('X-Property-Id', propAId)
      .send({
        code: 'UTIL_2',
        name: 'electricity & water utilities',
      });
    expect(dupName.status).toBe(409);

    // Same code/name in Property B is allowed (property-scoped isolation)
    const propBCat = await propBOnlyAdminAgent
      .post('/api/expenses/categories')
      .set('X-Property-Id', propBId)
      .send({
        code: 'UTILITIES',
        name: 'Electricity & Water Utilities',
      });
    expect(propBCat.status).toBe(201);
    propBCategoryId = propBCat.body.category.id;

    // Create and cleanly delete an unused category
    const unusedCat = await adminAgent
      .post('/api/expenses/categories')
      .set('X-Property-Id', propAId)
      .send({
        code: 'TEMP_UNUSED',
        name: 'Temporary Unused Category',
      });
    expect(unusedCat.status).toBe(201);

    const delUnused = await adminAgent
      .delete(`/api/expenses/categories/${unusedCat.body.category.id}`)
      .set('X-Property-Id', propAId);
    expect(delUnused.status).toBe(200);
    expect(delUnused.body.deleted).toBe(true);

    // Receptionist records an operating expense under MAINTENANCE
    const recExpense = await recAgent
      .post('/api/expenses')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catMaintenanceId,
        supplierId: supplierActiveId,
        title: 'Lobby AC Compressor Servicing',
        description: 'Replaced capacitor and refilled refrigerant on Daikin split unit.',
        amount: 2400.5,
        taxAmount: 288.06,
        expenseDate: '2026-10-10',
        paymentMethod: 'upi',
        referenceNumber: 'UPI-990112',
        notes: 'Verified by front office supervisor.',
      });
    expect(recExpense.status).toBe(201);
    const maintExpenseId = recExpense.body.expense.id;
    expect(recExpense.body.expense.vendorName).toBe('Varanasi Power & Electricals');
    expect(recExpense.body.expense.recordedByName).toBe('Phase 6 Receptionist');

    // Deleting a category referenced by historical expenses must fail with 409
    const delReferenced = await adminAgent
      .delete(`/api/expenses/categories/${catMaintenanceId}`)
      .set('X-Property-Id', propAId);
    expect(delReferenced.status).toBe(409);

    // Deactivating the category succeeds and preserves historical expense records
    const deactivateMaint = await adminAgent
      .put(`/api/expenses/categories/${catMaintenanceId}`)
      .set('X-Property-Id', propAId)
      .send({ isActive: false });
    expect(deactivateMaint.status).toBe(200);
    expect(deactivateMaint.body.category.isActive).toBe(false);
    expect(deactivateMaint.body.category.recordedExpenseCount).toBe(1);

    // Historical expense remains intact with categoryName preserved and categoryIsActive=false
    const checkHistorical = await recAgent
      .get(`/api/expenses/${maintExpenseId}`)
      .set('X-Property-Id', propAId);
    expect(checkHistorical.status).toBe(200);
    expect(checkHistorical.body.expense.categoryName).toBe('Facility Repairs & AMC');
    expect(checkHistorical.body.expense.categoryIsActive).toBe(false);

    // New expenses cannot be created under a deactivated category -> 409
    const blockedNew = await adminAgent
      .post('/api/expenses')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catMaintenanceId,
        title: 'Blocked New Maintenance Voucher',
        amount: 500,
        expenseDate: '2026-10-11',
        paymentMethod: 'cash',
      });
    expect(blockedNew.status).toBe(409);

    // Reactivate MAINTENANCE for subsequent tests
    const reactivate = await adminAgent
      .put(`/api/expenses/categories/${catMaintenanceId}`)
      .set('X-Property-Id', propAId)
      .send({ isActive: true });
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.category.isActive).toBe(true);
  });

  it('3. supports full expense CRUD, auditable voiding, immutable history, and active-vs-voided totals separation', async () => {
    await assertTestDatabaseOnly();

    // Create second expense under UTILITIES
    const createUtilExp = await adminAgent
      .post('/api/expenses')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catUtilitiesId,
        vendorName: 'Purvanchal Vidyut Vitran Nigam',
        title: 'October Electricity Bill — Main Meter',
        description: 'Commercial tariff HT feeder consumption.',
        amount: 14500.0,
        taxAmount: 0,
        expenseDate: '2026-10-12',
        paymentMethod: 'bank_transfer',
        referenceNumber: 'NEFT-772819',
      });
    expect(createUtilExp.status).toBe(201);
    const utilExpenseId = createUtilExp.body.expense.id;
    expect(createUtilExp.body.expense.expenseNumber).toContain('-EXP-');

    // Receptionist cannot edit or void an existing expense -> 403
    const recEdit = await recAgent
      .put(`/api/expenses/${utilExpenseId}`)
      .set('X-Property-Id', propAId)
      .send({ amount: 15000 });
    expect(recEdit.status).toBe(403);

    const recVoid = await recAgent
      .post(`/api/expenses/${utilExpenseId}/void`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Receptionist attempted void' });
    expect(recVoid.status).toBe(403);

    // Admin edits the UTILITIES expense
    const editRes = await adminAgent
      .put(`/api/expenses/${utilExpenseId}`)
      .set('X-Property-Id', propAId)
      .send({
        amount: 15000.0,
        notes: 'Adjusted to include fixed demand surcharge.',
      });
    expect(editRes.status).toBe(200);
    expect(editRes.body.expense.amount).toBe(15000);
    expect(editRes.body.expense.history).toHaveLength(2);
    expect(editRes.body.expense.history[1].action).toBe('updated');

    // Create a duplicate/erroneous expense and then void it with an auditable reason
    const errExp = await adminAgent
      .post('/api/expenses')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catUtilitiesId,
        vendorName: 'Duplicate Diesel Entry',
        title: 'Erroneous Generator Fuel Entry',
        amount: 3200.0,
        taxAmount: 384.0,
        expenseDate: '2026-10-13',
        paymentMethod: 'cash',
      });
    expect(errExp.status).toBe(201);
    const voidTargetId = errExp.body.expense.id;

    // Missing/short void reason -> 400
    const badVoid = await adminAgent
      .post(`/api/expenses/${voidTargetId}/void`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'x' });
    expect(badVoid.status).toBe(400);

    // Valid void -> 200
    const voidRes = await adminAgent
      .post(`/api/expenses/${voidTargetId}/void`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Entered twice by mistake; voided per duty manager.' });
    expect(voidRes.status).toBe(200);
    expect(voidRes.body.expense.status).toBe('voided');
    expect(voidRes.body.expense.voidReason).toContain('Entered twice');
    expect(voidRes.body.expense.voidedByName).toBe('Phase 6 Admin');
    expect(voidRes.body.expense.history.map((h: any) => h.action)).toEqual([
      'created',
      'voided',
    ]);

    // Voided expense cannot be voided again (409) or edited (409)
    const reVoid = await adminAgent
      .post(`/api/expenses/${voidTargetId}/void`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Second void attempt' });
    expect(reVoid.status).toBe(409);

    const editVoided = await adminAgent
      .put(`/api/expenses/${voidTargetId}/void`.replace('/void', ''))
      .set('X-Property-Id', propAId)
      .send({ title: 'Mutating voided expense' });
    expect(editVoided.status).toBe(409);

    // Verify expense_history database trigger blocks row-level UPDATE (immutability)
    const pool = getPool();
    const historyRow = voidRes.body.expense.history[0];
    await expect(
      pool.query('UPDATE expense_history SET reason = $1 WHERE id = $2', [
        'Tampered',
        historyRow.id,
      ])
    ).rejects.toThrow(/Expense audit history cannot be modified/);

    // Verify listExpenses excludes voided expenses from recordedTotal while keeping voided visible in history!
    // Recorded expenses so far in Oct 2026: 2400.50 (MAINTENANCE) + 15000.00 (UTILITIES) = 17400.50
    // Voided expenses so far in Oct 2026: 3200.00
    const listAll = await adminAgent
      .get('/api/expenses?dateFrom=2026-10-01&dateTo=2026-10-31&status=all')
      .set('X-Property-Id', propAId);
    expect(listAll.status).toBe(200);
    expect(listAll.body.items).toHaveLength(3);
    expect(listAll.body.summary.recordedCount).toBe(2);
    expect(listAll.body.summary.recordedTotal).toBe(17400.5);
    expect(listAll.body.summary.voidedCount).toBe(1);
    expect(listAll.body.summary.voidedTotal).toBe(3200);

    // Filtering status=recorded returns only the 2 active vouchers, while summary still tracks both
    const listRecordedOnly = await adminAgent
      .get('/api/expenses?dateFrom=2026-10-01&dateTo=2026-10-31&status=recorded')
      .set('X-Property-Id', propAId);
    expect(listRecordedOnly.status).toBe(200);
    expect(listRecordedOnly.body.items).toHaveLength(2);
    expect(
      listRecordedOnly.body.items.every((e: any) => e.status === 'recorded')
    ).toBe(true);
  });

  it('4. validates malformed UUIDs, dates, numeric bounds, inactive suppliers, and pagination', async () => {
    const badId = await adminAgent
      .get('/api/expenses/not-a-uuid')
      .set('X-Property-Id', propAId);
    expect(badId.status).toBe(400);

    const badCatFilter = await adminAgent
      .get('/api/expenses?categoryId=invalid-uuid')
      .set('X-Property-Id', propAId);
    expect(badCatFilter.status).toBe(400);

    const badPage = await adminAgent
      .get('/api/expenses?page=0')
      .set('X-Property-Id', propAId);
    expect(badPage.status).toBe(400);

    const badPageSize = await adminAgent
      .get('/api/expenses?pageSize=500')
      .set('X-Property-Id', propAId);
    expect(badPageSize.status).toBe(400);

    const invertedDates = await adminAgent
      .get('/api/expenses?dateFrom=2026-10-25&dateTo=2026-10-10')
      .set('X-Property-Id', propAId);
    expect(invertedDates.status).toBe(400);

    const badReportDates = await adminAgent
      .get('/api/reports/overview?dateFrom=2026-02-30&dateTo=2026-03-05')
      .set('X-Property-Id', propAId);
    expect(badReportDates.status).toBe(400);

    // Zero or negative amount -> 400
    const negAmount = await adminAgent
      .post('/api/expenses')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catUtilitiesId,
        title: 'Invalid Zero Expense',
        amount: 0,
        expenseDate: '2026-10-14',
        paymentMethod: 'cash',
      });
    expect(negAmount.status).toBe(400);

    // Tax exceeding amount -> 400
    const excessTax = await adminAgent
      .post('/api/expenses')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catUtilitiesId,
        title: 'Invalid Tax Exceeds Total',
        amount: 100,
        taxAmount: 120,
        expenseDate: '2026-10-14',
        paymentMethod: 'cash',
      });
    expect(excessTax.status).toBe(400);

    // Inactive supplier rejected -> 409
    const inactiveSup = await adminAgent
      .post('/api/expenses')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catUtilitiesId,
        supplierId: supplierInactiveId,
        title: 'Inactive Supplier Test',
        amount: 500,
        expenseDate: '2026-10-14',
        paymentMethod: 'cash',
      });
    expect(inactiveSup.status).toBe(409);
  });

  it('5. prevents duplicate submissions under concurrency (idempotency keys) and allocates unique voucher numbers', async () => {
    await assertTestDatabaseOnly();

    const idemKey = `p6-concurrent-idem-${Date.now()}`;
    const payload = {
      categoryId: catMaintenanceId,
      title: 'Elevator Annual Safety Inspection',
      amount: 4600.0,
      taxAmount: 552.0,
      expenseDate: '2026-10-15',
      paymentMethod: 'cheque',
      referenceNumber: 'CHQ-55102',
      idempotencyKey: idemKey,
    };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        adminAgent.post('/api/expenses').set('X-Property-Id', propAId).send(payload)
      )
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);

    const ids = new Set(responses.map((r) => r.body.expense.id));
    expect(ids.size).toBe(1);

    // Reusing the same idempotencyKey with altered amount must reject with 409
    const mismatchRes = await adminAgent
      .post('/api/expenses')
      .set('X-Property-Id', propAId)
      .send({ ...payload, amount: 9999.0 });
    expect(mismatchRes.status).toBe(409);

    // Concurrent distinct submissions without idempotencyKey must allocate unique expense numbers
    const distinctResponses = await Promise.all(
      [1, 2, 3].map((n) =>
        adminAgent
          .post('/api/expenses')
          .set('X-Property-Id', propAId)
          .send({
            categoryId: catUtilitiesId,
            title: `Water Tanker Delivery #${n}`,
            amount: 800,
            taxAmount: 0,
            expenseDate: '2026-10-16',
            paymentMethod: 'petty_cash',
          })
      )
    );
    expect(distinctResponses.every((r) => r.status === 201)).toBe(true);
    const voucherNumbers = new Set(
      distinctResponses.map((r) => r.body.expense.expenseNumber)
    );
    expect(voucherNumbers.size).toBe(3);
  });

  it('6. enforces strict multi-property isolation across categories, suppliers, expenses, and reports', async () => {
    // Receptionist assigned only to Property A cannot access Property B -> 403
    const recCrossProp = await recAgent
      .get('/api/expenses')
      .set('X-Property-Id', propBId);
    expect(recCrossProp.status).toBe(403);

    // Property A admin cannot attach Property B supplier or category to a Property A expense -> 404
    const crossSupplier = await adminAgent
      .post('/api/expenses')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: catUtilitiesId,
        supplierId: propBSupplierId,
        title: 'Cross Property Supplier Attempt',
        amount: 1000,
        expenseDate: '2026-10-16',
        paymentMethod: 'cash',
      });
    expect(crossSupplier.status).toBe(404);

    const crossCategory = await adminAgent
      .post('/api/expenses')
      .set('X-Property-Id', propAId)
      .send({
        categoryId: propBCategoryId,
        title: 'Cross Property Category Attempt',
        amount: 1000,
        expenseDate: '2026-10-16',
        paymentMethod: 'cash',
      });
    expect(crossCategory.status).toBe(404);

    // Property B admin sees 0 expenses from Property A
    const propBList = await propBOnlyAdminAgent
      .get('/api/expenses?dateFrom=2026-10-01&dateTo=2026-10-31')
      .set('X-Property-Id', propBId);
    expect(propBList.status).toBe(200);
    expect(propBList.body.total).toBe(0);
    expect(propBList.body.summary.recordedTotal).toBe(0);

    const propBReport = await propBOnlyAdminAgent
      .get('/api/reports/overview?dateFrom=2026-10-01&dateTo=2026-10-31')
      .set('X-Property-Id', propBId);
    expect(propBReport.status).toBe(200);
    expect(propBReport.body.report.expenses.recordedTotal).toBe(0);
    expect(propBReport.body.report.billing.recordedBilledTotal).toBe(0);
  });

  it('7. aggregates accurate financial, occupancy, and inventory reports without mutating historical records', async () => {
    await assertTestDatabaseOnly();
    const pool = getPool();

    const propAToday = getPropertyLocalDate('Asia/Kolkata');
    const reportFrom = '2026-10-01';
    const reportTo = addDays(propAToday, 10);
    const reportDays = diffDays(reportFrom, addDays(reportTo, 1));

    // 1) Create Reservations in Property A inside [reportFrom, reportTo]:
    // - Checked-in stay in Room 101: propAToday -> propAToday + 3 (3 nights @ 5000 + 12% GST = 16800)
    const resCheckedIn = await adminAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestAId,
        roomTypeId: roomTypeAId,
        roomId: roomA1Id,
        arrivalDate: propAToday,
        departureDate: addDays(propAToday, 3),
        adults: 2,
        children: 0,
        nightlyRate: 5000,
        discountAmount: 0,
        source: 'direct',
      });
    expect(resCheckedIn.status).toBe(201);
    const checkedInResId = resCheckedIn.body.reservation.id;

    const doCheckIn = await adminAgent
      .post(`/api/reservations/${checkedInResId}/check-in`)
      .set('X-Property-Id', propAId)
      .send({ roomId: roomA1Id, note: 'Guest arrived' });
    expect(doCheckIn.status).toBe(200);

    // - Confirmed future stay in Room 102: propAToday + 5 -> propAToday + 7 (2 nights @ 5000)
    const resConfirmed = await adminAgent
      .post('/api/reservations')
      .set('X-Property-Id', propAId)
      .send({
        guestId: guestAId,
        roomTypeId: roomTypeAId,
        roomId: roomA2Id,
        arrivalDate: addDays(propAToday, 5),
        departureDate: addDays(propAToday, 7),
        adults: 2,
        children: 0,
        nightlyRate: 5000,
        discountAmount: 0,
        source: 'website',
      });
    expect(resConfirmed.status).toBe(201);
    const confirmedResId = resConfirmed.body.reservation.id;

    // 2) Generate & issue invoice for checked-in stay (16,800.00), record partial payment of 10,000.00
    const genInv = await adminAgent
      .post(`/api/invoices/from-reservation/${checkedInResId}`)
      .set('X-Property-Id', propAId)
      .send({
        issueDate: propAToday,
        issueImmediately: true,
      });
    expect(genInv.status).toBe(201);
    const activeInvoiceId = genInv.body.invoice.id;
    expect(genInv.body.invoice.grandTotal).toBe(16800);

    const payRes = await adminAgent
      .post(`/api/invoices/${activeInvoiceId}/payments`)
      .set('X-Property-Id', propAId)
      .send({
        amount: 10000,
        paymentMethod: 'card',
        paymentDate: propAToday,
        referenceNumber: 'POS-CARD-4411',
      });
    expect(payRes.status).toBe(201);

    // Also generate and void an issued invoice on confirmed stay so we verify voided invoices are shown separately!
    const genVoidInv = await adminAgent
      .post(`/api/invoices/from-reservation/${confirmedResId}`)
      .set('X-Property-Id', propAId)
      .send({
        issueDate: propAToday,
        issueImmediately: true,
      });
    expect(genVoidInv.status).toBe(201);
    const voidInvoiceId = genVoidInv.body.invoice.id;
    expect(genVoidInv.body.invoice.grandTotal).toBe(11200);

    const voidInvRes = await adminAgent
      .post(`/api/invoices/${voidInvoiceId}/void`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Issued prematurely prior to guest arrival' });
    expect(voidInvRes.status).toBe(200);

    // 3) Create Phase 5 Inventory category, item, purchase receipt, and wastage movement
    const invCat = await adminAgent
      .post('/api/inventory/categories')
      .set('X-Property-Id', propAId)
      .send({ code: 'LINEN', name: 'Guest Room Amenities' });
    expect(invCat.status).toBe(201);

    const invItem = await adminAgent
      .post('/api/inventory/items')
      .set('X-Property-Id', propAId)
      .send({
        sku: 'P6-AMN-SOAP',
        name: 'Artisanal Sandalwood Soap',
        categoryId: invCat.body.category.id,
        supplierId: supplierActiveId,
        unit: 'pcs',
        openingStock: 20,
        reorderLevel: 10,
        unitCost: 50,
      });
    expect(invItem.status).toBe(201);
    const soapItemId = invItem.body.item.id;

    // Receive +10 pcs @ 50 = 500 on propAToday -> stock becomes 30
    const rcvRes = await adminAgent
      .post('/api/inventory/receipts')
      .set('X-Property-Id', propAId)
      .send({
        supplierId: supplierActiveId,
        receiptDate: propAToday,
        vendorInvoiceNumber: 'VPE-INV-99',
        items: [{ productId: soapItemId, quantity: 10, unitCost: 50 }],
      });
    expect(rcvRes.status).toBe(201);

    // Record wastage -2 pcs -> stock becomes 28 (valuation = 28 * 50 = 1,400.00)
    const wastRes = await adminAgent
      .post('/api/inventory/adjustments')
      .set('X-Property-Id', propAId)
      .send({
        productId: soapItemId,
        operation: 'wastage',
        quantity: 2,
        reason: 'Damaged outer carton during unloading',
      });
    expect(wastRes.status).toBe(201);

    // Snapshot ledger counts & sums BEFORE running financial/operational reports
    const preSnap = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM invoices WHERE property_id = $1) AS inv_cnt,
         (SELECT COALESCE(SUM(grand_total), 0)::text FROM invoices WHERE property_id = $1) AS inv_sum,
         (SELECT COUNT(*)::int FROM payments WHERE property_id = $1) AS pay_cnt,
         (SELECT COALESCE(SUM(amount), 0)::text FROM payments WHERE property_id = $1) AS pay_sum,
         (SELECT COUNT(*)::int FROM stock_movements WHERE property_id = $1) AS mov_cnt`,
      [propAId]
    );

    // 4) Query Report for [reportFrom, reportTo]
    const repRes = await recAgent
      .get(`/api/reports/overview?dateFrom=${reportFrom}&dateTo=${reportTo}`)
      .set('X-Property-Id', propAId);
    expect(repRes.status).toBe(200);

    const report = repRes.body.report;

    // Expenses verification:
    // Active recorded in window:
    //   2400.50 (MAINTENANCE) + 15000.00 (UTILITIES) + 4600.00 (MAINTENANCE idem) + 3 * 800.00 (UTILITIES) = 24,400.50 (6 vouchers)
    // Voided in window:
    //   3200.00 (1 voucher, strictly excluded from recordedTotal!)
    expect(report.expenses.recordedCount).toBe(6);
    expect(report.expenses.recordedTotal).toBe(24400.5);
    expect(report.expenses.voidedCount).toBe(1);
    expect(report.expenses.voidedTotal).toBe(3200);

    // Billing & Revenue verification:
    // Active invoice = 16,800.00 (partially_paid), Voided invoice = 11,200.00 (shown separately!)
    // Payments received = 10,000.00, Open balance = 6,800.00
    expect(report.billing.activeInvoicesCount).toBe(1);
    expect(report.billing.partiallyPaidCount).toBe(1);
    expect(report.billing.recordedBilledTotal).toBe(16800);
    expect(report.billing.paymentsReceivedCount).toBe(1);
    expect(report.billing.paymentsReceivedTotal).toBe(10000);
    expect(report.billing.periodInvoicesOutstandingBalance).toBe(6800);
    expect(report.billing.propertyTotalOutstandingBalance).toBe(6800);
    expect(report.billing.voidedInvoicesCount).toBe(1);
    expect(report.billing.voidedInvoicesTotal).toBe(11200);

    // Operating comparison & explicit non-audited profit labeling
    expect(report.operatingComparison.billedRevenueMinusExpenses).toBe(-7600.5);
    expect(report.operatingComparison.paymentsReceivedMinusExpenses).toBe(-14400.5);
    expect(report.operatingComparison.disclaimerTitle).toContain('Not Audited Profit');
    expect(report.operatingComparison.exclusionsAndLimitations.length).toBeGreaterThanOrEqual(4);

    // Occupancy verification:
    // 2 sellable rooms * reportDays = availableRoomNights
    // Actual occupied nights (checked_in) = 3; Committed (checked_in + confirmed) = 5
    expect(report.occupancy.currentSellableRooms).toBe(2);
    expect(report.occupancy.availableRoomNights).toBe(2 * reportDays);
    expect(report.occupancy.occupiedRoomNightsActual).toBe(3);
    expect(report.occupancy.committedRoomNightsIncludingConfirmed).toBe(5);
    expect(report.occupancy.averageDailyRateEstimate).toBe(5000);

    // Inventory verification (current valuation = 28 * 50 = 1400; receipts in period = 500)
    expect(report.inventory.activeItemsCount).toBe(1);
    expect(report.inventory.totalInventoryValuation).toBe(1400);
    expect(report.inventory.receiptsInPeriodCount).toBe(1);
    expect(report.inventory.receiptsInPeriodAmount).toBe(500);
    expect(report.inventory.totalInQuantity).toBe(30);
    expect(report.inventory.totalWastageQuantity).toBe(2);

    // Date filter test: querying September 2026 shows 0 period expenses/invoices/payments while preserving current valuation & property open balance
    const sepReportRes = await adminAgent
      .get('/api/reports/overview?dateFrom=2026-09-01&dateTo=2026-09-30')
      .set('X-Property-Id', propAId);
    expect(sepReportRes.status).toBe(200);
    expect(sepReportRes.body.report.expenses.recordedTotal).toBe(0);
    expect(sepReportRes.body.report.billing.recordedBilledTotal).toBe(0);
    expect(sepReportRes.body.report.billing.paymentsReceivedTotal).toBe(0);
    expect(sepReportRes.body.report.billing.propertyTotalOutstandingBalance).toBe(6800);
    expect(sepReportRes.body.report.inventory.totalInventoryValuation).toBe(1400);

    // Verify historical invoices, payments, and stock movements are 100% untouched
    const postSnap = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM invoices WHERE property_id = $1) AS inv_cnt,
         (SELECT COALESCE(SUM(grand_total), 0)::text FROM invoices WHERE property_id = $1) AS inv_sum,
         (SELECT COUNT(*)::int FROM payments WHERE property_id = $1) AS pay_cnt,
         (SELECT COALESCE(SUM(amount), 0)::text FROM payments WHERE property_id = $1) AS pay_sum,
         (SELECT COUNT(*)::int FROM stock_movements WHERE property_id = $1) AS mov_cnt`,
      [propAId]
    );
    expect(postSnap.rows[0]).toEqual(preSnap.rows[0]);
  });
});
