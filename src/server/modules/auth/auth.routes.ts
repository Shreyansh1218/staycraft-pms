import type { Request, Response } from 'express';
import { Router } from 'express';
import {
  accountChangeEmailSchema,
  accountChangePasswordSchema,
  forgotPasswordRequestSchema,
  loginSchema,
} from '../../../shared/schemas.js';
import type { AuthSessionPayload, Property } from '../../../shared/types.js';
import { config } from '../../config.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { extractCandidateSessionTokens, requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  createDummyPasswordHash,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from '../../security/password.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import {
  resolveSafeAppBaseUrl,
  sendAccountEmailChangedNotice,
  sendPasswordResetEmail,
} from '../../services/mailer.service.js';
import { mapPropertyRow, mapUserRow } from '../../services/mappers.js';
import {
  consumePasswordResetToken,
  invalidateUnusedPasswordResetTokensInTx,
  issuePasswordResetTokenInTx,
  verifyPasswordResetToken,
} from './password-reset.service.js';

async function getAccessiblePropertiesForUser(
  userId: string,
  role: string
): Promise<{ properties: Property[]; defaultPropertyId: string }> {
  const pool = getPool();
  let rows: Record<string, any>[];

  if (role === 'admin') {
    const res = await pool.query(
      `SELECT p.*, COALESCE(upa.is_default, FALSE) AS is_default_access
       FROM properties p
       LEFT JOIN user_property_access upa ON upa.property_id = p.id AND upa.user_id = $1
       WHERE p.is_active = TRUE
       ORDER BY COALESCE(upa.is_default, FALSE) DESC, p.created_at ASC`,
      [userId]
    );
    rows = res.rows;
  } else {
    const res = await pool.query(
      `SELECT p.*, upa.is_default AS is_default_access
       FROM properties p
       JOIN user_property_access upa ON upa.property_id = p.id
       WHERE upa.user_id = $1 AND p.is_active = TRUE
       ORDER BY upa.is_default DESC, p.created_at ASC`,
      [userId]
    );
    rows = res.rows;
  }

  const properties = rows.map(mapPropertyRow);
  const defaultPropertyId = properties[0]?.id ?? '';
  return { properties, defaultPropertyId };
}

function isHttpsRequest(req: Request): boolean {
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const hostHeader = String(
    req.headers['x-forwarded-host'] ?? req.headers.host ?? ''
  )
    .split(',')[0]
    .trim()
    .toLowerCase();

  return (
    req.secure ||
    forwardedProto === 'https' ||
    req.headers['x-forwarded-ssl'] === 'on' ||
    String(req.headers.origin ?? '').startsWith('https://') ||
    String(req.headers.referer ?? '').startsWith('https://') ||
    Boolean(process.env.E2B_SANDBOX_ID && hostHeader.endsWith('.e2b.app'))
  );
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const isHttps = isHttpsRequest(req);
  const maxAgeSeconds = config.sessionTtlHours * 3600;
  const parts = [
    `${config.sessionCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (isHttps) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }

  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = isHttpsRequest(req);
  const base = `${config.sessionCookieName}=; Path=/; HttpOnly; Max-Age=0`;
  if (isHttps) {
    res.setHeader('Set-Cookie', [
      `${base}; SameSite=None; Secure; Partitioned`,
      `${base}; SameSite=Lax`,
    ]);
  } else {
    res.setHeader('Set-Cookie', `${base}; SameSite=Lax`);
  }
}

export const authRouter = Router();

const DUMMY_PASSWORD_HASH = createDummyPasswordHash();

const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS_PER_ACCOUNT = 10;
const MAX_FAILED_LOGINS_PER_IP = 30;
const MAX_TRACKED_RATE_KEYS = 5000;

const failedAccountAttempts = new Map<string, number[]>();
const failedIpAttempts = new Map<string, number[]>();

const RESET_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FORGOT_REQUESTS_PER_EMAIL = 5;
const MAX_FORGOT_REQUESTS_PER_IP = 15;
const MAX_RESET_VERIFY_PER_IP = 30;

const forgotEmailAttempts = new Map<string, number[]>();
const forgotIpAttempts = new Map<string, number[]>();
const resetTokenIpAttempts = new Map<string, number[]>();

export function resetLoginRateLimiter(): void {
  failedAccountAttempts.clear();
  failedIpAttempts.clear();
  forgotEmailAttempts.clear();
  forgotIpAttempts.clear();
  resetTokenIpAttempts.clear();
}

function pruneWindowTimestamps(
  bucket: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number
): number[] {
  const existing = bucket.get(key);
  if (!existing) return [];
  const active = existing.filter((ts) => now - ts < windowMs);
  if (active.length === 0) {
    bucket.delete(key);
  } else {
    bucket.set(key, active);
  }
  return active;
}

function recordWindowHit(
  bucket: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number
): void {
  if (!bucket.has(key) && bucket.size >= MAX_TRACKED_RATE_KEYS) {
    const oldestKey = bucket.keys().next().value;
    if (oldestKey !== undefined) {
      bucket.delete(oldestKey);
    }
  }
  const active = pruneWindowTimestamps(bucket, key, now, windowMs);
  active.push(now);
  bucket.set(key, active);
}

function enforceSlidingWindowLimit(
  res: Response,
  bucket: Map<string, number[]>,
  key: string,
  maxHits: number,
  windowMs: number,
  message: string,
  now = Date.now()
): void {
  const active = pruneWindowTimestamps(bucket, key, now, windowMs);
  if (active.length >= maxHits) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowMs - (now - active[0])) / 1000)
    );
    res.setHeader('Retry-After', String(retryAfterSeconds));
    throw new AppError(429, message, 'RATE_LIMITED', { retryAfterSeconds });
  }
  recordWindowHit(bucket, key, now, windowMs);
}

function pruneRecentTimestamps(bucket: Map<string, number[]>, key: string, now: number): number[] {
  const existing = bucket.get(key);
  if (!existing) return [];
  const active = existing.filter((ts) => now - ts < LOGIN_RATE_WINDOW_MS);
  if (active.length === 0) {
    bucket.delete(key);
  } else {
    bucket.set(key, active);
  }
  return active;
}

function recordBucketFailure(bucket: Map<string, number[]>, key: string, now: number): void {
  if (!bucket.has(key) && bucket.size >= MAX_TRACKED_RATE_KEYS) {
    const oldestKey = bucket.keys().next().value;
    if (oldestKey !== undefined) {
      bucket.delete(oldestKey);
    }
  }
  const active = pruneRecentTimestamps(bucket, key, now);
  active.push(now);
  bucket.set(key, active);
}

function checkLoginRateLimit(
  clientIp: string,
  normalizedEmail: string,
  now = Date.now()
): { blocked: false } | { blocked: true; retryAfterSeconds: number } {
  const accountKey = `${clientIp}|${normalizedEmail}`;
  const acctHits = pruneRecentTimestamps(failedAccountAttempts, accountKey, now);
  if (acctHits.length >= MAX_FAILED_LOGINS_PER_ACCOUNT) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((LOGIN_RATE_WINDOW_MS - (now - acctHits[0])) / 1000)
    );
    return { blocked: true, retryAfterSeconds };
  }

  const ipHits = pruneRecentTimestamps(failedIpAttempts, clientIp, now);
  if (ipHits.length >= MAX_FAILED_LOGINS_PER_IP) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((LOGIN_RATE_WINDOW_MS - (now - ipHits[0])) / 1000)
    );
    return { blocked: true, retryAfterSeconds };
  }

  return { blocked: false };
}

function recordFailedLoginAttempt(clientIp: string, normalizedEmail: string, now = Date.now()): void {
  recordBucketFailure(failedAccountAttempts, `${clientIp}|${normalizedEmail}`, now);
  recordBucketFailure(failedIpAttempts, clientIp, now);
}

function clearAccountLoginFailures(clientIp: string, normalizedEmail: string): void {
  failedAccountAttempts.delete(`${clientIp}|${normalizedEmail}`);
}

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const normalizedEmail = input.email.toLowerCase();
    const clientIp = String(req.ip ?? req.socket?.remoteAddress ?? 'unknown').slice(0, 64) || 'unknown';

    const rateCheck = checkLoginRateLimit(clientIp, normalizedEmail);
    if (rateCheck.blocked) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSeconds));
      throw new AppError(
        429,
        'Too many failed sign-in attempts. Please wait before trying again.',
        'RATE_LIMITED',
        { retryAfterSeconds: rateCheck.retryAfterSeconds }
      );
    }

    const pool = getPool();

    const userRes = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1',
      [normalizedEmail]
    );

    const userRow = userRes.rows[0];
    if (!userRow || !userRow.is_active) {
      await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
      recordFailedLoginAttempt(clientIp, normalizedEmail);
      throw AppError.unauthorized(
        'Invalid email or password. Please check your credentials and try again.',
        'INVALID_CREDENTIALS'
      );
    }

    const passwordValid = await verifyPassword(input.password, userRow.password_hash);
    if (!passwordValid) {
      recordFailedLoginAttempt(clientIp, normalizedEmail);
      throw AppError.unauthorized(
        'Invalid email or password. Please check your credentials and try again.',
        'INVALID_CREDENTIALS'
      );
    }

    clearAccountLoginFailures(clientIp, normalizedEmail);

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);

    await pool.query(
      'DELETE FROM user_sessions WHERE user_id = $1 AND expires_at <= NOW()',
      [userRow.id]
    );

    await pool.query(
      `INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userRow.id,
        tokenHash,
        String(req.ip ?? '').slice(0, 64),
        String(req.headers['user-agent'] ?? '').slice(0, 500),
        expiresAt.toISOString(),
      ]
    );

    const updatedUserRes = await pool.query(
      'UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *',
      [userRow.id]
    );

    const user = mapUserRow(updatedUserRes.rows[0]);
    const { properties, defaultPropertyId } = await getAccessiblePropertiesForUser(
      user.id,
      user.role
    );

    await recordAuditEvent({
      propertyId: defaultPropertyId || null,
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      action: 'login',
      summary: `${user.fullName} (${user.role}) signed in`,
    });

    setSessionCookie(req, res, rawToken);

    const payload: AuthSessionPayload = {
      user,
      properties,
      defaultPropertyId,
      sessionToken: rawToken,
    };

    res.json(payload);
  })
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const { properties, defaultPropertyId } = await getAccessiblePropertiesForUser(
      user.id,
      user.role
    );

    if (req.rawSessionToken) {
      setSessionCookie(req, res, req.rawSessionToken);
    }

    const payload: AuthSessionPayload = {
      user,
      properties,
      defaultPropertyId,
      sessionToken: req.rawSessionToken,
    };
    res.json(payload);
  })
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const candidateTokens = extractCandidateSessionTokens(req);
    if (candidateTokens.length > 0) {
      const hashes = candidateTokens.map(hashSessionToken);
      await getPool().query('DELETE FROM user_sessions WHERE token_hash = ANY($1::text[])', [
        hashes,
      ]);
    }
    clearSessionCookie(req, res);
    res.json({ success: true });
  })
);

authRouter.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const input = forgotPasswordRequestSchema.parse(req.body);
    const normalizedEmail = input.email.toLowerCase();
    const clientIp =
      String(req.ip ?? req.socket?.remoteAddress ?? 'unknown').slice(0, 64) ||
      'unknown';

    enforceSlidingWindowLimit(
      res,
      forgotIpAttempts,
      clientIp,
      MAX_FORGOT_REQUESTS_PER_IP,
      RESET_RATE_WINDOW_MS,
      'Too many password recovery requests. Please wait before trying again.'
    );
    enforceSlidingWindowLimit(
      res,
      forgotEmailAttempts,
      normalizedEmail,
      MAX_FORGOT_REQUESTS_PER_EMAIL,
      RESET_RATE_WINDOW_MS,
      'Too many password recovery requests for this address. Please wait before trying again.'
    );

    const appBaseUrl = resolveSafeAppBaseUrl(req);
    let pendingMail:
      | {
          toEmail: string;
          fullName: string;
          resetUrl: string;
          expiresAt: string;
        }
      | undefined;

    await withTransaction(async (client) => {
      const userRes = await client.query<{
        id: string;
        email: string;
        full_name: string;
        is_active: boolean;
      }>(
        `SELECT id, email, full_name, is_active
         FROM users
         WHERE LOWER(email) = $1
         LIMIT 1
         FOR UPDATE`,
        [normalizedEmail]
      );

      const userRow = userRes.rows[0];
      if (!userRow || !userRow.is_active) {
        return;
      }

      const issued = await issuePasswordResetTokenInTx(client, {
        userId: String(userRow.id),
        deliveryEmail: String(userRow.email),
        initiatedByUserId: null,
        requestedIp: clientIp,
        userAgent: String(req.headers['user-agent'] ?? ''),
      });

      const resetUrl = `${appBaseUrl}/reset-password?token=${encodeURIComponent(
        issued.rawToken
      )}`;

      pendingMail = {
        toEmail: String(userRow.email),
        fullName: String(userRow.full_name),
        resetUrl,
        expiresAt: issued.expiresAt,
      };

      await recordAuditEvent(
        {
          propertyId: null,
          actorUserId: null,
          entityType: 'user',
          entityId: String(userRow.id),
          action: 'password_reset_requested',
          summary: `Password recovery link requested for ${userRow.email}`,
          payload: {
            expiresAt: issued.expiresAt,
          },
        },
        client
      );
    });

    if (pendingMail) {
      await sendPasswordResetEmail({
        ...pendingMail,
        initiatedByAdmin: false,
      }).catch(() => undefined);
    }

    // Constant non-enumerating response: never disclose account existence or reset token
    res.json({
      success: true,
      message:
        'If an active staff account matches that email address, password reset instructions have been sent.',
    });
  })
);

authRouter.get(
  '/reset-password/verify',
  asyncHandler(async (req, res) => {
    const clientIp =
      String(req.ip ?? req.socket?.remoteAddress ?? 'unknown').slice(0, 64) ||
      'unknown';

    enforceSlidingWindowLimit(
      res,
      resetTokenIpAttempts,
      clientIp,
      MAX_RESET_VERIFY_PER_IP,
      RESET_RATE_WINDOW_MS,
      'Too many password reset verification attempts. Please wait before trying again.'
    );

    const verified = await verifyPasswordResetToken(req.query.token);
    res.json(verified);
  })
);

authRouter.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const clientIp =
      String(req.ip ?? req.socket?.remoteAddress ?? 'unknown').slice(0, 64) ||
      'unknown';

    enforceSlidingWindowLimit(
      res,
      resetTokenIpAttempts,
      clientIp,
      MAX_RESET_VERIFY_PER_IP,
      RESET_RATE_WINDOW_MS,
      'Too many password reset attempts. Please wait before trying again.'
    );

    const completed = await consumePasswordResetToken(req.body);
    for (const key of Array.from(failedAccountAttempts.keys())) {
      if (key.endsWith(`|${completed.email.toLowerCase()}`)) {
        failedAccountAttempts.delete(key);
      }
    }
    clearSessionCookie(req, res);

    res.json({
      success: true,
      message: 'Your password has been updated. Please sign in with your new password.',
    });
  })
);

authRouter.put(
  '/account/email',
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = accountChangeEmailSchema.parse(req.body);
    const actorUser = req.user!;
    const preserveHash = req.sessionTokenHash ?? null;

    const { updatedUser, previousEmail } = await withTransaction(
      async (client) => {
        const existingRes = await client.query(
          `SELECT *
           FROM users
           WHERE id = $1 AND is_active = TRUE
           FOR UPDATE`,
          [actorUser.id]
        );
        if (existingRes.rowCount === 0) {
          throw AppError.unauthorized('Session user is no longer active.');
        }
        const existingRow = existingRes.rows[0];
        const prevEmail = String(existingRow.email);

        const passwordValid = await verifyPassword(
          input.currentPassword,
          String(existingRow.password_hash)
        );
        if (!passwordValid) {
          throw AppError.unauthorized(
            'Current password is incorrect.',
            'INVALID_CURRENT_PASSWORD'
          );
        }

        if (input.newEmail.toLowerCase() === prevEmail.toLowerCase()) {
          throw AppError.badRequest(
            'New email address must be different from your current email address.'
          );
        }

        const dupRes = await client.query(
          `SELECT id
           FROM users
           WHERE LOWER(email) = LOWER($1) AND id <> $2
           LIMIT 1`,
          [input.newEmail, actorUser.id]
        );
        if ((dupRes.rowCount ?? 0) > 0) {
          throw AppError.conflict('A user account with this email already exists.');
        }

        const updRes = await client.query(
          `UPDATE users
           SET email = $1,
               updated_at = NOW()
           WHERE id = $2
           RETURNING *`,
          [input.newEmail, actorUser.id]
        );

        await invalidateUnusedPasswordResetTokensInTx(client, actorUser.id);

        if (preserveHash) {
          await client.query(
            'DELETE FROM user_sessions WHERE user_id = $1 AND token_hash <> $2',
            [actorUser.id, preserveHash]
          );
        }

        const { defaultPropertyId } = await getAccessiblePropertiesForUser(
          actorUser.id,
          actorUser.role
        );

        await recordAuditEvent(
          {
            propertyId: defaultPropertyId || null,
            actorUserId: actorUser.id,
            entityType: 'user',
            entityId: actorUser.id,
            action: 'account_email_changed',
            summary: `${existingRow.full_name} changed own login email from ${prevEmail} to ${input.newEmail}`,
            payload: {
              previousEmail: prevEmail,
              newEmail: input.newEmail,
              otherSessionsRotated: Boolean(preserveHash),
            },
          },
          client
        );

        return {
          updatedUser: mapUserRow(updRes.rows[0]),
          previousEmail: prevEmail,
        };
      }
    );

    await sendAccountEmailChangedNotice({
      previousEmail,
      newEmail: updatedUser.email,
      fullName: updatedUser.fullName,
    }).catch(() => undefined);

    res.json({ user: updatedUser });
  })
);

authRouter.put(
  '/account/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = accountChangePasswordSchema.parse(req.body);
    const actorUser = req.user!;
    const preserveHash = req.sessionTokenHash ?? null;

    await withTransaction(async (client) => {
      const existingRes = await client.query(
        `SELECT *
         FROM users
         WHERE id = $1 AND is_active = TRUE
         FOR UPDATE`,
        [actorUser.id]
      );
      if (existingRes.rowCount === 0) {
        throw AppError.unauthorized('Session user is no longer active.');
      }
      const existingRow = existingRes.rows[0];

      const passwordValid = await verifyPassword(
        input.currentPassword,
        String(existingRow.password_hash)
      );
      if (!passwordValid) {
        throw AppError.unauthorized(
          'Current password is incorrect.',
          'INVALID_CURRENT_PASSWORD'
        );
      }

      const nextHash = await hashPassword(input.newPassword);
      await client.query(
        `UPDATE users
         SET password_hash = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [nextHash, actorUser.id]
      );

      await invalidateUnusedPasswordResetTokensInTx(client, actorUser.id);

      if (preserveHash) {
        await client.query(
          'DELETE FROM user_sessions WHERE user_id = $1 AND token_hash <> $2',
          [actorUser.id, preserveHash]
        );
      } else {
        await client.query('DELETE FROM user_sessions WHERE user_id = $1', [
          actorUser.id,
        ]);
      }

      const { defaultPropertyId } = await getAccessiblePropertiesForUser(
        actorUser.id,
        actorUser.role
      );

      await recordAuditEvent(
        {
          propertyId: defaultPropertyId || null,
          actorUserId: actorUser.id,
          entityType: 'user',
          entityId: actorUser.id,
          action: 'account_password_changed',
          summary: `${existingRow.full_name} (${existingRow.email}) changed own account password`,
          payload: {
            otherSessionsRotated: Boolean(preserveHash),
          },
        },
        client
      );
    });

    res.json({ success: true });
  })
);
