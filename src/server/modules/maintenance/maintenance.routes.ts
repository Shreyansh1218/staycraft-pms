import { Router } from 'express';
import { parseOptionalUuidQuery, parseUuidParam } from '../../errors.js';
import { requireAuth, requirePropertyContext } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  createMaintenanceRequest,
  getMaintenanceRequestById,
  listMaintenanceRequests,
  updateMaintenanceRequest,
} from './maintenance.service.js';

export const maintenanceRouter = Router();

maintenanceRouter.use(requireAuth, requirePropertyContext);

maintenanceRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await listMaintenanceRequests(req.property!.id, {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      priority: typeof req.query.priority === 'string' ? req.query.priority : undefined,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      roomId: parseOptionalUuidQuery(req.query.roomId, 'roomId'),
      assignedTo: parseOptionalUuidQuery(req.query.assignedTo, 'assignedTo', {
        allowLiterals: ['unassigned'],
      }),
      blocksInventory:
        req.query.blocksInventory === 'true'
          ? true
          : req.query.blocksInventory === 'false'
            ? false
            : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
    });
    res.json({ items });
  })
);

maintenanceRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const requestId = parseUuidParam(req.params.id, 'maintenance request id');
    const maintenanceRequest = await getMaintenanceRequestById(
      req.property!.id,
      requestId
    );
    res.json({ maintenanceRequest });
  })
);

maintenanceRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const result = await createMaintenanceRequest(req.property!, req.user!, req.body);
    res.status(201).json(result);
  })
);

maintenanceRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const requestId = parseUuidParam(req.params.id, 'maintenance request id');
    const maintenanceRequest = await updateMaintenanceRequest(
      req.property!,
      requestId,
      req.user!,
      req.body
    );
    res.json({ maintenanceRequest });
  })
);
