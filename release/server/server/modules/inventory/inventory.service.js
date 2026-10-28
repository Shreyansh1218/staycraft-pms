import { getInventoryStockStatus, INVENTORY_STOCK_STATUSES, STOCK_MOVEMENT_SOURCES, STOCK_MOVEMENT_TYPES, } from '../../../shared/constants.js';
import { getPropertyLocalDate, isValidIsoDate } from '../../../shared/dates.js';
import { fromCents, roundCurrency, toCents } from '../../../shared/pricing.js';
import { inventoryCategoryCreateSchema, inventoryCategoryUpdateSchema, inventoryItemCreateSchema, inventoryItemUpdateSchema, inventoryReceiptCreateSchema, stockAdjustmentCreateSchema, } from '../../../shared/schemas.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';
export function toStockUnits(value) {
    const num = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(num)) {
        throw new Error('Invalid stock quantity');
    }
    return Math.round((num + Math.sign(num) * Number.EPSILON) * 100);
}
export function fromStockUnits(units) {
    return Math.round(units) / 100;
}
function computeLineTotal(quantityUnits, unitCostCents) {
    // quantityUnits is quantity * 100; unitCostCents is unitCost * 100
    // lineTotalCents = round((quantityUnits * unitCostCents) / 100)
    const lineTotalCents = Math.round((quantityUnits * unitCostCents) / 100);
    return fromCents(lineTotalCents);
}
function mapInventoryCategoryRow(row) {
    return {
        id: row.id,
        propertyId: row.property_id,
        code: row.code,
        name: row.name,
        description: row.description ?? '',
        displayOrder: Number(row.display_order ?? 0),
        isActive: Boolean(row.is_active),
        itemCount: Number(row.item_count ?? 0),
        activeItemCount: Number(row.active_item_count ?? 0),
        lowStockItemCount: Number(row.low_stock_item_count ?? 0),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
function mapInventoryItemRow(row) {
    const currentStock = fromStockUnits(toStockUnits(row.current_stock ?? 0));
    const reorderLevel = fromStockUnits(toStockUnits(row.reorder_level ?? 0));
    const unitCost = roundCurrency(Number(row.unit_cost ?? 0));
    const stockValue = computeLineTotal(toStockUnits(currentStock), toCents(unitCost));
    const isActive = Boolean(row.is_active);
    const stockStatus = getInventoryStockStatus(currentStock, reorderLevel);
    return {
        id: row.id,
        propertyId: row.property_id,
        categoryId: row.category_id ?? null,
        categoryName: row.category_name ?? row.category ?? 'Uncategorized',
        categoryCode: row.category_code ?? '',
        supplierId: row.supplier_id ?? null,
        supplierName: row.supplier_name ?? null,
        supplierIsActive: row.supplier_is_active !== null && row.supplier_is_active !== undefined
            ? Boolean(row.supplier_is_active)
            : null,
        sku: row.sku,
        name: row.name,
        description: row.description ?? '',
        unit: row.unit,
        currentStock,
        reorderLevel,
        unitCost,
        stockValue,
        isActive,
        stockStatus,
        isLowStock: isActive && currentStock <= reorderLevel,
        linkedMenuItemCount: Number(row.linked_menu_item_count ?? 0),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
function mapReceiptItemRow(row) {
    return {
        id: row.id,
        receiptId: row.receipt_id,
        productId: row.product_id,
        productNameSnapshot: row.product_name_snapshot,
        skuSnapshot: row.sku_snapshot,
        unitSnapshot: row.unit_snapshot,
        quantity: fromStockUnits(toStockUnits(row.quantity)),
        unitCost: roundCurrency(Number(row.unit_cost ?? 0)),
        lineTotal: roundCurrency(Number(row.line_total ?? 0)),
        movementId: row.movement_id ?? null,
        sortOrder: Number(row.sort_order ?? 0),
        createdAt: new Date(row.created_at).toISOString(),
    };
}
function mapReceiptRow(row, items) {
    const itemsSummary = items
        .map((it) => `${it.quantity} ${it.unitSnapshot} ${it.productNameSnapshot}`)
        .join(', ');
    const receiptDateStr = typeof row.receipt_date === 'string'
        ? row.receipt_date.slice(0, 10)
        : new Date(row.receipt_date).toISOString().slice(0, 10);
    return {
        id: row.id,
        propertyId: row.property_id,
        receiptNumber: row.receipt_number,
        supplierId: row.supplier_id ?? null,
        supplierName: row.supplier_name ?? null,
        vendorInvoiceNumber: row.vendor_invoice_number ?? '',
        receiptDate: receiptDateStr,
        totalAmount: roundCurrency(Number(row.total_amount ?? 0)),
        currency: String(row.currency ?? 'INR').trim(),
        notes: row.notes ?? '',
        receivedBy: row.received_by ?? null,
        receivedByName: row.received_by_name ?? null,
        receivedAt: new Date(row.received_at).toISOString(),
        lineCount: items.length,
        itemsSummary,
        items,
        createdAt: new Date(row.created_at).toISOString(),
    };
}
export function mapStockMovementRow(row) {
    const qty = fromStockUnits(toStockUnits(row.quantity ?? 0));
    const rawDelta = row.quantity_delta !== null && row.quantity_delta !== undefined
        ? fromStockUnits(toStockUnits(row.quantity_delta))
        : row.movement_type === 'in'
            ? qty
            : -qty;
    return {
        id: row.id,
        propertyId: row.property_id,
        productId: row.product_id,
        productSku: row.product_sku ?? '',
        productName: row.product_name ?? '',
        categoryName: row.category_name ?? row.product_category ?? 'Uncategorized',
        unit: row.product_unit ?? 'pcs',
        movementType: row.movement_type,
        movementSource: (row.movement_source ?? 'manual_adjustment'),
        quantity: qty,
        quantityDelta: rawDelta,
        stockBefore: fromStockUnits(toStockUnits(row.stock_before ?? 0)),
        stockAfter: fromStockUnits(toStockUnits(row.stock_after ?? 0)),
        unitCost: roundCurrency(Number(row.unit_cost ?? 0)),
        reason: row.reason ?? '',
        referenceNote: row.reference_note ?? '',
        supplierId: row.supplier_id ?? null,
        supplierName: row.supplier_name ?? null,
        receiptId: row.receipt_id ?? null,
        receiptNumber: row.receipt_number ?? null,
        foodOrderId: row.food_order_id ?? null,
        foodOrderReference: row.food_order_reference ?? null,
        recordedBy: row.recorded_by ?? null,
        recordedByName: row.recorded_by_name ?? null,
        createdAt: new Date(row.created_at).toISOString(),
    };
}
const INVENTORY_ITEM_SELECT = `
  SELECT ip.*,
         ic.name AS category_name,
         ic.code AS category_code,
         s.name AS supplier_name,
         s.is_active AS supplier_is_active,
         COALESCE(mi_stats.linked_menu_item_count, 0)::int AS linked_menu_item_count
  FROM inventory_products ip
  LEFT JOIN inventory_categories ic
    ON ic.id = ip.category_id AND ic.property_id = ip.property_id
  LEFT JOIN suppliers s
    ON s.id = ip.supplier_id AND s.property_id = ip.property_id
  LEFT JOIN (
    SELECT product_id, COUNT(*)::int AS linked_menu_item_count
    FROM food_menu_item_ingredients
    WHERE property_id = $1
    GROUP BY product_id
  ) mi_stats ON mi_stats.product_id = ip.id
`;
const STOCK_MOVEMENT_SELECT = `
  SELECT sm.*,
         ip.sku AS product_sku,
         ip.name AS product_name,
         ip.category AS product_category,
         ip.unit AS product_unit,
         ic.name AS category_name,
         s.name AS supplier_name,
         ir.receipt_number,
         fo.order_reference AS food_order_reference,
         u.full_name AS recorded_by_name
  FROM stock_movements sm
  JOIN inventory_products ip
    ON ip.id = sm.product_id AND ip.property_id = sm.property_id
  LEFT JOIN inventory_categories ic
    ON ic.id = ip.category_id AND ic.property_id = ip.property_id
  LEFT JOIN suppliers s
    ON s.id = sm.supplier_id AND s.property_id = sm.property_id
  LEFT JOIN inventory_receipts ir
    ON ir.id = sm.receipt_id AND ir.property_id = sm.property_id
  LEFT JOIN food_orders fo
    ON fo.id = sm.food_order_id AND fo.property_id = sm.property_id
  LEFT JOIN users u
    ON u.id = sm.recorded_by
`;
async function allocateNextReceiptNumber(client, property) {
    await client.query(`INSERT INTO property_inventory_receipt_counters (property_id, next_number)
     VALUES ($1, 1001)
     ON CONFLICT (property_id) DO NOTHING`, [property.id]);
    const counterRes = await client.query(`SELECT next_number
     FROM property_inventory_receipt_counters
     WHERE property_id = $1
     FOR UPDATE`, [property.id]);
    let nextNum = Math.max(1, Number(counterRes.rows[0]?.next_number ?? 1001));
    const cleanCode = property.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'INV';
    let receiptNumber = '';
    for (let attempts = 0; attempts < 5000; attempts++) {
        const candidate = `${cleanCode}-RCV-${String(nextNum).padStart(4, '0')}`;
        const dupRes = await client.query('SELECT 1 FROM inventory_receipts WHERE property_id = $1 AND receipt_number = $2 LIMIT 1', [property.id, candidate]);
        if (dupRes.rowCount === 0) {
            receiptNumber = candidate;
            break;
        }
        nextNum += 1;
    }
    if (!receiptNumber) {
        receiptNumber = `${cleanCode}-RCV-${Date.now()}`;
    }
    await client.query(`UPDATE property_inventory_receipt_counters
     SET next_number = $2
     WHERE property_id = $1`, [property.id, nextNum + 1]);
    return receiptNumber;
}
// ============================================================================
// 1. INVENTORY DASHBOARD SUMMARY & LOW-STOCK INDICATORS
// ============================================================================
export async function getInventorySummary(property) {
    const pool = getPool();
    const propertyToday = getPropertyLocalDate(property.timezone);
    const monthStart = `${propertyToday.slice(0, 7)}-01`;
    const [itemStatsRes, catStatsRes, supStatsRes, movStatsRes, recStatsRes, lowItemsRes] = await Promise.all([
        pool.query(`SELECT
           COUNT(*) FILTER (WHERE is_active = TRUE)::int AS total_active_items,
           COUNT(*) FILTER (WHERE is_active = FALSE)::int AS total_inactive_items,
           COUNT(*) FILTER (WHERE is_active = TRUE AND current_stock <= reorder_level)::int AS low_stock_count,
           COUNT(*) FILTER (WHERE is_active = TRUE AND current_stock <= 0)::int AS out_of_stock_count,
           COALESCE(
             SUM(ROUND(current_stock * unit_cost, 2)) FILTER (WHERE is_active = TRUE),
             0
           ) AS total_valuation
         FROM inventory_products
         WHERE property_id = $1`, [property.id]),
        pool.query(`SELECT COUNT(*)::int AS cnt
         FROM inventory_categories
         WHERE property_id = $1 AND is_active = TRUE`, [property.id]),
        pool.query(`SELECT COUNT(*)::int AS cnt
         FROM suppliers
         WHERE property_id = $1 AND is_active = TRUE`, [property.id]),
        pool.query(`SELECT COUNT(*)::int AS cnt
         FROM stock_movements
         WHERE property_id = $1
           AND (created_at AT TIME ZONE $2)::date = $3::date`, [property.id, property.timezone, propertyToday]),
        pool.query(`SELECT COUNT(*)::int AS cnt,
                COALESCE(SUM(total_amount), 0) AS total_amount
         FROM inventory_receipts
         WHERE property_id = $1
           AND receipt_date >= $2::date`, [property.id, monthStart]),
        pool.query(`${INVENTORY_ITEM_SELECT}
         WHERE ip.property_id = $1
           AND ip.is_active = TRUE
           AND ip.current_stock <= ip.reorder_level
         ORDER BY (ip.current_stock <= 0) DESC,
                  (ip.current_stock - ip.reorder_level) ASC,
                  ip.name ASC
         LIMIT 25`, [property.id]),
    ]);
    const itemStats = itemStatsRes.rows[0] ?? {};
    const recStats = recStatsRes.rows[0] ?? {};
    return {
        totalActiveItems: Number(itemStats.total_active_items ?? 0),
        totalInactiveItems: Number(itemStats.total_inactive_items ?? 0),
        lowStockCount: Number(itemStats.low_stock_count ?? 0),
        outOfStockCount: Number(itemStats.out_of_stock_count ?? 0),
        activeCategoriesCount: Number(catStatsRes.rows[0]?.cnt ?? 0),
        activeSuppliersCount: Number(supStatsRes.rows[0]?.cnt ?? 0),
        totalInventoryValuation: roundCurrency(Number(itemStats.total_valuation ?? 0)),
        movementsTodayCount: Number(movStatsRes.rows[0]?.cnt ?? 0),
        receiptsThisMonthCount: Number(recStats.cnt ?? 0),
        receiptsThisMonthAmount: roundCurrency(Number(recStats.total_amount ?? 0)),
        currency: property.currency,
        lowStockItems: lowItemsRes.rows.map(mapInventoryItemRow),
    };
}
// ============================================================================
// 2. INVENTORY CATEGORIES
// ============================================================================
export async function listInventoryCategories(propertyId, includeInactive = false) {
    const pool = getPool();
    const res = await pool.query(`SELECT c.*,
            COUNT(ip.id)::int AS item_count,
            COUNT(ip.id) FILTER (WHERE ip.is_active = TRUE)::int AS active_item_count,
            COUNT(ip.id) FILTER (
              WHERE ip.is_active = TRUE AND ip.current_stock <= ip.reorder_level
            )::int AS low_stock_item_count
     FROM inventory_categories c
     LEFT JOIN inventory_products ip
       ON ip.category_id = c.id AND ip.property_id = c.property_id
     WHERE c.property_id = $1
       AND ($2::boolean = TRUE OR c.is_active = TRUE)
     GROUP BY c.id
     ORDER BY c.display_order ASC, c.name ASC`, [propertyId, includeInactive]);
    return res.rows.map(mapInventoryCategoryRow);
}
export async function getInventoryCategoryById(propertyId, categoryId, db = getPool()) {
    const res = await db.query(`SELECT c.*,
            COUNT(ip.id)::int AS item_count,
            COUNT(ip.id) FILTER (WHERE ip.is_active = TRUE)::int AS active_item_count,
            COUNT(ip.id) FILTER (
              WHERE ip.is_active = TRUE AND ip.current_stock <= ip.reorder_level
            )::int AS low_stock_item_count
     FROM inventory_categories c
     LEFT JOIN inventory_products ip
       ON ip.category_id = c.id AND ip.property_id = c.property_id
     WHERE c.id = $1 AND c.property_id = $2
     GROUP BY c.id`, [categoryId, propertyId]);
    if (res.rowCount === 0) {
        throw AppError.notFound('Inventory category not found');
    }
    return mapInventoryCategoryRow(res.rows[0]);
}
export async function createInventoryCategory(property, actorUser, rawInput) {
    if (actorUser.role !== 'admin') {
        throw AppError.forbidden('Administrator role is required to create inventory categories.');
    }
    const input = inventoryCategoryCreateSchema.parse(rawInput);
    const categoryId = await withTransaction(async (client) => {
        const ins = await client.query(`INSERT INTO inventory_categories (
         property_id, code, name, description, display_order, is_active,
         created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id`, [
            property.id,
            input.code,
            input.name,
            input.description,
            input.displayOrder,
            input.isActive,
            actorUser.id,
        ]);
        const id = ins.rows[0].id;
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'inventory_category',
            entityId: id,
            action: 'created',
            summary: `Created inventory category "${input.name}" (${input.code})`,
        }, client);
        return id;
    });
    return getInventoryCategoryById(property.id, categoryId);
}
export async function updateInventoryCategory(property, categoryId, actorUser, rawInput) {
    if (actorUser.role !== 'admin') {
        throw AppError.forbidden('Administrator role is required to update inventory categories.');
    }
    const input = inventoryCategoryUpdateSchema.parse(rawInput);
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM inventory_categories WHERE id = $1 AND property_id = $2 FOR UPDATE', [categoryId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Inventory category not found');
        }
        const existing = existingRes.rows[0];
        const nextName = input.name ?? existing.name;
        const nextCode = input.code ?? existing.code;
        const nextIsActive = input.isActive ?? existing.is_active;
        await client.query(`UPDATE inventory_categories
       SET code = $1,
           name = $2,
           description = $3,
           display_order = $4,
           is_active = $5,
           updated_by = $6,
           updated_at = NOW()
       WHERE id = $7 AND property_id = $8`, [
            nextCode,
            nextName,
            input.description ?? existing.description,
            input.displayOrder ?? existing.display_order,
            nextIsActive,
            actorUser.id,
            categoryId,
            property.id,
        ]);
        if (nextName !== existing.name) {
            await client.query(`UPDATE inventory_products
         SET category = $1
         WHERE property_id = $2 AND category_id = $3`, [nextName.slice(0, 80), property.id, categoryId]);
        }
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'inventory_category',
            entityId: categoryId,
            action: 'updated',
            summary: `Updated inventory category "${nextName}" (active: ${Boolean(nextIsActive)})`,
        }, client);
    });
    return getInventoryCategoryById(property.id, categoryId);
}
export async function listInventoryItems(propertyId, filter = {}) {
    const pool = getPool();
    const params = [propertyId];
    const conditions = ['ip.property_id = $1'];
    if (!filter.includeInactive) {
        conditions.push('ip.is_active = TRUE');
    }
    if (filter.categoryId) {
        params.push(filter.categoryId);
        conditions.push(`ip.category_id = $${params.length}`);
    }
    if (filter.supplierId) {
        if (filter.supplierId === 'none') {
            conditions.push('ip.supplier_id IS NULL');
        }
        else {
            params.push(filter.supplierId);
            conditions.push(`ip.supplier_id = $${params.length}`);
        }
    }
    if (filter.stockFilter && filter.stockFilter !== 'all' && filter.stockFilter.trim() !== '') {
        const sf = filter.stockFilter.trim();
        if (!INVENTORY_STOCK_STATUSES.includes(sf)) {
            throw AppError.badRequest(`Invalid stockFilter: "${sf}". Allowed values: all, ${INVENTORY_STOCK_STATUSES.join(', ')}`);
        }
        if (sf === 'out_of_stock') {
            conditions.push('ip.current_stock <= 0');
        }
        else if (sf === 'low_stock') {
            conditions.push('ip.current_stock <= ip.reorder_level');
        }
        else if (sf === 'in_stock') {
            conditions.push('ip.current_stock > ip.reorder_level AND ip.current_stock > 0');
        }
    }
    if (filter.search && filter.search.trim().length > 0) {
        params.push(`%${filter.search.trim()}%`);
        const idx = params.length;
        conditions.push(`(ip.name ILIKE $${idx} OR ip.sku ILIKE $${idx} OR ip.description ILIKE $${idx} OR COALESCE(ic.name, ip.category) ILIKE $${idx} OR COALESCE(s.name, '') ILIKE $${idx})`);
    }
    const res = await pool.query(`${INVENTORY_ITEM_SELECT}
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(ic.display_order, 9999) ASC,
              COALESCE(ic.name, ip.category) ASC,
              ip.name ASC`, params);
    return res.rows.map(mapInventoryItemRow);
}
export async function getInventoryItemById(propertyId, itemId, db = getPool()) {
    const res = await db.query(`${INVENTORY_ITEM_SELECT}
     WHERE ip.property_id = $1 AND ip.id = $2
     LIMIT 1`, [propertyId, itemId]);
    if (res.rowCount === 0) {
        throw AppError.notFound('Inventory item not found');
    }
    return mapInventoryItemRow(res.rows[0]);
}
export async function createInventoryItem(property, actorUser, rawInput) {
    if (actorUser.role !== 'admin') {
        throw AppError.forbidden('Administrator role is required to create inventory items.');
    }
    const input = inventoryItemCreateSchema.parse(rawInput);
    const itemId = await withTransaction(async (client) => {
        const catRes = await client.query('SELECT id, name, is_active FROM inventory_categories WHERE id = $1 AND property_id = $2 LIMIT 1', [input.categoryId, property.id]);
        if (catRes.rowCount === 0) {
            throw AppError.badRequest('Selected inventory category does not exist in this property.');
        }
        const category = catRes.rows[0];
        if (!category.is_active) {
            throw AppError.conflict('Cannot create an item under an inactive inventory category.');
        }
        if (input.supplierId) {
            const supRes = await client.query('SELECT id, is_active FROM suppliers WHERE id = $1 AND property_id = $2 LIMIT 1', [input.supplierId, property.id]);
            if (supRes.rowCount === 0) {
                throw AppError.badRequest('Selected supplier does not exist in this property.');
            }
            if (!supRes.rows[0].is_active) {
                throw AppError.conflict('Cannot link a new inventory item to an inactive supplier.');
            }
        }
        const openingUnits = toStockUnits(input.openingStock);
        const openingFixed = fromStockUnits(openingUnits).toFixed(2);
        const reorderFixed = fromStockUnits(toStockUnits(input.reorderLevel)).toFixed(2);
        const unitCostFixed = roundCurrency(input.unitCost).toFixed(2);
        const ins = await client.query(`INSERT INTO inventory_products (
         property_id, category_id, supplier_id, sku, name, description,
         category, unit, current_stock, reorder_level, unit_cost, is_active,
         created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
       RETURNING id`, [
            property.id,
            input.categoryId,
            input.supplierId,
            input.sku,
            input.name,
            input.description,
            String(category.name).slice(0, 80),
            input.unit,
            openingFixed,
            reorderFixed,
            unitCostFixed,
            input.isActive,
            actorUser.id,
        ]);
        const id = ins.rows[0].id;
        if (openingUnits > 0) {
            await client.query(`INSERT INTO stock_movements (
           property_id, product_id, movement_type, movement_source,
           quantity, quantity_delta, stock_before, stock_after,
           unit_cost, reason, reference_note, supplier_id,
           source_key, recorded_by
         ) VALUES (
           $1, $2, 'in', 'opening_stock',
           $3, $3, 0, $3,
           $4, 'Initial opening stock recorded on item creation', '', $5,
           $6, $7
         )`, [
                property.id,
                id,
                openingFixed,
                unitCostFixed,
                input.supplierId,
                `opening_stock:${id}`,
                actorUser.id,
            ]);
        }
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'inventory_item',
            entityId: id,
            action: 'created',
            summary: `Created inventory item "${input.name}" (${input.sku}) with opening stock ${openingFixed} ${input.unit}`,
            payload: {
                sku: input.sku,
                openingStock: Number(openingFixed),
                reorderLevel: Number(reorderFixed),
                unitCost: Number(unitCostFixed),
            },
        }, client);
        return id;
    });
    return getInventoryItemById(property.id, itemId);
}
export async function updateInventoryItem(property, itemId, actorUser, rawInput) {
    if (actorUser.role !== 'admin') {
        throw AppError.forbidden('Administrator role is required to update inventory items.');
    }
    const input = inventoryItemUpdateSchema.parse(rawInput);
    await withTransaction(async (client) => {
        const existingRes = await client.query('SELECT * FROM inventory_products WHERE id = $1 AND property_id = $2 FOR UPDATE', [itemId, property.id]);
        if (existingRes.rowCount === 0) {
            throw AppError.notFound('Inventory item not found');
        }
        const existing = existingRes.rows[0];
        const nextCategoryId = input.categoryId ?? existing.category_id;
        let nextCategoryLabel = existing.category;
        if (input.categoryId && input.categoryId !== existing.category_id) {
            const catRes = await client.query('SELECT id, name, is_active FROM inventory_categories WHERE id = $1 AND property_id = $2 LIMIT 1', [nextCategoryId, property.id]);
            if (catRes.rowCount === 0) {
                throw AppError.badRequest('Selected inventory category does not exist in this property.');
            }
            if (!catRes.rows[0].is_active) {
                throw AppError.conflict('Cannot move an item into an inactive inventory category.');
            }
            nextCategoryLabel = String(catRes.rows[0].name).slice(0, 80);
        }
        const nextSupplierId = input.supplierId !== undefined ? input.supplierId : existing.supplier_id;
        if (nextSupplierId && nextSupplierId !== existing.supplier_id) {
            const supRes = await client.query('SELECT id, is_active FROM suppliers WHERE id = $1 AND property_id = $2 LIMIT 1', [nextSupplierId, property.id]);
            if (supRes.rowCount === 0) {
                throw AppError.badRequest('Selected supplier does not exist in this property.');
            }
            if (!supRes.rows[0].is_active) {
                throw AppError.conflict('Cannot assign an inactive supplier to an inventory item.');
            }
        }
        const nextReorderFixed = input.reorderLevel !== undefined
            ? fromStockUnits(toStockUnits(input.reorderLevel)).toFixed(2)
            : Number(existing.reorder_level).toFixed(2);
        const nextUnitCostFixed = input.unitCost !== undefined
            ? roundCurrency(input.unitCost).toFixed(2)
            : Number(existing.unit_cost).toFixed(2);
        const nextName = input.name ?? existing.name;
        const nextSku = input.sku ?? existing.sku;
        const nextIsActive = input.isActive ?? existing.is_active;
        await client.query(`UPDATE inventory_products
       SET category_id = $1,
           supplier_id = $2,
           sku = $3,
           name = $4,
           description = $5,
           category = $6,
           unit = $7,
           reorder_level = $8,
           unit_cost = $9,
           is_active = $10,
           updated_by = $11,
           updated_at = NOW()
       WHERE id = $12 AND property_id = $13`, [
            nextCategoryId,
            nextSupplierId,
            nextSku,
            nextName,
            input.description ?? existing.description,
            nextCategoryLabel,
            input.unit ?? existing.unit,
            nextReorderFixed,
            nextUnitCostFixed,
            nextIsActive,
            actorUser.id,
            itemId,
            property.id,
        ]);
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'inventory_item',
            entityId: itemId,
            action: 'updated',
            summary: `Updated inventory item "${nextName}" (${nextSku})`,
        }, client);
    });
    return getInventoryItemById(property.id, itemId);
}
// ============================================================================
// 4. TRANSACTIONAL PURCHASE / STOCK RECEIPTS (WITH IDEMPOTENCY)
// ============================================================================
export async function getInventoryReceiptDetail(propertyId, receiptId, db = getPool()) {
    const res = await db.query(`SELECT r.*,
            s.name AS supplier_name,
            u.full_name AS received_by_name
     FROM inventory_receipts r
     LEFT JOIN suppliers s
       ON s.id = r.supplier_id AND s.property_id = r.property_id
     LEFT JOIN users u
       ON u.id = r.received_by
     WHERE r.id = $1 AND r.property_id = $2
     LIMIT 1`, [receiptId, propertyId]);
    if (res.rowCount === 0) {
        throw AppError.notFound('Stock receipt not found');
    }
    const itemsRes = await db.query(`SELECT *
     FROM inventory_receipt_items
     WHERE receipt_id = $1
     ORDER BY sort_order ASC, created_at ASC`, [receiptId]);
    return mapReceiptRow(res.rows[0], itemsRes.rows.map(mapReceiptItemRow));
}
export async function listInventoryReceipts(property, filter = {}) {
    const pool = getPool();
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));
    const offset = (page - 1) * pageSize;
    const params = [property.id];
    const conditions = ['r.property_id = $1'];
    if (filter.supplierId) {
        params.push(filter.supplierId);
        conditions.push(`r.supplier_id = $${params.length}`);
    }
    if (filter.dateFrom && filter.dateFrom.trim() !== '') {
        if (!isValidIsoDate(filter.dateFrom.trim())) {
            throw AppError.badRequest('Invalid dateFrom query parameter: expected YYYY-MM-DD');
        }
        params.push(filter.dateFrom.trim());
        conditions.push(`r.receipt_date >= $${params.length}::date`);
    }
    if (filter.dateTo && filter.dateTo.trim() !== '') {
        if (!isValidIsoDate(filter.dateTo.trim())) {
            throw AppError.badRequest('Invalid dateTo query parameter: expected YYYY-MM-DD');
        }
        params.push(filter.dateTo.trim());
        conditions.push(`r.receipt_date <= $${params.length}::date`);
    }
    if (filter.search && filter.search.trim().length > 0) {
        params.push(`%${filter.search.trim()}%`);
        const idx = params.length;
        conditions.push(`(r.receipt_number ILIKE $${idx} OR r.vendor_invoice_number ILIKE $${idx} OR COALESCE(s.name, '') ILIKE $${idx} OR r.notes ILIKE $${idx})`);
    }
    const whereClause = conditions.join(' AND ');
    const summaryRes = await pool.query(`SELECT COUNT(*)::int AS total_count,
            COALESCE(SUM(r.total_amount), 0) AS total_amount
     FROM inventory_receipts r
     LEFT JOIN suppliers s ON s.id = r.supplier_id AND s.property_id = r.property_id
     WHERE ${whereClause}`, params);
    const total = Number(summaryRes.rows[0]?.total_count ?? 0);
    const totalAmount = roundCurrency(Number(summaryRes.rows[0]?.total_amount ?? 0));
    const listParams = [...params, pageSize, offset];
    const rowsRes = await pool.query(`SELECT r.*,
            s.name AS supplier_name,
            u.full_name AS received_by_name
     FROM inventory_receipts r
     LEFT JOIN suppliers s ON s.id = r.supplier_id AND s.property_id = r.property_id
     LEFT JOIN users u ON u.id = r.received_by
     WHERE ${whereClause}
     ORDER BY r.receipt_date DESC, r.created_at DESC
     LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams);
    const receiptIds = rowsRes.rows.map((r) => r.id);
    const itemsByReceiptId = new Map();
    if (receiptIds.length > 0) {
        const itemsRes = await pool.query(`SELECT *
       FROM inventory_receipt_items
       WHERE receipt_id = ANY($1::uuid[])
       ORDER BY sort_order ASC, created_at ASC`, [receiptIds]);
        for (const row of itemsRes.rows) {
            const mapped = mapReceiptItemRow(row);
            const list = itemsByReceiptId.get(mapped.receiptId) ?? [];
            list.push(mapped);
            itemsByReceiptId.set(mapped.receiptId, list);
        }
    }
    const items = rowsRes.rows.map((row) => mapReceiptRow(row, itemsByReceiptId.get(row.id) ?? []));
    return {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        summary: {
            totalReceipts: total,
            totalAmount,
            currency: property.currency,
        },
    };
}
export async function createInventoryReceipt(property, actorUser, rawInput) {
    const input = inventoryReceiptCreateSchema.parse(rawInput);
    const receiptDate = input.receiptDate ?? getPropertyLocalDate(property.timezone);
    const normalizedFingerprint = JSON.stringify({
        supplierId: input.supplierId ?? null,
        vendorInvoiceNumber: input.vendorInvoiceNumber,
        receiptDate,
        notes: input.notes,
        items: input.items.map((it) => ({
            productId: it.productId,
            quantity: fromStockUnits(toStockUnits(it.quantity)).toFixed(2),
            unitCost: roundCurrency(it.unitCost).toFixed(2),
        })),
    });
    const { receiptId, created } = await withTransaction(async (client) => {
        if (input.idempotencyKey) {
            await client.query("SELECT pg_advisory_xact_lock(hashtext('inv_receipt_idem'), hashtext($1))", [`${property.id}:${input.idempotencyKey}`]);
            const existingIdem = await client.query(`SELECT id, request_fingerprint
         FROM inventory_receipts
         WHERE property_id = $1 AND idempotency_key = $2
         LIMIT 1`, [property.id, input.idempotencyKey]);
            if ((existingIdem.rowCount ?? 0) > 0) {
                const existingRow = existingIdem.rows[0];
                if (existingRow.request_fingerprint !== normalizedFingerprint) {
                    throw AppError.conflict('This idempotency key was already used with different stock receipt details.');
                }
                return { receiptId: existingRow.id, created: false };
            }
        }
        if (input.supplierId) {
            const supRes = await client.query('SELECT id, name, is_active FROM suppliers WHERE id = $1 AND property_id = $2 FOR SHARE', [input.supplierId, property.id]);
            if (supRes.rowCount === 0) {
                throw AppError.badRequest('Selected supplier does not exist in this property.');
            }
            if (!supRes.rows[0].is_active) {
                throw AppError.conflict(`Supplier "${supRes.rows[0].name}" is inactive. Reactivate the supplier or choose an active vendor.`);
            }
        }
        const distinctProductIds = Array.from(new Set(input.items.map((it) => it.productId))).sort();
        const productsRes = await client.query(`SELECT *
       FROM inventory_products
       WHERE property_id = $1 AND id = ANY($2::uuid[])
       ORDER BY id ASC
       FOR UPDATE`, [property.id, distinctProductIds]);
        if (productsRes.rowCount !== distinctProductIds.length) {
            throw AppError.badRequest('One or more selected inventory items do not exist in this property.');
        }
        const productMap = new Map();
        for (const row of productsRes.rows) {
            if (!row.is_active) {
                throw AppError.conflict(`Inventory item "${row.name}" (${row.sku}) is inactive and cannot receive new stock.`);
            }
            productMap.set(row.id, {
                row,
                runningUnits: toStockUnits(row.current_stock),
                latestCostCents: toCents(row.unit_cost),
            });
        }
        const receiptNumber = await allocateNextReceiptNumber(client, property);
        // Pre-compute receipt grand total
        let totalReceiptCents = 0;
        const preparedLines = input.items.map((line, index) => {
            const qtyUnits = toStockUnits(line.quantity);
            const unitCostCents = toCents(line.unitCost);
            const lineTotal = computeLineTotal(qtyUnits, unitCostCents);
            totalReceiptCents += toCents(lineTotal);
            return {
                productId: line.productId,
                qtyUnits,
                unitCostCents,
                lineTotal,
                sortOrder: index + 1,
            };
        });
        const totalReceiptAmountFixed = fromCents(totalReceiptCents).toFixed(2);
        const recIns = await client.query(`INSERT INTO inventory_receipts (
         property_id, receipt_number, supplier_id, vendor_invoice_number,
         receipt_date, total_amount, currency, notes,
         idempotency_key, request_fingerprint, received_by
       ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11)
       RETURNING id`, [
            property.id,
            receiptNumber,
            input.supplierId,
            input.vendorInvoiceNumber,
            receiptDate,
            totalReceiptAmountFixed,
            property.currency,
            input.notes,
            input.idempotencyKey ?? null,
            normalizedFingerprint,
            actorUser.id,
        ]);
        const newReceiptId = recIns.rows[0].id;
        for (const line of preparedLines) {
            const state = productMap.get(line.productId);
            const beforeUnits = state.runningUnits;
            const afterUnits = beforeUnits + line.qtyUnits;
            state.runningUnits = afterUnits;
            if (line.unitCostCents > 0) {
                state.latestCostCents = line.unitCostCents;
            }
            const qtyFixed = fromStockUnits(line.qtyUnits).toFixed(2);
            const beforeFixed = fromStockUnits(beforeUnits).toFixed(2);
            const afterFixed = fromStockUnits(afterUnits).toFixed(2);
            const unitCostFixed = fromCents(line.unitCostCents).toFixed(2);
            const lineTotalFixed = line.lineTotal.toFixed(2);
            const refNote = input.vendorInvoiceNumber
                ? `Receipt ${receiptNumber} • Ref ${input.vendorInvoiceNumber}`
                : `Receipt ${receiptNumber}`;
            const movIns = await client.query(`INSERT INTO stock_movements (
           property_id, product_id, movement_type, movement_source,
           quantity, quantity_delta, stock_before, stock_after,
           unit_cost, reason, reference_note,
           supplier_id, receipt_id, recorded_by
         ) VALUES (
           $1, $2, 'in', 'purchase_receipt',
           $3, $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11
         )
         RETURNING id`, [
                property.id,
                line.productId,
                qtyFixed,
                beforeFixed,
                afterFixed,
                unitCostFixed,
                input.notes || `Stock received on ${receiptNumber}`,
                refNote,
                input.supplierId,
                newReceiptId,
                actorUser.id,
            ]);
            const movementId = movIns.rows[0].id;
            await client.query(`INSERT INTO inventory_receipt_items (
           receipt_id, product_id, product_name_snapshot, sku_snapshot,
           unit_snapshot, quantity, unit_cost, line_total,
           movement_id, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
                newReceiptId,
                line.productId,
                state.row.name,
                state.row.sku,
                state.row.unit,
                qtyFixed,
                unitCostFixed,
                lineTotalFixed,
                movementId,
                line.sortOrder,
            ]);
        }
        // Persist final stock and latest unit cost per locked product
        for (const [prodId, state] of productMap.entries()) {
            await client.query(`UPDATE inventory_products
         SET current_stock = $1,
             unit_cost = $2,
             updated_by = $3,
             updated_at = NOW()
         WHERE id = $4 AND property_id = $5`, [
                fromStockUnits(state.runningUnits).toFixed(2),
                fromCents(state.latestCostCents).toFixed(2),
                actorUser.id,
                prodId,
                property.id,
            ]);
        }
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'inventory_receipt',
            entityId: newReceiptId,
            action: 'created',
            summary: `Recorded stock receipt ${receiptNumber} (${preparedLines.length} line(s), total ${totalReceiptAmountFixed} ${property.currency})`,
            payload: {
                receiptNumber,
                supplierId: input.supplierId,
                vendorInvoiceNumber: input.vendorInvoiceNumber,
                lineCount: preparedLines.length,
                totalAmount: Number(totalReceiptAmountFixed),
            },
        }, client);
        return { receiptId: newReceiptId, created: true };
    });
    const receipt = await getInventoryReceiptDetail(property.id, receiptId);
    return { receipt, created };
}
// ============================================================================
// 5. CONTROLLED STOCK ADJUSTMENTS (ADMIN ONLY, IMMUTABLE LEDGER)
// ============================================================================
export async function createStockAdjustment(property, actorUser, rawInput) {
    if (actorUser.role !== 'admin') {
        throw AppError.forbidden('Administrator role is required to perform controlled stock adjustments.');
    }
    const input = stockAdjustmentCreateSchema.parse(rawInput);
    const qtyUnits = toStockUnits(input.quantity);
    const qtyFixed = fromStockUnits(qtyUnits).toFixed(2);
    const normalizedFingerprint = JSON.stringify({
        productId: input.productId,
        operation: input.operation,
        quantity: qtyFixed,
        reason: input.reason,
        referenceNote: input.referenceNote,
    });
    const { movementId, created } = await withTransaction(async (client) => {
        const sourceKey = input.idempotencyKey ? `adj:${input.idempotencyKey}` : null;
        if (sourceKey) {
            await client.query("SELECT pg_advisory_xact_lock(hashtext('inv_adj_idem'), hashtext($1))", [`${property.id}:${sourceKey}`]);
            const existingMov = await client.query(`SELECT id, request_fingerprint
         FROM stock_movements
         WHERE property_id = $1 AND source_key = $2
         LIMIT 1`, [property.id, sourceKey]);
            if ((existingMov.rowCount ?? 0) > 0) {
                const existingRow = existingMov.rows[0];
                if (existingRow.request_fingerprint !== normalizedFingerprint) {
                    throw AppError.conflict('This idempotency key was already used with different stock adjustment parameters.');
                }
                return { movementId: existingRow.id, created: false };
            }
        }
        const prodRes = await client.query('SELECT * FROM inventory_products WHERE id = $1 AND property_id = $2 FOR UPDATE', [input.productId, property.id]);
        if (prodRes.rowCount === 0) {
            throw AppError.notFound('Inventory item not found');
        }
        const product = prodRes.rows[0];
        if (!product.is_active) {
            throw AppError.conflict(`Inventory item "${product.name}" (${product.sku}) is inactive. Reactivate the item before adjusting stock.`);
        }
        const beforeUnits = toStockUnits(product.current_stock);
        const deltaUnits = input.operation === 'increase' ? qtyUnits : -qtyUnits;
        const afterUnits = beforeUnits + deltaUnits;
        if (afterUnits < 0) {
            throw AppError.conflict(`Insufficient stock for "${product.name}" (${product.sku}): available ${fromStockUnits(beforeUnits).toFixed(2)} ${product.unit}, requested deduction ${qtyFixed} ${product.unit}.`, {
                reason: 'INSUFFICIENT_STOCK',
                productId: product.id,
                availableStock: fromStockUnits(beforeUnits),
                requestedQuantity: fromStockUnits(qtyUnits),
            });
        }
        let movementType = 'adjustment';
        let movementSource = 'manual_adjustment';
        if (input.operation === 'wastage') {
            movementType = 'wastage';
            movementSource = 'wastage';
        }
        else if (input.operation === 'department_issue') {
            movementType = 'out';
            movementSource = 'department_issue';
        }
        const beforeFixed = fromStockUnits(beforeUnits).toFixed(2);
        const afterFixed = fromStockUnits(afterUnits).toFixed(2);
        const deltaFixed = fromStockUnits(deltaUnits).toFixed(2);
        const unitCostFixed = roundCurrency(Number(product.unit_cost)).toFixed(2);
        await client.query(`UPDATE inventory_products
       SET current_stock = $1,
           updated_by = $2,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`, [afterFixed, actorUser.id, input.productId, property.id]);
        const movIns = await client.query(`INSERT INTO stock_movements (
         property_id, product_id, movement_type, movement_source,
         quantity, quantity_delta, stock_before, stock_after,
         unit_cost, reason, reference_note,
         source_key, request_fingerprint, recorded_by
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10, $11,
         $12, $13, $14
       )
       RETURNING id`, [
            property.id,
            input.productId,
            movementType,
            movementSource,
            qtyFixed,
            deltaFixed,
            beforeFixed,
            afterFixed,
            unitCostFixed,
            input.reason,
            input.referenceNote,
            sourceKey,
            normalizedFingerprint,
            actorUser.id,
        ]);
        const id = movIns.rows[0].id;
        await recordAuditEvent({
            propertyId: property.id,
            actorUserId: actorUser.id,
            entityType: 'inventory_item',
            entityId: input.productId,
            action: `stock_${input.operation}`,
            summary: `Adjusted stock for "${product.name}" (${product.sku}): ${beforeFixed} → ${afterFixed} ${product.unit} (${deltaUnits >= 0 ? `+${deltaFixed}` : deltaFixed}) • Reason: ${input.reason}`,
            payload: {
                movementId: id,
                operation: input.operation,
                stockBefore: Number(beforeFixed),
                stockAfter: Number(afterFixed),
                quantityDelta: Number(deltaFixed),
                reason: input.reason,
            },
        }, client);
        return { movementId: id, created: true };
    });
    const pool = getPool();
    const [movRes, item] = await Promise.all([
        pool.query(`${STOCK_MOVEMENT_SELECT}
       WHERE sm.property_id = $1 AND sm.id = $2
       LIMIT 1`, [property.id, movementId]),
        getInventoryItemById(property.id, input.productId),
    ]);
    return {
        movement: mapStockMovementRow(movRes.rows[0]),
        item,
        created,
    };
}
export async function listStockMovementsReport(property, filter = {}) {
    const pool = getPool();
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 30));
    const offset = (page - 1) * pageSize;
    const params = [property.id];
    const conditions = ['sm.property_id = $1'];
    if (filter.productId) {
        params.push(filter.productId);
        conditions.push(`sm.product_id = $${params.length}`);
    }
    if (filter.categoryId) {
        params.push(filter.categoryId);
        conditions.push(`ip.category_id = $${params.length}`);
    }
    if (filter.supplierId) {
        params.push(filter.supplierId);
        conditions.push(`(sm.supplier_id = $${params.length} OR ip.supplier_id = $${params.length})`);
    }
    if (filter.movementType && filter.movementType.trim() !== '') {
        const mt = filter.movementType.trim();
        if (!STOCK_MOVEMENT_TYPES.includes(mt)) {
            throw AppError.badRequest(`Invalid movementType filter: "${mt}". Allowed values: ${STOCK_MOVEMENT_TYPES.join(', ')}`);
        }
        params.push(mt);
        conditions.push(`sm.movement_type = $${params.length}`);
    }
    if (filter.movementSource && filter.movementSource.trim() !== '') {
        const ms = filter.movementSource.trim();
        if (!STOCK_MOVEMENT_SOURCES.includes(ms)) {
            throw AppError.badRequest(`Invalid movementSource filter: "${ms}". Allowed values: ${STOCK_MOVEMENT_SOURCES.join(', ')}`);
        }
        params.push(ms);
        conditions.push(`sm.movement_source = $${params.length}`);
    }
    if (filter.dateFrom && filter.dateFrom.trim() !== '') {
        if (!isValidIsoDate(filter.dateFrom.trim())) {
            throw AppError.badRequest('Invalid dateFrom query parameter: expected YYYY-MM-DD');
        }
        params.push(property.timezone, filter.dateFrom.trim());
        conditions.push(`(sm.created_at AT TIME ZONE $${params.length - 1})::date >= $${params.length}::date`);
    }
    if (filter.dateTo && filter.dateTo.trim() !== '') {
        if (!isValidIsoDate(filter.dateTo.trim())) {
            throw AppError.badRequest('Invalid dateTo query parameter: expected YYYY-MM-DD');
        }
        params.push(property.timezone, filter.dateTo.trim());
        conditions.push(`(sm.created_at AT TIME ZONE $${params.length - 1})::date <= $${params.length}::date`);
    }
    if (filter.search && filter.search.trim().length > 0) {
        params.push(`%${filter.search.trim()}%`);
        const idx = params.length;
        conditions.push(`(ip.name ILIKE $${idx} OR ip.sku ILIKE $${idx} OR sm.reason ILIKE $${idx} OR sm.reference_note ILIKE $${idx} OR COALESCE(ir.receipt_number, '') ILIKE $${idx} OR COALESCE(fo.order_reference, '') ILIKE $${idx})`);
    }
    const whereClause = conditions.join(' AND ');
    const summaryRes = await pool.query(`SELECT
       COUNT(*)::int AS total_movements,
       COALESCE(SUM(sm.quantity) FILTER (WHERE sm.quantity_delta > 0), 0) AS total_in_qty,
       COALESCE(SUM(sm.quantity) FILTER (WHERE sm.quantity_delta < 0 AND sm.movement_type <> 'wastage'), 0) AS total_out_qty,
       COALESCE(SUM(sm.quantity) FILTER (WHERE sm.movement_type = 'wastage'), 0) AS total_wastage_qty,
       COALESCE(SUM(sm.quantity_delta), 0) AS net_qty_delta,
       COUNT(*) FILTER (WHERE sm.movement_source = 'purchase_receipt')::int AS receipts_movement_count,
       COUNT(*) FILTER (WHERE sm.movement_source = 'order_consumption')::int AS order_consumption_count,
       COUNT(*) FILTER (WHERE sm.movement_source IN ('manual_adjustment', 'wastage', 'department_issue'))::int AS manual_adjustment_count
     FROM stock_movements sm
     JOIN inventory_products ip ON ip.id = sm.product_id AND ip.property_id = sm.property_id
     LEFT JOIN inventory_receipts ir ON ir.id = sm.receipt_id AND ir.property_id = sm.property_id
     LEFT JOIN food_orders fo ON fo.id = sm.food_order_id AND fo.property_id = sm.property_id
     WHERE ${whereClause}`, params);
    const sRow = summaryRes.rows[0] ?? {};
    const total = Number(sRow.total_movements ?? 0);
    const listParams = [...params, pageSize, offset];
    const rowsRes = await pool.query(`${STOCK_MOVEMENT_SELECT}
     WHERE ${whereClause}
     ORDER BY sm.created_at DESC, sm.id DESC
     LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams);
    return {
        items: rowsRes.rows.map(mapStockMovementRow),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        summary: {
            totalMovements: total,
            totalInQuantity: fromStockUnits(toStockUnits(sRow.total_in_qty ?? 0)),
            totalOutQuantity: fromStockUnits(toStockUnits(sRow.total_out_qty ?? 0)),
            totalWastageQuantity: fromStockUnits(toStockUnits(sRow.total_wastage_qty ?? 0)),
            netQuantityDelta: fromStockUnits(toStockUnits(sRow.net_qty_delta ?? 0)),
            receiptsMovementCount: Number(sRow.receipts_movement_count ?? 0),
            orderConsumptionCount: Number(sRow.order_consumption_count ?? 0),
            manualAdjustmentCount: Number(sRow.manual_adjustment_count ?? 0),
        },
    };
}
export async function listStockMovementsByFoodOrder(propertyId, foodOrderId, db = getPool()) {
    const res = await db.query(`${STOCK_MOVEMENT_SELECT}
     WHERE sm.property_id = $1 AND sm.food_order_id = $2
     ORDER BY sm.created_at ASC, ip.name ASC`, [propertyId, foodOrderId]);
    return res.rows.map(mapStockMovementRow);
}
