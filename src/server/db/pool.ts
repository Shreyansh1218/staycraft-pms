import pg from 'pg';
import { resolveDatabaseUrl, sanitizeErrorForLog } from '../config.js';

const { Pool, types } = pg;

// Keep PostgreSQL DATE (OID 1082) as 'YYYY-MM-DD' string to prevent UTC timezone shifts
types.setTypeParser(1082, (val: string) => val);

let poolInstance: pg.Pool | null = null;
let poolConnectionString: string | null = null;

export function getPool(): pg.Pool {
  const resolvedUrl = resolveDatabaseUrl(process.env);
  if (!poolInstance || poolConnectionString !== resolvedUrl) {
    if (poolInstance) {
      void poolInstance.end().catch(() => {});
    }
    const createdPool = new Pool({
      connectionString: resolvedUrl,
      max: 20,
      idleTimeoutMillis: 30_000,
    });
    createdPool.on('error', (err) => {
      console.error('[PostgreSQL Pool Error]', sanitizeErrorForLog(err));
    });
    poolInstance = createdPool;
    poolConnectionString = resolvedUrl;
  }
  return poolInstance;
}

export async function closePool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
    poolConnectionString = null;
  }
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
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
