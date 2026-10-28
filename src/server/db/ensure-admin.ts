import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import {
  PREVIEW_DATABASE_NAME,
  PRODUCTION_DATABASE_NAME,
  sanitizeErrorForLog,
  TEST_DATABASE_NAME,
} from '../config.js';
import { closePool, getPool, type Queryable } from './pool.js';
import { hashPassword } from '../security/password.js';

const DEV_DEMO_ADMIN_PASSWORD = 'Admin@12345';

export const REQUIRED_ADMIN_CORE_TABLES = [
  'users',
  'user_sessions',
  'properties',
  'user_property_access',
] as const;

export interface EnsureAdminOptions {
  email?: string;
  password?: string;
  fullName?: string;
  phone?: string;
  resetPassword?: boolean;
  pool?: pg.Pool;
  env?: NodeJS.ProcessEnv;
}

export interface EnsureAdminResult {
  userId: string;
  email: string;
  action: 'created' | 'password_reset' | 'verified_existing';
}

export async function verifyAdminCoreSchema(
  db: Queryable = getPool()
): Promise<void> {
  const schemaRes = await db.query<{ schema_name: string | null }>(
    'SELECT current_schema() AS schema_name'
  );
  const activeSchema = schemaRes.rows[0]?.schema_name;

  if (!activeSchema) {
    throw new Error(
      'Cannot run administrator account recovery: no active PostgreSQL schema exists. Admin recovery never executes pending migrations automatically; run authorized database migrations separately first.'
    );
  }

  const res = await db.query<{ table_name: string; present: boolean }>(
    `SELECT req.table_name,
            EXISTS (
              SELECT 1
              FROM pg_catalog.pg_class c
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1
                AND c.relname = req.table_name
                AND c.relkind IN ('r', 'p')
            ) AS present
     FROM unnest($2::text[]) WITH ORDINALITY AS req(table_name, ord)
     ORDER BY req.ord ASC`,
    [activeSchema, [...REQUIRED_ADMIN_CORE_TABLES]]
  );

  const missingTables = res.rows
    .filter((row) => !row.present)
    .map((row) => row.table_name);

  if (missingTables.length > 0) {
    throw new Error(
      `Cannot run administrator account recovery: missing required core database table(s) [${missingTables.join(
        ', '
      )}]. Admin recovery never executes pending migrations automatically; run authorized database migrations separately first (for example: npm run db:migrate on a non-production database, or an explicitly authorized production migration).`
    );
  }
}

async function runInPoolTransaction<T>(
  pool: pg.Pool,
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

export async function assertAdminTargetAuthorized(
  db: Pick<pg.Pool, 'query'> = getPool(),
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const dbCheck = await db.query<{ db: string }>('SELECT current_database() AS db');
  const connectedDb = String(dbCheck.rows[0]?.db ?? '').trim();

  if (!connectedDb) {
    throw new Error(
      'Refusing administrator account operation: unable to verify connected PostgreSQL database name.'
    );
  }

  if (env.NODE_ENV === 'test' && connectedDb !== TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing to run test admin account operation against non-test database: "${connectedDb}"`
    );
  }

  if (env.STAYCRAFT_DB_ROLE === 'preview' && connectedDb !== PREVIEW_DATABASE_NAME) {
    throw new Error(
      `Refusing to run preview admin account operation against non-preview database: "${connectedDb}"`
    );
  }

  if (
    connectedDb === PRODUCTION_DATABASE_NAME &&
    env.NODE_ENV !== 'production'
  ) {
    throw new Error(
      `Refusing to run admin account operation against production database "${PRODUCTION_DATABASE_NAME}" outside NODE_ENV=production.`
    );
  }

  return connectedDb;
}

export async function ensureInitialAdminAccount(
  options: EnsureAdminOptions = {}
): Promise<EnsureAdminResult> {
  const env = options.env ?? process.env;
  const email = (options.email ?? env.ADMIN_EMAIL ?? 'admin@staycraft.local')
    .trim()
    .toLowerCase();
  const explicitPassword = options.password ?? env.ADMIN_PASSWORD;
  const password = explicitPassword ?? DEV_DEMO_ADMIN_PASSWORD;
  const fullName = (options.fullName ?? env.ADMIN_FULL_NAME ?? 'Aarav Mehta').trim();
  const phone = (options.phone ?? '+91 98110 24001').trim();
  const resetPassword = Boolean(options.resetPassword);

  if (!email.includes('@')) {
    throw new Error('ADMIN_EMAIL must be a valid email address.');
  }
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters long.');
  }

  const targetPool = options.pool ?? getPool();
  const connectedDb = await assertAdminTargetAuthorized(targetPool, env);
  const isRealProduction =
    (connectedDb === PRODUCTION_DATABASE_NAME || env.NODE_ENV === 'production') &&
    env.STAYCRAFT_DB_ROLE !== 'preview';

  await verifyAdminCoreSchema(targetPool);

  return runInPoolTransaction(targetPool, async (client) => {
    const existingRes = await client.query(
      'SELECT id, role, is_active FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1 FOR UPDATE',
      [email]
    );

    let userId: string;
    let action: EnsureAdminResult['action'];

    const willWritePassword = existingRes.rowCount === 0 || resetPassword;
    if (isRealProduction && willWritePassword) {
      if (
        !explicitPassword ||
        explicitPassword === DEV_DEMO_ADMIN_PASSWORD ||
        explicitPassword.length < 12
      ) {
        throw new Error(
          'Refusing to provision or reset production administrator account with default or weak password. Set an explicit strong ADMIN_PASSWORD (at least 12 characters) in production.'
        );
      }
    }

    if (existingRes.rowCount === 0) {
      const passwordHash = await hashPassword(password);
      const inserted = await client.query(
        `INSERT INTO users (email, password_hash, full_name, role, phone, is_active)
         VALUES ($1, $2, $3, 'admin', $4, TRUE)
         RETURNING id`,
        [email, passwordHash, fullName, phone]
      );
      userId = inserted.rows[0].id as string;
      action = 'created';
    } else {
      userId = existingRes.rows[0].id as string;
      if (resetPassword) {
        const passwordHash = await hashPassword(password);
        await client.query(
          `UPDATE users
           SET password_hash = $1,
               role = 'admin',
               is_active = TRUE,
               updated_at = NOW()
           WHERE id = $2`,
          [passwordHash, userId]
        );
        await client.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
        action = 'password_reset';
      } else {
        await client.query(
          `UPDATE users
           SET role = 'admin',
               is_active = TRUE,
               updated_at = NOW()
           WHERE id = $1`,
          [userId]
        );
        action = 'verified_existing';
      }
    }

    // Link admin user to active properties if not already linked
    const propsRes = await client.query(
      'SELECT id FROM properties WHERE is_active = TRUE ORDER BY created_at ASC'
    );
    const hasDefaultRes = await client.query(
      'SELECT 1 FROM user_property_access WHERE user_id = $1 AND is_default = TRUE LIMIT 1',
      [userId]
    );
    let hasDefault = (hasDefaultRes.rowCount ?? 0) > 0;

    for (const row of propsRes.rows) {
      const makeDefault = !hasDefault;
      await client.query(
        `INSERT INTO user_property_access (user_id, property_id, is_default)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, property_id) DO NOTHING`,
        [userId, row.id, makeDefault]
      );
      if (makeDefault) {
        hasDefault = true;
      }
    }

    return { userId, email, action };
  });
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const resetFlag = process.argv.includes('--reset');
  ensureInitialAdminAccount({ resetPassword: resetFlag })
    .then(async (res) => {
      console.log(
        `Initial administrator account (${res.email}): ${res.action.replace(/_/g, ' ')}.`
      );
      await closePool();
    })
    .catch(async (err) => {
      console.error(
        'Failed to ensure initial administrator account:',
        sanitizeErrorForLog(err)
      );
      await closePool();
      process.exit(1);
    });
}
