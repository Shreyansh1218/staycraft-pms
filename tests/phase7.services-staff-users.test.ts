import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, diffDays, getPropertyLocalDate } from '../src/shared/dates.js';
import { calculateReservationFinancials } from '../src/shared/pricing.js';
import { createApiApp } from '../src/server/app.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { closePool, getPool } from '../src/server/db/pool.js';
import { hashPassword } from '../src/server/security/password.js';

const app = createApiApp();

let propAId = '';
let propBId = '';
let roomTypeAId = '';
let roomA1Id = '';
let guestAId = '';
let guestBId = '';
let reservationAId = '';
let reservationBId = '';

let adminUserId = '';
let recUserId = '';

let adminAgent: ReturnType<typeof supertest.agent>;
let recAgent: ReturnType<typeof supertest.agent>;

async function assertTestDatabaseOnly(): Promise<void> {
  const pool = getPool();
  const dbCheck = await pool.query<{ db_name: string }>(
    'SELECT current_database() AS db_name'
  );
  const connectedDb = String(dbCheck.rows[0]?.db_name ?? '');
  if (connectedDb !== 'staycraft_pms_test') {
    throw new Error(
      `ABORTING PHASE 7 TEST SUITE: Expected isolated staycraft_pms_test database, got "${connectedDb}"`
    );
  }
}

beforeAll(async () => {
  await assertTestDatabaseOnly();
  await runMigrations();

  const pool = getPool();
  const suffix = `${Date.now().toString(36).slice(-5)}${Math.floor(
    Math.random() * 90 + 10
  )}`.toUpperCase();

  const adminEmail = `p7.admin.${suffix.toLowerCase()}@staycraft.local`;
  const recEmail = `p7.rec.${suffix.toLowerCase()}@staycraft.local`;

  const adminPass = 'Phase7Admin#2026';
  const recPass = 'Phase7Rec#2026';

  const [adminHash, recHash] = await Promise.all([
    hashPassword(adminPass),
    hashPassword(recPass),
  ]);

  const uAdmin = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role, phone)
     VALUES ($1, $2, 'Phase 7 Admin', 'admin', '+91 91000 70001')
     RETURNING id`,
    [adminEmail, adminHash]
  );
  adminUserId = String(uAdmin.rows[0].id);

  const uRec = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role, phone)
     VALUES ($1, $2, 'Phase 7 Receptionist', 'receptionist', '+91 91000 70002')
     RETURNING id`,
    [recEmail, recHash]
  );
  recUserId = String(uRec.rows[0].id);

  const propARes = await pool.query(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name, invoice_settings
     ) VALUES (
       $1, $2, 'p7a@staycraft.local', '+91 542 250 7001', '71 Assi Ghat', 'Varanasi', 'India',
       'Asia/Kolkata', 'INR', 12.00, 'GST',
       '{"prefix": "P7A-INV", "next_number": 5001, "tax_id": "09AABCP7001M1Z5", "footer_note": "Thank you"}'::jsonb
     ) RETURNING id`,
    [`P7A${suffix.slice(0, 5)}`, `Phase 7 Riverfront Hotel ${suffix}`]
  );
  propAId = String(propARes.rows[0].id);

  const propBRes = await pool.query(
    `INSERT INTO properties (
       code, name, email, phone, address_line1, city, country,
       timezone, currency, default_tax_rate, tax_name
     ) VALUES (
       $1, $2, 'p7b@staycraft.local', '+91 22 4090 7002', '88 Marine Drive', 'Mumbai', 'India',
       'Asia/Kolkata', 'INR', 18.00, 'GST'
     ) RETURNING id`,
    [`P7B${suffix.slice(0, 5)}`, `Phase 7 Harbor Suites ${suffix}`]
  );
  propBId = String(propBRes.rows[0].id);

  // Grant Admin access to A & B; Receptionist ONLY to Property A
  await pool.query(
    `INSERT INTO user_property_access (user_id, property_id, is_default)
     VALUES ($1, $2, TRUE), ($1, $3, FALSE), ($4, $2, TRUE)`,
    [adminUserId, propAId, propBId, recUserId]
  );

  // Room types, rooms, guests & checked-in reservations on Property A and Property B
  const rtA = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'DLX', 'Deluxe River Room', 2, 3, 5500)
     RETURNING id`,
    [propAId]
  );
  roomTypeAId = String(rtA.rows[0].id);

  const rmA = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
     VALUES ($1, $2, '401', '4', 'available', 'clean')
     RETURNING id`,
    [propAId, roomTypeAId]
  );
  roomA1Id = String(rmA.rows[0].id);

  const gA = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'Devika', 'Rao', 'devika.rao@example.com', '+91 98111 77001')
     RETURNING id`,
    [propAId]
  );
  guestAId = String(gA.rows[0].id);

  const today = getPropertyLocalDate('Asia/Kolkata');
  const dep = addDays(today, 2);
  const nights = diffDays(today, dep);
  const fin = calculateReservationFinancials({
    nights,
    nightlyRate: 5500,
    discountAmount: 0,
    taxRate: 12,
  });

  const resA = await pool.query(
    `INSERT INTO reservations (
       property_id, booking_reference, guest_id, room_type_id, room_id,
       arrival_date, departure_date, adults, children, num_guests,
       nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
       currency, source, status, checked_in_at, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, 2, 0, 2,
       $8, 0, 12.00, $9, $10,
       'INR', 'direct', 'checked_in', NOW(), $11, $11
     ) RETURNING id`,
    [
      propAId,
      `P7-RES-${suffix.slice(0, 5)}`,
      guestAId,
      roomTypeAId,
      roomA1Id,
      today,
      dep,
      fin.nightlyRate,
      fin.taxAmount,
      fin.estimatedTotal,
      adminUserId,
    ]
  );
  reservationAId = String(resA.rows[0].id);

  const rtB = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_capacity, max_capacity, base_rate)
     VALUES ($1, 'STE', 'Harbor Suite', 2, 4, 9000)
     RETURNING id`,
    [propBId]
  );
  const gB = await pool.query(
    `INSERT INTO guests (property_id, first_name, last_name, email, phone)
     VALUES ($1, 'Kabir', 'Bedi', 'kabir.b@example.com', '+91 98222 77002')
     RETURNING id`,
    [propBId]
  );
  guestBId = String(gB.rows[0].id);

  const resB = await pool.query(
    `INSERT INTO reservations (
       property_id, booking_reference, guest_id, room_type_id,
       arrival_date, departure_date, adults, children, num_guests,
       nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
       currency, source, status, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, 2, 0, 2,
       9000, 0, 18.00, 3240, 21240,
       'INR', 'direct', 'confirmed', $7, $7
     ) RETURNING id`,
    [propBId, `P7B-RES-${suffix.slice(0, 5)}`, guestBId, rtB.rows[0].id, today, dep, adminUserId]
  );
  reservationBId = String(resB.rows[0].id);

  adminAgent = supertest.agent(app);
  const adminLogin = await adminAgent
    .post('/api/auth/login')
    .send({ email: adminEmail, password: adminPass });
  expect(adminLogin.status).toBe(200);

  recAgent = supertest.agent(app);
  const recLogin = await recAgent
    .post('/api/auth/login')
    .send({ email: recEmail, password: recPass });
  expect(recLogin.status).toBe(200);
});

afterAll(async () => {
  await closePool();
});

describe('Phase 7: Hotel Services, Property Staff Profiles & User Access Management', () => {
  let serviceLaundryId = '';
  let serviceAirportId = '';
  let propBServiceId = '';
  let staffConciergeId = '';
  let propBStaffId = '';
  let folioRequestId = '';

  it('enforces RBAC and validation on property-scoped service catalog CRUD', async () => {
    await assertTestDatabaseOnly();

    // Receptionist cannot create service catalog items
    const recDenied = await recAgent
      .post('/api/services/catalog')
      .set('X-Property-Id', propAId)
      .send({
        code: 'SVC-UNAUTH',
        name: 'Unauthorized Service',
        category: 'laundry',
        unitPrice: 300,
      });
    expect(recDenied.status).toBe(403);

    // Admin creates property-default-tax service (12% GST on Property A)
    const createLaundry = await adminAgent
      .post('/api/services/catalog')
      .set('X-Property-Id', propAId)
      .send({
        code: 'SVC-LAUNDRY',
        name: 'Express Shirt & Kurta Pressing',
        category: 'laundry',
        pricingUnit: 'per_item',
        unitPrice: 500,
        usePropertyTaxRate: true,
        description: 'Same-day steam press service',
      });
    expect(createLaundry.status).toBe(201);
    expect(createLaundry.body.service.effectiveTaxRate).toBe(12);
    serviceLaundryId = createLaundry.body.service.id;

    // Duplicate service code rejected with 409
    const dupCode = await adminAgent
      .post('/api/services/catalog')
      .set('X-Property-Id', propAId)
      .send({
        code: 'svc-laundry',
        name: 'Another Laundry Item',
        category: 'laundry',
        unitPrice: 400,
      });
    expect(dupCode.status).toBe(409);

    // Admin creates custom-tax airport transfer (5% GST)
    const createAirport = await adminAgent
      .post('/api/services/catalog')
      .set('X-Property-Id', propAId)
      .send({
        code: 'SVC-AIRPORT',
        name: 'Varanasi Airport Private Sedan',
        category: 'airport_transfer',
        pricingUnit: 'per_request',
        unitPrice: 2000,
        usePropertyTaxRate: false,
        taxRate: 5,
        description: 'Chauffeured AC sedan transfer',
      });
    expect(createAirport.status).toBe(201);
    expect(createAirport.body.service.effectiveTaxRate).toBe(5);
    serviceAirportId = createAirport.body.service.id;

    // Create a service on Property B to test cross-property isolation
    const createPropBSvc = await adminAgent
      .post('/api/services/catalog')
      .set('X-Property-Id', propBId)
      .send({
        code: 'SVC-YACHT',
        name: 'Harbor Sunset Transfer',
        category: 'concierge',
        unitPrice: 7500,
      });
    expect(createPropBSvc.status).toBe(201);
    propBServiceId = createPropBSvc.body.service.id;

    // Receptionist can list Property A catalog, but is denied Property B
    const recListA = await recAgent
      .get('/api/services/catalog')
      .set('X-Property-Id', propAId);
    expect(recListA.status).toBe(200);
    expect(recListA.body.items.map((i: any) => i.code)).toEqual(
      expect.arrayContaining(['SVC-LAUNDRY', 'SVC-AIRPORT'])
    );
    expect(recListA.body.items.map((i: any) => i.code)).not.toContain('SVC-YACHT');

    const recListB = await recAgent
      .get('/api/services/catalog')
      .set('X-Property-Id', propBId);
    expect(recListB.status).toBe(403);
  });

  it('manages property staff profiles with RBAC, user-link validation, and zero secret leakage', async () => {
    await assertTestDatabaseOnly();

    // Receptionist cannot create staff profile
    const recStaffDenied = await recAgent
      .post('/api/staff')
      .set('X-Property-Id', propAId)
      .send({
        employeeCode: 'EMP-UNAUTH',
        fullName: 'Blocked Staff',
        department: 'front_office',
        jobTitle: 'Clerk',
      });
    expect(recStaffDenied.status).toBe(403);

    // Admin creates active Concierge staff profile linked to receptionist user on Property A
    const createStaffA = await adminAgent
      .post('/api/staff')
      .set('X-Property-Id', propAId)
      .send({
        employeeCode: 'KHB-STF-01',
        fullName: 'Raghavendra Mishra',
        email: 'raghav.concierge@staycraft.local',
        phone: '+91 98333 10001',
        department: 'concierge_spa',
        jobTitle: 'Head Concierge',
        employmentStatus: 'active',
        shiftType: 'morning',
        joinedOn: '2026-01-15',
        emergencyContact: 'Sunita Mishra +91 98333 10009',
        userId: recUserId,
        notes: 'Fluent in Hindi, English, and French',
      });
    expect(createStaffA.status).toBe(201);
    staffConciergeId = createStaffA.body.staff.id;
    expect(createStaffA.body.staff.linkedUserRole).toBe('receptionist');
    // Verify no password_hash or secret fields exist anywhere in JSON
    expect(JSON.stringify(createStaffA.body)).not.toContain('password_hash');
    expect(JSON.stringify(createStaffA.body)).not.toContain('passwordHash');

    // Linking recUserId (who does NOT have Property B access) to a Property B staff profile must fail
    const invalidCrossPropUserLink = await adminAgent
      .post('/api/staff')
      .set('X-Property-Id', propBId)
      .send({
        employeeCode: 'EHS-STF-99',
        fullName: 'Invalid Link Staff',
        department: 'front_office',
        jobTitle: 'Associate',
        userId: recUserId,
      });
    expect(invalidCrossPropUserLink.status).toBe(400);

    // Create valid Property B staff profile (unlinked roster staff)
    const createStaffB = await adminAgent
      .post('/api/staff')
      .set('X-Property-Id', propBId)
      .send({
        employeeCode: 'EHS-STF-01',
        fullName: 'Farhan Shaikh',
        department: 'transport',
        jobTitle: 'Chauffeur',
      });
    expect(createStaffB.status).toBe(201);
    propBStaffId = createStaffB.body.staff.id;

    // Receptionist can read Property A staff directory, denied on Property B
    const recStaffListA = await recAgent
      .get('/api/staff')
      .set('X-Property-Id', propAId);
    expect(recStaffListA.status).toBe(200);
    expect(recStaffListA.body.summary.totalStaffCount).toBe(1);
    expect(recStaffListA.body.summary.activeCount).toBe(1);

    const recStaffListB = await recAgent
      .get('/api/staff')
      .set('X-Property-Id', propBId);
    expect(recStaffListB.status).toBe(403);
  });

  it('enforces strict same-property references, workflow transitions, and inactive-service blocks on service requests', async () => {
    await assertTestDatabaseOnly();

    // Cross-property service rejected on Property A
    const crossPropSvc = await recAgent
      .post('/api/services/requests')
      .set('X-Property-Id', propAId)
      .send({
        serviceId: propBServiceId,
        reservationId: reservationAId,
        quantity: 1,
      });
    expect(crossPropSvc.status).toBe(404);

    // Cross-property reservation rejected on Property A
    const crossPropRes = await recAgent
      .post('/api/services/requests')
      .set('X-Property-Id', propAId)
      .send({
        serviceId: serviceLaundryId,
        reservationId: reservationBId,
        quantity: 2,
      });
    expect(crossPropRes.status).toBe(400);

    // Cross-property staff assignee rejected on Property A
    const crossPropStaff = await recAgent
      .post('/api/services/requests')
      .set('X-Property-Id', propAId)
      .send({
        serviceId: serviceLaundryId,
        reservationId: reservationAId,
        assignedStaffId: propBStaffId,
        quantity: 2,
      });
    expect(crossPropStaff.status).toBe(400);

    // Valid service request created by Receptionist for checked-in stay on Property A
    // 2 items * ₹500 = ₹1,000 subtotal + 12% GST (₹120) = ₹1,120 total
    const createReq = await recAgent
      .post('/api/services/requests')
      .set('X-Property-Id', propAId)
      .send({
        serviceId: serviceLaundryId,
        reservationId: reservationAId,
        assignedStaffId: staffConciergeId,
        quantity: 2,
        notes: '2 silk kurtas for evening aarti',
      });
    expect(createReq.status).toBe(201);
    const sr = createReq.body.serviceRequest;
    folioRequestId = sr.id;
    expect(sr.status).toBe('requested');
    expect(sr.billingStatus).toBe('unbilled');
    expect(sr.subtotal).toBe(1000);
    expect(sr.taxAmount).toBe(120);
    expect(sr.totalAmount).toBe(1120);
    expect(sr.roomId).toBe(roomA1Id);
    expect(sr.guestId).toBe(guestAId);

    // Skipping directly from requested -> completed must be rejected (400)
    const invalidSkip = await recAgent
      .post(`/api/services/requests/${folioRequestId}/status`)
      .set('X-Property-Id', propAId)
      .send({ status: 'completed' });
    expect(invalidSkip.status).toBe(400);

    // Posting an incomplete ('requested') service request to invoice must be rejected (409)
    const prematurePost = await recAgent
      .post(`/api/services/requests/${folioRequestId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({});
    expect(prematurePost.status).toBe(409);

    // Valid workflow: requested -> in_progress -> completed
    const startRes = await recAgent
      .post(`/api/services/requests/${folioRequestId}/status`)
      .set('X-Property-Id', propAId)
      .send({
        status: 'in_progress',
        note: 'Garments collected from Room 401',
      });
    expect(startRes.status).toBe(200);
    expect(startRes.body.serviceRequest.status).toBe('in_progress');
    expect(startRes.body.serviceRequest.startedAt).toBeTruthy();

    const completeRes = await recAgent
      .post(`/api/services/requests/${folioRequestId}/status`)
      .set('X-Property-Id', propAId)
      .send({
        status: 'completed',
        note: 'Pressed kurtas delivered to Room 401',
      });
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.serviceRequest.status).toBe('completed');
    expect(completeRes.body.serviceRequest.completedAt).toBeTruthy();
    expect(completeRes.body.serviceRequest.history.length).toBeGreaterThanOrEqual(3);

    // Completed requests cannot be cancelled
    const cancelCompleted = await recAgent
      .post(`/api/services/requests/${folioRequestId}/cancel`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Too late to cancel' });
    expect(cancelCompleted.status).toBe(409);

    // Deactivating the airport transfer service blocks new requests while retaining history
    const deactivateAirport = await adminAgent
      .put(`/api/services/catalog/${serviceAirportId}`)
      .set('X-Property-Id', propAId)
      .send({ isActive: false });
    expect(deactivateAirport.status).toBe(200);
    expect(deactivateAirport.body.service.isActive).toBe(false);

    const reqInactiveBlocked = await recAgent
      .post('/api/services/requests')
      .set('X-Property-Id', propAId)
      .send({
        serviceId: serviceAirportId,
        reservationId: reservationAId,
        quantity: 1,
      });
    expect(reqInactiveBlocked.status).toBe(400);
  });

  it('posts completed service charges idempotently, blocks duplicates, rolls back invalid targets, and releases on unpaid invoice void', async () => {
    await assertTestDatabaseOnly();
    const pool = getPool();

    // 1. First post with idempotencyKey creates draft invoice + service line item + reservation_service_charges
    const idempKey = `test-idemp-post-${folioRequestId}`;
    const post1 = await recAgent
      .post(`/api/services/requests/${folioRequestId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({
        createDraftInvoiceIfMissing: true,
        idempotencyKey: idempKey,
        note: 'Laundry folio charge',
      });
    expect(post1.status).toBe(200);
    expect(post1.body.serviceRequest.billingStatus).toBe('posted');
    const invoice1Id = String(post1.body.invoice.id);
    expect(invoice1Id).toBeTruthy();

    const svcItemsAfter1 = post1.body.invoice.lineItems.filter(
      (li: any) => li.itemType === 'service_charge'
    );
    expect(svcItemsAfter1).toHaveLength(1);
    expect(svcItemsAfter1[0].netAmount).toBe(1000);
    expect(svcItemsAfter1[0].taxAmount).toBe(120);
    expect(svcItemsAfter1[0].lineTotal).toBe(1120);

    // 2. Idempotent replay with the SAME idempotencyKey returns 200 without duplicating charges
    const postReplay = await recAgent
      .post(`/api/services/requests/${folioRequestId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({
        createDraftInvoiceIfMissing: true,
        idempotencyKey: idempKey,
      });
    expect(postReplay.status).toBe(200);
    expect(postReplay.body.invoice.id).toBe(invoice1Id);

    const chargeCountRes = await pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM reservation_service_charges
       WHERE service_request_id = $1 AND status != 'voided'`,
      [folioRequestId]
    );
    expect(chargeCountRes.rows[0].cnt).toBe(1);

    // 3. Duplicate post with a DIFFERENT idempotency key is rejected with 409 Conflict
    const dupPost = await recAgent
      .post(`/api/services/requests/${folioRequestId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({
        idempotencyKey: 'different-key-attempt',
      });
    expect(dupPost.status).toBe(409);

    // 4. Voiding the unpaid invoice releases the service request back to 'unbilled'
    const voidRes = await adminAgent
      .post(`/api/invoices/${invoice1Id}/void`)
      .set('X-Property-Id', propAId)
      .send({ reason: 'Voiding draft invoice to test service release' });
    expect(voidRes.status).toBe(200);
    expect(voidRes.body.invoice.status).toBe('void');

    const srAfterVoid = await recAgent
      .get(`/api/services/requests/${folioRequestId}`)
      .set('X-Property-Id', propAId);
    expect(srAfterVoid.status).toBe(200);
    expect(srAfterVoid.body.serviceRequest.billingStatus).toBe('unbilled');
    expect(srAfterVoid.body.serviceRequest.postedInvoiceId).toBeNull();

    // 5. Attempting to post to the VOIDED invoice rolls back cleanly (409) without mutating billing_status
    const failedPostToVoid = await recAgent
      .post(`/api/services/requests/${folioRequestId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({
        invoiceId: invoice1Id,
      });
    expect(failedPostToVoid.status).toBe(409);

    const srStillUnbilled = await recAgent
      .get(`/api/services/requests/${folioRequestId}`)
      .set('X-Property-Id', propAId);
    expect(srStillUnbilled.body.serviceRequest.billingStatus).toBe('unbilled');

    // 6. Re-posting to a fresh replacement invoice succeeds cleanly!
    const repostRes = await recAgent
      .post(`/api/services/requests/${folioRequestId}/post-to-invoice`)
      .set('X-Property-Id', propAId)
      .send({
        createDraftInvoiceIfMissing: true,
        idempotencyKey: `repost-${folioRequestId}`,
      });
    expect(repostRes.status).toBe(200);
    expect(repostRes.body.serviceRequest.billingStatus).toBe('posted');
    expect(repostRes.body.invoice.id).not.toBe(invoice1Id);
  });

  it('preserves historical assignments & audit trail when staff profiles are deactivated while blocking new assignments', async () => {
    await assertTestDatabaseOnly();

    // Deactivate Head Concierge
    const deactRes = await adminAgent
      .put(`/api/staff/${staffConciergeId}`)
      .set('X-Property-Id', propAId)
      .send({ employmentStatus: 'inactive' });
    expect(deactRes.status).toBe(200);
    expect(deactRes.body.staff.employmentStatus).toBe('inactive');
    expect(deactRes.body.staff.deactivatedAt).toBeTruthy();

    // Historical service request assignment is preserved on staff detail!
    expect(deactRes.body.staff.completedRequestsCount).toBe(1);
    expect(
      deactRes.body.staff.recentServiceRequests.some(
        (r: any) => r.id === folioRequestId
      )
    ).toBe(true);

    // Assigning a NEW service request to the deactivated staff member is blocked (400)
    const newReqToInactiveStaff = await recAgent
      .post('/api/services/requests')
      .set('X-Property-Id', propAId)
      .send({
        serviceId: serviceLaundryId,
        reservationId: reservationAId,
        assignedStaffId: staffConciergeId,
        quantity: 1,
      });
    expect(newReqToInactiveStaff.status).toBe(400);
  });

  it('enforces user RBAC, blocks privilege escalation & self-lockout, manages property access, and revokes sessions on deactivation/password reset', async () => {
    await assertTestDatabaseOnly();
    const pool = getPool();

    // 1. Receptionist is blocked (403) from all /api/users endpoints — including privilege escalation attempts
    const recUsersList = await recAgent
      .get('/api/users')
      .set('X-Property-Id', propAId);
    expect(recUsersList.status).toBe(403);

    const recSelfEscalate = await recAgent
      .put(`/api/users/${recUserId}`)
      .set('X-Property-Id', propAId)
      .send({ role: 'admin' });
    expect(recSelfEscalate.status).toBe(403);

    const recGrantSelfPropB = await recAgent
      .put(`/api/users/${recUserId}/property-access`)
      .set('X-Property-Id', propAId)
      .send({ propertyIds: [propAId, propBId], defaultPropertyId: propAId });
    expect(recGrantSelfPropB.status).toBe(403);

    // 2. Admin cannot self-deactivate or self-demote
    const selfDeactivate = await adminAgent
      .put(`/api/users/${adminUserId}`)
      .set('X-Property-Id', propAId)
      .send({ isActive: false });
    expect(selfDeactivate.status).toBe(400);

    const selfDemote = await adminAgent
      .put(`/api/users/${adminUserId}`)
      .set('X-Property-Id', propAId)
      .send({ role: 'receptionist' });
    expect(selfDemote.status).toBe(400);

    // 3. Admin creates a new Receptionist account scoped to Property A
    const newRecEmail = `desk.new.${Date.now()}@staycraft.local`;
    const createUserRes = await adminAgent
      .post('/api/users')
      .set('X-Property-Id', propAId)
      .send({
        email: newRecEmail,
        fullName: 'Ananya Kulkarni',
        phone: '+91 98444 20001',
        role: 'receptionist',
        password: 'InitialPassword#1',
        isActive: true,
        propertyIds: [propAId],
        defaultPropertyId: propAId,
      });
    expect(createUserRes.status).toBe(201);
    const createdUserId = String(createUserRes.body.user.id);
    expect(JSON.stringify(createUserRes.body)).not.toContain('password_hash');
    expect(JSON.stringify(createUserRes.body)).not.toContain('InitialPassword#1');

    // New user logs in and can access Property A, denied on Property B
    const newRecAgent = supertest.agent(app);
    const login1 = await newRecAgent
      .post('/api/auth/login')
      .send({ email: newRecEmail, password: 'InitialPassword#1' });
    expect(login1.status).toBe(200);

    const accessPropBBefore = await newRecAgent
      .get('/api/services/catalog')
      .set('X-Property-Id', propBId);
    expect(accessPropBBefore.status).toBe(403);

    // 4. Admin grants Property B access to the new receptionist -> immediate access works
    const grantPropB = await adminAgent
      .put(`/api/users/${createdUserId}/property-access`)
      .set('X-Property-Id', propAId)
      .send({
        propertyIds: [propAId, propBId],
        defaultPropertyId: propBId,
      });
    expect(grantPropB.status).toBe(200);
    expect(grantPropB.body.user.propertyAccess).toHaveLength(2);

    const accessPropBAfter = await newRecAgent
      .get('/api/services/catalog')
      .set('X-Property-Id', propBId);
    expect(accessPropBAfter.status).toBe(200);

    // Stripping ALL properties from an active receptionist is rejected (400)
    const stripAllProps = await adminAgent
      .put(`/api/users/${createdUserId}/property-access`)
      .set('X-Property-Id', propAId)
      .send({ propertyIds: [] });
    expect(stripAllProps.status).toBe(400);

    // 5. Admin resets user password -> old session is immediately revoked (401), new password logs in
    const resetPwd = await adminAgent
      .post(`/api/users/${createdUserId}/reset-password`)
      .set('X-Property-Id', propAId)
      .send({ newPassword: 'RotatedPassword#2' });
    expect(resetPwd.status).toBe(200);

    const oldSessionAfterReset = await newRecAgent
      .get('/api/auth/me');
    expect(oldSessionAfterReset.status).toBe(401);

    const loginRotated = await newRecAgent
      .post('/api/auth/login')
      .send({ email: newRecEmail, password: 'RotatedPassword#2' });
    expect(loginRotated.status).toBe(200);

    // 6. Admin deactivates user -> active session is immediately revoked (401)
    const deactivateUser = await adminAgent
      .put(`/api/users/${createdUserId}`)
      .set('X-Property-Id', propAId)
      .send({ isActive: false });
    expect(deactivateUser.status).toBe(200);
    expect(deactivateUser.body.user.isActive).toBe(false);

    const sessionAfterDeactivate = await newRecAgent.get('/api/auth/me');
    expect(sessionAfterDeactivate.status).toBe(401);

    // 7. Verify append-only audit_events recorded across Phase 7 entities
    const auditRes = await pool.query<{ entity_type: string; cnt: number }>(
      `SELECT entity_type, COUNT(*)::int AS cnt
       FROM audit_events
       WHERE property_id = $1
         AND entity_type IN ('service_catalog', 'service_request', 'staff_profile', 'user')
       GROUP BY entity_type`,
      [propAId]
    );
    const byType = Object.fromEntries(
      auditRes.rows.map((r) => [r.entity_type, Number(r.cnt)])
    );
    expect(byType.service_catalog).toBeGreaterThanOrEqual(2);
    expect(byType.service_request).toBeGreaterThanOrEqual(4);
    expect(byType.staff_profile).toBeGreaterThanOrEqual(2);
    expect(byType.user).toBeGreaterThanOrEqual(4);
  });

  it('keeps unlinked login accounts at zero staff count, enforces property-isolated staff-to-user linking, unlinks on access revocation, and filters active/on_leave/inactive accurately', async () => {
    await assertTestDatabaseOnly();
    const pool = getPool();
    const tag = `${Date.now().toString(36).slice(-4)}${Math.floor(
      Math.random() * 90 + 10
    )}`.toUpperCase();

    // 1. Create two fresh properties (simulating KHB & EHS before any staff profiles exist)
    const khbRes = await pool.query<{ id: string }>(
      `INSERT INTO properties (
         code, name, email, phone, address_line1, city, country, timezone, currency, default_tax_rate, tax_name
       ) VALUES (
         $1, $2, 'khb.reg@staycraft.local', '+91 542 250 8801', 'Assi Ghat', 'Varanasi', 'India', 'Asia/Kolkata', 'INR', 12.00, 'GST'
       ) RETURNING id`,
      [`K${tag}`, `Kashi Regression Boutique ${tag}`]
    );
    const khbPropId = String(khbRes.rows[0].id);

    const ehsRes = await pool.query<{ id: string }>(
      `INSERT INTO properties (
         code, name, email, phone, address_line1, city, country, timezone, currency, default_tax_rate, tax_name
       ) VALUES (
         $1, $2, 'ehs.reg@staycraft.local', '+91 484 260 8802', 'Hill Road', 'Munnar', 'India', 'Asia/Kolkata', 'INR', 12.00, 'GST'
       ) RETURNING id`,
      [`E${tag}`, `Emerald Regression Suites ${tag}`]
    );
    const ehsPropId = String(ehsRes.rows[0].id);

    // Create an active Receptionist account ("Priya Nair") with KHB property access ONLY
    const priyaEmail = `priya.reg.${tag.toLowerCase()}@staycraft.local`;
    const priyaCreate = await adminAgent
      .post('/api/users')
      .set('X-Property-Id', khbPropId)
      .send({
        email: priyaEmail,
        fullName: 'Priya Nair',
        phone: '+91 98765 44110',
        role: 'receptionist',
        password: 'Priya#RegPassword9',
        isActive: true,
        propertyIds: [khbPropId],
        defaultPropertyId: khbPropId,
      });
    expect(priyaCreate.status).toBe(201);
    const priyaUserId = String(priyaCreate.body.user.id);

    // 2. Root-cause regression check: KHB has active login accounts (`users` + `user_property_access`),
    //    but 0 rows in `property_staff_profiles` -> directory & KPI counts MUST be 0 (never count users as staff!)
    const khbUsersBefore = await adminAgent
      .get(`/api/users?propertyId=${khbPropId}`)
      .set('X-Property-Id', khbPropId);
    expect(khbUsersBefore.status).toBe(200);
    const priyaManagedBefore = khbUsersBefore.body.items.find(
      (u: any) => u.id === priyaUserId
    );
    expect(priyaManagedBefore).toBeTruthy();
    expect(priyaManagedBefore.linkedStaffProfiles).toEqual([]);

    const khbStaffZero = await adminAgent
      .get('/api/staff')
      .set('X-Property-Id', khbPropId);
    expect(khbStaffZero.status).toBe(200);
    expect(khbStaffZero.body.items).toEqual([]);
    expect(khbStaffZero.body.summary).toMatchObject({
      totalStaffCount: 0,
      activeCount: 0,
      onLeaveCount: 0,
      inactiveCount: 0,
      linkedUsersCount: 0,
    });

    // 3. Creating a staff profile with the SAME name ("Priya Nair") without `userId` MUST NOT auto-link by name!
    const createUnlinkedSameName = await adminAgent
      .post('/api/staff')
      .set('X-Property-Id', khbPropId)
      .send({
        employeeCode: 'KHB-FO-01',
        fullName: 'Priya Nair',
        email: priyaEmail,
        phone: '+91 98765 44110',
        department: 'front_office',
        jobTitle: 'Front Desk Receptionist',
        employmentStatus: 'active',
        shiftType: 'day',
      });
    expect(createUnlinkedSameName.status).toBe(201);
    const khbPriyaStaffId = String(createUnlinkedSameName.body.staff.id);
    expect(createUnlinkedSameName.body.staff.userId).toBeNull();

    const khbAfterUnlinked = await adminAgent
      .get('/api/staff')
      .set('X-Property-Id', khbPropId);
    expect(khbAfterUnlinked.body.summary).toMatchObject({
      totalStaffCount: 1,
      activeCount: 1,
      linkedUsersCount: 0,
    });

    // 4. Explicitly linking `KHB-FO-01` -> `priyaUserId` updates `linkedUsersCount` to 1 and prevents duplicate links
    const explicitLink = await adminAgent
      .put(`/api/staff/${khbPriyaStaffId}`)
      .set('X-Property-Id', khbPropId)
      .send({ userId: priyaUserId });
    expect(explicitLink.status).toBe(200);
    expect(explicitLink.body.staff.userId).toBe(priyaUserId);
    expect(explicitLink.body.staff.linkedUserHasPropertyAccess).toBe(true);
    expect(JSON.stringify(explicitLink.body)).not.toContain('password_hash');

    const khbAfterLink = await adminAgent
      .get('/api/staff')
      .set('X-Property-Id', khbPropId);
    expect(khbAfterLink.body.summary.linkedUsersCount).toBe(1);

    // Duplicate staff link for the same user in KHB is rejected with 409 Conflict
    const dupUserLinkInKhb = await adminAgent
      .post('/api/staff')
      .set('X-Property-Id', khbPropId)
      .send({
        employeeCode: 'KHB-FO-DUP',
        fullName: 'Duplicate Link Attempt',
        department: 'front_office',
        jobTitle: 'Associate',
        userId: priyaUserId,
      });
    expect(dupUserLinkInKhb.status).toBe(409);

    // EHS remains strictly isolated (0 staff profiles)
    const ehsIsolatedCheck = await adminAgent
      .get('/api/staff')
      .set('X-Property-Id', ehsPropId);
    expect(ehsIsolatedCheck.body.summary.totalStaffCount).toBe(0);
    expect(ehsIsolatedCheck.body.summary.linkedUsersCount).toBe(0);

    // 5. Grant Priya access to EHS, link an EHS staff profile, then revoke EHS access -> EHS link clears automatically!
    const grantEhs = await adminAgent
      .put(`/api/users/${priyaUserId}/property-access`)
      .set('X-Property-Id', khbPropId)
      .send({
        propertyIds: [khbPropId, ehsPropId],
        defaultPropertyId: khbPropId,
      });
    expect(grantEhs.status).toBe(200);

    const createEhsStaff = await adminAgent
      .post('/api/staff')
      .set('X-Property-Id', ehsPropId)
      .send({
        employeeCode: 'EHS-FO-01',
        fullName: 'Priya Nair',
        department: 'front_office',
        jobTitle: 'Relief Receptionist',
        userId: priyaUserId,
      });
    expect(createEhsStaff.status).toBe(201);
    const ehsPriyaStaffId = String(createEhsStaff.body.staff.id);

    const ehsLinkedCheck = await adminAgent
      .get('/api/staff')
      .set('X-Property-Id', ehsPropId);
    expect(ehsLinkedCheck.body.summary.totalStaffCount).toBe(1);
    expect(ehsLinkedCheck.body.summary.linkedUsersCount).toBe(1);

    // Revoke EHS property access while keeping KHB access
    const revokeEhs = await adminAgent
      .put(`/api/users/${priyaUserId}/property-access`)
      .set('X-Property-Id', khbPropId)
      .send({
        propertyIds: [khbPropId],
        defaultPropertyId: khbPropId,
      });
    expect(revokeEhs.status).toBe(200);

    // EHS staff profile still exists (not deleted!), but its dangling userId was unlinked -> linkedUsersCount = 0
    const ehsAfterRevoke = await adminAgent
      .get('/api/staff')
      .set('X-Property-Id', ehsPropId);
    expect(ehsAfterRevoke.body.summary.totalStaffCount).toBe(1);
    expect(ehsAfterRevoke.body.summary.linkedUsersCount).toBe(0);
    expect(ehsAfterRevoke.body.items[0].id).toBe(ehsPriyaStaffId);
    expect(ehsAfterRevoke.body.items[0].userId).toBeNull();

    // KHB staff profile link remains intact (`linkedUsersCount = 1`)
    const khbStillLinked = await adminAgent
      .get('/api/staff')
      .set('X-Property-Id', khbPropId);
    expect(khbStillLinked.body.summary.linkedUsersCount).toBe(1);

    // 6. Disabling the user login drops `linkedUsersCount` to 0 and blocks new links to disabled user
    const disablePriya = await adminAgent
      .put(`/api/users/${priyaUserId}`)
      .set('X-Property-Id', khbPropId)
      .send({ isActive: false });
    expect(disablePriya.status).toBe(200);

    const khbWhenUserDisabled = await adminAgent
      .get('/api/staff')
      .set('X-Property-Id', khbPropId);
    expect(khbWhenUserDisabled.body.summary.linkedUsersCount).toBe(0);
    expect(khbWhenUserDisabled.body.items[0].linkedUserIsActive).toBe(false);

    const linkDisabledBlocked = await adminAgent
      .put(`/api/staff/${ehsPriyaStaffId}`)
      .set('X-Property-Id', ehsPropId)
      .send({ userId: priyaUserId });
    expect(linkDisabledBlocked.status).toBe(400);

    // Re-enable Priya login -> KHB linkedUsersCount returns to 1
    await adminAgent
      .put(`/api/users/${priyaUserId}`)
      .set('X-Property-Id', khbPropId)
      .send({ isActive: true });

    const khbReenabled = await adminAgent
      .get('/api/staff')
      .set('X-Property-Id', khbPropId);
    expect(khbReenabled.body.summary.linkedUsersCount).toBe(1);

    // 7. Add `on_leave` and `active` staff, deactivate `KHB-FO-01`, and verify status filters & KPI counts
    await adminAgent
      .post('/api/staff')
      .set('X-Property-Id', khbPropId)
      .send({
        employeeCode: 'KHB-HK-02',
        fullName: 'Savita Devi',
        department: 'housekeeping',
        jobTitle: 'Floor Supervisor',
        employmentStatus: 'active',
      });

    await adminAgent
      .post('/api/staff')
      .set('X-Property-Id', khbPropId)
      .send({
        employeeCode: 'KHB-SPA-03',
        fullName: 'Nitin Joshi',
        department: 'concierge_spa',
        jobTitle: 'Ayurveda Therapist',
        employmentStatus: 'on_leave',
      });

    await adminAgent
      .put(`/api/staff/${khbPriyaStaffId}`)
      .set('X-Property-Id', khbPropId)
      .send({ employmentStatus: 'inactive' });

    const [allRes, activeRes, leaveRes, inactiveRes, deactivatedAliasRes] =
      await Promise.all([
        adminAgent
          .get('/api/staff?includeInactive=true')
          .set('X-Property-Id', khbPropId),
        adminAgent
          .get('/api/staff?employmentStatus=active')
          .set('X-Property-Id', khbPropId),
        adminAgent
          .get('/api/staff?employmentStatus=on_leave')
          .set('X-Property-Id', khbPropId),
        adminAgent
          .get('/api/staff?employmentStatus=inactive')
          .set('X-Property-Id', khbPropId),
        adminAgent
          .get('/api/staff?employmentStatus=deactivated')
          .set('X-Property-Id', khbPropId),
      ]);

    expect(allRes.body.summary).toMatchObject({
      totalStaffCount: 3,
      activeCount: 1,
      onLeaveCount: 1,
      inactiveCount: 1,
      linkedUsersCount: 0, // KHB-FO-01 is inactive, so active linked login count is 0
    });
    expect(allRes.body.items).toHaveLength(3);
    expect(activeRes.body.items.map((i: any) => i.employeeCode)).toEqual([
      'KHB-HK-02',
    ]);
    expect(leaveRes.body.items.map((i: any) => i.employeeCode)).toEqual([
      'KHB-SPA-03',
    ]);
    expect(inactiveRes.body.items.map((i: any) => i.employeeCode)).toEqual([
      'KHB-FO-01',
    ]);
    expect(
      deactivatedAliasRes.body.items.map((i: any) => i.employeeCode)
    ).toEqual(['KHB-FO-01']);
  });
});
