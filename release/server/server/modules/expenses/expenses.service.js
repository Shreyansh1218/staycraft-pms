import crypto from 'node:crypto';
import { EXPENSE_PAYMENT_METHODS, EXPENSE_STATUSES, } from '../../../shared/constants.js';
import { getPropertyLocalDate, isValidIsoDate } from '../../../shared/dates.js';
import { roundCurrency } from '../../../shared/pricing.js';
import { expenseCategoryCreateSchema, expenseCategoryUpdateSchema, expenseCreateSchema, expenseUpdateSchema, expenseVoidSchema, } from '../../../shared/schemas.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError, formatZodError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';
function mapExpenseCategoryRow(row) {
    return {
        id: String(row.id),
        propertyId: String(row.property_id),
        code: String(row.code),
        name: String(row.name),
        description: String(row.description ?? ''),
        displayOrder: Number(row.display_order ?? 0),
        isActive: Boolean(row.is_active),
        recordedExpenseCount: Number(row.recorded_expense_count ?? 0),
        totalExpenseCount: Number(row.total_expense_count ?? 0),
        recordedTotalAmount: roundCurrency(Number(row.recorded_total_amount ?? 0)),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
function toIsoDateString(val) {
    if (typeof val === 'string')
        return val.slice(0, 10);
    if (val instanceof Date)
        return val.toISOString().slice(0, 10);
    return String(val ?? '').slice(0, 10);
}
function mapExpenseRow(row) {
    const categoryName = String(row.joined_category_name ?? '').trim() ||
        String(row.category_name_snapshot ?? '').trim() ||
        String(row.category ?? 'Uncategorized');
    const categoryCode = String(row.joined_category_code ?? '').trim() ||
        String(row.category ?? 'GENERAL');
    return {
        id: String(row.id),
        propertyId: String(row.property_id),
        expenseNumber: String(row.expense_number ?? `EXP-${String(row.id).slice(0, 8).toUpperCase()}`),
        categoryId: row.category_id ? String(row.category_id) : null,
        categoryCode,
        categoryName,
        categoryIsActive: row.joined_category_active === undefined || row.joined_category_active === null
            ? true
            : Boolean(row.joined_category_active),
        supplierId: row.supplier_id ? String(row.supplier_id) : null,
        supplierName: row.supplier_name ? String(row.supplier_name) : null,
        vendorName: String(row.vendor_name ?? ''),
        title: String(row.title ?? ''),
        description: String(row.description ?? ''),
        amount: roundCurrency(Number(row.amount ?? 0)),
        taxAmount: roundCurrency(Number(row.tax_amount ?? 0)),
        currency: String(row.currency ?? 'INR').trim(),
        expenseDate: toIsoDateString(row.expense_date),
        paymentMethod: String(row.payment_method ?? 'bank_transfer'),
        referenceNumber: String(row.reference_number ?? ''),
        notes: String(row.notes ?? ''),
        status: String(row.status ?? 'recorded'),
        recordedBy: row.recorded_by ? String(row.recorded_by) : null,
        recordedByName: row.recorded_by_name ? String(row.recorded_by_name) : null,
        voidedAt: row.voided_at ? new Date(row.voided_at).toISOString() : null,
        voidedBy: row.voided_by ? String(row.voided_by) : null,
        voidedByName: row.voided_by_name ? String(row.voided_by_name) : null,
        voidReason: String(row.void_reason ?? ''),
        updatedBy: row.updated_by ? String(row.updated_by) : null,
        updatedByName: row.updated_by_name ? String(row.updated_by_name) : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
function mapExpenseHistoryRow(row) {
    return {
        id: String(row.id),
        expenseId: String(row.expense_id),
        propertyId: String(row.property_id),
        action: String(row.action),
        reason: String(row.reason ?? ''),
        previousSnapshot: row.previous_snapshot && typeof row.previous_snapshot === 'object'
            ? row.previous_snapshot
            : null,
        newSnapshot: row.new_snapshot && typeof row.new_snapshot === 'object'
            ? row.new_snapshot
            : {},
        actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
        actorName: row.actor_name ? String(row.actor_name) : null,
        createdAt: new Date(row.created_at).toISOString(),
    };
}
function buildExpenseSnapshot(row) {
    return {
        expenseNumber: row.expense_number ?? null,
        categoryId: row.category_id ?? null,
        categoryNameSnapshot: row.category_name_snapshot ?? row.category ?? '',
        supplierId: row.supplier_id ?? null,
        vendorName: row.vendor_name ?? '',
        title: row.title ?? '',
        description: row.description ?? '',
        amount: roundCurrency(Number(row.amount ?? 0)),
        taxAmount: roundCurrency(Number(row.tax_amount ?? 0)),
        currency: String(row.currency ?? 'INR').trim(),
        expenseDate: toIsoDateString(row.expense_date),
        paymentMethod: row.payment_method ?? 'bank_transfer',
        referenceNumber: row.reference_number ?? '',
        notes: row.notes ?? '',
        status: row.status ?? 'recorded',
        voidReason: row.void_reason ?? '',
    };
}
const EXPENSE_SELECT = `
  SELECT e.*,
         ec.name AS joined_category_name,
         ec.code AS joined_category_code,
         ec.is_active AS joined_category_active,
         s.name AS supplier_name,
         u_rec.full_name AS recorded_by_name,
         u_void.full_name AS voided_by_name,
         u_upd.full_name AS updated_by_name
  FROM expenses e
  LEFT JOIN expense_categories ec
    ON ec.id = e.category_id AND ec.property_id = e.property_id
  LEFT JOIN suppliers s
    ON s.id = e.supplier_id AND s.property_id = e.property_id
  LEFT JOIN users u_rec
    ON u_rec.id = e.recorded_by
  LEFT JOIN users u_void
    ON u_void.id = e.voided_by
  LEFT JOIN users u_upd
    ON u_upd.id = e.updated_by
`;
async function queryExpenseById(db, propertyId, expenseId) {
    const res = await db.query(`${EXPENSE_SELECT}
     WHERE e.id = $1 AND e.property_id = $2
     LIMIT 1`, [expenseId, propertyId]);
    if (res.rowCount === 0) {
        throw AppError.notFound('Operating expense not found');
    }
    return mapExpenseRow(res.rows[0]);
}
async function allocateNextExpenseNumber(client, property) {
    await client.query(`INSERT INTO property_expense_counters (property_id, next_number)
     VALUES ($1, 1001)
     ON CONFLICT (property_id) DO NOTHING`, [property.id]);
    const counterRes = await client.query(`SELECT next_number
     FROM property_expense_counters
     WHERE property_id = $1
     FOR UPDATE`, [property.id]);
    let nextNum = Math.max(1, Number(counterRes.rows[0]?.next_number ?? 1001));
    const cleanCode = property.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PMS';
    let expenseNumber = '';
    for (let attempts = 0; attempts < 5000; attempts++) {
        const candidate = `${cleanCode}-EXP-${String(nextNum).padStart(4, '0')}`;
        const dupRes = await client.query('SELECT 1 FROM expenses WHERE property_id = $1 AND expense_number = $2 LIMIT 1', [property.id, candidate]);
        if (dupRes.rowCount === 0) {
            expenseNumber = candidate;
            break;
        }
        nextNum += 1;
    }
    if (!expenseNumber) {
        expenseNumber = `${cleanCode}-EXP-${Date.now()}`;
    }
    await client.query(`UPDATE property_expense_counters
     SET next_number = $2
     WHERE property_id = $1`, [property.id, nextNum + 1]);
    return expenseNumber;
}
function computeCreateExpenseFingerprint(data) {
    const canonical = JSON.stringify({
        categoryId: data.categoryId,
        supplierId: data.supplierId ?? null,
        vendorName: data.vendorName.trim(),
        title: data.title.trim(),
        description: data.description.trim(),
        amount: roundCurrency(data.amount).toFixed(2),
        taxAmount: roundCurrency(data.taxAmount).toFixed(2),
        expenseDate: data.expenseDate,
        paymentMethod: data.paymentMethod,
        referenceNumber: data.referenceNumber.trim(),
        notes: data.notes.trim(),
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}
// ============================================================================
// 1. EXPENSE CATEGORIES
// ============================================================================
export async function listExpenseCategories(propertyId, includeInactive = false) {
    const pool = getPool();
    const res = await pool.query(`SELECT c.*,
            COUNT(e.id) FILTER (WHERE e.status = 'recorded')::int AS recorded_expense_count,
            COUNT(e.id)::int AS total_expense_count,
            COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'recorded'), 0) AS recorded_total_amount
     FROM expense_categories c
     LEFT JOIN expenses e
       ON e.category_id = c.id AND e.property_id = c.property_id
     WHERE c.property_id = $1
       AND ($2::boolean = TRUE OR c.is_active = TRUE)
     GROUP BY c.id
     ORDER BY c.display_order ASC, c.name ASC`, [propertyId, includeInactive]);
    return res.rows.map(mapExpenseCategoryRow);
}
export async function createExpenseCategory(property, actor, rawPayload) {
    const parsed = expenseCategoryCreateSchema.safeParse(rawPayload);
    if (!parsed.success) {
        const formatted = formatZodError(parsed.error);
        throw AppError.badRequest(formatted.message, formatted.fieldErrors);
    }
    const data = parsed.data;
    return withTransaction(async (client) => {
        const ins = await client.query(`INSERT INTO expense_categories (
         property_id, code, name, description, display_order, is_active, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`, [
            property.id,
            data.code,
            data.name,
            data.description,
            data.displayOrder,
            data.isActive,
            actor.id,
        ]);
        const createdRow = ins.rows[0];
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actor.id,
            entityType: 'expense_category',
            entityId: createdRow.id,
            action: 'created',
            summary: `Created expense category "${data.name}" (${data.code})`,
            payload: { code: data.code, name: data.name, isActive: data.isActive },
        }, client);
        return mapExpenseCategoryRow({
            ...createdRow,
            recorded_expense_count: 0,
            total_expense_count: 0,
            recorded_total_amount: 0,
        });
    });
}
export async function updateExpenseCategory(property, categoryId, actor, rawPayload) {
    const parsed = expenseCategoryUpdateSchema.safeParse(rawPayload);
    if (!parsed.success) {
        const formatted = formatZodError(parsed.error);
        throw AppError.badRequest(formatted.message, formatted.fieldErrors);
    }
    const data = parsed.data;
    return withTransaction(async (client) => {
        const existingRes = await client.query(`SELECT * FROM expense_categories
       WHERE id = $1 AND property_id = $2
       FOR UPDATE`, [categoryId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Expense category not found');
        }
        const existing = existingRes.rows[0];
        const nextCode = data.code ?? String(existing.code);
        const nextName = data.name ?? String(existing.name);
        const nextDescription = data.description !== undefined ? data.description : String(existing.description ?? '');
        const nextDisplayOrder = data.displayOrder !== undefined ? data.displayOrder : Number(existing.display_order ?? 0);
        const nextIsActive = data.isActive !== undefined ? data.isActive : Boolean(existing.is_active);
        const upd = await client.query(`UPDATE expense_categories
       SET code = $1,
           name = $2,
           description = $3,
           display_order = $4,
           is_active = $5,
           updated_by = $6,
           updated_at = NOW()
       WHERE id = $7 AND property_id = $8
       RETURNING *`, [
            nextCode,
            nextName,
            nextDescription,
            nextDisplayOrder,
            nextIsActive,
            actor.id,
            categoryId,
            property.id,
        ]);
        // Keep category_name_snapshot in sync on non-voided or historical awareness?
        // Note: Historical expenses retain their original category_name_snapshot AND relational
        // category_id link so neither deactivation nor category rename breaks historical records.
        const statsRes = await client.query(`SELECT
         COUNT(*) FILTER (WHERE status = 'recorded')::int AS recorded_expense_count,
         COUNT(*)::int AS total_expense_count,
         COALESCE(SUM(amount) FILTER (WHERE status = 'recorded'), 0) AS recorded_total_amount
       FROM expenses
       WHERE property_id = $1 AND category_id = $2`, [property.id, categoryId]);
        const stats = statsRes.rows[0] ?? {};
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actor.id,
            entityType: 'expense_category',
            entityId: categoryId,
            action: nextIsActive !== Boolean(existing.is_active)
                ? nextIsActive
                    ? 'activated'
                    : 'deactivated'
                : 'updated',
            summary: `Updated expense category "${nextName}" (${nextCode})`,
            payload: {
                previous: {
                    code: existing.code,
                    name: existing.name,
                    isActive: existing.is_active,
                },
                updated: {
                    code: nextCode,
                    name: nextName,
                    isActive: nextIsActive,
                },
            },
        }, client);
        return mapExpenseCategoryRow({
            ...upd.rows[0],
            recorded_expense_count: stats.recorded_expense_count ?? 0,
            total_expense_count: stats.total_expense_count ?? 0,
            recorded_total_amount: stats.recorded_total_amount ?? 0,
        });
    });
}
export async function deleteExpenseCategory(property, categoryId, actor) {
    await withTransaction(async (client) => {
        const existingRes = await client.query(`SELECT * FROM expense_categories
       WHERE id = $1 AND property_id = $2
       FOR UPDATE`, [categoryId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Expense category not found');
        }
        const existing = existingRes.rows[0];
        const linkedRes = await client.query(`SELECT COUNT(*)::int AS cnt
       FROM expenses
       WHERE property_id = $1 AND category_id = $2`, [property.id, categoryId]);
        const linkedCount = Number(linkedRes.rows[0]?.cnt ?? 0);
        if (linkedCount > 0) {
            throw AppError.conflict(`Cannot delete expense category "${existing.name}" because ${linkedCount} historical expense record${linkedCount === 1 ? '' : 's'} reference it. Deactivate this category instead to preserve expense history.`);
        }
        await client.query(`DELETE FROM expense_categories WHERE id = $1 AND property_id = $2`, [categoryId, property.id]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actor.id,
            entityType: 'expense_category',
            entityId: categoryId,
            action: 'deleted',
            summary: `Deleted unused expense category "${existing.name}" (${existing.code})`,
            payload: { code: existing.code, name: existing.name },
        }, client);
    });
}
export async function listExpenses(property, filters = {}) {
    const pool = getPool();
    const params = [property.id];
    const baseConditions = ['e.property_id = $1'];
    if (filters.dateFrom) {
        if (!isValidIsoDate(filters.dateFrom)) {
            throw AppError.badRequest('Invalid dateFrom parameter (expected YYYY-MM-DD)');
        }
        params.push(filters.dateFrom);
        baseConditions.push(`e.expense_date >= $${params.length}::date`);
    }
    if (filters.dateTo) {
        if (!isValidIsoDate(filters.dateTo)) {
            throw AppError.badRequest('Invalid dateTo parameter (expected YYYY-MM-DD)');
        }
        params.push(filters.dateTo);
        baseConditions.push(`e.expense_date <= $${params.length}::date`);
    }
    if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
        throw AppError.badRequest('dateFrom cannot be after dateTo');
    }
    if (filters.categoryId) {
        params.push(filters.categoryId);
        baseConditions.push(`e.category_id = $${params.length}`);
    }
    if (filters.supplierId) {
        if (filters.supplierId === 'none') {
            baseConditions.push(`e.supplier_id IS NULL`);
        }
        else {
            params.push(filters.supplierId);
            baseConditions.push(`e.supplier_id = $${params.length}`);
        }
    }
    if (filters.paymentMethod) {
        if (!EXPENSE_PAYMENT_METHODS.includes(filters.paymentMethod)) {
            throw AppError.badRequest(`Invalid paymentMethod filter: "${filters.paymentMethod}"`);
        }
        params.push(filters.paymentMethod);
        baseConditions.push(`e.payment_method = $${params.length}`);
    }
    if (filters.search && filters.search.trim().length > 0) {
        params.push(`%${filters.search.trim()}%`);
        const idx = params.length;
        baseConditions.push(`(COALESCE(e.expense_number, '') ILIKE $${idx}
        OR e.title ILIKE $${idx}
        OR e.description ILIKE $${idx}
        OR e.vendor_name ILIKE $${idx}
        OR e.reference_number ILIKE $${idx}
        OR COALESCE(s.name, '') ILIKE $${idx}
        OR COALESCE(ec.name, e.category_name_snapshot, e.category) ILIKE $${idx})`);
    }
    // Summary metrics always compute recorded vs voided across the date/category/supplier/search
    // filter scope, while list query additionally applies the status filter if specified.
    const summaryWhereSql = baseConditions.join(' AND ');
    const listParams = [...params];
    const listConditions = [...baseConditions];
    if (filters.status && filters.status !== 'all') {
        if (!EXPENSE_STATUSES.includes(filters.status)) {
            throw AppError.badRequest(`Invalid expense status filter: "${filters.status}"`);
        }
        listParams.push(filters.status);
        listConditions.push(`e.status = $${listParams.length}`);
    }
    const listWhereSql = listConditions.join(' AND ');
    const page = Math.max(1, Math.trunc(filters.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(filters.pageSize ?? 25)));
    const offset = (page - 1) * pageSize;
    const propertyToday = getPropertyLocalDate(property.timezone);
    const monthStart = `${propertyToday.slice(0, 7)}-01`;
    const [countRes, listRes, sumRes, monthRes, catCountRes, byCatRes] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total
       FROM expenses e
       LEFT JOIN expense_categories ec
         ON ec.id = e.category_id AND ec.property_id = e.property_id
       LEFT JOIN suppliers s
         ON s.id = e.supplier_id AND s.property_id = e.property_id
       WHERE ${listWhereSql}`, listParams),
        pool.query(`${EXPENSE_SELECT}
       WHERE ${listWhereSql}
       ORDER BY e.expense_date DESC, e.created_at DESC
       LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`, [...listParams, pageSize, offset]),
        pool.query(`SELECT
         COUNT(*) FILTER (WHERE e.status = 'recorded')::int AS recorded_count,
         COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'recorded'), 0) AS recorded_total,
         COALESCE(SUM(e.tax_amount) FILTER (WHERE e.status = 'recorded'), 0) AS recorded_tax_total,
         COUNT(*) FILTER (WHERE e.status = 'voided')::int AS voided_count,
         COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'voided'), 0) AS voided_total
       FROM expenses e
       LEFT JOIN expense_categories ec
         ON ec.id = e.category_id AND ec.property_id = e.property_id
       LEFT JOIN suppliers s
         ON s.id = e.supplier_id AND s.property_id = e.property_id
       WHERE ${summaryWhereSql}`, params),
        pool.query(`SELECT
         COUNT(*)::int AS cnt,
         COALESCE(SUM(amount), 0) AS total_amount
       FROM expenses
       WHERE property_id = $1
         AND status = 'recorded'
         AND expense_date >= $2::date
         AND expense_date <= $3::date`, [property.id, monthStart, propertyToday]),
        pool.query(`SELECT COUNT(*)::int AS cnt
       FROM expense_categories
       WHERE property_id = $1 AND is_active = TRUE`, [property.id]),
        pool.query(`SELECT
         e.category_id,
         COALESCE(ec.code, e.category, 'GENERAL') AS category_code,
         COALESCE(ec.name, NULLIF(e.category_name_snapshot, ''), e.category, 'Uncategorized') AS category_name,
         COALESCE(ec.is_active, TRUE) AS is_category_active,
         COUNT(*)::int AS recorded_count,
         COALESCE(SUM(e.amount), 0) AS recorded_amount
       FROM expenses e
       LEFT JOIN expense_categories ec
         ON ec.id = e.category_id AND ec.property_id = e.property_id
       LEFT JOIN suppliers s
         ON s.id = e.supplier_id AND s.property_id = e.property_id
       WHERE ${summaryWhereSql}
         AND e.status = 'recorded'
       GROUP BY e.category_id, ec.code, ec.name, ec.is_active, e.category_name_snapshot, e.category
       ORDER BY recorded_amount DESC, category_name ASC`, params),
    ]);
    const total = Number(countRes.rows[0]?.total ?? 0);
    const sumRow = sumRes.rows[0] ?? {};
    const monthRow = monthRes.rows[0] ?? {};
    const recordedTotal = roundCurrency(Number(sumRow.recorded_total ?? 0));
    const byCategory = byCatRes.rows.map((r) => {
        const amt = roundCurrency(Number(r.recorded_amount ?? 0));
        const sharePercent = recordedTotal > 0 ? Math.round(((amt / recordedTotal) * 1000)) / 10 : 0;
        return {
            categoryId: r.category_id ? String(r.category_id) : null,
            categoryCode: String(r.category_code),
            categoryName: String(r.category_name),
            isCategoryActive: Boolean(r.is_category_active),
            recordedCount: Number(r.recorded_count ?? 0),
            recordedAmount: amt,
            sharePercent,
        };
    });
    const summary = {
        recordedCount: Number(sumRow.recorded_count ?? 0),
        recordedTotal,
        recordedTaxTotal: roundCurrency(Number(sumRow.recorded_tax_total ?? 0)),
        voidedCount: Number(sumRow.voided_count ?? 0),
        voidedTotal: roundCurrency(Number(sumRow.voided_total ?? 0)),
        thisMonthRecordedCount: Number(monthRow.cnt ?? 0),
        thisMonthRecordedTotal: roundCurrency(Number(monthRow.total_amount ?? 0)),
        activeCategoriesCount: Number(catCountRes.rows[0]?.cnt ?? 0),
        currency: property.currency,
        byCategory,
    };
    return {
        items: listRes.rows.map(mapExpenseRow),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        summary,
    };
}
export async function getExpenseDetail(propertyId, expenseId) {
    const pool = getPool();
    const expense = await queryExpenseById(pool, propertyId, expenseId);
    const histRes = await pool.query(`SELECT eh.*,
            u.full_name AS actor_name
     FROM expense_history eh
     LEFT JOIN users u ON u.id = eh.actor_user_id
     WHERE eh.expense_id = $1 AND eh.property_id = $2
     ORDER BY eh.created_at ASC, eh.id ASC`, [expenseId, propertyId]);
    return {
        ...expense,
        history: histRes.rows.map(mapExpenseHistoryRow),
    };
}
export async function createExpense(property, actor, rawPayload) {
    const parsed = expenseCreateSchema.safeParse(rawPayload);
    if (!parsed.success) {
        const formatted = formatZodError(parsed.error);
        throw AppError.badRequest(formatted.message, formatted.fieldErrors);
    }
    const data = parsed.data;
    const fingerprint = computeCreateExpenseFingerprint({
        categoryId: data.categoryId,
        supplierId: data.supplierId ?? null,
        vendorName: data.vendorName,
        title: data.title,
        description: data.description,
        amount: data.amount,
        taxAmount: data.taxAmount,
        expenseDate: data.expenseDate,
        paymentMethod: data.paymentMethod,
        referenceNumber: data.referenceNumber,
        notes: data.notes,
    });
    const result = await withTransaction(async (client) => {
        if (data.idempotencyKey) {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [property.id, `expense_idem:${data.idempotencyKey}`]);
            const existingIdem = await client.query(`SELECT id, request_fingerprint
         FROM expenses
         WHERE property_id = $1 AND idempotency_key = $2
         LIMIT 1`, [property.id, data.idempotencyKey]);
            if ((existingIdem.rowCount ?? 0) > 0) {
                const matched = existingIdem.rows[0];
                if (matched.request_fingerprint && matched.request_fingerprint !== fingerprint) {
                    throw AppError.conflict('Idempotency key has already been used with different expense parameters.');
                }
                return { expenseId: String(matched.id), idempotentReplay: true };
            }
        }
        // Verify property-scoped expense category
        const catRes = await client.query(`SELECT id, code, name, is_active
       FROM expense_categories
       WHERE id = $1 AND property_id = $2
       LIMIT 1`, [data.categoryId, property.id]);
        if (catRes.rowCount === 0) {
            throw AppError.notFound('Selected expense category does not exist in this property');
        }
        const catRow = catRes.rows[0];
        if (!catRow.is_active) {
            throw AppError.conflict(`Expense category "${catRow.name}" is inactive and cannot be used for new expenses.`);
        }
        let resolvedVendorName = data.vendorName.trim();
        if (data.supplierId) {
            const supRes = await client.query(`SELECT id, name, is_active
         FROM suppliers
         WHERE id = $1 AND property_id = $2
         LIMIT 1`, [data.supplierId, property.id]);
            if (supRes.rowCount === 0) {
                throw AppError.notFound('Selected supplier does not exist in this property');
            }
            const supRow = supRes.rows[0];
            if (!supRow.is_active) {
                throw AppError.conflict(`Supplier "${supRow.name}" is inactive and cannot be assigned to new expenses.`);
            }
            if (!resolvedVendorName) {
                resolvedVendorName = String(supRow.name);
            }
        }
        const expenseNumber = await allocateNextExpenseNumber(client, property);
        const amountFixed = roundCurrency(data.amount).toFixed(2);
        const taxFixed = roundCurrency(data.taxAmount).toFixed(2);
        const ins = await client.query(`INSERT INTO expenses (
         property_id, expense_number, category_id, category, category_name_snapshot,
         supplier_id, vendor_name, title, description, amount, tax_amount, currency,
         expense_date, payment_method, reference_number, notes, status,
         recorded_by, updated_by, idempotency_key, request_fingerprint
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10, $11, $12,
         $13::date, $14, $15, $16, 'recorded',
         $17, $17, $18, $19
       )
       RETURNING *`, [
            property.id,
            expenseNumber,
            catRow.id,
            catRow.code,
            catRow.name,
            data.supplierId ?? null,
            resolvedVendorName,
            data.title,
            data.description,
            amountFixed,
            taxFixed,
            property.currency,
            data.expenseDate,
            data.paymentMethod,
            data.referenceNumber,
            data.notes,
            actor.id,
            data.idempotencyKey ?? null,
            fingerprint,
        ]);
        const createdRow = ins.rows[0];
        const snap = buildExpenseSnapshot(createdRow);
        await client.query(`INSERT INTO expense_history (
         expense_id, property_id, action, reason, previous_snapshot, new_snapshot, actor_user_id
       ) VALUES ($1, $2, 'created', $3, NULL, $4::jsonb, $5)`, [
            createdRow.id,
            property.id,
            'Operating expense recorded',
            JSON.stringify(snap),
            actor.id,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actor.id,
            entityType: 'expense',
            entityId: createdRow.id,
            action: 'created',
            summary: `Recorded expense ${expenseNumber} (${data.title}) for ${property.currency} ${amountFixed}`,
            payload: snap,
        }, client);
        return { expenseId: String(createdRow.id), idempotentReplay: false };
    });
    const detail = await getExpenseDetail(property.id, result.expenseId);
    return { expense: detail, idempotentReplay: result.idempotentReplay };
}
export async function updateExpense(property, expenseId, actor, rawPayload) {
    const parsed = expenseUpdateSchema.safeParse(rawPayload);
    if (!parsed.success) {
        const formatted = formatZodError(parsed.error);
        throw AppError.badRequest(formatted.message, formatted.fieldErrors);
    }
    const data = parsed.data;
    await withTransaction(async (client) => {
        const existingRes = await client.query(`SELECT * FROM expenses
       WHERE id = $1 AND property_id = $2
       FOR UPDATE`, [expenseId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Operating expense not found');
        }
        const existing = existingRes.rows[0];
        if (String(existing.status) === 'voided') {
            throw AppError.conflict('Voided expenses are locked and cannot be edited.');
        }
        const nextAmount = data.amount !== undefined ? roundCurrency(data.amount) : roundCurrency(Number(existing.amount));
        const nextTaxAmount = data.taxAmount !== undefined
            ? roundCurrency(data.taxAmount)
            : roundCurrency(Number(existing.tax_amount ?? 0));
        if (nextTaxAmount > nextAmount) {
            throw AppError.badRequest('Included tax portion cannot exceed total expense amount', {
                taxAmount: 'Included tax portion cannot exceed total expense amount',
            });
        }
        let nextCategoryId = existing.category_id ? String(existing.category_id) : null;
        let nextCategoryCode = String(existing.category ?? 'GENERAL');
        let nextCategoryNameSnapshot = String(existing.category_name_snapshot ?? existing.category ?? '');
        if (data.categoryId !== undefined && data.categoryId !== nextCategoryId) {
            const catRes = await client.query(`SELECT id, code, name, is_active
         FROM expense_categories
         WHERE id = $1 AND property_id = $2
         LIMIT 1`, [data.categoryId, property.id]);
            if (catRes.rowCount === 0) {
                throw AppError.notFound('Selected expense category does not exist in this property');
            }
            const catRow = catRes.rows[0];
            if (!catRow.is_active) {
                throw AppError.conflict(`Expense category "${catRow.name}" is inactive and cannot be assigned.`);
            }
            nextCategoryId = String(catRow.id);
            nextCategoryCode = String(catRow.code);
            nextCategoryNameSnapshot = String(catRow.name);
        }
        const nextSupplierId = data.supplierId !== undefined
            ? data.supplierId
            : existing.supplier_id
                ? String(existing.supplier_id)
                : null;
        let nextVendorName = data.vendorName !== undefined ? data.vendorName.trim() : String(existing.vendor_name ?? '');
        if (nextSupplierId && nextSupplierId !== (existing.supplier_id ? String(existing.supplier_id) : null)) {
            const supRes = await client.query(`SELECT id, name, is_active
         FROM suppliers
         WHERE id = $1 AND property_id = $2
         LIMIT 1`, [nextSupplierId, property.id]);
            if (supRes.rowCount === 0) {
                throw AppError.notFound('Selected supplier does not exist in this property');
            }
            const supRow = supRes.rows[0];
            if (!supRow.is_active) {
                throw AppError.conflict(`Supplier "${supRow.name}" is inactive and cannot be assigned.`);
            }
            if (!nextVendorName) {
                nextVendorName = String(supRow.name);
            }
        }
        const nextTitle = data.title !== undefined ? data.title : String(existing.title);
        const nextDescription = data.description !== undefined ? data.description : String(existing.description ?? '');
        const nextExpenseDate = data.expenseDate !== undefined ? data.expenseDate : toIsoDateString(existing.expense_date);
        const nextPaymentMethod = data.paymentMethod !== undefined ? data.paymentMethod : String(existing.payment_method);
        const nextReferenceNumber = data.referenceNumber !== undefined
            ? data.referenceNumber
            : String(existing.reference_number ?? '');
        const nextNotes = data.notes !== undefined ? data.notes : String(existing.notes ?? '');
        const prevSnapshot = buildExpenseSnapshot(existing);
        const upd = await client.query(`UPDATE expenses
       SET category_id = $1,
           category = $2,
           category_name_snapshot = $3,
           supplier_id = $4,
           vendor_name = $5,
           title = $6,
           description = $7,
           amount = $8,
           tax_amount = $9,
           expense_date = $10::date,
           payment_method = $11,
           reference_number = $12,
           notes = $13,
           updated_by = $14,
           updated_at = NOW()
       WHERE id = $15 AND property_id = $16
       RETURNING *`, [
            nextCategoryId,
            nextCategoryCode,
            nextCategoryNameSnapshot,
            nextSupplierId,
            nextVendorName,
            nextTitle,
            nextDescription,
            nextAmount.toFixed(2),
            nextTaxAmount.toFixed(2),
            nextExpenseDate,
            nextPaymentMethod,
            nextReferenceNumber,
            nextNotes,
            actor.id,
            expenseId,
            property.id,
        ]);
        const updatedRow = upd.rows[0];
        const newSnapshot = buildExpenseSnapshot(updatedRow);
        await client.query(`INSERT INTO expense_history (
         expense_id, property_id, action, reason, previous_snapshot, new_snapshot, actor_user_id
       ) VALUES ($1, $2, 'updated', $3, $4::jsonb, $5::jsonb, $6)`, [
            expenseId,
            property.id,
            'Operating expense details updated',
            JSON.stringify(prevSnapshot),
            JSON.stringify(newSnapshot),
            actor.id,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actor.id,
            entityType: 'expense',
            entityId: expenseId,
            action: 'updated',
            summary: `Updated expense ${updatedRow.expense_number ?? expenseId} (${nextTitle})`,
            payload: { previous: prevSnapshot, updated: newSnapshot },
        }, client);
    });
    return getExpenseDetail(property.id, expenseId);
}
export async function voidExpense(property, expenseId, actor, rawPayload) {
    const parsed = expenseVoidSchema.safeParse(rawPayload);
    if (!parsed.success) {
        const formatted = formatZodError(parsed.error);
        throw AppError.badRequest(formatted.message, formatted.fieldErrors);
    }
    const { reason } = parsed.data;
    await withTransaction(async (client) => {
        const existingRes = await client.query(`SELECT * FROM expenses
       WHERE id = $1 AND property_id = $2
       FOR UPDATE`, [expenseId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Operating expense not found');
        }
        const existing = existingRes.rows[0];
        if (String(existing.status) === 'voided') {
            throw AppError.conflict('This operating expense has already been voided.');
        }
        const prevSnapshot = buildExpenseSnapshot(existing);
        const upd = await client.query(`UPDATE expenses
       SET status = 'voided',
           voided_at = NOW(),
           voided_by = $1,
           void_reason = $2,
           updated_by = $1,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4
       RETURNING *`, [actor.id, reason, expenseId, property.id]);
        const voidedRow = upd.rows[0];
        const newSnapshot = buildExpenseSnapshot(voidedRow);
        await client.query(`INSERT INTO expense_history (
         expense_id, property_id, action, reason, previous_snapshot, new_snapshot, actor_user_id
       ) VALUES ($1, $2, 'voided', $3, $4::jsonb, $5::jsonb, $6)`, [
            expenseId,
            property.id,
            reason,
            JSON.stringify(prevSnapshot),
            JSON.stringify(newSnapshot),
            actor.id,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actor.id,
            entityType: 'expense',
            entityId: expenseId,
            action: 'voided',
            summary: `Voided expense ${voidedRow.expense_number ?? expenseId}: ${reason}`,
            payload: { reason, previous: prevSnapshot, updated: newSnapshot },
        }, client);
    });
    return getExpenseDetail(property.id, expenseId);
}
