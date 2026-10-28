import { Router } from 'express';
import { parseUuidParam } from '../../errors.js';
import {
  requireAuth,
  requirePropertyContext,
  requireRole,
} from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  createStaffProfile,
  getStaffProfileDetail,
  listStaffProfiles,
  updateStaffProfile,
} from './staff.service.js';

export const staffRouter = Router();

staffRouter.use(requireAuth, requirePropertyContext);

staffRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await listStaffProfiles(req.property!.id, {
      department:
        typeof req.query.department === 'string'
          ? req.query.department
          : undefined,
      employmentStatus:
        typeof req.query.employmentStatus === 'string'
          ? req.query.employmentStatus
          : undefined,
      shiftType:
        typeof req.query.shiftType === 'string'
          ? req.query.shiftType
          : undefined,
      includeInactive: req.query.includeInactive !== 'false',
      search:
        typeof req.query.search === 'string' ? req.query.search : undefined,
    });
    res.json(result);
  })
);

staffRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const staffId = parseUuidParam(req.params.id, 'staff id');
    const staff = await getStaffProfileDetail(req.property!.id, staffId);
    res.json({ staff });
  })
);

staffRouter.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const staff = await createStaffProfile(req.property!, req.user!, req.body);
    res.status(201).json({ staff });
  })
);

staffRouter.put(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const staffId = parseUuidParam(req.params.id, 'staff id');
    const staff = await updateStaffProfile(
      req.property!,
      staffId,
      req.user!,
      req.body
    );
    res.json({ staff });
  })
);
