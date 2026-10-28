import http from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiClientError,
  apiFetch,
  isUsingRpcTransport,
  resetApiTransportState,
  setStoredAuthUserId,
  setStoredPropertyId,
  setStoredSessionToken,
  setUnauthorizedHandler,
} from '../src/client/lib/api.js';
import { createApiApp } from '../src/server/app.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { closePool, getPool } from '../src/server/db/pool.js';
import { resetLoginRateLimiter } from '../src/server/modules/auth/auth.routes.js';
import { hashPassword } from '../src/server/security/password.js';
import type { StaffProfileRecord } from '../src/shared/types.js';
import { verifyTestDatabaseIdentity } from './setup-db-guard.js';

const app = createApiApp();

let propAlphaId = '';
let propBetaId = '';
let adminUserId = '';
let recUserId = '';
let adminEmail = '';
let recEmail = '';
let adminToken = '';
let recToken = '';
let suffix = '';

beforeAll(async () => {
  const connectedDb = await verifyTestDatabaseIdentity();
  expect(connectedDb).toBe('staycraft_pms_test');

  await runMigrations();

  const pool = getPool();
  suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(
    Math.random() * 90 + 10
  )}`.toUpperCase();

  adminEmail = `stafffix.admin.${suffix.toLowerCase()}@synthetic.test`;
  recEmail = `stafffix.rec.${suffix.toLowerCase()}@synthetic.test`;

  const [adminHash, recHash] = await Promise.all([
    hashPassword('AdminStaffFix#2026!'),
    hashPassword('RecStaffFix#2026!'),
  ]);

  const uAdmin = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, phone)
     VALUES ($1, $2, 'StaffFix Admin', 'admin', '+1 555 201 0001')
     RETURNING id`,
    [adminEmail, adminHash]
  );
  adminUserId = uAdmin.rows[0].id;

  const uRec = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, phone)
     VALUES ($1, $2, 'StaffFix Receptionist', 'receptionist', '+1 555 201 0002')
     RETURNING id`,
    [recEmail, recHash]
  );
  recUserId = uRec.rows[0].id;

  const pAlpha = await pool.query<{ id: string }>(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name
     ) VALUES (
       $1, $2, 'alpha-staff@synthetic.test', '+1 555 201 1001', '10 Riverfront Rd', 'Testpur', 'Testland',
       'Asia/Kolkata', 'INR', 12.00, 'GST'
     ) RETURNING id`,
    [`FA${suffix.slice(0, 6)}`, `StaffFix Alpha Hotel ${suffix}`]
  );
  propAlphaId = pAlpha.rows[0].id;

  const pBeta = await pool.query<{ id: string }>(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name
     ) VALUES (
       $1, $2, 'beta-staff@synthetic.test', '+1 555 201 2002', '20 Hilltop Ave', 'Testgarh', 'Testland',
       'Asia/Kolkata', 'INR', 18.00, 'GST'
     ) RETURNING id`,
    [`FB${suffix.slice(0, 6)}`, `StaffFix Beta Suites ${suffix}`]
  );
  propBetaId = pBeta.rows[0].id;

  // Admin has access to Alpha & Beta; Receptionist ONLY has access to Alpha
  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id, is_default)
     VALUES ($1, $3, TRUE), ($1, $4, FALSE), ($2, $3, TRUE)`,
    [adminUserId, recUserId, propAlphaId, propBetaId]
  );

  resetLoginRateLimiter();

  const recLogin = await request(app)
    .post('/api/auth/login')
    .send({ email: recEmail, password: 'RecStaffFix#2026!' })
    .expect(200);
  recToken = recLogin.body.sessionToken as string;

  // Wait 15ms so admin session created_at is strictly newer than receptionist session
  await new Promise((r) => setTimeout(r, 15));

  const adminLogin = await request(app)
    .post('/api/auth/login')
    .send({ email: adminEmail, password: 'AdminStaffFix#2026!' })
    .expect(200);
  adminToken = adminLogin.body.sessionToken as string;
});

beforeEach(async () => {
  const connectedDb = await verifyTestDatabaseIdentity();
  expect(connectedDb).toBe('staycraft_pms_test');
  resetApiTransportState();
  setStoredSessionToken(null);
  setStoredAuthUserId(null);
  setStoredPropertyId(null);
  setUnauthorizedHandler(null);
});

afterAll(async () => {
  resetApiTransportState();
  setStoredSessionToken(null);
  setStoredAuthUserId(null);
  setStoredPropertyId(null);
  setUnauthorizedHandler(null);
  await closePool();
});

describe('StayCraft PMS — Administrator Add Staff Authorization & Session Isolation Regressions', () => {
  it('1. Allows authorized Administrator to create a staff profile (201) with property isolation and audit trail', async () => {
    const createRes = await request(app)
      .post('/api/staff')
      .set('X-Session-Token', adminToken)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Auth-User-Id', adminUserId)
      .set('X-Property-Id', propAlphaId)
      .send({
        employeeCode: `EMP-ADM-${suffix}`,
        fullName: 'Rohan Kulkarni',
        department: 'front_office',
        jobTitle: 'Front Office Supervisor',
        employmentStatus: 'active',
        shiftType: 'morning',
        email: 'rohan.k@synthetic.test',
        phone: '+91 98111 00101',
        userId: recUserId,
      })
      .expect(201);

    const created: StaffProfileRecord = createRes.body.staff;
    expect(created.propertyId).toBe(propAlphaId);
    expect(created.employeeCode).toBe(`EMP-ADM-${suffix}`);
    expect(created.fullName).toBe('Rohan Kulkarni');
    expect(created.userId).toBe(recUserId);

    // Property isolation: Alpha lists it, Beta does NOT
    const alphaList = await request(app)
      .get('/api/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propAlphaId)
      .expect(200);
    expect(alphaList.body.items.some((s: StaffProfileRecord) => s.id === created.id)).toBe(true);

    const betaList = await request(app)
      .get('/api/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propBetaId)
      .expect(200);
    expect(betaList.body.items.some((s: StaffProfileRecord) => s.id === created.id)).toBe(false);

    // Linking a Receptionist who lacks Beta access to a Beta staff profile fails closed (400)
    await request(app)
      .post('/api/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propBetaId)
      .send({
        employeeCode: `EMP-BETA-BAD-${suffix}`,
        fullName: 'Unauthorized Link Attempt',
        department: 'front_office',
        jobTitle: 'Desk Associate',
        userId: recUserId,
      })
      .expect(400);

    // Audit event recorded accurately for Administrator in Alpha property
    const auditRes = await getPool().query(
      `SELECT property_id, actor_user_id, entity_type, entity_id, action, summary
       FROM audit_events
       WHERE entity_type = 'staff_profile' AND entity_id = $1 AND action = 'created'`,
      [created.id]
    );
    expect(auditRes.rowCount).toBe(1);
    expect(auditRes.rows[0]).toMatchObject({
      property_id: propAlphaId,
      actor_user_id: adminUserId,
      entity_type: 'staff_profile',
      entity_id: created.id,
      action: 'created',
    });
  });

  it('2. Succeeds when Administrator submits Add Staff behind a header-stripping preview proxy even with a stale Receptionist cookie in the browser jar', async () => {
    const upstream = http.createServer(app);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const upAddr = upstream.address();
    const upstreamPort = typeof upAddr === 'object' && upAddr ? upAddr.port : 0;

    // Simulate preview gateway that strips custom auth/property headers AND forwards a stale Receptionist cookie
    const proxy = http.createServer((clientReq, clientRes) => {
      const forwardedHeaders: http.OutgoingHttpHeaders = {
        host: `127.0.0.1:${upstreamPort}`,
        cookie: `staycraft_session=${encodeURIComponent(recToken)}`,
      };
      for (const [k, v] of Object.entries(clientReq.headers)) {
        const lower = k.toLowerCase();
        if (['accept', 'content-type', 'content-length', 'user-agent'].includes(lower)) {
          forwardedHeaders[lower] = v;
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
          delete outHeaders['set-cookie'];
          clientRes.writeHead(upRes.statusCode ?? 500, outHeaders);
          upRes.pipe(clientRes);
        }
      );
      clientReq.pipe(proxyReq);
    });

    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
    const gwAddr = proxy.address();
    const proxyUrl = `http://127.0.0.1:${typeof gwAddr === 'object' && gwAddr ? gwAddr.port : 0}`;

    try {
      setStoredSessionToken(adminToken);
      setStoredAuthUserId(adminUserId);
      setStoredPropertyId(propAlphaId);
      expect(isUsingRpcTransport()).toBe(false);

      const createdRes = await apiFetch<{ staff: StaffProfileRecord }>(`${proxyUrl}/api/staff`, {
        method: 'POST',
        propertyId: propAlphaId,
        body: {
          employeeCode: `EMP-PRX-${suffix}`,
          fullName: 'Meera Deshmukh',
          department: 'housekeeping',
          jobTitle: 'Executive Housekeeper',
          employmentStatus: 'active',
          shiftType: 'day',
        },
      });

      expect(createdRes.staff.employeeCode).toBe(`EMP-PRX-${suffix}`);
      expect(createdRes.staff.propertyId).toBe(propAlphaId);
      expect(isUsingRpcTransport()).toBe(true);

      // Verify audit actor is Administrator, NOT the stale Receptionist cookie
      const auditRes = await getPool().query(
        `SELECT actor_user_id FROM audit_events WHERE entity_type = 'staff_profile' AND entity_id = $1 AND action = 'created'`,
        [createdRes.staff.id]
      );
      expect(auditRes.rows[0]?.actor_user_id).toBe(adminUserId);

      // Receptionist attempting POST /api/staff through the same proxy STILL receives 403 FORBIDDEN
      resetApiTransportState();
      setStoredSessionToken(recToken);
      setStoredAuthUserId(recUserId);
      setStoredPropertyId(propAlphaId);

      await expect(
        apiFetch(`${proxyUrl}/api/staff`, {
          method: 'POST',
          propertyId: propAlphaId,
          body: {
            employeeCode: `EMP-DENY-${suffix}`,
            fullName: 'Should Fail',
            department: 'front_office',
            jobTitle: 'Agent',
          },
        })
      ).rejects.toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
      });
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('3. Resolves newest active Administrator session when duplicate staycraft_session cookies (unpartitioned + Partitioned) are sent', async () => {
    const dupCookieHeader = `staycraft_session=${encodeURIComponent(recToken)}; staycraft_session=${encodeURIComponent(adminToken)}`;

    const res = await request(app)
      .post('/api/staff')
      .set('Cookie', dupCookieHeader)
      .set('X-Property-Id', propAlphaId)
      .send({
        employeeCode: `EMP-DUP-${suffix}`,
        fullName: 'Kabir Verma',
        department: 'concierge_spa',
        jobTitle: 'Head Concierge',
      })
      .expect(201);

    expect(res.body.staff.employeeCode).toBe(`EMP-DUP-${suffix}`);
  });

  it('4. Fails closed with 401 SESSION_MISMATCH instead of silently downgrading to Receptionist cookie when Admin header token was logged out in another tab', async () => {
    // Create a short-lived Admin login and immediately log it out (simulating Tab 2 logout)
    const tempLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: adminEmail, password: 'AdminStaffFix#2026!' })
      .expect(200);
    const revokedAdminToken = tempLogin.body.sessionToken as string;

    await request(app)
      .post('/api/auth/logout')
      .set('X-Session-Token', revokedAdminToken)
      .expect(200);

    // Tab 1 still holds revokedAdminToken + X-Auth-User-Id=adminUserId, while browser jar has recToken
    const mismatchRes = await request(app)
      .post('/api/staff')
      .set('X-Session-Token', revokedAdminToken)
      .set('Authorization', `Bearer ${revokedAdminToken}`)
      .set('X-Auth-User-Id', adminUserId)
      .set('Cookie', `staycraft_session=${encodeURIComponent(recToken)}`)
      .set('X-Property-Id', propAlphaId)
      .send({
        employeeCode: `EMP-MIS-${suffix}`,
        fullName: 'Should Not Execute As Receptionist',
        department: 'front_office',
        jobTitle: 'Supervisor',
      })
      .expect(401);

    expect(mismatchRes.body.error.code).toBe('SESSION_MISMATCH');

    // Forging X-Auth-User-Id=adminUserId with Receptionist credentials NEVER grants admin access
    await request(app)
      .post('/api/staff')
      .set('X-Session-Token', recToken)
      .set('X-Auth-User-Id', adminUserId)
      .set('X-Property-Id', propAlphaId)
      .send({
        employeeCode: `EMP-FORGE-${suffix}`,
        fullName: 'Forged Header Attempt',
        department: 'front_office',
        jobTitle: 'Supervisor',
      })
      .expect(401);
  });

  it('5. Enforces 403 for Receptionist, 401 for unauthenticated callers, and 400 for invalid staff form payloads', async () => {
    // Direct Receptionist POST /api/staff -> 403
    const recRes = await request(app)
      .post('/api/staff')
      .set('X-Session-Token', recToken)
      .set('Authorization', `Bearer ${recToken}`)
      .set('X-Property-Id', propAlphaId)
      .send({
        employeeCode: `EMP-REC-${suffix}`,
        fullName: 'Receptionist Attempt',
        department: 'front_office',
        jobTitle: 'Receptionist',
      })
      .expect(403);
    expect(recRes.body.error.code).toBe('FORBIDDEN');

    // Receptionist POST /api/rpc targeting /api/staff -> 403
    const recRpcRes = await request(app)
      .post('/api/rpc')
      .send({
        method: 'POST',
        path: '/api/staff',
        sessionToken: recToken,
        propertyId: propAlphaId,
        payload: {
          employeeCode: `EMP-RECRPC-${suffix}`,
          fullName: 'Receptionist RPC Attempt',
          department: 'front_office',
          jobTitle: 'Receptionist',
        },
      })
      .expect(403);
    expect(recRpcRes.body.error.code).toBe('FORBIDDEN');

    // Unauthenticated POST /api/staff -> 401
    const unauthRes = await request(app)
      .post('/api/staff')
      .set('X-Property-Id', propAlphaId)
      .send({
        employeeCode: `EMP-NOAUTH-${suffix}`,
        fullName: 'Unauthenticated Attempt',
        department: 'front_office',
        jobTitle: 'Receptionist',
      })
      .expect(401);
    expect(unauthRes.body.error.code).toBe('AUTH_TOKEN_MISSING');

    // Invalid form data submitted by authorized Administrator -> 400 VALIDATION_ERROR
    const invalidRes = await request(app)
      .post('/api/staff')
      .set('X-Session-Token', adminToken)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Property-Id', propAlphaId)
      .send({
        employeeCode: 'BAD CODE!',
        fullName: 'A',
        department: 'invalid_dept',
        jobTitle: '',
        email: 'not-an-email',
      })
      .expect(400);
    expect(invalidRes.body.error.code).toBe('VALIDATION_ERROR');
    expect(invalidRes.body.error.fieldErrors).toBeDefined();

    // Ensure ApiClientError surfaces status/code cleanly
    expect(ApiClientError).toBeDefined();
  });
});
