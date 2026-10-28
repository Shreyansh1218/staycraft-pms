import { Router } from 'express';
import { parseOptionalUuidQuery, parsePositiveIntQuery, parseUuidParam, } from '../../errors.js';
import { requireAuth, requirePropertyContext, requireRole, } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { addInvoiceLineItem, createOrSyncInvoiceFromReservation, getInvoiceDetail, issueInvoice, listInvoices, recordInvoicePayment, removeInvoiceLineItem, syncInvoiceWithReservation, updateInvoiceMetadata, voidInvoice, } from './invoices.service.js';
export const invoicesRouter = Router();
invoicesRouter.use(requireAuth, requirePropertyContext);
invoicesRouter.get('/', asyncHandler(async (req, res) => {
    const reservationId = parseOptionalUuidQuery(req.query.reservationId, 'reservationId');
    const guestId = parseOptionalUuidQuery(req.query.guestId, 'guestId');
    const result = await listInvoices(req.property, {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        reservationId,
        guestId,
        issueFrom: typeof req.query.issueFrom === 'string' ? req.query.issueFrom : undefined,
        issueTo: typeof req.query.issueTo === 'string' ? req.query.issueTo : undefined,
        unpaidOnly: req.query.unpaidOnly === 'true',
        page: parsePositiveIntQuery(req.query.page, 'page', {
            defaultValue: 1,
            max: 100000,
        }),
        pageSize: parsePositiveIntQuery(req.query.pageSize, 'pageSize', {
            defaultValue: 20,
            max: 100,
        }),
    });
    res.json(result);
}));
invoicesRouter.post('/from-reservation/:reservationId', asyncHandler(async (req, res) => {
    const reservationId = parseUuidParam(req.params.reservationId, 'reservation id');
    const { invoice, created } = await createOrSyncInvoiceFromReservation(req.property, reservationId, req.user, req.body);
    res.status(created ? 201 : 200).json({ invoice, created });
}));
invoicesRouter.get('/:id', asyncHandler(async (req, res) => {
    const invoiceId = parseUuidParam(req.params.id, 'invoice id');
    const invoice = await getInvoiceDetail(req.property.id, invoiceId);
    res.json({ invoice });
}));
invoicesRouter.patch('/:id', asyncHandler(async (req, res) => {
    const invoiceId = parseUuidParam(req.params.id, 'invoice id');
    const invoice = await updateInvoiceMetadata(req.property, invoiceId, req.user, req.body);
    res.json({ invoice });
}));
invoicesRouter.post('/:id/sync-reservation', asyncHandler(async (req, res) => {
    const invoiceId = parseUuidParam(req.params.id, 'invoice id');
    const invoice = await syncInvoiceWithReservation(req.property, invoiceId, req.user);
    res.json({ invoice });
}));
invoicesRouter.post('/:id/issue', asyncHandler(async (req, res) => {
    const invoiceId = parseUuidParam(req.params.id, 'invoice id');
    const invoice = await issueInvoice(req.property, invoiceId, req.user);
    res.json({ invoice });
}));
invoicesRouter.post('/:id/items', asyncHandler(async (req, res) => {
    const invoiceId = parseUuidParam(req.params.id, 'invoice id');
    const invoice = await addInvoiceLineItem(req.property, invoiceId, req.user, req.body);
    res.status(201).json({ invoice });
}));
invoicesRouter.delete('/:id/items/:itemId', requireRole('admin'), asyncHandler(async (req, res) => {
    const invoiceId = parseUuidParam(req.params.id, 'invoice id');
    const itemId = parseUuidParam(req.params.itemId, 'item id');
    const invoice = await removeInvoiceLineItem(req.property, invoiceId, itemId, req.user);
    res.json({ invoice });
}));
invoicesRouter.post('/:id/payments', asyncHandler(async (req, res) => {
    const invoiceId = parseUuidParam(req.params.id, 'invoice id');
    const { invoice, payment } = await recordInvoicePayment(req.property, invoiceId, req.user, req.body);
    res.status(201).json({ invoice, payment });
}));
invoicesRouter.post('/:id/void', requireRole('admin'), asyncHandler(async (req, res) => {
    const invoiceId = parseUuidParam(req.params.id, 'invoice id');
    const invoice = await voidInvoice(req.property, invoiceId, req.user, req.body);
    res.json({ invoice });
}));
