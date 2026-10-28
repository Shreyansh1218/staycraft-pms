import { Router } from 'express';
import { parseOptionalUuidQuery, parsePositiveIntQuery, parseUuidParam, } from '../../errors.js';
import { requireAuth, requirePropertyContext, requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getAffectedReservationsForRoomQuery, listMaintenanceRequests, placeRoomOutOfService, restoreRoomToService, } from '../maintenance/maintenance.service.js';
import { createRoom, createRoomType, executeRoomCleaningWorkflow, getRoomById, listRooms, listRoomTypes, updateRoom, updateRoomHousekeeping, updateRoomType, } from './rooms.service.js';
export const roomsRouter = Router();
roomsRouter.use(requireAuth, requirePropertyContext);
// Room Categories (Room Types)
roomsRouter.get('/room-types', asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const items = await listRoomTypes(req.property.id, includeInactive);
    res.json({ items });
}));
roomsRouter.post('/room-types', requireRole('admin'), asyncHandler(async (req, res) => {
    const roomType = await createRoomType(req.property.id, req.user.id, req.body);
    res.status(201).json({ roomType });
}));
roomsRouter.put('/room-types/:id', requireRole('admin'), asyncHandler(async (req, res) => {
    const roomTypeId = parseUuidParam(req.params.id, 'room type id');
    const roomType = await updateRoomType(req.property.id, roomTypeId, req.user.id, req.body);
    res.json({ roomType });
}));
// Rooms & Housekeeping Status
roomsRouter.get('/rooms', asyncHandler(async (req, res) => {
    const items = await listRooms(req.property.id, {
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        roomTypeId: parseOptionalUuidQuery(req.query.roomTypeId, 'roomTypeId'),
        operationalStatus: typeof req.query.operationalStatus === 'string' ? req.query.operationalStatus : undefined,
        housekeepingStatus: typeof req.query.housekeepingStatus === 'string' ? req.query.housekeepingStatus : undefined,
        floor: typeof req.query.floor === 'string' ? req.query.floor : undefined,
        includeInactive: req.query.includeInactive === 'true',
        availableFrom: typeof req.query.availableFrom === 'string' ? req.query.availableFrom : undefined,
        availableTo: typeof req.query.availableTo === 'string' ? req.query.availableTo : undefined,
        excludeReservationId: parseOptionalUuidQuery(req.query.excludeReservationId, 'excludeReservationId'),
        minCapacity: req.query.minCapacity !== undefined && req.query.minCapacity !== ''
            ? parsePositiveIntQuery(req.query.minCapacity, 'minCapacity', {
                defaultValue: 1,
                max: 50,
            })
            : undefined,
    });
    res.json({ items });
}));
roomsRouter.get('/rooms/:id', asyncHandler(async (req, res) => {
    const roomId = parseUuidParam(req.params.id, 'room id');
    const room = await getRoomById(req.property.id, roomId);
    res.json({ room });
}));
roomsRouter.post('/rooms', requireRole('admin'), asyncHandler(async (req, res) => {
    const room = await createRoom(req.property.id, req.user.id, req.body);
    res.status(201).json({ room });
}));
roomsRouter.put('/rooms/:id', requireRole('admin'), asyncHandler(async (req, res) => {
    const roomId = parseUuidParam(req.params.id, 'room id');
    const room = await updateRoom(req.property.id, roomId, req.user.id, req.body);
    res.json({ room });
}));
roomsRouter.patch('/rooms/:id/housekeeping', asyncHandler(async (req, res) => {
    const roomId = parseUuidParam(req.params.id, 'room id');
    const room = await updateRoomHousekeeping(req.property.id, roomId, req.user, req.body);
    res.json({ room });
}));
roomsRouter.post('/rooms/:id/housekeeping-workflow', asyncHandler(async (req, res) => {
    const roomId = parseUuidParam(req.params.id, 'room id');
    const room = await executeRoomCleaningWorkflow(req.property.id, roomId, req.user.id, req.body);
    res.json({ room });
}));
roomsRouter.get('/rooms/:id/affected-reservations', asyncHandler(async (req, res) => {
    const roomId = parseUuidParam(req.params.id, 'room id');
    const items = await getAffectedReservationsForRoomQuery(req.property, roomId, typeof req.query.from === 'string' ? req.query.from : undefined, typeof req.query.to === 'string' ? req.query.to : undefined);
    res.json({ items });
}));
roomsRouter.get('/rooms/:id/maintenance', asyncHandler(async (req, res) => {
    const roomId = parseUuidParam(req.params.id, 'room id');
    const items = await listMaintenanceRequests(req.property.id, {
        roomId,
    });
    res.json({ items });
}));
roomsRouter.post('/rooms/:id/out-of-service', requireRole('admin'), asyncHandler(async (req, res) => {
    const roomId = parseUuidParam(req.params.id, 'room id');
    const result = await placeRoomOutOfService(req.property, roomId, req.user, req.body);
    res.status(201).json(result);
}));
roomsRouter.post('/rooms/:id/restore-service', requireRole('admin'), asyncHandler(async (req, res) => {
    const roomId = parseUuidParam(req.params.id, 'room id');
    const room = await restoreRoomToService(req.property, roomId, req.user, req.body);
    res.json({ room });
}));
