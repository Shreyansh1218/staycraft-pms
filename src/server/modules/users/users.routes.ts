import { Router } from 'express';
import {
  parseOptionalUuidQuery,
  parseUuidParam,
} from '../../errors.js';
import {
  requireAuth,
  requirePropertyContext,
  requireRole,
} from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { resolveSafeAppBaseUrl } from '../../services/mailer.service.js';
import {
  createManagedUser,
  getManagedUserById,
  initiateManagedUserPasswordReset,
  listManagedUsers,
  resetManagedUserPassword,
  updateManagedUser,
  updateManagedUserPropertyAccess,
} from './users.service.js';

export const usersRouter = Router();

usersRouter.use(requireAuth, requireRole('admin'), requirePropertyContext);

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const propertyFilterId = parseOptionalUuidQuery(
      req.query.filterPropertyId,
      'filterPropertyId'
    );
    const isActive =
      req.query.isActive === 'true'
        ? true
        : req.query.isActive === 'false'
          ? false
          : undefined;

    const items = await listManagedUsers(req.user!, {
      role: typeof req.query.role === 'string' ? req.query.role : undefined,
      isActive,
      propertyId: propertyFilterId,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
    });
    res.json({ items });
  })
);

usersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = parseUuidParam(req.params.id, 'user id');
    const user = await getManagedUserById(req.user!, userId);
    res.json({ user });
  })
);

usersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = await createManagedUser(req.property!, req.user!, req.body);
    res.status(201).json({ user });
  })
);

usersRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = parseUuidParam(req.params.id, 'user id');
    const user = await updateManagedUser(
      req.property!,
      userId,
      req.user!,
      req.body,
      req.sessionTokenHash
    );
    res.json({ user });
  })
);

usersRouter.put(
  '/:id/property-access',
  asyncHandler(async (req, res) => {
    const userId = parseUuidParam(req.params.id, 'user id');
    const user = await updateManagedUserPropertyAccess(
      req.property!,
      userId,
      req.user!,
      req.body
    );
    res.json({ user });
  })
);

usersRouter.post(
  '/:id/reset-password',
  asyncHandler(async (req, res) => {
    const userId = parseUuidParam(req.params.id, 'user id');
    const result = await resetManagedUserPassword(
      req.property!,
      userId,
      req.user!,
      req.body,
      req.sessionTokenHash
    );
    res.json(result);
  })
);

usersRouter.post(
  '/:id/send-reset-link',
  asyncHandler(async (req, res) => {
    const userId = parseUuidParam(req.params.id, 'user id');
    const result = await initiateManagedUserPasswordReset(
      req.property!,
      userId,
      req.user!,
      {
        appBaseUrl: resolveSafeAppBaseUrl(req),
        requestedIp: String(req.ip ?? req.socket?.remoteAddress ?? ''),
        userAgent: String(req.headers['user-agent'] ?? ''),
      }
    );
    res.json(result);
  })
);
