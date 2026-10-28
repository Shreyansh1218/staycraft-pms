import { Router } from 'express';
import { AppError, parseOptionalUuidQuery, parsePositiveIntQuery, parseUuidParam, } from '../../errors.js';
import { requireAuth, requirePropertyContext } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getReservationActiveInvoice } from '../invoices/invoices.service.js';
import { cancelReservation, checkInReservation, checkOutReservation, createReservation, getReservationDetail, getRoomCalendar, listReservations, updateReservation, } from './reservations.service.js';
export const reservationsRouter = Router();
reservationsRouter.use(requireAuth, requirePropertyContext);
reservationsRouter.get('/', asyncHandler(async (req, res) => {
    const result = await listReservations(req.property, {
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        source: typeof req.query.source === 'string' ? req.query.source : undefined,
        roomTypeId: parseOptionalUuidQuery(req.query.roomTypeId, 'roomTypeId'),
        arrivalFrom: typeof req.query.arrivalFrom === 'string' ? req.query.arrivalFrom : undefined,
        arrivalTo: typeof req.query.arrivalTo === 'string' ? req.query.arrivalTo : undefined,
        quickFilter: typeof req.query.quickFilter === 'string'
            ? req.query.quickFilter
            : undefined,
        sortBy: typeof req.query.sortBy === 'string'
            ? req.query.sortBy
            : undefined,
        sortDir: req.query.sortDir === 'asc' ? 'asc' : 'desc',
        page: parsePositiveIntQuery(req.query.page, 'page', {
            defaultValue: 1,
            max: 100000,
        }),
        pageSize: parsePositiveIntQuery(req.query.pageSize, 'pageSize', {
            defaultValue: 15,
            max: 100,
        }),
    });
    res.json(result);
}));
reservationsRouter.get('/calendar', asyncHandler(async (req, res) => {
    let parsedDays;
    if (req.query.days !== undefined) {
        if (typeof req.query.days !== 'string' || !/^-?\d+$/.test(req.query.days.trim())) {
            throw AppError.badRequest('Calendar days must be an integer between 1 and 45');
        }
        parsedDays = Number.parseInt(req.query.days.trim(), 10);
    }
    const payload = await getRoomCalendar(req.property, {
        startDate: typeof req.query.startDate === 'string' ? req.query.startDate : undefined,
        endDate: typeof req.query.endDate === 'string' ? req.query.endDate : undefined,
        days: parsedDays,
        roomTypeId: parseOptionalUuidQuery(req.query.roomTypeId, 'roomTypeId'),
        floor: typeof req.query.floor === 'string' ? req.query.floor : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        includeCheckedOut: req.query.includeCheckedOut !== 'false',
    });
    res.json(payload);
}));
reservationsRouter.get('/:id', asyncHandler(async (req, res) => {
    const reservationId = parseUuidParam(req.params.id, 'reservation id');
    const reservation = await getReservationDetail(req.property.id, reservationId);
    res.json({ reservation });
}));
reservationsRouter.get('/:id/invoice', asyncHandler(async (req, res) => {
    const reservationId = parseUuidParam(req.params.id, 'reservation id');
    const invoice = await getReservationActiveInvoice(req.property.id, reservationId);
    res.json({ invoice });
}));
reservationsRouter.post('/', asyncHandler(async (req, res) => {
    const reservation = await createReservation(req.property, req.user.id, req.body);
    res.status(201).json({ reservation });
}));
reservationsRouter.put('/:id', asyncHandler(async (req, res) => {
    const reservationId = parseUuidParam(req.params.id, 'reservation id');
    const reservation = await updateReservation(req.property, reservationId, req.user.id, req.body);
    res.json({ reservation });
}));
reservationsRouter.post('/:id/cancel', asyncHandler(async (req, res) => {
    const reservationId = parseUuidParam(req.params.id, 'reservation id');
    const reservation = await cancelReservation(req.property, reservationId, req.user.id, req.body);
    res.json({ reservation });
}));
reservationsRouter.post('/:id/check-in', asyncHandler(async (req, res) => {
    const reservationId = parseUuidParam(req.params.id, 'reservation id');
    const reservation = await checkInReservation(req.property, reservationId, req.user.id, req.body);
    res.json({ reservation });
}));
reservationsRouter.post('/:id/check-out', asyncHandler(async (req, res) => {
    const reservationId = parseUuidParam(req.params.id, 'reservation id');
    const reservation = await checkOutReservation(req.property, reservationId, req.user.id, req.body);
    res.json({ reservation });
}));
