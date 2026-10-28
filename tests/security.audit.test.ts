import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, getPropertyLocalDate } from '../src/shared/dates.js';
import { sanitizeInternalRedirectPath } from '../src/shared/navigation.js';
import { createApiApp } from '../src/server/app.js';
import {
  redactConnectionStrings,
  sanitizeErrorForLog,
} from '../src/server/config.js';
import {
  assertAdminTargetAuthorized,
  ensureInitialAdminAccount,
} from '../src/server/db/ensure-admin.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { closePool, getPool } from '../src/server/db/pool.js';
import { errorHandler } from '../src/server/middleware/errorHandler.js';
import { resetLoginRateLimiter } from '../src/server/modules/auth/auth.routes.js';
import { hashPassword } from '../src/server/security/password.js';
import { verifyTestDatabaseIdentity } from './setup-db-guard.js';

const app = createApiApp();

let propAlphaId = '';
let propBetaId = '';
let roomAlphaId = '';
let roomBetaId = '';
let roomTypeAlphaId = '';
let guestAlphaId = '';
let guestBetaId = '';
let reservationAlphaId = '';
let reservationBetaId = '';
let invoiceBetaId = '';

let adminToken = '';
let adminCookie = '';
let alphaRecToken = '';
let alphaRecEmail = '';
let adminEmail = '';

beforeAll(async () => {
  await verifyTestDatabaseIdentity();
  await runMigrations();

  const pool = getPool();
  const suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(
    Math.random() * 90 + 10
  )}`.toUpperCase();

  adminEmail = `sec.admin.${suffix.toLowerCase()}@synthetic.test`;
  alphaRecEmail = `sec.rec.${suffix.toLowerCase()}@synthetic.test`;

  const [adminHash, recHash] = await Promise.all([
    hashPassword('SyntheticAdmin#2026!'),
    hashPassword('SyntheticRec#2026!'),
  ]);

  const uAdmin = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, phone)
     VALUES ($1, $2, 'Synthetic Audit Admin', 'admin', '+1 555 010 0001')
     RETURNING id`,
    [adminEmail, adminHash]
  );

  const uRec = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, phone)
     VALUES ($1, $2, 'Synthetic Alpha Receptionist', 'receptionist', '+1 555 010 0002')
     RETURNING id`,
    [alphaRecEmail, recHash]
  );

  const pAlpha = await pool.query<{ id: string }>(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name
     ) VALUES (
       $1, $2, 'alpha@synthetic.test', '+1 555 010 1001', '100 Harbor Way', 'Synthetic City', 'Testland',
       'Asia/Kolkata', 'INR', 12.00, 'GST'
     ) RETURNING id`,
    [`SA${suffix.slice(0, 6)}`, `Synthetic Alpha Hotel ${suffix}`]
  );
  propAlphaId = pAlpha.rows[0].id;

  const pBeta = await pool.query<{ id: string }>(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name
     ) VALUES (
       $1, $2, 'beta@synthetic.test', '+1 555 010 2002', '200 Summit Ave', 'Synthetic Ridge', 'Testland',
       'Asia/Kolkata', 'INR', 18.00, 'GST'
     ) RETURNING id`,
    [`SB${suffix.slice(0, 6)}`, `Synthetic Beta Suites ${suffix}`]
  );
  propBetaId = pBeta.rows[0].id;

  // Admin has access to both; Receptionist ONLY has access to Alpha
  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id, is_default)
     VALUES ($1, $3, TRUE), ($1, $4, FALSE), ($2, $3, TRUE)`,
    [uAdmin.rows[0].id, uRec.rows[0].id, propAlphaId, propBetaId]
  );

  const rtAlpha = await pool.query<{ id: string }>(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'DLX', 'Synthetic Deluxe', 2, 3, 4200) RETURNING id`,
    [propAlphaId]
  );
  roomTypeAlphaId = rtAlpha.rows[0].id;

  const rtBeta = await pool.query<{ id: string }>(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'STE', 'Synthetic Suite', 2, 4, 6800) RETURNING id`,
    [propBetaId]
  );

  const rmAlpha = await pool.query<{ id: string }>(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, 'A101', '1', 'available', 'inspected') RETURNING id`,
    [propAlphaId, roomTypeAlphaId]
  );
  roomAlphaId = rmAlpha.rows[0].id;

  const rmBeta = await pool.query<{ id: string }>(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, 'B201', '2', 'available', 'inspected') RETURNING id`,
    [propBetaId, rtBeta.rows[0].id]
  );
  roomBetaId = rmBeta.rows[0].id;

  const gAlpha = await pool.query<{ id: string }>(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'SynthAlpha', 'GuestOne', 'g1@synthetic.test', '+1 555 011 0001') RETURNING id`,
    [propAlphaId]
  );
  guestAlphaId = gAlpha.rows[0].id;

  const gBeta = await pool.query<{ id: string }>(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'SynthBeta', 'GuestTwo', 'g2@synthetic.test', '+1 555 011 0002') RETURNING id`,
    [propBetaId]
  );
  guestBetaId = gBeta.rows[0].id;

  resetLoginRateLimiter();

  const adminLogin = await request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-Proto', 'https')
    .send({ email: adminEmail, password: 'SyntheticAdmin#2026!' })
    .expect(200);
  adminToken = adminLogin.body.sessionToken;
  adminCookie = (adminLogin.headers['set-cookie']?.[0] ?? '').split(';')[0];

  const recLogin = await request(app)
    .post('/api/auth/login')
    .send({ email: alphaRecEmail, password: 'SyntheticRec#2026!' })
    .expect(200);
  alphaRecToken = recLogin.body.sessionToken;

  const today = getPropertyLocalDate('Asia/Kolkata');

  const resAlpha = await request(app)
    .post('/api/reservations')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Property-Id', propAlphaId)
    .send({
      guestId: guestAlphaId,
      roomId: roomAlphaId,
      arrivalDate: today,
      departureDate: addDays(today, 2),
      adults: 2,
      nightlyRate: 4200,
      status: 'confirmed',
      source: 'direct',
    })
    .expect(201);
  reservationAlphaId = resAlpha.body.reservation.id;

  const resBeta = await request(app)
    .post('/api/reservations')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Property-Id', propBetaId)
    .send({
      guestId: guestBetaId,
      roomId: roomBetaId,
      arrivalDate: today,
      departureDate: addDays(today, 2),
      adults: 2,
      nightlyRate: 6800,
      status: 'confirmed',
      source: 'direct',
    })
    .expect(201);
  reservationBetaId = resBeta.body.reservation.id;

  const invBeta = await request(app)
    .post(`/api/invoices/from-reservation/${reservationBetaId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Property-Id', propBetaId)
    .send({})
    .expect(201);
  invoiceBetaId = invBeta.body.invoice.id;
});

afterEach(() => {
  resetLoginRateLimiter();
});

afterAll(async () => {
  await closePool();
});

describe('Security Audit Regression Suite (Isolated staycraft_pms_test + Synthetic Data Only)', () => {
  it('1. Fail-closed per-test DB guard rejects missing, production, or preview database identities', async () => {
    const makeMockDb = (dbName: string | null): Pick<pg.Pool, 'query'> => ({
      query: (async () => ({
        rows: dbName === null ? [] : [{ db: dbName }],
        rowCount: dbName === null ? 0 : 1,
      })) as unknown as pg.Pool['query'],
    });

    await expect(
      verifyTestDatabaseIdentity(makeMockDb(null), {
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/staycraft_pms_test',
      })
    ).rejects.toThrowError(/FAIL-CLOSED TEST GUARD/);

    await expect(
      verifyTestDatabaseIdentity(makeMockDb('staycraft_pms'), {
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/staycraft_pms_test',
      })
    ).rejects.toThrowError(/Expected current_database\(\) === "staycraft_pms_test"/);

    await expect(
      verifyTestDatabaseIdentity(makeMockDb('staycraft_pms_preview'), {
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/staycraft_pms_test',
      })
    ).rejects.toThrowError(/Expected current_database\(\) === "staycraft_pms_test"/);

    await expect(
      verifyTestDatabaseIdentity(makeMockDb('staycraft_pms_test'), {
        NODE_ENV: 'production',
        TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/staycraft_pms_test',
      })
    ).rejects.toThrowError(/Expected NODE_ENV="test"/);

    await expect(
      verifyTestDatabaseIdentity(makeMockDb('staycraft_pms_test'), {
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/staycraft_pms_test',
      })
    ).resolves.toBe('staycraft_pms_test');
  });

  it('2. Blocks CSRF attacks across Origin, Referer, Sec-Fetch-Site, form Content-Type, and /api/rpc while preserving Arena preview', async () => {
    // Untrusted external Origin with valid session cookie -> 403 CSRF_REJECTED
    const csrfCheckIn = await request(app)
      .post(`/api/reservations/${reservationAlphaId}/check-in?propertyId=${propAlphaId}`)
      .set('Cookie', adminCookie)
      .set('Origin', 'https://evil-attacker.example')
      .send({});
    expect(csrfCheckIn.status).toBe(403);
    expect(csrfCheckIn.body.error.code).toBe('CSRF_REJECTED');

    // Sandboxed null Origin CSRF -> 403 CSRF_REJECTED
    const nullOriginLogout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', adminCookie)
      .set('Origin', 'null');
    expect(nullOriginLogout.status).toBe(403);
    expect(nullOriginLogout.body.error.code).toBe('CSRF_REJECTED');

    // Untrusted Referer when Origin is stripped -> 403 CSRF_REJECTED
    const refererCsrf = await request(app)
      .post(`/api/invoices/${invoiceBetaId}/issue?propertyId=${propBetaId}`)
      .set('Cookie', adminCookie)
      .set('Referer', 'https://evil-attacker.example/auto-submit.html');
    expect(refererCsrf.status).toBe(403);
    expect(refererCsrf.body.error.code).toBe('CSRF_REJECTED');

    // Fetch Metadata cross-site without trusted Origin -> 403 CSRF_REJECTED
    const secFetchCsrf = await request(app)
      .post(`/api/reservations/${reservationAlphaId}/cancel?propertyId=${propAlphaId}`)
      .set('Cookie', adminCookie)
      .set('Sec-Fetch-Site', 'cross-site');
    expect(secFetchCsrf.status).toBe(403);
    expect(secFetchCsrf.body.error.code).toBe('CSRF_REJECTED');

    // Simple HTML form Content-Type with referrer stripped -> 403 CSRF_REJECTED
    const formCsrf = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', adminCookie)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('confirm=1');
    expect(formCsrf.status).toBe(403);
    expect(formCsrf.body.error.code).toBe('CSRF_REJECTED');

    // POST /api/rpc cross-site cookie CSRF -> 403 CSRF_REJECTED
    const rpcCsrf = await request(app)
      .post('/api/rpc')
      .set('Cookie', adminCookie)
      .set('Origin', 'https://evil-attacker.example')
      .send({
        method: 'POST',
        path: `/api/reservations/${reservationAlphaId}/cancel`,
        propertyId: propAlphaId,
      });
    expect(rpcCsrf.status).toBe(403);
    expect(rpcCsrf.body.error.code).toBe('CSRF_REJECTED');

    // Verify admin session was NOT logged out and reservationAlpha remains 'confirmed'
    const resDetail = await request(app)
      .get(`/api/reservations/${reservationAlphaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propAlphaId)
      .expect(200);
    expect(resDetail.body.reservation.status).toBe('confirmed');

    // Legitimate Arena preview parent origin & same-host e2b preview origin are allowed
    const arenaOriginReq = await request(app)
      .post('/api/rpc')
      .set('Host', '3000-my-sandbox.e2b.app')
      .set('Origin', 'https://arena.ai')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({
        method: 'GET',
        path: '/api/auth/me',
        sessionToken: adminToken,
      })
      .expect(200);
    expect(arenaOriginReq.body.user.email).toBe(adminEmail);
  });

  it('3. Blocks cross-sandbox *.e2b.app credentialed CORS while enforcing security headers and Cache-Control: no-store', async () => {
    // Different tenant's E2B sandbox MUST NOT receive Access-Control-Allow-Origin or Credentials
    const crossSandboxPreflight = await request(app)
      .options('/api/auth/me')
      .set('Host', '3000-victim-sandbox.e2b.app')
      .set('Origin', 'https://3000-attacker-sandbox.e2b.app')
      .expect(204);
    expect(crossSandboxPreflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(crossSandboxPreflight.headers['access-control-allow-credentials']).toBeUndefined();

    // Cross-sandbox state-changing request is blocked as CSRF
    const crossSandboxPost = await request(app)
      .post('/api/auth/logout')
      .set('Host', '3000-victim-sandbox.e2b.app')
      .set('Origin', 'https://3000-attacker-sandbox.e2b.app')
      .set('Cookie', adminCookie);
    expect(crossSandboxPost.status).toBe(403);
    expect(crossSandboxPost.body.error.code).toBe('CSRF_REJECTED');

    // Same-host E2B sandbox origin IS granted CORS headers cleanly
    const sameHostMe = await request(app)
      .get('/api/auth/me')
      .set('Host', '3000-victim-sandbox.e2b.app')
      .set('Origin', 'https://3000-victim-sandbox.e2b.app')
      .set('Cookie', adminCookie)
      .expect(200);

    expect(sameHostMe.headers['access-control-allow-origin']).toBe(
      'https://3000-victim-sandbox.e2b.app'
    );
    expect(sameHostMe.headers['x-powered-by']).toBeUndefined();
    expect(sameHostMe.headers['x-content-type-options']).toBe('nosniff');
    expect(sameHostMe.headers['referrer-policy']).toBe(
      'strict-origin-when-cross-origin'
    );
    expect(sameHostMe.headers['permissions-policy']).toContain('camera=()');
    expect(sameHostMe.headers['x-permitted-cross-domain-policies']).toBe('none');
    expect(sameHostMe.headers['cache-control']).toContain('no-store');
  });

  it('4. Enforces login password max-length cap, brute-force rate limiting (429), and zero secret leakage in API payloads', async () => {
    // 1. Oversized password rejected at validation boundary (400) before scrypt
    const longPassword = 'A'.repeat(400);
    const oversizedLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: adminEmail, password: longPassword });
    expect(oversizedLogin.status).toBe(400);
    expect(oversizedLogin.body.error.code).toBe('VALIDATION_ERROR');

    // 2. 10 failed login attempts trigger 429 RATE_LIMITED with Retry-After on attempt 11
    const targetEmail = 'bruteforce.target@synthetic.test';
    for (let i = 0; i < 10; i++) {
      const attempt = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '203.0.113.77')
        .send({ email: targetEmail, password: `WrongGuess#${i}00` });
      expect(attempt.status).toBe(401);
    }

    const throttled = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '203.0.113.77')
      .send({ email: targetEmail, password: 'WrongGuess#1100' });
    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe('RATE_LIMITED');
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);

    // 3. Managed users endpoint never leaks password_hash or token_hash
    const usersRes = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propAlphaId)
      .expect(200);
    const serialized = JSON.stringify(usersRes.body);
    expect(serialized).not.toContain('password_hash');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('scrypt:');
    expect(serialized).not.toContain('token_hash');
  });

  it('5. Blocks production default-password fallback and cross-environment DB targets in ensureInitialAdminAccount', async () => {
    const mockProdDb: Pick<pg.Pool, 'query'> = {
      query: (async (sql: string) => {
        if (sql.includes('current_database()')) {
          return { rows: [{ db: 'staycraft_pms' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }) as unknown as pg.Pool['query'],
    };

    // Non-production runtime pointing at staycraft_pms is rejected before touching schema/users
    await expect(
      assertAdminTargetAuthorized(mockProdDb, { NODE_ENV: 'development' })
    ).rejects.toThrowError(
      /Refusing to run admin account operation against production database "staycraft_pms"/
    );

    // Test runtime pointing at staycraft_pms_preview is rejected
    const mockPreviewDb: Pick<pg.Pool, 'query'> = {
      query: (async () => ({
        rows: [{ db: 'staycraft_pms_preview' }],
        rowCount: 1,
      })) as unknown as pg.Pool['query'],
    };
    await expect(
      assertAdminTargetAuthorized(mockPreviewDb, { NODE_ENV: 'test' })
    ).rejects.toThrowError(/non-test database: "staycraft_pms_preview"/);

    // Real production mode refuses implicit default 'Admin@12345' password on creation/reset
    const mockIsolatedProdPool = {
      query: (async (sql: string) => {
        if (sql.includes('current_database()')) {
          return { rows: [{ db: 'staycraft_cloud_prod' }], rowCount: 1 };
        }
        if (sql.includes('current_schema()')) {
          return { rows: [{ schema_name: 'public' }], rowCount: 1 };
        }
        if (sql.includes('unnest(')) {
          return {
            rows: [
              { table_name: 'users', present: true },
              { table_name: 'user_sessions', present: true },
              { table_name: 'properties', present: true },
              { table_name: 'user_property_access', present: true },
            ],
            rowCount: 4,
          };
        }
        return { rows: [], rowCount: 0 };
      }) as unknown as pg.Pool['query'],
      connect: (async () => ({
        query: async (sql: string) => {
          if (sql.includes('FROM users')) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      })) as unknown as pg.Pool['connect'],
    } as unknown as pg.Pool;

    await expect(
      ensureInitialAdminAccount({
        pool: mockIsolatedProdPool,
        env: { NODE_ENV: 'production' },
        email: 'prod.admin@synthetic.test',
      })
    ).rejects.toThrowError(
      /Refusing to provision or reset production administrator account with default or weak password/
    );
  });

  it('6. Neutralizes SQL injection payloads, numeric query overflows, malformed JSON, and oversized Zod collections (GHSA-mrhx-c7xc-m3w5)', async () => {
    const sqli = `' OR 1=1; DROP TABLE guests; --`;

    const guestsSqli = await request(app)
      .get(`/api/guests?search=${encodeURIComponent(sqli)}`)
      .set('Authorization', `Bearer ${alphaRecToken}`)
      .set('X-Property-Id', propAlphaId)
      .expect(200);
    expect(guestsSqli.body.items).toEqual([]);

    const resSortSqli = await request(app)
      .get(
        `/api/reservations?sortBy=${encodeURIComponent('arrival_date; DROP TABLE users;--')}&search=${encodeURIComponent(sqli)}`
      )
      .set('Authorization', `Bearer ${alphaRecToken}`)
      .set('X-Property-Id', propAlphaId)
      .expect(200);
    expect(resSortSqli.body.items).toEqual([]);

    // NaN / negative / bigint-overflow query params return 400 VALIDATION_ERROR (never 500)
    for (const url of [
      '/api/guests?page=abc',
      '/api/guests?page=99999999999999999999999999',
      '/api/reservations?pageSize=0',
      '/api/reservations?page=Infinity',
      '/api/invoices?page=-5',
      '/api/rooms?minCapacity=999999999999999999',
    ]) {
      const badQuery = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${alphaRecToken}`)
        .set('X-Property-Id', propAlphaId);
      expect(badQuery.status).toBe(400);
      expect(['BAD_REQUEST', 'VALIDATION_ERROR']).toContain(
        badQuery.body.error.code
      );
    }

    // Malformed JSON returns 400 VALIDATION_ERROR (never 500)
    const malformedJson = await request(app)
      .post('/api/guests')
      .set('Authorization', `Bearer ${alphaRecToken}`)
      .set('X-Property-Id', propAlphaId)
      .set('Content-Type', 'application/json')
      .send('{"firstName": "Broken"');
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.body.error.code).toBe('VALIDATION_ERROR');

    // Oversized array (>200 items) blocked by pre-Zod structural guard (GHSA-mrhx-c7xc-m3w5 mitigation)
    const hugeCollection = await request(app)
      .post('/api/room-types')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propAlphaId)
      .send({
        code: 'BIG',
        name: 'Oversized Amenities',
        baseCapacity: 2,
        maxCapacity: 2,
        baseRate: 3000,
        amenities: Array.from({ length: 250 }, (_, idx) => `item-${idx}`),
      });
    expect(hugeCollection.status).toBe(400);
    expect(['BAD_REQUEST', 'VALIDATION_ERROR']).toContain(
      hugeCollection.body.error.code
    );
    expect(hugeCollection.body.error.message).toMatch(/maximum allowed length/i);
  });

  it('7. Neutralizes backslash and external open-redirect vectors (GHSA-wrjc-x8rr-h8h6)', () => {
    expect(sanitizeInternalRedirectPath('/\\evil.example')).toBe('/');
    expect(sanitizeInternalRedirectPath('/\\\\evil.example/phish')).toBe('/');
    expect(sanitizeInternalRedirectPath('//evil.example')).toBe('/');
    expect(sanitizeInternalRedirectPath('https://evil.example/dashboard')).toBe('/');
    expect(sanitizeInternalRedirectPath('/\t/evil.example')).toBe('/');
    expect(sanitizeInternalRedirectPath('/login')).toBe('/');
    expect(sanitizeInternalRedirectPath('/login?next=/rooms')).toBe('/');
    expect(sanitizeInternalRedirectPath(null)).toBe('/');
    expect(sanitizeInternalRedirectPath('/reservations?quickFilter=in_house')).toBe(
      '/reservations?quickFilter=in_house'
    );
    expect(sanitizeInternalRedirectPath('/staff')).toBe('/staff');
  });

  it('8. Enforces RBAC, cross-property isolation, IDOR rejection, and filterPropertyId user scoping', async () => {
    // Receptionist denied on Admin endpoints (403)
    for (const [method, path, body] of [
      ['post', '/api/rooms', { roomTypeId: roomTypeAlphaId, roomNumber: 'X99', floor: '9' }],
      ['post', '/api/users', { email: 'x@synthetic.test', password: 'Password#123', fullName: 'X', role: 'receptionist' }],
      ['post', '/api/staff', { fullName: 'Staff X', department: 'front_office', jobTitle: 'Agent' }],
      ['post', '/api/inventory/adjustments', {}],
    ] as const) {
      const agent = request(app) as Record<string, any>;
      const denied = await agent[method](path)
        .set('Authorization', `Bearer ${alphaRecToken}`)
        .set('X-Property-Id', propAlphaId)
        .send(body);
      expect(denied.status).toBe(403);
    }

    // Receptionist scoped to Alpha denied from Beta property context (403 PROPERTY_ACCESS_DENIED)
    const crossPropDenied = await request(app)
      .get('/api/guests')
      .set('Authorization', `Bearer ${alphaRecToken}`)
      .set('X-Property-Id', propBetaId);
    expect(crossPropDenied.status).toBe(403);
    expect(crossPropDenied.body.error.code).toBe('FORBIDDEN');

    // IDOR: Admin operating in Alpha context cannot read or mutate Beta's guest, reservation, or invoice
    await request(app)
      .get(`/api/guests/${guestBetaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propAlphaId)
      .expect(404);

    await request(app)
      .get(`/api/reservations/${reservationBetaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propAlphaId)
      .expect(404);

    await request(app)
      .post(`/api/invoices/${invoiceBetaId}/issue`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propAlphaId)
      .expect(404);

    // Cross-property FK injection: cannot book Alpha room for Beta guest
    const crossFkBooking = await request(app)
      .post('/api/reservations')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propAlphaId)
      .send({
        guestId: guestBetaId,
        roomId: roomAlphaId,
        arrivalDate: addDays(getPropertyLocalDate('Asia/Kolkata'), 10),
        departureDate: addDays(getPropertyLocalDate('Asia/Kolkata'), 12),
        adults: 1,
        nightlyRate: 4200,
        status: 'confirmed',
        source: 'direct',
      });
    expect([400, 404]).toContain(crossFkBooking.status);

    // filterPropertyId scopes /api/users strictly to Beta (excluding Alpha-only receptionist)
    const betaUsersRes = await request(app)
      .get(`/api/users?filterPropertyId=${propBetaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propBetaId)
      .expect(200);
    const betaUserEmails = betaUsersRes.body.items.map((u: { email: string }) => u.email);
    expect(betaUserEmails).toContain(adminEmail);
    expect(betaUserEmails).not.toContain(alphaRecEmail);
  });

  it('9. Redacts DB URLs, Bearer tokens, and session cookies in logs and errorHandler', () => {
    const rawMsg =
      'Connection failed to postgresql://pms_app:UltraSecretPw123@10.0.0.8:5432/staycraft_pms with Authorization: Bearer abcdef0123456789secretvalue and staycraft_session=deadbeefcafebabe00112233';
    const redacted = redactConnectionStrings(rawMsg);
    expect(redacted).not.toContain('UltraSecretPw123');
    expect(redacted).not.toContain('abcdef0123456789secretvalue');
    expect(redacted).not.toContain('deadbeefcafebabe00112233');
    expect(redacted).toContain('postgresql://[REDACTED]');
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).toContain('staycraft_session=[REDACTED]');

    const sanitizedErr = sanitizeErrorForLog(new Error(rawMsg));
    expect(sanitizedErr).not.toContain('UltraSecretPw123');
    expect(sanitizedErr).not.toContain('abcdef0123456789secretvalue');
    expect(sanitizedErr).not.toContain('deadbeefcafebabe00112233');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const fakeRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      };
      errorHandler(
        new Error(rawMsg),
        {} as any,
        fakeRes as any,
        (() => undefined) as any
      );
      expect(fakeRes.status).toHaveBeenCalledWith(500);
      const loggedStr = JSON.stringify(consoleSpy.mock.calls);
      expect(loggedStr).not.toContain('UltraSecretPw123');
      expect(loggedStr).not.toContain('abcdef0123456789secretvalue');
      expect(loggedStr).not.toContain('deadbeefcafebabe00112233');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
