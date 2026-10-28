import cookieParser from 'cookie-parser';
import express from 'express';
import { config, resolvePublicAppUrl } from './config.js';
import { getPool } from './db/pool.js';
import { AppError } from './errors.js';
import { asyncHandler, errorHandler } from './middleware/errorHandler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { expensesRouter } from './modules/expenses/expenses.routes.js';
import { guestsRouter } from './modules/guests/guests.routes.js';
import { housekeepingRouter } from './modules/housekeeping/housekeeping.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { invoicesRouter } from './modules/invoices/invoices.routes.js';
import { maintenanceRouter } from './modules/maintenance/maintenance.routes.js';
import { propertiesRouter } from './modules/properties/properties.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { reservationsRouter } from './modules/reservations/reservations.routes.js';
import { guestFoodRouter } from './modules/restaurant/guest-food.routes.js';
import { restaurantRouter } from './modules/restaurant/restaurant.routes.js';
import { roomsRouter } from './modules/rooms/rooms.routes.js';
import { servicesRouter } from './modules/services/services.routes.js';
import { staffRouter } from './modules/staff/staff.routes.js';
import { suppliersRouter } from './modules/suppliers/suppliers.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

const ALLOWED_RPC_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const UNSAFE_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_FORM_CONTENT_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
];

const MAX_JSON_DEPTH = 10;
const MAX_JSON_ARRAY_LENGTH = 200;
const MAX_JSON_OBJECT_KEYS = 100;

function extractRequestHost(req: express.Request, originProtocol?: string): string {
  const rawHost = String(
    req.headers['x-forwarded-host'] ?? req.headers.host ?? ''
  )
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!rawHost) return '';
  if (originProtocol === 'https:' && rawHost.endsWith(':443')) {
    return rawHost.slice(0, -4);
  }
  if (originProtocol === 'http:' && rawHost.endsWith(':80')) {
    return rawHost.slice(0, -3);
  }
  return rawHost;
}

export function isTrustedRequestOrigin(
  origin: string,
  req: express.Request
): boolean {
  if (!origin || origin === 'null') {
    return false;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const reqHost = extractRequestHost(req, parsed.protocol);
    if (reqHost && parsed.host.toLowerCase() === reqHost) {
      return true;
    }

    try {
      const configuredPublicOrigin = resolvePublicAppUrl(process.env);
      if (configuredPublicOrigin && parsed.origin === configuredPublicOrigin) {
        return true;
      }
    } catch {
      // Invalid PUBLIC_APP_URL is rejected fail-closed at route/startup validation
    }

    const host = parsed.hostname.toLowerCase();
    const allowPreviewOrigins =
      process.env.STAYCRAFT_DB_ROLE === 'preview' ||
      config.nodeEnv !== 'production';

    if (allowPreviewOrigins) {
      const sandboxId = String(process.env.E2B_SANDBOX_ID ?? '')
        .trim()
        .toLowerCase();
      if (
        sandboxId &&
        parsed.protocol === 'https:' &&
        host === `${config.port}-${sandboxId}.e2b.app`
      ) {
        return true;
      }

      if (
        parsed.protocol === 'https:' &&
        (host === 'arena.ai' ||
          host.endsWith('.arena.ai') ||
          host === 'lmarena.ai' ||
          host.endsWith('.lmarena.ai'))
      ) {
        return true;
      }
    }

    if (
      config.nodeEnv !== 'production' &&
      (host === 'localhost' || host === '127.0.0.1')
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function assertBoundedJsonValue(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw AppError.badRequest(
      'Request JSON payload exceeds maximum allowed nesting depth.'
    );
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_LENGTH) {
      throw AppError.badRequest(
        `Request JSON array exceeds maximum allowed length of ${MAX_JSON_ARRAY_LENGTH} items.`
      );
    }
    for (let i = 0; i < value.length; i++) {
      assertBoundedJsonValue(value[i], depth + 1);
    }
    return;
  }

  const keys = Object.keys(value);
  if (keys.length > MAX_JSON_OBJECT_KEYS) {
    throw AppError.badRequest(
      `Request JSON object exceeds maximum allowed key count of ${MAX_JSON_OBJECT_KEYS}.`
    );
  }
  for (const key of keys) {
    assertBoundedJsonValue((value as Record<string, unknown>)[key], depth + 1);
  }
}

export function createApiApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Security & preview-compatible CORS headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
    );
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, private'
      );
      res.setHeader('Pragma', 'no-cache');
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string' && isTrustedRequestOrigin(origin, req)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Accept, Content-Type, Authorization, X-Session-Token, X-Property-Id, X-Auth-User-Id, X-Requested-With'
      );
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  // CSRF defense on state-changing API endpoints before body parsing & routing
  app.use('/api', (req, _res, next) => {
    if (!UNSAFE_HTTP_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const contentType = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    if (
      contentType &&
      BLOCKED_FORM_CONTENT_TYPES.some((blocked) => contentType === blocked)
    ) {
      next(
        new AppError(
          403,
          'Cross-site form submissions are not permitted on API endpoints.',
          'CSRF_REJECTED'
        )
      );
      return;
    }

    const originHeader = req.headers.origin;
    if (originHeader !== undefined) {
      const originVal = Array.isArray(originHeader)
        ? originHeader[0]
        : originHeader;
      if (!originVal || !isTrustedRequestOrigin(originVal, req)) {
        next(
          new AppError(
            403,
            'Cross-site request blocked: untrusted Origin header.',
            'CSRF_REJECTED'
          )
        );
        return;
      }
    } else if (req.headers.referer !== undefined) {
      const refererVal = Array.isArray(req.headers.referer)
        ? req.headers.referer[0]
        : req.headers.referer;
      let refererOrigin = '';
      try {
        refererOrigin = new URL(String(refererVal)).origin;
      } catch {
        refererOrigin = '';
      }
      if (!refererOrigin || !isTrustedRequestOrigin(refererOrigin, req)) {
        next(
          new AppError(
            403,
            'Cross-site request blocked: untrusted Referer header.',
            'CSRF_REJECTED'
          )
        );
        return;
      }
    }

    const secFetchSite = String(req.headers['sec-fetch-site'] ?? '')
      .trim()
      .toLowerCase();
    if (secFetchSite === 'cross-site') {
      const originVal =
        typeof originHeader === 'string' ? originHeader : undefined;
      if (!originVal || !isTrustedRequestOrigin(originVal, req)) {
        next(
          new AppError(
            403,
            'Cross-site browser request blocked by Fetch Metadata policy.',
            'CSRF_REJECTED'
          )
        );
        return;
      }
    } else if (
      secFetchSite === 'same-site' &&
      originHeader === undefined &&
      req.headers.referer === undefined
    ) {
      next(
        new AppError(
          403,
          'Cross-origin same-site request missing Origin verification.',
          'CSRF_REJECTED'
        )
      );
      return;
    }

    next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use('/api', (req, _res, next) => {
    try {
      if (req.body !== undefined) {
        assertBoundedJsonValue(req.body, 0);
      }
      next();
    } catch (err) {
      next(err);
    }
  });
  app.use(cookieParser());

  // Proxy-resilient JSON RPC envelope: when an upstream preview gateway strips
  // Cookie / Authorization / custom headers, POST /api/rpc unwraps the target API
  // request and routes it through the exact same requireAuth + requireRole stack.
  app.use((req, _res, next) => {
    if (req.method !== 'POST' || req.path !== '/api/rpc') {
      next();
      return;
    }

    const envelope = req.body as Record<string, unknown> | null | undefined;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      next(AppError.badRequest('Invalid RPC request envelope'));
      return;
    }

    const targetMethod = String(envelope.method ?? '').trim().toUpperCase();
    const targetPath = String(envelope.path ?? '').trim();

    if (!ALLOWED_RPC_METHODS.has(targetMethod)) {
      next(AppError.badRequest('Unsupported RPC HTTP method'));
      return;
    }

    if (
      !targetPath.startsWith('/api/') ||
      targetPath.startsWith('/api/rpc') ||
      targetPath.includes('..') ||
      targetPath.includes('//') ||
      /[\r\n]/.test(targetPath)
    ) {
      next(AppError.badRequest('Invalid RPC target API path'));
      return;
    }

    if (typeof envelope.sessionToken === 'string' && envelope.sessionToken.trim().length > 0) {
      req.headers['x-session-token'] = envelope.sessionToken.trim();
    }

    if (typeof envelope.propertyId === 'string' && envelope.propertyId.trim().length > 0) {
      req.headers['x-property-id'] = envelope.propertyId.trim();
    }

    if (
      typeof envelope.expectedUserId === 'string' &&
      envelope.expectedUserId.trim().length > 0
    ) {
      req.headers['x-auth-user-id'] = envelope.expectedUserId.trim();
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetPath, 'http://localhost');
    } catch {
      next(AppError.badRequest('Malformed RPC target API path'));
      return;
    }

    const queryObj: Record<string, string | string[]> = {};
    for (const [key, value] of parsedUrl.searchParams.entries()) {
      const existing = queryObj[key];
      if (existing === undefined) {
        queryObj[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        queryObj[key] = [existing, value];
      }
    }

    req.method = targetMethod;
    req.url = `${parsedUrl.pathname}${parsedUrl.search}`;
    req.originalUrl = req.url;
    (req as unknown as { query: Record<string, unknown> }).query = queryObj;
    req.body =
      envelope.payload !== undefined && envelope.payload !== null ? envelope.payload : {};

    next();
  });

  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      await getPool().query('SELECT 1');
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    })
  );

  app.use('/api/auth', authRouter);
  app.use('/api/public/guest-food', guestFoodRouter);
  app.use('/api/properties', propertiesRouter);
  app.use('/api', roomsRouter);
  app.use('/api/housekeeping', housekeepingRouter);
  app.use('/api/maintenance', maintenanceRouter);
  app.use('/api/guests', guestsRouter);
  app.use('/api/reservations', reservationsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/restaurant', restaurantRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/services', servicesRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/dashboard', dashboardRouter);

  app.use('/api/*', (_req, _res, next) => {
    next(AppError.notFound('API endpoint not found'));
  });

  app.use(errorHandler);

  return app;
}
