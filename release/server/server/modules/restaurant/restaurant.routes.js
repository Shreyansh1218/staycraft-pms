import { Router } from 'express';
import { config, setDevRuntimePublicAppUrlOverride, } from '../../config.js';
import { AppError, parseOptionalUuidQuery, parseUuidParam } from '../../errors.js';
import { requireAuth, requirePropertyContext, requireRole, } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { resolveGuestQrUrlContext } from '../../services/mailer.service.js';
import { getPropertyQrFoodConfig, regeneratePropertyQrFoodToken, updatePropertyQrFoodConfig, } from './guest-food.service.js';
import { cancelFoodOrder, createFoodCategory, createFoodMenuItem, createFoodOrder, getFoodOrderDetail, listEligibleRoomServiceStays, listFoodCategories, listFoodMenuItems, listFoodOrders, listMenuItemIngredients, postFoodOrderToInvoice, reverseFoodOrderInvoiceCharge, transitionFoodOrderStatus, updateFoodCategory, updateFoodMenuItem, updateFoodOrder, updateMenuItemIngredients, } from './restaurant.service.js';
export const restaurantRouter = Router();
restaurantRouter.use(requireAuth, requirePropertyContext);
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
// Food Categories
restaurantRouter.get('/categories', asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const items = await listFoodCategories(req.property.id, includeInactive);
    res.json({ items });
}));
restaurantRouter.post('/categories', requireRole('admin'), asyncHandler(async (req, res) => {
    const category = await createFoodCategory(req.property, req.user, req.body);
    res.status(201).json({ category });
}));
restaurantRouter.put('/categories/:id', requireRole('admin'), asyncHandler(async (req, res) => {
    const categoryId = parseUuidParam(req.params.id, 'category id');
    const category = await updateFoodCategory(req.property, categoryId, req.user, req.body);
    res.json({ category });
}));
// Menu Items
restaurantRouter.get('/menu-items', asyncHandler(async (req, res) => {
    const categoryId = parseOptionalUuidQuery(req.query.categoryId, 'categoryId');
    if (req.query.dietaryTag !== undefined && typeof req.query.dietaryTag !== 'string') {
        throw AppError.badRequest('Invalid dietaryTag query parameter');
    }
    const items = await listFoodMenuItems(req.property.id, {
        categoryId,
        includeInactive: req.query.includeInactive === 'true',
        availableOnly: req.query.availableOnly === 'true',
        dietaryTag: typeof req.query.dietaryTag === 'string' ? req.query.dietaryTag : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
    });
    res.json({ items });
}));
restaurantRouter.post('/menu-items', requireRole('admin'), asyncHandler(async (req, res) => {
    const menuItem = await createFoodMenuItem(req.property, req.user, req.body);
    res.status(201).json({ menuItem });
}));
restaurantRouter.put('/menu-items/:id', requireRole('admin'), asyncHandler(async (req, res) => {
    const itemId = parseUuidParam(req.params.id, 'menu item id');
    const menuItem = await updateFoodMenuItem(req.property, itemId, req.user, req.body);
    res.json({ menuItem });
}));
restaurantRouter.get('/menu-items/:id/ingredients', asyncHandler(async (req, res) => {
    const itemId = parseUuidParam(req.params.id, 'menu item id');
    const items = await listMenuItemIngredients(req.property.id, itemId);
    res.json({ items });
}));
restaurantRouter.put('/menu-items/:id/ingredients', requireRole('admin'), asyncHandler(async (req, res) => {
    const itemId = parseUuidParam(req.params.id, 'menu item id');
    const menuItem = await updateMenuItemIngredients(req.property, itemId, req.user, req.body);
    res.json({ menuItem });
}));
// Eligible Checked-In Stays for Room Service
restaurantRouter.get('/eligible-stays', asyncHandler(async (req, res) => {
    const items = await listEligibleRoomServiceStays(req.property.id);
    res.json({ items });
}));
// Common Per-Hotel Guest Self-Service QR Code Configuration
restaurantRouter.get('/qr-config', asyncHandler(async (req, res) => {
    const config = await getPropertyQrFoodConfig(req.property.id, resolveGuestQrUrlContext(req));
    res.json({ config });
}));
restaurantRouter.put('/qr-config', requireRole('admin'), asyncHandler(async (req, res) => {
    const config = await updatePropertyQrFoodConfig(req.property, req.user, req.body, resolveGuestQrUrlContext(req));
    res.json({ config });
}));
restaurantRouter.post('/qr-config/regenerate', requireRole('admin'), asyncHandler(async (req, res) => {
    const configPayload = await regeneratePropertyQrFoodToken(req.property, req.user, resolveGuestQrUrlContext(req));
    res.json({ config: configPayload });
}));
restaurantRouter.put('/qr-config/dev-base-url', requireRole('admin'), asyncHandler(async (req, res) => {
    if (config.nodeEnv !== 'development') {
        throw AppError.forbidden('Runtime PUBLIC_APP_URL updates are restricted to NODE_ENV=development. Set PUBLIC_APP_URL=https://<your-public-domain> in your production server environment.');
    }
    const rawUrl = req.body && typeof req.body === 'object' && 'publicAppUrl' in req.body
        ? req.body.publicAppUrl
        : undefined;
    if (rawUrl !== undefined && rawUrl !== null && typeof rawUrl !== 'string') {
        throw AppError.badRequest('publicAppUrl must be a string.');
    }
    try {
        setDevRuntimePublicAppUrlOverride(rawUrl ?? null);
    }
    catch (err) {
        throw AppError.badRequest(err instanceof Error
            ? err.message
            : 'Invalid PUBLIC_APP_URL configuration.');
    }
    const configPayload = await getPropertyQrFoodConfig(req.property.id, resolveGuestQrUrlContext(req));
    res.json({ config: configPayload });
}));
// Food Orders & Kitchen Workflow
restaurantRouter.get('/orders', asyncHandler(async (req, res) => {
    const reservationId = parseOptionalUuidQuery(req.query.reservationId, 'reservationId');
    const page = parsePositiveIntQuery(req.query.page, 'page', {
        defaultValue: 1,
        max: 100000,
    });
    const pageSize = parsePositiveIntQuery(req.query.pageSize, 'pageSize', {
        defaultValue: 30,
        max: 100,
    });
    const result = await listFoodOrders(req.property, {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        orderType: typeof req.query.orderType === 'string' ? req.query.orderType : undefined,
        orderSource: typeof req.query.orderSource === 'string' ? req.query.orderSource : undefined,
        billingStatus: typeof req.query.billingStatus === 'string' ? req.query.billingStatus : undefined,
        reservationId,
        dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
        dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
        kitchenActiveOnly: req.query.kitchenActiveOnly === 'true',
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        page,
        pageSize,
    });
    res.json(result);
}));
restaurantRouter.post('/orders', asyncHandler(async (req, res) => {
    const { order, created } = await createFoodOrder(req.property, req.user, req.body);
    res.status(created ? 201 : 200).json({ order });
}));
restaurantRouter.get('/orders/:id', asyncHandler(async (req, res) => {
    const orderId = parseUuidParam(req.params.id, 'order id');
    const order = await getFoodOrderDetail(req.property.id, orderId);
    res.json({ order });
}));
restaurantRouter.put('/orders/:id', asyncHandler(async (req, res) => {
    const orderId = parseUuidParam(req.params.id, 'order id');
    const order = await updateFoodOrder(req.property, orderId, req.user, req.body);
    res.json({ order });
}));
restaurantRouter.post('/orders/:id/status', asyncHandler(async (req, res) => {
    const orderId = parseUuidParam(req.params.id, 'order id');
    const order = await transitionFoodOrderStatus(req.property, orderId, req.user, req.body);
    res.json({ order });
}));
restaurantRouter.post('/orders/:id/cancel', asyncHandler(async (req, res) => {
    const orderId = parseUuidParam(req.params.id, 'order id');
    const order = await cancelFoodOrder(req.property, orderId, req.user, req.body);
    res.json({ order });
}));
restaurantRouter.post('/orders/:id/post-to-invoice', asyncHandler(async (req, res) => {
    const orderId = parseUuidParam(req.params.id, 'order id');
    const { order, invoice } = await postFoodOrderToInvoice(req.property, orderId, req.user, req.body);
    res.json({ order, invoice });
}));
restaurantRouter.post('/orders/:id/reverse-charge', requireRole('admin'), asyncHandler(async (req, res) => {
    const orderId = parseUuidParam(req.params.id, 'order id');
    const { order, invoice } = await reverseFoodOrderInvoiceCharge(req.property, orderId, req.user, req.body);
    res.json({ order, invoice });
}));
