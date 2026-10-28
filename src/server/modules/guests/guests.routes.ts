import { Router } from 'express';
import { parsePositiveIntQuery, parseUuidParam } from '../../errors.js';
import { requireAuth, requirePropertyContext } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  createGuest,
  getGuestDetail,
  listGuests,
  updateGuest,
} from './guests.service.js';

export const guestsRouter = Router();

guestsRouter.use(requireAuth, requirePropertyContext);

guestsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = parsePositiveIntQuery(req.query.page, 'page', {
      defaultValue: 1,
      max: 100000,
    });
    const pageSize = parsePositiveIntQuery(req.query.pageSize, 'pageSize', {
      defaultValue: 20,
      max: 100,
    });
    const result = await listGuests(req.property!.id, {
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      vipOnly: req.query.vipOnly === 'true',
      page,
      pageSize,
    });
    res.json(result);
  })
);

guestsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const guestId = parseUuidParam(req.params.id, 'guest id');
    const guest = await getGuestDetail(req.property!.id, guestId);
    res.json({ guest });
  })
);

guestsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const guest = await createGuest(req.property!.id, req.user!.id, req.body);
    res.status(201).json({ guest });
  })
);

guestsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const guestId = parseUuidParam(req.params.id, 'guest id');
    const guest = await updateGuest(
      req.property!.id,
      guestId,
      req.user!.id,
      req.body
    );
    res.json({ guest });
  })
);
