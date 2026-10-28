import type { Request } from 'express';
import type { GuestQrUrlMode } from '../../shared/types.js';
import {
  config,
  getEffectivePublicAppUrlInput,
  isLoopbackOrPrivateHost,
  isSandboxPreviewHost,
  resolveConfiguredAppUrl,
  type ResolvedConfiguredAppUrl,
} from '../config.js';
import { AppError } from '../errors.js';

export interface OutboxEmailMessage {
  id: string;
  to: string;
  subject: string;
  textBody: string;
  category: 'password_reset' | 'email_changed_notice';
  resetUrl?: string;
  sentAt: string;
  deliveredExternally: boolean;
}

export interface ResolvedGuestQrUrlContext {
  urlMode: GuestQrUrlMode;
  qrReady: boolean;
  baseUrl: string | null;
  configurationNotice: string | null;
  configurationError: string | null;
  configuredPublicAppUrl: string | null;
  canConfigureDevUrl: boolean;
}

const MAX_TEST_OUTBOX = 200;
const testOutbox: OutboxEmailMessage[] = [];

export function isExternalEmailTransportConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const url = String(env.EMAIL_WEBHOOK_URL ?? '').trim();
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function getValidatedConfiguredAppUrl(
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfiguredAppUrl | null {
  try {
    return resolveConfiguredAppUrl(env);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Invalid PUBLIC_APP_URL configuration.';
    throw new AppError(503, message, 'PUBLIC_APP_URL_INVALID');
  }
}

function parseValidatedHostOrigin(
  rawHostHeader: string,
  protocol: 'http' | 'https'
): URL | null {
  const rawHost = rawHostHeader.split(',')[0].trim().toLowerCase();
  if (!rawHost) return null;
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(rawHost)) {
    return null;
  }
  try {
    return new URL(`${protocol}://${rawHost}`);
  } catch {
    return null;
  }
}

function detectRequestProtocol(req: Request, sandboxId: string, rawHost: string): 'http' | 'https' {
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isHttps =
    req.secure ||
    forwardedProto === 'https' ||
    req.headers['x-forwarded-ssl'] === 'on' ||
    Boolean(sandboxId && rawHost.toLowerCase().endsWith('.e2b.app'));
  return isHttps ? 'https' : 'http';
}

function requestUsesSandboxHost(req: Request): boolean {
  const candidates = [
    String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim(),
    String(req.headers.host ?? '').split(',')[0].trim(),
  ];

  for (const raw of candidates) {
    const parsed = parseValidatedHostOrigin(raw, 'https');
    if (parsed && isSandboxPreviewHost(parsed.hostname)) {
      return true;
    }
  }

  const rawOrigin = String(req.headers.origin ?? '').trim();
  if (rawOrigin && rawOrigin !== 'null') {
    try {
      const parsedOrigin = new URL(rawOrigin);
      if (isSandboxPreviewHost(parsedOrigin.hostname)) {
        return true;
      }
    } catch {
      // Ignore malformed Origin
    }
  }

  return false;
}

/**
 * Resolves the Guest QR ordering URL strictly separated across environments:
 * - Production / Configured Public Domain (`PUBLIC_APP_URL` set & valid): uses `PUBLIC_APP_URL`.
 *   Invalid or sandbox `PUBLIC_APP_URL` values fail closed (`503 PUBLIC_APP_URL_INVALID`)
 *   and NEVER silently fall back to a sandbox URL.
 * - Preview Sandbox (`STAYCRAFT_DB_ROLE=preview` or sandbox request without `PUBLIC_APP_URL`):
 *   withholds QR generation (`qrReady: false`, `baseUrl: null`) rather than encoding an
 *   inaccessible `*.e2b.app` URL that requires a sandbox traffic access token.
 * - Unconfigured Production (`NODE_ENV=production` without `PUBLIC_APP_URL`):
 *   withholds QR generation (`qrReady: false`, `baseUrl: null`) and never falls back to
 *   sandbox or internal hosts.
 * - Local Development / Automated Test (`development` / `test` on local host):
 *   uses validated local loopback origin (`urlMode: 'local_dev'`), kept explicitly separate
 *   from production URLs.
 */
export function resolveGuestQrUrlContext(
  req: Request,
  env: NodeJS.ProcessEnv = process.env
): ResolvedGuestQrUrlContext {
  const effectiveNodeEnv =
    String(env.NODE_ENV ?? config.nodeEnv ?? 'development').trim() ||
    'development';
  const canConfigureDevUrl = effectiveNodeEnv === 'development';
  const rawConfigured = getEffectivePublicAppUrlInput(env);

  if (rawConfigured) {
    try {
      const configured = resolveConfiguredAppUrl(env);
      if (configured) {
        if (configured.mode === 'local_lan') {
          return {
            urlMode: 'local_lan',
            qrReady: true,
            baseUrl: configured.origin,
            configurationNotice:
              'Local Wi-Fi / LAN URL active — phones connected to the same Wi-Fi network can scan this QR code directly. Configure https://<your-public-domain> in production.',
            configurationError: null,
            configuredPublicAppUrl: configured.origin,
            canConfigureDevUrl,
          };
        }

        return {
          urlMode: 'production',
          qrReady: true,
          baseUrl: configured.origin,
          configurationNotice: null,
          configurationError: null,
          configuredPublicAppUrl: configured.origin,
          canConfigureDevUrl,
        };
      }
    } catch (err) {
      const exactError =
        err instanceof Error
          ? err.message
          : 'Invalid PUBLIC_APP_URL configuration.';
      return {
        urlMode: 'invalid_config',
        qrReady: false,
        baseUrl: null,
        configurationNotice: exactError,
        configurationError: exactError,
        configuredPublicAppUrl: null,
        canConfigureDevUrl,
      };
    }
  }

  const isPreviewRuntime = env.STAYCRAFT_DB_ROLE === 'preview';

  if (effectiveNodeEnv === 'development') {
    const missingDevMsg =
      'Missing PUBLIC_APP_URL: set PUBLIC_APP_URL=http://<your-laptop-wifi-ip>:3000 in .env (or enter your laptop Wi-Fi LAN URL below) to generate the Guest QR code.';
    return {
      urlMode: 'dev_unconfigured',
      qrReady: false,
      baseUrl: null,
      configurationNotice: missingDevMsg,
      configurationError: missingDevMsg,
      configuredPublicAppUrl: null,
      canConfigureDevUrl: true,
    };
  }

  if (isPreviewRuntime || requestUsesSandboxHost(req)) {
    const missingPreviewMsg =
      'Missing PUBLIC_APP_URL: Arena’s private sandbox URL requires a platform traffic access token and cannot be used for phone QR codes. Set PUBLIC_APP_URL=https://<your-public-domain> (production) or run with NODE_ENV=development and PUBLIC_APP_URL=http://<your-laptop-wifi-ip>:3000 (local Wi-Fi).';
    return {
      urlMode: 'preview_unconfigured',
      qrReady: false,
      baseUrl: null,
      configurationNotice: missingPreviewMsg,
      configurationError: missingPreviewMsg,
      configuredPublicAppUrl: null,
      canConfigureDevUrl: false,
    };
  }

  if (effectiveNodeEnv === 'production') {
    const missingProdMsg =
      'Missing PUBLIC_APP_URL: set PUBLIC_APP_URL=https://<your-public-domain> in your production server environment to generate a phone-scannable Guest QR code.';
    return {
      urlMode: 'production_unconfigured',
      qrReady: false,
      baseUrl: null,
      configurationNotice: missingProdMsg,
      configurationError: missingProdMsg,
      configuredPublicAppUrl: null,
      canConfigureDevUrl: false,
    };
  }

  // Automated test runtime (NODE_ENV=test) without PUBLIC_APP_URL on local loopback
  const rawHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
  const protocol = detectRequestProtocol(req, '', rawHost);
  const parsedHost = parseValidatedHostOrigin(rawHost, protocol);

  let localOrigin = `http://localhost:${config.port}`;
  if (parsedHost && !isSandboxPreviewHost(parsedHost.hostname)) {
    const hostOnly = parsedHost.hostname.toLowerCase();
    if (hostOnly === 'localhost' || hostOnly === '127.0.0.1') {
      localOrigin = parsedHost.origin;
    }
  }

  return {
    urlMode: 'local_dev',
    qrReady: true,
    baseUrl: localOrigin,
    configurationNotice:
      'Same-machine test loopback URL. Configure PUBLIC_APP_URL=http://<your-laptop-lan-ip>:3000 in development or https://<your-public-domain> in production.',
    configurationError: null,
    configuredPublicAppUrl: null,
    canConfigureDevUrl: false,
  };
}

/**
 * Safely resolves the application base URL for account password-reset links.
 * Validates PUBLIC_APP_URL fail-closed when set, and never falls back to a
 * sandbox URL in production.
 */
export function resolveSafeAppBaseUrl(
  req: Request,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = getValidatedConfiguredAppUrl(env);
  if (configured) {
    return configured.origin;
  }

  const sandboxId = String(env.E2B_SANDBOX_ID ?? '')
    .trim()
    .toLowerCase();
  const effectiveNodeEnv =
    String(env.NODE_ENV ?? config.nodeEnv ?? 'development').trim() ||
    'development';
  const isPreviewRuntime = env.STAYCRAFT_DB_ROLE === 'preview';

  const rawHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
  const protocol = detectRequestProtocol(req, isPreviewRuntime ? sandboxId : '', rawHost);
  const parsedHost = parseValidatedHostOrigin(rawHost, protocol);

  if (effectiveNodeEnv === 'production' && !isPreviewRuntime) {
    throw new AppError(
      503,
      'PUBLIC_APP_URL must be configured with your deployed https://<domain> in production.',
      'PUBLIC_APP_URL_REQUIRED'
    );
  }

  if (isPreviewRuntime) {
    if (parsedHost && !isLoopbackOrPrivateHost(parsedHost.hostname)) {
      return parsedHost.origin;
    }
    const rawOrigin = String(req.headers.origin ?? '').trim();
    if (rawOrigin && rawOrigin !== 'null') {
      try {
        const parsedOrigin = new URL(rawOrigin);
        if (
          (parsedOrigin.protocol === 'https:' || parsedOrigin.protocol === 'http:') &&
          !isLoopbackOrPrivateHost(parsedOrigin.hostname)
        ) {
          return parsedOrigin.origin;
        }
      } catch {
        // Ignore malformed Origin
      }
    }
    if (sandboxId) {
      return `https://${config.port}-${sandboxId}.e2b.app`;
    }
  }

  if (parsedHost && !isSandboxPreviewHost(parsedHost.hostname)) {
    return parsedHost.origin;
  }

  return `http://localhost:${config.port}`;
}

async function dispatchOutboundEmail(message: {
  to: string;
  subject: string;
  textBody: string;
  category: OutboxEmailMessage['category'];
  resetUrl?: string;
}): Promise<{ deliveredExternally: boolean }> {
  let deliveredExternally = false;
  const webhookUrl = String(process.env.EMAIL_WEBHOOK_URL ?? '').trim();

  if (webhookUrl && isExternalEmailTransportConfigured()) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const bearer = String(process.env.EMAIL_WEBHOOK_TOKEN ?? '').trim();
    if (bearer) {
      headers.Authorization = `Bearer ${bearer}`;
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        to: message.to,
        subject: message.subject,
        text: message.textBody,
        category: message.category,
      }),
    });
    deliveredExternally = res.ok;
  }

  if (process.env.NODE_ENV === 'test') {
    if (testOutbox.length >= MAX_TEST_OUTBOX) {
      testOutbox.shift();
    }
    testOutbox.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      to: message.to,
      subject: message.subject,
      textBody: message.textBody,
      category: message.category,
      resetUrl: message.resetUrl,
      sentAt: new Date().toISOString(),
      deliveredExternally,
    });
  }

  return { deliveredExternally };
}

export async function sendPasswordResetEmail(params: {
  toEmail: string;
  fullName: string;
  resetUrl: string;
  expiresAt: string;
  initiatedByAdmin?: boolean;
}): Promise<{ deliveredExternally: boolean }> {
  const subject = 'StayCraft PMS — Password Reset Instructions';
  const initiatorLine = params.initiatedByAdmin
    ? 'An authorized hotel administrator initiated a password reset for your StayCraft PMS staff account.'
    : 'We received a password reset request for your StayCraft PMS staff account.';

  const textBody = [
    `Hello ${params.fullName},`,
    '',
    initiatorLine,
    'Use the single-use link below to choose a new password:',
    params.resetUrl,
    '',
    `This link expires at ${params.expiresAt} and can only be used once.`,
    'If you did not expect this request, you can safely ignore this message.',
  ].join('\n');

  return dispatchOutboundEmail({
    to: params.toEmail,
    subject,
    textBody,
    category: 'password_reset',
    resetUrl: params.resetUrl,
  });
}

export async function sendAccountEmailChangedNotice(params: {
  previousEmail: string;
  newEmail: string;
  fullName: string;
}): Promise<void> {
  const subject = 'StayCraft PMS — Account Email Address Updated';
  const textBody = [
    `Hello ${params.fullName},`,
    '',
    `Your StayCraft PMS sign-in email address was changed from ${params.previousEmail} to ${params.newEmail}.`,
    'If you did not authorize this change, contact your hotel administrator immediately.',
  ].join('\n');

  await dispatchOutboundEmail({
    to: params.previousEmail,
    subject,
    textBody,
    category: 'email_changed_notice',
  });
}

export function getTestMailOutbox(): ReadonlyArray<OutboxEmailMessage> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('getTestMailOutbox is restricted to NODE_ENV=test');
  }
  return [...testOutbox];
}

export function clearTestMailOutbox(): void {
  testOutbox.length = 0;
}
