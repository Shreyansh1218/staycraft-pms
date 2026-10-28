import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, getPropertyLocalDate } from '../src/shared/dates.js';
import { calculateReservationFinancials } from '../src/shared/pricing.js';
import { createApiApp } from '../src/server/app.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { closePool, getPool } from '../src/server/db/pool.js';
import { hashPassword } from '../src/server/security/password.js';

function resolveChromiumExecutable(): string | undefined {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const chromiumExecutable = resolveChromiumExecutable();

let server: http.Server | null = null;
let viteDevServer: ViteDevServer | null = null;
let baseUrl = '';
let browser: Browser | null = null;

let propId = '';
let propToday = '';
let stdTypeId = '';
let dlxTypeId = '';
let room101Id = '';
let room102Id = '';
let room103Id = '';
let room104Id = '';
let room201Id = '';
let room202Id = '';
let room203Id = '';
let receptionistId = '';
let guest1Id = '';
let guest2Id = '';
let inHousePastArrivalBookingRef = '';
let overdueBookingRef = '';
let dueTodayBookingRef = '';

async function signInViaUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.locator('button[type="submit"]', { hasText: 'Sign In' }).click();
  await page.locator('h1', { hasText: 'Front Office Dashboard' }).waitFor({ timeout: 10000 });
}

describe('Phase 1 Automated Browser E2E Verification (Isolated Test DB)', () => {
  beforeAll(async () => {
    if (!chromiumExecutable) {
      throw new Error('Chromium executable not found at /usr/bin/chromium for browser E2E suite.');
    }

    const clientDist = path.resolve(process.cwd(), 'dist/client');
    const hasClientBuild = fs.existsSync(path.join(clientDist, 'index.html'));

    const pool = getPool();
    const dbCheck = await pool.query('SELECT current_database() AS db_name');
    if (String(dbCheck.rows[0]?.db_name ?? '') !== 'staycraft_pms_test') {
      throw new Error('Browser E2E suite must run strictly against staycraft_pms_test');
    }

    await runMigrations();

    // Isolated staycraft_pms_test cleanup only (NODE_ENV === 'test')
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

    // Seed exact staff accounts documented in README.md into isolated test DB
    const adminHash = await hashPassword('Admin@12345');
    const recHash = await hashPassword('FrontDesk@123');

    const uAdmin = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ('admin@staycraft.local', $1, 'Aarav Mehta', 'admin') RETURNING id`,
      [adminHash]
    );
    const uRec = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ('frontdesk@staycraft.local', $1, 'Priya Nair', 'receptionist') RETURNING id`,
      [recHash]
    );
    const adminId = uAdmin.rows[0].id as string;
    receptionistId = uRec.rows[0].id as string;

    const pRes = await pool.query(
      `INSERT INTO properties (code, name, email, phone, address_line1, city, country, timezone, currency, default_tax_rate, tax_name)
       VALUES ('KHB', 'Kashi Heritage Test Hotel', 'desk@khb.test', '+91 542 250 8800', 'Assi Ghat Rd', 'Varanasi', 'India', 'Asia/Kolkata', 'INR', 12.00, 'GST')
       RETURNING id`
    );
    propId = pRes.rows[0].id as string;
    propToday = getPropertyLocalDate('Asia/Kolkata');

    await pool.query(
      `INSERT INTO user_property_access (user_id, property_id, is_default)
       VALUES ($1, $3, TRUE), ($2, $3, TRUE)`,
      [adminId, uRec.rows[0].id, propId]
    );

    const rtStd = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
       VALUES ($1, 'STD', 'Standard Queen', 2, 2, 4200) RETURNING id`,
      [propId]
    );
    const rtDlx = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
       VALUES ($1, 'DLX', 'Deluxe King', 2, 3, 6200) RETURNING id`,
      [propId]
    );
    stdTypeId = rtStd.rows[0].id as string;
    dlxTypeId = rtDlx.rows[0].id as string;

    // Physical rooms including Room 104 (maintenance + clean) and deactivated Room 109
    const r101 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
       VALUES ($1, $2, '101', '1', 'available', 'inspected', TRUE) RETURNING id`,
      [propId, stdTypeId]
    );
    const r102 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
       VALUES ($1, $2, '102', '1', 'available', 'clean', TRUE) RETURNING id`,
      [propId, stdTypeId]
    );
    const r103 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
       VALUES ($1, $2, '103', '1', 'available', 'dirty', TRUE) RETURNING id`,
      [propId, stdTypeId]
    );
    room103Id = r103.rows[0].id as string;
    const r104 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, notes, is_active)
       VALUES ($1, $2, '104', '1', 'maintenance', 'clean', 'AC compressor maintenance', TRUE) RETURNING id`,
      [propId, stdTypeId]
    );
    const r201 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
       VALUES ($1, $2, '201', '2', 'available', 'inspected', TRUE) RETURNING id`,
      [propId, dlxTypeId]
    );
    const r202 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
       VALUES ($1, $2, '202', '2', 'available', 'inspected', TRUE) RETURNING id`,
      [propId, dlxTypeId]
    );
    const r203 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
       VALUES ($1, $2, '203', '2', 'available', 'inspected', TRUE) RETURNING id`,
      [propId, dlxTypeId]
    );
    await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, is_active)
       VALUES ($1, $2, '109', '1', 'available', 'clean', FALSE)`,
      [propId, stdTypeId]
    );

    room101Id = r101.rows[0].id as string;
    room102Id = r102.rows[0].id as string;
    room104Id = r104.rows[0].id as string;
    room201Id = r201.rows[0].id as string;
    room202Id = r202.rows[0].id as string;
    room203Id = r203.rows[0].id as string;

    const g1 = await pool.query(
      `INSERT INTO guests (property_id, first_name, last_name, phone, email, vip_status)
       VALUES ($1, 'Rohan', 'Kulkarni', '+91 98201 11402', 'rohan@example.com', TRUE) RETURNING id`,
      [propId]
    );
    const g2 = await pool.query(
      `INSERT INTO guests (property_id, first_name, last_name, phone, email, vip_status)
       VALUES ($1, 'Meera', 'Iyer', '+91 98401 33910', 'meera@example.com', FALSE) RETURNING id`,
      [propId]
    );
    guest1Id = g1.rows[0].id as string;
    guest2Id = g2.rows[0].id as string;

    // Fixture A: Legitimate existing in-house reservation with past arrival [today-2, today+2) in Room 202
    inHousePastArrivalBookingRef = 'KHB-E2E-PAST1';
    const finPast = calculateReservationFinancials({
      nights: 4,
      nightlyRate: 6200,
      discountAmount: 0,
      taxRate: 12,
    });
    await pool.query(
      `INSERT INTO reservations (
         property_id, booking_reference, guest_id, room_type_id, room_id,
         arrival_date, departure_date, adults, children, num_guests,
         nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
         currency, source, status, checked_in_at, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, 2, 0, 2,
         $8, 0, 12, $9, $10,
         'INR', 'direct', 'checked_in', NOW() - INTERVAL '2 days', $11, $11
       )`,
      [
        propId,
        inHousePastArrivalBookingRef,
        guest1Id,
        dlxTypeId,
        room202Id,
        addDays(propToday, -2),
        addDays(propToday, 2),
        finPast.nightlyRate,
        finPast.taxAmount,
        finPast.estimatedTotal,
        adminId,
      ]
    );

    // Fixture B: Overdue checked-in stay [today-3, today-1) in Room 201
    overdueBookingRef = 'KHB-E2E-OVD1';
    const finOvd = calculateReservationFinancials({
      nights: 2,
      nightlyRate: 6200,
      discountAmount: 0,
      taxRate: 12,
    });
    await pool.query(
      `INSERT INTO reservations (
         property_id, booking_reference, guest_id, room_type_id, room_id,
         arrival_date, departure_date, adults, children, num_guests,
         nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
         currency, source, status, checked_in_at, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, 2, 0, 2,
         $8, 0, 12, $9, $10,
         'INR', 'corporate', 'checked_in', NOW() - INTERVAL '3 days', $11, $11
       )`,
      [
        propId,
        overdueBookingRef,
        guest2Id,
        dlxTypeId,
        room201Id,
        addDays(propToday, -3),
        addDays(propToday, -1),
        finOvd.nightlyRate,
        finOvd.taxAmount,
        finOvd.estimatedTotal,
        adminId,
      ]
    );

    // Fixture C: Scheduled departure due TODAY [today-1, today) in Room 203
    dueTodayBookingRef = 'KHB-E2E-DUE1';
    const finDue = calculateReservationFinancials({
      nights: 1,
      nightlyRate: 6200,
      discountAmount: 0,
      taxRate: 12,
    });
    await pool.query(
      `INSERT INTO reservations (
         property_id, booking_reference, guest_id, room_type_id, room_id,
         arrival_date, departure_date, adults, children, num_guests,
         nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
         currency, source, status, checked_in_at, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, 2, 0, 2,
         $8, 0, 12, $9, $10,
         'INR', 'direct', 'checked_in', NOW() - INTERVAL '1 day', $11, $11
       )`,
      [
        propId,
        dueTodayBookingRef,
        guest1Id,
        dlxTypeId,
        room203Id,
        addDays(propToday, -1),
        propToday,
        finDue.nightlyRate,
        finDue.taxAmount,
        finDue.estimatedTotal,
        adminId,
      ]
    );

    // Start full Express + SPA server (production dist/client if built, else Vite middleware)
    const app = express();
    app.use(createApiApp());
    if (hasClientBuild) {
      app.use(express.static(clientDist));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(clientDist, 'index.html'));
      });
    } else {
      viteDevServer = await createViteServer({
        server: { middlewareMode: true, hmr: false },
        appType: 'spa',
      });
      app.use(viteDevServer.middlewares);
    }

    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    browser = await chromium.launch({
      executablePath: chromiumExecutable,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
      browser = null;
    }
    if (viteDevServer) {
      await viteDevServer.close();
      viteDevServer = null;
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
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

  it('verifies housekeeping summary cards, bucket filters, single-counting, and distinct operational vs housekeeping badges in browser', async () => {
    const context: BrowserContext = await browser!.newContext();
    const page = await context.newPage();
    try {
      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');

      // 6 active physical rooms:
      // 101 (available+inspected), 201 (available+inspected), 202 (available+inspected) => 3 inspected
      // 102 (available+clean) => 1 clean
      // 103 (available+dirty) => 1 dirty
      // 104 (maintenance+clean) => 1 out_of_service (must NOT be counted as clean)
      // 109 is deactivated => excluded from active room inventory
      await page.goto(`${baseUrl}/housekeeping`, { waitUntil: 'networkidle' });
      await page.locator('h1', { hasText: 'Housekeeping Room Status Board' }).waitFor();

      const readCardCount = async (label: string) => {
        const card = page.locator('button', { hasText: label }).first();
        const numText = await card.locator('p').first().innerText();
        return Number(numText.trim());
      };

      const inspectedCount = await readCardCount('Inspected (Ready)');
      const cleanCount = await readCardCount('Clean');
      const dirtyCount = await readCardCount('Dirty (Needs Turnover)');
      const oosCount = await readCardCount('Maintenance / Out of Service');

      expect(inspectedCount).toBe(4);
      expect(cleanCount).toBe(1);
      expect(dirtyCount).toBe(1);
      expect(oosCount).toBe(1);
      expect(inspectedCount + cleanCount + dirtyCount + oosCount).toBe(7);

      // Click Clean bucket filter -> only Room 102 appears; Room 104 (maintenance + clean) is excluded
      await page.locator('button', { hasText: 'Clean' }).first().click();
      await expect(page.locator('span', { hasText: 'Room 102' }).count()).resolves.toBe(1);
      await expect(page.locator('span', { hasText: 'Room 104' }).count()).resolves.toBe(0);

      // Click Maintenance / Out of Service bucket filter -> Room 104 appears with BOTH distinct badges
      await page.locator('button', { hasText: 'Maintenance / Out of Service' }).first().click();
      await expect(page.locator('span', { hasText: 'Room 104' }).count()).resolves.toBe(1);
      const room104Card = page.locator('div.rounded-2xl', { hasText: 'Room 104' }).first();
      const cardText = await room104Card.innerText();
      expect(cardText).toContain('Maintenance');
      expect(cardText).toContain('Clean');
      expect(room104Id).toBeTruthy();
    } finally {
      await context.close();
    }
  });

  it('enforces arrival-date minimum in browser create modal, rejects past arrival, allows today & future arrivals, and permits editing existing past-arrival stay', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    try {
      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');

      // Open New Reservation modal from Dashboard
      await page.locator('button', { hasText: 'New Reservation' }).click();
      const arrivalInput = page.locator('#res-arrival');
      await arrivalInput.waitFor();

      // 1. Verify HTML min attribute matches property localToday
      const minAttr = await arrivalInput.getAttribute('min');
      expect(minAttr).toBe(propToday);

      // 2. Enter past arrival date -> verify native browser rangeUnderflow AND custom form error when noValidate is set
      const yesterday = addDays(propToday, -1);
      await arrivalInput.fill(yesterday);
      const validity = await arrivalInput.evaluate((el: HTMLInputElement) => ({
        valid: el.checkValidity(),
        rangeUnderflow: el.validity.rangeUnderflow,
      }));
      expect(validity.valid).toBe(false);
      expect(validity.rangeUnderflow).toBe(true);

      // Also verify React submit handler blocks past arrival even if HTML5 validation is bypassed
      await arrivalInput.evaluate((el: HTMLInputElement) => {
        if (el.form) el.form.noValidate = true;
      });
      await page.locator('button[type="submit"]', { hasText: 'Create Reservation' }).click();
      const alertText = await page.locator('[role="alert"]').innerText();
      expect(alertText).toContain('cannot be earlier');

      // 3. Create reservation arriving TODAY in Room 101
      await arrivalInput.fill(propToday);
      await page.locator('#res-departure').fill(addDays(propToday, 2));
      await page.locator('#res-guest-select').selectOption(guest1Id);
      await page.waitForFunction(
        (rmId) => {
          const sel = document.querySelector('#res-room-select') as HTMLSelectElement | null;
          return Boolean(sel && Array.from(sel.options).some((o) => o.value === rmId && !o.disabled));
        },
        room101Id
      );
      await page.locator('#res-room-select').selectOption(room101Id);
      await page.locator('button[type="submit"]', { hasText: 'Create Reservation' }).click();
      await arrivalInput.waitFor({ state: 'detached', timeout: 10000 });

      // 4. Create reservation arriving in the FUTURE (today + 4 -> today + 6) in Room 102
      await page.locator('button', { hasText: 'New Reservation' }).click();
      await arrivalInput.waitFor();
      await arrivalInput.fill(addDays(propToday, 4));
      await page.locator('#res-departure').fill(addDays(propToday, 6));
      await page.locator('#res-guest-select').selectOption(guest2Id);
      await page.waitForFunction(
        (rmId) => {
          const sel = document.querySelector('#res-room-select') as HTMLSelectElement | null;
          return Boolean(sel && Array.from(sel.options).some((o) => o.value === rmId && !o.disabled));
        },
        room102Id
      );
      await page.locator('#res-room-select').selectOption(room102Id);
      await page.locator('button[type="submit"]', { hasText: 'Create Reservation' }).click();
      await arrivalInput.waitFor({ state: 'detached', timeout: 10000 });

      // 5. Edit legitimate existing in-house reservation whose arrival date is in the past (KHB-E2E-PAST1)
      await page.goto(`${baseUrl}/reservations`, { waitUntil: 'networkidle' });
      await page.locator('a', { hasText: inHousePastArrivalBookingRef }).first().click();
      await page.locator('h1', { hasText: inHousePastArrivalBookingRef }).waitFor();

      await page.locator('button', { hasText: 'Edit Reservation' }).click();
      const editArrivalInput = page.locator('#res-arrival');
      await editArrivalInput.waitFor();

      // In edit mode, min attribute is NOT set to today and past arrival value remains valid
      expect(await editArrivalInput.getAttribute('min')).toBeNull();
      expect(await editArrivalInput.inputValue()).toBe(addDays(propToday, -2));
      const editValid = await editArrivalInput.evaluate((el: HTMLInputElement) => el.checkValidity());
      expect(editValid).toBe(true);

      // Extend departure by 1 night and add special request, then save
      const extendedDeparture = addDays(propToday, 3);
      await page.locator('#res-departure').fill(extendedDeparture);
      await page.locator('#res-requests').fill('Extended stay by 1 night via browser test');
      await page.locator('#res-edit-reason').fill('Guest requested stay extension');
      await page.locator('button[type="submit"]', { hasText: 'Save Changes' }).click();
      await editArrivalInput.waitFor({ state: 'detached', timeout: 10000 });

      await expect(page.locator('body').innerText()).resolves.toContain(
        'Extended stay by 1 night via browser test'
      );
    } finally {
      await context.close();
    }
  });

  it('verifies overdue check-out dashboard callout, counter, deskboard tab, quick filter, room occupancy retention, and deliberate resolution', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    try {
      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');

      // 1. Verify Dashboard overdue callout banner, counter, and Overdue (1) deskboard tab
      const overdueRegion = page.locator(
        '[role="region"][aria-label="Overdue check-outs requiring resolution"]'
      );
      await overdueRegion.waitFor();
      expect(await overdueRegion.innerText()).toContain(overdueBookingRef);
      expect(await overdueRegion.innerText()).toContain('Overdue Check-Outs Requiring Resolution (1)');
      expect(await page.locator('body').innerText()).toContain('1 overdue past departure');

      // Click Overdue (1) deskboard tab
      await page.locator('button', { hasText: 'Overdue (1)' }).click();
      expect(await page.locator('body').innerText()).toContain('Resolve Stay');

      // 2. Verify Notification Bell contains urgent overdue alert and navigates to quickFilter=overdue_checkouts
      await page.locator('button[aria-label="Operational notifications"]').click();
      const urgentAlertBtn = page.locator('button', {
        hasText: '1 overdue check-out past scheduled departure',
      });
      await urgentAlertBtn.waitFor();
      await urgentAlertBtn.click();

      await page.waitForURL((url) => url.searchParams.get('quickFilter') === 'overdue_checkouts');
      await page.locator('a', { hasText: overdueBookingRef }).waitFor();
      expect(await page.locator('tbody').innerText()).toContain('Checked In');
      expect(await page.locator('tbody').innerText()).not.toContain(dueTodayBookingRef);

      // Verify Departures Today tab shows due-today departure and NOT overdue departure
      await page.locator('button', { hasText: 'Departures Today' }).click();
      await page.locator('a', { hasText: dueTodayBookingRef }).waitFor();
      expect(await page.locator('tbody').innerText()).not.toContain(overdueBookingRef);

      // 3. Confirm Room 201 remains Occupied on /rooms until deliberate check-out
      await page.goto(`${baseUrl}/rooms`, { waitUntil: 'networkidle' });
      const room201Row = page.locator('tr', { hasText: 'Room 201' });
      await room201Row.waitFor();
      expect(await room201Row.innerText()).toContain('Occupied: Meera Iyer');
      expect(await room201Row.innerText()).toContain(overdueBookingRef);

      // 4. Deliberately resolve overdue stay on ReservationDetailPage (update departure to today & check out)
      await page.locator('a', { hasText: overdueBookingRef }).click();
      await page.locator('h1', { hasText: overdueBookingRef }).waitFor();
      await page.locator('button', { hasText: 'Check Out Guest' }).click();

      const resolveBtn = page.locator('button', {
        hasText: `Update Departure to ${propToday} & Check Out`,
      });
      await resolveBtn.waitFor();
      await page.locator('#checkout-note').fill('Late departure reconciled and settled');
      await resolveBtn.click();
      await page.locator('#checkout-note').waitFor({ state: 'detached', timeout: 15000 });

      await page.waitForFunction(() => document.body.innerText.includes('Checked Out'));

      // 5. Confirm Dashboard overdue callout and counter clear and Room 201 is released + marked Dirty
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await page.locator('h1', { hasText: 'Front Office Dashboard' }).waitFor();
      expect(await overdueRegion.count()).toBe(0);
      expect(await page.locator('body').innerText()).not.toContain('overdue past departure');
      await page.locator('button', { hasText: 'Overdue (0)' }).waitFor();

      await page.goto(`${baseUrl}/rooms`, { waitUntil: 'networkidle' });
      const room201After = page.locator('tr', { hasText: 'Room 201' });
      await room201After.waitFor();
      expect(await room201After.innerText()).toContain('Vacant');
      expect(await room201After.innerText()).toContain('Dirty');
    } finally {
      await context.close();
    }
  });

  it('verifies receptionist reservation workflow (create, list visibility, check-in, check-out) and room-management restrictions', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    try {
      await signInViaUi(page, 'frontdesk@staycraft.local', 'FrontDesk@123');

      // 1. Receptionist creates a booking arriving today in Room 102 (1 night: today -> tomorrow)
      await page.locator('button', { hasText: 'New Reservation' }).click();
      await page.locator('#res-arrival').waitFor();
      await page.locator('#res-arrival').fill(propToday);
      await page.locator('#res-departure').fill(addDays(propToday, 1));
      await page.locator('#res-guest-select').selectOption(guest1Id);
      await page.waitForFunction(
        (rmId) => {
          const sel = document.querySelector('#res-room-select') as HTMLSelectElement | null;
          return Boolean(sel && Array.from(sel.options).some((o) => o.value === rmId && !o.disabled));
        },
        room102Id
      );
      await page.locator('#res-room-select').selectOption(room102Id);
      await page.locator('#res-requests').fill('Receptionist E2E booking check');
      await page.locator('button[type="submit"]', { hasText: 'Create Reservation' }).click();
      await page.locator('#res-arrival').waitFor({ state: 'detached', timeout: 10000 });

      // 2. Verify visibility in /reservations Arrivals Today list and open detail page
      await page.goto(`${baseUrl}/reservations`, { waitUntil: 'networkidle' });
      await page.locator('button', { hasText: 'Arrivals Today' }).click();
      const createdRow = page.locator('tbody tr', { hasText: '102' }).first();
      await createdRow.waitFor();
      const createdRef = (await createdRow.locator('td a').first().innerText()).trim();
      expect(createdRef).toMatch(/^KHB-/);

      await createdRow.locator('td a').first().click();
      await page.locator('h1', { hasText: createdRef }).waitFor();

      // 3. Check in the guest via browser modal
      await page.locator('button', { hasText: 'Check In Guest' }).click();
      await page.locator('#checkin-note').fill('Front desk ID checked');
      await page.locator('button', { hasText: 'Complete Check-In' }).click();
      await page.locator('button', { hasText: 'Check Out Guest' }).waitFor({ timeout: 10000 });

      // 4. Complete standard scheduled Check-Out on due-today stay (KHB-E2E-DUE1 in Room 203)
      await page.goto(`${baseUrl}/reservations`, { waitUntil: 'networkidle' });
      await page.locator('button', { hasText: 'Departures Today' }).click();
      await page.locator('a', { hasText: dueTodayBookingRef }).click();
      await page.locator('h1', { hasText: dueTodayBookingRef }).waitFor();

      await page.locator('button', { hasText: 'Check Out Guest' }).click();
      await page.locator('#checkout-note').fill('Keys returned at front desk');
      await page.locator('button', { hasText: 'Complete Check-Out' }).click();
      await page.waitForFunction(() => document.body.innerText.includes('Checked Out'));

      // 5. Verify Receptionist UI & API restrictions on /rooms (and Room 203 marked Dirty after check-out)
      await page.goto(`${baseUrl}/rooms`, { waitUntil: 'networkidle' });
      await page.locator('h1', { hasText: 'Room Types & Room Inventory' }).waitFor();

      const room203Row = page.locator('tr', { hasText: 'Room 203' });
      await room203Row.waitFor();
      expect(await room203Row.innerText()).toContain('Vacant');
      expect(await room203Row.innerText()).toContain('Dirty');

      expect(await page.locator('body').innerText()).toContain(
        'Administrator role required to add/edit room inventory'
      );
      expect(await page.locator('button', { hasText: 'Add Room' }).count()).toBe(0);
      expect(await page.locator('button', { hasText: 'New Category' }).count()).toBe(0);
      expect(await page.locator('button[title="Edit room"]').count()).toBe(0);

      // Verify server-side 403 enforcement directly from receptionist's authenticated browser session
      const statuses = await page.evaluate(
        async ({ pId, rtId, rmId }) => {
          const token =
            window.sessionStorage.getItem('staycraft_opaque_session') ??
            window.localStorage.getItem('staycraft_opaque_session') ??
            '';
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Property-Id': pId,
          };
          if (token) {
            headers['X-Session-Token'] = token;
            headers.Authorization = `Bearer ${token}`;
          }

          const postRoom = await fetch('/api/rooms', {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify({ roomTypeId: rtId, roomNumber: '888', floor: '8' }),
          });
          const putRoom = await fetch(`/api/rooms/${rmId}`, {
            method: 'PUT',
            headers,
            credentials: 'include',
            body: JSON.stringify({ notes: 'Unauthorized edit' }),
          });
          const postCat = await fetch('/api/room-types', {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify({
              code: 'UNAUTH',
              name: 'Unauthorized',
              baseCapacity: 2,
              maxCapacity: 2,
              baseRate: 3000,
            }),
          });

          return {
            postRoom: postRoom.status,
            putRoom: putRoom.status,
            postCat: postCat.status,
          };
        },
        { pId: propId, rtId: stdTypeId, rmId: room101Id }
      );

      expect(statuses).toEqual({
        postRoom: 403,
        putRoom: 403,
        postCat: 403,
      });
    } finally {
      await context.close();
    }
  });

  it('Phase 2 E2E: manages housekeeping tasks (auto-turnover from checkout, create, assign, start, filter) and cleaning/inspection workflow without altering in-house occupancy', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    try {
      await signInViaUi(page, 'frontdesk@staycraft.local', 'FrontDesk@123');

      // 1. Open Housekeeping Tasks tab -> verify auto-generated Turnover Clean task from Room 203 checkout exists
      await page.goto(`${baseUrl}/housekeeping?tab=tasks`, { waitUntil: 'networkidle' });
      await page.locator('h1', { hasText: 'Housekeeping Room Status Board' }).waitFor();
      expect(await page.locator('tbody').innerText()).toContain('Room 203');
      expect(await page.locator('tbody').innerText()).toContain('Turnover Clean');

      // 2. Create a new Urgent Deep Clean task on Dirty Room 103 assigned to real staff Priya Nair
      await page.locator('button', { hasText: 'New Housekeeping Task' }).click();
      await page.locator('#hk-task-room').waitFor();
      await page.locator('#hk-task-room').selectOption(room103Id);
      await page.locator('#hk-task-type').selectOption('deep_clean');
      await page.locator('#hk-task-priority').selectOption('urgent');
      await page.locator('#hk-task-assignee').selectOption(receptionistId);
      await page.locator('#hk-task-notes').fill('Browser E2E balcony sanitize & linen refresh');
      await page.locator('button[type="submit"]', { hasText: 'Create Task' }).click();
      await page.locator('#hk-task-room').waitFor({ state: 'detached', timeout: 10000 });

      // 3. Search & filter tasks -> Start task -> verify Room 103 transitions to Cleaning in Progress
      await page.locator('input[aria-label="Search housekeeping tasks"]').fill('balcony sanitize');
      const taskRow = page.locator('tbody tr', { hasText: 'Room 103' }).first();
      await taskRow.waitFor();
      expect(await taskRow.innerText()).toContain('Priya Nair');
      expect(await taskRow.innerText()).toContain('Urgent');

      await taskRow.locator('button', { hasText: 'Start' }).click();
      await page.waitForFunction(() => {
        const txt = document.querySelector('tbody')?.innerText ?? '';
        return txt.includes('In Progress') && txt.includes('Cleaning in Progress');
      });

      // 4. Switch to Cleaning & Inspection Board -> complete Mark Clean -> Mark Inspected on Room 103
      await page.locator('button', { hasText: 'Cleaning & Inspection Board' }).click();
      const room103Card = page.locator('div.rounded-2xl', { hasText: 'Room 103' }).first();
      await room103Card.waitFor();
      expect(await room103Card.innerText()).toContain('Cleaning in Progress');

      await room103Card.locator('button', { hasText: 'Mark Clean' }).click();
      await room103Card.locator('button', { hasText: 'Mark Inspected' }).waitFor({ timeout: 10000 });
      await room103Card.locator('button', { hasText: 'Mark Inspected' }).click();
      await page.waitForFunction(() => {
        const cards = Array.from(document.querySelectorAll('div.rounded-2xl'));
        const r103 = cards.find((el) => (el as HTMLElement).innerText.includes('Room 103'));
        return Boolean(r103 && (r103 as HTMLElement).innerText.includes('Inspected'));
      });

      // 5. Stayover housekeeping on occupied Room 202 must NEVER alter reservation status or mark room Vacant
      const room202Card = page.locator('div.rounded-2xl', { hasText: 'Room 202' }).first();
      expect(await room202Card.innerText()).toContain('In-House: Rohan Kulkarni');
      await room202Card.locator('button', { hasText: 'Mark Dirty' }).click();
      await room202Card.locator('button', { hasText: 'Start Cleaning' }).waitFor({ timeout: 10000 });
      expect(await room202Card.innerText()).toContain('In-House: Rohan Kulkarni');
      await room202Card.locator('button', { hasText: 'Start Cleaning' }).click();
      await room202Card.locator('button', { hasText: 'Mark Clean' }).waitFor({ timeout: 10000 });
      await room202Card.locator('button', { hasText: 'Mark Clean' }).click();
      await room202Card.locator('button', { hasText: 'Mark Inspected' }).waitFor({ timeout: 10000 });
      expect(await room202Card.innerText()).toContain('In-House: Rohan Kulkarni');
    } finally {
      await context.close();
    }
  });

  it('Phase 2 E2E: enforces maintenance RBAC, surfaces affected stays on out-of-service with explicit room reassignment, and restores room with history', async () => {
    // Part A: Receptionist can report minor maintenance but cannot place room Out of Service
    const recCtx = await browser!.newContext();
    const recPage = await recCtx.newPage();
    try {
      await signInViaUi(recPage, 'frontdesk@staycraft.local', 'FrontDesk@123');
      await recPage.goto(`${baseUrl}/housekeeping?tab=maintenance`, { waitUntil: 'networkidle' });
      expect(await recPage.locator('button', { hasText: 'Place Room Out of Service' }).count()).toBe(0);

      await recPage.locator('button', { hasText: 'Report Maintenance' }).click();
      await recPage.locator('#maint-room').waitFor();
      expect(await recPage.locator('#maint-impact').isDisabled()).toBe(true);
      await recPage.locator('#maint-room').selectOption(room103Id);
      await recPage.locator('#maint-title').fill('Loose bathroom towel bar');
      await recPage.locator('#maint-desc').fill('Tighten wall anchor screws');
      await recPage.locator('button[type="submit"]', { hasText: 'Save Maintenance Request' }).click();
      await recPage.locator('#maint-room').waitFor({ state: 'detached', timeout: 10000 });
      expect(await recPage.locator('tbody').innerText()).toContain('Loose bathroom towel bar');

      // Direct API OOS attempt from receptionist browser session -> 403
      const oosStatus = await recPage.evaluate(
        async ({ pId, rmId, today }) => {
          const token =
            window.sessionStorage.getItem('staycraft_opaque_session') ??
            window.localStorage.getItem('staycraft_opaque_session') ??
            '';
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Property-Id': pId,
          };
          if (token) {
            headers['X-Session-Token'] = token;
            headers.Authorization = `Bearer ${token}`;
          }
          const res = await fetch(`/api/rooms/${rmId}/out-of-service`, {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify({
              category: 'hvac',
              title: 'Unauth OOS',
              description: 'Unauth',
              priority: 'high',
              operationalImpact: 'out_of_service',
              unavailableFrom: today,
            }),
          });
          return res.status;
        },
        { pId: propId, rmId: room103Id, today: propToday }
      );
      expect(oosStatus).toBe(403);
    } finally {
      await recCtx.close();
    }

    // Part B: Admin places Room 101 Out of Service -> resolves affected stay explicitly by reassigning to Room 103 -> restores Room 101
    const adminCtx = await browser!.newContext();
    const adminPage = await adminCtx.newPage();
    try {
      await signInViaUi(adminPage, 'admin@staycraft.local', 'Admin@12345');
      await adminPage.goto(`${baseUrl}/housekeeping?tab=maintenance`, { waitUntil: 'networkidle' });

      await adminPage.locator('button', { hasText: 'Place Room Out of Service' }).click();
      await adminPage.locator('#maint-room').waitFor();
      await adminPage.locator('#maint-room').selectOption(room101Id);
      await adminPage.locator('#maint-cat').selectOption('hvac');
      await adminPage.locator('#maint-title').fill('AC Condenser Coil Leak');
      await adminPage.locator('#maint-desc').fill('Requires copper brazing and vacuum recharge');
      await adminPage.locator('#maint-from').fill(propToday);
      await adminPage.locator('#maint-to').fill(addDays(propToday, 3));

      // Live conflict region surfaces existing confirmed reservation on Room 101!
      const conflictRegion = adminPage.locator(
        '[role="region"][aria-label="Affected stays conflicting with unavailable period"]'
      );
      await conflictRegion.waitFor({ timeout: 10000 });
      expect(await conflictRegion.innerText()).toContain('Existing Reservation');

      // Explicitly reassign the affected booking to Room 103 via Reassign Room modal
      await conflictRegion.locator('button', { hasText: 'Reassign Room' }).click();
      await adminPage.locator('#res-room-select').waitFor();
      await adminPage.waitForFunction(
        (rmId) => {
          const sel = document.querySelector('#res-room-select') as HTMLSelectElement | null;
          return Boolean(sel && Array.from(sel.options).some((o) => o.value === rmId && !o.disabled));
        },
        room103Id
      );
      await adminPage.locator('#res-room-select').selectOption(room103Id);
      await adminPage.locator('#res-edit-reason').fill('Reassigned prior to Room 101 OOS');
      await adminPage.locator('button[type="submit"]', { hasText: 'Save Changes' }).click();
      await adminPage.locator('#res-room-select').waitFor({ state: 'detached', timeout: 10000 });

      // Conflict region clears automatically once affected stay is reassigned
      await conflictRegion.waitFor({ state: 'detached', timeout: 10000 });
      await adminPage.locator('button[type="submit"]', { hasText: 'Save Maintenance Request' }).click();
      await adminPage.locator('#maint-room').waitFor({ state: 'detached', timeout: 10000 });

      // Verify single-counted bucket cards: Maintenance / Out of Service is now 2 (Room 104 + Room 101), total still 7
      const readBucket = async (label: string) => {
        const card = adminPage.locator('button', { hasText: label }).first();
        return Number((await card.locator('p').first().innerText()).trim());
      };
      const iCnt = await readBucket('Inspected (Ready)');
      const cCnt = await readBucket('Clean');
      const dCnt = await readBucket('Dirty (Needs Turnover)');
      const oCnt = await readBucket('Maintenance / Out of Service');
      expect(oCnt).toBe(2);
      expect(iCnt + cCnt + dCnt + oCnt).toBe(7);

      // Restore Room 101 to service with resolution notes
      const room101MaintRow = adminPage.locator('tbody tr', { hasText: 'AC Condenser Coil Leak' }).first();
      await room101MaintRow.locator('button', { hasText: 'Restore Room' }).click();
      await adminPage.locator('#restore-hk-status').waitFor();
      await adminPage.locator('#restore-hk-status').selectOption('dirty');
      await adminPage.locator('#restore-notes').fill('Brazed leak, pressure-tested, safe for service');
      await adminPage.locator('button[type="submit"]', { hasText: 'Restore to Service' }).click();
      await adminPage.locator('#restore-notes').waitFor({ state: 'detached', timeout: 10000 });

      // Inspect Room 101 Maintenance History on /rooms
      await adminPage.goto(`${baseUrl}/rooms`, { waitUntil: 'networkidle' });
      const room101Row = adminPage.locator('tbody tr', { hasText: 'Room 101' }).first();
      expect(await room101Row.innerText()).toContain('Operational');
      expect(await room101Row.innerText()).toContain('Dirty');
      await room101Row.locator('button', { hasText: 'Maintenance History' }).click();
      await adminPage.locator('h2', { hasText: 'Room 101 — Maintenance & Out-of-Service History' }).waitFor();
      expect(await adminPage.locator('body').innerText()).toContain('Brazed leak, pressure-tested');
      expect(await adminPage.locator('body').innerText()).toContain('Resolved');
    } finally {
      await adminCtx.close();
    }
  });

  it('Phase 2 E2E: renders room-by-date calendar boundaries, prefills room/date booking with cleanliness warning, and enforces clean room before check-in', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    try {
      await signInViaUi(page, 'frontdesk@staycraft.local', 'FrontDesk@123');

      // 1. Navigate to Room Calendar via sidebar
      await page.locator('a', { hasText: 'Room Calendar' }).first().click();
      await page.locator('h1', { hasText: 'Room-by-Date Reservation Calendar' }).waitFor();
      const grid = page.locator('[data-testid="room-calendar-grid"]');
      await grid.waitFor();

      // Verify Room 202 in-house stay [today-2, today+3) spans 3 visible columns starting at propToday
      const room202Row = grid.locator('tr[data-room-number="202"]');
      const pastStayCell = room202Row.locator('td', { hasText: inHousePastArrivalBookingRef });
      await pastStayCell.waitFor();
      expect(await pastStayCell.getAttribute('colspan')).toBe('3');

      // Verify date range navigation (+1d -> Today -> 7 Nights) & responsive Mobile / Room List mode
      await page.locator('button[aria-label="Next day"]').click();
      await page.waitForFunction(
        (expectedDate) => Boolean(document.querySelector(`th[data-calendar-date="${expectedDate}"]`)),
        addDays(propToday, 1)
      );
      await page.locator('button', { hasText: 'Today' }).click();
      await page.locator('button', { hasText: '7 Nights' }).click();
      await page.waitForFunction(
        () => document.querySelectorAll('th[data-calendar-date]').length === 7
      );

      await page.locator('button', { hasText: 'Mobile / Room List' }).click();
      await page.locator('[data-testid="room-calendar-agenda"]').waitFor();
      await page.locator('button', { hasText: 'Tape Chart' }).click();
      await grid.waitFor();

      // 2. Click available cell on Dirty Room 201 for propToday -> verify safe prefill & Dirty warning
      await page.locator(`button[aria-label="Book Room 201 from ${propToday}"]`).click();
      await page.locator('#res-room-select').waitFor();
      expect(await page.locator('#res-room-select').inputValue()).toBe(room201Id);
      expect(await page.locator('#res-arrival').inputValue()).toBe(propToday);
      expect(await page.locator('body').innerText()).toContain('Room 201 is currently marked Dirty');

      await page.locator('#res-departure').fill(addDays(propToday, 1));
      await page.locator('#res-guest-select').selectOption(guest2Id);
      await page.locator('button[type="submit"]', { hasText: 'Create Reservation' }).click();
      await page.locator('#res-room-select').waitFor({ state: 'detached', timeout: 10000 });

      // 3. Click newly created booking bar on Room 201 row in Calendar -> opens Reservation Detail
      const room201CalRow = grid.locator('tr[data-room-number="201"]');
      const newStayLink = room201CalRow.locator('a', { hasText: 'Meera Iyer' }).first();
      await newStayLink.waitFor();
      await newStayLink.click();
      await page.locator('button', { hasText: 'Check In Guest' }).waitFor();

      // 4. Verify Check-In is blocked while Dirty AND while Cleaning in Progress, then succeeds once Clean
      await page.locator('button', { hasText: 'Check In Guest' }).click();
      const completeCheckInBtn = page.locator('button', { hasText: 'Complete Check-In' });
      await completeCheckInBtn.waitFor();
      expect(await completeCheckInBtn.isDisabled()).toBe(true);

      await page.locator('button', { hasText: 'Start Cleaning' }).last().click();
      await page.waitForFunction(() =>
        document.body.innerText.includes('currently in Cleaning in Progress')
      );
      expect(await completeCheckInBtn.isDisabled()).toBe(true);

      await page.locator('button', { hasText: 'Mark Room Clean Now' }).click();
      await page.waitForFunction(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('Complete Check-In')
        ) as HTMLButtonElement | undefined;
        return Boolean(btn && !btn.disabled);
      });
      await completeCheckInBtn.click();
      await page.locator('button', { hasText: 'Check Out Guest' }).waitFor({ timeout: 10000 });
    } finally {
      await context.close();
    }
  });

  it('Phase 2 Audit E2E: verifies calendar month/year boundaries without mutating stays, empty/error UI states, and full refresh persistence', async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      // 1. Verify invalid credentials error banner ([role="alert"]) before valid login
      await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
      await page.locator('#login-email').fill('admin@staycraft.local');
      await page.locator('#login-password').fill('WrongPassword999');
      await page.locator('button[type="submit"]', { hasText: 'Sign In' }).click();
      const loginAlert = page.locator('[role="alert"]');
      await loginAlert.waitFor();
      expect((await loginAlert.innerText()).toLowerCase()).toContain('invalid');

      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');

      // Snapshot all reservation updated_at timestamps in staycraft_pms_test before calendar navigation
      const pool = getPool();
      const beforeRes = await pool.query(
        'SELECT id, status, updated_at FROM reservations WHERE property_id = $1 ORDER BY id',
        [propId]
      );

      // 2. Navigate Calendar across Year Boundary (2026-12-28 -> 2027-01-03) and Feb->Mar Boundary (2027-02-26 -> 2027-03-04)
      await page.goto(`${baseUrl}/calendar`, { waitUntil: 'networkidle' });
      await page.locator('[data-testid="room-calendar-grid"]').waitFor();
      await page.locator('button', { hasText: '7 Nights' }).click();
      await page.locator('#cal-start-date').fill('2026-12-28');
      await page.waitForFunction(() =>
        Boolean(
          document.querySelector('th[data-calendar-date="2026-12-31"]') &&
            document.querySelector('th[data-calendar-date="2027-01-01"]')
        )
      );

      await page.locator('#cal-start-date').fill('2027-02-26');
      await page.waitForFunction(() =>
        Boolean(
          document.querySelector('th[data-calendar-date="2027-02-28"]') &&
            document.querySelector('th[data-calendar-date="2027-03-01"]')
        )
      );

      // Confirm zero reservation mutations occurred from calendar navigation
      const afterRes = await pool.query(
        'SELECT id, status, updated_at FROM reservations WHERE property_id = $1 ORDER BY id',
        [propId]
      );
      expect(afterRes.rows).toEqual(beforeRes.rows);

      // 3. Verify Empty States on Calendar, Housekeeping Board, Tasks, and Maintenance
      await page.locator('input[aria-label="Search calendar rooms"]').fill('ZZZ_NO_MATCH_999');
      await page.locator('h3', { hasText: 'No rooms match selected filter' }).waitFor();
      await page.locator('input[aria-label="Search calendar rooms"]').fill('');
      await page.locator('[data-testid="room-calendar-grid"]').waitFor();

      await page.goto(`${baseUrl}/housekeeping`, { waitUntil: 'networkidle' });
      await page.locator('input[aria-label="Search housekeeping board"]').fill('ZZZ_NO_ROOM');
      await page.locator('h3', { hasText: 'No rooms match selected Housekeeping filter' }).waitFor();
      await page.locator('input[aria-label="Search housekeeping board"]').fill('');

      await page.locator('button', { hasText: 'Housekeeping Tasks' }).click();
      await page.locator('input[aria-label="Search housekeeping tasks"]').fill('ZZZ_NO_TASK');
      await page.locator('h3', { hasText: 'No housekeeping tasks match current filter' }).waitFor();
      await page.locator('input[aria-label="Search housekeeping tasks"]').fill('');

      await page.locator('button', { hasText: 'Maintenance & Out of Service' }).click();
      await page.locator('input[aria-label="Search maintenance requests"]').fill('ZZZ_NO_MAINT');
      await page.locator('h3', { hasText: 'No maintenance records match current filter' }).waitFor();
      await page.locator('input[aria-label="Search maintenance requests"]').fill('');

      // 4. Verify Form Error Alert in Maintenance Modal when end date <= start date
      await page.locator('button', { hasText: 'Place Room Out of Service' }).click();
      await page.locator('#maint-room').waitFor();
      await page.locator('#maint-title').fill('Invalid window test');
      await page.locator('#maint-desc').fill('End before start');
      await page.locator('#maint-from').fill(addDays(propToday, 5));
      await page.locator('#maint-to').fill(addDays(propToday, 4));
      await page.locator('button[type="submit"]', { hasText: 'Save Maintenance Request' }).click();
      const modalAlert = page.locator('[role="dialog"] [role="alert"]');
      await modalAlert.waitFor();
      expect((await modalAlert.innerText()).toLowerCase()).toContain('after');
      await page.locator('[role="dialog"] button', { hasText: 'Cancel' }).click();

      // 5. Verify Persistence After Full Browser Reload across Housekeeping, Calendar, and Dashboard
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('h1', { hasText: 'Housekeeping Room Status Board' }).waitFor();
      expect(await page.locator('tbody').innerText()).toContain('AC Condenser Coil Leak');

      await page.goto(`${baseUrl}/calendar`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('[data-testid="room-calendar-grid"]').waitFor();
      expect(await page.locator('body').innerText()).toContain(inHousePastArrivalBookingRef);

      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('h1', { hasText: 'Front Office Dashboard' }).waitFor();
      expect(await page.locator('body').innerText()).toContain('Open HK Tasks:');
    } finally {
      await context.close();
    }
  });

  it('Phase 2 Audit E2E: verifies responsive mobile layout (375x812), mobile navigation drawer, dialog ARIA attributes, and zero viewport overflow', async () => {
    const context = await browser!.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    try {
      await signInViaUi(page, 'frontdesk@staycraft.local', 'FrontDesk@123');

      // Verify zero horizontal page overflow on mobile Dashboard
      const dashOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      expect(dashOverflow).toBe(false);

      // Open mobile navigation drawer via accessible aria-label and navigate to Room Calendar
      const menuBtn = page.locator('button[aria-label="Open navigation menu"]');
      await menuBtn.waitFor();
      await menuBtn.click();
      await page.locator('aside a', { hasText: 'Room Calendar' }).last().click();
      await page.locator('h1', { hasText: 'Room-by-Date Reservation Calendar' }).waitFor();

      // Verify zero horizontal document overflow even when Tape Chart table scrolls internally
      const calGridOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      expect(calGridOverflow).toBe(false);

      // Switch to Mobile / Room List card view on 375px screen and open dialog to verify role="dialog" + aria-modal="true"
      await page.locator('button', { hasText: 'Mobile / Room List' }).click();
      await page.locator('[data-testid="room-calendar-agenda"]').waitFor();
      await page.locator('button', { hasText: '+ Book Room' }).first().click();

      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor();
      expect(await dialog.getAttribute('aria-modal')).toBe('true');
      await dialog.locator('button[aria-label="Close dialog"]').click();
      await dialog.waitFor({ state: 'detached' });

      // Navigate via mobile drawer to Housekeeping and verify mobile usability & zero overflow
      await menuBtn.click();
      await page.locator('aside a', { hasText: 'Housekeeping' }).last().click();
      await page.locator('h1', { hasText: 'Housekeeping Room Status Board' }).waitFor();
      const hkOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      expect(hkOverflow).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('Phase 3 Billing & Invoices E2E: verifies invoice generation, draft/issued states, print view, folio items, partial/full payments, checkout integration, and reload persistence', async () => {
    const pool = getPool();

    // Seed an isolated checked-in room & reservation departing today for Phase 3 E2E
    const r301 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
       VALUES ($1, $2, '301', '3', 'inspected', 'available') RETURNING id`,
      [propId, dlxTypeId]
    );
    const room301Id = r301.rows[0].id as string;

    const e2eFin = calculateReservationFinancials({
      nights: 2,
      nightlyRate: 4500,
      discountAmount: 0,
      taxRate: 12,
    });

    const p3Res = await pool.query(
      `INSERT INTO reservations (
         property_id, booking_reference, guest_id, room_type_id, room_id,
         status, source, arrival_date, departure_date, adults, children, num_guests,
         nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total, currency,
         checked_in_at, created_by, updated_by
       ) VALUES (
         $1, 'BK-P3-E2E', $2, $3, $4,
         'checked_in', 'direct', $5, $6, 2, 0, 2,
         $7, 0, 12.00, $8, $9, 'INR',
         NOW() - INTERVAL '2 days', $10, $10
       ) RETURNING id`,
      [
        propId,
        guest1Id,
        dlxTypeId,
        room301Id,
        addDays(propToday, -2),
        propToday,
        e2eFin.nightlyRate,
        e2eFin.taxAmount,
        e2eFin.estimatedTotal,
        receptionistId,
      ]
    );
    const p3ReservationId = p3Res.rows[0].id as string;

    const context = await browser!.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();

    try {
      await signInViaUi(page, 'frontdesk@staycraft.local', 'FrontDesk@123');

      // 1. Navigate to Invoices via Sidebar
      await page.locator('aside a', { hasText: 'Invoices' }).first().click();
      await page.locator('h1', { hasText: 'Billing & Invoices' }).waitFor();

      // 2. Generate Draft Invoice for BK-P3-E2E via Generate Invoice modal
      await page.locator('button', { hasText: 'Generate Invoice' }).first().click();
      await page.locator('#invoice-res-search').waitFor();
      await page.locator('#invoice-res-search').fill('BK-P3-E2E');
      await page.locator('#invoice-reservation-select option', { hasText: 'BK-P3-E2E' }).waitFor({
        state: 'attached',
      });
      await page.locator('#invoice-reservation-select').selectOption(p3ReservationId);
      await page.locator('button[type="submit"]', { hasText: 'Generate Draft Invoice' }).click();

      // Lands on InvoiceDetailPage
      await page.locator('[data-testid="invoice-print-sheet"]').waitFor();
      expect(await page.locator('body').innerText()).toContain('Draft');
      expect(await page.locator('body').innerText()).toContain('Room 301');

      // 3. Issue Invoice -> status transitions from Draft to Issued (Unpaid)
      await page.locator('button', { hasText: 'Issue Invoice' }).click();
      await page.locator('span', { hasText: 'Issued (Unpaid)' }).first().waitFor();

      // 4. Verify Print-Friendly View toggle
      await page.locator('button', { hasText: 'Print View' }).click();
      await page.locator('button', { hasText: 'Exit Print View' }).waitFor();
      expect(await page.locator('[data-testid="invoice-print-sheet"]').isVisible()).toBe(true);
      await page.locator('button', { hasText: 'Exit Print View' }).click();

      // 5. Add an itemized Additional Service folio charge (1000.00 + 12% GST = 1120.00 -> Total 11,200.00)
      await page.locator('button', { hasText: 'Add Folio Item' }).click();
      await page.locator('#folio-item-description').waitFor();
      await page.locator('#folio-item-description').fill('Airport Sedan Transfer');
      await page.locator('#folio-item-price').fill('1000');
      await page.locator('button[type="submit"]', { hasText: 'Post Folio Item' }).click();
      await page.locator('td', { hasText: 'Airport Sedan Transfer' }).waitFor();

      // 6. Validate overpayment rejection and then record Partial Payment (4,200.00 -> Balance Due 7,000.00)
      await page.locator('button', { hasText: 'Record Payment' }).first().click();
      await page.locator('#payment-amount').waitFor();
      // Remove HTML max attribute transiently to verify API/UI overpayment error handling
      await page.locator('#payment-amount').evaluate((el) => el.removeAttribute('max'));
      await page.locator('#payment-amount').fill('99999');
      await page.locator('[role="dialog"] button[type="submit"]', { hasText: 'Record Payment' }).click();
      const payErr = page.locator('[role="dialog"] [role="alert"]');
      await payErr.waitFor();
      expect((await payErr.innerText()).toLowerCase()).toContain('exceeds');

      // Now enter valid partial payment of 4200 via UPI
      await page.locator('#payment-amount').fill('4200');
      await page.locator('#payment-method').selectOption('upi');
      await page.locator('#payment-reference').fill('UPI-E2E-4200');
      await page.locator('[role="dialog"] button[type="submit"]', { hasText: 'Record Payment' }).click();
      await page.locator('td', { hasText: 'UPI-E2E-4200' }).waitFor();
      await page.locator('span', { hasText: 'Partially Paid' }).first().waitFor();

      // 7. Navigate to Reservation Detail & Check Out — verify checkout succeeds and does NOT auto-mark Paid
      await page.locator('a', { hasText: 'Booking BK-P3-E2E' }).click();
      await page.locator('h1', { hasText: 'BK-P3-E2E' }).waitFor();
      expect(await page.locator('[data-testid="reservation-billing-panel"]').innerText()).toContain(
        'Partially Paid'
      );

      await page.locator('button', { hasText: 'Check Out' }).first().click();
      await page.locator('[role="dialog"]').waitFor();
      expect(await page.locator('[role="dialog"]').innerText()).toContain(
        'Checkout will not auto-mark unpaid balances as Paid'
      );
      await page.locator('button', { hasText: 'Complete Check-Out' }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'detached' });

      // Reservation is Checked Out, while invoice remains Partially Paid (NOT Paid!)
      await page.locator('span', { hasText: 'Checked Out' }).first().waitFor();
      expect(await page.locator('[data-testid="reservation-billing-panel"]').innerText()).toContain(
        'Partially Paid'
      );

      // 8. Record Final Settlement Payment from Reservation Detail Page -> Invoice becomes Paid with ₹0.00 balance
      await page
        .locator('[data-testid="reservation-billing-panel"] button', { hasText: 'Record Payment' })
        .click();
      await page.locator('#payment-amount').waitFor();
      await page.locator('button', { hasText: 'Full Balance' }).click();
      await page.locator('#payment-method').selectOption('card');
      await page.locator('#payment-reference').fill('POS-E2E-7000');
      await page.locator('[role="dialog"] button[type="submit"]', { hasText: 'Record Payment' }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'detached' });

      await page
        .locator('[data-testid="reservation-billing-panel"]')
        .getByText('Paid', { exact: true })
        .waitFor();

      // 9. Reload and verify full database persistence across Reservation Detail and Invoices List
      await page.reload({ waitUntil: 'networkidle' });
      expect(await page.locator('[data-testid="reservation-billing-panel"]').innerText()).toContain(
        'Paid'
      );

      await page.goto(`${baseUrl}/invoices`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Paid', exact: true }).click();
      await page.locator('a', { hasText: 'BK-P3-E2E' }).first().waitFor();
      expect(await page.locator('body').innerText()).toContain('BK-P3-E2E');
    } finally {
      await context.close();
    }
  });

  it('Phase 4 Food Ordering & Restaurant Management E2E: verifies menu CRUD, room-service & POS ordering, kitchen board workflow, folio posting without auto-paid, and auditable charge reversal', async () => {
    const pool = getPool();

    const r401 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, housekeeping_status, operational_status)
       VALUES ($1, $2, '401', '4', 'clean', 'available') RETURNING id`,
      [propId, dlxTypeId]
    );
    const room401Id = r401.rows[0].id as string;

    const stayFin = calculateReservationFinancials({
      nights: 2,
      nightlyRate: 5000,
      discountAmount: 0,
      taxRate: 12,
    });

    const p4Res = await pool.query(
      `INSERT INTO reservations (
         property_id, booking_reference, guest_id, room_type_id, room_id,
         status, source, arrival_date, departure_date, adults, children, num_guests,
         nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total, currency,
         checked_in_at, created_by, updated_by
       ) VALUES (
         $1, 'BK-P4-E2E', $2, $3, $4,
         'checked_in', 'direct', $5, $6, 2, 0, 2,
         $7, 0, 12.00, $8, $9, 'INR',
         NOW() - INTERVAL '1 day', $10, $10
       ) RETURNING id`,
      [
        propId,
        guest1Id,
        dlxTypeId,
        room401Id,
        addDays(propToday, -1),
        addDays(propToday, 1),
        stayFin.nightlyRate,
        stayFin.taxAmount,
        stayFin.estimatedTotal,
        receptionistId,
      ]
    );
    const p4ReservationId = p4Res.rows[0].id as string;

    const context = await browser!.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();

    try {
      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');

      // 1. Navigate to Restaurant & POS via Sidebar and configure Menu Category + Menu Items
      await page.locator('aside a', { hasText: 'Restaurant & POS' }).first().click();
      await page.locator('h1', { hasText: 'Restaurant, Room Service & Kitchen POS' }).waitFor();

      await page.getByRole('button', { name: 'Menu & Categories', exact: true }).click();
      await page.locator('[data-testid="menu-management-view"]').waitFor();

      await page.getByRole('button', { name: 'New Category', exact: true }).click();
      await page.locator('#cat-code').waitFor();
      await page.locator('#cat-code').fill('THALI');
      await page.locator('#cat-name').fill('Heritage Thali & Mains');
      await page.locator('#cat-desc').fill('Banarasi royal thalis and signature dishes');
      await page.locator('[role="dialog"] button[type="submit"]', { hasText: 'Create Category' }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
      await page.locator('h3', { hasText: 'Heritage Thali & Mains' }).waitFor();

      await page.getByRole('button', { name: 'New Menu Item', exact: true }).click();
      await page.locator('#menu-sku').waitFor();
      await page.locator('#menu-sku').fill('TH-01');
      await page.locator('#menu-name').fill('Kashi Royal Thali');
      await page.locator('#menu-desc').fill('Traditional Banarasi platter');
      await page.locator('#menu-price').fill('650');
      await page.locator('[role="dialog"] button[type="submit"]', { hasText: 'Create Menu Item' }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
      await page.locator('td', { hasText: 'Kashi Royal Thali' }).first().waitFor();

      await page.getByRole('button', { name: 'New Menu Item', exact: true }).click();
      await page.locator('#menu-sku').waitFor();
      await page.locator('#menu-sku').fill('TH-02');
      await page.locator('#menu-name').fill('Kesar Badam Milk');
      await page.locator('#menu-price').fill('180');
      await page.locator('#menu-dietary').selectOption('beverage');
      await page.locator('[role="dialog"] button[type="submit"]', { hasText: 'Create Menu Item' }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
      await page.locator('td', { hasText: 'Kesar Badam Milk' }).first().waitFor();

      // 2. Open Checked-In Reservation Detail Page and click "Order Room Service" shortcut
      await page.goto(`${baseUrl}/reservations/${p4ReservationId}`, { waitUntil: 'networkidle' });
      await page.locator('h1', { hasText: 'BK-P4-E2E' }).waitFor();
      await page.locator('a', { hasText: 'Order Room Service' }).click();
      await page.locator('[data-testid="restaurant-pos-view"]').waitFor();
      expect(await page.locator('#pos-room-service-stay').inputValue()).toBe(p4ReservationId);

      // 3. Build Room-Service Order (2x 650 + 1x 180 = 1480.00 subtotal + 12% GST 177.60 = 1657.60)
      await page.locator('[data-testid="pos-menu-card-TH-01"] button').click();
      await page.locator('[data-testid="pos-menu-card-TH-01"] button').click();
      await page.locator('[data-testid="pos-menu-card-TH-02"] button').click();
      await page.getByLabel('Instructions for Kashi Royal Thali').fill('No onion, extra ghee');
      await page.locator('#pos-order-notes').fill('Deliver to Room 401 balcony');
      await page.locator('button[type="submit"]', { hasText: 'Place Kitchen Order' }).click();

      // 4. Order Detail Modal opens -> verify reference & totals, then Post to Guest Folio
      await page.locator('[role="dialog"]', { hasText: 'KHB-FD-1001' }).waitFor();
      expect(await page.locator('[role="dialog"]').innerText()).toContain('1,657.60');
      await page.locator('[data-testid="order-folio-panel"] button', { hasText: 'Post to Guest Folio' }).click();
      await page
        .locator('[data-testid="order-folio-panel"]', { hasText: 'Posted to Guest Invoice' })
        .waitFor();
      await page.locator('[role="dialog"] button', { hasText: 'Close' }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'detached' });

      // 5. Open Kitchen Order Board & advance Pending -> Preparing -> Ready -> Served
      await page.getByRole('button', { name: /Kitchen Order Board/ }).click();
      await page.locator('[data-testid="kitchen-order-board"]').waitFor();
      const cardPending = page.locator('[data-testid="kitchen-col-pending"] [data-testid="kitchen-card-KHB-FD-1001"]');
      await cardPending.waitFor();
      expect(await cardPending.innerText()).toContain('Room 401');
      expect(await cardPending.innerText()).toContain('No onion, extra ghee');
      expect(await cardPending.innerText()).toContain('elapsed');

      await cardPending.getByRole('button', { name: 'Start Preparing' }).click();
      const cardPreparing = page.locator('[data-testid="kitchen-col-preparing"] [data-testid="kitchen-card-KHB-FD-1001"]');
      await cardPreparing.waitFor();

      await cardPreparing.getByRole('button', { name: 'Mark Ready' }).click();
      const cardReady = page.locator('[data-testid="kitchen-col-ready"] [data-testid="kitchen-card-KHB-FD-1001"]');
      await cardReady.waitFor();

      await cardReady.getByRole('button', { name: 'Mark Served' }).click();
      const cardServed = page.locator('[data-testid="kitchen-col-served"] [data-testid="kitchen-card-KHB-FD-1001"]');
      await cardServed.waitFor();

      // 6. Verify Orders & Room Folios ledger + Guest Invoice page (NOT auto-marked Paid & no silent delete button)
      await page.getByRole('button', { name: 'Orders & Room Folios', exact: true }).click();
      await page.locator('[data-testid="orders-ledger-view"]').waitFor();
      await page.locator('button', { hasText: 'KHB-FD-1001' }).first().waitFor();
      await page.locator('[data-testid="orders-ledger-view"] a', { hasText: 'INV-' }).first().click();

      await page.locator('[data-testid="invoice-print-sheet"]').waitFor();
      const invTextBeforeReversal = await page.locator('[data-testid="invoice-print-sheet"]').innerText();
      expect(invTextBeforeReversal).toContain('Room Service KHB-FD-1001');
      expect(invTextBeforeReversal).toContain('Draft');
      expect(
        await page
          .locator('button[aria-label*="Room Service KHB-FD-1001"]')
          .count()
      ).toBe(0);

      // 7. Perform Auditable Charge Reversal from Restaurant Orders & verify both original + reversal rows persist
      await page.locator('aside a', { hasText: 'Restaurant & POS' }).first().click();
      await page.getByRole('button', { name: 'Orders & Room Folios', exact: true }).click();
      await page.locator('button', { hasText: 'KHB-FD-1001' }).first().click();
      await page.locator('[data-testid="order-folio-panel"]').waitFor();
      await page.locator('[data-testid="order-folio-panel"] button', { hasText: 'Reverse Charge' }).click();
      await page.locator('#reverse-charge-reason').fill('Complimentary welcome dinner by GM');
      await page.locator('button[type="submit"]', { hasText: 'Confirm Charge Reversal' }).click();
      await page
        .locator('[data-testid="order-folio-panel"]', { hasText: 'Charge Reversed on Invoice' })
        .waitFor();

      await page.locator('[data-testid="order-folio-panel"] a', { hasText: 'Open Invoice' }).click();
      await page.locator('[data-testid="invoice-print-sheet"]').waitFor();
      await page.reload({ waitUntil: 'networkidle' });
      const invTextAfterReversal = await page.locator('[data-testid="invoice-print-sheet"]').innerText();
      expect(invTextAfterReversal).toContain('Room Service KHB-FD-1001');
      expect(invTextAfterReversal).toContain('Charge Reversal — Room Service KHB-FD-1001');
    } finally {
      await context.close();
    }
  });

  it('Phase 4 Regression [DEFECT-03]: enforces POS cart maximum item quantity of 500 across Add and Increase without blank-screen crash', async () => {
    const pool = getPool();
    const dbCheck = await pool.query('SELECT current_database() AS db_name');
    expect(dbCheck.rows[0]?.db_name).toBe('staycraft_pms_test');

    const context = await browser!.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const uncaughtErrors: string[] = [];
    page.on('pageerror', (err) => {
      uncaughtErrors.push(err.message);
    });

    try {
      await signInViaUi(page, 'frontdesk@staycraft.local', 'FrontDesk@123');
      await page.goto(`${baseUrl}/restaurant?tab=pos`, { waitUntil: 'networkidle' });
      await page.locator('[data-testid="restaurant-pos-view"]').waitFor();

      const addCardBtn = page.locator('[data-testid="pos-menu-card-TH-01"] button');
      await addCardBtn.waitFor();

      // Quantity = 1
      await addCardBtn.click();
      const incBtn = page.getByRole('button', { name: 'Increase Kashi Royal Thali' });
      const decBtn = page.getByRole('button', { name: 'Decrease Kashi Royal Thali' });
      await incBtn.waitFor();
      expect(await addCardBtn.innerText()).toContain('Add (1)');

      // Advance to Quantity = 499 (498 clicks)
      await incBtn.evaluate((btn: HTMLButtonElement) => {
        for (let i = 0; i < 498; i++) {
          btn.click();
        }
      });
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="pos-menu-card-TH-01"] button');
        return Boolean(el && el.textContent?.includes('Add (499)'));
      });
      expect(await incBtn.isDisabled()).toBe(false);
      expect(await addCardBtn.isDisabled()).toBe(false);

      // Advance to Quantity = 500
      await incBtn.click();
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="pos-menu-card-TH-01"] button');
        return Boolean(el && el.textContent?.includes('Add (500)'));
      });

      // At 500: both Increase and Add controls must be disabled, and user-friendly max explanation shown
      expect(await incBtn.isDisabled()).toBe(true);
      expect(await addCardBtn.isDisabled()).toBe(true);
      const maxNotice = page.locator('[data-testid="cart-max-qty-notice"]');
      await maxNotice.waitFor();
      expect(await maxNotice.innerText()).toContain('Maximum 500 units per item reached');
      expect(await page.locator('[data-testid="restaurant-pos-view"]').innerText()).toContain(
        '3,64,000.00'
      );

      // Attempted increment past 500 (501) via both Increase and Add must NOT crash or exceed 500
      await page.evaluate(() => {
        const cardBtn = document.querySelector(
          '[data-testid="pos-menu-card-TH-01"] button'
        ) as HTMLButtonElement | null;
        const plusBtn = document.querySelector(
          'button[aria-label="Increase Kashi Royal Thali"]'
        ) as HTMLButtonElement | null;
        cardBtn?.click();
        plusBtn?.click();
      });

      expect(uncaughtErrors).toEqual([]);
      expect(await page.locator('[data-testid="restaurant-pos-view"]').isVisible()).toBe(true);
      expect(await addCardBtn.innerText()).toContain('Add (500)');

      // Decreasing back to 499 re-enables increment controls cleanly
      await decBtn.click();
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="pos-menu-card-TH-01"] button');
        return Boolean(el && el.textContent?.includes('Add (499)'));
      });
      expect(await incBtn.isDisabled()).toBe(false);
      expect(await addCardBtn.isDisabled()).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('Phase 4 Regression [DEFECT-04]: Kitchen Order Board requests kitchenActiveOnly=true and keeps older active orders visible alongside >80 newer completed orders', async () => {
    const pool = getPool();
    const dbCheck = await pool.query('SELECT current_database() AS db_name');
    expect(dbCheck.rows[0]?.db_name).toBe('staycraft_pms_test');

    // Fetch TH-01 menu item on propId for realistic order item snapshots
    const menuItemRes = await pool.query(
      `SELECT m.id, m.name, m.price, c.name AS category_name
       FROM food_menu_items m
       JOIN food_categories c ON c.id = m.category_id
       WHERE m.property_id = $1 AND m.sku = 'TH-01'
       LIMIT 1`,
      [propId]
    );
    expect(menuItemRes.rowCount).toBe(1);
    const thali = menuItemRes.rows[0];

    // 1. Seed 1 older active (pending) order placed 4 hours ago
    const oldActiveIns = await pool.query(
      `INSERT INTO food_orders (
         property_id, order_reference, order_type, status, table_label, customer_name,
         subtotal, tax_name, tax_rate, tax_amount, total_amount, currency,
         notes, billing_status, placed_at, created_by, updated_by, created_at, updated_at
       ) VALUES (
         $1, 'KHB-FD-OLD-ACTIVE', 'restaurant', 'pending', 'Table 18', 'Older Active Guest',
         650.00, 'GST', 12.00, 78.00, 728.00, 'INR',
         'Must remain visible despite >80 newer completed orders', 'not_applicable',
         NOW() - INTERVAL '4 hours', $2, $2, NOW() - INTERVAL '4 hours', NOW() - INTERVAL '4 hours'
       ) RETURNING id`,
      [propId, receptionistId]
    );
    const oldActiveId = oldActiveIns.rows[0].id as string;
    await pool.query(
      `INSERT INTO food_order_items (
         order_id, menu_item_id, item_name_snapshot, category_name_snapshot,
         quantity, unit_price, line_subtotal, special_instructions, sort_order
       ) VALUES ($1, $2, $3, $4, 1, 650.00, 650.00, 'Extra papad', 10)`,
      [oldActiveId, thali.id, thali.name, thali.category_name]
    );
    await pool.query(
      `INSERT INTO food_order_status_history (order_id, property_id, from_status, to_status, note, changed_by)
       VALUES ($1, $2, NULL, 'pending', 'Seeded older active ticket', $3)`,
      [oldActiveId, propId, receptionistId]
    );

    // 2. Seed 1 cancelled ticket placed 3 hours ago (for Show Cancelled Tickets verification)
    const cancelledIns = await pool.query(
      `INSERT INTO food_orders (
         property_id, order_reference, order_type, status, table_label, customer_name,
         subtotal, tax_name, tax_rate, tax_amount, total_amount, currency,
         billing_status, placed_at, cancelled_at, cancel_reason, cancelled_by,
         created_by, updated_by, created_at, updated_at
       ) VALUES (
         $1, 'KHB-FD-CANCEL-81', 'takeaway', 'cancelled', '', 'Cancelled Guest',
         650.00, 'GST', 12.00, 78.00, 728.00, 'INR',
         'not_applicable', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '170 minutes',
         'Walk-in left early', $2, $2, $2, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '170 minutes'
       ) RETURNING id`,
      [propId, receptionistId]
    );
    await pool.query(
      `INSERT INTO food_order_items (
         order_id, menu_item_id, item_name_snapshot, category_name_snapshot,
         quantity, unit_price, line_subtotal, special_instructions, sort_order
       ) VALUES ($1, $2, $3, $4, 1, 650.00, 650.00, '', 10)`,
      [cancelledIns.rows[0].id, thali.id, thali.name, thali.category_name]
    );

    // 3. Seed 85 newer completed (served) orders placed between 90m and 1m ago
    for (let i = 1; i <= 85; i++) {
      const ref = `KHB-FD-SERVED-${String(i).padStart(3, '0')}`;
      const minsAgo = 90 - i;
      const ordIns = await pool.query(
        `INSERT INTO food_orders (
           property_id, order_reference, order_type, status, table_label, customer_name,
           subtotal, tax_name, tax_rate, tax_amount, total_amount, currency,
           billing_status, placed_at, preparing_at, ready_at, served_at, served_by,
           created_by, updated_by, created_at, updated_at
         ) VALUES (
           $1, $2, 'restaurant', 'served', 'Table 2', 'Completed Guest',
           650.00, 'GST', 12.00, 78.00, 728.00, 'INR',
           'not_applicable',
           NOW() - ($3::text || ' minutes')::interval,
           NOW() - ($3::text || ' minutes')::interval,
           NOW() - ($3::text || ' minutes')::interval,
           NOW() - ($3::text || ' minutes')::interval,
           $4, $4, $4,
           NOW() - ($3::text || ' minutes')::interval,
           NOW() - ($3::text || ' minutes')::interval
         ) RETURNING id`,
        [propId, ref, String(minsAgo), receptionistId]
      );
      await pool.query(
        `INSERT INTO food_order_items (
           order_id, menu_item_id, item_name_snapshot, category_name_snapshot,
           quantity, unit_price, line_subtotal, special_instructions, sort_order
         ) VALUES ($1, $2, $3, $4, 1, 650.00, 650.00, '', 10)`,
        [ordIns.rows[0].id, thali.id, thali.name, thali.category_name]
      );
    }

    const context = await browser!.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const observedOrderQueryUrls: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/api/restaurant/orders')) {
        observedOrderQueryUrls.push(url);
      }
    });

    try {
      await signInViaUi(page, 'frontdesk@staycraft.local', 'FrontDesk@123');
      observedOrderQueryUrls.length = 0;

      await page.goto(`${baseUrl}/restaurant?tab=kitchen`, { waitUntil: 'networkidle' });
      await page.locator('[data-testid="kitchen-order-board"]').waitFor();

      // Must issue active kitchen filter request with kitchenActiveOnly=true when cancelled not requested
      expect(
        observedOrderQueryUrls.some((u) => u.includes('kitchenActiveOnly=true'))
      ).toBe(true);

      // Older active order MUST be visible in Pending column despite 85 newer served orders!
      const oldActiveCard = page.locator(
        '[data-testid="kitchen-col-pending"] [data-testid="kitchen-card-KHB-FD-OLD-ACTIVE"]'
      );
      await oldActiveCard.waitFor({ timeout: 5000 });
      expect(await oldActiveCard.innerText()).toContain('Table 18');

      // Kitchen tab badge count (1) matches visible active cards (pending + preparing + ready = 1)
      const kitchenTabBtn = page.getByRole('button', { name: /Kitchen Order Board/ });
      expect(await kitchenTabBtn.innerText()).toContain('1');

      // Recent served column still shows recent completed tickets
      expect(
        await page.locator('[data-testid="kitchen-col-served"] [data-testid^="kitchen-card-"]').count()
      ).toBeGreaterThan(0);

      // Refresh persistence: reload and confirm older active ticket remains visible
      await page.reload({ waitUntil: 'networkidle' });
      await oldActiveCard.waitFor({ timeout: 5000 });

      // Toggling Show Cancelled Tickets surfaces cancelled order while keeping active ticket visible
      await page.getByLabel('Show Cancelled Tickets').check();
      await page
        .locator('[data-testid="kitchen-col-cancelled"] [data-testid="kitchen-card-KHB-FD-CANCEL-81"]')
        .waitFor({ timeout: 5000 });
      expect(await oldActiveCard.isVisible()).toBe(true);

      await page.getByLabel('Show Cancelled Tickets').uncheck();
      await page.locator('[data-testid="kitchen-col-cancelled"]').waitFor({ state: 'detached' });

      // Advance KHB-FD-OLD-ACTIVE through Preparing -> Ready -> Served cleanly
      await oldActiveCard.getByRole('button', { name: 'Start Preparing' }).click();
      const inPreparing = page.locator(
        '[data-testid="kitchen-col-preparing"] [data-testid="kitchen-card-KHB-FD-OLD-ACTIVE"]'
      );
      await inPreparing.waitFor();

      await inPreparing.getByRole('button', { name: 'Mark Ready' }).click();
      const inReady = page.locator(
        '[data-testid="kitchen-col-ready"] [data-testid="kitchen-card-KHB-FD-OLD-ACTIVE"]'
      );
      await inReady.waitFor();

      await inReady.getByRole('button', { name: 'Mark Served' }).click();
      const inServed = page.locator(
        '[data-testid="kitchen-col-served"] [data-testid="kitchen-card-KHB-FD-OLD-ACTIVE"]'
      );
      await inServed.waitFor();
    } finally {
      await context.close();
    }
  });

  it('verifies Phase 5 Suppliers, Inventory catalog, low-stock alerts, purchase receipts, controlled adjustments, and movement reports in browser', async () => {
    const context: BrowserContext = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');

      // Sidebar links across all Phases 1–7 modules are active (zero Ph.2 placeholder badges remain)
      const invNav = page.locator('aside a[href="/inventory"]').first();
      const supNav = page.locator('aside a[href="/suppliers"]').first();
      const expNav = page.locator('aside a[href="/expenses"]').first();
      const repNav = page.locator('aside a[href="/reports"]').first();
      const svcNav = page.locator('aside a[href="/services"]').first();
      const staffNav = page.locator('aside a[href="/staff"]').first();
      expect(await invNav.innerText()).not.toContain('Ph.2');
      expect(await supNav.innerText()).not.toContain('Ph.2');
      expect(await expNav.innerText()).not.toContain('Ph.2');
      expect(await repNav.innerText()).not.toContain('Ph.2');
      expect(await svcNav.innerText()).not.toContain('Ph.2');
      expect(await staffNav.innerText()).not.toContain('Ph.2');

      // 1. Navigate to Suppliers and add a vendor
      await supNav.click();
      await page.locator('h1', { hasText: 'Suppliers & Vendors' }).waitFor();

      await page.getByRole('button', { name: 'New Supplier' }).click();
      await page.locator('#sup-name').fill('Kashi Agro Foods');
      await page.locator('#sup-code').fill('VND-KAF');
      await page.locator('#sup-contact').fill('Ramesh Patel');
      await page.locator('#sup-phone').fill('+91 98391 22334');
      await page.locator('#sup-email').fill('orders@kashiagro.example');
      await page.getByRole('button', { name: 'Create Supplier' }).click();

      const supRow = page.locator('[data-testid="supplier-row-Kashi Agro Foods"]');
      await supRow.waitFor({ timeout: 5000 });
      expect(await supRow.innerText()).toContain('Ramesh Patel');

      // 2. Navigate to Inventory, create Category and low-stock Item
      await invNav.click();
      await page.locator('h1', { hasText: 'Inventory & Stock Control' }).waitFor();

      await page.locator('[data-testid="inventory-tab-categories"]').click();
      await page.getByRole('button', { name: 'New Category' }).click();
      await page.locator('#inv-cat-code').fill('PANTRY');
      await page.locator('#inv-cat-name').fill('Kitchen Dairy & Pantry');
      await page.getByRole('button', { name: 'Create Category' }).click();
      await page.locator('[data-testid="inv-category-card-PANTRY"]').waitFor({ timeout: 5000 });

      await page.locator('[data-testid="inventory-tab-items"]').click();
      await page.getByRole('button', { name: 'New Item' }).click();
      await page.locator('#inv-sku').fill('E2E-ING-PNR');
      await page.locator('#inv-name').fill('E2E Fresh Paneer');
      await page.locator('#inv-unit').selectOption('kg');
      await page.locator('#inv-opening-stock').fill('1.5');
      await page.locator('#inv-reorder').fill('3');
      await page.locator('#inv-cost').fill('360');
      await page.locator('#inv-supplier').selectOption({ label: 'Kashi Agro Foods' });
      await page.getByRole('button', { name: 'Create Item' }).click();

      const itemRow = page.locator('[data-testid="inventory-item-row-E2E-ING-PNR"]');
      await itemRow.waitFor({ timeout: 5000 });
      expect(await page.locator('[data-testid="stock-qty-E2E-ING-PNR"]').innerText()).toContain(
        '1.5 kg'
      );

      // Low-stock banner immediately highlights 1.5 <= 3.0 threshold
      const lowBanner = page.locator('[data-testid="inventory-low-stock-banner"]');
      await lowBanner.waitFor({ timeout: 5000 });
      expect(await lowBanner.innerText()).toContain('E2E Fresh Paneer');

      // 3. Replenish via Purchase / Stock Receipt (+4.5 kg -> 6 kg)
      await page.getByRole('button', { name: 'Receive Stock' }).click();
      await page.locator('#rcv-inv').fill('KAF-2026-99');
      await page.getByLabel('Receipt quantity 1').fill('4.5');
      await page.getByLabel('Receipt unit cost 1').fill('370');
      await page.getByRole('button', { name: 'Post Stock Receipt' }).click();

      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="stock-qty-E2E-ING-PNR"]');
        return el && el.textContent?.includes('6 kg');
      });
      await lowBanner.waitFor({ state: 'detached', timeout: 5000 });

      // 4. Record Controlled Stock Adjustment (Wastage -0.5 kg -> 5.5 kg)
      await page.getByRole('button', { name: 'Adjust Stock' }).click();
      await page.locator('#adj-op').selectOption('wastage');
      await page.locator('#adj-qty').fill('0.5');
      await page.locator('#adj-reason').fill('Evening chill-box quality check');
      await page.getByRole('button', { name: 'Record Adjustment' }).click();

      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="stock-qty-E2E-ING-PNR"]');
        return el && el.textContent?.includes('5.5 kg');
      });

      // 5. Verify Purchase Receipts tab & Movement Reports tab
      await page.locator('[data-testid="inventory-tab-receipts"]').click();
      await page.locator('[data-testid="inventory-receipts-view"]').waitFor();
      expect(await page.locator('[data-testid="inventory-receipts-view"]').innerText()).toContain(
        'KAF-2026-99'
      );

      await page.locator('[data-testid="inventory-tab-movements"]').click();
      await page.locator('[data-testid="inventory-movements-view"]').waitFor();
      await page.locator('[data-testid="movement-ledger-row"]').first().waitFor({ timeout: 5000 });
      expect(
        await page.locator('[data-testid="movement-ledger-row"]').count()
      ).toBeGreaterThanOrEqual(3);
      expect(
        await page.locator('[data-testid="inventory-movements-view"]').innerText()
      ).toContain('Evening chill-box quality check');
    } finally {
      await context.close();
    }
  });

  it('verifies Phase 5 Menu Recipe mapping, kitchen prep stock deduction, insufficient stock blocking, and Receptionist RBAC in browser', async () => {
    const adminCtx: BrowserContext = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await adminCtx.newPage();
    try {
      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');

      // 1. Navigate to Restaurant -> Menu & Categories, create dish & map recipe (2.0 kg E2E-ING-PNR per dish)
      await page.goto(`${baseUrl}/restaurant?tab=menu`, { waitUntil: 'networkidle' });
      await page.locator('[data-testid="menu-management-view"]').waitFor();

      // Ensure at least one food category exists
      if ((await page.getByRole('button', { name: 'New Menu Item' }).isDisabled())) {
        await page.getByRole('button', { name: 'New Category' }).click();
        await page.locator('#food-cat-code').fill('E2E-MAIN');
        await page.locator('#food-cat-name').fill('E2E Tandoor Mains');
        await page.getByRole('button', { name: 'Create Category' }).click();
        await page.waitForTimeout(300);
      }

      await page.getByRole('button', { name: 'New Menu Item' }).click();
      await page.locator('#menu-sku').fill('E2E-FD-PNR');
      await page.locator('#menu-name').fill('E2E Royal Paneer Tikka');
      await page.locator('#menu-price').fill('480');
      await page.getByRole('button', { name: 'Create Menu Item' }).click();

      const menuRow = page.locator('[data-testid="managed-menu-row-E2E-FD-PNR"]');
      await menuRow.waitFor({ timeout: 5000 });

      await menuRow.getByRole('button', { name: 'Recipe' }).click();
      await page.getByRole('button', { name: 'Add Ingredient' }).click();
      await page.getByLabel('Recipe ingredient 1', { exact: true }).selectOption({
        label: 'E2E Fresh Paneer (E2E-ING-PNR) — 5.5 kg on hand',
      });
      await page.getByLabel('Recipe quantity 1', { exact: true }).fill('2');
      await page.getByRole('button', { name: 'Save Recipe' }).click();

      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="managed-menu-row-E2E-FD-PNR"]');
        return el && el.textContent?.includes('1 ingr.');
      });

      // 2. Place POS order #1 for 2x E2E Royal Paneer Tikka (needs 4.0 kg out of 5.5 kg)
      await page.getByRole('button', { name: /New Order \/ POS/ }).click();
      const posCard = page.locator('[data-testid="pos-menu-card-E2E-FD-PNR"]');
      await posCard.waitFor({ timeout: 5000 });
      await posCard.getByRole('button', { name: /Add/ }).click();
      await posCard.getByRole('button', { name: /Add/ }).click();
      await page.locator('#pos-table-label').fill('Table 22');
      await page.getByRole('button', { name: 'Place Kitchen Order' }).click();

      // Placing an order opens FoodOrderDetailModal automatically — close it, then advance on Kitchen Order Board
      const detailDialog = page.locator('[role="dialog"]');
      await detailDialog.waitFor({ timeout: 5000 });
      await detailDialog.getByRole('button', { name: 'Close', exact: true }).click();
      await detailDialog.waitFor({ state: 'detached', timeout: 5000 });

      // Switch to Kitchen Order Board & Start Preparing Table 22 -> deducts 4.0 kg (5.5 -> 1.5 kg)
      await page.getByRole('button', { name: /Kitchen Order Board/ }).click();
      const pendingCol = page.locator('[data-testid="kitchen-col-pending"]');
      const table22Card = pendingCol
        .locator('[data-testid^="kitchen-card-"]', { hasText: 'Table 22' })
        .first();
      await table22Card.waitFor({ timeout: 5000 });
      await table22Card.getByRole('button', { name: 'Start Preparing' }).click();

      const prepCol = page.locator('[data-testid="kitchen-col-preparing"]');
      const table22PrepCard = prepCol
        .locator('[data-testid^="kitchen-card-"]', { hasText: 'Table 22' })
        .first();
      await table22PrepCard.waitFor({ timeout: 5000 });

      // Open order Details modal -> verify ingredient deduction ledger entry is shown
      await table22PrepCard.getByRole('button', { name: 'Details' }).click();
      const deductionLine = page.locator('[data-testid="order-stock-deduction-E2E-ING-PNR"]');
      await deductionLine.waitFor({ timeout: 5000 });
      expect(await deductionLine.innerText()).toContain('-4 kg (5.5 → 1.5)');
      await detailDialog.getByRole('button', { name: 'Close', exact: true }).click();
      await detailDialog.waitFor({ state: 'detached', timeout: 5000 });

      // 3. Place POS order #2 for 2x E2E Royal Paneer Tikka (needs 4.0 kg, only 1.5 kg left!)
      await page.getByRole('button', { name: /New Order \/ POS/ }).click();
      // Notice POS card now flags Low Recipe Stock (1.5 kg < 2.0 kg required per 1 dish)
      await page.locator('[data-testid="pos-low-ingredient-E2E-FD-PNR"]').waitFor({ timeout: 5000 });
      await posCard.getByRole('button', { name: /Add/ }).click();
      await posCard.getByRole('button', { name: /Add/ }).click();
      await page.locator('#pos-table-label').fill('Table 23');
      await page.getByRole('button', { name: 'Place Kitchen Order' }).click();

      await detailDialog.waitFor({ timeout: 5000 });
      await detailDialog.getByRole('button', { name: 'Close', exact: true }).click();
      await detailDialog.waitFor({ state: 'detached', timeout: 5000 });

      await page.getByRole('button', { name: /Kitchen Order Board/ }).click();
      const table23Card = pendingCol
        .locator('[data-testid^="kitchen-card-"]', { hasText: 'Table 23' })
        .first();
      await table23Card.waitFor({ timeout: 5000 });
      await table23Card.getByRole('button', { name: 'Start Preparing' }).click();

      // Transition must be blocked; Table 23 stays in Pending and stock stays 1.5 kg!
      await page.waitForTimeout(500);
      expect(await table23Card.isVisible()).toBe(true);

      await page.goto(`${baseUrl}/inventory`, { waitUntil: 'networkidle' });
      expect(await page.locator('[data-testid="stock-qty-E2E-ING-PNR"]').innerText()).toContain(
        '1.5 kg'
      );
      await page.locator('[data-testid="inventory-low-stock-banner"]').waitFor({ timeout: 5000 });
    } finally {
      await adminCtx.close();
    }

    // 4. Verify Receptionist RBAC in browser (can view & receive stock, cannot adjust or edit catalog/suppliers)
    const recCtx: BrowserContext = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const recPage = await recCtx.newPage();
    try {
      await signInViaUi(recPage, 'frontdesk@staycraft.local', 'FrontDesk@123');
      await recPage.goto(`${baseUrl}/inventory`, { waitUntil: 'networkidle' });
      await recPage.locator('h1', { hasText: 'Inventory & Stock Control' }).waitFor();

      expect(
        await recPage.getByRole('button', { name: 'Receive Stock' }).isVisible()
      ).toBe(true);
      expect(await recPage.getByRole('button', { name: 'New Item' }).count()).toBe(0);
      expect(await recPage.getByRole('button', { name: 'Adjust Stock' }).count()).toBe(0);

      await recPage.goto(`${baseUrl}/suppliers`, { waitUntil: 'networkidle' });
      await recPage.locator('h1', { hasText: 'Suppliers & Vendors' }).waitFor();
      expect(await recPage.getByRole('button', { name: 'New Supplier' }).count()).toBe(0);
      expect(
        await recPage.locator('[data-testid="supplier-row-Kashi Agro Foods"]').isVisible()
      ).toBe(true);
    } finally {
      await recCtx.close();
    }
  });

  it('verifies Phase 6 Expenses entry, category management, filtering, auditable voiding, and receptionist RBAC in browser', async () => {
    const adminCtx: BrowserContext = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await adminCtx.newPage();

    try {
      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');

      const expNav = page.locator('aside a[href="/expenses"]').first();
      await expNav.click();
      await page.locator('h1', { hasText: 'Operating Expenses' }).waitFor();

      // Seed standard hotel categories via one-click starter button
      const seedBtn = page.getByRole('button', { name: 'Add Standard Hotel Categories' });
      await seedBtn.waitFor({ timeout: 5000 });
      await seedBtn.click();

      await page.waitForFunction(
        () =>
          Number(
            document
              .querySelector('[data-testid="expenses-active-categories"]')
              ?.textContent?.trim() ?? '0'
          ) >= 5,
        undefined,
        { timeout: 10000 }
      );

      // 1. Record an active Utilities operating expense on 2026-10-15
      await page.getByRole('button', { name: 'Record Expense' }).click();
      const expDialog = page.getByRole('dialog');
      await expDialog.waitFor({ timeout: 5000 });

      await page.locator('#expense-date-input').fill('2026-10-15');
      await page
        .locator('#expense-title-input')
        .fill('E2E October Commercial Power Bill');
      await page.locator('#expense-amount-input').fill('12500');
      await page.locator('#expense-tax-input').fill('0');
      await page.locator('#expense-payment-method-select').selectOption('bank_transfer');
      await page.locator('#expense-vendor-input').fill('Purvanchal Power Grid');
      await page.locator('#expense-reference-input').fill('NEFT-E2E-1001');
      await page
        .locator('#expense-description-input')
        .fill('Main HT transformer billing cycle.');
      await expDialog.getByRole('button', { name: 'Record Expense' }).click();
      await expDialog.waitFor({ state: 'detached', timeout: 5000 });

      await page
        .locator('tr', { hasText: 'E2E October Commercial Power Bill' })
        .waitFor({ timeout: 5000 });

      // 2. Record a second erroneous expense on 2026-10-16 and void it with an auditable reason
      await page.getByRole('button', { name: 'Record Expense' }).click();
      await expDialog.waitFor({ timeout: 5000 });
      await page.locator('#expense-date-input').fill('2026-10-16');
      await page
        .locator('#expense-title-input')
        .fill('E2E Duplicate Generator Diesel Bill');
      await page.locator('#expense-amount-input').fill('3400');
      await page.locator('#expense-payment-method-select').selectOption('cash');
      await page.locator('#expense-vendor-input').fill('Ghat Fuel Station');
      await expDialog.getByRole('button', { name: 'Record Expense' }).click();
      await expDialog.waitFor({ state: 'detached', timeout: 5000 });

      const dupRow = page.locator('tr', {
        hasText: 'E2E Duplicate Generator Diesel Bill',
      });
      await dupRow.waitFor({ timeout: 5000 });

      // Void the duplicate expense
      await dupRow.locator('button[title="Void expense"]').click();
      const voidDialog = page.getByRole('dialog');
      await voidDialog.waitFor({ timeout: 5000 });
      await page
        .locator('#void-expense-reason')
        .fill('Duplicate entry detected during daily cashbook audit.');
      await voidDialog.getByRole('button', { name: 'Confirm Void Expense' }).click();
      await voidDialog.waitFor({ state: 'detached', timeout: 5000 });

      // Verify active recorded spend excludes the ₹3,400 voided voucher (stays ₹12,500.00)
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="expenses-voided-total"]')
            ?.textContent?.includes('3,400'),
        undefined,
        { timeout: 5000 }
      );
      expect(
        await page.locator('[data-testid="expenses-recorded-total"]').innerText()
      ).toContain('12,500');
      expect(
        await page.locator('[data-testid="expenses-voided-total"]').innerText()
      ).toContain('3,400');

      // Voided row remains visible in "All History" with reason & audit trail modal
      expect(await dupRow.innerText()).toContain('Voided');
      expect(await dupRow.innerText()).toContain('Duplicate entry detected');

      await dupRow.locator('button[title="View voucher & audit history"]').click();
      const detailModal = page.getByRole('dialog');
      await detailModal.waitFor({ timeout: 5000 });
      await detailModal.getByText(/Audit History \(2\)/i).waitFor({ timeout: 5000 });
      expect((await detailModal.innerText()).toUpperCase()).toContain(
        'AUDIT HISTORY (2)'
      );
      expect(await detailModal.innerText()).toContain('Voided');
      await detailModal.getByRole('button', { name: 'Close dialog' }).click();
      await detailModal.waitFor({ state: 'detached', timeout: 5000 });

      // Filter to "Recorded (Active)" -> voided row hides while active row stays visible
      await page.getByRole('button', { name: 'Recorded (Active)' }).click();
      await page.waitForTimeout(300);
      expect(await dupRow.count()).toBe(0);
      expect(
        await page
          .locator('tr', { hasText: 'E2E October Commercial Power Bill' })
          .isVisible()
      ).toBe(true);
    } finally {
      await adminCtx.close();
    }

    // Receptionist can record expenses and view history, but cannot void/edit or add categories
    const recCtx: BrowserContext = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const recPage = await recCtx.newPage();
    try {
      await signInViaUi(recPage, 'frontdesk@staycraft.local', 'FrontDesk@123');
      await recPage.goto(`${baseUrl}/expenses`, { waitUntil: 'networkidle' });
      await recPage.locator('h1', { hasText: 'Operating Expenses' }).waitFor();

      expect(
        await recPage.getByRole('button', { name: 'Record Expense' }).isVisible()
      ).toBe(true);
      expect(await recPage.getByRole('button', { name: 'New Category' }).count()).toBe(0);
      expect(await recPage.locator('button[title="Void expense"]').count()).toBe(0);
    } finally {
      await recCtx.close();
    }
  });

  it('verifies Phase 6 Financial & Operational Reports KPI cards, date-range filtering, and non-audited profit disclosures in browser', async () => {
    const context: BrowserContext = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    try {
      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');

      const repNav = page.locator('aside a[href="/reports"]').first();
      await repNav.click();
      await page
        .locator('h1', { hasText: 'Financial & Operational Reports' })
        .waitFor({ timeout: 5000 });

      // Apply full October 2026 range to capture the recorded & voided expenses
      await page.getByLabel('Report start date').fill('2026-10-01');
      await page.getByLabel('Report end date').fill('2026-10-31');
      await page.getByRole('button', { name: 'Apply Range' }).click();

      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="report-recorded-expenses"]')
            ?.textContent?.includes('12,500'),
        undefined,
        { timeout: 8000 }
      );

      // Verify recorded operating expenses show ₹12,500 (excluding the ₹3,400 voided voucher)
      expect(
        await page.locator('[data-testid="report-recorded-expenses"]').innerText()
      ).toContain('12,500');

      // Verify honest non-audited profit labeling & exclusions panel
      const pageText = await page.locator('main').innerText();
      expect(pageText).toContain('Not Audited Profit');
      expect(
        await page.locator('[data-testid="report-exclusions-panel"]').innerText()
      ).toContain('must not be treated as audited GAAP/IFRS net profit');
      expect(
        await page.locator('[data-testid="report-voided-invoices-box"]').isVisible()
      ).toBe(true);

      // Filter to an earlier empty period (2026-01-01 .. 2026-01-31) -> period expenses drop to ₹0.00
      await page.getByLabel('Report start date').fill('2026-01-01');
      await page.getByLabel('Report end date').fill('2026-01-31');
      await page.getByRole('button', { name: 'Apply Range' }).click();

      await page.waitForFunction(
        () => {
          const txt =
            document
              .querySelector('[data-testid="report-recorded-expenses"]')
              ?.textContent ?? '';
          return txt.includes('0.00') && !txt.includes('12,500');
        },
        undefined,
        { timeout: 8000 }
      );

      expect(
        await page.locator('[data-testid="report-recorded-expenses"]').innerText()
      ).toContain('0.00');
    } finally {
      await context.close();
    }
  });

  it('verifies Phase 7 Hotel Services catalog, request workflow, folio posting, Staff Directory, User Access, and Receptionist RBAC in browser', async () => {
    const adminCtx: BrowserContext = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await adminCtx.newPage();

    try {
      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');

      // 1. Navigate to Staff & Users (/staff) and create a Property Staff Profile
      await page.locator('aside a[href="/staff"]').first().click();
      await page
        .locator('h1', { hasText: 'Staff Directory & User Access' })
        .waitFor({ timeout: 5000 });

      await page.getByRole('button', { name: 'New Staff Profile' }).click();
      const staffDialog = page.getByRole('dialog');
      await staffDialog.waitFor({ timeout: 5000 });

      await page.locator('#sp-code').fill('EMP-E2E-01');
      await page.locator('#sp-name').fill('Meera Deshmukh');
      await page.locator('#sp-dept').selectOption('concierge_spa');
      await page.locator('#sp-title').fill('Lead Spa & Concierge Coordinator');
      await page.locator('#sp-phone').fill('+91 98765 77101');
      await staffDialog
        .getByRole('button', { name: 'Create Staff Profile' })
        .click();
      await staffDialog.waitFor({ state: 'detached', timeout: 5000 });

      const staffRow = page.locator('[data-testid="staff-row-EMP-E2E-01"]');
      await staffRow.waitFor({ timeout: 5000 });
      expect(await staffRow.innerText()).toContain('Meera Deshmukh');

      // 2. Switch to System Users & Property Access tab and create a new Receptionist account
      await page
        .getByRole('button', { name: /System Users & Property Access/i })
        .click();
      await page.getByRole('button', { name: 'New System User' }).click();
      const userDialog = page.getByRole('dialog');
      await userDialog.waitFor({ timeout: 5000 });

      await page.locator('#cu-name').fill('E2E Front Desk Associate');
      await page.locator('#cu-email').fill('e2e.associate@staycraft.local');
      await page.locator('#cu-phone').fill('+91 98765 77202');
      await page.locator('#cu-password').fill('Associate#2026');
      await userDialog.getByRole('button', { name: 'Create User' }).click();
      await userDialog.waitFor({ state: 'detached', timeout: 5000 });

      const managedUserRow = page.locator(
        '[data-testid="managed-user-row-e2e.associate@staycraft.local"]'
      );
      await managedUserRow.waitFor({ timeout: 5000 });
      expect(await managedUserRow.innerText()).toContain(
        'E2E Front Desk Associate'
      );

      // 3. Navigate to Services (/services), create a Service Catalog item, then fulfill & post a Guest Service Request
      await page.locator('aside a[href="/services"]').first().click();
      await page
        .locator('h1', { hasText: 'Hotel Services & Guest Requests' })
        .waitFor({ timeout: 5000 });

      await page.getByRole('button', { name: 'New Service Item' }).click();
      const catDialog = page.getByRole('dialog');
      await catDialog.waitFor({ timeout: 5000 });

      await page.locator('#svc-cat-code').fill('SVC-E2E-SPA');
      await page.locator('#svc-cat-name').fill('E2E Riverfront Spa Therapy');
      await page.locator('#svc-cat-category').selectOption('spa_wellness');
      await page.locator('#svc-cat-price').fill('2500');
      await catDialog.getByRole('button', { name: 'Create Service' }).click();
      await catDialog.waitFor({ state: 'detached', timeout: 5000 });

      // Create a reservation-linked guest service request assigned to Meera Deshmukh
      await page
        .getByRole('button', { name: 'New Service Request' })
        .first()
        .click();
      const reqDialog = page.getByRole('dialog');
      await reqDialog.waitFor({ timeout: 5000 });

      await page
        .locator('#sr-service')
        .selectOption({ label: 'E2E Riverfront Spa Therapy (SVC-E2E-SPA) — ₹2,500.00 / Per Request' });
      await page.locator('#sr-qty').fill('1');
      await page
        .locator('#sr-staff')
        .selectOption({ label: 'Meera Deshmukh (Lead Spa & Concierge Coordinator)' });
      await page
        .locator('#sr-notes')
        .fill('Evening herbal oil spa session confirmed with guest.');
      await reqDialog
        .getByRole('button', { name: 'Create Service Request' })
        .click();
      await reqDialog.waitFor({ state: 'detached', timeout: 5000 });

      const reqRow = page.locator('tr', {
        hasText: 'E2E Riverfront Spa Therapy',
      });
      await reqRow.waitFor({ timeout: 5000 });
      expect(await reqRow.innerText()).toContain('Meera Deshmukh');
      expect(await reqRow.innerText()).toContain('Requested');

      // Start Service (requested -> in_progress)
      await reqRow.getByRole('button', { name: 'Start' }).click();
      const startDialog = page.getByRole('dialog');
      await startDialog.waitFor({ timeout: 5000 });
      await startDialog.getByRole('button', { name: 'Mark In Progress' }).click();
      await startDialog.waitFor({ state: 'detached', timeout: 5000 });
      await reqRow
        .locator('[data-testid="service-request-status-in_progress"]')
        .waitFor({ timeout: 5000 });

      // Complete Service (in_progress -> completed)
      await reqRow.getByRole('button', { name: 'Complete' }).click();
      const completeDialog = page.getByRole('dialog');
      await completeDialog.waitFor({ timeout: 5000 });
      await completeDialog.getByRole('button', { name: 'Mark Completed' }).click();
      await completeDialog.waitFor({ state: 'detached', timeout: 5000 });
      await reqRow
        .locator('[data-testid="service-request-status-completed"]')
        .waitFor({ timeout: 5000 });

      // Post Charge to Folio
      await reqRow.getByRole('button', { name: 'Post to Folio' }).click();
      const postDialog = page.getByRole('dialog');
      await postDialog.waitFor({ timeout: 5000 });
      await postDialog
        .getByRole('button', { name: 'Confirm & Post to Invoice' })
        .click();
      await postDialog.waitFor({ state: 'detached', timeout: 5000 });

      await reqRow
        .locator('[data-testid="service-billing-status-posted"]')
        .waitFor({ timeout: 5000 });
      expect(await reqRow.innerText()).toContain('Posted to Invoice');
    } finally {
      await adminCtx.close();
    }

    // 4. Verify Receptionist RBAC on /services and /staff in browser
    const recCtx: BrowserContext = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const recPage = await recCtx.newPage();
    try {
      await signInViaUi(recPage, 'frontdesk@staycraft.local', 'FrontDesk@123');

      await recPage.goto(`${baseUrl}/services`, { waitUntil: 'networkidle' });
      await recPage
        .locator('h1', { hasText: 'Hotel Services & Guest Requests' })
        .waitFor({ timeout: 5000 });
      expect(
        await recPage
          .getByRole('button', { name: 'New Service Request' })
          .first()
          .isVisible()
      ).toBe(true);
      expect(
        await recPage.getByRole('button', { name: 'New Service Item' }).count()
      ).toBe(0);

      await recPage.goto(`${baseUrl}/staff`, { waitUntil: 'networkidle' });
      await recPage
        .locator('h1', { hasText: 'Staff Directory & User Access' })
        .waitFor({ timeout: 5000 });
      expect(
        await recPage.getByRole('button', { name: 'New Staff Profile' }).count()
      ).toBe(0);

      await recPage
        .getByRole('button', { name: /System Users & Property Access/i })
        .click();
      await recPage
        .locator('h3', { hasText: 'Administrator Privileges Required' })
        .waitFor({ timeout: 5000 });
      expect(await recPage.locator('main').innerText()).toContain(
        'Administrator Privileges Required'
      );
    } finally {
      await recCtx.close();
    }
  });

  it('verifies zero-staff vs unlinked-login distinction, guided Create & Link flow, KHB vs EHS property isolation, status filter counts, and multi-property RBAC in browser', async () => {
    const pool = getPool();
    const dbCheck = await pool.query('SELECT current_database() AS db_name');
    expect(String(dbCheck.rows[0]?.db_name ?? '')).toBe('staycraft_pms_test');

    // Insert second property EHS (with 0 staff profiles) in staycraft_pms_test; Admin gets EHS access, Priya Nair does NOT
    const ehsIns = await pool.query<{ id: string }>(
      `INSERT INTO properties (code, name, email, phone, address_line1, city, country, timezone, currency, default_tax_rate, tax_name)
       VALUES ('EHS', 'Emerald Hills Suites', 'desk@ehs.test', '+91 484 260 1100', 'Hilltop Rd', 'Munnar', 'India', 'Asia/Kolkata', 'INR', 12.00, 'GST')
       RETURNING id`
    );
    const ehsId = String(ehsIns.rows[0].id);

    await pool.query(
      `INSERT INTO user_property_access (user_id, property_id, is_default)
       SELECT id, $1, FALSE FROM users WHERE email = 'admin@staycraft.local'
       ON CONFLICT (user_id, property_id) DO NOTHING`,
      [ehsId]
    );

    const adminCtx: BrowserContext = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await adminCtx.newPage();

    try {
      await signInViaUi(page, 'admin@staycraft.local', 'Admin@12345');
      await page.goto(`${baseUrl}/staff`, { waitUntil: 'networkidle' });
      await page
        .locator('h1', { hasText: 'Staff Directory & User Access' })
        .waitFor({ timeout: 5000 });

      // 1. Before linking Priya Nair: KHB has 1 unlinked staff profile (Meera Deshmukh from prior test),
      //    so Linked Login Accounts MUST be 0 even though Priya Nair & Aarav Mehta hold KHB access!
      expect(
        (await page.locator('[data-testid="staff-kpi-total"]').innerText()).trim()
      ).toBe('1');
      expect(
        (
          await page
            .locator('[data-testid="staff-kpi-linked-users"]')
            .innerText()
        ).trim()
      ).toBe('0');

      const banner = page.locator(
        '[data-testid="unlinked-property-logins-banner"]'
      );
      await banner.waitFor({ timeout: 5000 });
      expect(await banner.innerText()).toContain('frontdesk@staycraft.local');

      // 2. Switch property selector to EHS -> verify strict property isolation & genuine zero-staff empty state
      await page.locator('#property-selector').selectOption(ehsId);
      await page
        .locator('h3', {
          hasText: 'No staff profiles registered for EHS yet',
        })
        .waitFor({ timeout: 5000 });
      expect(
        (await page.locator('[data-testid="staff-kpi-total"]').innerText()).trim()
      ).toBe('0');
      expect(
        (
          await page.locator('[data-testid="staff-kpi-active"]').innerText()
        ).trim()
      ).toBe('0');
      expect(
        (
          await page
            .locator('[data-testid="staff-kpi-linked-users"]')
            .innerText()
        ).trim()
      ).toBe('0');
      expect(
        await page.locator('[data-testid="staff-row-EMP-E2E-01"]').count()
      ).toBe(0);

      // 3. Switch back to KHB and use the guided "Create & Link KHB Profile" flow for Priya Nair
      await page.locator('#property-selector').selectOption(propId);
      await page
        .locator('[data-testid="staff-row-EMP-E2E-01"]')
        .waitFor({ timeout: 5000 });

      await page
        .locator(
          '[data-testid="create-staff-from-user-frontdesk@staycraft.local"]'
        )
        .click();
      const linkDialog = page.getByRole('dialog');
      await linkDialog.waitFor({ timeout: 5000 });

      // Name & email & user link are pre-populated; Admin confirms employee code & role
      expect(await page.locator('#sp-name').inputValue()).toBe('Priya Nair');
      expect(await page.locator('#sp-linked-user').inputValue()).toBe(
        receptionistId
      );
      await page.locator('#sp-code').fill('KHB-FD-PRIYA');
      await page.locator('#sp-dept').selectOption('front_office');
      await page.locator('#sp-title').fill('Senior Front Desk Executive');
      await linkDialog
        .getByRole('button', { name: 'Create Staff Profile' })
        .click();
      await linkDialog.waitFor({ state: 'detached', timeout: 5000 });

      // KPIs update accurately: Total Roster = 2, Active = 2, Linked Login Accounts = 1
      await page
        .locator('[data-testid="staff-row-KHB-FD-PRIYA"]')
        .waitFor({ timeout: 5000 });
      expect(
        (await page.locator('[data-testid="staff-kpi-total"]').innerText()).trim()
      ).toBe('2');
      expect(
        (
          await page.locator('[data-testid="staff-kpi-active"]').innerText()
        ).trim()
      ).toBe('2');
      expect(
        (
          await page
            .locator('[data-testid="staff-kpi-linked-users"]')
            .innerText()
        ).trim()
      ).toBe('1');

      // 4. Create an On-Leave staff profile & deactivate Meera -> verify Active / On Leave / Inactive filters & counts
      await page.getByRole('button', { name: 'New Staff Profile' }).click();
      const leaveDialog = page.getByRole('dialog');
      await leaveDialog.waitFor({ timeout: 5000 });
      await page.locator('#sp-code').fill('KHB-HK-LEAVE');
      await page.locator('#sp-name').fill('Sunil Chauhan');
      await page.locator('#sp-dept').selectOption('housekeeping');
      await page.locator('#sp-title').fill('Linen Attendant');
      await page.locator('#sp-status').selectOption('on_leave');
      await leaveDialog
        .getByRole('button', { name: 'Create Staff Profile' })
        .click();
      await leaveDialog.waitFor({ state: 'detached', timeout: 5000 });
      await page
        .locator('[data-testid="staff-row-KHB-HK-LEAVE"]')
        .waitFor({ timeout: 5000 });

      // Deactivate EMP-E2E-01 (Meera Deshmukh)
      await page
        .locator('[data-testid="staff-row-EMP-E2E-01"]')
        .getByRole('button', { name: 'Deactivate' })
        .click();
      const deactDialog = page.getByRole('dialog');
      await deactDialog.waitFor({ timeout: 5000 });
      await deactDialog
        .getByRole('button', { name: 'Deactivate Staff' })
        .click();
      await deactDialog.waitFor({ state: 'detached', timeout: 5000 });

      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="staff-kpi-inactive"]')
            ?.textContent?.trim() === '1',
        undefined,
        { timeout: 5000 }
      );
      expect(
        (await page.locator('[data-testid="staff-kpi-total"]').innerText()).trim()
      ).toBe('3');
      expect(
        (
          await page.locator('[data-testid="staff-kpi-active"]').innerText()
        ).trim()
      ).toBe('1');
      expect(
        (
          await page.locator('[data-testid="staff-kpi-on-leave"]').innerText()
        ).trim()
      ).toBe('1');
      expect(
        (
          await page.locator('[data-testid="staff-kpi-inactive"]').innerText()
        ).trim()
      ).toBe('1');

      // Filter pills narrow visible rows accurately
      await page.locator('[data-testid="staff-filter-on_leave"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll('tbody tr').length === 1,
        undefined,
        { timeout: 5000 }
      );
      expect(
        await page.locator('[data-testid="staff-row-KHB-HK-LEAVE"]').isVisible()
      ).toBe(true);

      await page.locator('[data-testid="staff-filter-inactive"]').click();
      await page.waitForFunction(
        () =>
          Boolean(
            document.querySelector('[data-testid="staff-row-EMP-E2E-01"]')
          ),
        undefined,
        { timeout: 5000 }
      );
      expect(await page.locator('tbody tr').count()).toBe(1);

      await page.locator('[data-testid="staff-filter-active"]').click();
      await page
        .locator('[data-testid="staff-row-KHB-FD-PRIYA"]')
        .waitFor({ timeout: 5000 });
      expect(await page.locator('tbody tr').count()).toBe(1);

      // 5. Verify System Users & Property Access tab shows KHB-FD-PRIYA linked on Priya Nair's row
      await page
        .getByRole('button', { name: /System Users & Property Access/i })
        .click();
      const priyaUserRow = page.locator(
        '[data-testid="managed-user-row-frontdesk@staycraft.local"]'
      );
      await priyaUserRow.waitFor({ timeout: 5000 });
      expect(await priyaUserRow.innerText()).toContain('KHB-FD-PRIYA');
    } finally {
      await adminCtx.close();
    }

    // 6. Verify Receptionist (`frontdesk@staycraft.local`) cannot access EHS or grant property access
    const recCtx: BrowserContext = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const recPage = await recCtx.newPage();
    try {
      await signInViaUi(recPage, 'frontdesk@staycraft.local', 'FrontDesk@123');
      // Receptionist only has KHB access, so multi-property selector is not shown
      expect(await recPage.locator('#property-selector').count()).toBe(0);

      const crossPropStatus = await recPage.evaluate(async (targetEhsId) => {
        const res = await fetch('/api/staff', {
          headers: { 'X-Property-Id': targetEhsId },
          credentials: 'include',
        });
        return res.status;
      }, ehsId);
      expect(crossPropStatus).toBe(403);
    } finally {
      await recCtx.close();
    }
  });
});
