import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '../../shared/constants.js';
import type { Property, UserSummary } from '../../shared/types.js';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { AppError, isValidUuid } from '../errors.js';
import { hashSessionToken } from '../security/password.js';
import { mapPropertyRow, mapUserRow } from '../services/mappers.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserSummary;
    rawSessionToken?: string;
    sessionTokenHash?: string;
    property?: Property;
  }
}

function extractExplicitHeaderTokens(req: Request): string[] {
  const tokens: string[] = [];

  const headerSessionToken = req.headers['x-session-token'];
  if (typeof headerSessionToken === 'string' && headerSessionToken.trim().length > 0) {
    tokens.push(headerSessionToken.trim());
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearer.length > 0 && !tokens.includes(bearer)) {
      tokens.push(bearer);
    }
  }

  return tokens;
}

function extractCookieTokens(req: Request): string[] {
  const tokens: string[] = [];
  const targetName = config.sessionCookieName;

  // Parse all matching cookie occurrences from raw Cookie header so a stale
  // unpartitioned/partitioned duplicate cookie never shadows a newer session cookie.
  const rawCookieHeader = req.headers.cookie;
  if (typeof rawCookieHeader === 'string' && rawCookieHeader.length > 0) {
    const pairs = rawCookieHeader.split(';');
    for (let i = pairs.length - 1; i >= 0; i -= 1) {
      const pair = pairs[i];
      const eqIdx = pair.indexOf('=');
      if (eqIdx <= 0) continue;
      const name = pair.slice(0, eqIdx).trim();
      if (name !== targetName) continue;
      const rawVal = pair.slice(eqIdx + 1).trim();
      if (!rawVal) continue;
      let decoded = rawVal;
      try {
        decoded = decodeURIComponent(rawVal).trim();
      } catch {
        decoded = rawVal;
      }
      if (decoded.length > 0 && !tokens.includes(decoded)) {
        tokens.push(decoded);
      }
    }
  }

  const parsedCookieToken = req.cookies?.[targetName];
  if (typeof parsedCookieToken === 'string' && parsedCookieToken.trim().length > 0) {
    const trimmedCookie = parsedCookieToken.trim();
    if (!tokens.includes(trimmedCookie)) {
      tokens.push(trimmedCookie);
    }
  }

  return tokens;
}

export function extractCandidateSessionTokens(req: Request): string[] {
  const tokens = extractExplicitHeaderTokens(req);
  for (const cookieToken of extractCookieTokens(req)) {
    if (!tokens.includes(cookieToken)) {
      tokens.push(cookieToken);
    }
  }
  return tokens;
}

export function extractRawSessionToken(req: Request): string | null {
  return extractCandidateSessionTokens(req)[0] ?? null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const explicitHeaderTokens = extractExplicitHeaderTokens(req);
    const cookieTokens = extractCookieTokens(req);
    const candidateTokens = [...explicitHeaderTokens];
    for (const ct of cookieTokens) {
      if (!candidateTokens.includes(ct)) {
        candidateTokens.push(ct);
      }
    }

    if (candidateTokens.length === 0) {
      throw AppError.unauthorized(
        'Authentication required. Please sign in to access this resource.',
        'AUTH_TOKEN_MISSING'
      );
    }

    const hashToRaw = new Map<string, string>();
    const candidateHashes: string[] = [];
    for (const raw of candidateTokens) {
      const h = hashSessionToken(raw);
      if (!hashToRaw.has(h)) {
        hashToRaw.set(h, raw);
        candidateHashes.push(h);
      }
    }

    const explicitHeaderHashes = explicitHeaderTokens.map(hashSessionToken);

    const pool = getPool();
    const sessionRes = await pool.query(
      `SELECT u.*, s.token_hash AS matched_token_hash, s.created_at AS session_created_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ANY($1::text[])
         AND s.expires_at > NOW()
         AND u.is_active = TRUE
       ORDER BY s.created_at DESC`,
      [candidateHashes]
    );

    if (sessionRes.rowCount === 0) {
      throw AppError.unauthorized(
        'Session expired or invalid. Please sign in again.',
        'SESSION_EXPIRED'
      );
    }

    // 1. Explicit header tokens (X-Session-Token, Authorization: Bearer) always take priority.
    // 2. If falling back to browser cookies, sessionRes is ordered by s.created_at DESC so the
    //    most recently established active session wins over any stale duplicate cookie.
    const matchedRow =
      explicitHeaderHashes
        .map((h) => sessionRes.rows.find((row) => String(row.matched_token_hash).trim() === h))
        .find(Boolean) ?? sessionRes.rows[0];

    const matchedUser = mapUserRow(matchedRow);

    // Fail-closed cross-account session guard: X-Auth-User-Id never grants privileges,
    // but if an authenticated UI tab asserts a specific active user id and its explicit
    // token expired/logged out while a different user's cookie matched, reject with 401
    // instead of silently downgrading/switching the actor identity on protected routes.
    const rawExpectedUserId = req.headers['x-auth-user-id'];
    const expectedUserId =
      typeof rawExpectedUserId === 'string' ? rawExpectedUserId.trim() : '';
    const isAuthBootstrapMe =
      req.method.toUpperCase() === 'GET' &&
      req.baseUrl === '/api/auth' &&
      req.path === '/me';

    if (expectedUserId && !isAuthBootstrapMe && matchedUser.id !== expectedUserId) {
      throw AppError.unauthorized(
        'Your active session changed in another tab or window. Please sign in again.',
        'SESSION_MISMATCH'
      );
    }

    const matchedHash = String(matchedRow.matched_token_hash).trim();
    req.user = matchedUser;
    req.sessionTokenHash = matchedHash;
    req.rawSessionToken = hashToRaw.get(matchedHash);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized());
      return;
    }
    const normalizedUserRole = String(req.user.role ?? '')
      .trim()
      .toLowerCase() as UserRole;
    if (!allowedRoles.includes(normalizedUserRole)) {
      next(
        AppError.forbidden(
          `Access denied. Required role: ${allowedRoles.join(' or ')}.`
        )
      );
      return;
    }
    next();
  };
}

export async function requirePropertyContext(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw AppError.unauthorized();
    }

    const headerPropId = req.headers['x-property-id'];
    const queryPropId = req.query.propertyId;
    const requestedId =
      (typeof headerPropId === 'string' && headerPropId.trim()) ||
      (typeof queryPropId === 'string' && queryPropId.trim()) ||
      null;

    const pool = getPool();
    let propRow: Record<string, any> | undefined;

    if (requestedId) {
      if (!isValidUuid(requestedId)) {
        throw AppError.invalidIdentifier('Invalid property identifier');
      }
      if (req.user.role === 'admin') {
        const res = await pool.query(
          'SELECT * FROM properties WHERE id = $1 AND is_active = TRUE LIMIT 1',
          [requestedId]
        );
        propRow = res.rows[0];
      } else {
        const res = await pool.query(
          `SELECT p.*
           FROM properties p
           JOIN user_property_access upa ON upa.property_id = p.id
           WHERE p.id = $1 AND upa.user_id = $2 AND p.is_active = TRUE
           LIMIT 1`,
          [requestedId, req.user.id]
        );
        propRow = res.rows[0];
        if (!propRow) {
          throw AppError.forbidden('You do not have access to the selected property');
        }
      }
    } else {
      // Fallback to default accessible property
      if (req.user.role === 'admin') {
        const res = await pool.query(
          `SELECT p.*
           FROM properties p
           LEFT JOIN user_property_access upa ON upa.property_id = p.id AND upa.user_id = $1
           WHERE p.is_active = TRUE
           ORDER BY COALESCE(upa.is_default, FALSE) DESC, p.created_at ASC
           LIMIT 1`,
          [req.user.id]
        );
        propRow = res.rows[0];
      } else {
        const res = await pool.query(
          `SELECT p.*
           FROM properties p
           JOIN user_property_access upa ON upa.property_id = p.id
           WHERE upa.user_id = $1 AND p.is_active = TRUE
           ORDER BY upa.is_default DESC, p.created_at ASC
           LIMIT 1`,
          [req.user.id]
        );
        propRow = res.rows[0];
      }
    }

    if (!propRow) {
      throw AppError.notFound('No active property found for your account');
    }

    req.property = mapPropertyRow(propRow);
    next();
  } catch (err) {
    next(err);
  }
}
