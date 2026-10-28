import { Router } from 'express';
import { createPropertySchema, propertySettingsSchema } from '../../../shared/schemas.js';
import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { requireAuth, requirePropertyContext, requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import { mapPropertyRow, mapStaffOptionRow, mapUserRow } from '../../services/mappers.js';

export async function validatePropertyStaffAssignee(
  db: Queryable,
  propertyId: string,
  assignedTo: string | null | undefined
): Promise<void> {
  if (!assignedTo) return;
  const staffRes = await db.query(
    `SELECT u.id
     FROM users u
     WHERE u.id = $1
       AND u.is_active = TRUE
       AND (
         u.role = 'admin'
         OR EXISTS (
           SELECT 1 FROM user_property_access upa
           WHERE upa.user_id = u.id AND upa.property_id = $2
         )
       )
     LIMIT 1`,
    [assignedTo, propertyId]
  );
  if (staffRes.rowCount === 0) {
    throw AppError.badRequest(
      'Selected staff assignee does not exist, is inactive, or does not have access to this property.'
    );
  }
}

export const propertiesRouter = Router();

propertiesRouter.use(requireAuth);

propertiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const pool = getPool();
    const query =
      user.role === 'admin'
        ? `SELECT * FROM properties WHERE is_active = TRUE ORDER BY created_at ASC`
        : `SELECT p.* FROM properties p
           JOIN user_property_access upa ON upa.property_id = p.id
           WHERE upa.user_id = $1 AND p.is_active = TRUE
           ORDER BY upa.is_default DESC, p.created_at ASC`;
    const params = user.role === 'admin' ? [] : [user.id];
    const result = await pool.query(query, params);
    res.json({ items: result.rows.map(mapPropertyRow) });
  })
);

propertiesRouter.get(
  '/current',
  requirePropertyContext,
  asyncHandler(async (req, res) => {
    res.json({ property: req.property! });
  })
);

propertiesRouter.put(
  '/current',
  requireRole('admin'),
  requirePropertyContext,
  asyncHandler(async (req, res) => {
    const input = propertySettingsSchema.parse(req.body);
    const property = req.property!;

    const updated = await withTransaction(async (client) => {
      const nextInvoice = input.invoiceSettings
        ? {
            prefix: input.invoiceSettings.prefix,
            next_number: input.invoiceSettings.nextNumber,
            tax_id: input.invoiceSettings.taxId,
            footer_note: input.invoiceSettings.footerNote,
          }
        : {
            prefix: property.invoiceSettings.prefix,
            next_number: property.invoiceSettings.nextNumber,
            tax_id: property.invoiceSettings.taxId,
            footer_note: property.invoiceSettings.footerNote,
          };

      const resDb = await client.query(
        `UPDATE properties
         SET name = $1,
             email = $2,
             phone = $3,
             website = $4,
             address_line1 = $5,
             address_line2 = $6,
             city = $7,
             state_region = $8,
             postal_code = $9,
             country = $10,
             timezone = $11,
             currency = $12,
             default_tax_rate = $13,
             tax_name = $14,
             standard_check_in_time = $15,
             standard_check_out_time = $16,
             cancellation_policy = $17,
             booking_terms = $18,
             invoice_settings = $19::jsonb,
             updated_at = NOW()
         WHERE id = $20
         RETURNING *`,
        [
          input.name,
          input.email,
          input.phone,
          input.website ?? '',
          input.addressLine1,
          input.addressLine2 ?? '',
          input.city,
          input.stateRegion ?? '',
          input.postalCode ?? '',
          input.country,
          input.timezone,
          input.currency,
          input.defaultTaxRate,
          input.taxName,
          input.standardCheckInTime,
          input.standardCheckOutTime,
          input.cancellationPolicy ?? '',
          input.bookingTerms ?? '',
          JSON.stringify(nextInvoice),
          property.id,
        ]
      );

      if (resDb.rowCount === 0) {
        throw AppError.notFound('Property not found');
      }

      const mapped = mapPropertyRow(resDb.rows[0]);
      await recordAuditEvent(
        {
          propertyId: property.id,
          actorUserId: req.user!.id,
          entityType: 'property',
          entityId: property.id,
          action: 'updated_settings',
          summary: `Updated settings for ${mapped.name}`,
          payload: { timezone: mapped.timezone, currency: mapped.currency, defaultTaxRate: mapped.defaultTaxRate },
        },
        client
      );
      return mapped;
    });

    res.json({ property: updated });
  })
);

propertiesRouter.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const input = createPropertySchema.parse(req.body);
    const created = await withTransaction(async (client) => {
      const invoiceJson = input.invoiceSettings
        ? {
            prefix: input.invoiceSettings.prefix,
            next_number: input.invoiceSettings.nextNumber,
            tax_id: input.invoiceSettings.taxId,
            footer_note: input.invoiceSettings.footerNote,
          }
        : {
            prefix: 'INV',
            next_number: 1001,
            tax_id: '',
            footer_note: 'Thank you for staying with us.',
          };

      const insertRes = await client.query(
        `INSERT INTO properties (
           code, name, email, phone, website, address_line1, address_line2,
           city, state_region, postal_code, country, timezone, currency,
           default_tax_rate, tax_name, standard_check_in_time, standard_check_out_time,
           cancellation_policy, booking_terms, invoice_settings
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb
         ) RETURNING *`,
        [
          input.code,
          input.name,
          input.email,
          input.phone,
          input.website ?? '',
          input.addressLine1,
          input.addressLine2 ?? '',
          input.city,
          input.stateRegion ?? '',
          input.postalCode ?? '',
          input.country,
          input.timezone,
          input.currency,
          input.defaultTaxRate,
          input.taxName,
          input.standardCheckInTime,
          input.standardCheckOutTime,
          input.cancellationPolicy ?? '',
          input.bookingTerms ?? '',
          JSON.stringify(invoiceJson),
        ]
      );

      const prop = mapPropertyRow(insertRes.rows[0]);
      await client.query(
        `INSERT INTO user_property_access (user_id, property_id, is_default)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (user_id, property_id) DO NOTHING`,
        [req.user!.id, prop.id]
      );

      await recordAuditEvent(
        {
          propertyId: prop.id,
          actorUserId: req.user!.id,
          entityType: 'property',
          entityId: prop.id,
          action: 'created_property',
          summary: `Created property ${prop.name} (${prop.code})`,
        },
        client
      );
      return prop;
    });

    res.status(201).json({ property: created });
  })
);

propertiesRouter.get(
  '/staff',
  requirePropertyContext,
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const staffRes = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.role
       FROM users u
       WHERE u.is_active = TRUE
         AND (
           u.role = 'admin'
           OR EXISTS (
             SELECT 1 FROM user_property_access upa
             WHERE upa.user_id = u.id AND upa.property_id = $1
           )
         )
       ORDER BY u.role ASC, u.full_name ASC`,
      [req.property!.id]
    );
    res.json({ items: staffRes.rows.map(mapStaffOptionRow) });
  })
);

propertiesRouter.get(
  '/users',
  requireRole('admin'),
  requirePropertyContext,
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const usersRes = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.phone, u.is_active, u.last_login_at, u.created_at
       FROM users u
       ORDER BY u.role ASC, u.full_name ASC`
    );
    res.json({ items: usersRes.rows.map(mapUserRow) });
  })
);
