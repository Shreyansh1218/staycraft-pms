import { z } from 'zod';
import {
  BOOKING_SOURCES,
  CLEANING_WORKFLOW_ACTIONS,
  DIETARY_TAGS,
  EXPENSE_PAYMENT_METHODS,
  FOOD_ORDER_TYPES,
  HOUSEKEEPING_STATUSES,
  HOUSEKEEPING_TASK_STATUSES,
  HOUSEKEEPING_TASK_TYPES,
  INVENTORY_UNITS,
  INVOICE_ITEM_TYPES,
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_IMPACTS,
  MAINTENANCE_STATUSES,
  OPERATIONAL_STATUSES,
  PAYMENT_METHODS,
  RESERVATION_STATUSES,
  SERVICE_CATEGORIES,
  SERVICE_PRICING_UNITS,
  STAFF_DEPARTMENTS,
  STAFF_EMPLOYMENT_STATUSES,
  STAFF_SHIFT_TYPES,
  STOCK_ADJUSTMENT_OPERATIONS,
  TASK_PRIORITIES,
  USER_ROLES,
} from './constants.js';
import { diffDays, isValidIsoDate, isValidTimezone } from './dates.js';

const isoDateField = z
  .string()
  .trim()
  .refine(isValidIsoDate, { message: 'Must be a valid calendar date in YYYY-MM-DD format' });

const time24Field = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Must be in 24-hour HH:MM format');

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z
    .string()
    .min(6, 'Password must be at least 6 characters')
    .max(256, 'Password must not exceed 256 characters'),
});

export const propertySettingsSchema = z.object({
  name: z.string().trim().min(2, 'Property name is required').max(150),
  email: z.string().trim().email('Valid contact email is required'),
  phone: z.string().trim().min(5, 'Contact phone is required').max(50),
  website: z.string().trim().max(255).optional().default(''),
  addressLine1: z.string().trim().min(2, 'Street address is required').max(255),
  addressLine2: z.string().trim().max(255).optional().default(''),
  city: z.string().trim().min(2, 'City is required').max(100),
  stateRegion: z.string().trim().max(100).optional().default(''),
  postalCode: z.string().trim().max(30).optional().default(''),
  country: z.string().trim().min(2, 'Country is required').max(100),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimezone, { message: 'Invalid IANA timezone identifier' }),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code'),
  defaultTaxRate: z.coerce.number().min(0).max(100),
  taxName: z.string().trim().min(1, 'Tax label is required').max(40),
  standardCheckInTime: time24Field,
  standardCheckOutTime: time24Field,
  cancellationPolicy: z.string().trim().max(2000).optional().default(''),
  bookingTerms: z.string().trim().max(2000).optional().default(''),
  invoiceSettings: z
    .object({
      prefix: z.string().trim().min(1).max(12),
      nextNumber: z.coerce.number().int().min(1),
      taxId: z.string().trim().max(60).optional().default(''),
      footerNote: z.string().trim().max(500).optional().default(''),
    })
    .optional(),
});

export const createPropertySchema = propertySettingsSchema.extend({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/, 'Property code must be 2–10 uppercase letters or numbers'),
});

export const roomTypeCreateSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{2,20}$/, 'Code must be 2–20 uppercase letters, digits, - or _'),
    name: z.string().trim().min(2, 'Category name is required').max(120),
    description: z.string().trim().max(1000).optional().default(''),
    baseCapacity: z.coerce.number().int().min(1, 'Base capacity must be at least 1').max(20),
    maxCapacity: z.coerce.number().int().min(1, 'Max capacity must be at least 1').max(30),
    baseRate: z.coerce.number().min(0, 'Base nightly rate cannot be negative').max(10_000_000),
    amenities: z.array(z.string().trim().min(1).max(60)).max(30).optional().default([]),
    isActive: z.boolean().optional().default(true),
  })
  .refine((data) => data.maxCapacity >= data.baseCapacity, {
    message: 'Maximum capacity must be greater than or equal to base capacity',
    path: ['maxCapacity'],
  });

export const roomTypeUpdateSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{2,20}$/)
      .optional(),
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    baseCapacity: z.coerce.number().int().min(1).max(20).optional(),
    maxCapacity: z.coerce.number().int().min(1).max(30).optional(),
    baseRate: z.coerce.number().min(0).max(10_000_000).optional(),
    amenities: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.baseCapacity === undefined ||
      data.maxCapacity === undefined ||
      data.maxCapacity >= data.baseCapacity,
    {
      message: 'Maximum capacity must be greater than or equal to base capacity',
      path: ['maxCapacity'],
    }
  );

export const roomCreateSchema = z.object({
  roomTypeId: z.string().uuid('Select a valid room category'),
  roomNumber: z
    .string()
    .trim()
    .min(1, 'Room number is required')
    .max(30)
    .regex(/^[A-Za-z0-9-]+$/, 'Room number may only contain letters, digits, and hyphens'),
  floor: z.string().trim().min(1, 'Floor is required').max(20),
  operationalStatus: z.enum(OPERATIONAL_STATUSES).optional().default('available'),
  housekeepingStatus: z.enum(HOUSEKEEPING_STATUSES).optional().default('clean'),
  notes: z.string().trim().max(1000).optional().default(''),
  isActive: z.boolean().optional().default(true),
});

export const roomUpdateSchema = z.object({
  roomTypeId: z.string().uuid().optional(),
  roomNumber: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9-]+$/, 'Room number may only contain letters, digits, and hyphens')
    .optional(),
  floor: z.string().trim().min(1).max(20).optional(),
  operationalStatus: z.enum(OPERATIONAL_STATUSES).optional(),
  housekeepingStatus: z.enum(HOUSEKEEPING_STATUSES).optional(),
  notes: z.string().trim().max(1000).optional(),
  isActive: z.boolean().optional(),
});

export const housekeepingUpdateSchema = z.object({
  housekeepingStatus: z.enum(HOUSEKEEPING_STATUSES),
  notes: z.string().trim().max(1000).optional(),
});

export const guestCreateSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  email: z
    .string()
    .trim()
    .max(255)
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'Enter a valid email address or leave blank',
    })
    .optional()
    .default(''),
  phone: z.string().trim().min(5, 'Phone number is required').max(50),
  addressLine1: z.string().trim().max(255).optional().default(''),
  city: z.string().trim().max(100).optional().default(''),
  stateRegion: z.string().trim().max(100).optional().default(''),
  postalCode: z.string().trim().max(30).optional().default(''),
  country: z.string().trim().max(100).optional().default(''),
  idDocumentType: z.string().trim().max(50).optional().default(''),
  idDocumentNumber: z.string().trim().max(100).optional().default(''),
  vipStatus: z.boolean().optional().default(false),
  notes: z.string().trim().max(2000).optional().default(''),
});

export const guestUpdateSchema = guestCreateSchema.partial();

export const reservationCreateSchema = z
  .object({
    guestId: z.string().uuid('Select a valid guest'),
    roomId: z.string().uuid('Select a valid room'),
    arrivalDate: isoDateField,
    departureDate: isoDateField,
    adults: z.coerce.number().int().min(1, 'At least 1 adult is required').max(30),
    children: z.coerce.number().int().min(0).max(20).optional().default(0),
    nightlyRate: z.coerce.number().min(0, 'Nightly rate cannot be negative').max(10_000_000).optional(),
    discountAmount: z.coerce.number().min(0, 'Discount cannot be negative').max(10_000_000).optional().default(0),
    source: z.enum(BOOKING_SOURCES).optional().default('direct'),
    isWalkIn: z.boolean().optional().default(false),
    checkInImmediately: z.boolean().optional().default(false),
    status: z.enum(['pending', 'confirmed']).optional().default('confirmed'),
    specialRequests: z.string().trim().max(2000).optional().default(''),
    internalNotes: z.string().trim().max(2000).optional().default(''),
  })
  .refine((data) => diffDays(data.arrivalDate, data.departureDate) >= 1, {
    message: 'Departure date must be after arrival date (minimum 1 night)',
    path: ['departureDate'],
  });

export const reservationUpdateSchema = z
  .object({
    roomId: z.string().uuid().optional(),
    arrivalDate: isoDateField.optional(),
    departureDate: isoDateField.optional(),
    adults: z.coerce.number().int().min(1).max(30).optional(),
    children: z.coerce.number().int().min(0).max(20).optional(),
    nightlyRate: z.coerce.number().min(0).max(10_000_000).optional(),
    discountAmount: z.coerce.number().min(0).max(10_000_000).optional(),
    source: z.enum(BOOKING_SOURCES).optional(),
    status: z.enum(RESERVATION_STATUSES).optional(),
    specialRequests: z.string().trim().max(2000).optional(),
    internalNotes: z.string().trim().max(2000).optional(),
    editReason: z.string().trim().max(500).optional(),
  })
  .refine(
    (data) => {
      if (data.arrivalDate && data.departureDate) {
        return diffDays(data.arrivalDate, data.departureDate) >= 1;
      }
      return true;
    },
    {
      message: 'Departure date must be after arrival date (minimum 1 night)',
      path: ['departureDate'],
    }
  );

export const reservationCancelSchema = z.object({
  reason: z.string().trim().min(2, 'Please provide a brief cancellation reason').max(500),
});

export const checkInActionSchema = z.object({
  roomId: z.string().uuid().optional(),
  note: z.string().trim().max(500).optional().default(''),
});

export const checkOutActionSchema = z.object({
  note: z.string().trim().max(500).optional().default(''),
});

const nullableUuidField = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.string().uuid('Invalid identifier').nullable()
);

const nullableIsoDateField = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  isoDateField.nullable()
);

export const cleaningWorkflowActionSchema = z.object({
  action: z.enum(CLEANING_WORKFLOW_ACTIONS),
  notes: z.string().trim().max(1000).optional(),
});

export const housekeepingTaskCreateSchema = z.object({
  roomId: z.string().uuid('Select a valid room'),
  taskType: z.enum(HOUSEKEEPING_TASK_TYPES).optional().default('turnover_clean'),
  priority: z.enum(TASK_PRIORITIES).optional().default('normal'),
  dueDate: isoDateField,
  assignedTo: nullableUuidField.optional().default(null),
  reservationId: nullableUuidField.optional().default(null),
  notes: z.string().trim().max(1500).optional().default(''),
});

export const housekeepingTaskUpdateSchema = z.object({
  taskType: z.enum(HOUSEKEEPING_TASK_TYPES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  status: z.enum(HOUSEKEEPING_TASK_STATUSES).optional(),
  dueDate: isoDateField.optional(),
  assignedTo: nullableUuidField.optional(),
  notes: z.string().trim().max(1500).optional(),
});

export const housekeepingTaskTransitionSchema = z.object({
  notes: z.string().trim().max(1500).optional(),
});

export const maintenanceCreateSchema = z
  .object({
    roomId: z.string().uuid('Select a valid room'),
    category: z.enum(MAINTENANCE_CATEGORIES).optional().default('general'),
    title: z.string().trim().min(3, 'Enter a concise issue summary').max(160),
    description: z.string().trim().min(2, 'Provide a maintenance description').max(2000),
    priority: z.enum(TASK_PRIORITIES).optional().default('normal'),
    assignedTo: nullableUuidField.optional().default(null),
    operationalImpact: z.enum(MAINTENANCE_IMPACTS).optional().default('none'),
    unavailableFrom: nullableIsoDateField.optional().default(null),
    unavailableTo: nullableIsoDateField.optional().default(null),
    acknowledgeAffectedStays: z.boolean().optional().default(false),
  })
  .refine(
    (data) => {
      if (data.unavailableFrom && data.unavailableTo) {
        return diffDays(data.unavailableFrom, data.unavailableTo) >= 1;
      }
      return true;
    },
    {
      message: 'Unavailable end date must be after unavailable start date',
      path: ['unavailableTo'],
    }
  );

export const maintenanceUpdateSchema = z
  .object({
    category: z.enum(MAINTENANCE_CATEGORIES).optional(),
    title: z.string().trim().min(3).max(160).optional(),
    description: z.string().trim().min(2).max(2000).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    status: z.enum(MAINTENANCE_STATUSES).optional(),
    assignedTo: nullableUuidField.optional(),
    resolutionNotes: z.string().trim().max(2000).optional(),
    unavailableFrom: nullableIsoDateField.optional(),
    unavailableTo: nullableIsoDateField.optional(),
  })
  .refine(
    (data) => {
      if (data.unavailableFrom && data.unavailableTo) {
        return diffDays(data.unavailableFrom, data.unavailableTo) >= 1;
      }
      return true;
    },
    {
      message: 'Unavailable end date must be after unavailable start date',
      path: ['unavailableTo'],
    }
  );

export const roomOutOfServiceSchema = z
  .object({
    operationalStatus: z.enum(['maintenance', 'out_of_service']).optional().default('out_of_service'),
    category: z.enum(MAINTENANCE_CATEGORIES).optional().default('general'),
    title: z.string().trim().min(3, 'Provide a reason for placing room out of service').max(160),
    description: z.string().trim().max(2000).optional().default(''),
    priority: z.enum(TASK_PRIORITIES).optional().default('high'),
    assignedTo: nullableUuidField.optional().default(null),
    unavailableFrom: nullableIsoDateField.optional().default(null),
    unavailableTo: nullableIsoDateField.optional().default(null),
    acknowledgeAffectedStays: z.boolean().optional().default(false),
  })
  .refine(
    (data) => {
      if (data.unavailableFrom && data.unavailableTo) {
        return diffDays(data.unavailableFrom, data.unavailableTo) >= 1;
      }
      return true;
    },
    {
      message: 'Unavailable end date must be after unavailable start date',
      path: ['unavailableTo'],
    }
  );

export const roomRestoreServiceSchema = z.object({
  housekeepingStatus: z.enum(['dirty', 'clean']).optional().default('dirty'),
  resolutionNotes: z
    .string()
    .trim()
    .min(2, 'Provide brief resolution notes before restoring room to service')
    .max(2000),
});

// Phase 3: Billing, Invoices & Payments Schemas

function containsRawPaymentCardNumber(text: string): boolean {
  // Match groups of digits separated only by spaces or hyphens totaling 13–19 digits
  const candidates = text.match(/(?:\d[ -]?){13,19}/g);
  if (!candidates) return false;
  for (const raw of candidates) {
    // Skip if framed by letters/underscores like TXN_20261022123456
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    // Luhn check for payment card PANs
    let sum = 0;
    let shouldDouble = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let digit = Number(digits[i]);
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }
    if (sum % 10 === 0) {
      return true;
    }
  }
  return false;
}

const strictMonetaryNumber = (fieldLabel: string, minVal = 0) =>
  z
    .preprocess((val) => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string' && val.trim() !== '') return Number(val.trim());
      return Number.NaN;
    }, z.number({ invalid_type_error: `${fieldLabel} must be a valid amount` }))
    .refine((v) => Number.isFinite(v), { message: `${fieldLabel} must be a valid number` })
    .refine((v) => v >= minVal, {
      message:
        minVal > 0
          ? `${fieldLabel} must be at least ${minVal.toFixed(2)}`
          : `${fieldLabel} cannot be negative`,
    })
    .refine((v) => v <= 10_000_000, {
      message: `${fieldLabel} exceeds maximum supported amount`,
    })
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, {
      message: `${fieldLabel} can have at most 2 decimal places`,
    });

export const invoiceFromReservationSchema = z.object({
  issueImmediately: z.boolean().optional().default(false),
  dueDate: nullableIsoDateField.optional().default(null),
  notes: z.string().trim().max(2000).optional(),
});

export const invoiceUpdateSchema = z.object({
  dueDate: nullableIsoDateField.optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const invoiceLineItemCreateSchema = z.object({
  itemType: z.enum(INVOICE_ITEM_TYPES),
  description: z.string().trim().min(2, 'Item description is required').max(255),
  quantity: z
    .preprocess((val) => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string' && val.trim() !== '') return Number(val.trim());
      return 1;
    }, z.number())
    .refine((v) => Number.isFinite(v) && v > 0 && v <= 10_000, {
      message: 'Quantity must be greater than 0',
    })
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, {
      message: 'Quantity can have at most 2 decimal places',
    })
    .optional()
    .default(1),
  unitPrice: strictMonetaryNumber('Unit price', 0.01),
  taxRate: z
    .preprocess((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      return typeof val === 'number' ? val : Number(String(val).trim());
    }, z.number().min(0).max(100).optional()),
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
});

export const paymentCreateSchema = z.object({
  amount: strictMonetaryNumber('Payment amount', 0.01),
  paymentMethod: z.enum(PAYMENT_METHODS),
  paymentDate: nullableIsoDateField.optional().default(null),
  paymentReference: z
    .string()
    .trim()
    .max(60, 'Reference must be 60 characters or fewer')
    .refine((v) => !containsRawPaymentCardNumber(v), {
      message:
        'Do not enter full payment card numbers. Record only a masked last-4 or terminal receipt reference.',
    })
    .optional()
    .default(''),
  notes: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => !containsRawPaymentCardNumber(v), {
      message:
        'Do not enter full payment card numbers in payment notes.',
    })
    .optional()
    .default(''),
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
});

export const invoiceVoidSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Provide a brief reason for voiding this invoice')
    .max(500),
});

// Phase 4: Food Ordering & Restaurant Management Schemas

export const foodCategoryCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Category code must be at least 2 characters')
    .max(30)
    .regex(/^[A-Z0-9_-]+$/, 'Category code may contain only letters, numbers, hyphens, and underscores'),
  name: z.string().trim().min(2, 'Category name is required').max(120),
  description: z.string().trim().max(500).optional().default(''),
  displayOrder: z
    .preprocess((v) => (v === undefined || v === '' ? 0 : Number(v)), z.number().int().min(0).max(9999))
    .optional()
    .default(0),
  isActive: z.boolean().optional().default(true),
});

export const foodCategoryUpdateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(30)
    .regex(/^[A-Z0-9_-]+$/)
    .optional(),
  name: z.string().trim().min(2, 'Category name is required').max(120).optional(),
  description: z.string().trim().max(500).optional(),
  displayOrder: z
    .preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(0).max(9999).optional()),
  isActive: z.boolean().optional(),
});

export const foodMenuItemCreateSchema = z.object({
  categoryId: z.string().uuid('Select a valid food category'),
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Menu SKU must be at least 2 characters')
    .max(40)
    .regex(/^[A-Z0-9_-]+$/, 'SKU may contain only letters, numbers, hyphens, and underscores'),
  name: z.string().trim().min(2, 'Menu item name is required').max(160),
  description: z.string().trim().max(600).optional().default(''),
  price: strictMonetaryNumber('Menu item price', 0.01),
  dietaryTag: z.enum(DIETARY_TAGS).optional().default('veg'),
  prepTimeMinutes: z
    .preprocess((val) => {
      if (val === undefined || val === null || val === '') return null;
      return Number(val);
    }, z.number().int().min(1).max(240).nullable())
    .optional()
    .default(null),
  isAvailable: z.boolean().optional().default(true),
  isActive: z.boolean().optional().default(true),
  displayOrder: z
    .preprocess((v) => (v === undefined || v === '' ? 0 : Number(v)), z.number().int().min(0).max(9999))
    .optional()
    .default(0),
});

export const foodMenuItemUpdateSchema = z.object({
  categoryId: z.string().uuid('Select a valid food category').optional(),
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9_-]+$/)
    .optional(),
  name: z.string().trim().min(2, 'Menu item name is required').max(160).optional(),
  description: z.string().trim().max(600).optional(),
  price: strictMonetaryNumber('Menu item price', 0.01).optional(),
  dietaryTag: z.enum(DIETARY_TAGS).optional(),
  prepTimeMinutes: z
    .preprocess((val) => {
      if (val === undefined) return undefined;
      if (val === null || val === '') return null;
      return Number(val);
    }, z.number().int().min(1).max(240).nullable().optional()),
  isAvailable: z.boolean().optional(),
  isActive: z.boolean().optional(),
  displayOrder: z
    .preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(0).max(9999).optional()),
});

export const foodOrderItemInputSchema = z.object({
  menuItemId: z.string().uuid('Invalid menu item ID'),
  quantity: z
    .preprocess((val) => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string' && val.trim() !== '') return Number(val.trim());
      return Number.NaN;
    }, z.number().int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(500, 'Quantity cannot exceed 500')),
  specialInstructions: z.string().trim().max(500).optional().default(''),
});

export const foodOrderCreateSchema = z
  .object({
    orderType: z.enum(FOOD_ORDER_TYPES),
    tableLabel: z.string().trim().max(60).optional().default(''),
    customerName: z.string().trim().max(160).optional().default(''),
    reservationId: nullableUuidField.optional().default(null),
    roomId: nullableUuidField.optional().default(null),
    guestId: nullableUuidField.optional().default(null),
    notes: z.string().trim().max(1000).optional().default(''),
    items: z
      .array(foodOrderItemInputSchema)
      .min(1, 'Add at least one menu item to place an order')
      .max(100, 'An order cannot exceed 100 line items'),
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.orderType === 'room_service' && !data.reservationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reservationId'],
        message: 'Select an in-house checked-in reservation for Room Service orders',
      });
    }
    if (data.orderType !== 'room_service' && (data.reservationId || data.roomId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orderType'],
        message: 'Only Room Service orders may link to a guest reservation or room',
      });
    }
    if (data.orderType === 'restaurant' && !data.tableLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tableLabel'],
        message: 'Enter a table or dining area label for Restaurant / Dine-In orders',
      });
    }
  });

export const foodOrderUpdateSchema = z.object({
  tableLabel: z.string().trim().max(60).optional(),
  customerName: z.string().trim().max(160).optional(),
  notes: z.string().trim().max(1000).optional(),
  items: z
    .array(foodOrderItemInputSchema)
    .min(1, 'Order must retain at least one item')
    .max(100)
    .optional(),
});

export const foodOrderStatusUpdateSchema = z.object({
  status: z.enum(['preparing', 'ready', 'served']),
  note: z.string().trim().max(500).optional().default(''),
});

export const foodOrderCancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Provide a brief cancellation reason')
    .max(500),
});

export const foodOrderPostToInvoiceSchema = z.object({
  createDraftInvoiceIfMissing: z.boolean().optional().default(true),
  note: z.string().trim().max(500).optional().default(''),
});

export const foodOrderReverseChargeSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Provide an audit reason for reversing this posted folio charge')
    .max(500),
  cancelOrder: z.boolean().optional().default(false),
});

// Phase 5: Inventory, Suppliers, Stock Receipts, Adjustments & Recipes Schemas

const strictStockQuantity = (fieldLabel: string, minVal = 0.01) =>
  z
    .preprocess((val) => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string' && val.trim() !== '') return Number(val.trim());
      return Number.NaN;
    }, z.number({ invalid_type_error: `${fieldLabel} must be a valid quantity` }))
    .refine((v) => Number.isFinite(v), { message: `${fieldLabel} must be a valid number` })
    .refine((v) => v >= minVal, {
      message:
        minVal > 0
          ? `${fieldLabel} must be at least ${minVal.toFixed(2)}`
          : `${fieldLabel} cannot be negative`,
    })
    .refine((v) => v <= 1_000_000, {
      message: `${fieldLabel} exceeds maximum supported quantity`,
    })
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, {
      message: `${fieldLabel} can have at most 2 decimal places`,
    });

const optionalSupplierEmailField = z
  .string()
  .trim()
  .max(255)
  .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
    message: 'Enter a valid supplier email address or leave blank',
  });

export const supplierCreateSchema = z.object({
  code: z
    .preprocess(
      (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().toUpperCase()),
      z
        .string()
        .min(2, 'Supplier code must be at least 2 characters')
        .max(40)
        .regex(/^[A-Z0-9_-]+$/, 'Supplier code may contain only letters, numbers, hyphens, and underscores')
        .nullable()
    )
    .optional()
    .default(null),
  name: z.string().trim().min(2, 'Supplier name is required').max(150),
  contactPerson: z.string().trim().max(150).optional().default(''),
  email: optionalSupplierEmailField.optional().default(''),
  phone: z.string().trim().max(50).optional().default(''),
  address: z.string().trim().max(1000).optional().default(''),
  taxIdentifier: z.string().trim().max(60).optional().default(''),
  paymentTerms: z.string().trim().max(120).optional().default(''),
  notes: z.string().trim().max(1000).optional().default(''),
  isActive: z.boolean().optional().default(true),
});

export const supplierUpdateSchema = z.object({
  code: z
    .preprocess((v) => {
      if (v === undefined) return undefined;
      if (v === null || String(v).trim() === '') return null;
      return String(v).trim().toUpperCase();
    }, z.string().min(2).max(40).regex(/^[A-Z0-9_-]+$/).nullable().optional()),
  name: z.string().trim().min(2, 'Supplier name is required').max(150).optional(),
  contactPerson: z.string().trim().max(150).optional(),
  email: optionalSupplierEmailField.optional(),
  phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(1000).optional(),
  taxIdentifier: z.string().trim().max(60).optional(),
  paymentTerms: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
  isActive: z.boolean().optional(),
});

export const inventoryCategoryCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Category code must be at least 2 characters')
    .max(40)
    .regex(/^[A-Z0-9_-]+$/, 'Category code may contain only letters, numbers, hyphens, and underscores'),
  name: z.string().trim().min(2, 'Category name is required').max(120),
  description: z.string().trim().max(500).optional().default(''),
  displayOrder: z
    .preprocess((v) => (v === undefined || v === '' ? 0 : Number(v)), z.number().int().min(0).max(9999))
    .optional()
    .default(0),
  isActive: z.boolean().optional().default(true),
});

export const inventoryCategoryUpdateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9_-]+$/)
    .optional(),
  name: z.string().trim().min(2, 'Category name is required').max(120).optional(),
  description: z.string().trim().max(500).optional(),
  displayOrder: z
    .preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(0).max(9999).optional()),
  isActive: z.boolean().optional(),
});

export const inventoryItemCreateSchema = z.object({
  categoryId: z.string().uuid('Select a valid inventory category'),
  supplierId: nullableUuidField.optional().default(null),
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Item SKU must be at least 2 characters')
    .max(50)
    .regex(/^[A-Z0-9_-]+$/, 'SKU may contain only letters, numbers, hyphens, and underscores'),
  name: z.string().trim().min(2, 'Inventory item name is required').max(150),
  description: z.string().trim().max(600).optional().default(''),
  unit: z.enum(INVENTORY_UNITS).optional().default('pcs'),
  openingStock: strictStockQuantity('Opening stock', 0).optional().default(0),
  reorderLevel: strictStockQuantity('Reorder threshold', 0).optional().default(0),
  unitCost: strictMonetaryNumber('Unit cost', 0).optional().default(0),
  isActive: z.boolean().optional().default(true),
});

export const inventoryItemUpdateSchema = z.object({
  categoryId: z.string().uuid('Select a valid inventory category').optional(),
  supplierId: nullableUuidField.optional(),
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(50)
    .regex(/^[A-Z0-9_-]+$/)
    .optional(),
  name: z.string().trim().min(2, 'Inventory item name is required').max(150).optional(),
  description: z.string().trim().max(600).optional(),
  unit: z.enum(INVENTORY_UNITS).optional(),
  reorderLevel: strictStockQuantity('Reorder threshold', 0).optional(),
  unitCost: strictMonetaryNumber('Unit cost', 0).optional(),
  isActive: z.boolean().optional(),
});

export const inventoryReceiptLineInputSchema = z.object({
  productId: z.string().uuid('Select a valid inventory item'),
  quantity: strictStockQuantity('Received quantity', 0.01),
  unitCost: strictMonetaryNumber('Unit cost', 0).optional().default(0),
});

export const inventoryReceiptCreateSchema = z.object({
  supplierId: nullableUuidField.optional().default(null),
  vendorInvoiceNumber: z.string().trim().max(100).optional().default(''),
  receiptDate: nullableIsoDateField.optional().default(null),
  notes: z.string().trim().max(1000).optional().default(''),
  items: z
    .array(inventoryReceiptLineInputSchema)
    .min(1, 'Add at least one received item line')
    .max(100, 'A single receipt cannot exceed 100 item lines'),
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
});

export const stockAdjustmentCreateSchema = z.object({
  productId: z.string().uuid('Select a valid inventory item'),
  operation: z.enum(STOCK_ADJUSTMENT_OPERATIONS),
  quantity: strictStockQuantity('Adjustment quantity', 0.01),
  reason: z
    .string()
    .trim()
    .min(3, 'Provide a clear audit reason (minimum 3 characters) for this stock adjustment')
    .max(500),
  referenceNote: z.string().trim().max(500).optional().default(''),
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
});

export const menuItemRecipeIngredientInputSchema = z.object({
  productId: z.string().uuid('Select a valid inventory ingredient'),
  quantityRequired: strictStockQuantity('Recipe quantity required', 0.01),
});

export const menuItemRecipeUpdateSchema = z
  .object({
    ingredients: z
      .array(menuItemRecipeIngredientInputSchema)
      .max(50, 'A menu item recipe cannot exceed 50 ingredients'),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.ingredients.forEach((ing, idx) => {
      if (seen.has(ing.productId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ingredients', idx, 'productId'],
          message: 'Duplicate ingredient in recipe; combine quantities onto a single line',
        });
      }
      seen.add(ing.productId);
    });
  });

// Phase 6: Expense Categories, Operating Expenses & Reports Schemas

export const expenseCategoryCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Category code must be at least 2 characters')
    .max(40)
    .regex(
      /^[A-Z0-9_-]+$/,
      'Category code may contain only letters, numbers, hyphens, and underscores'
    ),
  name: z.string().trim().min(2, 'Category name is required').max(120),
  description: z.string().trim().max(500).optional().default(''),
  displayOrder: z
    .preprocess(
      (v) => (v === undefined || v === '' ? 0 : Number(v)),
      z.number().int().min(0).max(9999)
    )
    .optional()
    .default(0),
  isActive: z.boolean().optional().default(true),
});

export const expenseCategoryUpdateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Category code must be at least 2 characters')
    .max(40)
    .regex(
      /^[A-Z0-9_-]+$/,
      'Category code may contain only letters, numbers, hyphens, and underscores'
    )
    .optional(),
  name: z.string().trim().min(2, 'Category name is required').max(120).optional(),
  description: z.string().trim().max(500).optional(),
  displayOrder: z
    .preprocess(
      (v) => (v === undefined || v === '' ? undefined : Number(v)),
      z.number().int().min(0).max(9999).optional()
    ),
  isActive: z.boolean().optional(),
});

export const expenseCreateSchema = z
  .object({
    categoryId: z.string().uuid('Select a valid expense category'),
    supplierId: nullableUuidField.optional().default(null),
    vendorName: z.string().trim().max(160).optional().default(''),
    title: z.string().trim().min(2, 'Expense title / summary is required').max(200),
    description: z.string().trim().max(1000).optional().default(''),
    amount: strictMonetaryNumber('Expense amount', 0.01),
    taxAmount: strictMonetaryNumber('Tax portion', 0).optional().default(0),
    expenseDate: isoDateField,
    paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS).optional().default('bank_transfer'),
    referenceNumber: z.string().trim().max(80).optional().default(''),
    notes: z.string().trim().max(1000).optional().default(''),
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.taxAmount > data.amount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['taxAmount'],
        message: 'Included tax portion cannot exceed total expense amount',
      });
    }
  });

export const expenseUpdateSchema = z
  .object({
    categoryId: z.string().uuid('Select a valid expense category').optional(),
    supplierId: nullableUuidField.optional(),
    vendorName: z.string().trim().max(160).optional(),
    title: z.string().trim().min(2, 'Expense title / summary is required').max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    amount: strictMonetaryNumber('Expense amount', 0.01).optional(),
    taxAmount: strictMonetaryNumber('Tax portion', 0).optional(),
    expenseDate: isoDateField.optional(),
    paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS).optional(),
    referenceNumber: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.amount !== undefined &&
      data.taxAmount !== undefined &&
      data.taxAmount > data.amount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['taxAmount'],
        message: 'Included tax portion cannot exceed total expense amount',
      });
    }
  });

export const expenseVoidSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Provide a clear audit reason (minimum 3 characters) to void this expense')
    .max(500),
});

// Phase 7: Services Catalog, Service Requests, Staff Profiles & User Management Schemas

const optionalStaffEmailField = z
  .string()
  .trim()
  .max(255)
  .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
    message: 'Enter a valid email address or leave blank',
  });

const optionalIsoTimestampField = z
  .preprocess((val) => {
    if (val === undefined || val === null || String(val).trim() === '') return null;
    const str = String(val).trim();
    const parsed = new Date(str);
    return Number.isNaN(parsed.getTime()) ? '__INVALID_DATE__' : parsed.toISOString();
  }, z.string().nullable())
  .refine((v) => v !== '__INVALID_DATE__', {
    message: 'Enter a valid request date and time',
  });

const strictServiceQuantity = (fieldLabel: string) =>
  z
    .preprocess((val) => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string' && val.trim() !== '') return Number(val.trim());
      return Number.NaN;
    }, z.number({ invalid_type_error: `${fieldLabel} must be a valid quantity` }))
    .refine((v) => Number.isFinite(v), { message: `${fieldLabel} must be a valid number` })
    .refine((v) => v >= 0.01, { message: `${fieldLabel} must be at least 0.01` })
    .refine((v) => v <= 10_000, { message: `${fieldLabel} cannot exceed 10,000` })
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, {
      message: `${fieldLabel} can have at most 2 decimal places`,
    });

export const serviceCatalogCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Service code must be at least 2 characters')
    .max(30)
    .regex(
      /^[A-Z0-9_-]+$/,
      'Service code may contain only letters, numbers, hyphens, and underscores'
    ),
  name: z.string().trim().min(2, 'Service name is required').max(150),
  description: z.string().trim().max(1000).optional().default(''),
  category: z.enum(SERVICE_CATEGORIES),
  unitPrice: strictMonetaryNumber('Service price', 0),
  pricingUnit: z.enum(SERVICE_PRICING_UNITS).optional().default('per_request'),
  usePropertyTaxRate: z.boolean().optional().default(true),
  taxRate: z
    .preprocess((val) => {
      if (val === undefined || val === null || val === '') return 0;
      return typeof val === 'number' ? val : Number(String(val).trim());
    }, z.number().min(0, 'Tax rate cannot be negative').max(100, 'Tax rate cannot exceed 100%'))
    .optional()
    .default(0),
  isActive: z.boolean().optional().default(true),
});

export const serviceCatalogUpdateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Service code must be at least 2 characters')
    .max(30)
    .regex(
      /^[A-Z0-9_-]+$/,
      'Service code may contain only letters, numbers, hyphens, and underscores'
    )
    .optional(),
  name: z.string().trim().min(2, 'Service name is required').max(150).optional(),
  description: z.string().trim().max(1000).optional(),
  category: z.enum(SERVICE_CATEGORIES).optional(),
  unitPrice: strictMonetaryNumber('Service price', 0).optional(),
  pricingUnit: z.enum(SERVICE_PRICING_UNITS).optional(),
  usePropertyTaxRate: z.boolean().optional(),
  taxRate: z
    .preprocess((val) => {
      if (val === undefined) return undefined;
      return typeof val === 'number' ? val : Number(String(val).trim());
    }, z.number().min(0, 'Tax rate cannot be negative').max(100, 'Tax rate cannot exceed 100%').optional()),
  isActive: z.boolean().optional(),
});

export const serviceRequestCreateSchema = z
  .object({
    serviceId: z.string().uuid('Select a valid hotel service'),
    reservationId: nullableUuidField.optional().default(null),
    guestId: nullableUuidField.optional().default(null),
    roomId: nullableUuidField.optional().default(null),
    assignedStaffId: nullableUuidField.optional().default(null),
    quantity: strictServiceQuantity('Quantity').optional().default(1),
    requestedFor: optionalIsoTimestampField.optional().default(null),
    notes: z.string().trim().max(1000).optional().default(''),
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.reservationId && !data.guestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reservationId'],
        message: 'Associate the service request with an active reservation or registered guest',
      });
    }
  });

export const serviceRequestUpdateSchema = z.object({
  assignedStaffId: nullableUuidField.optional(),
  quantity: strictServiceQuantity('Quantity').optional(),
  requestedFor: optionalIsoTimestampField.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const serviceRequestStatusUpdateSchema = z.object({
  status: z.enum(['in_progress', 'completed']),
  assignedStaffId: nullableUuidField.optional(),
  note: z.string().trim().max(500).optional().default(''),
});

export const serviceRequestCancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Provide a clear reason (minimum 3 characters) to cancel this service request')
    .max(500),
});

export const serviceRequestPostToInvoiceSchema = z.object({
  invoiceId: nullableUuidField.optional().default(null),
  createDraftInvoiceIfMissing: z.boolean().optional().default(true),
  note: z.string().trim().max(500).optional().default(''),
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
});

export const staffProfileCreateSchema = z.object({
  employeeCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Employee code must be at least 2 characters')
    .max(40)
    .regex(
      /^[A-Z0-9_-]+$/,
      'Employee code may contain only letters, numbers, hyphens, and underscores'
    ),
  fullName: z.string().trim().min(2, 'Staff full name is required').max(150),
  email: optionalStaffEmailField.optional().default(''),
  phone: z.string().trim().max(50).optional().default(''),
  department: z.enum(STAFF_DEPARTMENTS),
  jobTitle: z.string().trim().min(2, 'Job title is required').max(120),
  employmentStatus: z.enum(STAFF_EMPLOYMENT_STATUSES).optional().default('active'),
  shiftType: z.enum(STAFF_SHIFT_TYPES).optional().default('day'),
  joinedOn: nullableIsoDateField.optional().default(null),
  emergencyContact: z.string().trim().max(160).optional().default(''),
  notes: z.string().trim().max(1000).optional().default(''),
  userId: nullableUuidField.optional().default(null),
});

export const staffProfileUpdateSchema = z.object({
  employeeCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Employee code must be at least 2 characters')
    .max(40)
    .regex(
      /^[A-Z0-9_-]+$/,
      'Employee code may contain only letters, numbers, hyphens, and underscores'
    )
    .optional(),
  fullName: z.string().trim().min(2, 'Staff full name is required').max(150).optional(),
  email: optionalStaffEmailField.optional(),
  phone: z.string().trim().max(50).optional(),
  department: z.enum(STAFF_DEPARTMENTS).optional(),
  jobTitle: z.string().trim().min(2, 'Job title is required').max(120).optional(),
  employmentStatus: z.enum(STAFF_EMPLOYMENT_STATUSES).optional(),
  shiftType: z.enum(STAFF_SHIFT_TYPES).optional(),
  joinedOn: nullableIsoDateField.optional(),
  emergencyContact: z.string().trim().max(160).optional(),
  notes: z.string().trim().max(1000).optional(),
  userId: nullableUuidField.optional(),
});

export const managedUserCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(255),
  fullName: z.string().trim().min(2, 'Full name is required').max(150),
  phone: z.string().trim().max(50).optional().default(''),
  role: z.enum(USER_ROLES),
  password: z
    .string()
    .min(8, 'Initial password must be at least 8 characters long')
    .max(128),
  isActive: z.boolean().optional().default(true),
  propertyIds: z
    .array(z.string().uuid('Invalid property identifier'))
    .max(50)
    .optional()
    .default([]),
  defaultPropertyId: nullableUuidField.optional().default(null),
});

export const managedUserUpdateSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address')
    .max(255)
    .optional(),
  fullName: z.string().trim().min(2, 'Full name is required').max(150).optional(),
  phone: z.string().trim().max(50).optional(),
  role: z.enum(USER_ROLES).optional(),
  isActive: z.boolean().optional(),
});

export const managedUserPropertyAccessSchema = z
  .object({
    propertyIds: z
      .array(z.string().uuid('Invalid property identifier'))
      .max(50, 'Cannot assign more than 50 properties at once'),
    defaultPropertyId: nullableUuidField.optional().default(null),
  })
  .superRefine((data, ctx) => {
    const unique = new Set(data.propertyIds);
    if (unique.size !== data.propertyIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['propertyIds'],
        message: 'Duplicate property identifiers are not allowed',
      });
    }
    if (data.defaultPropertyId && !unique.has(data.defaultPropertyId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultPropertyId'],
        message: 'Default property must be one of the assigned properties',
      });
    }
  });

export const managedUserResetPasswordSchema = z.object({
  newPassword: z
    .string()
    .min(8, 'New password must be at least 8 characters long')
    .max(128),
});

// Guest Self-Service Food Ordering & Account Security Schemas

export const guestFoodQrConfigUpdateSchema = z.object({
  enabled: z.boolean(),
});

export const guestFoodOrderItemInputSchema = z
  .object({
    menuItemId: z.string().uuid('Invalid menu item identifier'),
    quantity: z.preprocess(
      (val) => {
        if (typeof val === 'number') return val;
        if (typeof val === 'string' && val.trim() !== '') return Number(val.trim());
        return Number.NaN;
      },
      z
        .number()
        .int('Quantity must be a whole number')
        .min(1, 'Quantity must be at least 1')
        .max(50, 'Quantity per item cannot exceed 50')
    ),
    specialInstructions: z.string().trim().max(300).optional().default(''),
  })
  .strict();

export const guestFoodOrderCreateSchema = z
  .object({
    roomNumber: z
      .string()
      .trim()
      .min(1, 'Enter your room number')
      .max(30, 'Room number cannot exceed 30 characters')
      .regex(/^[A-Za-z0-9 _-]+$/, 'Enter a valid room number'),
    items: z
      .array(guestFoodOrderItemInputSchema)
      .min(1, 'Select at least one menu item to place your order')
      .max(50, 'An order cannot exceed 50 items'),
    notes: z.string().trim().max(500).optional().default(''),
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const accountChangeEmailSchema = z.object({
  newEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address')
    .max(255),
  currentPassword: z
    .string()
    .min(1, 'Enter your current password to confirm this change')
    .max(256),
});

export const accountChangePasswordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, 'Enter your current password')
      .max(256),
    newPassword: z
      .string()
      .min(8, 'New password must be at least 8 characters long')
      .max(128),
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    path: ['newPassword'],
    message: 'New password must be different from your current password',
  });

export const forgotPasswordRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address')
    .max(255),
});

export const resetPasswordConfirmSchema = z.object({
  token: z
    .string()
    .trim()
    .min(32, 'Invalid or malformed password reset token')
    .max(128, 'Invalid or malformed password reset token')
    .regex(/^[a-fA-F0-9]+$/, 'Invalid or malformed password reset token'),
  newPassword: z
    .string()
    .min(8, 'New password must be at least 8 characters long')
    .max(128),
});






