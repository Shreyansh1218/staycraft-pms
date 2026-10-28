import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { sanitizeErrorForLog } from '../config.js';
import { closePool, getPool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = [
  path.resolve(__dirname, '../../../migrations'),
  path.resolve(__dirname, '../../../../migrations'),
  path.resolve(process.cwd(), 'migrations'),
].find((candidate) => fsSync.existsSync(candidate)) ?? path.resolve(process.cwd(), 'migrations');

export const PRODUCTION_DATABASE_NAME = 'staycraft_pms';
export const PREVIEW_DATABASE_NAME = 'staycraft_pms_preview';
export const TEST_DATABASE_NAME = 'staycraft_pms_test';
export const PRODUCTION_MIGRATION_AUTH_ENV = 'ALLOW_PRODUCTION_MIGRATIONS';

export interface MigrationPoolLike {
  query: pg.Pool['query'];
  connect: pg.Pool['connect'];
}

export interface RunMigrationsOptions {
  pool?: MigrationPoolLike;
  env?: NodeJS.ProcessEnv;
  migrationsDir?: string;
}

export async function assertMigrationTargetAuthorized(
  pool: Pick<pg.Pool, 'query'>,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const dbCheck = await pool.query<{ db: string }>('SELECT current_database() AS db');
  const connectedDb = String(dbCheck.rows[0]?.db ?? '').trim();

  if (!connectedDb) {
    throw new Error(
      'Refusing to run migrations: unable to verify connected PostgreSQL database name.'
    );
  }

  if (env.NODE_ENV === 'test') {
    if (connectedDb !== TEST_DATABASE_NAME) {
      throw new Error(
        `Refusing to run test migrations against non-test database: "${connectedDb}"`
      );
    }
    return connectedDb;
  }

  if (env.STAYCRAFT_DB_ROLE === 'preview') {
    if (connectedDb !== PREVIEW_DATABASE_NAME) {
      throw new Error(
        `Refusing to run preview migrations against non-preview database: "${connectedDb}"`
      );
    }
    return connectedDb;
  }

  const isProductionTarget =
    connectedDb === PRODUCTION_DATABASE_NAME || env.NODE_ENV === 'production';

  if (isProductionTarget && env[PRODUCTION_MIGRATION_AUTH_ENV] !== 'true') {
    throw new Error(
      `Refusing to run migrations against production database "${connectedDb}" without explicit authorization. Set ${PRODUCTION_MIGRATION_AUTH_ENV}=true for an explicitly authorized production migration window, or target a non-production database (${PREVIEW_DATABASE_NAME} / ${TEST_DATABASE_NAME}).`
    );
  }

  return connectedDb;
}

export async function runMigrations(
  options: RunMigrationsOptions = {}
): Promise<string[]> {
  const pool = options.pool ?? getPool();
  const env = options.env ?? process.env;
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;

  await assertMigrationTargetAuthorized(pool, env);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const appliedRes = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations ORDER BY filename ASC'
  );
  const applied = new Set(appliedRes.rows.map((r) => r.filename));

  const entries = await fs.readdir(migrationsDir);
  const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort();

  const newlyApplied: string[] = [];

  for (const filename of sqlFiles) {
    if (applied.has(filename)) continue;
    const sqlPath = path.join(migrationsDir, filename);
    const sql = await fs.readFile(sqlPath, 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      newlyApplied.push(filename);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return newlyApplied;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runMigrations()
    .then(async (applied) => {
      if (applied.length === 0) {
        console.log('Database migrations are already up to date.');
      } else {
        console.log(`Applied migrations: ${applied.join(', ')}`);
      }
      await closePool();
    })
    .catch(async (err) => {
      console.error('Migration failed:', sanitizeErrorForLog(err));
      await closePool();
      process.exit(1);
    });
}
