import { Router } from 'express';
import {
  AppError,
  parseOptionalUuidQuery,
  parseUuidParam,
} from '../../errors.js';
import {
  requireAuth,
  requirePropertyContext,
  requireRole,
} from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  cancelServiceRequest,
  createServiceCatalogItem,
  createServiceRequest,
  getServiceCatalogItemById,
  getServiceRequestDetail,
  listEligibleServiceStays,
  listServiceCatalog,
  listServiceRequests,
  postServiceRequestToInvoice,
  transitionServiceRequestStatus,
  updateServiceCatalogItem,
  updateServiceRequest,
} from './services.service.js';

export const servicesRouter = Router();

servicesRouter.use(requireAuth, requirePropertyContext);

function parsePositiveIntQuery(
  raw: unknown,
  label: string,
  options: { defaultValue: number; max: number }
): number {
  if (raw === undefined || raw === null) {
    return options.defaultValue;
  }
  if (typeof raw !== 'string') {
    throw AppError.badRequest(`Invalid ${label}: must be a positive integer`);
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return options.defaultValue;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw AppError.badRequest(`Invalid ${label}: must be a positive integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw AppError.badRequest(`Invalid ${label}: must be at least 1`);
  }
  if (parsed > options.max) {
    throw AppError.badRequest(`Invalid ${label}: cannot exceed ${options.max}`);
  }
  return parsed;
}

// Service Catalog Routes
servicesRouter.get(
  '/catalog',
  asyncHandler(async (req, res) => {
    const items = await listServiceCatalog(req.property!, {
      includeInactive: req.query.includeInactive === 'true',
      category:
        typeof req.query.category === 'string' ? req.query.category : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
    });
    res.json({ items });
  })
);

servicesRouter.get(
  '/catalog/:id',
  asyncHandler(async (req, res) => {
    const serviceId = parseUuidParam(req.params.id, 'service id');
    const service = await getServiceCatalogItemById(req.property!, serviceId);
    res.json({ service });
  })
);

servicesRouter.post(
  '/catalog',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const service = await createServiceCatalogItem(
      req.property!,
      req.user!,
      req.body
    );
    res.status(201).json({ service });
  })
);

servicesRouter.put(
  '/catalog/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const serviceId = parseUuidParam(req.params.id, 'service id');
    const service = await updateServiceCatalogItem(
      req.property!,
      serviceId,
      req.user!,
      req.body
    );
    res.json({ service });
  })
);

// Eligible Stays for Service Requests
servicesRouter.get(
  '/eligible-stays',
  asyncHandler(async (req, res) => {
    const items = await listEligibleServiceStays(req.property!.id);
    res.json({ items });
  })
);

// Service Requests Routes
servicesRouter.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const serviceId = parseOptionalUuidQuery(req.query.serviceId, 'serviceId');
    const reservationId = parseOptionalUuidQuery(
      req.query.reservationId,
      'reservationId'
    );
    const assignedStaffId = parseOptionalUuidQuery(
      req.query.assignedStaffId,
      'assignedStaffId',
      { allowLiterals: ['unassigned'] }
    );
    const page = parsePositiveIntQuery(req.query.page, 'page', {
      defaultValue: 1,
      max: 10000,
    });
    const pageSize = parsePositiveIntQuery(req.query.pageSize, 'pageSize', {
      defaultValue: 25,
      max: 100,
    });

    const result = await listServiceRequests(req.property!, {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      category:
        typeof req.query.category === 'string' ? req.query.category : undefined,
      billingStatus:
        typeof req.query.billingStatus === 'string'
          ? req.query.billingStatus
          : undefined,
      serviceId,
      reservationId,
      assignedStaffId,
      dateFrom:
        typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
      dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      page,
      pageSize,
    });

    res.json(result);
  })
);

servicesRouter.get(
  '/requests/:id',
  asyncHandler(async (req, res) => {
    const requestId = parseUuidParam(req.params.id, 'service request id');
    const serviceRequest = await getServiceRequestDetail(
      req.property!.id,
      requestId
    );
    res.json({ serviceRequest });
  })
);

servicesRouter.post(
  '/requests',
  asyncHandler(async (req, res) => {
    const { serviceRequest, idempotentReplay } = await createServiceRequest(
      req.property!,
      req.user!,
      req.body
    );
    res
      .status(idempotentReplay ? 200 : 201)
      .json({ serviceRequest, idempotentReplay });
  })
);

servicesRouter.put(
  '/requests/:id',
  asyncHandler(async (req, res) => {
    const requestId = parseUuidParam(req.params.id, 'service request id');
    const serviceRequest = await updateServiceRequest(
      req.property!,
      requestId,
      req.user!,
      req.body
    );
    res.json({ serviceRequest });
  })
);

servicesRouter.post(
  '/requests/:id/status',
  asyncHandler(async (req, res) => {
    const requestId = parseUuidParam(req.params.id, 'service request id');
    const serviceRequest = await transitionServiceRequestStatus(
      req.property!,
      requestId,
      req.user!,
      req.body
    );
    res.json({ serviceRequest });
  })
);

servicesRouter.post(
  '/requests/:id/cancel',
  asyncHandler(async (req, res) => {
    const requestId = parseUuidParam(req.params.id, 'service request id');
    const serviceRequest = await cancelServiceRequest(
      req.property!,
      requestId,
      req.user!,
      req.body
    );
    res.json({ serviceRequest });
  })
);

servicesRouter.post(
  '/requests/:id/post-to-invoice',
  asyncHandler(async (req, res) => {
    const requestId = parseUuidParam(req.params.id, 'service request id');
    const result = await postServiceRequestToInvoice(
      req.property!,
      requestId,
      req.user!,
      req.body
    );
    res.status(200).json(result);
  })
);
