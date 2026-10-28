import type { PoolClient } from 'pg';
import {
  canTransitionFoodOrderStatus,
  DIETARY_TAGS,
  FOOD_BILLING_STATUSES,
  FOOD_ORDER_SOURCES,
  FOOD_ORDER_STATUSES,
  FOOD_ORDER_TYPES,
  getInventoryStockStatus,
  type FoodBillingStatus,
  type FoodOrderSource,
  type FoodOrderStatus,
  type FoodOrderType,
} from '../../../shared/constants.js';
import { getPropertyLocalDate, isValidIsoDate } from '../../../shared/dates.js';
import { calculateFoodOrderTotals, roundCurrency } from '../../../shared/pricing.js';
import {
  foodCategoryCreateSchema,
  foodCategoryUpdateSchema,
  foodMenuItemCreateSchema,
  foodMenuItemUpdateSchema,
  foodOrderCancelSchema,
  foodOrderCreateSchema,
  foodOrderPostToInvoiceSchema,
  foodOrderReverseChargeSchema,
  foodOrderStatusUpdateSchema,
  foodOrderUpdateSchema,
  menuItemRecipeUpdateSchema,
} from '../../../shared/schemas.js';
import type {
  DashboardFoodOrdersSummary,
  EligibleRoomServiceStay,
  FoodCategory,
  FoodMenuItem,
  FoodMenuItemIngredient,
  FoodOrderDetail,
  FoodOrderItem,
  FoodOrderListItem,
  FoodOrdersListResponse,
  FoodOrdersSummaryMetrics,
  FoodOrderStatusHistoryEntry,
  InvoiceDetail,
  Property,
  UserSummary,
} from '../../../shared/types.js';
import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { AppError } from '../../errors.js';
import { recordAuditEvent } from '../../services/audit.service.js';
import {
  fromStockUnits,
  listStockMovementsByFoodOrder,
  toStockUnits,
} from '../inventory/inventory.service.js';
import {
  ensureAndSyncReservationInvoiceInTx,
  getInvoiceDetail,
  recomputeAndPersistInvoiceInTx,
} from '../invoices/invoices.service.js';

function mapFoodCategoryRow(row: Record<string, any>): FoodCategory {
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
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapMenuItemIngredientRow(row: Record<string, any>): FoodMenuItemIngredient {
  const quantityRequired = fromStockUnits(toStockUnits(row.quantity_required ?? 0));
  const currentStock = fromStockUnits(toStockUnits(row.current_stock ?? 0));
  const reorderLevel = fromStockUnits(toStockUnits(row.reorder_level ?? 0));
  const productIsActive = Boolean(row.product_is_active);
  const stockStatus = getInventoryStockStatus(currentStock, reorderLevel);

  return {
    id: row.id,
    menuItemId: row.menu_item_id,
    productId: row.product_id,
    productSku: row.product_sku ?? '',
    productName: row.product_name ?? '',
    unit: row.product_unit ?? 'pcs',
    quantityRequired,
    currentStock,
    reorderLevel,
    productIsActive,
    stockStatus,
    isInsufficientForOneUnit:
      !productIsActive || toStockUnits(currentStock) < toStockUnits(quantityRequired),
  };
}

function mapFoodMenuItemRow(
  row: Record<string, any>,
  ingredients: FoodMenuItemIngredient[] = []
): FoodMenuItem {
  const hasLowOrOutIngredient = ingredients.some(
    (ing) =>
      ing.isInsufficientForOneUnit ||
      ing.stockStatus === 'low_stock' ||
      ing.stockStatus === 'out_of_stock'
  );

  return {
    id: row.id,
    propertyId: row.property_id,
    categoryId: row.category_id,
    categoryName: row.category_name ?? '',
    categoryIsActive: row.category_is_active !== undefined ? Boolean(row.category_is_active) : true,
    sku: row.sku,
    name: row.name,
    description: row.description ?? '',
    price: Number(row.price),
    dietaryTag: row.dietary_tag,
    prepTimeMinutes:
      row.prep_time_minutes !== null && row.prep_time_minutes !== undefined
        ? Number(row.prep_time_minutes)
        : null,
    isAvailable: Boolean(row.is_available),
    isActive: Boolean(row.is_active),
    displayOrder: Number(row.display_order ?? 0),
    ingredientCount: ingredients.length,
    hasLowOrOutIngredient,
    ingredients,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapFoodOrderItemRow(row: Record<string, any>): FoodOrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    menuItemId: row.menu_item_id,
    itemNameSnapshot: row.item_name_snapshot,
    categoryNameSnapshot: row.category_name_snapshot ?? '',
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    lineSubtotal: Number(row.line_subtotal),
    specialInstructions: row.special_instructions ?? '',
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapFoodOrderHistoryRow(row: Record<string, any>): FoodOrderStatusHistoryEntry {
  return {
    id: row.id,
    orderId: row.order_id,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status,
    note: row.note ?? '',
    changedBy: row.changed_by ?? null,
    changedByName: row.changed_by_name ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const FOOD_ORDER_SELECT = `
  SELECT o.*,
         r.booking_reference,
         r.status AS reservation_status,
         rm.room_number,
         g.first_name AS guest_first_name,
         g.last_name AS guest_last_name,
         inv.invoice_number AS posted_invoice_number,
         inv.status AS posted_invoice_status,
         u_created.full_name AS created_by_name,
         u_prep.full_name AS preparing_by_name,
         u_ready.full_name AS ready_by_name,
         u_served.full_name AS served_by_name,
         u_cancel.full_name AS cancelled_by_name,
         u_posted.full_name AS posted_by_name,
         u_rev.full_name AS reversed_by_name
  FROM food_orders o
  LEFT JOIN reservations r ON r.id = o.reservation_id
  LEFT JOIN rooms rm ON rm.id = o.room_id
  LEFT JOIN guests g ON g.id = o.guest_id
  LEFT JOIN invoices inv ON inv.id = o.posted_invoice_id
  LEFT JOIN users u_created ON u_created.id = o.created_by
  LEFT JOIN users u_prep ON u_prep.id = o.preparing_by
  LEFT JOIN users u_ready ON u_ready.id = o.ready_by
  LEFT JOIN users u_served ON u_served.id = o.served_by
  LEFT JOIN users u_cancel ON u_cancel.id = o.cancelled_by
  LEFT JOIN users u_posted ON u_posted.id = o.posted_by
  LEFT JOIN users u_rev ON u_rev.id = o.reversed_by
`;

function mapFoodOrderRow(
  row: Record<string, any>,
  items: FoodOrderItem[]
): FoodOrderListItem {
  const guestName =
    row.guest_first_name || row.guest_last_name
      ? `${row.guest_first_name ?? ''} ${row.guest_last_name ?? ''}`.trim()
      : null;

  const totalUnits = items.reduce((sum, it) => sum + it.quantity, 0);
  const itemsSummary = items
    .map((it) => `${it.quantity}× ${it.itemNameSnapshot}`)
    .join(', ');

  return {
    id: row.id,
    propertyId: row.property_id,
    orderReference: row.order_reference,
    orderType: row.order_type as FoodOrderType,
    orderSource: (row.order_source ?? 'staff_pos') as FoodOrderSource,
    status: row.status as FoodOrderStatus,
    tableLabel: row.table_label ?? '',
    customerName: row.customer_name ?? '',
    reservationId: row.reservation_id ?? null,
    bookingReference: row.booking_reference ?? null,
    reservationStatus: row.reservation_status ?? null,
    roomId: row.room_id ?? null,
    roomNumber: row.room_number ?? null,
    guestId: row.guest_id ?? null,
    guestName,
    subtotal: Number(row.subtotal),
    taxName: String(row.tax_name ?? 'GST'),
    taxRate: Number(row.tax_rate ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    totalAmount: Number(row.total_amount ?? 0),
    currency: String(row.currency ?? 'INR').trim(),
    notes: row.notes ?? '',
    billingStatus: row.billing_status as FoodBillingStatus,
    postedInvoiceId: row.posted_invoice_id ?? null,
    postedInvoiceNumber: row.posted_invoice_number ?? null,
    postedInvoiceStatus: row.posted_invoice_status ?? null,
    postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
    postedByName: row.posted_by_name ?? null,
    reversedAt: row.reversed_at ? new Date(row.reversed_at).toISOString() : null,
    reversedByName: row.reversed_by_name ?? null,
    reversalReason: row.reversal_reason ?? '',
    placedAt: new Date(row.placed_at).toISOString(),
    preparingAt: row.preparing_at ? new Date(row.preparing_at).toISOString() : null,
    preparingByName: row.preparing_by_name ?? null,
    readyAt: row.ready_at ? new Date(row.ready_at).toISOString() : null,
    readyByName: row.ready_by_name ?? null,
    servedAt: row.served_at ? new Date(row.served_at).toISOString() : null,
    servedByName: row.served_by_name ?? null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    cancelledByName: row.cancelled_by_name ?? null,
    cancelReason: row.cancel_reason ?? '',
    inventoryDeductedAt: row.inventory_deducted_at
      ? new Date(row.inventory_deducted_at).toISOString()
      : null,
    createdByName: row.created_by_name ?? null,
    itemCount: totalUnits,
    itemsSummary,
    items,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function allocateNextFoodOrderReference(
  client: PoolClient,
  property: Property
): Promise<string> {
  await client.query(
    `INSERT INTO property_food_order_counters (property_id, next_number)
     VALUES ($1, 1001)
     ON CONFLICT (property_id) DO NOTHING`,
    [property.id]
  );

  const counterRes = await client.query(
    `SELECT next_number
     FROM property_food_order_counters
     WHERE property_id = $1
     FOR UPDATE`,
    [property.id]
  );

  let nextNum = Math.max(1, Number(counterRes.rows[0]?.next_number ?? 1001));
  const cleanCode =
    property.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'ORD';

  let orderReference = '';
  for (let attempts = 0; attempts < 5000; attempts++) {
    const candidate = `${cleanCode}-FD-${String(nextNum).padStart(4, '0')}`;
    const dupRes = await client.query(
      'SELECT 1 FROM food_orders WHERE property_id = $1 AND order_reference = $2 LIMIT 1',
      [property.id, candidate]
    );
    if (dupRes.rowCount === 0) {
      orderReference = candidate;
      break;
    }
    nextNum += 1;
  }

  if (!orderReference) {
    orderReference = `${cleanCode}-FD-${Date.now()}`;
  }

  await client.query(
    `UPDATE property_food_order_counters
     SET next_number = $2
     WHERE property_id = $1`,
    [property.id, nextNum + 1]
  );

  return orderReference;
}

// ============================================================================
// 1. MENU CATEGORIES
// ============================================================================

export async function listFoodCategories(
  propertyId: string,
  includeInactive = false
): Promise<FoodCategory[]> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT c.*,
            COUNT(m.id)::int AS item_count,
            COUNT(m.id) FILTER (WHERE m.is_active = TRUE)::int AS active_item_count
     FROM food_categories c
     LEFT JOIN food_menu_items m
       ON m.category_id = c.id AND m.property_id = c.property_id
     WHERE c.property_id = $1
       AND ($2::boolean = TRUE OR c.is_active = TRUE)
     GROUP BY c.id
     ORDER BY c.display_order ASC, c.name ASC`,
    [propertyId, includeInactive]
  );
  return res.rows.map(mapFoodCategoryRow);
}

export async function createFoodCategory(
  property: Property,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<FoodCategory> {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden('Administrator role is required to create food categories.');
  }
  const input = foodCategoryCreateSchema.parse(rawInput);

  const categoryId = await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO food_categories (
         property_id, code, name, description, display_order, is_active, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id`,
      [
        property.id,
        input.code,
        input.name,
        input.description,
        input.displayOrder,
        input.isActive,
        actorUser.id,
      ]
    );
    const id = ins.rows[0].id as string;

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_category',
        entityId: id,
        action: 'created',
        summary: `Created food category "${input.name}" (${input.code})`,
      },
      client
    );
    return id;
  });

  const categories = await listFoodCategories(property.id, true);
  return categories.find((c) => c.id === categoryId)!;
}

export async function updateFoodCategory(
  property: Property,
  categoryId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<FoodCategory> {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden('Administrator role is required to update food categories.');
  }
  const input = foodCategoryUpdateSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      'SELECT * FROM food_categories WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [categoryId, property.id]
    );
    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Food category not found');
    }
    const existing = existingRes.rows[0];

    await client.query(
      `UPDATE food_categories
       SET code = $1,
           name = $2,
           description = $3,
           display_order = $4,
           is_active = $5,
           updated_by = $6,
           updated_at = NOW()
       WHERE id = $7 AND property_id = $8`,
      [
        input.code ?? existing.code,
        input.name ?? existing.name,
        input.description ?? existing.description,
        input.displayOrder ?? existing.display_order,
        input.isActive ?? existing.is_active,
        actorUser.id,
        categoryId,
        property.id,
      ]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_category',
        entityId: categoryId,
        action: input.isActive === false ? 'deactivated' : 'updated',
        summary: `Updated food category "${input.name ?? existing.name}"`,
      },
      client
    );
  });

  const categories = await listFoodCategories(property.id, true);
  return categories.find((c) => c.id === categoryId)!;
}

// ============================================================================
// 2. MENU ITEMS
// ============================================================================

export interface ListMenuItemsFilter {
  categoryId?: string;
  includeInactive?: boolean;
  availableOnly?: boolean;
  dietaryTag?: string;
  search?: string;
}

async function fetchIngredientsByMenuItemIds(
  propertyId: string,
  menuItemIds: string[],
  db: Queryable = getPool()
): Promise<Map<string, FoodMenuItemIngredient[]>> {
  const map = new Map<string, FoodMenuItemIngredient[]>();
  if (menuItemIds.length === 0) {
    return map;
  }

  const res = await db.query(
    `SELECT mii.*,
            ip.sku AS product_sku,
            ip.name AS product_name,
            ip.unit AS product_unit,
            ip.current_stock,
            ip.reorder_level,
            ip.is_active AS product_is_active
     FROM food_menu_item_ingredients mii
     JOIN inventory_products ip
       ON ip.id = mii.product_id AND ip.property_id = mii.property_id
     WHERE mii.property_id = $1
       AND mii.menu_item_id = ANY($2::uuid[])
     ORDER BY ip.name ASC`,
    [propertyId, menuItemIds]
  );

  for (const row of res.rows) {
    const mapped = mapMenuItemIngredientRow(row);
    const list = map.get(mapped.menuItemId) ?? [];
    list.push(mapped);
    map.set(mapped.menuItemId, list);
  }

  return map;
}

export async function listFoodMenuItems(
  propertyId: string,
  filter: ListMenuItemsFilter = {}
): Promise<FoodMenuItem[]> {
  const pool = getPool();
  const params: unknown[] = [propertyId];
  const conditions: string[] = ['m.property_id = $1'];

  if (!filter.includeInactive) {
    conditions.push('m.is_active = TRUE AND c.is_active = TRUE');
  }

  if (filter.availableOnly) {
    conditions.push('m.is_available = TRUE AND m.is_active = TRUE AND c.is_active = TRUE');
  }

  if (filter.categoryId) {
    params.push(filter.categoryId);
    conditions.push(`m.category_id = $${params.length}`);
  }

  if (filter.dietaryTag !== undefined && filter.dietaryTag.trim() !== '') {
    const normalizedTag = filter.dietaryTag.trim();
    if (!(DIETARY_TAGS as readonly string[]).includes(normalizedTag)) {
      throw AppError.badRequest(
        `Invalid dietaryTag filter: "${normalizedTag}". Allowed values: ${DIETARY_TAGS.join(', ')}`
      );
    }
    params.push(normalizedTag);
    conditions.push(`m.dietary_tag = $${params.length}`);
  }

  if (filter.search && filter.search.trim().length > 0) {
    params.push(`%${filter.search.trim()}%`);
    const idx = params.length;
    conditions.push(
      `(m.name ILIKE $${idx} OR m.sku ILIKE $${idx} OR m.description ILIKE $${idx} OR c.name ILIKE $${idx})`
    );
  }

  const res = await pool.query(
    `SELECT m.*,
            c.name AS category_name,
            c.is_active AS category_is_active
     FROM food_menu_items m
     JOIN food_categories c
       ON c.id = m.category_id AND c.property_id = m.property_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.display_order ASC, m.display_order ASC, m.name ASC`,
    params
  );

  const ids = res.rows.map((r) => r.id as string);
  const ingredientsByItem = await fetchIngredientsByMenuItemIds(propertyId, ids, pool);

  return res.rows.map((row) =>
    mapFoodMenuItemRow(row, ingredientsByItem.get(row.id as string) ?? [])
  );
}

export async function getFoodMenuItemById(
  propertyId: string,
  itemId: string,
  db: Queryable = getPool()
): Promise<FoodMenuItem> {
  const res = await db.query(
    `SELECT m.*,
            c.name AS category_name,
            c.is_active AS category_is_active
     FROM food_menu_items m
     JOIN food_categories c
       ON c.id = m.category_id AND c.property_id = m.property_id
     WHERE m.id = $1 AND m.property_id = $2
     LIMIT 1`,
    [itemId, propertyId]
  );
  if (res.rowCount === 0) {
    throw AppError.notFound('Menu item not found');
  }
  const ingredientsByItem = await fetchIngredientsByMenuItemIds(propertyId, [itemId], db);
  return mapFoodMenuItemRow(res.rows[0], ingredientsByItem.get(itemId) ?? []);
}

export async function listMenuItemIngredients(
  propertyId: string,
  itemId: string
): Promise<FoodMenuItemIngredient[]> {
  const item = await getFoodMenuItemById(propertyId, itemId);
  return item.ingredients ?? [];
}

export async function updateMenuItemIngredients(
  property: Property,
  itemId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<FoodMenuItem> {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden(
      'Administrator role is required to configure menu item ingredient recipes.'
    );
  }
  const input = menuItemRecipeUpdateSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const itemRes = await client.query(
      'SELECT id, name, sku FROM food_menu_items WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [itemId, property.id]
    );
    if (itemRes.rowCount === 0) {
      throw AppError.notFound('Menu item not found');
    }
    const menuItem = itemRes.rows[0];

    if (input.ingredients.length > 0) {
      const productIds = input.ingredients.map((ing) => ing.productId).sort();
      const prodRes = await client.query(
        `SELECT id, name, sku, is_active
         FROM inventory_products
         WHERE property_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id ASC
         FOR SHARE`,
        [property.id, productIds]
      );

      if (prodRes.rowCount !== productIds.length) {
        throw AppError.badRequest(
          'One or more selected recipe ingredients do not exist in this property.'
        );
      }

      for (const pRow of prodRes.rows) {
        if (!pRow.is_active) {
          throw AppError.conflict(
            `Cannot map inactive inventory ingredient "${pRow.name}" (${pRow.sku}) to a menu recipe.`
          );
        }
      }
    }

    await client.query(
      'DELETE FROM food_menu_item_ingredients WHERE property_id = $1 AND menu_item_id = $2',
      [property.id, itemId]
    );

    for (const ing of input.ingredients) {
      const qtyFixed = fromStockUnits(toStockUnits(ing.quantityRequired)).toFixed(2);
      await client.query(
        `INSERT INTO food_menu_item_ingredients (
           property_id, menu_item_id, product_id, quantity_required,
           created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $5)`,
        [property.id, itemId, ing.productId, qtyFixed, actorUser.id]
      );
    }

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_menu_item',
        entityId: itemId,
        action: 'recipe_updated',
        summary: `Updated ingredient recipe for "${menuItem.name}" (${menuItem.sku}): ${input.ingredients.length} ingredient(s)`,
        payload: {
          ingredientCount: input.ingredients.length,
          ingredients: input.ingredients.map((i) => ({
            productId: i.productId,
            quantityRequired: fromStockUnits(toStockUnits(i.quantityRequired)),
          })),
        },
      },
      client
    );
  });

  return getFoodMenuItemById(property.id, itemId);
}

export async function createFoodMenuItem(
  property: Property,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<FoodMenuItem> {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden('Administrator role is required to create menu items.');
  }
  const input = foodMenuItemCreateSchema.parse(rawInput);

  const itemId = await withTransaction(async (client) => {
    const catCheck = await client.query(
      'SELECT id, name FROM food_categories WHERE id = $1 AND property_id = $2 LIMIT 1',
      [input.categoryId, property.id]
    );
    if (catCheck.rowCount === 0) {
      throw AppError.badRequest(
        'Selected food category does not exist in this property.'
      );
    }

    const ins = await client.query(
      `INSERT INTO food_menu_items (
         property_id, category_id, sku, name, description,
         price, dietary_tag, prep_time_minutes, is_available, is_active,
         display_order, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       RETURNING id`,
      [
        property.id,
        input.categoryId,
        input.sku,
        input.name,
        input.description,
        input.price.toFixed(2),
        input.dietaryTag,
        input.prepTimeMinutes,
        input.isAvailable,
        input.isActive,
        input.displayOrder,
        actorUser.id,
      ]
    );
    const id = ins.rows[0].id as string;

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_menu_item',
        entityId: id,
        action: 'created',
        summary: `Created menu item "${input.name}" (${input.sku}) at ${input.price.toFixed(2)}`,
      },
      client
    );
    return id;
  });

  return getFoodMenuItemById(property.id, itemId);
}

export async function updateFoodMenuItem(
  property: Property,
  itemId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<FoodMenuItem> {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden('Administrator role is required to update menu items.');
  }
  const input = foodMenuItemUpdateSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      'SELECT * FROM food_menu_items WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [itemId, property.id]
    );
    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Menu item not found');
    }
    const existing = existingRes.rows[0];

    const nextCategoryId = input.categoryId ?? existing.category_id;
    if (input.categoryId && input.categoryId !== existing.category_id) {
      const catCheck = await client.query(
        'SELECT id FROM food_categories WHERE id = $1 AND property_id = $2 LIMIT 1',
        [nextCategoryId, property.id]
      );
      if (catCheck.rowCount === 0) {
        throw AppError.badRequest(
          'Selected food category does not exist in this property.'
        );
      }
    }

    const nextPrice =
      input.price !== undefined ? input.price : Number(existing.price);

    await client.query(
      `UPDATE food_menu_items
       SET category_id = $1,
           sku = $2,
           name = $3,
           description = $4,
           price = $5,
           dietary_tag = $6,
           prep_time_minutes = $7,
           is_available = $8,
           is_active = $9,
           display_order = $10,
           updated_by = $11,
           updated_at = NOW()
       WHERE id = $12 AND property_id = $13`,
      [
        nextCategoryId,
        input.sku ?? existing.sku,
        input.name ?? existing.name,
        input.description ?? existing.description,
        nextPrice.toFixed(2),
        input.dietaryTag ?? existing.dietary_tag,
        input.prepTimeMinutes !== undefined
          ? input.prepTimeMinutes
          : existing.prep_time_minutes,
        input.isAvailable ?? existing.is_available,
        input.isActive ?? existing.is_active,
        input.displayOrder ?? existing.display_order,
        actorUser.id,
        itemId,
        property.id,
      ]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_menu_item',
        entityId: itemId,
        action: input.isActive === false ? 'deactivated' : 'updated',
        summary: `Updated menu item "${input.name ?? existing.name}"`,
        payload: {
          previousPrice: Number(existing.price),
          price: nextPrice,
          isActive: input.isActive ?? existing.is_active,
          isAvailable: input.isAvailable ?? existing.is_available,
        },
      },
      client
    );
  });

  return getFoodMenuItemById(property.id, itemId);
}

// ============================================================================
// 3. ELIGIBLE IN-HOUSE ROOM-SERVICE STAYS
// ============================================================================

export async function listEligibleRoomServiceStays(
  propertyId: string
): Promise<EligibleRoomServiceStay[]> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT r.id AS reservation_id,
            r.booking_reference,
            r.room_id,
            rm.room_number,
            rt.name AS room_type_name,
            r.guest_id,
            g.first_name,
            g.last_name,
            r.arrival_date::text AS arrival_date,
            r.departure_date::text AS departure_date,
            inv.id AS active_invoice_id,
            inv.invoice_number AS active_invoice_number,
            inv.status AS active_invoice_status
     FROM reservations r
     JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = r.property_id
     JOIN room_types rt ON rt.id = r.room_type_id
     JOIN guests g ON g.id = r.guest_id
     LEFT JOIN invoices inv
       ON inv.property_id = r.property_id
      AND inv.reservation_id = r.id
      AND inv.status != 'void'
     WHERE r.property_id = $1
       AND r.status = 'checked_in'
     ORDER BY rm.room_number ASC, r.booking_reference ASC`,
    [propertyId]
  );

  return res.rows.map((row) => ({
    reservationId: row.reservation_id,
    bookingReference: row.booking_reference,
    roomId: row.room_id,
    roomNumber: row.room_number,
    roomTypeName: row.room_type_name,
    guestId: row.guest_id,
    guestName: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
    arrivalDate: String(row.arrival_date).slice(0, 10),
    departureDate: String(row.departure_date).slice(0, 10),
    activeInvoiceId: row.active_invoice_id ?? null,
    activeInvoiceNumber: row.active_invoice_number ?? null,
    activeInvoiceStatus: row.active_invoice_status ?? null,
  }));
}

// ============================================================================
// 4. FOOD ORDERS, KITCHEN WORKFLOW & FOLIO POSTING / REVERSAL
// ============================================================================

export async function resolveAndValidateOrderItemsInTx(
  client: PoolClient,
  propertyId: string,
  requestedItems: ReadonlyArray<{
    menuItemId: string;
    quantity: number;
    specialInstructions: string;
  }>
): Promise<
  Array<{
    menuItemId: string;
    itemNameSnapshot: string;
    categoryNameSnapshot: string;
    quantity: number;
    unitPrice: number;
    specialInstructions: string;
  }>
> {
  const uniqueIds = Array.from(new Set(requestedItems.map((i) => i.menuItemId)));
  const menuRes = await client.query(
    `SELECT m.*,
            c.name AS category_name,
            c.is_active AS category_is_active
     FROM food_menu_items m
     JOIN food_categories c
       ON c.id = m.category_id AND c.property_id = m.property_id
     WHERE m.property_id = $1
       AND m.id = ANY($2::uuid[])`,
    [propertyId, uniqueIds]
  );

  const menuMap = new Map<string, Record<string, any>>();
  for (const row of menuRes.rows) {
    menuMap.set(String(row.id), row);
  }

  return requestedItems.map((reqItem) => {
    const mi = menuMap.get(reqItem.menuItemId);
    if (!mi) {
      throw AppError.notFound(
        'One or more selected menu items do not exist in this property.'
      );
    }
    if (!mi.is_active || !mi.category_is_active) {
      throw AppError.badRequest(
        `Menu item "${mi.name}" is inactive and cannot be ordered.`
      );
    }
    if (!mi.is_available) {
      throw AppError.badRequest(
        `Menu item "${mi.name}" is currently marked unavailable.`
      );
    }

    return {
      menuItemId: String(mi.id),
      itemNameSnapshot: String(mi.name),
      categoryNameSnapshot: String(mi.category_name),
      quantity: reqItem.quantity,
      unitPrice: Number(mi.price),
      specialInstructions: reqItem.specialInstructions,
    };
  });
}

export interface ListFoodOrdersFilter {
  status?: string;
  orderType?: string;
  orderSource?: string;
  billingStatus?: string;
  reservationId?: string;
  dateFrom?: string;
  dateTo?: string;
  kitchenActiveOnly?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listFoodOrders(
  property: Property,
  filter: ListFoodOrdersFilter = {}
): Promise<FoodOrdersListResponse> {
  const pool = getPool();
  const params: unknown[] = [property.id];
  const conditions: string[] = ['o.property_id = $1'];

  if (filter.kitchenActiveOnly) {
    conditions.push(`o.status IN ('pending', 'preparing', 'ready')`);
  }

  if (filter.status) {
    if (!(FOOD_ORDER_STATUSES as readonly string[]).includes(filter.status)) {
      throw AppError.badRequest(`Invalid order status filter: "${filter.status}"`);
    }
    params.push(filter.status);
    conditions.push(`o.status = $${params.length}`);
  }

  if (filter.orderType) {
    if (!(FOOD_ORDER_TYPES as readonly string[]).includes(filter.orderType)) {
      throw AppError.badRequest(`Invalid order type filter: "${filter.orderType}"`);
    }
    params.push(filter.orderType);
    conditions.push(`o.order_type = $${params.length}`);
  }

  if (filter.orderSource) {
    if (!(FOOD_ORDER_SOURCES as readonly string[]).includes(filter.orderSource)) {
      throw AppError.badRequest(`Invalid order source filter: "${filter.orderSource}"`);
    }
    params.push(filter.orderSource);
    conditions.push(`o.order_source = $${params.length}`);
  }

  if (filter.billingStatus) {
    if (!(FOOD_BILLING_STATUSES as readonly string[]).includes(filter.billingStatus)) {
      throw AppError.badRequest(`Invalid billing status filter: "${filter.billingStatus}"`);
    }
    params.push(filter.billingStatus);
    conditions.push(`o.billing_status = $${params.length}`);
  }

  if (filter.reservationId) {
    params.push(filter.reservationId);
    conditions.push(`o.reservation_id = $${params.length}`);
  }

  if (filter.dateFrom) {
    if (!isValidIsoDate(filter.dateFrom)) {
      throw AppError.badRequest('Invalid dateFrom (must be YYYY-MM-DD)');
    }
    params.push(filter.dateFrom, property.timezone);
    conditions.push(
      `(o.placed_at AT TIME ZONE $${params.length})::date >= $${params.length - 1}::date`
    );
  }

  if (filter.dateTo) {
    if (!isValidIsoDate(filter.dateTo)) {
      throw AppError.badRequest('Invalid dateTo (must be YYYY-MM-DD)');
    }
    params.push(filter.dateTo, property.timezone);
    conditions.push(
      `(o.placed_at AT TIME ZONE $${params.length})::date <= $${params.length - 1}::date`
    );
  }

  if (filter.search && filter.search.trim().length > 0) {
    params.push(`%${filter.search.trim()}%`);
    const idx = params.length;
    conditions.push(
      `(o.order_reference ILIKE $${idx}
        OR o.table_label ILIKE $${idx}
        OR o.customer_name ILIKE $${idx}
        OR COALESCE(r.booking_reference, '') ILIKE $${idx}
        OR COALESCE(rm.room_number, '') ILIKE $${idx}
        OR COALESCE(g.first_name || ' ' || g.last_name, '') ILIKE $${idx})`
    );
  }

  const rawPage = filter.page ?? 1;
  const rawPageSize = filter.pageSize ?? 30;
  if (!Number.isSafeInteger(rawPage) || rawPage < 1 || rawPage > 100000) {
    throw AppError.badRequest('Invalid page: must be a positive integer between 1 and 100000');
  }
  if (!Number.isSafeInteger(rawPageSize) || rawPageSize < 1 || rawPageSize > 100) {
    throw AppError.badRequest('Invalid pageSize: must be a positive integer between 1 and 100');
  }
  const page = rawPage;
  const pageSize = rawPageSize;
  const offset = (page - 1) * pageSize;

  const whereSql = conditions.join(' AND ');
  const propToday = getPropertyLocalDate(property.timezone);
  const orderBySql =
    filter.status === 'served'
      ? 'COALESCE(o.served_at, o.placed_at) DESC, o.placed_at DESC, o.created_at DESC'
      : filter.status === 'cancelled'
        ? 'COALESCE(o.cancelled_at, o.placed_at) DESC, o.placed_at DESC, o.created_at DESC'
        : 'o.placed_at DESC, o.created_at DESC';

  const [countRes, ordersRes, summaryRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM food_orders o
       LEFT JOIN reservations r ON r.id = o.reservation_id
       LEFT JOIN rooms rm ON rm.id = o.room_id
       LEFT JOIN guests g ON g.id = o.guest_id
       WHERE ${whereSql}`,
      params
    ),
    pool.query(
      `${FOOD_ORDER_SELECT}
       WHERE ${whereSql}
       ORDER BY ${orderBySql}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
         COUNT(*) FILTER (WHERE status = 'preparing')::int AS preparing_count,
         COUNT(*) FILTER (WHERE status = 'ready')::int AS ready_count,
         COUNT(*) FILTER (
           WHERE status = 'served'
             AND (served_at AT TIME ZONE $2)::date = $3::date
         )::int AS served_today_count,
         COUNT(*) FILTER (
           WHERE status = 'cancelled'
             AND (cancelled_at AT TIME ZONE $2)::date = $3::date
         )::int AS cancelled_today_count,
         COUNT(*) FILTER (
           WHERE order_type = 'room_service'
             AND status != 'cancelled'
             AND billing_status = 'unbilled'
         )::int AS unbilled_rs_count,
         COALESCE(
           SUM(total_amount) FILTER (
             WHERE order_type = 'room_service'
               AND status != 'cancelled'
               AND billing_status = 'unbilled'
           ),
           0
         ) AS unbilled_rs_amount
       FROM food_orders
       WHERE property_id = $1`,
      [property.id, property.timezone, propToday]
    ),
  ]);

  const orderIds = ordersRes.rows.map((r) => String(r.id));
  const itemsByOrder = new Map<string, FoodOrderItem[]>();

  if (orderIds.length > 0) {
    const itemsRes = await pool.query(
      `SELECT *
       FROM food_order_items
       WHERE order_id = ANY($1::uuid[])
       ORDER BY sort_order ASC, created_at ASC`,
      [orderIds]
    );
    for (const row of itemsRes.rows) {
      const oid = String(row.order_id);
      const list = itemsByOrder.get(oid) ?? [];
      list.push(mapFoodOrderItemRow(row));
      itemsByOrder.set(oid, list);
    }
  }

  const total = Number(countRes.rows[0]?.total ?? 0);
  const sRow = summaryRes.rows[0] ?? {};
  const summary: FoodOrdersSummaryMetrics = {
    pendingCount: Number(sRow.pending_count ?? 0),
    preparingCount: Number(sRow.preparing_count ?? 0),
    readyCount: Number(sRow.ready_count ?? 0),
    servedTodayCount: Number(sRow.served_today_count ?? 0),
    cancelledTodayCount: Number(sRow.cancelled_today_count ?? 0),
    unbilledRoomServiceCount: Number(sRow.unbilled_rs_count ?? 0),
    unbilledRoomServiceAmount: Number(sRow.unbilled_rs_amount ?? 0),
    currency: property.currency,
  };

  return {
    items: ordersRes.rows.map((row) =>
      mapFoodOrderRow(row, itemsByOrder.get(String(row.id)) ?? [])
    ),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    summary,
  };
}

export async function getDashboardFoodOrdersSnapshot(
  propertyId: string
): Promise<{
  foodOrdersSummary: DashboardFoodOrdersSummary;
  activeFoodOrders: FoodOrderListItem[];
}> {
  const pool = getPool();
  const [summaryRes, activeRes] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
         COUNT(*) FILTER (WHERE status = 'preparing')::int AS preparing_count,
         COUNT(*) FILTER (WHERE status = 'ready')::int AS ready_count,
         COUNT(*) FILTER (
           WHERE status IN ('pending', 'preparing', 'ready')
             AND order_source = 'guest_qr'
         )::int AS active_guest_qr_count,
         COUNT(*) FILTER (
           WHERE order_type = 'room_service'
             AND status != 'cancelled'
             AND billing_status = 'unbilled'
         )::int AS unbilled_rs_count
       FROM food_orders
       WHERE property_id = $1`,
      [propertyId]
    ),
    pool.query(
      `${FOOD_ORDER_SELECT}
       WHERE o.property_id = $1
         AND o.status IN ('pending', 'preparing', 'ready')
       ORDER BY
         CASE
           WHEN o.status = 'pending' AND o.order_source = 'guest_qr' THEN 0
           WHEN o.status = 'pending' THEN 1
           WHEN o.status = 'preparing' THEN 2
           ELSE 3
         END ASC,
         o.placed_at DESC
       LIMIT 8`,
      [propertyId]
    ),
  ]);

  const orderIds = activeRes.rows.map((r) => String(r.id));
  const itemsByOrder = new Map<string, FoodOrderItem[]>();
  if (orderIds.length > 0) {
    const itemsRes = await pool.query(
      `SELECT *
       FROM food_order_items
       WHERE order_id = ANY($1::uuid[])
       ORDER BY sort_order ASC, created_at ASC`,
      [orderIds]
    );
    for (const row of itemsRes.rows) {
      const oid = String(row.order_id);
      const list = itemsByOrder.get(oid) ?? [];
      list.push(mapFoodOrderItemRow(row));
      itemsByOrder.set(oid, list);
    }
  }

  const sRow = summaryRes.rows[0] ?? {};
  return {
    foodOrdersSummary: {
      pendingCount: Number(sRow.pending_count ?? 0),
      preparingCount: Number(sRow.preparing_count ?? 0),
      readyCount: Number(sRow.ready_count ?? 0),
      activeGuestQrCount: Number(sRow.active_guest_qr_count ?? 0),
      unbilledRoomServiceCount: Number(sRow.unbilled_rs_count ?? 0),
    },
    activeFoodOrders: activeRes.rows.map((row) =>
      mapFoodOrderRow(row, itemsByOrder.get(String(row.id)) ?? [])
    ),
  };
}

export async function getFoodOrderDetail(
  propertyId: string,
  orderId: string,
  db: Queryable = getPool()
): Promise<FoodOrderDetail> {
  const orderRes = await db.query(
    `${FOOD_ORDER_SELECT}
     WHERE o.id = $1 AND o.property_id = $2
     LIMIT 1`,
    [orderId, propertyId]
  );

  if (orderRes.rowCount === 0) {
    throw AppError.notFound('Food order not found');
  }

  const [itemsRes, historyRes, stockMovements] = await Promise.all([
    db.query(
      `SELECT *
       FROM food_order_items
       WHERE order_id = $1
       ORDER BY sort_order ASC, created_at ASC`,
      [orderId]
    ),
    db.query(
      `SELECT h.*, u.full_name AS changed_by_name
       FROM food_order_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.order_id = $1 AND h.property_id = $2
       ORDER BY h.created_at ASC`,
      [orderId, propertyId]
    ),
    listStockMovementsByFoodOrder(propertyId, orderId, db),
  ]);

  const base = mapFoodOrderRow(
    orderRes.rows[0],
    itemsRes.rows.map(mapFoodOrderItemRow)
  );

  return {
    ...base,
    statusHistory: historyRes.rows.map(mapFoodOrderHistoryRow),
    stockMovements,
  };
}

interface CanonicalFoodOrderPayload {
  orderType: FoodOrderType;
  reservationId: string | null;
  roomId: string | null;
  guestId: string | null;
  tableLabel: string;
  customerName: string;
  notes: string;
  items: Array<{
    menuItemId: string;
    quantity: number;
    specialInstructions: string;
  }>;
}

function normalizeCanonicalOrderItems(
  items: ReadonlyArray<{
    menuItemId: string;
    quantity: number;
    specialInstructions?: string | null;
  }>
): CanonicalFoodOrderPayload['items'] {
  return items
    .map((item) => ({
      menuItemId: String(item.menuItemId).trim().toLowerCase(),
      quantity: Math.trunc(Number(item.quantity)),
      specialInstructions: String(item.specialInstructions ?? '').trim(),
    }))
    .sort((a, b) => {
      if (a.menuItemId !== b.menuItemId) return a.menuItemId.localeCompare(b.menuItemId);
      if (a.specialInstructions !== b.specialInstructions) {
        return a.specialInstructions.localeCompare(b.specialInstructions);
      }
      return a.quantity - b.quantity;
    });
}

function areCanonicalItemListsEqual(
  a: CanonicalFoodOrderPayload['items'],
  b: CanonicalFoodOrderPayload['items']
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].menuItemId !== b[i].menuItemId ||
      a[i].quantity !== b[i].quantity ||
      a[i].specialInstructions !== b[i].specialInstructions
    ) {
      return false;
    }
  }
  return true;
}
function isEquivalentIdempotentOrderPayload(
  incoming: {
    orderType: FoodOrderType;
    reservationId: string | null;
    roomId: string | null;
    guestId: string | null;
    tableLabel: string;
    customerName: string;
    notes: string;
    items: ReadonlyArray<{
      menuItemId: string;
      quantity: number;
      specialInstructions?: string;
    }>;
  },
  existingRow: Record<string, any>,
  existingItems: ReadonlyArray<Record<string, any>>,
  storedRequestPayload: CanonicalFoodOrderPayload | null
): boolean {
  const incomingCanonicalItems = normalizeCanonicalOrderItems(incoming.items);
  const incomingTableLabel =
    incoming.orderType === 'room_service' ? '' : incoming.tableLabel.trim();
  const incomingReservationId =
    incoming.orderType === 'room_service'
      ? (incoming.reservationId?.trim().toLowerCase() ?? null)
      : null;
  const incomingNotes = incoming.notes.trim();
  const incomingCustomerName = incoming.customerName.trim();

  if (storedRequestPayload) {
    const storedCanonicalItems = normalizeCanonicalOrderItems(
      storedRequestPayload.items ?? []
    );
    return (
      incoming.orderType === storedRequestPayload.orderType &&
      incomingReservationId ===
        (storedRequestPayload.reservationId?.toLowerCase() ?? null) &&
      (incoming.roomId?.toLowerCase() ?? null) ===
        (storedRequestPayload.roomId?.toLowerCase() ?? null) &&
      (incoming.guestId?.toLowerCase() ?? null) ===
        (storedRequestPayload.guestId?.toLowerCase() ?? null) &&
      incomingTableLabel === storedRequestPayload.tableLabel &&
      incomingCustomerName === storedRequestPayload.customerName &&
      incomingNotes === storedRequestPayload.notes &&
      areCanonicalItemListsEqual(incomingCanonicalItems, storedCanonicalItems)
    );
  }

  const existingOrderType = String(existingRow.order_type) as FoodOrderType;
  if (incoming.orderType !== existingOrderType) return false;

  const existingReservationId = existingRow.reservation_id
    ? String(existingRow.reservation_id).trim().toLowerCase()
    : null;
  if (incomingReservationId !== existingReservationId) return false;

  if (incoming.roomId) {
    const existingRoomId = existingRow.room_id
      ? String(existingRow.room_id).trim().toLowerCase()
      : null;
    if (incoming.roomId.trim().toLowerCase() !== existingRoomId) return false;
  }

  if (incoming.guestId) {
    const existingGuestId = existingRow.guest_id
      ? String(existingRow.guest_id).trim().toLowerCase()
      : null;
    if (incoming.guestId.trim().toLowerCase() !== existingGuestId) return false;
  }

  const existingTableLabel =
    existingOrderType === 'room_service'
      ? ''
      : String(existingRow.table_label ?? '').trim();
  if (incomingTableLabel !== existingTableLabel) return false;

  const existingCustomerName = String(existingRow.customer_name ?? '').trim();
  const existingGuestFullName = String(existingRow.guest_full_name ?? '').trim();
  const expectedCustomerName =
    incoming.orderType === 'room_service' && incomingCustomerName === ''
      ? existingGuestFullName
      : incomingCustomerName;
  if (expectedCustomerName !== existingCustomerName) return false;

  if (incomingNotes !== String(existingRow.notes ?? '').trim()) return false;

  const existingCanonicalItems = normalizeCanonicalOrderItems(
    existingItems.map((it) => ({
      menuItemId: String(it.menu_item_id),
      quantity: Number(it.quantity),
      specialInstructions: String(it.special_instructions ?? ''),
    }))
  );

  return areCanonicalItemListsEqual(
    incomingCanonicalItems,
    existingCanonicalItems
  );
}

export async function createFoodOrder(
  property: Property,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<{ order: FoodOrderDetail; created: boolean }> {
  const input = foodOrderCreateSchema.parse(rawInput);

  const txResult = await withTransaction(async (client) => {
    if (input.idempotencyKey) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
        [property.id, input.idempotencyKey]
      );
      const dupCheck = await client.query(
        `SELECT o.*,
                COALESCE(TRIM(g.first_name || ' ' || g.last_name), '') AS guest_full_name
         FROM food_orders o
         LEFT JOIN guests g ON g.id = o.guest_id AND g.property_id = o.property_id
         WHERE o.property_id = $1 AND o.idempotency_key = $2
         LIMIT 1`,
        [property.id, input.idempotencyKey]
      );
      if ((dupCheck.rowCount ?? 0) > 0) {
        const existingOrderRow = dupCheck.rows[0];
        const existingOrderId = String(existingOrderRow.id);

        const [existingItemsRes, auditCreatedRes] = await Promise.all([
          client.query(
            `SELECT menu_item_id, quantity, special_instructions
             FROM food_order_items
             WHERE order_id = $1`,
            [existingOrderId]
          ),
          client.query(
            `SELECT payload
             FROM audit_events
             WHERE property_id = $1
               AND entity_type = 'food_order'
               AND entity_id = $2
               AND action = 'created'
             ORDER BY created_at ASC
             LIMIT 1`,
            [property.id, existingOrderId]
          ),
        ]);

        const storedRequestPayload =
          (auditCreatedRes.rows[0]?.payload?.idempotencyPayload as
            | CanonicalFoodOrderPayload
            | undefined) ?? null;

        const isEquivalent = isEquivalentIdempotentOrderPayload(
          input,
          existingOrderRow,
          existingItemsRes.rows,
          storedRequestPayload
        );
        if (!isEquivalent) {
          throw AppError.conflict(
            'Idempotency key has already been used for a different food order payload.'
          );
        }

        return { orderId: existingOrderId, created: false };
      }
    }

    let reservationId: string | null = null;
    let roomId: string | null = null;
    let guestId: string | null = null;
    let resolvedCustomerName = input.customerName;

    if (input.orderType === 'room_service') {
      const resQuery = await client.query(
        `SELECT r.id, r.property_id, r.status, r.room_id, r.guest_id, r.booking_reference,
                rm.room_number, rm.is_active AS room_is_active,
                g.first_name, g.last_name
         FROM reservations r
         LEFT JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = r.property_id
         JOIN guests g ON g.id = r.guest_id AND g.property_id = r.property_id
         WHERE r.id = $1 AND r.property_id = $2
         FOR UPDATE OF r`,
        [input.reservationId, property.id]
      );

      if (resQuery.rowCount === 0) {
        throw AppError.notFound('Reservation not found in this property');
      }
      const resRow = resQuery.rows[0];

      if (resRow.status !== 'checked_in') {
        throw AppError.badRequest(
          `Room Service orders can only be linked to Checked-In in-house reservations (current status: "${resRow.status}").`
        );
      }
      if (!resRow.room_id || !resRow.room_is_active) {
        throw AppError.badRequest(
          'Checked-in reservation does not have an active room assigned in this property.'
        );
      }
      if (input.roomId && input.roomId !== resRow.room_id) {
        throw AppError.badRequest(
          'Specified room does not match the reservation assigned room.'
        );
      }
      if (input.guestId && input.guestId !== resRow.guest_id) {
        throw AppError.badRequest(
          'Specified guest does not match the reservation guest.'
        );
      }

      reservationId = String(resRow.id);
      roomId = String(resRow.room_id);
      guestId = String(resRow.guest_id);
      if (!resolvedCustomerName) {
        resolvedCustomerName = `${resRow.first_name ?? ''} ${resRow.last_name ?? ''}`.trim();
      }
    }

    const resolvedItems = await resolveAndValidateOrderItemsInTx(
      client,
      property.id,
      input.items
    );

    const totals = calculateFoodOrderTotals(
      resolvedItems.map((it) => ({
        quantity: it.quantity,
        unitPrice: it.unitPrice,
      })),
      property.defaultTaxRate
    );

    const orderReference = await allocateNextFoodOrderReference(client, property);
    const billingStatus: FoodBillingStatus =
      input.orderType === 'room_service' ? 'unbilled' : 'not_applicable';

    const insertOrder = await client.query(
      `INSERT INTO food_orders (
         property_id, order_reference, order_type, status,
         table_label, customer_name, reservation_id, room_id, guest_id,
         subtotal, tax_name, tax_rate, tax_amount, total_amount, currency,
         notes, billing_status, idempotency_key, created_by, updated_by
       ) VALUES (
         $1, $2, $3, 'pending',
         $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $18
       ) RETURNING id`,
      [
        property.id,
        orderReference,
        input.orderType,
        input.orderType === 'room_service' ? '' : input.tableLabel,
        resolvedCustomerName,
        reservationId,
        roomId,
        guestId,
        totals.subtotal.toFixed(2),
        property.taxName,
        totals.taxRate.toFixed(2),
        totals.taxAmount.toFixed(2),
        totals.totalAmount.toFixed(2),
        property.currency,
        input.notes,
        billingStatus,
        input.idempotencyKey ?? null,
        actorUser.id,
      ]
    );
    const newOrderId = insertOrder.rows[0].id as string;

    for (let idx = 0; idx < resolvedItems.length; idx++) {
      const item = resolvedItems[idx];
      await client.query(
        `INSERT INTO food_order_items (
           order_id, menu_item_id, item_name_snapshot, category_name_snapshot,
           quantity, unit_price, line_subtotal, special_instructions, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          newOrderId,
          item.menuItemId,
          item.itemNameSnapshot,
          item.categoryNameSnapshot,
          item.quantity,
          item.unitPrice.toFixed(2),
          totals.lineSubtotals[idx].toFixed(2),
          item.specialInstructions,
          (idx + 1) * 10,
        ]
      );
    }

    await client.query(
      `INSERT INTO food_order_status_history (
         order_id, property_id, from_status, to_status, note, changed_by
       ) VALUES ($1, $2, NULL, 'pending', $3, $4)`,
      [
        newOrderId,
        property.id,
        `Order ${orderReference} placed (${input.orderType.replace('_', ' ')})`,
        actorUser.id,
      ]
    );

    const idempotencyPayload: CanonicalFoodOrderPayload = {
      orderType: input.orderType,
      reservationId:
        input.orderType === 'room_service'
          ? (input.reservationId?.trim().toLowerCase() ?? null)
          : null,
      roomId: input.roomId?.trim().toLowerCase() ?? null,
      guestId: input.guestId?.trim().toLowerCase() ?? null,
      tableLabel: input.orderType === 'room_service' ? '' : input.tableLabel.trim(),
      customerName: input.customerName.trim(),
      notes: input.notes.trim(),
      items: normalizeCanonicalOrderItems(input.items),
    };

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_order',
        entityId: newOrderId,
        action: 'created',
        summary: `Placed ${input.orderType.replace('_', ' ')} order ${orderReference} (${totals.totalAmount.toFixed(2)} ${property.currency})`,
        payload: {
          orderReference,
          orderType: input.orderType,
          reservationId,
          roomId,
          totalAmount: totals.totalAmount,
          idempotencyPayload,
        },
      },
      client
    );

    return { orderId: newOrderId, created: true };
  });

  const order = await getFoodOrderDetail(property.id, txResult.orderId);
  return { order, created: txResult.created };
}

export async function updateFoodOrder(
  property: Property,
  orderId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<FoodOrderDetail> {
  const input = foodOrderUpdateSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      'SELECT * FROM food_orders WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [orderId, property.id]
    );
    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Food order not found');
    }
    const existing = existingRes.rows[0];

    if (existing.status !== 'pending') {
      throw AppError.conflict(
        `Cannot edit order items or details once kitchen status is "${existing.status}". Only Pending orders can be modified.`
      );
    }
    if (
      existing.billing_status === 'posted' ||
      existing.billing_status === 'reversed'
    ) {
      throw AppError.conflict(
        'Cannot modify an order after its charges have been posted to an invoice.'
      );
    }

    const nextTableLabel =
      existing.order_type === 'room_service'
        ? ''
        : input.tableLabel !== undefined
          ? input.tableLabel
          : existing.table_label;

    if (existing.order_type === 'restaurant' && !nextTableLabel) {
      throw AppError.badRequest(
        'Table or dining area label is required for Restaurant / Dine-In orders.'
      );
    }

    let nextSubtotal = Number(existing.subtotal);
    let nextTaxAmount = Number(existing.tax_amount);
    let nextTotalAmount = Number(existing.total_amount);

    if (input.items !== undefined) {
      const resolvedItems = await resolveAndValidateOrderItemsInTx(
        client,
        property.id,
        input.items
      );
      const totals = calculateFoodOrderTotals(
        resolvedItems.map((it) => ({
          quantity: it.quantity,
          unitPrice: it.unitPrice,
        })),
        Number(existing.tax_rate)
      );

      await client.query('DELETE FROM food_order_items WHERE order_id = $1', [orderId]);

      for (let idx = 0; idx < resolvedItems.length; idx++) {
        const item = resolvedItems[idx];
        await client.query(
          `INSERT INTO food_order_items (
             order_id, menu_item_id, item_name_snapshot, category_name_snapshot,
             quantity, unit_price, line_subtotal, special_instructions, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            orderId,
            item.menuItemId,
            item.itemNameSnapshot,
            item.categoryNameSnapshot,
            item.quantity,
            item.unitPrice.toFixed(2),
            totals.lineSubtotals[idx].toFixed(2),
            item.specialInstructions,
            (idx + 1) * 10,
          ]
        );
      }

      nextSubtotal = totals.subtotal;
      nextTaxAmount = totals.taxAmount;
      nextTotalAmount = totals.totalAmount;
    }

    await client.query(
      `UPDATE food_orders
       SET table_label = $1,
           customer_name = $2,
           notes = $3,
           subtotal = $4,
           tax_amount = $5,
           total_amount = $6,
           updated_by = $7,
           updated_at = NOW()
       WHERE id = $8 AND property_id = $9`,
      [
        nextTableLabel,
        input.customerName !== undefined ? input.customerName : existing.customer_name,
        input.notes !== undefined ? input.notes : existing.notes,
        nextSubtotal.toFixed(2),
        nextTaxAmount.toFixed(2),
        nextTotalAmount.toFixed(2),
        actorUser.id,
        orderId,
        property.id,
      ]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_order',
        entityId: orderId,
        action: 'updated',
        summary: `Updated pending food order ${existing.order_reference}`,
      },
      client
    );
  });

  return getFoodOrderDetail(property.id, orderId);
}

/**
 * Deducts mapped recipe ingredients transactionally when a food order begins
 * kitchen preparation (pending -> preparing).
 *
 * Explicit Reversal & Idempotency Policy:
 * 1. Stock is NOT deducted while an order is 'pending' (allowing pre-prep edits or
 *    'pending -> cancelled' cancellations with zero stock impact).
 * 2. When transitioning 'pending -> preparing', all required recipe ingredients are
 *    locked in deterministic UUID order (ORDER BY id ASC FOR UPDATE), verified active
 *    and sufficient, deducted atomically, and recorded as immutable 'order_consumption'
 *    stock_movements with DB-unique source_key 'food_order_consume:<orderId>:<productId>'.
 * 3. Subsequent transitions ('preparing -> ready -> served') never re-deduct stock.
 * 4. Cancelling AFTER prep has started ('preparing/ready -> cancelled') or reversing a
 *    posted financial folio charge NEVER automatically restores physical stock, because
 *    cooked/plated food cannot be returned to raw inventory automatically; any unopened
 *    salvageable items must be recorded via an explicit Admin Controlled Stock Adjustment.
 */
async function deductOrderRecipeIngredientsInTx(
  client: PoolClient,
  property: Property,
  orderRow: Record<string, any>,
  actorUserId: string
): Promise<boolean> {
  if (orderRow.inventory_deducted_at) {
    return false;
  }

  const orderId = String(orderRow.id);
  const orderReference = String(orderRow.order_reference);

  const reqRes = await client.query(
    `SELECT mii.product_id,
            SUM(oi.quantity * mii.quantity_required) AS required_qty
     FROM food_order_items oi
     JOIN food_menu_item_ingredients mii
       ON mii.menu_item_id = oi.menu_item_id
      AND mii.property_id = $2
     WHERE oi.order_id = $1
     GROUP BY mii.product_id
     ORDER BY mii.product_id ASC`,
    [orderId, property.id]
  );

  if (reqRes.rowCount === 0) {
    return false;
  }

  const requiredByProduct = new Map<string, number>();
  const productIds: string[] = [];
  for (const row of reqRes.rows) {
    const pid = String(row.product_id);
    productIds.push(pid);
    requiredByProduct.set(pid, toStockUnits(row.required_qty));
  }

  const prodRes = await client.query(
    `SELECT *
     FROM inventory_products
     WHERE property_id = $1 AND id = ANY($2::uuid[])
     ORDER BY id ASC
     FOR UPDATE`,
    [property.id, productIds]
  );

  if (prodRes.rowCount !== productIds.length) {
    throw AppError.conflict(
      'One or more recipe ingredients mapped to this order could not be resolved in property inventory.'
    );
  }

  const shortages: Array<{
    productId: string;
    sku: string;
    name: string;
    unit: string;
    required: number;
    available: number;
    reason: 'inactive' | 'insufficient_stock';
  }> = [];

  for (const prod of prodRes.rows) {
    const reqUnits = requiredByProduct.get(String(prod.id)) ?? 0;
    const availUnits = toStockUnits(prod.current_stock);
    if (!prod.is_active) {
      shortages.push({
        productId: String(prod.id),
        sku: String(prod.sku),
        name: String(prod.name),
        unit: String(prod.unit),
        required: fromStockUnits(reqUnits),
        available: fromStockUnits(availUnits),
        reason: 'inactive',
      });
    } else if (availUnits < reqUnits) {
      shortages.push({
        productId: String(prod.id),
        sku: String(prod.sku),
        name: String(prod.name),
        unit: String(prod.unit),
        required: fromStockUnits(reqUnits),
        available: fromStockUnits(availUnits),
        reason: 'insufficient_stock',
      });
    }
  }

  if (shortages.length > 0) {
    const first = shortages[0];
    const detailText =
      first.reason === 'inactive'
        ? `Recipe ingredient "${first.name}" (${first.sku}) is inactive.`
        : `Insufficient stock for recipe ingredient "${first.name}" (${first.sku}): required ${first.required.toFixed(2)} ${first.unit}, available ${first.available.toFixed(2)} ${first.unit}.`;

    throw AppError.conflict(
      `Cannot start preparing order ${orderReference}. ${detailText}`,
      {
        reason: 'INSUFFICIENT_STOCK',
        shortages,
      }
    );
  }

  for (const prod of prodRes.rows) {
    const prodId = String(prod.id);
    const reqUnits = requiredByProduct.get(prodId)!;
    const beforeUnits = toStockUnits(prod.current_stock);
    const afterUnits = beforeUnits - reqUnits;

    const reqFixed = fromStockUnits(reqUnits).toFixed(2);
    const deltaFixed = fromStockUnits(-reqUnits).toFixed(2);
    const beforeFixed = fromStockUnits(beforeUnits).toFixed(2);
    const afterFixed = fromStockUnits(afterUnits).toFixed(2);
    const unitCostFixed = roundCurrency(Number(prod.unit_cost ?? 0)).toFixed(2);

    await client.query(
      `UPDATE inventory_products
       SET current_stock = $1,
           updated_by = $2,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`,
      [afterFixed, actorUserId, prodId, property.id]
    );

    await client.query(
      `INSERT INTO stock_movements (
         property_id, product_id, movement_type, movement_source,
         quantity, quantity_delta, stock_before, stock_after,
         unit_cost, reason, reference_note,
         food_order_id, source_key, recorded_by
       ) VALUES (
         $1, $2, 'out', 'order_consumption',
         $3, $4, $5, $6,
         $7, $8, $9,
         $10, $11, $12
       )`,
      [
        property.id,
        prodId,
        reqFixed,
        deltaFixed,
        beforeFixed,
        afterFixed,
        unitCostFixed,
        `Kitchen preparation consumption for order ${orderReference}`,
        `Order ${orderReference}`,
        orderId,
        `food_order_consume:${orderId}:${prodId}`,
        actorUserId,
      ]
    );
  }

  return true;
}

export async function transitionFoodOrderStatus(
  property: Property,
  orderId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<FoodOrderDetail> {
  const input = foodOrderStatusUpdateSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      'SELECT * FROM food_orders WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [orderId, property.id]
    );
    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Food order not found');
    }
    const existing = existingRes.rows[0];
    const currentStatus = existing.status as FoodOrderStatus;

    if (!canTransitionFoodOrderStatus(currentStatus, input.status)) {
      throw AppError.badRequest(
        `Invalid kitchen status transition from "${currentStatus}" to "${input.status}".`
      );
    }

    let deductedNow = false;
    if (currentStatus === 'pending' && input.status === 'preparing') {
      deductedNow = await deductOrderRecipeIngredientsInTx(
        client,
        property,
        existing,
        actorUser.id
      );
    }

    const colPrefix =
      input.status === 'preparing'
        ? 'preparing'
        : input.status === 'ready'
          ? 'ready'
          : 'served';

    await client.query(
      `UPDATE food_orders
       SET status = $1,
           ${colPrefix}_at = NOW(),
           ${colPrefix}_by = $2,
           inventory_deducted_at = CASE WHEN $5::boolean THEN NOW() ELSE inventory_deducted_at END,
           updated_by = $2,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`,
      [input.status, actorUser.id, orderId, property.id, deductedNow]
    );

    await client.query(
      `INSERT INTO food_order_status_history (
         order_id, property_id, from_status, to_status, note, changed_by
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        orderId,
        property.id,
        currentStatus,
        input.status,
        input.note || `Marked ${input.status} by ${actorUser.fullName}`,
        actorUser.id,
      ]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_order',
        entityId: orderId,
        action: `status_${input.status}`,
        summary: `Order ${existing.order_reference} transitioned ${currentStatus} → ${input.status}`,
        payload: {
          fromStatus: currentStatus,
          toStatus: input.status,
          inventoryDeducted: deductedNow,
        },
      },
      client
    );
  });

  return getFoodOrderDetail(property.id, orderId);
}

export async function cancelFoodOrder(
  property: Property,
  orderId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<FoodOrderDetail> {
  const input = foodOrderCancelSchema.parse(rawInput);

  await withTransaction(async (client) => {
    const existingRes = await client.query(
      'SELECT * FROM food_orders WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [orderId, property.id]
    );
    if (existingRes.rowCount === 0) {
      throw AppError.notFound('Food order not found');
    }
    const existing = existingRes.rows[0];
    const currentStatus = existing.status as FoodOrderStatus;

    if (!canTransitionFoodOrderStatus(currentStatus, 'cancelled')) {
      throw AppError.conflict(
        `Cannot cancel a food order once its status is "${currentStatus}".`
      );
    }

    if (existing.billing_status === 'posted') {
      throw AppError.conflict(
        'Cannot cancel a room-service order while its charge is posted to a guest invoice. Reverse the posted folio charge first through the auditable reversal workflow.'
      );
    }

    await client.query(
      `UPDATE food_orders
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancelled_by = $1,
           cancel_reason = $2,
           updated_by = $1,
           updated_at = NOW()
       WHERE id = $3 AND property_id = $4`,
      [actorUser.id, input.reason, orderId, property.id]
    );

    await client.query(
      `INSERT INTO food_order_status_history (
         order_id, property_id, from_status, to_status, note, changed_by
       ) VALUES ($1, $2, $3, 'cancelled', $4, $5)`,
      [
        orderId,
        property.id,
        currentStatus,
        `Cancelled: ${input.reason}`,
        actorUser.id,
      ]
    );

    const hadDeductedInventory = Boolean(existing.inventory_deducted_at);

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_order',
        entityId: orderId,
        action: 'cancelled',
        summary: `Cancelled food order ${existing.order_reference}: ${input.reason}`,
        payload: {
          reason: input.reason,
          fromStatus: currentStatus,
          inventoryRestored: false,
          inventoryPolicy: hadDeductedInventory
            ? 'no_auto_restock_after_prep_start'
            : 'not_deducted_before_prep',
        },
      },
      client
    );
  });

  return getFoodOrderDetail(property.id, orderId);
}

/**
 * Posts an eligible Room Service order onto the reservation's Phase 3 invoice/folio.
 * Enforces lock ordering (reservations -> invoices -> food_orders) and DB-level source_key
 * uniqueness ('food_order:<orderId>') so orders can never be double-charged.
 * Never marks an invoice as 'paid'.
 */
export async function postFoodOrderToInvoice(
  property: Property,
  orderId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<{ order: FoodOrderDetail; invoice: InvoiceDetail }> {
  const input = foodOrderPostToInvoiceSchema.parse(rawInput ?? {});

  const targetInvoiceId = await withTransaction(async (client) => {
    const preOrderRes = await client.query(
      'SELECT id, order_type, reservation_id FROM food_orders WHERE id = $1 AND property_id = $2',
      [orderId, property.id]
    );
    if (preOrderRes.rowCount === 0) {
      throw AppError.notFound('Food order not found');
    }
    const preOrder = preOrderRes.rows[0];
    if (preOrder.order_type !== 'room_service' || !preOrder.reservation_id) {
      throw AppError.badRequest(
        'Only Room Service orders linked to an in-house reservation can be posted to a guest folio.'
      );
    }
    const reservationId = String(preOrder.reservation_id);

    // 1. Lock reservation first (consistent with Phase 3 lock ordering)
    const resCheck = await client.query(
      `SELECT r.*, rm.room_number
       FROM reservations r
       LEFT JOIN rooms rm ON rm.id = r.room_id
       WHERE r.id = $1 AND r.property_id = $2
       FOR UPDATE OF r`,
      [reservationId, property.id]
    );
    if (resCheck.rowCount === 0) {
      throw AppError.notFound('Linked reservation not found');
    }
    const reservation = resCheck.rows[0];

    if (reservation.status === 'cancelled') {
      throw AppError.conflict(
        'Cannot post room-service charges to a cancelled reservation.'
      );
    }

    // 2. Locate or create active non-void invoice for this reservation
    let invRes = await client.query(
      `SELECT * FROM invoices
       WHERE property_id = $1 AND reservation_id = $2 AND status != 'void'
       LIMIT 1
       FOR UPDATE`,
      [property.id, reservationId]
    );

    if (invRes.rowCount === 0) {
      if (!input.createDraftInvoiceIfMissing) {
        throw AppError.conflict(
          `No active invoice exists for reservation ${reservation.booking_reference} yet. Generate a draft invoice on the reservation first, or enable automatic draft folio creation.`,
          { reason: 'NO_ACTIVE_INVOICE', reservationId }
        );
      }

      const synced = await ensureAndSyncReservationInvoiceInTx(
        client,
        property,
        reservationId,
        actorUser.id,
        { issueImmediately: false }
      );
      invRes = await client.query(
        'SELECT * FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE',
        [synced.invoiceId, property.id]
      );
    }

    const invoiceRow = invRes.rows[0];
    const invoiceId = String(invoiceRow.id);

    if (reservation.status === 'checked_out' && invoiceRow.status === 'paid') {
      throw AppError.conflict(
        `Reservation ${reservation.booking_reference} is already checked out and Invoice ${invoiceRow.invoice_number} is Paid in full. Place a direct Restaurant/POS order instead.`
      );
    }

    // 3. Lock food_orders row and validate eligibility
    const orderRes = await client.query(
      'SELECT * FROM food_orders WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [orderId, property.id]
    );
    const order = orderRes.rows[0];

    if (order.status === 'cancelled') {
      throw AppError.conflict('Cannot post a cancelled food order to a guest invoice.');
    }
    if (order.billing_status === 'posted') {
      throw AppError.conflict(
        'This room-service order has already been posted to a guest invoice.'
      );
    }
    if (order.billing_status === 'reversed') {
      throw AppError.conflict(
        'This room-service order charge was previously reversed. Place a new order if re-billing is required.'
      );
    }

    const orderItemsRes = await client.query(
      `SELECT item_name_snapshot, quantity
       FROM food_order_items
       WHERE order_id = $1
       ORDER BY sort_order ASC`,
      [orderId]
    );
    const compactItems = orderItemsRes.rows
      .map((r) => `${r.quantity}× ${r.item_name_snapshot}`)
      .join(', ');

    const roomTag = reservation.room_number ? `Room ${reservation.room_number} — ` : '';
    const rawDesc = `Room Service ${order.order_reference} (${roomTag}${compactItems})`;
    const description = rawDesc.length > 250 ? `${rawDesc.slice(0, 247)}...` : rawDesc;

    // 4. Insert reservation_service_charges row (DB-unique on active food_order_id)
    const scInsert = await client.query(
      `INSERT INTO reservation_service_charges (
         property_id, reservation_id, food_order_id, description,
         quantity, unit_price, tax_amount, total_amount, status, posted_by
       ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 'billed', $8)
       RETURNING id`,
      [
        property.id,
        reservationId,
        orderId,
        description,
        Number(order.subtotal).toFixed(2),
        Number(order.tax_amount).toFixed(2),
        Number(order.total_amount).toFixed(2),
        actorUser.id,
      ]
    );
    const serviceChargeId = scInsert.rows[0].id as string;

    // 5. Insert invoice_line_items row with DB-enforced unique source_key 'food_order:<orderId>'
    const sortRes = await client.query(
      'SELECT COALESCE(MAX(sort_order), 20)::int AS max_sort FROM invoice_line_items WHERE invoice_id = $1',
      [invoiceId]
    );
    const nextSort = Number(sortRes.rows[0]?.max_sort ?? 20) + 10;
    const sourceKey = `food_order:${orderId}`;

    const liInsert = await client.query(
      `INSERT INTO invoice_line_items (
         invoice_id, service_charge_id, source_key, item_type, description,
         quantity, unit_price, net_amount, tax_rate, tax_amount, line_total,
         sort_order, metadata, created_by
       ) VALUES ($1, $2, $3, 'service_charge', $4, 1, $5, 0, $6, 0, 0, $7, $8::jsonb, $9)
       RETURNING id`,
      [
        invoiceId,
        serviceChargeId,
        sourceKey,
        description,
        Number(order.subtotal).toFixed(2),
        Number(order.tax_rate).toFixed(2),
        nextSort,
        JSON.stringify({
          foodOrderId: orderId,
          orderReference: order.order_reference,
          reservationId,
          note: input.note || undefined,
        }),
        actorUser.id,
      ]
    );
    const lineItemId = liInsert.rows[0].id as string;

    // 6. Reuse Phase 3 invoice calculation engine (never marks invoice paid)
    await recomputeAndPersistInvoiceInTx(client, invoiceId, actorUser.id);

    await client.query(
      `UPDATE food_orders
       SET billing_status = 'posted',
           posted_invoice_id = $1,
           posted_line_item_id = $2,
           posted_service_charge_id = $3,
           posted_at = NOW(),
           posted_by = $4,
           updated_by = $4,
           updated_at = NOW()
       WHERE id = $5 AND property_id = $6`,
      [invoiceId, lineItemId, serviceChargeId, actorUser.id, orderId, property.id]
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_order',
        entityId: orderId,
        action: 'posted_to_invoice',
        summary: `Posted room-service order ${order.order_reference} to invoice ${invoiceRow.invoice_number}`,
        payload: {
          invoiceId,
          invoiceNumber: invoiceRow.invoice_number,
          lineItemId,
          totalAmount: Number(order.total_amount),
        },
      },
      client
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'invoice',
        entityId: invoiceId,
        action: 'room_service_posted',
        summary: `Posted room-service order ${order.order_reference} (${Number(order.total_amount).toFixed(2)} ${property.currency})`,
        payload: { foodOrderId: orderId, orderReference: order.order_reference },
      },
      client
    );

    return invoiceId;
  });

  const [order, invoice] = await Promise.all([
    getFoodOrderDetail(property.id, orderId),
    getInvoiceDetail(property.id, targetInvoiceId),
  ]);

  return { order, invoice };
}

/**
 * Auditable reversal of a posted Room Service charge without silent deletion.
 * Preserves the original charge row and appends an offsetting negative adjustment row
 * ('food_order_reversal:<orderId>') while recalculating exact invoice totals & balance.
 */
export async function reverseFoodOrderInvoiceCharge(
  property: Property,
  orderId: string,
  actorUser: UserSummary,
  rawInput: unknown
): Promise<{ order: FoodOrderDetail; invoice: InvoiceDetail }> {
  if (actorUser.role !== 'admin') {
    throw AppError.forbidden(
      'Administrator role is required to reverse posted invoice charges.'
    );
  }
  const input = foodOrderReverseChargeSchema.parse(rawInput);

  const targetInvoiceId = await withTransaction(async (client) => {
    const preRes = await client.query(
      'SELECT reservation_id, posted_invoice_id FROM food_orders WHERE id = $1 AND property_id = $2',
      [orderId, property.id]
    );
    if (preRes.rowCount === 0) {
      throw AppError.notFound('Food order not found');
    }
    const { reservation_id: reservationId, posted_invoice_id: postedInvoiceId } =
      preRes.rows[0];

    if (!postedInvoiceId) {
      throw AppError.conflict('This food order does not have a posted invoice charge to reverse.');
    }

    if (reservationId) {
      await client.query(
        'SELECT id FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE',
        [reservationId, property.id]
      );
    }

    const invRes = await client.query(
      'SELECT * FROM invoices WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [postedInvoiceId, property.id]
    );
    if (invRes.rowCount === 0) {
      throw AppError.notFound('Linked invoice not found');
    }
    const invoiceRow = invRes.rows[0];
    if (invoiceRow.status === 'void') {
      throw AppError.conflict('Linked invoice is already voided.');
    }

    const orderRes = await client.query(
      'SELECT * FROM food_orders WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [orderId, property.id]
    );
    const order = orderRes.rows[0];

    if (order.billing_status !== 'posted') {
      throw AppError.conflict(
        `Only currently posted charges can be reversed (current billing status: "${order.billing_status}").`
      );
    }

    const sortRes = await client.query(
      'SELECT COALESCE(MAX(sort_order), 20)::int AS max_sort FROM invoice_line_items WHERE invoice_id = $1',
      [postedInvoiceId]
    );
    const nextSort = Number(sortRes.rows[0]?.max_sort ?? 20) + 10;

    const reversalDescRaw = `Charge Reversal — Room Service ${order.order_reference} (${input.reason})`;
    const reversalDesc =
      reversalDescRaw.length > 250
        ? `${reversalDescRaw.slice(0, 247)}...`
        : reversalDescRaw;

    await client.query(
      `INSERT INTO invoice_line_items (
         invoice_id, service_charge_id, source_key, item_type, description,
         quantity, unit_price, net_amount, tax_rate, tax_amount, line_total,
         sort_order, metadata, created_by
       ) VALUES ($1, $2, $3, 'adjustment', $4, 1, $5, 0, $6, 0, 0, $7, $8::jsonb, $9)`,
      [
        postedInvoiceId,
        order.posted_service_charge_id ?? null,
        `food_order_reversal:${orderId}`,
        reversalDesc,
        (-Number(order.subtotal)).toFixed(2),
        Number(order.tax_rate).toFixed(2),
        nextSort,
        JSON.stringify({
          foodOrderId: orderId,
          orderReference: order.order_reference,
          reversalReason: input.reason,
        }),
        actorUser.id,
      ]
    );

    if (order.posted_service_charge_id) {
      await client.query(
        `UPDATE reservation_service_charges
         SET status = 'voided'
         WHERE id = $1 AND property_id = $2`,
        [order.posted_service_charge_id, property.id]
      );
    }

    // Recompute invoice totals (also rejects if payments already exceed adjusted grand total)
    await recomputeAndPersistInvoiceInTx(client, String(postedInvoiceId), actorUser.id);

    const currentStatus = order.status as FoodOrderStatus;
    const shouldAlsoCancel =
      input.cancelOrder && canTransitionFoodOrderStatus(currentStatus, 'cancelled');

    await client.query(
      `UPDATE food_orders
       SET billing_status = 'reversed',
           reversed_at = NOW(),
           reversed_by = $1,
           reversal_reason = $2,
           status = CASE WHEN $3::boolean THEN 'cancelled' ELSE status END,
           cancelled_at = CASE WHEN $3::boolean THEN NOW() ELSE cancelled_at END,
           cancelled_by = CASE WHEN $3::boolean THEN $1 ELSE cancelled_by END,
           cancel_reason = CASE WHEN $3::boolean THEN $2 ELSE cancel_reason END,
           updated_by = $1,
           updated_at = NOW()
       WHERE id = $4 AND property_id = $5`,
      [actorUser.id, input.reason, shouldAlsoCancel, orderId, property.id]
    );

    if (shouldAlsoCancel) {
      await client.query(
        `INSERT INTO food_order_status_history (
           order_id, property_id, from_status, to_status, note, changed_by
         ) VALUES ($1, $2, $3, 'cancelled', $4, $5)`,
        [
          orderId,
          property.id,
          currentStatus,
          `Charge reversed & order cancelled: ${input.reason}`,
          actorUser.id,
        ]
      );
    }

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'food_order',
        entityId: orderId,
        action: 'charge_reversed',
        summary: `Reversed posted charge for ${order.order_reference} on invoice ${invoiceRow.invoice_number}: ${input.reason}`,
        payload: {
          invoiceId: postedInvoiceId,
          invoiceNumber: invoiceRow.invoice_number,
          reason: input.reason,
          cancelledOrder: shouldAlsoCancel,
        },
      },
      client
    );

    await recordAuditEvent(
      {
        propertyId: property.id,
        actorUserId: actorUser.id,
        entityType: 'invoice',
        entityId: String(postedInvoiceId),
        action: 'room_service_reversed',
        summary: `Posted auditable reversal for ${order.order_reference}: ${input.reason}`,
        payload: { foodOrderId: orderId, reason: input.reason },
      },
      client
    );

    return String(postedInvoiceId);
  });

  const [order, invoice] = await Promise.all([
    getFoodOrderDetail(property.id, orderId),
    getInvoiceDetail(property.id, targetInvoiceId),
  ]);

  return { order, invoice };
}
