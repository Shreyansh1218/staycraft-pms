import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import express from 'express';
import { chromium } from 'playwright-core';
import QRCode from 'qrcode';
import supertest from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Property, UserSummary } from '../src/shared/types.js';

interface MockPropertyRow {
  id: string;
  name: string;
  code: string;
  city: string;
  currency: string;
  tax_name: string;
  default_tax_rate: string;
  phone: string;
  is_active: boolean;
  guest_qr_token: string;
  guest_qr_enabled: boolean;
}

const mockStore = vi.hoisted(() => ({
  properties: new Map<string, MockPropertyRow>(),
  auditEvents: [] as Array<{ action: string; propertyId: string }>,
}));

vi.mock('../src/server/db/pool.js', () => {
  const queryImpl = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized === 'SELECT current_database() AS db') {
      return { rowCount: 1, rows: [{ db: 'staycraft_pms_test' }] };
    }

    if (
      normalized.startsWith(
        'SELECT id, name, code, guest_qr_token, guest_qr_enabled FROM properties'
      )
    ) {
      const id = String(params[0] ?? '');
      const row = mockStore.properties.get(id);
      if (!row || !row.is_active) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [{ ...row }] };
    }

    if (normalized.startsWith('UPDATE properties SET guest_qr_enabled = $1')) {
      const enabled = Boolean(params[0]);
      const id = String(params[1] ?? '');
      const row = mockStore.properties.get(id);
      if (!row || !row.is_active) {
        return { rowCount: 0, rows: [] };
      }
      row.guest_qr_enabled = enabled;
      return { rowCount: 1, rows: [{ ...row }] };
    }

    if (normalized.startsWith('UPDATE properties SET guest_qr_token = $1')) {
      const nextToken = String(params[0] ?? '');
      const id = String(params[1] ?? '');
      const row = mockStore.properties.get(id);
      if (!row || !row.is_active) {
        return { rowCount: 0, rows: [] };
      }
      row.guest_qr_token = nextToken;
      return { rowCount: 1, rows: [{ ...row }] };
    }

    if (normalized.includes('FROM properties WHERE LOWER(guest_qr_token) = $1')) {
      const token = String(params[0] ?? '').toLowerCase();
      const found = Array.from(mockStore.properties.values()).find(
        (p) => p.is_active && p.guest_qr_token.toLowerCase() === token
      );
      if (!found) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [{ ...found }] };
    }

    if (normalized.includes('FROM food_categories c')) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 'cat-1',
            name: 'All-Day Dining',
            description: 'Freshly prepared',
            display_order: 1,
          },
        ],
      };
    }

    if (normalized.includes('FROM food_menu_items m')) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 'item-1',
            category_id: 'cat-1',
            category_name: 'All-Day Dining',
            name: 'Masala Chai',
            description: 'Spiced tea',
            price: '120.00',
            dietary_tag: 'beverage',
            prep_time_minutes: 8,
            display_order: 1,
          },
        ],
      };
    }

    return { rowCount: 0, rows: [] };
  });

  const fakeClient = { query: queryImpl };

  return {
    getPool: () => ({ query: queryImpl }),
    withTransaction: async <T>(fn: (client: typeof fakeClient) => Promise<T>) =>
      fn(fakeClient),
    closePool: async () => undefined,
  };
});

vi.mock('../src/server/services/audit.service.js', () => ({
  recordAuditEvent: vi.fn(async (event: { action: string; propertyId: string }) => {
    mockStore.auditEvents.push({
      action: event.action,
      propertyId: event.propertyId,
    });
  }),
}));

import { createApiApp, isTrustedRequestOrigin } from '../src/server/app.js';
import {
  isLoopbackOrPrivateHost,
  isPrivateLanHost,
  isSandboxPreviewHost,
  resolveConfiguredAppUrl,
  resolvePublicAppUrl,
} from '../src/server/config.js';
import {
  createPublicGuestFoodOrder,
  getPropertyQrFoodConfig,
  getPublicGuestMenuByQrToken,
  regeneratePropertyQrFoodToken,
  updatePropertyQrFoodConfig,
} from '../src/server/modules/restaurant/guest-food.service.js';
import {
  resolveGuestQrUrlContext,
  resolveSafeAppBaseUrl,
} from '../src/server/services/mailer.service.js';

const PROP_A_ID = '11111111-1111-4111-8111-111111111111';
const PROP_B_ID = '22222222-2222-4222-8222-222222222222';
const PROP_A_INITIAL_TOKEN = '3341cf7e5b0c77a2539798b97aff873e';
const PROP_B_INITIAL_TOKEN = '86607eea78b6125bd83f9fd2e81b2a78';

const adminActor: UserSummary = {
  id: '99999999-9999-4999-8999-999999999999',
  email: 'admin@staycraft.local',
  fullName: 'Mock Admin',
  role: 'admin',
  phone: '',
  isActive: true,
  lastLoginAt: null,
  createdAt: '2026-10-26T00:00:00.000Z',
};

const receptionistActor: UserSummary = {
  id: '88888888-8888-4888-8888-888888888888',
  email: 'frontdesk@staycraft.local',
  fullName: 'Mock Receptionist',
  role: 'receptionist',
  phone: '',
  isActive: true,
  lastLoginAt: null,
  createdAt: '2026-10-26T00:00:00.000Z',
};

const propASummary = {
  id: PROP_A_ID,
  name: 'Kashi Heritage Boutique Hotel',
  code: 'KHB',
} as Property;

function makeMockRequest(headers: Record<string, string> = {}, secure = false): Request {
  return {
    headers,
    secure,
  } as unknown as Request;
}

describe('Guest QR URL Configuration, Validation & Mocked Service Regressions (Zero DB Writes)', () => {
  beforeEach(() => {
    mockStore.auditEvents.length = 0;
    mockStore.properties.clear();
    mockStore.properties.set(PROP_A_ID, {
      id: PROP_A_ID,
      name: 'Kashi Heritage Boutique Hotel',
      code: 'KHB',
      city: 'Varanasi',
      currency: 'INR',
      tax_name: 'GST',
      default_tax_rate: '12.00',
      phone: '+91 542 250 8800',
      is_active: true,
      guest_qr_token: PROP_A_INITIAL_TOKEN.toUpperCase(), // verify canonical lowercase normalization
      guest_qr_enabled: true,
    });
    mockStore.properties.set(PROP_B_ID, {
      id: PROP_B_ID,
      name: 'Emerald Harbor Suites',
      code: 'EHS',
      city: 'Mumbai',
      currency: 'INR',
      tax_name: 'GST',
      default_tax_rate: '12.00',
      phone: '+91 22 4000 1200',
      is_active: true,
      guest_qr_token: PROP_B_INITIAL_TOKEN,
      guest_qr_enabled: true,
    });
  });

  it('strictly enforces HTTPS public domains in production/preview and rejects sandbox, LAN, loopback, non-HTTPS, credential, subpath, and token-bearing URLs', () => {
    expect(resolvePublicAppUrl({ NODE_ENV: 'production' })).toBeNull();
    expect(
      resolvePublicAppUrl({ NODE_ENV: 'production', PUBLIC_APP_URL: '   ' })
    ).toBeNull();

    // Valid stable public HTTPS origins normalize trailing slash cleanly
    expect(
      resolveConfiguredAppUrl({
        NODE_ENV: 'production',
        PUBLIC_APP_URL: 'https://dining.kashiheritage.example/',
      })
    ).toEqual({
      origin: 'https://dining.kashiheritage.example',
      mode: 'production',
    });
    expect(
      resolvePublicAppUrl({
        NODE_ENV: 'production',
        PUBLIC_APP_URL: 'https://orders.staycraft-pms.com',
      })
    ).toBe('https://orders.staycraft-pms.com');

    // Sandbox, preview, HTTP, LAN, loopback, and malformed URLs rejected in production & preview
    const rejectedInProduction = [
      'https://3000-iz5fdtoqamrkd8a88xl53.e2b.app',
      'https://3000-iz5fdtoqamrkd8a88xl53.e2b.app.',
      'https://preview.e2b.dev',
      'https://arena.ai',
      'https://app.arena.ai',
      'https://preview.lmarena.ai',
      // Access token / query / hash injection
      'https://dining.kashiheritage.example?e2b-traffic-access-token=tok_secret',
      'https://dining.kashiheritage.example#fragment',
      // Embedded credentials & subpaths
      'https://user:pass@dining.kashiheritage.example',
      'https://dining.kashiheritage.example/guest/menu',
      // Non-HTTPS scheme (including local LAN HTTP in production!)
      'http://dining.kashiheritage.example',
      'http://192.168.1.10:3000',
      'http://10.0.0.12:3000',
      'ftp://dining.kashiheritage.example',
      // Loopback, private LAN, link-local, and internal container hosts in production
      'https://localhost:3000',
      'https://localhost.',
      'https://127.0.0.1:3000',
      'https://0.0.0.0:3000',
      'https://[::1]:3000',
      'https://10.0.0.12',
      'https://172.16.4.10',
      'https://192.168.1.25',
      'https://169.254.169.254',
      'https://staycraft-internal',
      'https://printer.local',
      'not-a-valid-url',
    ];

    for (const bad of rejectedInProduction) {
      expect(
        () =>
          resolvePublicAppUrl({
            NODE_ENV: 'production',
            PUBLIC_APP_URL: bad,
          }),
        `Expected PUBLIC_APP_URL="${bad}" to be rejected in production`
      ).toThrow(/Invalid PUBLIC_APP_URL/);
    }

    expect(isSandboxPreviewHost('3000-abc.e2b.app.')).toBe(true);
    expect(isLoopbackOrPrivateHost('localhost.')).toBe(true);
  });

  it('supports configured local Wi-Fi LAN URLs in local development while still rejecting localhost, 0.0.0.0, sandbox URLs, and plain-HTTP public domains', async () => {
    const validLanConfigs: Array<{ input: string; expectedOrigin: string }> = [
      {
        input: 'http://192.168.1.10:3000',
        expectedOrigin: 'http://192.168.1.10:3000',
      },
      {
        input: 'http://192.168.29.55:4000/',
        expectedOrigin: 'http://192.168.29.55:4000',
      },
      {
        input: 'http://10.0.0.24:3000',
        expectedOrigin: 'http://10.0.0.24:3000',
      },
      {
        input: 'http://172.20.10.2:3000',
        expectedOrigin: 'http://172.20.10.2:3000',
      },
      {
        input: 'http://frontdesk-laptop.local:3000',
        expectedOrigin: 'http://frontdesk-laptop.local:3000',
      },
    ];

    for (const { input, expectedOrigin } of validLanConfigs) {
      expect(
        resolveConfiguredAppUrl({
          NODE_ENV: 'development',
          PUBLIC_APP_URL: input,
        })
      ).toEqual({
        origin: expectedOrigin,
        mode: 'local_lan',
      });
    }

    // Rejects non-phone-reachable or unsafe URLs even in NODE_ENV=development
    const rejectedEvenInDev = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://0.0.0.0:3000',
      'http://[::1]:3000',
      'http://169.254.169.254:3000',
      'http://172.32.0.10:3000', // outside RFC 1918 172.16.0.0/12
      'http://dining.kashiheritage.example', // public domain must still use https://
      'https://3000-iz5fdtoqamrkd8a88xl53.e2b.app', // sandbox host always rejected
      'http://3000-iz5fdtoqamrkd8a88xl53.e2b.app',
      'http://192.168.1.10:3000/guest/menu', // subpath rejected
      'http://192.168.1.10:3000?token=abc', // query rejected
      'http://admin:secret@192.168.1.10:3000', // credentials rejected
    ];

    for (const badDev of rejectedEvenInDev) {
      expect(
        () =>
          resolvePublicAppUrl({
            NODE_ENV: 'development',
            PUBLIC_APP_URL: badDev,
          }),
        `Expected PUBLIC_APP_URL="${badDev}" to be rejected even in local development`
      ).toThrow(/Invalid PUBLIC_APP_URL/);
    }

    expect(isPrivateLanHost('192.168.1.10')).toBe(true);
    expect(isPrivateLanHost('172.20.10.2')).toBe(true);
    expect(isPrivateLanHost('172.32.0.1')).toBe(false);
    expect(isPrivateLanHost('localhost')).toBe(false);
    expect(isPrivateLanHost('0.0.0.0')).toBe(false);

    // End-to-end QR config + SVG generation + CSRF origin trust in local_lan mode
    const lanOrigin = 'http://192.168.29.55:3000';
    const lanCtx = resolveGuestQrUrlContext(
      makeMockRequest({ host: 'localhost:3000' }, false),
      {
        NODE_ENV: 'development',
        PUBLIC_APP_URL: `${lanOrigin}/`,
      }
    );

    expect(lanCtx.urlMode).toBe('local_lan');
    expect(lanCtx.qrReady).toBe(true);
    expect(lanCtx.baseUrl).toBe(lanOrigin);

    const lanQrCfg = await getPropertyQrFoodConfig(PROP_A_ID, lanCtx);
    const expectedLanMenuUrl = `${lanOrigin}/guest/menu/${PROP_A_INITIAL_TOKEN}`;
    expect(lanQrCfg.qrReady).toBe(true);
    expect(lanQrCfg.urlMode).toBe('local_lan');
    expect(lanQrCfg.guestMenuPath).toBe(`/guest/menu/${PROP_A_INITIAL_TOKEN}`);
    expect(lanQrCfg.guestMenuUrl).toBe(expectedLanMenuUrl);

    const expectedLanSvg = await QRCode.toString(expectedLanMenuUrl, {
      type: 'svg',
      margin: 2,
      width: 280,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    expect(lanQrCfg.qrSvg).toBe(expectedLanSvg);

    // Verify phone browser POST origin on LAN IP passes CSRF origin verification
    const phoneLanReq = makeMockRequest({ host: '192.168.29.55:3000' }, false);
    expect(isTrustedRequestOrigin(lanOrigin, phoneLanReq)).toBe(true);
  });

  it('never derives QR URLs from Host headers, Origin headers, localhost, or Arena sandbox URLs, and surfaces exact errors when PUBLIC_APP_URL is missing or invalid', () => {
    const spoofedReq = makeMockRequest(
      {
        host: '3000-sandbox123.e2b.app',
        'x-forwarded-host': 'spoofed-host.example.com',
        'x-forwarded-proto': 'https',
        origin: 'https://app.arena.ai',
      },
      true
    );

    // Production without PUBLIC_APP_URL -> fails clearly with exact configurationError
    const prodNoSandboxReq = makeMockRequest(
      {
        host: 'spoofed-host.example.com',
        'x-forwarded-proto': 'https',
      },
      true
    );
    const prodMissingCtx = resolveGuestQrUrlContext(prodNoSandboxReq, {
      NODE_ENV: 'production',
      E2B_SANDBOX_ID: 'iz5fdtoqamrkd8a88xl53',
    });
    expect(prodMissingCtx).toMatchObject({
      urlMode: 'production_unconfigured',
      qrReady: false,
      baseUrl: null,
      configurationError: expect.stringContaining('Missing PUBLIC_APP_URL'),
      canConfigureDevUrl: false,
    });

    // resolveSafeAppBaseUrl also refuses Host-header derivation in production when PUBLIC_APP_URL is unset
    expect(() =>
      resolveSafeAppBaseUrl(prodNoSandboxReq, {
        NODE_ENV: 'production',
        E2B_SANDBOX_ID: 'iz5fdtoqamrkd8a88xl53',
      })
    ).toThrow(/PUBLIC_APP_URL/);

    // Preview sandbox in production without PUBLIC_APP_URL -> surfaces exact error without encoding *.e2b.app
    const previewCtx = resolveGuestQrUrlContext(spoofedReq, {
      NODE_ENV: 'production',
      STAYCRAFT_DB_ROLE: 'preview',
      E2B_SANDBOX_ID: 'iz5fdtoqamrkd8a88xl53',
    });
    expect(previewCtx.urlMode).toBe('preview_unconfigured');
    expect(previewCtx.qrReady).toBe(false);
    expect(previewCtx.baseUrl).toBeNull();
    expect(previewCtx.configurationError).toContain('Missing PUBLIC_APP_URL');

    // Local development without PUBLIC_APP_URL -> surfaces exact error (never encodes localhost or sandbox URL)
    const devMissingCtx = resolveGuestQrUrlContext(
      makeMockRequest({ host: 'localhost:3000' }, false),
      {
        NODE_ENV: 'development',
        E2B_SANDBOX_ID: 'iz5fdtoqamrkd8a88xl53',
      }
    );
    expect(devMissingCtx).toMatchObject({
      urlMode: 'dev_unconfigured',
      qrReady: false,
      baseUrl: null,
      configurationError: expect.stringContaining('Missing PUBLIC_APP_URL'),
      canConfigureDevUrl: true,
    });

    // Invalid PUBLIC_APP_URL -> surfaces exact validation error in configurationError
    const invalidSandboxCtx = resolveGuestQrUrlContext(spoofedReq, {
      NODE_ENV: 'development',
      PUBLIC_APP_URL: 'https://3000-sandbox123.e2b.app',
    });
    expect(invalidSandboxCtx).toMatchObject({
      urlMode: 'invalid_config',
      qrReady: false,
      baseUrl: null,
      configurationError: expect.stringContaining('Invalid PUBLIC_APP_URL'),
    });
  });

  it('produces one canonical property-scoped HTTPS QR destination and matching SVG per hotel when PUBLIC_APP_URL is configured', async () => {
    const prodCtx = resolveGuestQrUrlContext(
      makeMockRequest({ 'x-forwarded-host': '3000-sandbox.e2b.app' }, true),
      {
        NODE_ENV: 'production',
        PUBLIC_APP_URL: 'https://dining.kashiheritage.example/',
      }
    );

    const [cfgA, cfgB] = await Promise.all([
      getPropertyQrFoodConfig(PROP_A_ID, prodCtx),
      getPropertyQrFoodConfig(PROP_B_ID, prodCtx),
    ]);

    const expectedUrlA = `https://dining.kashiheritage.example/guest/menu/${PROP_A_INITIAL_TOKEN}`;
    const expectedUrlB = `https://dining.kashiheritage.example/guest/menu/${PROP_B_INITIAL_TOKEN}`;

    expect(cfgA.propertyId).toBe(PROP_A_ID);
    expect(cfgA.propertyCode).toBe('KHB');
    expect(cfgA.qrToken).toBe(PROP_A_INITIAL_TOKEN);
    expect(cfgA.guestMenuPath).toBe(`/guest/menu/${PROP_A_INITIAL_TOKEN}`);
    expect(cfgA.guestMenuUrl).toBe(expectedUrlA);
    expect(cfgA.qrReady).toBe(true);
    expect(cfgA.urlMode).toBe('production');

    expect(cfgB.propertyId).toBe(PROP_B_ID);
    expect(cfgB.propertyCode).toBe('EHS');
    expect(cfgB.guestMenuUrl).toBe(expectedUrlB);
    expect(cfgB.guestMenuUrl).not.toBe(cfgA.guestMenuUrl);

    const expectedSvgA = await QRCode.toString(expectedUrlA, {
      type: 'svg',
      margin: 2,
      width: 280,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    expect(cfgA.qrSvg).toBe(expectedSvgA);
  });

  it('enforces admin RBAC, blocks public orders when paused, and invalidates previous QR link upon rotation (mocked store)', async () => {
    const prodCtx = resolveGuestQrUrlContext(makeMockRequest(), {
      NODE_ENV: 'production',
      PUBLIC_APP_URL: 'https://dining.kashiheritage.example',
    });

    // Receptionist cannot pause or rotate
    await expect(
      updatePropertyQrFoodConfig(
        propASummary,
        receptionistActor,
        { enabled: false },
        prodCtx
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      regeneratePropertyQrFoodToken(propASummary, receptionistActor, prodCtx)
    ).rejects.toMatchObject({ statusCode: 403 });

    // Admin pauses QR ordering -> public menu & public order submission fail with 403
    const pausedCfg = await updatePropertyQrFoodConfig(
      propASummary,
      adminActor,
      { enabled: false },
      prodCtx
    );
    expect(pausedCfg.enabled).toBe(false);

    await expect(
      getPublicGuestMenuByQrToken(PROP_A_INITIAL_TOKEN)
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      createPublicGuestFoodOrder(PROP_A_INITIAL_TOKEN, {
        roomNumber: '101',
        items: [{ menuItemId: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    // Re-enable, then rotate QR token -> old token immediately fails with 404, new token loads Property A only
    await updatePropertyQrFoodConfig(
      propASummary,
      adminActor,
      { enabled: true },
      prodCtx
    );
    const rotatedCfg = await regeneratePropertyQrFoodToken(
      propASummary,
      adminActor,
      prodCtx
    );
    expect(rotatedCfg.qrToken).toMatch(/^[a-f0-9]{32}$/);
    expect(rotatedCfg.qrToken).not.toBe(PROP_A_INITIAL_TOKEN);
    expect(rotatedCfg.guestMenuUrl).toBe(
      `https://dining.kashiheritage.example/guest/menu/${rotatedCfg.qrToken}`
    );

    await expect(
      getPublicGuestMenuByQrToken(PROP_A_INITIAL_TOKEN)
    ).rejects.toMatchObject({ statusCode: 404 });

    const activeMenu = await getPublicGuestMenuByQrToken(rotatedCfg.qrToken);
    expect(activeMenu.hotel.code).toBe('KHB');
    expect(mockStore.auditEvents.map((e) => e.action)).toEqual([
      'guest_qr_updated',
      'guest_qr_updated',
      'guest_qr_regenerated',
    ]);
  });

  it('protects internal PMS API routes with 401 while keeping public guest menu accessible without PMS login', async () => {
    const app = createApiApp();

    const publicMenuRes = await supertest(app).get(
      `/api/public/guest-food/menu/${PROP_A_INITIAL_TOKEN}`
    );
    expect(publicMenuRes.status).toBe(200);
    expect(publicMenuRes.body.hotel.code).toBe('KHB');

    for (const protectedEndpoint of [
      '/api/dashboard',
      '/api/reservations',
      '/api/restaurant/orders',
      '/api/restaurant/qr-config',
      '/api/invoices',
      '/api/users',
    ]) {
      const res = await supertest(app).get(protectedEndpoint);
      expect(res.status, `Expected ${protectedEndpoint} to require auth`).toBe(
        401
      );
    }
  });

  it('renders a scannable Local Wi-Fi / LAN QR SVG in GuestQrConfigModal with exact Open Guest Menu, Copy, Download SVG, and Print parity (zero DB writes)', async () => {
    const chromiumPath = ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
      (p) => fs.existsSync(p)
    );
    const distClient = path.resolve(process.cwd(), 'dist/client');
    if (!chromiumPath || !fs.existsSync(path.join(distClient, 'index.html'))) {
      return;
    }

    const zbarPath = ['/usr/bin/zbarimg', '/usr/local/bin/zbarimg'].find((p) =>
      fs.existsSync(p)
    );
    const configuredLanBase = 'http://192.168.1.10:3000';
    const expectedLanGuestUrl = `${configuredLanBase}/guest/menu/3341cf7e5b0c77a2539798b97aff873e`;
    let activeDevBaseUrl = '';

    const uiApp = express();
    uiApp.use(express.json());
    uiApp.get('/api/auth/me', (_req, res) => {
      res.json({
        user: adminActor,
        properties: [
          {
            id: PROP_A_ID,
            code: 'KHB',
            name: 'Kashi Heritage Boutique Hotel',
            email: 'info@kashi.local',
            phone: '+91 542 250 8800',
            addressLine1: '12 Ghat Road',
            addressLine2: '',
            city: 'Varanasi',
            stateProvince: 'UP',
            postalCode: '221001',
            country: 'India',
            timezone: 'Asia/Kolkata',
            currency: 'INR',
            defaultCheckInTime: '14:00',
            defaultCheckOutTime: '11:00',
            defaultTaxRate: 12,
            taxName: 'GST',
            invoiceSettings: {
              prefix: 'KHB-INV',
              nextNumber: 1001,
              taxId: '',
              footerNote: '',
            },
            isActive: true,
            createdAt: '2026-10-26T00:00:00.000Z',
            updatedAt: '2026-10-26T00:00:00.000Z',
          },
        ],
        defaultPropertyId: PROP_A_ID,
      });
    });
    uiApp.get('/api/dashboard/notifications', (_req, res) => {
      res.json({ items: [], totalCount: 0 });
    });
    uiApp.get('/api/restaurant/categories', (_req, res) => {
      res.json({ items: [] });
    });
    uiApp.get('/api/restaurant/menu-items', (_req, res) => {
      res.json({ items: [] });
    });
    uiApp.get('/api/restaurant/eligible-stays', (_req, res) => {
      res.json({ items: [] });
    });
    uiApp.get('/api/restaurant/orders', (_req, res) => {
      res.json({
        items: [],
        pagination: { page: 1, pageSize: 30, totalCount: 0, totalPages: 1 },
        summary: {
          pendingCount: 0,
          preparingCount: 0,
          readyCount: 0,
          servedTodayCount: 0,
          unbilledRoomServiceCount: 0,
          todayFoodRevenue: 0,
        },
      });
    });
    uiApp.get('/api/restaurant/qr-config', async (req, res, next) => {
      try {
        const ctx = resolveGuestQrUrlContext(req, {
          NODE_ENV: 'development',
          PUBLIC_APP_URL: activeDevBaseUrl,
        });
        const cfg = await getPropertyQrFoodConfig(PROP_A_ID, ctx);
        res.json({ config: cfg });
      } catch (err) {
        next(err);
      }
    });
    uiApp.put('/api/restaurant/qr-config/dev-base-url', async (req, res) => {
      const candidate = String(req.body?.publicAppUrl ?? '').trim();
      if (candidate) {
        try {
          const validated = resolveConfiguredAppUrl({
            NODE_ENV: 'development',
            PUBLIC_APP_URL: candidate,
          });
          activeDevBaseUrl = validated?.origin ?? '';
        } catch (err) {
          res.status(400).json({
            error: {
              code: 'BAD_REQUEST',
              message: (err as Error).message,
            },
          });
          return;
        }
      } else {
        activeDevBaseUrl = '';
      }
      const ctx = resolveGuestQrUrlContext(req, {
        NODE_ENV: 'development',
        PUBLIC_APP_URL: activeDevBaseUrl,
      });
      const cfg = await getPropertyQrFoodConfig(PROP_A_ID, ctx);
      res.json({ config: cfg });
    });
    uiApp.use(express.static(distClient));
    uiApp.get('*', (_req, res) => {
      res.sendFile(path.join(distClient, 'index.html'));
    });

    const server = http.createServer(uiApp);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    const port = (server.address() as { port: number }).port;
    const localUiOrigin = `http://127.0.0.1:${port}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staycraft-lan-qr-'));

    const browser = await chromium.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        acceptDownloads: true,
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      const page = await context.newPage();

      await page.goto(`${localUiOrigin}/restaurant`, {
        waitUntil: 'networkidle',
      });
      await page.getByTestId('open-hotel-qr-modal-btn').click();
      await page
        .getByTestId('guest-qr-config-modal')
        .waitFor({ state: 'visible', timeout: 10_000 });

      // 1. Missing PUBLIC_APP_URL -> shows exact configuration error (never "Phone QR Code Withheld")
      await page
        .getByTestId('hotel-qr-config-error-alert')
        .waitFor({ state: 'visible', timeout: 5_000 });
      expect(
        await page.getByTestId('hotel-qr-config-error-alert').textContent()
      ).toContain('Missing PUBLIC_APP_URL');
      expect(await page.getByTestId('guest-qr-config-modal').textContent()).not.toContain(
        'Phone QR Code Withheld'
      );
      expect(await page.getByTestId('hotel-qr-route-path').textContent()).toBe(
        '/guest/menu/3341cf7e5b0c77a2539798b97aff873e'
      );

      // 2. Invalid Arena sandbox URL -> shows exact validation error without generating QR
      await page
        .getByTestId('hotel-qr-dev-url-input')
        .fill('https://3000-sandbox123.e2b.app');
      await page.getByTestId('hotel-qr-dev-url-apply-btn').click();
      await page
        .getByTestId('hotel-qr-action-error')
        .waitFor({ state: 'visible', timeout: 5_000 });
      expect(
        await page.getByTestId('hotel-qr-action-error').textContent()
      ).toContain('Invalid PUBLIC_APP_URL');
      expect(await page.getByTestId('hotel-qr-svg-img').count()).toBe(0);

      // 3. Valid laptop Wi-Fi LAN URL -> visibly renders QR SVG image on page
      await page
        .getByTestId('hotel-qr-dev-url-input')
        .fill(configuredLanBase);
      await page.getByTestId('hotel-qr-dev-url-apply-btn').click();

      await page
        .getByTestId('hotel-qr-svg-img')
        .waitFor({ state: 'visible', timeout: 5_000 });
      expect(
        await page.getByTestId('hotel-qr-unconfigured-placeholder').count()
      ).toBe(0);

      const imgDims = await page
        .getByTestId('hotel-qr-svg-img')
        .evaluate((el) => {
          const img = el as HTMLImageElement;
          return {
            complete: img.complete,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
          };
        });
      expect(imgDims.complete).toBe(true);
      expect(imgDims.naturalWidth).toBeGreaterThan(0);
      expect(imgDims.naturalHeight).toBeGreaterThan(0);

      expect(
        await page.getByTestId('hotel-qr-url-env').getAttribute('data-url-kind')
      ).toBe('local_lan');

      // Displayed URL, Copy action, Open Guest Menu link, Download SVG, and Print all match exact LAN URL
      expect(await page.getByTestId('hotel-qr-menu-url').inputValue()).toBe(
        expectedLanGuestUrl
      );
      expect(
        await page
          .getByTestId('hotel-qr-open-preview-link')
          .getAttribute('href')
      ).toBe(expectedLanGuestUrl);

      await page.getByRole('button', { name: 'Copy' }).click();
      const copiedText = await page.evaluate(() =>
        navigator.clipboard.readText()
      );
      expect(copiedText).toBe(expectedLanGuestUrl);

      // Verify Print button invokes window.print()
      await page.evaluate(() => {
        (window as unknown as { __printCalls?: number }).__printCalls = 0;
        window.print = () => {
          (window as unknown as { __printCalls: number }).__printCalls += 1;
        };
      });
      await page.getByRole('button', { name: 'Print' }).click();
      const printCalls = await page.evaluate(
        () => (window as unknown as { __printCalls?: number }).__printCalls ?? 0
      );
      expect(printCalls).toBe(1);

      if (zbarPath) {
        const modalPng = path.join(tmpDir, 'lan-modal-qr.png');
        await page.getByTestId('hotel-qr-svg-img').screenshot({ path: modalPng });
        const decodedModalQr = execFileSync(
          zbarPath,
          ['--quiet', '--raw', modalPng],
          { encoding: 'utf8' }
        ).trim();
        expect(decodedModalQr).toBe(expectedLanGuestUrl);

        // Downloaded SVG also optically scans to exact LAN URL
        const dlPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download SVG' }).click();
        const dl = await dlPromise;
        const svgPath = path.join(tmpDir, 'lan-downloaded.svg');
        await dl.saveAs(svgPath);
        const svgContent = fs.readFileSync(svgPath, 'utf8');
        const svgPage = await context.newPage();
        await svgPage.setContent(
          `<html><body style="margin:24px;background:#fff">${svgContent}</body></html>`
        );
        const dlPng = path.join(tmpDir, 'lan-downloaded.png');
        await svgPage.locator('svg').screenshot({ path: dlPng });
        const decodedDlQr = execFileSync(zbarPath, ['--quiet', '--raw', dlPng], {
          encoding: 'utf8',
        }).trim();
        expect(decodedDlQr).toBe(expectedLanGuestUrl);
        await svgPage.close();

        // Printed card (@media print) also optically scans to exact LAN URL
        await page.emulateMedia({ media: 'print' });
        await page
          .getByTestId('hotel-qr-print-card')
          .waitFor({ state: 'visible', timeout: 5_000 });
        expect(
          (await page.getByTestId('hotel-qr-print-url').textContent())?.trim()
        ).toBe(expectedLanGuestUrl);
        const printPng = path.join(tmpDir, 'lan-print.png');
        await page
          .getByTestId('hotel-qr-print-svg-img')
          .screenshot({ path: printPng });
        const decodedPrintQr = execFileSync(
          zbarPath,
          ['--quiet', '--raw', printPng],
          { encoding: 'utf8' }
        ).trim();
        expect(decodedPrintQr).toBe(expectedLanGuestUrl);
      }
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
