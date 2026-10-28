import {
  STAFF_DEPARTMENTS,
  STAFF_EMPLOYMENT_STATUSES,
  STAFF_SHIFT_TYPES,
  type ServiceCategory,
  type ServicePricingUnit,
  type ServiceRequestStatus,
  type ServiceBillingStatus,
  type StaffDepartment,
  type StaffEmploymentStatus,
  type StaffShiftType,
  type UserRole,
} from '../../../shared/constants.js';
import {
  staffProfileCreateSchema,
  staffProfileUpdateSchema,
} from '../../../shared/schemas.js';
import type {
  Property,
  ServiceRequestRecord,
  StaffListResponse,
  StaffProfileDetail,
  StaffProfileRecord,
  UserSummary,
} from '../../../shared/types.js';
import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';

function mapStaffProfileRow(row: Record<string, any>): StaffProfileRecord {
  return {
    id: String(row.id),
    propertyId: String(row.property_id),
    userId: row.user_id ? String(row.user_id) : null,
    linkedUserEmail: row.linked_user_email ? String(row.linked_user_email) : null,
    linkedUserRole: (row.linked_user_role as UserRole) ?? null,
    linkedUserIsActive:
      row.linked_user_is_active !== null && row.linked_user_is_active !== undefined
        ? Boolean(row.linked_user_is_active)
        : null,
    linkedUserHasPropertyAccess:
      row.linked_user_has_property_access !== null &&
      row.linked_user_has_property_access !== undefined
        ? Boolean(row.linked_user_has_property_access)
        : null,
    employeeCode: String(row.employee_code),
    fullName: String(row.full_name),
    email: String(row.email ?? ''),
    phone: String(row.phone ?? ''),
    department: row.department as StaffDepartment,
    jobTitle: String(row.job_title),
    employmentStatus: row.employment_status as StaffEmploymentStatus,
    shiftType: row.shift_type as StaffShiftType,
    joinedOn: row.joined_on ? String(row.joined_on).slice(0, 10) : null,
    emergencyContact: String(row.emergency_contact ?? ''),
    notes: String(row.notes ?? ''),
    deactivatedAt: row.deactivated_at
      ? new Date(row.deactivated_at).toISOString()
      : null,
    assignedOpenRequestsCount: Number(row.assigned_open_requests_count ?? 0),
    completedRequestsCount: Number(row.completed_requests_count ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function validateLinkedPropertyUser(
  db: Queryable,
  propertyId: string,
  userId: string | null | undefined,
  options: { requireActiveUser?: boolean; excludeStaffId?: string } = {}
): Promise<void> {
  if (!userId) return;

  const requireActive = options.requireActiveUser !== false;

  const res = await db.query<{
    id: string;
    role: string;
    is_active: boolean;
    has_property_access: boolean;
  }>(
    `SELECT u.id,
            u.role,
            u.is_active,
            (
              u.role = 'admin'
              OR EXISTS (
                SELECT 1
                FROM user_property_access upa
                WHERE upa.user_id = u.id AND upa.property_id = $2
              )
            ) AS has_property_access
     FROM users u
     WHERE u.id = $1
     LIMIT 1`,
    [userId, propertyId]
  );

  if (res.rowCount === 0) {
    throw AppError.badRequest('Selected user account does not exist.');
  }

  const userRow = res.rows[0];
  if (requireActive && !userRow.is_active) {
    throw AppError.badRequest(
      'Cannot link a disabled user login account. Activate the user account first.'
    );
  }

  if (!userRow.has_property_access) {
    throw AppError.badRequest(
      'Selected user account does not have access to this property. Grant property access first before linking their staff profile.'
    );
  }

  // Ensure 1:1 link within the property before INSERT/UPDATE
  const dupParams: unknown[] = [propertyId, userId];
  let dupSql = `
    SELECT id, full_name, employee_code
    FROM property_staff_profiles
    WHERE property_id = $1 AND user_id = $2
  `;
  if (options.excludeStaffId) {
    dupParams.push(options.excludeStaffId);
    dupSql += ` AND id <> $3`;
  }
  dupSql += ' LIMIT 1';

  const dupRes = await db.query<{
    id: string;
    full_name: string;
    employee_code: string;
  }>(dupSql, dupParams);

  if ((dupRes.rowCount ?? 0) > 0) {
    const existingLink = dupRes.rows[0];
    throw AppError.conflict(
      `Selected system user account is already linked to staff profile "${existingLink.full_name}" (${existingLink.employee_code}) in this property.`
    );
  }
}

export interface ListStaffProfilesFilter {
  department?: string;
  employmentStatus?: string;
  shiftType?: string;
  includeInactive?: boolean;
  search?: string;
}

export async function listStaffProfiles(
  propertyId: string,
  filter: ListStaffProfilesFilter = {}
): Promise<StaffListResponse> {
  const pool = getPool();
  const params: unknown[] = [propertyId];
  const conditions: string[] = ['sp.property_id = $1'];

  if (filter.employmentStatus) {
    const normalizedStatus =
      filter.employmentStatus === 'deactivated'
        ? 'inactive'
        : filter.employmentStatus;
    if (
      !(STAFF_EMPLOYMENT_STATUSES as readonly string[]).includes(
        normalizedStatus
      )
    ) {
      throw AppError.badRequest(
        `Invalid employment status filter: "${filter.employmentStatus}"`
      );
    }
    params.push(normalizedStatus);
    conditions.push(`sp.employment_status = $${params.length}`);
  } else if (filter.includeInactive === false) {
    conditions.push(`sp.employment_status != 'inactive'`);
  }

  if (filter.department) {
    if (!(STAFF_DEPARTMENTS as readonly string[]).includes(filter.department)) {
      throw AppError.badRequest(
        `Invalid staff department filter: "${filter.department}"`
      );
    }
    params.push(filter.department);
    conditions.push(`sp.department = $${params.length}`);
  }

  if (filter.shiftType) {
    if (!(STAFF_SHIFT_TYPES as readonly string[]).includes(filter.shiftType)) {
      throw AppError.badRequest(`Invalid shift filter: "${filter.shiftType}"`);
    }
    params.push(filter.shiftType);
    conditions.push(`sp.shift_type = $${params.length}`);
  }

  if (filter.search && filter.search.trim().length > 0) {
    const q = `%${filter.search.trim()}%`;
    params.push(q);
    conditions.push(
      `(sp.full_name ILIKE $${params.length}
        OR sp.employee_code ILIKE $${params.length}
        OR sp.job_title ILIKE $${params.length}
        OR sp.email ILIKE $${params.length}
        OR sp.phone ILIKE $${params.length})`
    );
  }

  const listSql = `
    SELECT sp.*,
           u.email AS linked_user_email,
           u.role AS linked_user_role,
           u.is_active AS linked_user_is_active,
           CASE
             WHEN sp.user_id IS NULL OR u.id IS NULL THEN NULL
             WHEN u.role = 'admin' THEN TRUE
             ELSE EXISTS (
               SELECT 1
               FROM user_property_access upa
               WHERE upa.user_id = u.id AND upa.property_id = sp.property_id
             )
           END AS linked_user_has_property_access,
           COUNT(sr.id) FILTER (WHERE sr.status IN ('requested', 'in_progress'))::int AS assigned_open_requests_count,
           COUNT(sr.id) FILTER (WHERE sr.status = 'completed')::int AS completed_requests_count
    FROM property_staff_profiles sp
    LEFT JOIN users u ON u.id = sp.user_id
    LEFT JOIN service_requests sr
      ON sr.assigned_staff_id = sp.id AND sr.property_id = sp.property_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY sp.id, u.id, u.email, u.role, u.is_active
    ORDER BY
      CASE sp.employment_status
        WHEN 'active' THEN 0
        WHEN 'on_leave' THEN 1
        ELSE 2
      END ASC,
      sp.department ASC,
      sp.full_name ASC
    LIMIT 300
  `;

  // linkedUsersCount strictly counts real, active, property-authorized linked logins
  // on non-deactivated staff profiles in the selected property (never counting users
  // merely because they hold property access without a linked staff profile).
  const summarySql = `
    SELECT
      COUNT(*)::int AS total_staff_count,
      COUNT(*) FILTER (WHERE sp.employment_status = 'active')::int AS active_count,
      COUNT(*) FILTER (WHERE sp.employment_status = 'on_leave')::int AS on_leave_count,
      COUNT(*) FILTER (WHERE sp.employment_status = 'inactive')::int AS inactive_count,
      COUNT(DISTINCT sp.user_id) FILTER (
        WHERE sp.user_id IS NOT NULL
          AND sp.employment_status != 'inactive'
          AND u.id IS NOT NULL
          AND u.is_active = TRUE
          AND (
            u.role = 'admin'
            OR EXISTS (
              SELECT 1
              FROM user_property_access upa
              WHERE upa.user_id = u.id AND upa.property_id = sp.property_id
            )
          )
      )::int AS linked_users_count
    FROM property_staff_profiles sp
    LEFT JOIN users u ON u.id = sp.user_id
    WHERE sp.property_id = $1
  `;

  const deptSql = `
    SELECT
      department,
      COUNT(*) FILTER (WHERE employment_status = 'active')::int AS active_count,
      COUNT(*)::int AS total_count
    FROM property_staff_profiles
    WHERE property_id = $1
    GROUP BY department
    ORDER BY department ASC
  `;

  const [listRes, summaryRes, deptRes] = await Promise.all([
    pool.query(listSql, params),
    pool.query(summarySql, [propertyId]),
    pool.query(deptSql, [propertyId]),
  ]);

  const sumRow = summaryRes.rows[0] ?? {};

  return {
    items: listRes.rows.map(mapStaffProfileRow),
    summary: {
      totalStaffCount: Number(sumRow.total_staff_count ?? 0),
      activeCount: Number(sumRow.active_count ?? 0),
      onLeaveCount: Number(sumRow.on_leave_count ?? 0),
      inactiveCount: Number(sumRow.inactive_count ?? 0),
      linkedUsersCount: Number(sumRow.linked_users_count ?? 0),
      byDepartment: deptRes.rows.map((r) => ({
        department: r.department as StaffDepartment,
        activeCount: Number(r.active_count ?? 0),
        totalCount: Number(r.total_count ?? 0),
      })),
    },
  };
}

export async function getStaffProfileDetail(
  propertyId: string,
  staffId: string
): Promise<StaffProfileDetail> {
  const pool = getPool();

  const [staffRes, reqsRes] = await Promise.all([
    pool.query(
      `SELECT sp.*,
              u.email AS linked_user_email,
              u.role AS linked_user_role,
              u.is_active AS linked_user_is_active,
              CASE
                WHEN sp.user_id IS NULL OR u.id IS NULL THEN NULL
                WHEN u.role = 'admin' THEN TRUE
                ELSE EXISTS (
                  SELECT 1
                  FROM user_property_access upa
                  WHERE upa.user_id = u.id AND upa.property_id = sp.property_id
                )
              END AS linked_user_has_property_access,
              COUNT(sr.id) FILTER (WHERE sr.status IN ('requested', 'in_progress'))::int AS assigned_open_requests_count,
              COUNT(sr.id) FILTER (WHERE sr.status = 'completed')::int AS completed_requests_count
       FROM property_staff_profiles sp
       LEFT JOIN users u ON u.id = sp.user_id
       LEFT JOIN service_requests sr
         ON sr.assigned_staff_id = sp.id AND sr.property_id = sp.property_id
       WHERE sp.property_id = $1 AND sp.id = $2
       GROUP BY sp.id, u.id, u.email, u.role, u.is_active`,
      [propertyId, staffId]
    ),
    pool.query(
      `SELECT sr.*,
              sc.is_active AS service_is_active,
              r.booking_reference,
              r.status AS reservation_status,
              g.first_name AS guest_first_name,
              g.last_name AS guest_last_name,
              g.phone AS guest_phone,
              rm.room_number,
              inv.invoice_number AS posted_invoice_number,
              inv.status AS posted_invoice_status
       FROM service_requests sr
       JOIN service_catalog sc
         ON sc.id = sr.service_id AND sc.property_id = sr.property_id
       LEFT JOIN reservations r
         ON r.id = sr.reservation_id AND r.property_id = sr.property_id
       LEFT JOIN guests g
         ON g.id = sr.guest_id AND g.property_id = sr.property_id
       LEFT JOIN rooms rm
         ON rm.id = sr.room_id AND rm.property_id = sr.property_id
       LEFT JOIN invoices inv
         ON inv.id = sr.posted_invoice_id AND inv.property_id = sr.property_id
       WHERE sr.property_id = $1 AND sr.assigned_staff_id = $2
       ORDER BY sr.requested_for DESC
       LIMIT 25`,
      [propertyId, staffId]
    ),
  ]);

  if (staffRes.rowCount === 0) {
    throw AppError.notFound('Staff profile not found in this property');
  }

  const profile = mapStaffProfileRow(staffRes.rows[0]);
  const recentServiceRequests: ServiceRequestRecord[] = reqsRes.rows.map((row) => {
    const guestFull = [row.guest_first_name, row.guest_last_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      id: String(row.id),
      propertyId: String(row.property_id),
      requestNumber: String(row.request_number),
      serviceId: String(row.service_id),
      serviceCodeSnapshot: String(row.service_code_snapshot),
      serviceNameSnapshot: String(row.service_name_snapshot),
      categorySnapshot: row.category_snapshot as ServiceCategory,
      pricingUnitSnapshot: (row.pricing_unit_snapshot ??
        'per_request') as ServicePricingUnit,
      serviceIsActive: Boolean(row.service_is_active ?? true),
      reservationId: row.reservation_id ? String(row.reservation_id) : null,
      bookingReference: row.booking_reference
        ? String(row.booking_reference)
        : null,
      reservationStatus: row.reservation_status ?? null,
      guestId: row.guest_id ? String(row.guest_id) : null,
      guestName: guestFull || null,
      guestPhone: row.guest_phone ? String(row.guest_phone) : null,
      roomId: row.room_id ? String(row.room_id) : null,
      roomNumber: row.room_number ? String(row.room_number) : null,
      assignedStaffId: profile.id,
      assignedStaffName: profile.fullName,
      assignedStaffDepartment: profile.department,
      assignedStaffEmploymentStatus: profile.employmentStatus,
      quantity: Number(row.quantity),
      unitPrice: Number(row.unit_price),
      subtotal: Number(row.subtotal),
      taxName: String(row.tax_name ?? 'GST'),
      taxRate: Number(row.tax_rate ?? 0),
      taxAmount: Number(row.tax_amount ?? 0),
      totalAmount: Number(row.total_amount ?? 0),
      currency: String(row.currency ?? 'INR').trim(),
      status: row.status as ServiceRequestStatus,
      requestedFor: new Date(row.requested_for).toISOString(),
      notes: String(row.notes ?? ''),
      billingStatus: row.billing_status as ServiceBillingStatus,
      postedInvoiceId: row.posted_invoice_id ? String(row.posted_invoice_id) : null,
      postedInvoiceNumber: row.posted_invoice_number
        ? String(row.posted_invoice_number)
        : null,
      postedInvoiceStatus: row.posted_invoice_status ?? null,
      postedLineItemId: row.posted_line_item_id
        ? String(row.posted_line_item_id)
        : null,
      postedServiceChargeId: row.posted_service_charge_id
        ? String(row.posted_service_charge_id)
        : null,
      postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
      postedByName: null,
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      startedByName: null,
      completedAt: row.completed_at
        ? new Date(row.completed_at).toISOString()
        : null,
      completedByName: null,
      cancelledAt: row.cancelled_at
        ? new Date(row.cancelled_at).toISOString()
        : null,
      cancelledByName: null,
      cancelReason: String(row.cancel_reason ?? ''),
      createdByName: null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });

  return {
    ...profile,
    recentServiceRequests,
  };
}

export async function createStaffProfile(
  property: Property,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<StaffProfileDetail> {
  const input = staffProfileCreateSchema.parse(rawInput);

  const staffId = await withTransaction(async (client) => {
    await validateLinkedPropertyUser(client, property.id, input.userId, {
      requireActiveUser: true,
    });

    const isInactive = input.employmentStatus === 'inactive';

    const ins = await client.query<{ id: string }>(
      `INSERT INTO property_staff_profiles (
         property_id, user_id, employee_code, full_name, email, phone,
         department, job_title, employment_status, shift_type,
         joined_on, emergency_contact, notes,
         deactivated_at, deactivated_by, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16, $16
       ) RETURNING id`,
      [
        property.id,
        input.userId ?? null,
        input.employeeCode,
        input.fullName,
        input.email,
        input.phone,
        input.department,
        input.jobTitle,
        input.employmentStatus,
        input.shiftType,
        input.joinedOn ?? null,
        input.emergencyContact,
        input.notes,
        isInactive ? new Date().toISOString() : null,
        isInactive ? actorUser.id : null,
        actorUser.id,
      ]
    );
    const id = ins.rows[0].id;

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'staff_profile',
        entityId: id,
        action: 'created',
        summary: `Created staff profile "${input.fullName}" (${input.employeeCode}) — ${input.jobTitle}`,
        payload: {
          employeeCode: input.employeeCode,
          department: input.department,
          jobTitle: input.jobTitle,
          employmentStatus: input.employmentStatus,
          linkedUserId: input.userId ?? null,
        },
      },
      client
    );

    return id;
  });

  return getStaffProfileDetail(property.id, staffId);
}

export async function updateStaffProfile(
  property: Property,
  staffId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<StaffProfileDetail> {
  const input = staffProfileUpdateSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      'SELECT * FROM property_staff_profiles WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [staffId, property.id]
    );
    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Staff profile not found in this property');
    }
    const existing = existingRes.rows[0];

    const existingUserId = existing.user_id ? String(existing.user_id) : null;
    const nextUserId =
      input.userId !== undefined ? input.userId : existingUserId;
    const userIdChanged = nextUserId !== existingUserId;

    await validateLinkedPropertyUser(client, property.id, nextUserId, {
      requireActiveUser: userIdChanged,
      excludeStaffId: staffId,
    });

    const nextCode = input.employeeCode ?? String(existing.employee_code);
    const nextName = input.fullName ?? String(existing.full_name);
    const nextEmail = input.email !== undefined ? input.email : String(existing.email ?? '');
    const nextPhone = input.phone !== undefined ? input.phone : String(existing.phone ?? '');
    const nextDept = input.department ?? String(existing.department);
    const nextTitle = input.jobTitle ?? String(existing.job_title);
    const nextStatus =
      input.employmentStatus ?? (existing.employment_status as StaffEmploymentStatus);
    const nextShift = input.shiftType ?? String(existing.shift_type);
    const nextJoinedOn =
      input.joinedOn !== undefined
        ? input.joinedOn
        : existing.joined_on
          ? String(existing.joined_on).slice(0, 10)
          : null;
    const nextEmergency =
      input.emergencyContact !== undefined
        ? input.emergencyContact
        : String(existing.emergency_contact ?? '');
    const nextNotes =
      input.notes !== undefined ? input.notes : String(existing.notes ?? '');

    const prevStatus = existing.employment_status as StaffEmploymentStatus;
    let nextDeactivatedAt = existing.deactivated_at;
    let nextDeactivatedBy = existing.deactivated_by;

    if (nextStatus === 'inactive' && prevStatus !== 'inactive') {
      nextDeactivatedAt = new Date().toISOString();
      nextDeactivatedBy = actorUser.id;
    } else if (nextStatus !== 'inactive') {
      nextDeactivatedAt = null;
      nextDeactivatedBy = null;
    }

    await client.query(
      `UPDATE property_staff_profiles
       SET user_id = $1,
           employee_code = $2,
           full_name = $3,
           email = $4,
           phone = $5,
           department = $6,
           job_title = $7,
           employment_status = $8,
           shift_type = $9,
           joined_on = $10,
           emergency_contact = $11,
           notes = $12,
           deactivated_at = $13,
           deactivated_by = $14,
           updated_by = $15,
           updated_at = NOW()
       WHERE id = $16 AND property_id = $17`,
      [
        nextUserId,
        nextCode,
        nextName,
        nextEmail,
        nextPhone,
        nextDept,
        nextTitle,
        nextStatus,
        nextShift,
        nextJoinedOn,
        nextEmergency,
        nextNotes,
        nextDeactivatedAt,
        nextDeactivatedBy,
        actorUser.id,
        staffId,
        property.id,
      ]
    );

    const action =
      nextStatus !== prevStatus
        ? nextStatus === 'inactive'
          ? 'deactivated'
          : 'status_updated'
        : userIdChanged
          ? nextUserId
            ? 'user_linked'
            : 'user_unlinked'
          : 'updated';

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'staff_profile',
        entityId: staffId,
        action,
        summary:
          action === 'deactivated'
            ? `Deactivated staff profile "${nextName}" (${nextCode})`
            : action === 'user_linked'
              ? `Linked system user account to staff profile "${nextName}" (${nextCode})`
              : action === 'user_unlinked'
                ? `Unlinked system user account from staff profile "${nextName}" (${nextCode})`
                : `Updated staff profile "${nextName}" (${nextCode})`,
        payload: {
          previousStatus: prevStatus,
          employmentStatus: nextStatus,
          department: nextDept,
          jobTitle: nextTitle,
          previousUserId: existingUserId,
          linkedUserId: nextUserId,
        },
      },
      client
    );
  });

  return getStaffProfileDetail(property.id, staffId);
}
