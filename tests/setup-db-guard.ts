import type pg from 'pg';
import { beforeAll, beforeEach } from 'vitest';
import {
  resolveDatabaseUrl,
  TEST_DATABASE_NAME,
} from '../src/server/config.js';
import { closePool, getPool } from '../src/server/db/pool.js';

/**
 * Fail-closed database identity verification for automated test runs.
 * Rejects missing environment configuration, non-test NODE_ENV, or any live PostgreSQL
 * connection whose current_database() is missing or not strictly "staycraft_pms_test".
 */
export async function verifyTestDatabaseIdentity(
  db: Pick<pg.Pool, 'query'> = getPool(),
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if ((env.NODE_ENV ?? '').trim() !== 'test') {
    throw new Error(
      `FAIL-CLOSED TEST GUARD: Expected NODE_ENV="test", received "${env.NODE_ENV ?? ''}".`
    );
  }

  // Validates TEST_DATABASE_URL is explicitly configured and points solely to staycraft_pms_test
  resolveDatabaseUrl(env);

  const res = await db.query<{ db: string }>('SELECT current_database() AS db');
  const connectedDb = String(res.rows[0]?.db ?? '').trim();

  if (!connectedDb || connectedDb !== TEST_DATABASE_NAME) {
    throw new Error(
      `FAIL-CLOSED TEST GUARD: Expected current_database() === "${TEST_DATABASE_NAME}", received "${connectedDb || '<empty>'}".`
    );
  }

  return connectedDb;
}

beforeAll(async () => {
  try {
    await verifyTestDatabaseIdentity();
  } catch (err) {
    await closePool().catch(() => undefined);
    throw err;
  }
});

beforeEach(async () => {
  try {
    await verifyTestDatabaseIdentity();
  } catch (err) {
    await closePool().catch(() => undefined);
    throw err;
  }
});
