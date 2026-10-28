import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { addDays, diffDays, getPropertyLocalDate } from '../../shared/dates.js';
import { calculateReservationFinancials } from '../../shared/pricing.js';
import { sanitizeErrorForLog } from '../config.js';
import { ensureInitialAdminAccount } from './ensure-admin.js';
import {
  PREVIEW_DATABASE_NAME,
  PRODUCTION_DATABASE_NAME,
  PRODUCTION_MIGRATION_AUTH_ENV,
  runMigrations,
  TEST_DATABASE_NAME,
  type MigrationPoolLike,
} from './migrate.js';
import { closePool, getPool } from './pool.js';
import { hashPassword } from '../security/password.js';

export interface SeedDatabaseOptions {
  pool?: MigrationPoolLike;
  env?: NodeJS.ProcessEnv;
  migrationsDir?: string;
}

/**
 * Independent fail-closed seed authorization guard.
 * Unconditionally blocks seeding production ("staycraft_pms") and NODE_ENV=production
 * (outside preview role), even if ALLOW_PRODUCTION_MIGRATIONS=true is set.
 */
export async function assertSeedTargetAuthorized(
  pool: Pick<pg.Pool, 'query'>,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const dbCheck = await pool.query<{ db: string }>('SELECT current_database() AS db');
  const connectedDb = String(dbCheck.rows[0]?.db ?? '').trim();

  if (!connectedDb) {
    throw new Error(
      'Refusing to seed database: unable to verify connected PostgreSQL database name.'
    );
  }

  // Unconditional production database block — never overridable by ALLOW_PRODUCTION_MIGRATIONS
  if (connectedDb === PRODUCTION_DATABASE_NAME) {
    throw new Error(
      `Refusing to seed production database "${PRODUCTION_DATABASE_NAME}". Demo/seed writes against production are permanently prohibited regardless of ${PRODUCTION_MIGRATION_AUTH_ENV} or environment flags.`
    );
  }

  if (env.NODE_ENV === 'test') {
    if (connectedDb !== TEST_DATABASE_NAME) {
      throw new Error(
        `Refusing to run test seed against non-test database: "${connectedDb}"`
      );
    }
    return connectedDb;
  }

  if (env.STAYCRAFT_DB_ROLE === 'preview') {
    if (connectedDb !== PREVIEW_DATABASE_NAME) {
      throw new Error(
        `Refusing to run preview seed against non-preview database: "${connectedDb}"`
      );
    }
    return connectedDb;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      `Refusing to run database seed when NODE_ENV=production (target database: "${connectedDb}"). Seeding is restricted to test, preview, or non-production development databases.`
    );
  }

  return connectedDb;
}

async function runSeedTransaction<T>(
  pool: MigrationPoolLike,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function seedDatabase(options: SeedDatabaseOptions = {}): Promise<void> {
  const pool = options.pool ?? getPool();
  const env = options.env ?? process.env;

  // Enforce independent production seed block BEFORE running migrations or reading/writing rows
  await assertSeedTargetAuthorized(pool, env);

  await runMigrations({
    pool,
    env,
    migrationsDir: options.migrationsDir,
  });

  const existingProps = await pool.query('SELECT COUNT(*)::int AS cnt FROM properties');
  if (Number(existingProps.rows[0]?.cnt ?? 0) > 0) {
    const adminCheck = await ensureInitialAdminAccount({
      resetPassword: false,
      ...(options.pool ? { pool: options.pool as pg.Pool } : {}),
    });
    console.log(
      `Seed skipped: properties already exist in database (admin ${adminCheck.email}: ${adminCheck.action}).`
    );
    return;
  }

  const adminHash = await hashPassword('Admin@12345');
  const receptionistHash = await hashPassword('FrontDesk@123');
  const today = getPropertyLocalDate('Asia/Kolkata');

  await runSeedTransaction(pool, async (client) => {
    // Re-verify connected database inside write transaction before any INSERT
    await assertSeedTargetAuthorized(client, env);
    // 1. Create Users
    const adminRes = await client.query(
      `INSERT INTO users (email, password_hash, full_name, role, phone)
       VALUES ($1, $2, $3, 'admin', $4)
       RETURNING id`,
      ['admin@staycraft.local', adminHash, 'Aarav Mehta', '+91 98110 24001']
    );
    const adminId = adminRes.rows[0].id as string;

    const recRes = await client.query(
      `INSERT INTO users (email, password_hash, full_name, role, phone)
       VALUES ($1, $2, $3, 'receptionist', $4)
       RETURNING id`,
      ['frontdesk@staycraft.local', receptionistHash, 'Priya Nair', '+91 98110 24002']
    );
    const recId = recRes.rows[0].id as string;

    // 2. Primary Property: Kashi Heritage Boutique Hotel
    const prop1Res = await client.query(
      `INSERT INTO properties (
         code, name, email, phone, website,
         address_line1, address_line2, city, state_region, postal_code, country,
         timezone, currency, default_tax_rate, tax_name,
         standard_check_in_time, standard_check_out_time,
         cancellation_policy, booking_terms, invoice_settings
       ) VALUES (
         'KHB', 'Kashi Heritage Boutique Hotel', 'reservations@kashiheritage.example', '+91 542 250 8800', 'https://kashiheritage.example',
         'B-1/142 Assi Ghat Road', 'Near Riverfront Promenade', 'Varanasi', 'Uttar Pradesh', '221005', 'India',
         'Asia/Kolkata', 'INR', 12.00, 'GST',
         '14:00', '11:00',
         'Free cancellation up to 24 hours before arrival. First night charged for late cancellations or no-shows.',
         'Government-issued photo ID is mandatory for all guests upon check-in. Pets are not permitted.',
         '{"prefix": "KHB-INV", "next_number": 1001, "tax_id": "09AABCK4821M1Z5", "footer_note": "Thank you for choosing Kashi Heritage Boutique Hotel."}'::jsonb
       ) RETURNING id`
    );
    const prop1Id = prop1Res.rows[0].id as string;

    // 3. Secondary Property: Emerald Harbor Suites (demonstrating multi-property support)
    const prop2Res = await client.query(
      `INSERT INTO properties (
         code, name, email, phone, website,
         address_line1, address_line2, city, state_region, postal_code, country,
         timezone, currency, default_tax_rate, tax_name,
         standard_check_in_time, standard_check_out_time
       ) VALUES (
         'EHS', 'Emerald Harbor Suites', 'desk@emeraldharbor.example', '+91 22 4090 1200', 'https://emeraldharbor.example',
         '44 Marine Drive', 'Colaba', 'Mumbai', 'Maharashtra', '400005', 'India',
         'Asia/Kolkata', 'INR', 18.00, 'GST',
         '15:00', '12:00'
       ) RETURNING id`
    );
    const prop2Id = prop2Res.rows[0].id as string;

    await client.query(
      `INSERT INTO user_property_access (user_id, property_id, is_default)
       VALUES
         ($1, $2, TRUE),
         ($1, $3, FALSE),
         ($4, $2, TRUE)`,
      [adminId, prop1Id, prop2Id, recId]
    );

    // 4. Room Types for Property 1
    const rtStdRes = await client.query(
      `INSERT INTO room_types (property_id, code, name, description, base_capacity, max_capacity, base_rate, amenities)
       VALUES ($1, 'STD', 'Standard Heritage Queen', 'Cozy queen room with handcrafted teak furnishings and courtyard view.', 2, 2, 4200, '["Wi-Fi", "Air Conditioning", "Tea/Coffee Maker", "Rain Shower"]'::jsonb)
       RETURNING id`,
      [prop1Id]
    );
    const rtDlxRes = await client.query(
      `INSERT INTO room_types (property_id, code, name, description, base_capacity, max_capacity, base_rate, amenities)
       VALUES ($1, 'DLX', 'Deluxe King Room', 'Spacious king room with work desk, seating alcove, and balcony.', 2, 3, 6200, '["Wi-Fi", "Air Conditioning", "Balcony", "Minibar", "Smart TV"]'::jsonb)
       RETURNING id`,
      [prop1Id]
    );
    const rtSteRes = await client.query(
      `INSERT INTO room_types (property_id, code, name, description, base_capacity, max_capacity, base_rate, amenities)
       VALUES ($1, 'STE', 'Ganges Terrace Suite', 'Panoramic terrace suite with living lounge and complimentary breakfast.', 2, 4, 9800, '["Wi-Fi", "River Terrace", "Living Lounge", "Bathtub", "Espresso Machine"]'::jsonb)
       RETURNING id`,
      [prop1Id]
    );
    const rtFamRes = await client.query(
      `INSERT INTO room_types (property_id, code, name, description, base_capacity, max_capacity, base_rate, amenities)
       VALUES ($1, 'FAM', 'Family Courtyard Suite', 'Two-bedroom interconnecting family suite overlooking central courtyard.', 4, 5, 11500, '["Wi-Fi", "2 Bedrooms", "Courtyard View", "Dining Nook"]'::jsonb)
       RETURNING id`,
      [prop1Id]
    );

    const rtStd = rtStdRes.rows[0].id as string;
    const rtDlx = rtDlxRes.rows[0].id as string;
    const rtSte = rtSteRes.rows[0].id as string;
    const rtFam = rtFamRes.rows[0].id as string;

    // 5. Physical Rooms for Property 1 (12 rooms)
    const roomsSpec = [
      { num: '101', floor: '1', rt: rtStd, op: 'available', hk: 'inspected', notes: '' },
      { num: '102', floor: '1', rt: rtStd, op: 'available', hk: 'clean', notes: '' },
      { num: '103', floor: '1', rt: rtStd, op: 'available', hk: 'dirty', notes: 'Recent checkout turnover needed' },
      { num: '104', floor: '1', rt: rtStd, op: 'maintenance', hk: 'out_of_service', notes: 'AC compressor servicing scheduled' },
      { num: '201', floor: '2', rt: rtDlx, op: 'available', hk: 'inspected', notes: '' },
      { num: '202', floor: '2', rt: rtDlx, op: 'available', hk: 'clean', notes: '' },
      { num: '203', floor: '2', rt: rtDlx, op: 'available', hk: 'inspected', notes: '' },
      { num: '204', floor: '2', rt: rtDlx, op: 'available', hk: 'dirty', notes: 'Linen refresh pending' },
      { num: '301', floor: '3', rt: rtSte, op: 'available', hk: 'inspected', notes: 'VIP welcome amenities stocked' },
      { num: '302', floor: '3', rt: rtSte, op: 'available', hk: 'clean', notes: '' },
      { num: '303', floor: '3', rt: rtFam, op: 'available', hk: 'inspected', notes: '' },
      { num: '304', floor: '3', rt: rtFam, op: 'available', hk: 'clean', notes: '' },
    ];

    const roomIds: Record<string, string> = {};
    for (const r of roomsSpec) {
      const ins = await client.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [prop1Id, r.rt, r.num, r.floor, r.op, r.hk, r.notes]
      );
      roomIds[r.num] = ins.rows[0].id as string;
    }

    // Also add 2 Room Types & 4 Rooms to Property 2
    const p2Rt = await client.query(
      `INSERT INTO room_types (property_id, code, name, description, base_capacity, max_capacity, base_rate, amenities)
       VALUES ($1, 'HAR', 'Harbor View King', 'Modern sea-facing king room.', 2, 3, 8500, '["Wi-Fi", "Sea View", "Minibar"]'::jsonb)
       RETURNING id`,
      [prop2Id]
    );
    for (const num of ['401', '402', '403', '404']) {
      await client.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, floor, operational_status, housekeeping_status)
         VALUES ($1, $2, $3, '4', 'available', 'inspected')`,
        [prop2Id, p2Rt.rows[0].id, num]
      );
    }

    // 6. Guests for Property 1
    const guestsSpec = [
      { first: 'Rohan', last: 'Kulkarni', email: 'rohan.kulkarni@example.com', phone: '+91 98201 11402', city: 'Pune', country: 'India', vip: true, notes: 'Prefers high floor and extra feather pillows.' },
      { first: 'Elena', last: 'Rostova', email: 'elena.rostova@example.com', phone: '+44 7700 900412', city: 'London', country: 'United Kingdom', vip: false, notes: 'Airport pickup requested; vegetarian breakfast.' },
      { first: 'Vikram', last: 'Desai', email: 'vikram.desai@example.com', phone: '+91 98112 77890', city: 'Ahmedabad', country: 'India', vip: true, notes: 'Corporate traveler, early morning tea.' },
      { first: 'Ananya', last: 'Chatterjee', email: 'ananya.c@example.com', phone: '+91 98300 55219', city: 'Kolkata', country: 'India', vip: false, notes: 'Celebrating wedding anniversary.' },
      { first: 'Marcus', last: 'Lindqvist', email: 'marcus.l@example.com', phone: '+46 70 174 0620', city: 'Stockholm', country: 'Sweden', vip: false, notes: 'Quiet room away from elevator.' },
      { first: 'Meera', last: 'Subramanian', email: 'meera.s@example.com', phone: '+91 98401 33910', city: 'Chennai', country: 'India', vip: false, notes: 'Traveling with two children.' },
      { first: 'Kabir', last: 'Malhotra', email: 'kabir.m@example.com', phone: '+91 98711 60921', city: 'New Delhi', country: 'India', vip: false, notes: '' },
    ];

    const guestIds: string[] = [];
    for (const g of guestsSpec) {
      const ins = await client.query(
        `INSERT INTO guests (property_id, first_name, last_name, email, phone, city, country, vip_status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [prop1Id, g.first, g.last, g.email, g.phone, g.city, g.country, g.vip, g.notes]
      );
      guestIds.push(ins.rows[0].id as string);
    }

    // 7. Realistic Reservations anchored to today
    const seedBookings = [
      // In-house Checked-In guest staying across tonight
      {
        ref: 'KHB-SEED-1001',
        guest: guestIds[0],
        rt: rtSte,
        room: roomIds['301'],
        arr: addDays(today, -2),
        dep: addDays(today, 2),
        adults: 2,
        children: 0,
        rate: 9800,
        discount: 800,
        source: 'website',
        walkIn: false,
        status: 'checked_in',
        req: 'Late evening boat tour concierge arrangement',
      },
      // In-house Checked-In guest due for Check-Out TODAY
      {
        ref: 'KHB-SEED-1002',
        guest: guestIds[2],
        rt: rtDlx,
        room: roomIds['201'],
        arr: addDays(today, -2),
        dep: today,
        adults: 1,
        children: 0,
        rate: 6200,
        discount: 0,
        source: 'corporate',
        walkIn: false,
        status: 'checked_in',
        req: 'GST invoice required at check-out',
      },
      // In-house Family stay
      {
        ref: 'KHB-SEED-1003',
        guest: guestIds[5],
        rt: rtFam,
        room: roomIds['303'],
        arr: addDays(today, -1),
        dep: addDays(today, 3),
        adults: 2,
        children: 2,
        rate: 11500,
        discount: 500,
        source: 'direct',
        walkIn: false,
        status: 'checked_in',
        req: 'Extra child cot provided',
      },
      // Arrival TODAY (Confirmed, ready to Check In into clean Room 202)
      {
        ref: 'KHB-SEED-1004',
        guest: guestIds[1],
        rt: rtDlx,
        room: roomIds['202'],
        arr: today,
        dep: addDays(today, 3),
        adults: 2,
        children: 0,
        rate: 6200,
        discount: 0,
        source: 'ota_booking',
        walkIn: false,
        status: 'confirmed',
        req: 'Airport transfer landing at 13:15',
      },
      // Arrival TODAY (Pending confirmation, Room 101 inspected)
      {
        ref: 'KHB-SEED-1005',
        guest: guestIds[3],
        rt: rtStd,
        room: roomIds['101'],
        arr: today,
        dep: addDays(today, 2),
        adults: 2,
        children: 0,
        rate: 4200,
        discount: 200,
        source: 'phone',
        walkIn: false,
        status: 'pending',
        req: 'Anniversary flower arrangement requested',
      },
      // Upcoming Confirmed Booking starting in 2 days
      {
        ref: 'KHB-SEED-1006',
        guest: guestIds[4],
        rt: rtSte,
        room: roomIds['302'],
        arr: addDays(today, 2),
        dep: addDays(today, 5),
        adults: 2,
        children: 0,
        rate: 9800,
        discount: 0,
        source: 'ota_expedia',
        walkIn: false,
        status: 'confirmed',
        req: 'Quiet top-floor room',
      },
      // Past Checked-Out Booking (completed this morning in Room 103)
      {
        ref: 'KHB-SEED-1007',
        guest: guestIds[6],
        rt: rtStd,
        room: roomIds['103'],
        arr: addDays(today, -3),
        dep: today,
        adults: 1,
        children: 0,
        rate: 4200,
        discount: 0,
        source: 'walk_in',
        walkIn: true,
        status: 'checked_out',
        req: '',
      },
      // Cancelled Booking (does NOT block Room 102 availability!)
      {
        ref: 'KHB-SEED-1008',
        guest: guestIds[6],
        rt: rtStd,
        room: roomIds['102'],
        arr: today,
        dep: addDays(today, 2),
        adults: 2,
        children: 0,
        rate: 4200,
        discount: 0,
        source: 'website',
        walkIn: false,
        status: 'cancelled',
        req: '',
      },
    ];

    for (const b of seedBookings) {
      const nights = diffDays(b.arr, b.dep);
      const fin = calculateReservationFinancials({
        nights,
        nightlyRate: b.rate,
        discountAmount: b.discount,
        taxRate: 12,
      });

      const resIns = await client.query(
        `INSERT INTO reservations (
           property_id, booking_reference, guest_id, room_type_id, room_id,
           arrival_date, departure_date, adults, children, num_guests,
           nightly_rate, discount_amount, tax_rate, tax_amount, estimated_total,
           currency, source, is_walk_in, status, special_requests,
           cancellation_reason, cancelled_at, checked_in_at, checked_out_at,
           created_by, updated_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           $11,$12,12.00,$13,$14,'INR',$15,$16,$17,$18,
           $19,$20,$21,$22,$23,$23
         ) RETURNING id`,
        [
          prop1Id,
          b.ref,
          b.guest,
          b.rt,
          b.room,
          b.arr,
          b.dep,
          b.adults,
          b.children,
          b.adults + b.children,
          fin.nightlyRate,
          fin.discountAmount,
          fin.taxAmount,
          fin.estimatedTotal,
          b.source,
          b.walkIn,
          b.status,
          b.req,
          b.status === 'cancelled' ? 'Guest flight rescheduled' : '',
          b.status === 'cancelled' ? new Date().toISOString() : null,
          b.status === 'checked_in' || b.status === 'checked_out'
            ? new Date(Date.now() - 86_400_000).toISOString()
            : null,
          b.status === 'checked_out' ? new Date().toISOString() : null,
          adminId,
        ]
      );

      await client.query(
        `INSERT INTO reservation_status_history (
           reservation_id, property_id, from_status, to_status, action, note, changed_by
         ) VALUES ($1, $2, NULL, $3, 'seeded', $4, $5)`,
        [
          resIns.rows[0].id,
          prop1Id,
          b.status,
          `Initial reservation state (${b.status})`,
          adminId,
        ]
      );
    }
  });

  console.log('Seeded StayCraft PMS with initial properties, rooms, guests, and reservations.');
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  seedDatabase()
    .then(async () => {
      await closePool();
    })
    .catch(async (err) => {
      console.error('Seed failed:', sanitizeErrorForLog(err));
      await closePool();
      process.exit(1);
    });
}
