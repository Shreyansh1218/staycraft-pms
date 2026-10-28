import { Router } from 'express';
import { parseUuidParam } from '../../errors.js';
import { requireAuth, requirePropertyContext, requireRole, } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { createSupplier, getSupplierById, listSuppliers, updateSupplier, } from './suppliers.service.js';
export const suppliersRouter = Router();
suppliersRouter.use(requireAuth, requirePropertyContext);
suppliersRouter.get('/', asyncHandler(async (req, res) => {
    const items = await listSuppliers(req.property.id, {
        includeInactive: req.query.includeInactive === 'true',
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
    });
    res.json({ items });
}));
suppliersRouter.get('/:id', asyncHandler(async (req, res) => {
    const supplierId = parseUuidParam(req.params.id, 'supplier id');
    const supplier = await getSupplierById(req.property.id, supplierId);
    res.json({ supplier });
}));
suppliersRouter.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
    const supplier = await createSupplier(req.property, req.user, req.body);
    res.status(201).json({ supplier });
}));
suppliersRouter.put('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
    const supplierId = parseUuidParam(req.params.id, 'supplier id');
    const supplier = await updateSupplier(req.property, supplierId, req.user, req.body);
    res.json({ supplier });
}));
