import type { PoolClient } from 'pg';
import type {
  StaffDepartment,
  StaffEmploymentStatus,
  UserRole,
} from '../../../shared/constants.js';
import {
  managedUserCreateSchema,
  managedUserPropertyAccessSchema,
  managedUserResetPasswordSchema,
  managedUserUpdateSchema,
} from '../../../shared/schemas.js';
import type {
  AdminPasswordResetInitiateResponse,
  LinkedStaffProfileSummary,
  ManagedUserAccount,
  ManagedUserPropertyAccessItem,
  Property,
  UserSummary,
} from '../../../shared/types.js';
import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { hashPassword } from '../../security/password.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import {
  isExternalEmailTransportConfigured,
  sendAccountEmailChangedNotice,
  sendPasswordResetEmail,
} from '../../services/mailer.service.js';
import {
  invalidateUnusedPasswordResetTokensInTx,
  issuePasswordResetTokenInTx,
} from '../auth/password-reset.service.js';

function assertAdminActor(actorUser: UserSummary): void {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden(
      'Administrator role is required to manage user accounts, roles, credentials, and property access.'
    );
  }
}

async function getActorAccessiblePropertyIdSet(
  db: Queryable,
  actorUser: UserSummary
): Promise<Set<string>> {
  if (actorUser.role === 'admin') {
    const res = await db.query<{ id: string }>(
      'SELECT id FROM properties WHERE is_active = TRUE'
    );
    return new Set(res.rows.map((r) => String(r.id)));
  }

  const res = await db.query<{ property_id: string }>(
    `SELECT upa.property_id
     FROM user_property_access upa
     JOIN properties p ON p.id = upa.property_id
     WHERE upa.user_id = $1 AND p.is_active = TRUE`,
    [actorUser.id]
  );
  return new Set(res.rows.map((r) => String(r.property_id)));
}

async function validateRequestedPropertyGrantsInTx(
  client: PoolClient,
  actorUser: UserSummary,
  propertyIds: readonly string[]
): Promise<void> {
  if (propertyIds.length === 0) return;

  const accessibleSet = await getActorAccessiblePropertyIdSet(client, actorUser);
  for (const propId of propertyIds) {
    if (!accessibleSet.has(propId)) {
      throw AppError.forbidden(
        'Cannot grant access to an inactive property or a property you do not possess access to.'
      );
    }
  }
}

async function ensureRemainingActiveAdminExistsInTx(
  client: PoolClient,
  excludedUserId: string
): Promise<void> {
  const countRes = await client.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
     FROM users
     WHERE role = 'admin' AND is_active = TRUE AND id <> $1`,
    [excludedUserId]
  );
  if (Number(countRes.rows[0]?.cnt ?? 0) < 1) {
    throw AppError.conflict(
      'Cannot deactivate or demote the last active administrator account.'
    );
  }
}

/**
 * Ensures non-admin users never retain dangling `property_staff_profiles.user_id` links
 * in properties where their `user_property_access` has been revoked.
 * Historical staff profile records and assignments are preserved intact.
 */
async function unlinkUnauthorizedStaffProfilesInTx(
  client: PoolClient,
  targetUserId: string,
  actorUserId: string
): Promise<string[]> {
  const unlinkedRes = await client.query<{ id: string }>(
    `UPDATE property_staff_profiles sp
     SET user_id = NULL,
         updated_by = $2,
         updated_at = NOW()
     WHERE sp.user_id = $1
       AND NOT EXISTS (
         SELECT 1
         FROM user_property_access upa
         JOIN properties p ON p.id = upa.property_id
         WHERE upa.user_id = sp.user_id
           AND upa.property_id = sp.property_id
           AND p.is_active = TRUE
       )
     RETURNING sp.id`,
    [targetUserId, actorUserId]
  );
  return unlinkedRes.rows.map((r) => String(r.id));
}

const SAFE_USER_SELECT_SQL = `
  SELECT u.id,
         u.email,
         u.full_name,
         u.role,
         u.phone,
         u.is_active,
         u.last_login_at,
         u.created_at,
         u.updated_at
  FROM users u
`;

function mapManagedUserRows(
  userRows: ReadonlyArray<Record<string, any>>,
  accessRows: ReadonlyArray<Record<string, any>>,
  staffRows: ReadonlyArray<Record<string, any>>
): ManagedUserAccount[] {
  const accessByUser = new Map<string, ManagedUserPropertyAccessItem[]>();
  const staffByUser = new Map<string, LinkedStaffProfileSummary[]>();

  for (const row of accessRows) {
    const uid = String(row.user_id);
    const list = accessByUser.get(uid) ?? [];
    list.push({
      propertyId: String(row.property_id),
      propertyCode: String(row.property_code),
      propertyName: String(row.property_name),
      isDefault: Boolean(row.is_default),
      grantedAt: new Date(row.created_at).toISOString(),
    });
    accessByUser.set(uid, list);
  }

  for (const row of staffRows) {
    const uid = String(row.user_id);
    const list = staffByUser.get(uid) ?? [];
    list.push({
      staffId: String(row.staff_id),
      propertyId: String(row.property_id),
      propertyCode: String(row.property_code),
      propertyName: String(row.property_name),
      employeeCode: String(row.employee_code),
      fullName: String(row.full_name),
      department: row.department as StaffDepartment,
      jobTitle: String(row.job_title),
      employmentStatus: row.employment_status as StaffEmploymentStatus,
    });
    staffByUser.set(uid, list);
  }

  return userRows.map((row) => {
    const uid = String(row.id);
    const linkedStaffProfiles = staffByUser.get(uid) ?? [];
    return {
      id: uid,
      email: String(row.email),
      fullName: String(row.full_name),
      role: row.role as UserRole,
      phone: String(row.phone ?? ''),
      isActive: Boolean(row.is_active),
      lastLoginAt: row.last_login_at
        ? new Date(row.last_login_at).toISOString()
        : null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      propertyAccess: accessByUser.get(uid) ?? [],
      linkedStaffCount: linkedStaffProfiles.length,
      linkedStaffProfiles,
    };
  });
}

export interface ListManagedUsersFilter {
  role?: string;
  isActive?: boolean;
  propertyId?: string;
  search?: string;
}

export async function listManagedUsers(
  actorUser: UserSummary,
  filter: ListManagedUsersFilter = {}
): Promise<ManagedUserAccount[]> {
  assertAdminActor(actorUser);
  const pool = getPool();
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filter.role) {
    if (filter.role !== 'admin' && filter.role !== 'receptionist') {
      throw AppError.badRequest(`Invalid role filter: "${filter.role}"`);
    }
    params.push(filter.role);
    conditions.push(`u.role = $${params.length}`);
  }

  if (filter.isActive !== undefined) {
    params.push(filter.isActive);
    conditions.push(`u.is_active = $${params.length}`);
  }

  if (filter.propertyId) {
    params.push(filter.propertyId);
    conditions.push(
      `(u.role = 'admin' OR EXISTS (
        SELECT 1 FROM user_property_access upa_f
        WHERE upa_f.user_id = u.id AND upa_f.property_id = $${params.length}
      ))`
    );
  }

  if (filter.search && filter.search.trim().length > 0) {
    const q = `%${filter.search.trim()}%`;
    params.push(q);
    conditions.push(
      `(u.full_name ILIKE $${params.length}
        OR u.email ILIKE $${params.length}
        OR u.phone ILIKE $${params.length})`
    );
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const usersRes = await pool.query(
    `${SAFE_USER_SELECT_SQL}
     ${whereClause}
     ORDER BY u.is_active DESC, u.role ASC, u.full_name ASC
     LIMIT 300`,
    params
  );

  if (usersRes.rows.length === 0) {
    return [];
  }

  const userIds = usersRes.rows.map((r) => String(r.id));
  const [accessRes, staffRes] = await Promise.all([
    pool.query(
      `SELECT upa.user_id,
              upa.property_id,
              upa.is_default,
              upa.created_at,
              p.code AS property_code,
              p.name AS property_name
       FROM user_property_access upa
       JOIN properties p ON p.id = upa.property_id
       WHERE upa.user_id = ANY($1::uuid[])
         AND p.is_active = TRUE
       ORDER BY upa.is_default DESC, p.created_at ASC`,
      [userIds]
    ),
    pool.query(
      `SELECT sp.id AS staff_id,
              sp.user_id,
              sp.property_id,
              p.code AS property_code,
              p.name AS property_name,
              sp.employee_code,
              sp.full_name,
              sp.department,
              sp.job_title,
              sp.employment_status
       FROM property_staff_profiles sp
       JOIN properties p ON p.id = sp.property_id
       WHERE sp.user_id = ANY($1::uuid[])
         AND p.is_active = TRUE
       ORDER BY p.created_at ASC, sp.employee_code ASC`,
      [userIds]
    ),
  ]);

  return mapManagedUserRows(usersRes.rows, accessRes.rows, staffRes.rows);
}

export async function getManagedUserById(
  actorUser: UserSummary,
  userId: string
): Promise<ManagedUserAccount> {
  assertAdminActor(actorUser);
  const pool = getPool();

  const [userRes, accessRes, staffRes] = await Promise.all([
    pool.query(`${SAFE_USER_SELECT_SQL} WHERE u.id = $1`, [userId]),
    pool.query(
      `SELECT upa.user_id,
              upa.property_id,
              upa.is_default,
              upa.created_at,
              p.code AS property_code,
              p.name AS property_name
       FROM user_property_access upa
       JOIN properties p ON p.id = upa.property_id
       WHERE upa.user_id = $1
         AND p.is_active = TRUE
       ORDER BY upa.is_default DESC, p.created_at ASC`,
      [userId]
    ),
    pool.query(
      `SELECT sp.id AS staff_id,
              sp.user_id,
              sp.property_id,
              p.code AS property_code,
              p.name AS property_name,
              sp.employee_code,
              sp.full_name,
              sp.department,
              sp.job_title,
              sp.employment_status
       FROM property_staff_profiles sp
       JOIN properties p ON p.id = sp.property_id
       WHERE sp.user_id = $1
         AND p.is_active = TRUE
       ORDER BY p.created_at ASC, sp.employee_code ASC`,
      [userId]
    ),
  ]);

  if (userRes.rowCount === 0) {
    throw AppError.notFound('User account not found');
  }

  return mapManagedUserRows(userRes.rows, accessRes.rows, staffRes.rows)[0];
}

export async function createManagedUser(
  contextProperty: Property,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<ManagedUserAccount> {
  assertAdminActor(actorUser);
  const input = managedUserCreateSchema.parse(rawInput);

  const uniquePropIds = Array.from(new Set(input.propertyIds));
  if (input.defaultPropertyId && !uniquePropIds.includes(input.defaultPropertyId)) {
    throw AppError.badRequest(
      'Default property must be included in the assigned properties list.'
    );
  }

  if (
    input.role === 'receptionist' &&
    input.isActive &&
    uniquePropIds.length === 0
  ) {
    throw AppError.badRequest(
      'Active receptionist accounts must be assigned access to at least one property.'
    );
  }

  const createdId = await withTransaction(async (client) => {
    const dupCheck = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [input.email]
    );
    if ((dupCheck.rowCount ?? 0) > 0) {
      throw AppError.conflict('A user account with this email already exists.');
    }

    await validateRequestedPropertyGrantsInTx(client, actorUser, uniquePropIds);

    const passwordHash = await hashPassword(input.password);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, phone, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.email,
        passwordHash,
        input.fullName,
        input.role,
        input.phone,
        input.isActive,
      ]
    );
    const userId = ins.rows[0].id;

    const chosenDefault =
      input.defaultPropertyId ?? (uniquePropIds[0] ?? null);

    for (const propId of uniquePropIds) {
      await client.query(
        `INSERT INTO user_property_access (user_id, property_id, is_default)
         VALUES ($1, $2, $3)`,
        [userId, propId, propId === chosenDefault]
      );
    }

    await recordAuditEvent(
      {
        propertyId: contextProperty.id,
        actorUserId: actorUser.id,
        entityType: 'user',
        entityId: userId,
        action: 'user_created',
        summary: `Created ${input.role} account for ${input.fullName} (${input.email})`,
        payload: {
          email: input.email,
          role: input.role,
          isActive: input.isActive,
          propertyIds: uniquePropIds,
        },
      },
      client
    );

    return userId;
  });

  return getManagedUserById(actorUser, createdId);
}

export async function updateManagedUser(
  contextProperty: Property,
  targetUserId: string,
  actorUser: UserSummary,
  rawInput: unknown,
  preserveSessionTokenHash?: string
): Promise<ManagedUserAccount> {
  assertAdminActor(actorUser);
  const input = managedUserUpdateSchema.parse(rawInput);

  let emailNoticePayload:
    | { previousEmail: string; newEmail: string; fullName: string }
    | undefined;

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT id, email, full_name, role, phone, is_active
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [targetUserId]
    );
    if (existingRes.rowCount === 0) {
      throw AppError.notFound('User account not found');
    }
    const existing = existingRes.rows[0];
    const previousEmail = String(existing.email);
    const nextEmail =
      input.email !== undefined
        ? input.email.trim().toLowerCase()
        : previousEmail;
    const emailChanged = nextEmail.toLowerCase() !== previousEmail.toLowerCase();

    if (
      emailChanged &&
      existing.role === 'admin' &&
      targetUserId !== actorUser.id
    ) {
      throw AppError.forbidden(
        'Administrators may change receptionist email addresses or update their own email in Account Settings, not another administrator account email.'
      );
    }

    if (emailChanged) {
      const dupRes = await client.query(
        `SELECT id
         FROM users
         WHERE LOWER(email) = LOWER($1) AND id <> $2
         LIMIT 1`,
        [nextEmail, targetUserId]
      );
      if ((dupRes.rowCount ?? 0) > 0) {
        throw AppError.conflict('A user account with this email already exists.');
      }
    }

    const nextFullName = input.fullName ?? String(existing.full_name);
    const nextPhone =
      input.phone !== undefined ? input.phone : String(existing.phone ?? '');
    const nextRole = (input.role ?? existing.role) as UserRole;
    const nextIsActive =
      input.isActive !== undefined ? input.isActive : Boolean(existing.is_active);

    // Prevent self-lockout / self-demotion
    if (targetUserId === actorUser.id) {
      if (!nextIsActive) {
        throw AppError.badRequest(
          'You cannot deactivate your own active administrator account.'
        );
      }
      if (nextRole !== 'admin') {
        throw AppError.badRequest(
          'You cannot remove administrator privileges from your own account.'
        );
      }
    }

    // Prevent deactivating or demoting the last active administrator
    if (
      existing.role === 'admin' &&
      Boolean(existing.is_active) &&
      (!nextIsActive || nextRole !== 'admin')
    ) {
      await ensureRemainingActiveAdminExistsInTx(client, targetUserId);
    }

    // Ensure active receptionists have at least one property assigned
    if (nextRole === 'receptionist' && nextIsActive) {
      const accessCheck = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM user_property_access upa
         JOIN properties p ON p.id = upa.property_id
         WHERE upa.user_id = $1 AND p.is_active = TRUE`,
        [targetUserId]
      );
      if (Number(accessCheck.rows[0]?.cnt ?? 0) === 0) {
        throw AppError.badRequest(
          'Assign at least one active property to this user before setting their role to active Receptionist.'
        );
      }
    }

    await client.query(
      `UPDATE users
       SET email = $1,
           full_name = $2,
           phone = $3,
           role = $4,
           is_active = $5,
           updated_at = NOW()
       WHERE id = $6`,
      [nextEmail, nextFullName, nextPhone, nextRole, nextIsActive, targetUserId]
    );

    if (emailChanged) {
      await invalidateUnusedPasswordResetTokensInTx(client, targetUserId);
      emailNoticePayload = {
        previousEmail,
        newEmail: nextEmail,
        fullName: nextFullName,
      };
    }

    // If demoted from admin to receptionist, clear any staff links on properties they lack access to
    let unlinkedStaffProfileIds: string[] = [];
    if (nextRole === 'receptionist') {
      unlinkedStaffProfileIds = await unlinkUnauthorizedStaffProfilesInTx(
        client,
        targetUserId,
        actorUser.id
      );
    }

    // Revoke active sessions immediately on account deactivation or login email change
    let revokedSessions = false;
    if (Boolean(existing.is_active) && !nextIsActive) {
      await client.query('DELETE FROM user_sessions WHERE user_id = $1', [
        targetUserId,
      ]);
      revokedSessions = true;
    } else if (emailChanged) {
      if (targetUserId === actorUser.id && preserveSessionTokenHash) {
        await client.query(
          'DELETE FROM user_sessions WHERE user_id = $1 AND token_hash <> $2',
          [targetUserId, preserveSessionTokenHash]
        );
      } else {
        await client.query('DELETE FROM user_sessions WHERE user_id = $1', [
          targetUserId,
        ]);
      }
      revokedSessions = true;
    }

    const action =
      Boolean(existing.is_active) !== nextIsActive
        ? nextIsActive
          ? 'user_activated'
          : 'user_deactivated'
        : existing.role !== nextRole
          ? 'user_role_changed'
          : emailChanged
            ? 'user_email_changed'
            : 'user_updated';

    await recordAuditEvent(
      {
        propertyId: contextProperty.id,
        actorUserId: actorUser.id,
        entityType: 'user',
        entityId: targetUserId,
        action,
        summary: emailChanged
          ? `Updated user email from ${previousEmail} to ${nextEmail}`
          : `Updated user account ${nextEmail} (${action.replace('user_', '')})`,
        payload: {
          previousEmail,
          email: nextEmail,
          emailChanged,
          previousRole: existing.role,
          role: nextRole,
          previousActive: Boolean(existing.is_active),
          isActive: nextIsActive,
          revokedSessions,
          unlinkedStaffProfileIds,
        },
      },
      client
    );
  });

  if (emailNoticePayload) {
    await sendAccountEmailChangedNotice(emailNoticePayload).catch(
      () => undefined
    );
  }

  return getManagedUserById(actorUser, targetUserId);
}

export async function updateManagedUserPropertyAccess(
  contextProperty: Property,
  targetUserId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<ManagedUserAccount> {
  assertAdminActor(actorUser);
  const input = managedUserPropertyAccessSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const userRes = await client.query(
      `SELECT id, email, full_name, role, is_active
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [targetUserId]
    );
    if (userRes.rowCount === 0) {
      throw AppError.notFound('User account not found');
    }
    const targetUser = userRes.rows[0];

    await validateRequestedPropertyGrantsInTx(
      client,
      actorUser,
      input.propertyIds
    );

    if (
      targetUser.role === 'receptionist' &&
      Boolean(targetUser.is_active) &&
      input.propertyIds.length === 0
    ) {
      throw AppError.badRequest(
        'Active receptionist accounts must retain access to at least one property. Deactivate the account first if revoking all property access.'
      );
    }

    const accessibleSet = await getActorAccessiblePropertyIdSet(client, actorUser);
    const accessibleIds = Array.from(accessibleSet);

    if (accessibleIds.length > 0) {
      await client.query(
        `DELETE FROM user_property_access
         WHERE user_id = $1 AND property_id = ANY($2::uuid[])`,
        [targetUserId, accessibleIds]
      );
    }

    const chosenDefault =
      input.defaultPropertyId ?? (input.propertyIds[0] ?? null);

    if (chosenDefault) {
      await client.query(
        `UPDATE user_property_access
         SET is_default = FALSE
         WHERE user_id = $1`,
        [targetUserId]
      );
    }

    for (const propId of input.propertyIds) {
      await client.query(
        `INSERT INTO user_property_access (user_id, property_id, is_default)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, property_id)
         DO UPDATE SET is_default = EXCLUDED.is_default`,
        [targetUserId, propId, propId === chosenDefault]
      );
    }

    let unlinkedStaffProfileIds: string[] = [];
    if (targetUser.role !== 'admin') {
      unlinkedStaffProfileIds = await unlinkUnauthorizedStaffProfilesInTx(
        client,
        targetUserId,
        actorUser.id
      );
    }

    await recordAuditEvent(
      {
        propertyId: contextProperty.id,
        actorUserId: actorUser.id,
        entityType: 'user',
        entityId: targetUserId,
        action: 'user_property_access_updated',
        summary: `Updated property access for ${targetUser.email}`,
        payload: {
          propertyIds: input.propertyIds,
          defaultPropertyId: chosenDefault,
          unlinkedStaffProfileIds,
        },
      },
      client
    );
  });

  return getManagedUserById(actorUser, targetUserId);
}

export async function resetManagedUserPassword(
  contextProperty: Property,
  targetUserId: string,
  actorUser: UserSummary,
  rawInput: unknown,
  preserveSessionTokenHash?: string
): Promise<{ success: true }> {
  assertAdminActor(actorUser);
  const input = managedUserResetPasswordSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const userRes = await client.query(
      'SELECT id, email, full_name FROM users WHERE id = $1 FOR UPDATE',
      [targetUserId]
    );
    if (userRes.rowCount === 0) {
      throw AppError.notFound('User account not found');
    }
    const targetUser = userRes.rows[0];

    const passwordHash = await hashPassword(input.newPassword);
    await client.query(
      `UPDATE users
       SET password_hash = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, targetUserId]
    );

    await invalidateUnusedPasswordResetTokensInTx(client, targetUserId);

    if (targetUserId === actorUser.id && preserveSessionTokenHash) {
      await client.query(
        'DELETE FROM user_sessions WHERE user_id = $1 AND token_hash <> $2',
        [targetUserId, preserveSessionTokenHash]
      );
    } else {
      await client.query('DELETE FROM user_sessions WHERE user_id = $1', [
        targetUserId,
      ]);
    }

    await recordAuditEvent(
      {
        propertyId: contextProperty.id,
        actorUserId: actorUser.id,
        entityType: 'user',
        entityId: targetUserId,
        action: 'user_password_reset',
        summary: `Reset password and rotated sessions for ${targetUser.email}`,
        payload: {
          targetUserId,
          sessionsRotated: true,
        },
      },
      client
    );
  });

  return { success: true };
}

export async function initiateManagedUserPasswordReset(
  contextProperty: Property,
  targetUserId: string,
  actorUser: UserSummary,
  options: {
    appBaseUrl: string;
    requestedIp?: string;
    userAgent?: string;
  }
): Promise<AdminPasswordResetInitiateResponse> {
  assertAdminActor(actorUser);

  const issuedData = await withTransaction(async (client) => {
    const userRes = await client.query<{
      id: string;
      email: string;
      full_name: string;
      role: string;
      is_active: boolean;
    }>(
      `SELECT id, email, full_name, role, is_active
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [targetUserId]
    );
    if (userRes.rowCount === 0) {
      throw AppError.notFound('User account not found');
    }
    const targetUser = userRes.rows[0];
    if (!targetUser.is_active) {
      throw AppError.conflict(
        'Cannot initiate a password reset link for an inactive user account. Activate the account first.'
      );
    }

    const issued = await issuePasswordResetTokenInTx(client, {
      userId: targetUserId,
      deliveryEmail: String(targetUser.email),
      initiatedByUserId: actorUser.id,
      requestedIp: options.requestedIp,
      userAgent: options.userAgent,
    });

    await recordAuditEvent(
      {
        propertyId: contextProperty.id,
        actorUserId: actorUser.id,
        entityType: 'user',
        entityId: targetUserId,
        action: 'user_password_reset_initiated',
        summary: `Initiated single-use password reset link for ${targetUser.email}`,
        payload: {
          targetUserId,
          expiresAt: issued.expiresAt,
        },
      },
      client
    );

    return {
      email: String(targetUser.email),
      fullName: String(targetUser.full_name),
      rawToken: issued.rawToken,
      expiresAt: issued.expiresAt,
    };
  });

  const resetUrl = `${options.appBaseUrl}/reset-password?token=${encodeURIComponent(
    issuedData.rawToken
  )}`;

  const mailResult = await sendPasswordResetEmail({
    toEmail: issuedData.email,
    fullName: issuedData.fullName,
    resetUrl,
    expiresAt: issuedData.expiresAt,
    initiatedByAdmin: true,
  }).catch(() => ({ deliveredExternally: false }));

  if (isExternalEmailTransportConfigured() && mailResult.deliveredExternally) {
    return {
      success: true,
      deliveryMode: 'email',
      expiresAt: issuedData.expiresAt,
    };
  }

  return {
    success: true,
    deliveryMode: 'manual_link_fallback',
    expiresAt: issuedData.expiresAt,
    resetUrl,
  };
}
