import { Router } from 'express';
import { AppError, parseOptionalUuidQuery, parseUuidParam, } from '../../errors.js';
import { requireAuth, requirePropertyContext, requireRole, } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { createExpense, createExpenseCategory, deleteExpenseCategory, getExpenseDetail, listExpenseCategories, listExpenses, updateExpense, updateExpenseCategory, voidExpense, } from './expenses.service.js';
export const expensesRouter = Router();
expensesRouter.use(requireAuth, requirePropertyContext);
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
// Expense Categories
expensesRouter.get('/categories', asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const items = await listExpenseCategories(req.property.id, includeInactive);
    res.json({ items });
}));
expensesRouter.post('/categories', requireRole('admin'), asyncHandler(async (req, res) => {
    const category = await createExpenseCategory(req.property, req.user, req.body);
    res.status(201).json({ category });
}));
expensesRouter.put('/categories/:id', requireRole('admin'), asyncHandler(async (req, res) => {
    const categoryId = parseUuidParam(req.params.id, 'expense category id');
    const category = await updateExpenseCategory(req.property, categoryId, req.user, req.body);
    res.json({ category });
}));
expensesRouter.delete('/categories/:id', requireRole('admin'), asyncHandler(async (req, res) => {
    const categoryId = parseUuidParam(req.params.id, 'expense category id');
    await deleteExpenseCategory(req.property, categoryId, req.user);
    res.json({ deleted: true });
}));
// Operating Expenses List & Summary
expensesRouter.get('/', asyncHandler(async (req, res) => {
    const categoryId = parseOptionalUuidQuery(req.query.categoryId, 'categoryId');
    const supplierId = parseOptionalUuidQuery(req.query.supplierId, 'supplierId', {
        allowLiterals: ['none'],
    });
    const page = parsePositiveIntQuery(req.query.page, 'page', {
        defaultValue: 1,
        max: 10000,
    });
    const pageSize = parsePositiveIntQuery(req.query.pageSize, 'pageSize', {
        defaultValue: 25,
        max: 100,
    });
    const result = await listExpenses(req.property, {
        categoryId,
        supplierId,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        paymentMethod: typeof req.query.paymentMethod === 'string' ? req.query.paymentMethod : undefined,
        dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
        dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        page,
        pageSize,
    });
    res.json(result);
}));
expensesRouter.get('/:id', asyncHandler(async (req, res) => {
    const expenseId = parseUuidParam(req.params.id, 'expense id');
    const expense = await getExpenseDetail(req.property.id, expenseId);
    res.json({ expense });
}));
expensesRouter.post('/', asyncHandler(async (req, res) => {
    const { expense, idempotentReplay } = await createExpense(req.property, req.user, req.body);
    res.status(idempotentReplay ? 200 : 201).json({ expense, idempotentReplay });
}));
expensesRouter.put('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
    const expenseId = parseUuidParam(req.params.id, 'expense id');
    const expense = await updateExpense(req.property, expenseId, req.user, req.body);
    res.json({ expense });
}));
expensesRouter.post('/:id/void', requireRole('admin'), asyncHandler(async (req, res) => {
    const expenseId = parseUuidParam(req.params.id, 'expense id');
    const expense = await voidExpense(req.property, expenseId, req.user, req.body);
    res.json({ expense });
}));
