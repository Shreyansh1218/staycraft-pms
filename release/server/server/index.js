import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiApp } from './app.js';
import { config, PREVIEW_DATABASE_NAME, PRODUCTION_DATABASE_NAME, resolveConfiguredAppUrl, resolveDatabaseUrl, sanitizeErrorForLog, TEST_DATABASE_NAME, } from './config.js';
import { runMigrations } from './db/migrate.js';
import { closePool, getPool } from './db/pool.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
async function verifyConnectedDatabaseIdentity() {
    const pool = getPool();
    const dbRes = await pool.query('SELECT current_database() AS db');
    const connectedDb = String(dbRes.rows[0]?.db ?? '').trim();
    if (!connectedDb) {
        throw new Error('Unable to verify connected PostgreSQL database identity on startup.');
    }
    if (process.env.NODE_ENV === 'test' && connectedDb !== TEST_DATABASE_NAME) {
        throw new Error(`Refusing to start test server connected to "${connectedDb}" (expected "${TEST_DATABASE_NAME}").`);
    }
    if (process.env.STAYCRAFT_DB_ROLE === 'preview') {
        if (connectedDb !== PREVIEW_DATABASE_NAME) {
            throw new Error(`Refusing to start preview server connected to "${connectedDb}" (expected "${PREVIEW_DATABASE_NAME}").`);
        }
        return;
    }
    if (connectedDb === PRODUCTION_DATABASE_NAME && process.env.NODE_ENV !== 'production') {
        throw new Error(`Refusing to connect non-production server to "${PRODUCTION_DATABASE_NAME}".`);
    }
}
function resolveProductionClientDir() {
    const candidates = [
        path.resolve(process.cwd(), 'dist/client'),
        path.resolve(process.cwd(), 'release/client'),
        path.resolve(__dirname, '../../../dist/client'),
        path.resolve(__dirname, '../../../release/client'),
        path.resolve(__dirname, '../../client'),
    ];
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'index.html'))) {
            return dir;
        }
    }
    throw new Error('Production client bundle (index.html) not found in dist/client or release/client.');
}
async function bootstrap() {
    // 1. Fail-closed validation of explicit runtime database URL and live current_database();
    //    PUBLIC_APP_URL is checked on startup and surfaced fail-closed in QR / mailer endpoints.
    resolveDatabaseUrl(process.env);
    let configuredAppUrl = null;
    try {
        configuredAppUrl = resolveConfiguredAppUrl(process.env);
    }
    catch (urlErr) {
        console.error(`[PUBLIC_APP_URL Configuration Error] ${sanitizeErrorForLog(urlErr)}`);
    }
    await verifyConnectedDatabaseIdentity();
    if (process.env.AUTO_MIGRATE === 'true') {
        await runMigrations();
    }
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', true);
    const server = http.createServer(app);
    const apiApp = createApiApp();
    app.use(apiApp);
    if (config.nodeEnv === 'production' || process.env.SERVE_STATIC_CLIENT === 'true') {
        const resolvedDist = resolveProductionClientDir();
        app.use((_req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
            res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
            res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'");
            next();
        });
        app.use(express.static(resolvedDist));
        app.get('*', (_req, res) => {
            res.sendFile(path.join(resolvedDist, 'index.html'));
        });
    }
    else {
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
            server: {
                middlewareMode: true,
                allowedHosts: true,
                hmr: { server },
            },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    }
    server.listen(config.port, config.host, () => {
        console.log(`StayCraft PMS server listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
        if (configuredAppUrl) {
            console.log(`Guest QR base URL active (${configuredAppUrl.mode}): ${configuredAppUrl.origin}`);
        }
    });
    const shutdown = async () => {
        server.close(async () => {
            await closePool();
            process.exit(0);
        });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
bootstrap().catch((err) => {
    console.error('Failed to start StayCraft PMS server:', sanitizeErrorForLog(err));
    process.exit(1);
});
