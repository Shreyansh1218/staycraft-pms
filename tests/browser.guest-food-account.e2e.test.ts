import { execFileSync } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, getPropertyLocalDate } from '../src/shared/dates.js';
import { calculateReservationFinancials } from '../src/shared/pricing.js';
import { createApiApp } from '../src/server/app.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { closePool, getPool } from '../src/server/db/pool.js';
import { resetLoginRateLimiter } from '../src/server/modules/auth/auth.routes.js';
import { resetPublicGuestOrderRateLimiter } from '../src/server/modules/restaurant/guest-food.routes.js';
import { hashPassword } from '../src/server/security/password.js';
import {
  clearTestMailOutbox,
  getTestMailOutbox,
} from '../src/server/services/mailer.service.js';

function resolveExecutable(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const chromiumExecutable = resolveExecutable([
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
]);

const zbarExecutable = resolveExecutable(['/usr/bin/zbarimg', '/usr/local/bin/zbarimg']);

async function assertTestDatabaseOnly(): Promise<void> {
  const pool = getPool();
  const dbCheck = await pool.query<{ db_name: string }>(
    'SELECT current_database() AS db_name'
  );
  const connectedDb = String(dbCheck.rows[0]?.db_name ?? '').trim();
  if (connectedDb !== 'staycraft_pms_test') {
    throw new Error(
      `ABORTING BROWSER E2E: Expected staycraft_pms_test, got "${connectedDb}"`
    );
  }
}

function scanQrImageWithZbar(pngPath: string): string {
  if (!zbarExecutable) {
    throw new Error('zbarimg binary is required for optical QR verification');
  }
  return execFileSync(zbarExecutable, ['--raw', '-q', pngPath], {
    encoding: 'utf8',
  }).trim();
}

describe.skipIf(!chromiumExecutable)(
  'Browser E2E: Full 10-Point Verification of Guest QR Food Ordering & Account Management',
  () => {
    let server: http.Server | null = null;
    let viteDevServer: ViteDevServer | null = null;
    let baseUrl = '';
    let browser: Browser | null = null;
    let tmpDir = '';

    let propId = '';
    let qrToken = '';
    let checkedInRoomNumber = '';
    let secondCheckedInRoomNumber = '';
    let vacantRoomNumber = '';
    let menuItemId = '';
    let unavailableMenuItemId = '';

    let adminEmail = '';
    let recEmail = '';
    const adminPassword = 'BrowserAdminPass#2026';
    const recPassword = 'BrowserRecPass#2026';

    beforeAll(async () => {
      await assertTestDatabaseOnly();
      await runMigrations();
      resetLoginRateLimiter();
      resetPublicGuestOrderRateLimiter();
      clearTestMailOutbox();

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staycraft-qr-e2e-'));

      const pool = getPool();
      const suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(
        Math.random() * 90 + 10
      )}`.toUpperCase();

      adminEmail = `e2e.fab.admin.${suffix.toLowerCase()}@staycraft.local`;
      recEmail = `e2e.fab.rec.${suffix.toLowerCase()}@staycraft.local`;
      const [adminHash, recHash] = await Promise.all([
        hashPassword(adminPassword),
        hashPassword(recPassword),
      ]);

      const uAdmin = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, role, phone)
         VALUES ($1, $2, 'E2E Hotel Admin', 'admin', '+91 91000 91000')
         RETURNING id`,
        [adminEmail, adminHash]
      );
      const adminId = String(uAdmin.rows[0].id);

      const uRec = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, role, phone)
         VALUES ($1, $2, 'E2E Front Desk', 'receptionist', '+91 91000 91001')
         RETURNING id`,
        [recEmail, recHash]
      );
      const recId = String(uRec.rows[0].id);

      const propRes = await pool.query(
        `INSERT INTO properties (
           code, name, email, phone, address_line1, city, country,
           timezone, currency, default_tax_rate, tax_name
         ) VALUES (
           $1, $2, 'e2efab@staycraft.local', '+91 542 250 9101', '5 Shivala Ghat', 'Varanasi', 'India',
           'Asia/Kolkata', 'INR', 12.00, 'GST'
         ) RETURNING id, guest_qr_token`,
        [`EF${suffix.slice(0, 6)}`, `Ganges View E2E Hotel ${suffix}`]
      );
      propId = String(propRes.rows[0].id);
      qrToken = String(propRes.rows[0].guest_qr_token);

      await pool.query(
        `INSERT INTO user_property_access (user_id, property_id, is_default)
         VALUES ($1, $3, TRUE), ($2, $3, TRUE)`,
        [adminId, recId, propId]
      );

      const rtRes = await pool.query(
        `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
         VALUES ($1, 'RIV', 'River Suite', 2, 3, 5200) RETURNING id`,
        [propId]
      );
      checkedInRoomNumber = `301-${suffix.slice(0, 3)}`;
      secondCheckedInRoomNumber = `302-${suffix.slice(0, 3)}`;
      vacantRoomNumber = `303-${suffix.slice(0, 3)}`;

      const room1Res = await pool.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
         VALUES ($1, $2, $3, '3', 'available', 'clean') RETURNING id`,
        [propId, rtRes.rows[0].id, checkedInRoomNumber]
      );
      const room2Res = await pool.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
         VALUES ($1, $2, $3, '3', 'available', 'clean') RETURNING id`,
        [propId, rtRes.rows[0].id, secondCheckedInRoomNumber]
      );
      await pool.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
         VALUES ($1, $2, $3, '3', 'available', 'clean')`,
        [propId, rtRes.rows[0].id, vacantRoomNumber]
      );

      const guest1Res = await pool.query(
        `INSERT INTO guests (property_id, first_name, last_name, email, phone)
         VALUES ($1, 'Kavya', 'Nair', 'kavya.e2e@guest.example', '+91 98333 44556')
         RETURNING id`,
        [propId]
      );
      const guest2Res = await pool.query(
        `INSERT INTO guests (property_id, first_name, last_name, email, phone)
         VALUES ($1, 'Vikram', 'Sethi', 'vikram.e2e@guest.example', '+91 98444 55667')
         RETURNING id`,
        [propId]
      );

      const today = getPropertyLocalDate('Asia/Kolkata');
      const fin = calculateReservationFinancials({
        nights: 2,
        nightlyRate: 5200,
        discountAmount: 0,
        taxRate: 12,
      });

      await pool.query(
        `INSERT INTO reservations (
           property_id, booking_reference, guest_id, room_type_id, room_id,
           arrival_date, departure_date, adults, children, num_guests,
           nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
           currency, source, status, checked_in_at, created_by
         ) VALUES
           ($1, $2, $3, $4, $5, $6::date, $7::date, 2, 0, 2, 5200, 0, 12, $8, $9, 'INR', 'direct', 'checked_in', NOW(), $10),
           ($1, $11, $12, $4, $13, $6::date, $7::date, 1, 0, 1, 5200, 0, 12, $8, $9, 'INR', 'direct', 'checked_in', NOW(), $10)`,
        [
          propId,
          `EF-RES1-${suffix}`,
          guest1Res.rows[0].id,
          rtRes.rows[0].id,
          room1Res.rows[0].id,
          today,
          addDays(today, 2),
          fin.taxAmount,
          fin.estimatedTotal,
          adminId,
          `EF-RES2-${suffix}`,
          guest2Res.rows[0].id,
          room2Res.rows[0].id,
        ]
      );

      const catRes = await pool.query(
        `INSERT INTO food_categories (property_id, code, name, description, display_order, is_active)
         VALUES ($1, 'ALLDAY', 'All-Day Room Dining', 'Served fresh to your room', 1, TRUE)
         RETURNING id`,
        [propId]
      );
      const itemRes = await pool.query(
        `INSERT INTO food_menu_items (
           property_id, category_id, sku, name, description, price, dietary_tag, prep_time_minutes, is_available, is_active
         ) VALUES ($1, $2, $3, 'Saffron Kesari Pulao', 'Fragrant basmati rice with nuts', 420.00, 'veg', 18, TRUE, TRUE)
         RETURNING id`,
        [propId, catRes.rows[0].id, `E2E-SKU1-${suffix}`]
      );
      menuItemId = String(itemRes.rows[0].id);

      const unavailRes = await pool.query(
        `INSERT INTO food_menu_items (
           property_id, category_id, sku, name, description, price, dietary_tag, prep_time_minutes, is_available, is_active
         ) VALUES ($1, $2, $3, 'Midnight Rabri SoldOut', 'Unavailable dessert', 260.00, 'veg', 10, FALSE, TRUE)
         RETURNING id`,
        [propId, catRes.rows[0].id, `E2E-SKU2-${suffix}`]
      );
      unavailableMenuItemId = String(unavailRes.rows[0].id);

      const clientDist = path.resolve(process.cwd(), 'dist/client');
      const hasClientBuild = fs.existsSync(path.join(clientDist, 'index.html'));

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
      await new Promise<void>((resolve) =>
        server!.listen(0, '127.0.0.1', () => resolve())
      );
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;

      browser = await chromium.launch({
        executablePath: chromiumExecutable,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    }, 60_000);

    beforeEach(async () => {
      await assertTestDatabaseOnly();
      resetLoginRateLimiter();
      resetPublicGuestOrderRateLimiter();
      clearTestMailOutbox();
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
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      await closePool();
    });

    it(
      'verifies Open Guest Menu click, QR SVG/Download/Print optical scan parity, guest ordering, Dashboard + Food & Menu visibility, status updates, guest isolation, and Pause + Rotate QR controls',
      async () => {
        await assertTestDatabaseOnly();

        // Admin context: open Restaurant -> Hotel QR Menu modal
        const adminContext = await browser!.newContext({
          viewport: { width: 1366, height: 900 },
          acceptDownloads: true,
          permissions: ['clipboard-read', 'clipboard-write'],
        });
        const adminPage = await adminContext.newPage();

        await adminPage.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
        await adminPage.fill('#login-email', adminEmail);
        await adminPage.fill('#login-password', adminPassword);
        await adminPage.click('button[type="submit"]');
        await adminPage.waitForURL(`${baseUrl}/`, { timeout: 15_000 });

        await adminPage.goto(`${baseUrl}/restaurant`, {
          waitUntil: 'networkidle',
        });
        await adminPage.getByTestId('open-hotel-qr-modal-btn').click();
        await adminPage
          .getByTestId('guest-qr-config-modal')
          .waitFor({ state: 'visible', timeout: 10_000 });

        // Check 8 & 9 (Local Dev mode): Inspect displayed URL, Copy link, QR image, Downloaded SVG, and Printed QR card
        const displayedUrl = await adminPage
          .getByTestId('hotel-qr-menu-url')
          .inputValue();
        expect(displayedUrl).toBe(`${baseUrl}/guest/menu/${qrToken}`);
        expect(displayedUrl).not.toContain('.e2b.app');

        const envKind = await adminPage
          .getByTestId('hotel-qr-url-env')
          .getAttribute('data-url-kind');
        expect(envKind).toBe('local_dev');

        await adminPage.getByRole('button', { name: 'Copy' }).click();
        const copiedLocalUrl = await adminPage.evaluate(() =>
          navigator.clipboard.readText()
        );
        expect(copiedLocalUrl).toBe(displayedUrl);

        if (zbarExecutable) {
          // 9a. Optical scan of modal QR image
          const modalQrPng = path.join(tmpDir, 'modal-qr.png');
          await adminPage
            .getByTestId('hotel-qr-svg-img')
            .screenshot({ path: modalQrPng });
          expect(scanQrImageWithZbar(modalQrPng)).toBe(displayedUrl);

          // 9b. Optical scan of downloaded SVG
          const downloadPromise = adminPage.waitForEvent('download');
          await adminPage.getByRole('button', { name: 'Download SVG' }).click();
          const download = await downloadPromise;
          const downloadedSvgPath = path.join(tmpDir, 'downloaded-qr.svg');
          await download.saveAs(downloadedSvgPath);
          const downloadedSvgText = fs.readFileSync(downloadedSvgPath, 'utf8');
          expect(downloadedSvgText).toContain('<svg');

          const svgCheckPage = await adminContext.newPage();
          await svgCheckPage.setContent(
            `<html><body style="margin:24px;background:#fff">${downloadedSvgText}</body></html>`
          );
          const downloadedPng = path.join(tmpDir, 'downloaded-qr.png');
          await svgCheckPage.locator('svg').screenshot({ path: downloadedPng });
          expect(scanQrImageWithZbar(downloadedPng)).toBe(displayedUrl);
          await svgCheckPage.close();

          // 9c. Optical scan & URL parity of Printed QR Room Tent Card (@media print)
          await adminPage.emulateMedia({ media: 'print' });
          await adminPage
            .getByTestId('hotel-qr-print-card')
            .waitFor({ state: 'visible', timeout: 5_000 });
          const printedUrlText =
            (await adminPage.getByTestId('hotel-qr-print-url').textContent())?.trim() ??
            '';
          expect(printedUrlText).toBe(displayedUrl);

          const printedQrPng = path.join(tmpDir, 'printed-qr.png');
          await adminPage
            .getByTestId('hotel-qr-print-svg-img')
            .screenshot({ path: printedQrPng });
          expect(scanQrImageWithZbar(printedQrPng)).toBe(displayedUrl);
          await adminPage.emulateMedia({ media: 'screen' });
        }

        // Check Production PUBLIC_APP_URL mode in UI (QR image + Copy + Downloaded SVG + Printed QR all encode production URL)
        const originalPublicAppUrl = process.env.PUBLIC_APP_URL;
        try {
          process.env.PUBLIC_APP_URL = 'https://dining.staycraft-hotel.example/';
          await adminPage.getByLabel('Close dialog').click();
          await adminPage.getByTestId('open-hotel-qr-modal-btn').click();
          await adminPage
            .getByTestId('guest-qr-config-modal')
            .waitFor({ state: 'visible', timeout: 10_000 });

          const expectedProdUrl = `https://dining.staycraft-hotel.example/guest/menu/${qrToken}`;
          expect(
            await adminPage
              .getByTestId('hotel-qr-url-env')
              .getAttribute('data-url-kind')
          ).toBe('production');
          expect(
            await adminPage.getByTestId('hotel-qr-menu-url').inputValue()
          ).toBe(expectedProdUrl);
          expect(
            await adminPage
              .getByTestId('hotel-qr-open-preview-link')
              .getAttribute('href')
          ).toBe(expectedProdUrl);
          expect(
            await adminPage
              .getByTestId('hotel-qr-local-preview-link')
              .getAttribute('href')
          ).toBe(`/guest/menu/${qrToken}`);

          await adminPage.getByRole('button', { name: 'Copy' }).click();
          const copiedProdUrl = await adminPage.evaluate(() =>
            navigator.clipboard.readText()
          );
          expect(copiedProdUrl).toBe(expectedProdUrl);

          if (zbarExecutable) {
            const prodModalPng = path.join(tmpDir, 'prod-modal-qr.png');
            await adminPage
              .getByTestId('hotel-qr-svg-img')
              .screenshot({ path: prodModalPng });
            expect(scanQrImageWithZbar(prodModalPng)).toBe(expectedProdUrl);

            const prodDownloadPromise = adminPage.waitForEvent('download');
            await adminPage
              .getByRole('button', { name: 'Download SVG' })
              .click();
            const prodDownload = await prodDownloadPromise;
            const prodSvgPath = path.join(tmpDir, 'prod-downloaded-qr.svg');
            await prodDownload.saveAs(prodSvgPath);
            const prodSvgText = fs.readFileSync(prodSvgPath, 'utf8');

            const prodSvgPage = await adminContext.newPage();
            await prodSvgPage.setContent(
              `<html><body style="margin:24px;background:#fff">${prodSvgText}</body></html>`
            );
            const prodDlPng = path.join(tmpDir, 'prod-downloaded-qr.png');
            await prodSvgPage.locator('svg').screenshot({ path: prodDlPng });
            expect(scanQrImageWithZbar(prodDlPng)).toBe(expectedProdUrl);
            await prodSvgPage.close();

            await adminPage.emulateMedia({ media: 'print' });
            await adminPage
              .getByTestId('hotel-qr-print-card')
              .waitFor({ state: 'visible', timeout: 5_000 });
            expect(
              (
                await adminPage.getByTestId('hotel-qr-print-url').textContent()
              )?.trim()
            ).toBe(expectedProdUrl);
            const prodPrintPng = path.join(tmpDir, 'prod-printed-qr.png');
            await adminPage
              .getByTestId('hotel-qr-print-svg-img')
              .screenshot({ path: prodPrintPng });
            expect(scanQrImageWithZbar(prodPrintPng)).toBe(expectedProdUrl);
            await adminPage.emulateMedia({ media: 'screen' });
          }

          // Check Preview Sandbox Unconfigured mode in UI without mutating NODE_ENV or STAYCRAFT_DB_ROLE
          delete process.env.PUBLIC_APP_URL;
          await adminPage.setExtraHTTPHeaders({
            'X-Forwarded-Host': '3000-previewtest.e2b.app',
            'X-Forwarded-Proto': 'https',
          });
          await adminPage.getByLabel('Close dialog').click();
          await adminPage.getByTestId('open-hotel-qr-modal-btn').click();
          await adminPage
            .getByTestId('hotel-qr-unconfigured-placeholder')
            .waitFor({ state: 'visible', timeout: 10_000 });
          expect(await adminPage.getByTestId('hotel-qr-svg-img').count()).toBe(
            0
          );
          expect(
            await adminPage.getByTestId('hotel-qr-print-card').count()
          ).toBe(0);
          expect(
            await adminPage
              .getByRole('button', { name: 'Download SVG' })
              .isDisabled()
          ).toBe(true);
          expect(
            await adminPage.getByRole('button', { name: 'Print' }).isDisabled()
          ).toBe(true);
          expect(
            await adminPage.getByTestId('hotel-qr-config-required').textContent()
          ).toContain('PUBLIC_APP_URL');
          await adminPage.setExtraHTTPHeaders({});

          // Check Production Unconfigured alert in UI using mocked route response (zero DB/env side effects)
          await adminPage.route('**/api/restaurant/qr-config', async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                config: {
                  propertyId: propId,
                  propertyName: 'Ganges View E2E Hotel',
                  propertyCode: 'EFE2E',
                  enabled: true,
                  qrToken,
                  guestMenuPath: `/guest/menu/${qrToken}`,
                  urlMode: 'production_unconfigured',
                  qrReady: false,
                  guestMenuUrl: null,
                  qrSvg: null,
                  configurationNotice:
                    'PUBLIC_APP_URL is not configured for this production deployment. Set PUBLIC_APP_URL=https://<your-public-domain> on the server to generate a verified, phone-scannable Guest QR code.',
                },
              }),
            });
          });
          await adminPage.getByLabel('Close dialog').click();
          await adminPage.getByTestId('open-hotel-qr-modal-btn').click();
          await adminPage
            .getByTestId('hotel-qr-production-missing-alert')
            .waitFor({ state: 'visible', timeout: 10_000 });
          expect(
            await adminPage
              .getByTestId('hotel-qr-url-env')
              .getAttribute('data-url-kind')
          ).toBe('production_unconfigured');
          expect(await adminPage.getByTestId('hotel-qr-svg-img').count()).toBe(
            0
          );
          await adminPage.unroute('**/api/restaurant/qr-config');
        } finally {
          await adminPage.setExtraHTTPHeaders({}).catch(() => {});
          await adminPage.unroute('**/api/restaurant/qr-config').catch(() => {});
          if (originalPublicAppUrl === undefined) {
            delete process.env.PUBLIC_APP_URL;
          } else {
            process.env.PUBLIC_APP_URL = originalPublicAppUrl;
          }
        }

        // Restore modal in normal local_dev mode and click "Open Guest Menu"
        await adminPage.getByLabel('Close dialog').click();
        await adminPage.getByTestId('open-hotel-qr-modal-btn').click();
        await adminPage
          .getByTestId('hotel-qr-open-preview-link')
          .waitFor({ state: 'visible', timeout: 10_000 });

        // Check 1: Click "Open Guest Menu" and verify public guest page loads in new tab
        const popupPromise = adminContext.waitForEvent('page');
        await adminPage.getByTestId('hotel-qr-open-preview-link').click();
        const openedPreviewTab = await popupPromise;
        await openedPreviewTab
          .getByTestId('guest-qr-menu-page')
          .waitFor({ state: 'visible', timeout: 15_000 });
        expect(await openedPreviewTab.textContent('h1')).toContain(
          'Ganges View E2E Hotel'
        );
        await openedPreviewTab.close();
        await adminPage.keyboard.press('Escape');

        // Check 2 & 5 & 8: Unauthenticated mobile guest browser context (zero PMS session, zero /api/auth/me calls)
        const guestContext = await browser!.newContext({
          viewport: { width: 390, height: 844 },
        });
        const guestPage = await guestContext.newPage();
        const guestStaffAuthCalls: string[] = [];
        guestPage.on('request', (req) => {
          if (req.url().includes('/api/auth/')) {
            guestStaffAuthCalls.push(req.url());
          }
        });
        await guestPage.goto(`${baseUrl}/guest/menu/${qrToken}`, {
          waitUntil: 'networkidle',
        });
        await guestPage
          .getByTestId('guest-qr-menu-page')
          .waitFor({ state: 'visible', timeout: 15_000 });
        expect(guestStaffAuthCalls).toHaveLength(0);

        // Available item is shown; unavailable item is hidden
        expect(
          await guestPage.getByTestId(`guest-menu-item-${menuItemId}`).isVisible()
        ).toBe(true);
        expect(
          await guestPage
            .getByTestId(`guest-menu-item-${unavailableMenuItemId}`)
            .count()
        ).toBe(0);

        // Select quantity = 2 (2 * 420 = 840 + 12% GST 100.80 = 940.80)
        await guestPage.getByTestId(`guest-add-item-${menuItemId}`).click();
        await guestPage
          .getByRole('button', { name: 'Increase Saffron Kesari Pulao' })
          .click();
        expect(
          await guestPage.getByTestId(`guest-item-qty-${menuItemId}`).textContent()
        ).toBe('2');

        await guestPage.getByTestId('guest-open-cart-btn').click();
        await guestPage
          .getByTestId('guest-cart-modal')
          .waitFor({ state: 'visible', timeout: 10_000 });

        // First test invalid/vacant room rejection in UI
        await guestPage
          .getByTestId('guest-checkout-room-input')
          .fill(vacantRoomNumber);
        await guestPage.getByTestId('guest-submit-order-btn').click();
        await guestPage
          .getByTestId('guest-order-error')
          .waitFor({ state: 'visible', timeout: 10_000 });

        // Now submit with valid checked-in room number without any PMS login
        await guestPage
          .getByTestId('guest-checkout-room-input')
          .fill(checkedInRoomNumber);
        await guestPage.getByTestId('guest-submit-order-btn').click();

        await guestPage
          .getByTestId('guest-qr-order-tracker')
          .waitFor({ state: 'visible', timeout: 15_000 });
        const guest1Url = new URL(guestPage.url());
        const guest1TrackingToken = guest1Url.searchParams.get('track') ?? '';
        expect(guest1TrackingToken).toMatch(/^[a-f0-9]{64}$/);

        const trackerHeading =
          (await guestPage
            .getByTestId('guest-qr-order-tracker')
            .locator('h2')
            .textContent()) ?? '';
        const orderRefMatch = trackerHeading.match(/Order\s+([A-Z0-9-]+)/);
        expect(orderRefMatch).not.toBeNull();
        const orderReference = orderRefMatch![1];

        // Place a second guest order on Room 302 from a separate guest context to verify cross-guest isolation
        const guest2Context = await browser!.newContext({
          viewport: { width: 390, height: 844 },
        });
        const guest2Page = await guest2Context.newPage();
        await guest2Page.goto(`${baseUrl}/guest/menu/${qrToken}`, {
          waitUntil: 'networkidle',
        });
        await guest2Page.getByTestId(`guest-add-item-${menuItemId}`).click();
        await guest2Page.getByTestId('guest-open-cart-btn').click();
        await guest2Page
          .getByTestId('guest-checkout-room-input')
          .fill(secondCheckedInRoomNumber);
        await guest2Page.getByTestId('guest-submit-order-btn').click();
        await guest2Page
          .getByTestId('guest-qr-order-tracker')
          .waitFor({ state: 'visible', timeout: 15_000 });
        const guest2Heading =
          (await guest2Page
            .getByTestId('guest-qr-order-tracker')
            .locator('h2')
            .textContent()) ?? '';
        const order2Ref = guest2Heading.replace(/^Order\s+/, '').trim();
        expect(order2Ref).not.toBe(orderReference);

        // Check 4 (Isolation): Guest 1 cannot access internal PMS pages or another guest's order by reference
        const internalProbePage = await guestContext.newPage();
        for (const protectedPath of ['/', '/restaurant', '/reservations', '/staff', '/settings']) {
          await internalProbePage.goto(`${baseUrl}${protectedPath}`, {
            waitUntil: 'networkidle',
          });
          expect(new URL(internalProbePage.url()).pathname).toBe('/login');
        }
        const unauthorizedApiStatus = await internalProbePage.evaluate(async () => {
          const r = await fetch('/api/restaurant/orders');
          return r.status;
        });
        expect(unauthorizedApiStatus).toBe(401);

        const crossGuestRefProbeStatus = await internalProbePage.evaluate(
          async (otherOrderRef) => {
            const r = await fetch(
              `/api/public/guest-food/orders/${encodeURIComponent(otherOrderRef)}`
            );
            return r.status;
          },
          order2Ref
        );
        expect(crossGuestRefProbeStatus).toBe(404);
        await internalProbePage.close();

        // Check 3 & 4: Verify submitted order appears on BOTH PMS Dashboard and Food & Menu, and staff updates status
        await adminPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
        await adminPage
          .getByTestId(`dashboard-food-order-${orderReference}`)
          .waitFor({ state: 'visible', timeout: 15_000 });
        const dashCardText =
          (await adminPage
            .getByTestId(`dashboard-food-order-${orderReference}`)
            .textContent()) ?? '';
        expect(dashCardText).toContain('Guest QR');
        expect(dashCardText).toContain(checkedInRoomNumber);

        // Advance Pending -> Preparing from PMS Dashboard
        await adminPage
          .getByTestId(`dashboard-food-order-${orderReference}`)
          .getByRole('button', { name: 'Start Prep' })
          .click();

        // Verify order also appears in Food & Menu -> Kitchen Board & Orders Ledger, and advance Preparing -> Ready
        await adminPage.goto(`${baseUrl}/restaurant?tab=kitchen`, {
          waitUntil: 'networkidle',
        });
        await adminPage
          .getByTestId(`kitchen-card-${orderReference}`)
          .waitFor({ state: 'visible', timeout: 15_000 });
        await adminPage
          .getByTestId(`kitchen-card-${orderReference}`)
          .getByRole('button', { name: 'Mark Ready' })
          .click();

        // Switch to Orders Ledger tab and filter by Guest QR source
        await adminPage.goto(`${baseUrl}/restaurant?tab=orders`, {
          waitUntil: 'networkidle',
        });
        await adminPage
          .getByLabel('Filter order source')
          .selectOption('guest_qr');
        await adminPage.waitForFunction(
          (ref) => document.body.textContent?.includes(ref) === true,
          orderReference,
          { timeout: 10_000 }
        );

        // Guest 1 refreshes status tracker -> sees "Ready" (and still zero PII or Guest 2 data)
        await guestPage.getByRole('button', { name: 'Refresh' }).click();
        await guestPage.waitForFunction(
          () => document.body.textContent?.includes('Ready') === true,
          undefined,
          { timeout: 10_000 }
        );
        const guest1BodyText = (await guestPage.textContent('body')) ?? '';
        expect(guest1BodyText).not.toContain('Kavya');
        expect(guest1BodyText).not.toContain('Vikram');
        expect(guest1BodyText).not.toContain(order2Ref);

        // Check 6: Pause QR Ordering & Rotate QR Link in GuestQrConfigModal
        await adminPage.getByTestId('open-hotel-qr-modal-btn').click();
        await adminPage
          .getByTestId('hotel-qr-toggle-btn')
          .waitFor({ state: 'visible', timeout: 10_000 });

        // Pause QR ordering
        await adminPage.getByTestId('hotel-qr-toggle-btn').click();
        await adminPage.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="guest-qr-config-modal"]')
              ?.textContent?.includes('Paused') === true,
          undefined,
          { timeout: 10_000 }
        );

        // Guest attempting to load paused QR menu sees paused message, and order POST fails with 403
        const pausedGuestPage = await guestContext.newPage();
        await pausedGuestPage.goto(`${baseUrl}/guest/menu/${qrToken}`, {
          waitUntil: 'networkidle',
        });
        await pausedGuestPage
          .getByTestId('guest-qr-error-state')
          .waitFor({ state: 'visible', timeout: 10_000 });
        expect(await pausedGuestPage.textContent('body')).toContain('Paused');

        const pausedPostStatus = await pausedGuestPage.evaluate(
          async ({ token, room, itemId }) => {
            const r = await fetch(`/api/public/guest-food/menu/${token}/orders`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                roomNumber: room,
                items: [{ menuItemId: itemId, quantity: 1 }],
              }),
            });
            return r.status;
          },
          { token: qrToken, room: checkedInRoomNumber, itemId: menuItemId }
        );
        expect(pausedPostStatus).toBe(403);

        // Unrelated PMS functionality (staff POS ordering & existing guest tracking) remains unaffected while QR is paused
        const staffPosWhilePausedStatus = await adminPage.evaluate(
          async ({ prop, itemId }) => {
            const token = window.localStorage.getItem('staycraft_session_token');
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              'X-Property-Id': prop,
            };
            if (token) headers.Authorization = `Bearer ${token}`;
            const r = await fetch('/api/restaurant/orders', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                orderType: 'takeaway',
                tableOrLocation: 'Lobby Counter',
                items: [{ menuItemId: itemId, quantity: 1 }],
              }),
            });
            return r.status;
          },
          { prop: propId, itemId: menuItemId }
        );
        expect(staffPosWhilePausedStatus).toBe(201);

        // Re-enable QR ordering, then Rotate QR Link
        await adminPage.getByTestId('hotel-qr-toggle-btn').click();
        await adminPage.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="guest-qr-config-modal"]')
              ?.textContent?.includes('Ordering Active') === true,
          undefined,
          { timeout: 10_000 }
        );

        const previousQrToken = qrToken;
        await adminPage.getByRole('button', { name: 'Rotate QR Link' }).click();
        await adminPage.getByTestId('hotel-qr-confirm-rotate-btn').click();

        await adminPage.waitForFunction(
          (oldUrl) => {
            const input = document.querySelector(
              '[data-testid="hotel-qr-menu-url"]'
            ) as HTMLInputElement | null;
            return Boolean(input && input.value && input.value !== oldUrl);
          },
          `${baseUrl}/guest/menu/${previousQrToken}`,
          { timeout: 10_000 }
        );
        const rotatedMenuUrl = await adminPage
          .getByTestId('hotel-qr-menu-url')
          .inputValue();
        expect(rotatedMenuUrl).not.toContain(previousQrToken);

        // Old QR link is immediately invalidated (error state on UI + 404 on API), while rotated link loads
        await pausedGuestPage.goto(`${baseUrl}/guest/menu/${previousQrToken}`, {
          waitUntil: 'networkidle',
        });
        await pausedGuestPage
          .getByTestId('guest-qr-error-state')
          .waitFor({ state: 'visible', timeout: 10_000 });

        await pausedGuestPage.goto(rotatedMenuUrl, { waitUntil: 'networkidle' });
        await pausedGuestPage
          .getByTestId('guest-qr-menu-page')
          .waitFor({ state: 'visible', timeout: 10_000 });

        qrToken = rotatedMenuUrl.split('/guest/menu/')[1];

        await pausedGuestPage.close();
        await guestContext.close();
        await guest2Context.close();
        await adminContext.close();
      },
      90_000
    );

    it(
      'verifies Account Management in Chromium: self-service email & password changes, session invalidation, RBAC restrictions, Admin reset link UI, and Forgot/Reset Password recovery',
      async () => {
        await assertTestDatabaseOnly();

        // Two browser contexts for Receptionist to verify multi-device session invalidation
        const recCtx1 = await browser!.newContext({
          viewport: { width: 1366, height: 900 },
        });
        const recCtx2 = await browser!.newContext({
          viewport: { width: 1366, height: 900 },
        });
        const recPage1 = await recCtx1.newPage();
        const recPage2 = await recCtx2.newPage();

        for (const p of [recPage1, recPage2]) {
          await p.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
          await p.fill('#login-email', recEmail);
          await p.fill('#login-password', recPassword);
          await p.click('button[type="submit"]');
          await p.waitForURL(`${baseUrl}/`, { timeout: 15_000 });
        }

        // Receptionist opens Settings -> Property Settings is read-only, Account & Security is editable
        await recPage1.goto(`${baseUrl}/settings`, { waitUntil: 'networkidle' });
        await recPage1
          .getByTestId('account-security-section')
          .waitFor({ state: 'visible', timeout: 10_000 });
        expect(await recPage1.locator('#prop-name').isDisabled()).toBe(true);

        // Receptionist updates own email -> Device 1 stays signed in, Device 2 session is invalidated
        const updatedRecEmail = `self.${recEmail}`;
        await recPage1.getByTestId('acct-new-email-input').fill(updatedRecEmail);
        await recPage1.getByTestId('acct-email-password-input').fill(recPassword);
        await recPage1.getByTestId('acct-save-email-btn').click();
        await recPage1.waitForFunction(
          (emailVal) => document.body.textContent?.includes(emailVal) === true,
          updatedRecEmail,
          { timeout: 10_000 }
        );
        recEmail = updatedRecEmail;

        const dev2StatusAfterEmail = await recPage2.evaluate(async () => {
          const r = await fetch('/api/auth/me');
          return r.status;
        });
        expect(dev2StatusAfterEmail).toBe(401);

        // Receptionist changes own password -> updates hash cleanly
        const updatedRecPass = 'RecSelfUpdated#2026!';
        await recPage1.getByTestId('acct-current-password-input').fill(recPassword);
        await recPage1.getByTestId('acct-new-password-input').fill(updatedRecPass);
        await recPage1.getByTestId('acct-confirm-password-input').fill(updatedRecPass);
        await recPage1.getByTestId('acct-save-password-btn').click();
        await recPage1.waitForFunction(
          () =>
            (
              document.querySelector(
                '[data-testid="acct-new-password-input"]'
              ) as HTMLInputElement | null
            )?.value === '',
          undefined,
          { timeout: 10_000 }
        );

        // Admin opens Staff & Users -> System Users & Access -> issues single-use reset link for Receptionist
        const adminCtx = await browser!.newContext({
          viewport: { width: 1366, height: 900 },
        });
        const adminPage = await adminCtx.newPage();
        await adminPage.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
        await adminPage.fill('#login-email', adminEmail);
        await adminPage.fill('#login-password', adminPassword);
        await adminPage.click('button[type="submit"]');
        await adminPage.waitForURL(`${baseUrl}/`, { timeout: 15_000 });

        await adminPage.goto(`${baseUrl}/staff?tab=users`, {
          waitUntil: 'networkidle',
        });
        const recRow = adminPage.locator('tr', { hasText: recEmail });
        await recRow.waitFor({ state: 'visible', timeout: 10_000 });
        await recRow.getByRole('button', { name: /Reset/i }).click();

        await adminPage
          .getByTestId('admin-send-reset-link-btn')
          .waitFor({ state: 'visible', timeout: 10_000 });
        await adminPage.getByTestId('admin-send-reset-link-btn').click();
        await adminPage
          .getByTestId('admin-generated-reset-url')
          .waitFor({ state: 'visible', timeout: 10_000 });
        const adminIssuedUrl = await adminPage
          .getByTestId('admin-generated-reset-url')
          .inputValue();
        expect(adminIssuedUrl).toContain('/reset-password?token=');

        // Public Forgot Password -> single-use Reset Password link invalidates prior link & rotates all sessions
        clearTestMailOutbox();
        const recoveryCtx = await browser!.newContext();
        const recoveryPage = await recoveryCtx.newPage();

        await recoveryPage.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
        await recoveryPage.getByTestId('login-forgot-password-link').click();
        await recoveryPage
          .getByTestId('forgot-password-email-input')
          .fill(recEmail);
        await recoveryPage.getByTestId('forgot-password-submit-btn').click();
        await recoveryPage
          .getByTestId('forgot-password-success')
          .waitFor({ state: 'visible', timeout: 10_000 });

        const outbox = getTestMailOutbox();
        expect(outbox.length).toBeGreaterThanOrEqual(1);
        const tokenMatch = outbox[outbox.length - 1].textBody.match(
          /token=([a-f0-9]{64})/
        );
        expect(tokenMatch).not.toBeNull();

        // Admin's earlier unused link was superseded by the newer reset request
        await recoveryPage.goto(adminIssuedUrl, { waitUntil: 'networkidle' });
        await recoveryPage
          .getByTestId('reset-password-invalid')
          .waitFor({ state: 'visible', timeout: 10_000 });

        // Complete password reset with the latest token
        const finalRecPass = 'FinalRecoveredRec#2026!';
        await recoveryPage.goto(
          `${baseUrl}/reset-password?token=${tokenMatch![1]}`,
          { waitUntil: 'networkidle' }
        );
        await recoveryPage
          .getByTestId('reset-password-new-input')
          .fill(finalRecPass);
        await recoveryPage
          .getByTestId('reset-password-confirm-input')
          .fill(finalRecPass);
        await recoveryPage.getByTestId('reset-password-submit-btn').click();
        await recoveryPage
          .getByTestId('login-reset-success-banner')
          .waitFor({ state: 'visible', timeout: 10_000 });

        // Receptionist's Device 1 session was also invalidated when password reset completed!
        const dev1StatusAfterReset = await recPage1.evaluate(async () => {
          const r = await fetch('/api/auth/me');
          return r.status;
        });
        expect(dev1StatusAfterReset).toBe(401);

        // Sign in with the newly recovered password succeeds
        await recoveryPage.fill('#login-email', recEmail);
        await recoveryPage.fill('#login-password', finalRecPass);
        await recoveryPage.click('button[type="submit"]');
        await recoveryPage.waitForURL(`${baseUrl}/`, { timeout: 15_000 });

        await recCtx1.close();
        await recCtx2.close();
        await adminCtx.close();
        await recoveryCtx.close();
      },
      90_000
    );
  }
);
