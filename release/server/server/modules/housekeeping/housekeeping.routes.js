import { Router } from 'express';
import { parseOptionalUuidQuery, parseUuidParam } from '../../errors.js';
import { requireAuth, requirePropertyContext } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { completeHousekeepingTask, createHousekeepingTask, getHousekeepingTaskById, listHousekeepingTasks, startHousekeepingTask, updateHousekeepingTask, } from './housekeeping.service.js';
export const housekeepingRouter = Router();
housekeepingRouter.use(requireAuth, requirePropertyContext);
housekeepingRouter.get('/tasks', asyncHandler(async (req, res) => {
    const items = await listHousekeepingTasks(req.property.id, {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        priority: typeof req.query.priority === 'string' ? req.query.priority : undefined,
        taskType: typeof req.query.taskType === 'string' ? req.query.taskType : undefined,
        roomId: parseOptionalUuidQuery(req.query.roomId, 'roomId'),
        assignedTo: parseOptionalUuidQuery(req.query.assignedTo, 'assignedTo', {
            allowLiterals: ['unassigned'],
        }),
        dueDate: typeof req.query.dueDate === 'string' ? req.query.dueDate : undefined,
        dueFrom: typeof req.query.dueFrom === 'string' ? req.query.dueFrom : undefined,
        dueTo: typeof req.query.dueTo === 'string' ? req.query.dueTo : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
    });
    res.json({ items });
}));
housekeepingRouter.get('/tasks/:id', asyncHandler(async (req, res) => {
    const taskId = parseUuidParam(req.params.id, 'task id');
    const task = await getHousekeepingTaskById(req.property.id, taskId);
    res.json({ task });
}));
housekeepingRouter.post('/tasks', asyncHandler(async (req, res) => {
    const task = await createHousekeepingTask(req.property.id, req.user.id, req.body);
    res.status(201).json({ task });
}));
housekeepingRouter.put('/tasks/:id', asyncHandler(async (req, res) => {
    const taskId = parseUuidParam(req.params.id, 'task id');
    const task = await updateHousekeepingTask(req.property.id, taskId, req.user.id, req.body);
    res.json({ task });
}));
housekeepingRouter.post('/tasks/:id/start', asyncHandler(async (req, res) => {
    const taskId = parseUuidParam(req.params.id, 'task id');
    const task = await startHousekeepingTask(req.property.id, taskId, req.user.id, req.body);
    res.json({ task });
}));
housekeepingRouter.post('/tasks/:id/complete', asyncHandler(async (req, res) => {
    const taskId = parseUuidParam(req.params.id, 'task id');
    const task = await completeHousekeepingTask(req.property.id, taskId, req.user.id, req.body);
    res.json({ task });
}));
