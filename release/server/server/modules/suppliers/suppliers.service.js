import { supplierCreateSchema, supplierUpdateSchema, } from '../../../shared/schemas.js';
import { roundCurrency } from '../../../shared/pricing.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';
function mapSupplierRow(row) {
    return {
        id: row.id,
        propertyId: row.property_id,
        code: row.code ?? null,
        name: row.name,
        contactPerson: row.contact_person ?? '',
        email: row.email ?? '',
        phone: row.phone ?? '',
        address: row.address ?? '',
        taxIdentifier: row.tax_identifier ?? '',
        paymentTerms: row.payment_terms ?? '',
        notes: row.notes ?? '',
        isActive: Boolean(row.is_active),
        linkedItemCount: Number(row.linked_item_count ?? 0),
        activeItemCount: Number(row.active_item_count ?? 0),
        receiptCount: Number(row.receipt_count ?? 0),
        totalPurchasedAmount: roundCurrency(Number(row.total_purchased_amount ?? 0)),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
const SUPPLIER_SELECT_BASE = `
  SELECT s.*,
         COALESCE(ip_stats.linked_item_count, 0)::int AS linked_item_count,
         COALESCE(ip_stats.active_item_count, 0)::int AS active_item_count,
         COALESCE(rc_stats.receipt_count, 0)::int AS receipt_count,
         COALESCE(rc_stats.total_purchased_amount, 0) AS total_purchased_amount
  FROM suppliers s
  LEFT JOIN (
    SELECT supplier_id,
           COUNT(*)::int AS linked_item_count,
           COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active_item_count
    FROM inventory_products
    WHERE property_id = $1 AND supplier_id IS NOT NULL
    GROUP BY supplier_id
  ) ip_stats ON ip_stats.supplier_id = s.id
  LEFT JOIN (
    SELECT supplier_id,
           COUNT(*)::int AS receipt_count,
           COALESCE(SUM(total_amount), 0) AS total_purchased_amount
    FROM inventory_receipts
    WHERE property_id = $1 AND supplier_id IS NOT NULL
    GROUP BY supplier_id
  ) rc_stats ON rc_stats.supplier_id = s.id
`;
export async function listSuppliers(propertyId, filter = {}) {
    const pool = getPool();
    const params = [propertyId];
    const conditions = ['s.property_id = $1'];
    if (!filter.includeInactive) {
        conditions.push('s.is_active = TRUE');
    }
    if (filter.search && filter.search.trim().length > 0) {
        params.push(`%${filter.search.trim()}%`);
        const idx = params.length;
        conditions.push(`(s.name ILIKE $${idx} OR COALESCE(s.code, '') ILIKE $${idx} OR s.contact_person ILIKE $${idx} OR s.email ILIKE $${idx} OR s.phone ILIKE $${idx})`);
    }
    const res = await pool.query(`${SUPPLIER_SELECT_BASE}
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.is_active DESC, s.name ASC`, params);
    return res.rows.map(mapSupplierRow);
}
export async function getSupplierById(propertyId, supplierId, db = getPool()) {
    const res = await db.query(`${SUPPLIER_SELECT_BASE}
     WHERE s.property_id = $1 AND s.id = $2
     LIMIT 1`, [propertyId, supplierId]);
    if (res.rowCount === 0) {
        throw AppError.notFound('Supplier not found');
    }
    return mapSupplierRow(res.rows[0]);
}
export async function createSupplier(property, actorUser, rawInput) {
    if (actorUser.role !== 'admin') {
        throw AppError.forbidden('Administrator role is required to create suppliers.');
    }
    const input = supplierCreateSchema.parse(rawInput);
    const supplierId = await withTransaction(async (client) => {
        const ins = await client.query(`INSERT INTO suppliers (
         property_id, code, name, contact_person, email, phone,
         address, tax_identifier, payment_terms, notes, is_active,
         created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       RETURNING id`, [
            property.id,
            input.code,
            input.name,
            input.contactPerson,
            input.email,
            input.phone,
            input.address,
            input.taxIdentifier,
            input.paymentTerms,
            input.notes,
            input.isActive,
            actorUser.id,
        ]);
        const id = ins.rows[0].id;
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'supplier',
            entityId: id,
            action: 'created',
            summary: `Created supplier "${input.name}"${input.code ? ` (${input.code})` : ''}`,
        }, client);
        return id;
    });
    return getSupplierById(property.id, supplierId);
}
export async function updateSupplier(property, supplierId, actorUser, rawInput) {
    if (actorUser.role !== 'admin') {
        throw AppError.forbidden('Administrator role is required to update suppliers.');
    }
    const input = supplierUpdateSchema.parse(rawInput);
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM suppliers WHERE id = $1 AND property_id = $2 FOR UPDATE', [supplierId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Supplier not found');
        }
        const existing = existingRes.rows[0];
        const nextCode = input.code !== undefined ? input.code : existing.code;
        const nextName = input.name ?? existing.name;
        const nextIsActive = input.isActive ?? existing.is_active;
        await client.query(`UPDATE suppliers
       SET code = $1,
           name = $2,
           contact_person = $3,
           email = $4,
           phone = $5,
           address = $6,
           tax_identifier = $7,
           payment_terms = $8,
           notes = $9,
           is_active = $10,
           updated_by = $11,
           updated_at = NOW()
       WHERE id = $12 AND property_id = $13`, [
            nextCode,
            nextName,
            input.contactPerson ?? existing.contact_person,
            input.email ?? existing.email,
            input.phone ?? existing.phone,
            input.address ?? existing.address,
            input.taxIdentifier ?? existing.tax_identifier,
            input.paymentTerms ?? existing.payment_terms,
            input.notes ?? existing.notes,
            nextIsActive,
            actorUser.id,
            supplierId,
            property.id,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'supplier',
            entityId: supplierId,
            action: 'updated',
            summary: `Updated supplier "${nextName}" (active: ${Boolean(nextIsActive)})`,
        }, client);
    });
    return getSupplierById(property.id, supplierId);
}
