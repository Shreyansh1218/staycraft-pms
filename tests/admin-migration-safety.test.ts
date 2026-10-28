import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  config,
  redactConnectionStrings,
  resolveDatabaseUrl,
  sanitizeErrorForLog,
} from '../src/server/config.js';
import {
  ensureInitialAdminAccount,
  REQUIRED_ADMIN_CORE_TABLES,
} from '../src/server/db/ensure-admin.js';
import {
  assertMigrationTargetAuthorized,
  PRODUCTION_MIGRATION_AUTH_ENV,
  runMigrations,
  type MigrationPoolLike,
} from '../src/server/db/migrate.js';
import { closePool, getPool, type Queryable } from '../src/server/db/pool.js';
import {
  assertSeedTargetAuthorized,
  seedDatabase,
} from '../src/server/db/seed.js';

async function assertTestDatabase(db: Queryable): Promise<void> {
  const res = await db.query<{ db: string }>('SELECT current_database() AS db');
  expect(res.rows[0]?.db).toBe('staycraft_pms_test');
}

function createMockMigrationPool(connectedDb: string | null): {
  pool: MigrationPoolLike;
  queries: string[];
  connectCalls: number;
} {
  const queries: string[] = [];
  let connectCalls = 0;

  const queryFn = (async (text: string) => {
    queries.push(String(text).trim());
    if (String(text).includes('current_database()')) {
      return {
        rows: connectedDb === null ? [] : [{ db: connectedDb }],
        rowCount: connectedDb === null ? 0 : 1,
      };
    }
    if (String(text).includes('SELECT filename FROM schema_migrations')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }) as unknown as pg.Pool['query'];

  const connectFn = (async () => {
    connectCalls += 1;
    throw new Error('Unexpected pool.connect() call in migration/seed guard test');
  }) as unknown as pg.Pool['connect'];

  return {
    pool: {
      query: queryFn,
      connect: connectFn,
    },
    queries,
    get connectCalls() {
      return connectCalls;
    },
  };
}

describe('Database Safety Guards: Config, Seed Block, Migration Guard & Admin Recovery Decoupling', () => {
  beforeAll(async () => {
    const pool = getPool();
    await assertTestDatabase(pool);
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it('never silently defaults to staycraft_pms when DATABASE_URL is missing and redacts connection secrets', () => {
    // 1. Missing DATABASE_URL in development or production fails fast instead of selecting staycraft_pms
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'development' })).toThrowError(
      /Missing required DATABASE_URL environment variable.*never defaults to production "staycraft_pms"/i
    );
    expect(() =>
      resolveDatabaseUrl({ NODE_ENV: 'development', DATABASE_URL: '   ' })
    ).toThrowError(/Missing required DATABASE_URL environment variable/i);
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'production' })).toThrowError(
      /Missing required DATABASE_URL environment variable/i
    );

    // 2. Non-production environments reject accidental DATABASE_URL targeting staycraft_pms
    expect(() =>
      resolveDatabaseUrl({
        NODE_ENV: 'development',
        DATABASE_URL:
          'postgresql://user:SuperSecretPass99@localhost:5432/staycraft_pms',
      })
    ).toThrowError(
      /Refusing to select production database "staycraft_pms" when NODE_ENV="development"/i
    );

    // 3. Preview role accepts ONLY staycraft_pms_preview
    expect(() =>
      resolveDatabaseUrl({
        NODE_ENV: 'production',
        STAYCRAFT_DB_ROLE: 'preview',
      })
    ).toThrowError(
      /Missing required PREVIEW_DATABASE_URL \(or DATABASE_URL\) environment variable/i
    );

    expect(() =>
      resolveDatabaseUrl({
        NODE_ENV: 'production',
        STAYCRAFT_DB_ROLE: 'preview',
        PREVIEW_DATABASE_URL:
          'postgresql://user:SecretPreviewPass@localhost:5432/staycraft_pms',
      })
    ).toThrowError(
      /Refusing to configure preview runtime with non-preview database "staycraft_pms"/i
    );

    expect(
      resolveDatabaseUrl({
        NODE_ENV: 'production',
        STAYCRAFT_DB_ROLE: 'preview',
        PREVIEW_DATABASE_URL:
          'postgresql://postgres@localhost:5432/staycraft_pms_preview',
      })
    ).toBe('postgresql://postgres@localhost:5432/staycraft_pms_preview');

    // 4. Test environment requires explicit TEST_DATABASE_URL targeting ONLY staycraft_pms_test
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'test' })).toThrowError(
      /Missing required TEST_DATABASE_URL environment variable/i
    );

    expect(() =>
      resolveDatabaseUrl({
        NODE_ENV: 'test',
        TEST_DATABASE_URL:
          'postgresql://postgres:TopSecretTestPass@localhost:5432/staycraft_pms',
      })
    ).toThrowError(
      /Refusing to configure test runtime with non-test database "staycraft_pms"/i
    );

    expect(
      resolveDatabaseUrl({
        NODE_ENV: 'test',
        TEST_DATABASE_URL:
          'postgresql://postgres@localhost:5432/staycraft_pms_test',
      })
    ).toContain('/staycraft_pms_test');

    // 5. Explicit dev and explicit prod URLs continue to work cleanly
    expect(
      resolveDatabaseUrl({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://postgres@localhost:5432/staycraft_pms_dev',
      })
    ).toBe('postgresql://postgres@localhost:5432/staycraft_pms_dev');

    expect(
      resolveDatabaseUrl({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://postgres@localhost:5432/staycraft_pms',
      })
    ).toBe('postgresql://postgres@localhost:5432/staycraft_pms');

    // 6. Malformed URLs & error sanitizers never leak credentials
    const secretConn =
      'postgresql://admin_user:UltraSensitiveSecret!23@db.internal.example:5432/staycraft_pms';
    try {
      resolveDatabaseUrl({
        NODE_ENV: 'development',
        DATABASE_URL: 'not-a-valid-uri://admin:UltraSensitiveSecret!23@bad host',
      });
      expect.unreachable('Expected malformed DATABASE_URL to throw');
    } catch (err) {
      const msg = sanitizeErrorForLog(err);
      expect(msg).not.toContain('UltraSensitiveSecret!23');
    }

    const sanitized = redactConnectionStrings(
      `Connection failed for ${secretConn} during startup`
    );
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('UltraSensitiveSecret!23');
    expect(sanitized).not.toContain('db.internal.example');
  });

  it('unconditionally blocks seedDatabase on staycraft_pms even when ALLOW_PRODUCTION_MIGRATIONS=true', async () => {
    const envMatrix: NodeJS.ProcessEnv[] = [
      { NODE_ENV: 'development' },
      { NODE_ENV: 'production' },
      {
        NODE_ENV: 'production',
        [PRODUCTION_MIGRATION_AUTH_ENV]: 'true',
      },
      {
        NODE_ENV: 'development',
        [PRODUCTION_MIGRATION_AUTH_ENV]: 'true',
      },
    ];

    for (const env of envMatrix) {
      const mock = createMockMigrationPool('staycraft_pms');

      await expect(
        assertSeedTargetAuthorized(mock.pool, env)
      ).rejects.toThrowError(
        /Refusing to seed production database "staycraft_pms".*ALLOW_PRODUCTION_MIGRATIONS/i
      );

      await expect(
        seedDatabase({ pool: mock.pool, env })
      ).rejects.toThrowError(
        /Refusing to seed production database "staycraft_pms"/i
      );

      // Only SELECT current_database() was checked; zero migrations or seed transactions ran
      expect(mock.connectCalls).toBe(0);
      expect(
        mock.queries.every((q) => q.includes('current_database()'))
      ).toBe(true);
    }

    // Also blocks non-test DB in test mode and non-preview DB in preview mode
    const wrongTestMock = createMockMigrationPool('staycraft_pms_dev');
    await expect(
      seedDatabase({ pool: wrongTestMock.pool, env: { NODE_ENV: 'test' } })
    ).rejects.toThrowError(/Refusing to run test seed against non-test database/i);
    expect(wrongTestMock.connectCalls).toBe(0);

    const wrongPreviewMock = createMockMigrationPool('staycraft_pms_dev');
    await expect(
      seedDatabase({
        pool: wrongPreviewMock.pool,
        env: { NODE_ENV: 'production', STAYCRAFT_DB_ROLE: 'preview' },
      })
    ).rejects.toThrowError(
      /Refusing to run preview seed against non-preview database/i
    );
    expect(wrongPreviewMock.connectCalls).toBe(0);
  });

  it('does not execute pending migrations or modify schema_migrations during admin account creation, verification, or password reset', async () => {
    const pool = getPool();
    await assertTestDatabase(pool);

    const pendingFilenames = [
      '006_phase5_inventory_suppliers.sql',
      '007_phase6_expenses_reports.sql',
      '008_phase7_services_staff_users.sql',
      '009_guest_food_ordering_and_account_management.sql',
    ];
    const testAdminEmail = `decoupled.admin.${Date.now()}@test.local`;

    // Confirm the pending migration SQL files genuinely exist on disk in migrations/
    for (const file of pendingFilenames) {
      const stat = await fs.stat(path.resolve(process.cwd(), 'migrations', file));
      expect(stat.isFile()).toBe(true);
    }

    const savedRowsRes = await pool.query<{ filename: string; applied_at: Date }>(
      `SELECT filename, applied_at
       FROM schema_migrations
       WHERE filename = ANY($1::text[])
       ORDER BY filename ASC`,
      [pendingFilenames]
    );
    expect(savedRowsRes.rows.map((r) => r.filename)).toEqual(pendingFilenames);

    try {
      await assertTestDatabase(pool);
      await pool.query(
        'DELETE FROM schema_migrations WHERE filename = ANY($1::text[])',
        [pendingFilenames]
      );

      const beforeRecovery = await pool.query<{ filename: string; applied_at: Date }>(
        'SELECT filename, applied_at FROM schema_migrations ORDER BY filename ASC'
      );
      expect(beforeRecovery.rows.map((r) => r.filename)).toEqual([
        '001_core_pms.sql',
        '002_future_modules_foundation.sql',
        '003_phase2_room_operations.sql',
        '004_phase3_billing_invoices.sql',
        '005_phase4_food_restaurant.sql',
      ]);

      await assertTestDatabase(pool);
      const created = await ensureInitialAdminAccount({
        email: testAdminEmail,
        password: 'SafeAdminPassword#1',
        fullName: 'Decoupled Recovery Admin',
      });
      expect(created.action).toBe('created');

      await assertTestDatabase(pool);
      const verified = await ensureInitialAdminAccount({
        email: testAdminEmail,
        password: 'SafeAdminPassword#1',
        resetPassword: false,
      });
      expect(verified.action).toBe('verified_existing');

      await assertTestDatabase(pool);
      const reset = await ensureInitialAdminAccount({
        email: testAdminEmail,
        password: 'SafeAdminPassword#2',
        resetPassword: true,
      });
      expect(reset.action).toBe('password_reset');

      const afterRecovery = await pool.query<{ filename: string; applied_at: Date }>(
        'SELECT filename, applied_at FROM schema_migrations ORDER BY filename ASC'
      );

      expect(afterRecovery.rows.map((r) => r.filename)).toEqual(
        beforeRecovery.rows.map((r) => r.filename)
      );
      expect(
        afterRecovery.rows.map((r) => r.applied_at.toISOString())
      ).toEqual(beforeRecovery.rows.map((r) => r.applied_at.toISOString()));
      expect(afterRecovery.rows.some((r) => pendingFilenames.includes(r.filename))).toBe(
        false
      );
    } finally {
      await assertTestDatabase(pool);
      for (const row of savedRowsRes.rows) {
        await pool.query(
          `INSERT INTO schema_migrations (filename, applied_at)
           VALUES ($1, $2)
           ON CONFLICT (filename) DO NOTHING`,
          [row.filename, row.applied_at]
        );
      }
      await pool.query('DELETE FROM users WHERE LOWER(email) = LOWER($1)', [
        testAdminEmail,
      ]);
    }
  });

  it('stops fast with clear instructions when required core tables are missing instead of running migrations', async () => {
    const pool = getPool();
    await assertTestDatabase(pool);

    const isolatedSchema = 'admin_preflight_isolated_test';
    const isolatedPool = new pg.Pool({
      connectionString: config.databaseUrl,
      options: `-c search_path=${isolatedSchema}`,
    });

    try {
      await assertTestDatabase(pool);
      await pool.query(`DROP SCHEMA IF EXISTS ${isolatedSchema} CASCADE`);
      await pool.query(`CREATE SCHEMA ${isolatedSchema}`);

      await assertTestDatabase(isolatedPool);

      await expect(
        ensureInitialAdminAccount({
          email: 'missing.tables@test.local',
          password: 'SafeAdminPassword#1',
          pool: isolatedPool,
        })
      ).rejects.toThrowError(
        new RegExp(
          `missing required core database table\\(s\\) \\[${REQUIRED_ADMIN_CORE_TABLES.join(
            ', '
          )}\\].*run authorized database migrations separately`,
          'i'
        )
      );

      await assertTestDatabase(pool);
      await pool.query(`
        CREATE TABLE ${isolatedSchema}.users (
          id UUID PRIMARY KEY,
          email TEXT NOT NULL
        )
      `);

      await expect(
        ensureInitialAdminAccount({
          email: 'partial.tables@test.local',
          password: 'SafeAdminPassword#1',
          pool: isolatedPool,
        })
      ).rejects.toThrowError(
        /missing required core database table\(s\) \[user_sessions, properties, user_property_access\].*run authorized database migrations separately/i
      );

      const userCountRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${isolatedSchema}.users`
      );
      expect(userCountRes.rows[0]?.count).toBe('0');
    } finally {
      await isolatedPool.end();
      await assertTestDatabase(pool);
      await pool.query(`DROP SCHEMA IF EXISTS ${isolatedSchema} CASCADE`);
    }
  });

  it('fails closed when runMigrations targets staycraft_pms without explicit authorization and never executes DDL', async () => {
    for (const invalidAuthValue of [undefined, '', 'false', '0', '1', 'yes', 'TRUE']) {
      const mock = createMockMigrationPool('staycraft_pms');
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: 'development',
        ...(invalidAuthValue !== undefined
          ? { [PRODUCTION_MIGRATION_AUTH_ENV]: invalidAuthValue }
          : {}),
      };

      await expect(
        runMigrations({ pool: mock.pool, env })
      ).rejects.toThrowError(
        /Refusing to run migrations against production database "staycraft_pms" without explicit authorization/
      );

      expect(mock.queries).toHaveLength(1);
      expect(mock.queries[0]).toContain('current_database()');
      expect(mock.connectCalls).toBe(0);
    }

    const unknownDbMock = createMockMigrationPool(null);
    await expect(
      runMigrations({
        pool: unknownDbMock.pool,
        env: { NODE_ENV: 'development', [PRODUCTION_MIGRATION_AUTH_ENV]: 'true' },
      })
    ).rejects.toThrowError(/unable to verify connected PostgreSQL database name/);
    expect(unknownDbMock.queries).toHaveLength(1);

    const mispointedTestMock = createMockMigrationPool('staycraft_pms');
    await expect(
      runMigrations({
        pool: mispointedTestMock.pool,
        env: { NODE_ENV: 'test', [PRODUCTION_MIGRATION_AUTH_ENV]: 'true' },
      })
    ).rejects.toThrowError(
      /Refusing to run test migrations against non-test database: "staycraft_pms"/
    );

    const mispointedPreviewMock = createMockMigrationPool('staycraft_pms');
    await expect(
      runMigrations({
        pool: mispointedPreviewMock.pool,
        env: {
          NODE_ENV: 'production',
          STAYCRAFT_DB_ROLE: 'preview',
          [PRODUCTION_MIGRATION_AUTH_ENV]: 'true',
        },
      })
    ).rejects.toThrowError(
      /Refusing to run preview migrations against non-preview database: "staycraft_pms"/
    );

    const customProdMock = createMockMigrationPool('staycraft_cloud_prod');
    await expect(
      runMigrations({
        pool: customProdMock.pool,
        env: { NODE_ENV: 'production' },
      })
    ).rejects.toThrowError(
      /Refusing to run migrations against production database "staycraft_cloud_prod" without explicit authorization/
    );
  });

  it('preserves normal dev, preview, test, and explicitly authorized migration workflows', async () => {
    const emptyMigrationsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'staycraft-mig-guard-test-')
    );

    try {
      const devMock = createMockMigrationPool('staycraft_pms_dev');
      await expect(
        runMigrations({
          pool: devMock.pool,
          env: { NODE_ENV: 'development' },
          migrationsDir: emptyMigrationsDir,
        })
      ).resolves.toEqual([]);

      const previewMock = createMockMigrationPool('staycraft_pms_preview');
      await expect(
        runMigrations({
          pool: previewMock.pool,
          env: { NODE_ENV: 'production', STAYCRAFT_DB_ROLE: 'preview' },
          migrationsDir: emptyMigrationsDir,
        })
      ).resolves.toEqual([]);

      const testMock = createMockMigrationPool('staycraft_pms_test');
      await expect(
        assertMigrationTargetAuthorized(testMock.pool, { NODE_ENV: 'test' })
      ).resolves.toBe('staycraft_pms_test');

      const authorizedProdMock = createMockMigrationPool('staycraft_pms');
      await expect(
        runMigrations({
          pool: authorizedProdMock.pool,
          env: {
            NODE_ENV: 'production',
            [PRODUCTION_MIGRATION_AUTH_ENV]: 'true',
          },
          migrationsDir: emptyMigrationsDir,
        })
      ).resolves.toEqual([]);
    } finally {
      await fs.rm(emptyMigrationsDir, { recursive: true, force: true });
    }
  });
});
