import { Router } from 'express';
import { requireAuth, requirePropertyContext } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getPropertyFinancialOperationalReport } from './reports.service.js';
export const reportsRouter = Router();
reportsRouter.use(requireAuth, requirePropertyContext);
reportsRouter.get('/overview', asyncHandler(async (req, res) => {
    const report = await getPropertyFinancialOperationalReport(req.property, {
        dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
        dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
    });
    res.json({ report });
}));
