import { Router } from 'express';
import { AppError, parseOptionalUuidQuery, parseUuidParam, } from '../../errors.js';
import { requireAuth, requirePropertyContext, requireRole, } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { createInventoryCategory, createInventoryItem, createInventoryReceipt, createStockAdjustment, getInventoryItemById, getInventoryReceiptDetail, getInventorySummary, listInventoryCategories, listInventoryItems, listInventoryReceipts, listStockMovementsReport, updateInventoryCategory, updateInventoryItem, } from './inventory.service.js';
export const inventoryRouter = Router();
inventoryRouter.use(requireAuth, requirePropertyContext);
function parsePositiveIntQuery(raw, label, options) {
    if (raw === undefined || raw === null) {
        return options.defaultValue;
    }
    if (typeof raw !== 'string') {
        throw AppError.badRequest(`Invalid ${label}: must be a positive integer`);
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
        return options.defaultValue;
    }
    if (!/^\d+$/.test(trimmed)) {
        throw AppError.badRequest(`Invalid ${label}: must be a positive integer`);
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw AppError.badRequest(`Invalid ${label}: must be at least 1`);
    }
    if (parsed > options.max) {
        throw AppError.badRequest(`Invalid ${label}: cannot exceed ${options.max}`);
    }
    return parsed;
}
// Dashboard KPIs & Low-Stock Alerts
inventoryRouter.get('/summary', asyncHandler(async (req, res) => {
    const summary = await getInventorySummary(req.property);
    res.json({ summary });
}));
// Inventory Categories
inventoryRouter.get('/categories', asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const items = await listInventoryCategories(req.property.id, includeInactive);
    res.json({ items });
}));
inventoryRouter.post('/categories', requireRole('admin'), asyncHandler(async (req, res) => {
    const category = await createInventoryCategory(req.property, req.user, req.body);
    res.status(201).json({ category });
}));
inventoryRouter.put('/categories/:id', requireRole('admin'), asyncHandler(async (req, res) => {
    const categoryId = parseUuidParam(req.params.id, 'category id');
    const category = await updateInventoryCategory(req.property, categoryId, req.user, req.body);
    res.json({ category });
}));
// Inventory Items
inventoryRouter.get('/items', asyncHandler(async (req, res) => {
    const categoryId = parseOptionalUuidQuery(req.query.categoryId, 'categoryId');
    const supplierId = parseOptionalUuidQuery(req.query.supplierId, 'supplierId', {
        allowLiterals: ['none'],
    });
    const items = await listInventoryItems(req.property.id, {
        categoryId,
        supplierId,
        stockFilter: typeof req.query.stockFilter === 'string' ? req.query.stockFilter : undefined,
        includeInactive: req.query.includeInactive === 'true',
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
    });
    res.json({ items });
}));
inventoryRouter.get('/items/:id', asyncHandler(async (req, res) => {
    const itemId = parseUuidParam(req.params.id, 'inventory item id');
    const item = await getInventoryItemById(req.property.id, itemId);
    res.json({ item });
}));
inventoryRouter.post('/items', requireRole('admin'), asyncHandler(async (req, res) => {
    const item = await createInventoryItem(req.property, req.user, req.body);
    res.status(201).json({ item });
}));
inventoryRouter.put('/items/:id', requireRole('admin'), asyncHandler(async (req, res) => {
    const itemId = parseUuidParam(req.params.id, 'inventory item id');
    const item = await updateInventoryItem(req.property, itemId, req.user, req.body);
    res.json({ item });
}));
// Purchase / Stock Receipts
inventoryRouter.get('/receipts', asyncHandler(async (req, res) => {
    const supplierId = parseOptionalUuidQuery(req.query.supplierId, 'supplierId');
    const page = parsePositiveIntQuery(req.query.page, 'page', {
        defaultValue: 1,
        max: 100000,
    });
    const pageSize = parsePositiveIntQuery(req.query.pageSize, 'pageSize', {
        defaultValue: 25,
        max: 100,
    });
    const result = await listInventoryReceipts(req.property, {
        supplierId,
        dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
        dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        page,
        pageSize,
    });
    res.json(result);
}));
inventoryRouter.get('/receipts/:id', asyncHandler(async (req, res) => {
    const receiptId = parseUuidParam(req.params.id, 'receipt id');
    const receipt = await getInventoryReceiptDetail(req.property.id, receiptId);
    res.json({ receipt });
}));
inventoryRouter.post('/receipts', asyncHandler(async (req, res) => {
    const { receipt, created } = await createInventoryReceipt(req.property, req.user, req.body);
    res.status(created ? 201 : 200).json({ receipt });
}));
// Controlled Stock Adjustments (Admin-only)
inventoryRouter.post('/adjustments', requireRole('admin'), asyncHandler(async (req, res) => {
    const { movement, item, created } = await createStockAdjustment(req.property, req.user, req.body);
    res.status(created ? 201 : 200).json({ movement, item });
}));
// Immutable Inventory Movement History & Reports
inventoryRouter.get('/movements', asyncHandler(async (req, res) => {
    const productId = parseOptionalUuidQuery(req.query.productId, 'productId');
    const categoryId = parseOptionalUuidQuery(req.query.categoryId, 'categoryId');
    const supplierId = parseOptionalUuidQuery(req.query.supplierId, 'supplierId');
    const page = parsePositiveIntQuery(req.query.page, 'page', {
        defaultValue: 1,
        max: 100000,
    });
    const pageSize = parsePositiveIntQuery(req.query.pageSize, 'pageSize', {
        defaultValue: 30,
        max: 100,
    });
    const result = await listStockMovementsReport(req.property, {
        productId,
        categoryId,
        supplierId,
        movementType: typeof req.query.movementType === 'string' ? req.query.movementType : undefined,
        movementSource: typeof req.query.movementSource === 'string'
            ? req.query.movementSource
            : undefined,
        dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
        dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        page,
        pageSize,
    });
    res.json(result);
}));
