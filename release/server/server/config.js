import dotenv from 'dotenv';
import { z } from 'zod';
dotenv.config();
export const PRODUCTION_DATABASE_NAME = 'staycraft_pms';
export const PREVIEW_DATABASE_NAME = 'staycraft_pms_preview';
export const TEST_DATABASE_NAME = 'staycraft_pms_test';
export function redactConnectionStrings(message) {
    return message
        .replace(/postgres(?:ql)?:\/\/[^\s"'`)\]]+/gi, 'postgresql://[REDACTED]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]')
        .replace(/\b(staycraft_session|x-session-token|e2b-traffic-access-token)\s*[:=]\s*[^\s;,"'`&)\]]+/gi, '$1=[REDACTED]');
}
/**
 * Returns true if the hostname belongs to an access-restricted sandbox or preview
 * gateway (such as E2B or Arena preview proxies) that requires a platform traffic
 * access token and cannot be opened directly by external guest phones.
 */
export function isSandboxPreviewHost(rawHostname) {
    const host = rawHostname
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.+$/, '');
    if (!host)
        return false;
    return (host === 'e2b.app' ||
        host.endsWith('.e2b.app') ||
        host === 'e2b.dev' ||
        host.endsWith('.e2b.dev') ||
        host === 'arena.ai' ||
        host.endsWith('.arena.ai') ||
        host === 'lmarena.ai' ||
        host.endsWith('.lmarena.ai'));
}
/**
 * Returns true if the hostname is loopback, RFC1918 private LAN, link-local,
 * or a single-label internal container hostname not reachable from external guest phones.
 */
export function isLoopbackOrPrivateHost(rawHostname) {
    const host = rawHostname
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.+$/, '');
    if (!host)
        return true;
    if (host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        host === '0.0.0.0' ||
        host === '::1' ||
        host === '::') {
        return true;
    }
    // IPv6 link-local (fe80::/10) or unique-local (fc00::/7)
    if (host.includes(':')) {
        if (host.startsWith('fe80:') ||
            host.startsWith('fc') ||
            host.startsWith('fd')) {
            return true;
        }
        return false;
    }
    // IPv4 literal checks
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
        if (a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168)) {
            return true;
        }
        return false;
    }
    // Single-label internal hostname (e.g., "web", "app", "staycraft")
    if (!host.includes('.')) {
        return true;
    }
    return false;
}
/**
 * Returns true if the hostname is a routable private LAN address (RFC 1918 IPv4,
 * RFC 4193 IPv6 unique-local, or multi-label mDNS .local hostname) reachable by
 * phones connected to the same local Wi-Fi / hotspot network during development.
 * Explicitly excludes loopback (localhost/127.0.0.1/::1), unspecified (0.0.0.0/::),
 * link-local (169.254.x.x/fe80::), and sandbox preview domains.
 */
export function isPrivateLanHost(rawHostname) {
    const host = rawHostname
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.+$/, '');
    if (!host || isSandboxPreviewHost(host)) {
        return false;
    }
    if (host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.internal') ||
        host === '0.0.0.0' ||
        host === '::1' ||
        host === '::') {
        return false;
    }
    // IPv6 unique-local (fc00::/7) on LAN, excluding link-local fe80::/10
    if (host.includes(':')) {
        return host.startsWith('fc') || host.startsWith('fd');
    }
    // RFC 1918 private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const octets = [
            Number(ipv4Match[1]),
            Number(ipv4Match[2]),
            Number(ipv4Match[3]),
            Number(ipv4Match[4]),
        ];
        if (octets.some((n) => n < 0 || n > 255)) {
            return false;
        }
        const [a, b] = octets;
        return (a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168));
    }
    // Multi-label mDNS LAN hostname (e.g. "hotel-laptop.local")
    if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.local$/.test(host)) {
        return true;
    }
    return false;
}
function createPublicAppUrlSchema(allowLocalDevLan) {
    return z
        .string()
        .trim()
        .min(1)
        .transform((raw, ctx) => {
        let parsed;
        try {
            parsed = new URL(raw);
        }
        catch {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Invalid PUBLIC_APP_URL: must be a valid https://<your-public-domain> URL (or http://<lan-ip>:<port> in local development).',
            });
            return z.NEVER;
        }
        if (parsed.username || parsed.password) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Invalid PUBLIC_APP_URL: must not contain embedded credentials.',
            });
            return z.NEVER;
        }
        if (parsed.search || parsed.hash) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Invalid PUBLIC_APP_URL: must not contain query parameters, access tokens, or URL fragments.',
            });
            return z.NEVER;
        }
        if (parsed.pathname !== '/') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Invalid PUBLIC_APP_URL: specify only the root origin (for example, https://pms.yourhotel.com or http://192.168.1.10:3000) without a path.',
            });
            return z.NEVER;
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Invalid PUBLIC_APP_URL: public production base URL must use https:// (or http://<lan-ip>:<port> in local development).',
            });
            return z.NEVER;
        }
        const rawHostname = parsed.hostname.toLowerCase();
        const unbracketedHost = rawHostname.replace(/^\[|\]$/g, '');
        if (unbracketedHost.endsWith('.')) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Invalid PUBLIC_APP_URL: hostname must not end with a trailing dot.',
            });
            return z.NEVER;
        }
        if (isSandboxPreviewHost(rawHostname)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Invalid PUBLIC_APP_URL: "${rawHostname}" is an access-restricted sandbox/preview host that requires a platform traffic token. Configure your deployed public HTTPS domain (or your laptop LAN IP in local development) instead.`,
            });
            return z.NEVER;
        }
        if (isPrivateLanHost(rawHostname)) {
            if (!allowLocalDevLan) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Invalid PUBLIC_APP_URL: "${rawHostname}" is a private LAN address not reachable from external guest phones in production. Configure a publicly reachable HTTPS domain, or run with NODE_ENV=development for local Wi-Fi testing.`,
                });
                return z.NEVER;
            }
            return {
                origin: parsed.origin,
                mode: 'local_lan',
            };
        }
        if (isLoopbackOrPrivateHost(rawHostname)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Invalid PUBLIC_APP_URL: "${rawHostname}" is a loopback, unspecified, link-local, or single-label internal address not reachable from guest phones. Configure https://<your-public-domain> in production, or http://<your-laptop-lan-ip>:<port> in local development.`,
            });
            return z.NEVER;
        }
        if (parsed.protocol !== 'https:') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Invalid PUBLIC_APP_URL: public production base URL must use https://.',
            });
            return z.NEVER;
        }
        return {
            origin: parsed.origin,
            mode: 'production',
        };
    });
}
let devRuntimePublicAppUrlOverride = null;
export function getEffectivePublicAppUrlInput(env = process.env) {
    const effectiveNodeEnv = (env.NODE_ENV ?? 'development').trim() || 'development';
    if (effectiveNodeEnv === 'development' &&
        env === process.env &&
        devRuntimePublicAppUrlOverride !== null) {
        return devRuntimePublicAppUrlOverride;
    }
    return String(env.PUBLIC_APP_URL ?? '').trim();
}
export function setDevRuntimePublicAppUrlOverride(rawUrl) {
    const effectiveNodeEnv = (process.env.NODE_ENV ?? 'development').trim() || 'development';
    if (effectiveNodeEnv !== 'development') {
        throw new Error('Runtime PUBLIC_APP_URL override is restricted to NODE_ENV=development.');
    }
    const trimmed = String(rawUrl ?? '').trim();
    if (!trimmed) {
        devRuntimePublicAppUrlOverride = null;
        return null;
    }
    const validated = resolveConfiguredAppUrl({
        ...process.env,
        NODE_ENV: 'development',
        PUBLIC_APP_URL: trimmed,
    });
    devRuntimePublicAppUrlOverride = validated?.origin ?? null;
    return devRuntimePublicAppUrlOverride;
}
/**
 * Validates PUBLIC_APP_URL in a fail-closed manner and classifies its mode:
 * - Returns null when PUBLIC_APP_URL is unset or blank.
 * - Production (`NODE_ENV=production`):
 *   strictly requires a public `https://` domain and rejects all HTTP, LAN, loopback,
 *   and sandbox preview URLs.
 * - Local Development (`NODE_ENV=development` / `test`):
 *   permits a routable local Wi-Fi / LAN origin (e.g. `http://192.168.1.10:3000`)
 *   or a valid public `https://` domain, while still rejecting `localhost`, `127.0.0.1`,
 *   `0.0.0.0`, `169.254.x.x`, plain HTTP public domains, and sandbox preview URLs.
 */
export function resolveConfiguredAppUrl(env = process.env) {
    const raw = getEffectivePublicAppUrlInput(env);
    if (!raw) {
        return null;
    }
    const effectiveNodeEnv = (env.NODE_ENV ?? 'development').trim() || 'development';
    const allowLocalDevLan = effectiveNodeEnv === 'development' || effectiveNodeEnv === 'test';
    const result = createPublicAppUrlSchema(allowLocalDevLan).safeParse(raw);
    if (!result.success) {
        throw new Error(result.error.issues[0]?.message ??
            'Invalid PUBLIC_APP_URL: must be a valid https://<your-public-domain> URL.');
    }
    return result.data;
}
export function resolvePublicAppUrl(env = process.env) {
    return resolveConfiguredAppUrl(env)?.origin ?? null;
}
export function sanitizeErrorForLog(err) {
    if (err instanceof Error) {
        const codeSuffix = typeof err.code === 'string'
            ? ` [code=${String(err.code)}]`
            : '';
        return `${err.name}: ${redactConnectionStrings(err.message)}${codeSuffix}`;
    }
    return redactConnectionStrings(String(err));
}
function parseAndValidateDatabaseName(rawUrl, envVarName) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        throw new Error(`Invalid ${envVarName}: must be a valid postgres:// or postgresql:// URL including a target database name.`);
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        throw new Error(`Invalid ${envVarName}: protocol must be postgres:// or postgresql://.`);
    }
    const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).trim();
    if (!dbName || dbName.includes('/')) {
        throw new Error(`Invalid ${envVarName}: connection URL must specify a non-empty PostgreSQL database name.`);
    }
    return dbName;
}
/**
 * Resolves the PostgreSQL connection URL in a strictly fail-closed manner:
 * - Never falls back to production ("staycraft_pms") when DATABASE_URL is missing.
 * - Requires TEST_DATABASE_URL targeting "staycraft_pms_test" in test mode.
 * - Requires PREVIEW_DATABASE_URL (or DATABASE_URL) targeting "staycraft_pms_preview" in preview mode.
 * - Rejects targeting "staycraft_pms" outside NODE_ENV=production.
 * - Never includes credentials or raw connection strings in error messages.
 */
export function resolveDatabaseUrl(env = process.env) {
    const nodeEnv = (env.NODE_ENV ?? 'development').trim() || 'development';
    if (nodeEnv === 'test') {
        const rawTestUrl = (env.TEST_DATABASE_URL ?? '').trim();
        if (!rawTestUrl) {
            throw new Error(`Missing required TEST_DATABASE_URL environment variable for test runtime (expected PostgreSQL database "${TEST_DATABASE_NAME}").`);
        }
        const dbName = parseAndValidateDatabaseName(rawTestUrl, 'TEST_DATABASE_URL');
        if (dbName !== TEST_DATABASE_NAME) {
            throw new Error(`Refusing to configure test runtime with non-test database "${dbName}" (expected "${TEST_DATABASE_NAME}").`);
        }
        return rawTestUrl;
    }
    if (env.STAYCRAFT_DB_ROLE === 'preview') {
        const rawPreviewUrl = (env.PREVIEW_DATABASE_URL ?? '').trim();
        const rawFallbackUrl = (env.DATABASE_URL ?? '').trim();
        const chosenUrl = rawPreviewUrl || rawFallbackUrl;
        const chosenVar = rawPreviewUrl ? 'PREVIEW_DATABASE_URL' : 'DATABASE_URL';
        if (!chosenUrl) {
            throw new Error(`Missing required PREVIEW_DATABASE_URL (or DATABASE_URL) environment variable for preview runtime (expected PostgreSQL database "${PREVIEW_DATABASE_NAME}").`);
        }
        const dbName = parseAndValidateDatabaseName(chosenUrl, chosenVar);
        if (dbName !== PREVIEW_DATABASE_NAME) {
            throw new Error(`Refusing to configure preview runtime with non-preview database "${dbName}" (expected "${PREVIEW_DATABASE_NAME}").`);
        }
        return chosenUrl;
    }
    const rawDbUrl = (env.DATABASE_URL ?? '').trim();
    if (!rawDbUrl) {
        throw new Error(`Missing required DATABASE_URL environment variable for ${nodeEnv} runtime. Configure DATABASE_URL explicitly for the target database; StayCraft PMS never defaults to production "${PRODUCTION_DATABASE_NAME}".`);
    }
    const dbName = parseAndValidateDatabaseName(rawDbUrl, 'DATABASE_URL');
    if (dbName === PRODUCTION_DATABASE_NAME && nodeEnv !== 'production') {
        throw new Error(`Refusing to select production database "${PRODUCTION_DATABASE_NAME}" when NODE_ENV="${nodeEnv}". Point DATABASE_URL at an explicit development or preview database (for example "${PREVIEW_DATABASE_NAME}"), or set NODE_ENV=production for an authorized production server.`);
    }
    return rawDbUrl;
}
export const config = {
    get nodeEnv() {
        return (process.env.NODE_ENV ?? 'development').trim() || 'development';
    },
    get port() {
        return Number(process.env.PORT ?? 3000);
    },
    get host() {
        return process.env.HOST ?? '0.0.0.0';
    },
    get databaseUrl() {
        return resolveDatabaseUrl(process.env);
    },
    get sessionCookieName() {
        return process.env.SESSION_COOKIE_NAME ?? 'staycraft_session';
    },
    get sessionTtlHours() {
        return Number(process.env.SESSION_TTL_HOURS ?? 24);
    },
    get publicAppUrl() {
        return resolvePublicAppUrl(process.env);
    },
};
