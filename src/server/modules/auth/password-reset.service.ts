import type { PoolClient } from 'pg';
import { resetPasswordConfirmSchema } from '../../../shared/schemas.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import {
  generatePasswordResetToken,
  hashPassword,
  hashPasswordResetToken,
} from '../../security/password.js';
import { recordAuditEvent } from '../../services/audit.service.js';

export const PASSWORD_RESET_TTL_MINUTES = 30;

export const INVALID_RESET_TOKEN_MESSAGE =
  'This password reset link is invalid, expired, or has already been used.';

export async function invalidateUnusedPasswordResetTokensInTx(
  client: PoolClient,
  userId: string
): Promise<void> {
  await client.query(
    `UPDATE password_reset_tokens
     SET invalidated_at = NOW()
     WHERE user_id = $1
       AND used_at IS NULL
       AND invalidated_at IS NULL`,
    [userId]
  );
}

export async function issuePasswordResetTokenInTx(
  client: PoolClient,
  params: {
    userId: string;
    deliveryEmail: string;
    initiatedByUserId?: string | null;
    requestedIp?: string;
    userAgent?: string;
    ttlMinutes?: number;
  }
): Promise<{ rawToken: string; expiresAt: string }> {
  await invalidateUnusedPasswordResetTokensInTx(client, params.userId);

  const rawToken = generatePasswordResetToken();
  const tokenHash = hashPasswordResetToken(rawToken);
  const ttlMinutes = Math.max(1, params.ttlMinutes ?? PASSWORD_RESET_TTL_MINUTES);
  const expiresAtDate = new Date(Date.now() + ttlMinutes * 60 * 1000);

  await client.query(
    `INSERT INTO password_reset_tokens (
       user_id,
       token_hash,
       delivery_email,
       initiated_by_user_id,
       requested_ip,
       user_agent,
       expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.userId,
      tokenHash,
      params.deliveryEmail.trim().toLowerCase(),
      params.initiatedByUserId ?? null,
      String(params.requestedIp ?? '').slice(0, 64),
      String(params.userAgent ?? '').slice(0, 500),
      expiresAtDate.toISOString(),
    ]
  );

  return {
    rawToken,
    expiresAt: expiresAtDate.toISOString(),
  };
}

export async function verifyPasswordResetToken(
  rawToken: unknown
): Promise<{ valid: true; expiresAt: string }> {
  if (
    typeof rawToken !== 'string' ||
    !/^[a-fA-F0-9]{32,128}$/.test(rawToken.trim())
  ) {
    throw new AppError(
      400,
      INVALID_RESET_TOKEN_MESSAGE,
      'INVALID_OR_EXPIRED_RESET_TOKEN'
    );
  }

  const tokenHash = hashPasswordResetToken(rawToken);
  const pool = getPool();
  const res = await pool.query<{ expires_at: Date }>(
    `SELECT prt.expires_at
     FROM password_reset_tokens prt
     JOIN users u ON u.id = prt.user_id
     WHERE prt.token_hash = $1
       AND prt.used_at IS NULL
       AND prt.invalidated_at IS NULL
       AND prt.expires_at > NOW()
       AND u.is_active = TRUE
       AND LOWER(u.email) = LOWER(prt.delivery_email)
     LIMIT 1`,
    [tokenHash]
  );

  if (res.rowCount === 0) {
    throw new AppError(
      400,
      INVALID_RESET_TOKEN_MESSAGE,
      'INVALID_OR_EXPIRED_RESET_TOKEN'
    );
  }

  return {
    valid: true,
    expiresAt: new Date(res.rows[0].expires_at).toISOString(),
  };
}

export async function consumePasswordResetToken(
  rawInput: unknown
): Promise<{ userId: string; email: string }> {
  const input = resetPasswordConfirmSchema.parse(rawInput);
  const tokenHash = hashPasswordResetToken(input.token);
  const newPasswordHash = await hashPassword(input.newPassword);

  return withTransaction(async (client) => {
    const claimRes = await client.query<{
      id: string;
      user_id: string;
      email: string;
      full_name: string;
    }>(
      `UPDATE password_reset_tokens prt
       SET used_at = NOW()
       FROM users u
       WHERE prt.token_hash = $1
         AND prt.user_id = u.id
         AND prt.used_at IS NULL
         AND prt.invalidated_at IS NULL
         AND prt.expires_at > NOW()
         AND u.is_active = TRUE
         AND LOWER(u.email) = LOWER(prt.delivery_email)
       RETURNING prt.id, prt.user_id, u.email, u.full_name`,
      [tokenHash]
    );

    if (claimRes.rowCount === 0) {
      throw new AppError(
        400,
        INVALID_RESET_TOKEN_MESSAGE,
        'INVALID_OR_EXPIRED_RESET_TOKEN'
      );
    }

    const claimed = claimRes.rows[0];
    const userId = String(claimed.user_id);

    await client.query(
      `UPDATE users
       SET password_hash = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [newPasswordHash, userId]
    );

    await invalidateUnusedPasswordResetTokensInTx(client, userId);

    // Revoke all existing sessions upon password recovery completion
    await client.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);

    await recordAuditEvent(
      {
        propertyId: null,
        actorUserId: userId,
        entityType: 'user',
        entityId: userId,
        action: 'password_reset_completed',
        summary: `Completed single-use password reset for ${claimed.email} and revoked active sessions`,
        payload: {
          sessionsRotated: true,
        },
      },
      client
    );

    return {
      userId,
      email: String(claimed.email),
    };
  });
}
