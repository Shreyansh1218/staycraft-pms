import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, getPropertyLocalDate } from '../src/shared/dates.js';
import {
  calculateBillableNights,
  calculateReservationFinancials,
  computeInvoiceTotalsFromItems,
} from '../src/shared/pricing.js';
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
let suiteTypeId = '';
let room101Id = '';
let room102Id = '';
let room103Id = '';
let room104Id = '';
let room105Id = '';
let room106Id = '';
let room201Id = '';
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
     VALUES ('admin@phase3.test', $1, 'Aarav BillingAdmin', 'admin') RETURNING id`,
    [adminHash]
  );
  const uRec = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('frontdesk@phase3.test', $1, 'Priya Cashier', 'receptionist') RETURNING id`,
    [recHash]
  );
  const uPropB = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ('propb@phase3.test', $1, 'Kabir AnnexDesk', 'receptionist') RETURNING id`,
    [recHash]
  );

  adminUserId = uAdmin.rows[0].id as string;
  receptionistUserId = uRec.rows[0].id as string;
  propBOnlyUserId = uPropB.rows[0].id as string;

  const pA = await pool.query(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, state_region, postal_code, country,
       timezone, currency, default_tax_rate, tax_name, invoice_settings
     ) VALUES (
       'P3A', 'Phase 3 Grand Heritage', 'billing@p3a.test', '+91 542 220 1100',
       'Assi Ghat Road', 'Varanasi', 'Uttar Pradesh', '221005', 'India',
       'Asia/Kolkata', 'INR', 12.00, 'GST',
       '{"prefix":"P3A","next_number":2001,"tax_id":"09AABCS1429B1Z5","footer_note":"Thank you for staying at Grand Heritage."}'::jsonb
     ) RETURNING id`
  );
  const pB = await pool.query(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name, invoice_settings
     ) VALUES (
       'P3B', 'Phase 3 Riverfront Annex', 'billing@p3b.test', '+91 542 220 2200',
       'Dashashwamedh Road', 'Varanasi', 'India',
       'Asia/Kolkata', 'INR', 18.00, 'GST',
       '{"prefix":"P3B","next_number":5001,"tax_id":"","footer_note":"Thank you."}'::jsonb
     ) RETURNING id`
  );

  propAId = pA.rows[0].id as string;
  propBId = pB.rows[0].id as string;
  propAToday = getPropertyLocalDate('Asia/Kolkata');

  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id, is_default)
     VALUES ($1, $4, TRUE), ($1, $5, FALSE), ($2, $4, TRUE), ($3, $5, TRUE)`,
    [adminUserId, receptionistUserId, propBOnlyUserId, propAId, propBId]
  );

  const rtDlx = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'DLX', 'Deluxe Heritage Room', 2, 3, 4000.00) RETURNING id`,
    [propAId]
  );
  const rtSuite = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'STE', 'Ganges Suite', 2, 4, 3333.33) RETURNING id`,
    [propAId]
  );
  const rtPropB = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'STD', 'Annex Standard', 2, 2, 2800.00) RETURNING id`,
    [propBId]
  );

  dlxTypeId = rtDlx.rows[0].id as string;
  suiteTypeId = rtSuite.rows[0].id as string;
  const propBTypeId = rtPropB.rows[0].id as string;

  const insertRoom = async (propId: string, typeId: string, num: string, floor: string) => {
    const r = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
       VALUES ($1, $2, $3, $4, 'inspected', 'available') RETURNING id`,
      [propId, typeId, num, floor]
    );
    return r.rows[0].id as string;
  };

  room101Id = await insertRoom(propAId, dlxTypeId, '101', '1');
  room102Id = await insertRoom(propAId, dlxTypeId, '102', '1');
  room103Id = await insertRoom(propAId, dlxTypeId, '103', '1');
  room104Id = await insertRoom(propAId, dlxTypeId, '104', '1');
  room105Id = await insertRoom(propAId, dlxTypeId, '105', '1');
  room106Id = await insertRoom(propAId, dlxTypeId, '106', '1');
  room201Id = await insertRoom(propAId, suiteTypeId, '201', '2');
  propBRoomId = await insertRoom(propBId, propBTypeId, 'B101', '1');

  const gA = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone, city, country)
     VALUES ($1, 'Meera', 'Krishnan', 'meera@guest.test', '+91 98111 22333', 'Bengaluru', 'India')
     RETURNING id`,
    [propAId]
  );
  const gB = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'Rohan', 'Verma', 'rohan@guest.test', '+91 98222 33444')
     RETURNING id`,
    [propBId]
  );
  guestAId = gA.rows[0].id as string;
  guestBId = gB.rows[0].id as string;

  adminAgent = request.agent(app);
  const loginAdmin = await adminAgent
    .post('/api/auth/login')
    .send({ email: 'admin@phase3.test', password: 'Admin@12345' });
  expect(loginAdmin.status).toBe(200);

  receptionistAgent = request.agent(app);
  const loginRec = await receptionistAgent
    .post('/api/auth/login')
    .send({ email: 'frontdesk@phase3.test', password: 'FrontDesk@123' });
  expect(loginRec.status).toBe(200);

  propBOnlyAgent = request.agent(app);
  const loginPropB = await propBOnlyAgent
    .post('/api/auth/login')
    .send({ email: 'propb@phase3.test', password: 'FrontDesk@123' });
  expect(loginPropB.status).toBe(200);
});

afterAll(async () => {
  await closePool();
});

describe('Phase 3: Billing, Invoices, Room Charges, Payments & Checkout Integration', () => {
  describe('1. Pricing & Billable Nights Pure Unit Rules', () => {
    it('calculates billable nights accurately for same-day stays, 1-night stays, and extended stays', () => {
      // Same-day day-use window (0 calendar diff) bills 1 minimum room night
      expect(calculateBillableNights('2026-10-22', '2026-10-22')).toBe(1);
      // Standard 1-night overnight stay
      expect(calculateBillableNights('2026-10-22', '2026-10-23')).toBe(1);
      // Multi-night & extended stays
      expect(calculateBillableNights('2026-10-22', '2026-10-27')).toBe(5);
      expect(calculateBillableNights('2026-10-22', '2026-11-05')).toBe(14);
      // Invalid inverted dates throw
      expect(() => calculateBillableNights('2026-10-25', '2026-10-22')).toThrow();
    });

    it('matches reservation financials to the exact cent with zero IEEE-754 floating-point drift', () => {
      const resFin = calculateReservationFinancials({
        nights: 3,
        nightlyRate: 3333.33,
        discountAmount: 500,
        taxRate: 12,
      });

      const invCalc = computeInvoiceTotalsFromItems(
        [
          {
            id: 'line-room',
            itemType: 'room_charge',
            quantity: 3,
            unitPrice: 3333.33,
            taxRate: 12,
            sourceKey: 'reservation_room_charge',
          },
          {
            id: 'line-disc',
            itemType: 'discount',
            quantity: 1,
            unitPrice: 500,
            taxRate: 0,
            sourceKey: 'reservation_discount',
          },
        ],
        3333.33
      );

      expect(invCalc.subtotal).toBe(9999.99);
      expect(invCalc.discountTotal).toBe(500);
      expect(invCalc.taxableSubtotal).toBe(9499.99);
      expect(invCalc.taxTotal).toBe(resFin.taxAmount);
      expect(invCalc.grandTotal).toBe(resFin.estimatedTotal);
      expect(invCalc.amountPaid).toBe(3333.33);
      expect(invCalc.balanceDue).toBe(Number((invCalc.grandTotal - 3333.33).toFixed(2)));
    });
  });

  describe('2. Security: Authentication, UUID Validation, RBAC & Multi-Property Isolation', () => {
    it('rejects unauthenticated requests to all billing endpoints with 401 AUTH_TOKEN_MISSING', async () => {
      const fakeId = '00000000-0000-4000-8000-000000000001';
      const checks = await Promise.all([
        request(app).get('/api/invoices'),
        request(app).get(`/api/invoices/${fakeId}`),
        request(app).post(`/api/invoices/from-reservation/${fakeId}`).send({}),
        request(app).post(`/api/invoices/${fakeId}/payments`).send({ amount: 100, paymentMethod: 'cash' }),
        request(app).get(`/api/reservations/${fakeId}/invoice`),
      ]);

      for (const res of checks) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('AUTH_TOKEN_MISSING');
        expect(res.body.error.message).not.toMatch(/invalid email or password/i);
      }
    });

    it('rejects malformed UUIDs with 400 INVALID_IDENTIFIER and nonexistent UUIDs with 404', async () => {
      const badGet = await adminAgent
        .get('/api/invoices/not-a-valid-uuid')
        .set('X-Property-Id', propAId);
      expect(badGet.status).toBe(400);
      expect(badGet.body.error.code).toBe('INVALID_IDENTIFIER');

      const badQuery = await adminAgent
        .get('/api/invoices?reservationId=bad-uuid')
        .set('X-Property-Id', propAId);
      expect(badQuery.status).toBe(400);
      expect(badQuery.body.error.code).toBe('INVALID_IDENTIFIER');

      const missingGet = await adminAgent
        .get('/api/invoices/00000000-0000-4000-8000-000000009999')
        .set('X-Property-Id', propAId);
      expect(missingGet.status).toBe(404);
    });

    it('enforces strict property isolation across invoice listing, viewing, mutations, and payments', async () => {
      // Create a reservation & invoice in Property B
      const resB = await propBOnlyAgent
        .post('/api/reservations')
        .set('X-Property-Id', propBId)
        .send({
          guestId: guestBId,
          roomId: propBRoomId,
          arrivalDate: propAToday,
          departureDate: addDays(propAToday, 2),
          adults: 2,
          children: 0,
          source: 'direct',
        });
      expect(resB.status).toBe(201);
      const resBId = resB.body.reservation.id as string;

      const invBRes = await propBOnlyAgent
        .post(`/api/invoices/from-reservation/${resBId}`)
        .set('X-Property-Id', propBId)
        .send({ issueImmediately: true });
      expect(invBRes.status).toBe(201);
      const invBId = invBRes.body.invoice.id as string;
      expect(invBRes.body.invoice.invoiceNumber).toBe('P3B-5001');

      // Property B staff cannot access Property A header at all (403)
      const forbiddenPropA = await propBOnlyAgent
        .get('/api/invoices')
        .set('X-Property-Id', propAId);
      expect(forbiddenPropA.status).toBe(403);

      // Receptionist scoped only to Property A cannot view or pay Property B's invoice under Property A context (404)
      const crossView = await receptionistAgent
        .get(`/api/invoices/${invBId}`)
        .set('X-Property-Id', propAId);
      expect(crossView.status).toBe(404);

      const crossPay = await receptionistAgent
        .post(`/api/invoices/${invBId}/payments`)
        .set('X-Property-Id', propAId)
        .send({ amount: 500, paymentMethod: 'cash' });
      expect(crossPay.status).toBe(404);

      // Property A invoice list does not leak Property B's invoice
      const listA = await receptionistAgent
        .get('/api/invoices')
        .set('X-Property-Id', propAId);
      expect(listA.status).toBe(200);
      expect(listA.body.items).toHaveLength(0);
    });
  });

  describe('3. Concurrency-Safe Unique Invoice Numbers & Duplicate Room-Charge Prevention', () => {
    it('prevents duplicate invoices and duplicate room charges when concurrent requests target the same reservation', async () => {
      const resCreate = await receptionistAgent
        .post('/api/reservations')
        .set('X-Property-Id', propAId)
        .send({
          guestId: guestAId,
          roomId: room101Id,
          arrivalDate: addDays(propAToday, 10),
          departureDate: addDays(propAToday, 12),
          adults: 2,
          children: 0,
          discountAmount: 400,
          source: 'direct',
        });
      expect(resCreate.status).toBe(201);
      const reservationId = resCreate.body.reservation.id as string;

      // Fire 5 simultaneous invoice-generation requests against the same reservation
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          receptionistAgent
            .post(`/api/invoices/from-reservation/${reservationId}`)
            .set('X-Property-Id', propAId)
            .send({ issueImmediately: false })
        )
      );

      for (const r of results) {
        expect([200, 201]).toContain(r.status);
      }
      const createdCount = results.filter((r) => r.status === 201).length;
      expect(createdCount).toBe(1);

      const uniqueIds = new Set(results.map((r) => r.body.invoice.id));
      expect(uniqueIds.size).toBe(1);

      const invoice = results[0].body.invoice;
      expect(invoice.invoiceNumber).toBe('P3A-2001');
      expect(invoice.status).toBe('draft');
      // 2 nights * 4000 = 8000; discount = 400; taxable = 7600; 12% GST = 912; total = 8512
      expect(invoice.subtotal).toBe(8000);
      expect(invoice.discountTotal).toBe(400);
      expect(invoice.taxTotal).toBe(912);
      expect(invoice.grandTotal).toBe(8512);
      expect(invoice.amountPaid).toBe(0);
      expect(invoice.balanceDue).toBe(8512);

      const roomChargeLines = invoice.lineItems.filter(
        (li: any) => li.itemType === 'room_charge'
      );
      expect(roomChargeLines).toHaveLength(1);
    });

    it('allocates strictly unique sequential invoice numbers under concurrent multi-reservation load', async () => {
      const rooms = [room102Id, room103Id, room104Id, room105Id, room106Id];
      const reservationIds: string[] = [];

      for (let i = 0; i < rooms.length; i++) {
        const res = await adminAgent
          .post('/api/reservations')
          .set('X-Property-Id', propAId)
          .send({
            guestId: guestAId,
            roomId: rooms[i],
            arrivalDate: addDays(propAToday, 20 + i),
            departureDate: addDays(propAToday, 22 + i),
            adults: 2,
            children: 0,
            source: 'website',
          });
        expect(res.status).toBe(201);
        reservationIds.push(res.body.reservation.id as string);
      }

      const concurrentCreates = await Promise.all(
        reservationIds.map((rId) =>
          adminAgent
            .post(`/api/invoices/from-reservation/${rId}`)
            .set('X-Property-Id', propAId)
            .send({ issueImmediately: true })
        )
      );

      for (const resp of concurrentCreates) {
        expect(resp.status).toBe(201);
      }

      const numbers = concurrentCreates.map((r) => r.body.invoice.invoiceNumber as string).sort();
      expect(numbers).toEqual([
        'P3A-2002',
        'P3A-2003',
        'P3A-2004',
        'P3A-2005',
        'P3A-2006',
      ]);
    });
  });

  describe('4. Extended Stays & Historical Invoice Rate Immutability', () => {
    it('recalculates room charges cleanly on stay extension and preserves historical invoice amounts when room/tax rates later change', async () => {
      // Create 2-night reservation at Deluxe rate 4000.00 & 12% GST
      const createRes = await receptionistAgent
        .post('/api/reservations')
        .set('X-Property-Id', propAId)
        .send({
          guestId: guestAId,
          roomId: room101Id,
          arrivalDate: addDays(propAToday, 35),
          departureDate: addDays(propAToday, 37),
          adults: 2,
          children: 0,
          source: 'phone',
        });
      expect(createRes.status).toBe(201);
      const resId = createRes.body.reservation.id as string;

      const invCreate = await receptionistAgent
        .post(`/api/invoices/from-reservation/${resId}`)
        .set('X-Property-Id', propAId)
        .send({ issueImmediately: true });
      expect(invCreate.status).toBe(201);
      const invoiceId = invCreate.body.invoice.id as string;
      expect(invCreate.body.invoice.subtotal).toBe(8000);
      expect(invCreate.body.invoice.taxTotal).toBe(960);
      expect(invCreate.body.invoice.grandTotal).toBe(8960);

      // Extend stay from 2 nights to 5 nights -> linked invoice updates automatically without duplicate room charges
      const extendRes = await receptionistAgent
        .put(`/api/reservations/${resId}`)
        .set('X-Property-Id', propAId)
        .send({
          departureDate: addDays(propAToday, 40),
          editReason: 'Guest extended stay by 3 additional nights',
        });
      expect(extendRes.status).toBe(200);
      expect(extendRes.body.reservation.nights).toBe(5);

      const afterExtend = await receptionistAgent
        .get(`/api/invoices/${invoiceId}`)
        .set('X-Property-Id', propAId);
      expect(afterExtend.status).toBe(200);
      expect(afterExtend.body.invoice.lineItems.filter((i: any) => i.itemType === 'room_charge')).toHaveLength(1);
      expect(afterExtend.body.invoice.lineItems[0].quantity).toBe(5);
      expect(afterExtend.body.invoice.lineItems[0].unitPrice).toBe(4000);
      expect(afterExtend.body.invoice.subtotal).toBe(20000);
      expect(afterExtend.body.invoice.taxTotal).toBe(2400);
      expect(afterExtend.body.invoice.grandTotal).toBe(22400);

      // Admin changes Deluxe base_rate from 4000 -> 9500 AND property default_tax_rate from 12% -> 18%
      const rateUpdate = await adminAgent
        .put(`/api/room-types/${dlxTypeId}`)
        .set('X-Property-Id', propAId)
        .send({ baseRate: 9500 });
      expect(rateUpdate.status).toBe(200);

      const currentPropResp = await adminAgent
        .get('/api/properties/current')
        .set('X-Property-Id', propAId);
      expect(currentPropResp.status).toBe(200);

      const propTaxUpdate = await adminAgent
        .put('/api/properties/current')
        .set('X-Property-Id', propAId)
        .send({
          ...currentPropResp.body.property,
          defaultTaxRate: 18,
        });
      expect(propTaxUpdate.status).toBe(200);

      // Verify historical invoice amounts remain 100% preserved even after explicit sync!
      const syncAfterRateChange = await receptionistAgent
        .post(`/api/invoices/${invoiceId}/sync-reservation`)
        .set('X-Property-Id', propAId);
      expect(syncAfterRateChange.status).toBe(200);
      expect(syncAfterRateChange.body.invoice.lineItems[0].unitPrice).toBe(4000);
      expect(syncAfterRateChange.body.invoice.taxRate).toBe(12);
      expect(syncAfterRateChange.body.invoice.subtotal).toBe(20000);
      expect(syncAfterRateChange.body.invoice.taxTotal).toBe(2400);
      expect(syncAfterRateChange.body.invoice.grandTotal).toBe(22400);

      // Restore property tax rate & room type rate for subsequent tests
      await adminAgent
        .put(`/api/room-types/${dlxTypeId}`)
        .set('X-Property-Id', propAId)
        .send({ baseRate: 4000 });
      await adminAgent
        .put('/api/properties/current')
        .set('X-Property-Id', propAId)
        .send({
          ...currentPropResp.body.property,
          defaultTaxRate: 12,
        });
    });
  });

  describe('5. RBAC, Itemized Charges, Partial/Full Payments, Validation & Concurrency', () => {
    let targetInvoiceId = '';

    it('enforces RBAC on folio items and voids, validates payment amounts & card-PAN prohibitions, and prevents concurrent overpayments', async () => {
      const resCreate = await receptionistAgent
        .post('/api/reservations')
        .set('X-Property-Id', propAId)
        .send({
          guestId: guestAId,
          roomId: room201Id,
          arrivalDate: addDays(propAToday, 5),
          departureDate: addDays(propAToday, 8),
          adults: 2,
          children: 0,
          source: 'direct',
        });
      expect(resCreate.status).toBe(201);

      const invCreate = await receptionistAgent
        .post(`/api/invoices/from-reservation/${resCreate.body.reservation.id}`)
        .set('X-Property-Id', propAId)
        .send({ issueImmediately: false });
      expect(invCreate.status).toBe(201);
      targetInvoiceId = invCreate.body.invoice.id as string;
      expect(invCreate.body.invoice.status).toBe('draft');

      // Receptionist can add service_charge, but CANNOT post manual discount or void an invoice
      const addService = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/items`)
        .set('X-Property-Id', propAId)
        .send({
          itemType: 'service_charge',
          description: 'Airport Pickup Transfer',
          quantity: 1,
          unitPrice: 1000.01,
          idempotencyKey: 'svc-transfer-1',
        });
      expect(addService.status).toBe(201);

      // Duplicate item submission with same idempotencyKey rejected with 409
      const dupService = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/items`)
        .set('X-Property-Id', propAId)
        .send({
          itemType: 'service_charge',
          description: 'Airport Pickup Transfer',
          quantity: 1,
          unitPrice: 1000.01,
          idempotencyKey: 'svc-transfer-1',
        });
      expect(dupService.status).toBe(409);

      const forbiddenDiscount = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/items`)
        .set('X-Property-Id', propAId)
        .send({
          itemType: 'discount',
          description: 'Unauthorized discount',
          quantity: 1,
          unitPrice: 200,
        });
      expect(forbiddenDiscount.status).toBe(403);

      const forbiddenVoid = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/void`)
        .set('X-Property-Id', propAId)
        .send({ reason: 'Trying to void as receptionist' });
      expect(forbiddenVoid.status).toBe(403);

      // Admin CAN post an authorized discount
      const adminDiscount = await adminAgent
        .post(`/api/invoices/${targetInvoiceId}/items`)
        .set('X-Property-Id', propAId)
        .send({
          itemType: 'discount',
          description: ' Returning Guest Goodwill Credit',
          quantity: 1,
          unitPrice: 1000,
        });
      expect(adminDiscount.status).toBe(201);

      // Subtotal = (3 * 3333.33) + 1000.01 = 11000.00; Discount = 1000.00; Taxable = 10000.00; 12% GST = 1200.00; Grand Total = 11200.00
      expect(adminDiscount.body.invoice.subtotal).toBe(11000);
      expect(adminDiscount.body.invoice.discountTotal).toBe(1000);
      expect(adminDiscount.body.invoice.taxTotal).toBe(1200);
      expect(adminDiscount.body.invoice.grandTotal).toBe(11200);

      // Reject 0, negative, 3-decimal amounts, and raw Luhn card PANs
      const zeroPay = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/payments`)
        .set('X-Property-Id', propAId)
        .send({ amount: 0, paymentMethod: 'cash' });
      expect(zeroPay.status).toBe(400);

      const negPay = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/payments`)
        .set('X-Property-Id', propAId)
        .send({ amount: -100, paymentMethod: 'cash' });
      expect(negPay.status).toBe(400);

      const threeDecimals = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/payments`)
        .set('X-Property-Id', propAId)
        .send({ amount: 100.555, paymentMethod: 'cash' });
      expect(threeDecimals.status).toBe(400);

      const rawCardPan = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/payments`)
        .set('X-Property-Id', propAId)
        .send({
          amount: 500,
          paymentMethod: 'card',
          paymentReference: '4111 1111 1111 1111',
        });
      expect(rawCardPan.status).toBe(400);

      // Record valid partial payment of 4200.00 -> status becomes partially_paid, balanceDue = 7000.00
      const partialPay = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/payments`)
        .set('X-Property-Id', propAId)
        .send({
          amount: 4200,
          paymentMethod: 'upi',
          paymentDate: propAToday,
          paymentReference: 'UPI-UTR-778899',
          notes: 'Advance UPI deposit',
          idempotencyKey: 'pay-partial-1',
        });
      expect(partialPay.status).toBe(201);
      expect(partialPay.body.invoice.status).toBe('partially_paid');
      expect(partialPay.body.invoice.amountPaid).toBe(4200);
      expect(partialPay.body.invoice.balanceDue).toBe(7000);
      expect(partialPay.body.payment.receivedBy).toBe(receptionistUserId);
      expect(partialPay.body.payment.receivedByName).toBe('Priya Cashier');

      // Duplicate submission with identical idempotencyKey rejected with 409
      const dupPay = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/payments`)
        .set('X-Property-Id', propAId)
        .send({
          amount: 4200,
          paymentMethod: 'upi',
          idempotencyKey: 'pay-partial-1',
        });
      expect(dupPay.status).toBe(409);

      // Overpayment above remaining 7000.00 rejected with 400
      const overPay = await receptionistAgent
        .post(`/api/invoices/${targetInvoiceId}/payments`)
        .set('X-Property-Id', propAId)
        .send({
          amount: 7000.01,
          paymentMethod: 'cash',
        });
      expect(overPay.status).toBe(400);
      expect(overPay.body.error.details?.reason).toBe('OVERPAYMENT_NOT_ALLOWED');

      // Cannot void an invoice that has recorded payments (even as Admin)
      const adminVoidPaid = await adminAgent
        .post(`/api/invoices/${targetInvoiceId}/void`)
        .set('X-Property-Id', propAId)
        .send({ reason: 'Attempt to void partially paid invoice' });
      expect(adminVoidPaid.status).toBe(409);

      // Concurrent race: fire two simultaneous 7000.00 full-balance payments -> exact 1 succeeds, 1 rejected
      const [raceA, raceB] = await Promise.all([
        receptionistAgent
          .post(`/api/invoices/${targetInvoiceId}/payments`)
          .set('X-Property-Id', propAId)
          .send({ amount: 7000, paymentMethod: 'card', paymentReference: 'POS-9001' }),
        adminAgent
          .post(`/api/invoices/${targetInvoiceId}/payments`)
          .set('X-Property-Id', propAId)
          .send({ amount: 7000, paymentMethod: 'cash', paymentReference: 'CASH-9002' }),
      ]);

      const statuses = [raceA.status, raceB.status].sort((a, b) => a - b);
      expect(statuses[0]).toBe(201);
      expect([400, 409]).toContain(statuses[1]);

      const finalInv = await adminAgent
        .get(`/api/invoices/${targetInvoiceId}`)
        .set('X-Property-Id', propAId);
      expect(finalInv.status).toBe(200);
      expect(finalInv.body.invoice.status).toBe('paid');
      expect(finalInv.body.invoice.amountPaid).toBe(11200);
      expect(finalInv.body.invoice.balanceDue).toBe(0);
      expect(finalInv.body.invoice.payments).toHaveLength(2);
    });
  });

  describe('6. Checkout Integration: Unpaid Checkout Permitted & Never Auto-Marked Paid', () => {
    it('issues unpaid invoice on checkout without blocking departure, never auto-marks paid, and preserves dirty room + turnover task', async () => {
      // Create reservation arriving yesterday and departing today so we can check in (via deliberate arrival edit) or create arriving today?
      // Wait: arrival yesterday -> edit arrival or insert checked_in reservation departing today!
      const pool = getPool();
      const arrivalIso = addDays(propAToday, -2);
      const departureIso = propAToday;

      const insRes = await pool.query(
        `INSERT INTO reservations (
           property_id, booking_reference, guest_id, room_type_id, room_id,
           status, source, arrival_date, departure_date, adults, children, num_guests,
           nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total, currency,
           checked_in_at, created_by, updated_by
         ) VALUES (
           $1, 'BK-CHKOUT-01', $2, $3, $4,
           'checked_in', 'direct', $5, $6, 2, 0, 2,
           4000.00, 0.00, 12.00, 960.00, 8960.00, 'INR',
           NOW() - INTERVAL '2 days', $7, $7
         ) RETURNING id`,
        [propAId, guestAId, dlxTypeId, room102Id, arrivalIso, departureIso, receptionistUserId]
      );
      const checkoutResId = insRes.rows[0].id as string;

      // Perform check-out WITH ZERO PAYMENTS recorded -> must NOT block checkout and must NOT mark invoice paid!
      const coResp = await receptionistAgent
        .post(`/api/reservations/${checkoutResId}/check-out`)
        .set('X-Property-Id', propAId)
        .send({ note: 'Guest departing; company settling via bank transfer' });
      expect(coResp.status).toBe(200);
      expect(coResp.body.reservation.status).toBe('checked_out');

      // Verify room became dirty (not clean) and turnover_clean task was queued
      const roomsResp = await receptionistAgent
        .get('/api/rooms')
        .set('X-Property-Id', propAId);
      const room102 = roomsResp.body.items.find((r: any) => r.id === room102Id);
      expect(room102.housekeepingStatus).toBe('dirty');

      const hkResp = await receptionistAgent
        .get(`/api/housekeeping/tasks?roomId=${room102Id}`)
        .set('X-Property-Id', propAId);
      expect(
        hkResp.body.items.some(
          (t: any) => t.reservationId === checkoutResId && t.taskType === 'turnover_clean'
        )
      ).toBe(true);

      // Verify reservation's invoice is 'issued' (UNPAID), with 0 paid and full 8960.00 balanceDue!
      const resInvResp = await receptionistAgent
        .get(`/api/reservations/${checkoutResId}/invoice`)
        .set('X-Property-Id', propAId);
      expect(resInvResp.status).toBe(200);
      expect(resInvResp.body.invoice).not.toBeNull();
      expect(resInvResp.body.invoice.status).toBe('issued');
      expect(resInvResp.body.invoice.status).not.toBe('paid');
      expect(resInvResp.body.invoice.amountPaid).toBe(0);
      expect(resInvResp.body.invoice.balanceDue).toBe(8960);

      // Settle post-checkout invoice via bank_transfer -> becomes 'paid'
      const settleResp = await receptionistAgent
        .post(`/api/invoices/${resInvResp.body.invoice.id}/payments`)
        .set('X-Property-Id', propAId)
        .send({
          amount: 8960,
          paymentMethod: 'bank_transfer',
          paymentReference: 'NEFT-20261022-001',
        });
      expect(settleResp.status).toBe(201);
      expect(settleResp.body.invoice.status).toBe('paid');
      expect(settleResp.body.invoice.balanceDue).toBe(0);
    });

    it('allows Admin to void an unpaid invoice and cleanly generate a replacement invoice', async () => {
      const resCreate = await adminAgent
        .post('/api/reservations')
        .set('X-Property-Id', propAId)
        .send({
          guestId: guestAId,
          roomId: room103Id,
          arrivalDate: addDays(propAToday, 50),
          departureDate: addDays(propAToday, 51),
          adults: 1,
          children: 0,
          source: 'direct',
        });
      expect(resCreate.status).toBe(201);
      const resId = resCreate.body.reservation.id as string;

      const firstInv = await adminAgent
        .post(`/api/invoices/from-reservation/${resId}`)
        .set('X-Property-Id', propAId)
        .send({ issueImmediately: true });
      expect(firstInv.status).toBe(201);
      const firstId = firstInv.body.invoice.id as string;
      const firstNumber = firstInv.body.invoice.invoiceNumber as string;

      const voidRes = await adminAgent
        .post(`/api/invoices/${firstId}/void`)
        .set('X-Property-Id', propAId)
        .send({ reason: 'Voided to reissue with updated billing instructions' });
      expect(voidRes.status).toBe(200);
      expect(voidRes.body.invoice.status).toBe('void');
      expect(voidRes.body.invoice.balanceDue).toBe(0);

      const replacementInv = await adminAgent
        .post(`/api/invoices/from-reservation/${resId}`)
        .set('X-Property-Id', propAId)
        .send({ issueImmediately: false });
      expect(replacementInv.status).toBe(201);
      expect(replacementInv.body.invoice.id).not.toBe(firstId);
      expect(replacementInv.body.invoice.invoiceNumber).not.toBe(firstNumber);
      expect(replacementInv.body.invoice.status).toBe('draft');
    });
  });
});
