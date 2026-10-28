import { ZodError } from 'zod';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, code = 'APP_ERROR', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, message, 'BAD_REQUEST', details);
  }

  static invalidIdentifier(message = 'Invalid identifier format', details?: unknown) {
    return new AppError(400, message, 'INVALID_IDENTIFIER', details);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppError(401, message, code);
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new AppError(403, message, 'FORBIDDEN');
  }

  static notFound(message = 'Requested resource was not found') {
    return new AppError(404, message, 'NOT_FOUND');
  }

  static conflict(message: string, details?: unknown) {
    return new AppError(409, message, 'CONFLICT', details);
  }
}

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

export function parseUuidParam(raw: unknown, label = 'id'): string {
  if (typeof raw !== 'string' || !UUID_REGEX.test(raw.trim())) {
    throw AppError.invalidIdentifier(`Invalid ${label}: must be a valid UUID`);
  }
  return raw.trim();
}

export function parseOptionalUuidQuery(
  raw: unknown,
  label: string,
  options?: { allowLiterals?: readonly string[] }
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw AppError.invalidIdentifier(`Invalid ${label}: must be a valid UUID`);
  }
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (options?.allowLiterals?.includes(trimmed)) {
    return trimmed;
  }
  if (!UUID_REGEX.test(trimmed)) {
    throw AppError.invalidIdentifier(`Invalid ${label}: must be a valid UUID`);
  }
  return trimmed;
}

export function parsePositiveIntQuery(
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

export function normalizeDatabaseError(err: unknown): AppError | null {
  if (!err || typeof err !== 'object') return null;
  const pgErr = err as { code?: string; constraint?: string; detail?: string; message?: string };

  if (pgErr.code === '22P02') {
    return AppError.invalidIdentifier('Invalid identifier format.');
  }

  if (pgErr.code === '22003') {
    return AppError.badRequest('Numeric value is out of supported range.');
  }

  if (pgErr.code === '23P01') {
    // Exclusion violation (room date overlap)
    return AppError.conflict(
      'Selected room is already booked for one or more nights in this date range.',
      { constraint: pgErr.constraint }
    );
  }

  if (pgErr.code === '23505') {
    if (pgErr.constraint === 'uq_rooms_property_room_number') {
      return AppError.conflict('A room with this room number already exists in this property.');
    }
    if (
      pgErr.constraint === 'uq_room_types_property_code' ||
      pgErr.constraint === 'uq_room_types_property_name'
    ) {
      return AppError.conflict('A room category with this name or code already exists in this property.');
    }
    if (pgErr.constraint?.includes('properties_code')) {
      return AppError.conflict('A property with this code already exists.');
    }
    if (pgErr.constraint?.includes('users_email')) {
      return AppError.conflict('A user with this email already exists.');
    }
    if (pgErr.constraint === 'uq_invoices_property_number') {
      return AppError.conflict('An invoice with this invoice number already exists in this property.');
    }
    if (pgErr.constraint === 'uq_invoices_active_reservation') {
      return AppError.conflict('An active invoice already exists for this reservation.');
    }
    if (pgErr.constraint === 'uq_invoice_items_source_key') {
      return AppError.conflict('This folio charge has already been posted to the invoice.');
    }
    if (pgErr.constraint === 'uq_payments_invoice_idempotency') {
      return AppError.conflict('This payment submission has already been recorded.');
    }
    if (
      pgErr.constraint === 'uq_food_categories_property_code' ||
      pgErr.constraint === 'uq_food_categories_property_lower_name'
    ) {
      return AppError.conflict('A food category with this code or name already exists in this property.');
    }
    if (pgErr.constraint === 'uq_food_menu_items_property_sku') {
      return AppError.conflict('A menu item with this SKU already exists in this property.');
    }
    if (pgErr.constraint === 'uq_food_orders_property_reference') {
      return AppError.conflict('A food order with this order reference already exists in this property.');
    }
    if (pgErr.constraint === 'uq_food_orders_property_idempotency') {
      return AppError.conflict('Duplicate food order submission detected for this request.');
    }
    if (
      pgErr.constraint === 'uq_service_charges_active_food_order' ||
      pgErr.constraint === 'uq_invoice_items_food_order_global'
    ) {
      return AppError.conflict('This food order charge has already been posted to a guest invoice.');
    }
    if (
      pgErr.constraint === 'uq_inventory_categories_property_code' ||
      pgErr.constraint === 'uq_inventory_categories_property_lower_name'
    ) {
      return AppError.conflict(
        'An inventory category with this code or name already exists in this property.'
      );
    }
    if (
      pgErr.constraint === 'uq_suppliers_property_code' ||
      pgErr.constraint === 'uq_suppliers_property_lower_name'
    ) {
      return AppError.conflict(
        'A supplier with this code or name already exists in this property.'
      );
    }
    if (pgErr.constraint === 'uq_inventory_products_property_sku') {
      return AppError.conflict('An inventory item with this SKU already exists in this property.');
    }
    if (pgErr.constraint === 'uq_inventory_receipts_property_number') {
      return AppError.conflict('A stock receipt with this receipt number already exists in this property.');
    }
    if (pgErr.constraint === 'uq_inventory_receipts_property_idempotency') {
      return AppError.conflict('Duplicate stock receipt submission detected for this request.');
    }
    if (pgErr.constraint === 'uq_stock_movements_property_source_key') {
      return AppError.conflict('Duplicate inventory movement submission detected for this request.');
    }
    if (pgErr.constraint === 'uq_menu_item_ingredient') {
      return AppError.conflict('This ingredient is already linked to the menu item recipe.');
    }
    if (
      pgErr.constraint === 'uq_expense_categories_property_code' ||
      pgErr.constraint === 'uq_expense_categories_property_lower_name'
    ) {
      return AppError.conflict(
        'An expense category with this code or name already exists in this property.'
      );
    }
    if (pgErr.constraint === 'uq_expenses_property_number') {
      return AppError.conflict(
        'An expense voucher with this number already exists in this property.'
      );
    }
    if (pgErr.constraint === 'uq_expenses_property_idempotency') {
      return AppError.conflict('Duplicate expense submission detected for this request.');
    }
    if (
      pgErr.constraint === 'uq_service_catalog_property_code' ||
      pgErr.constraint === 'uq_service_catalog_property_lower_name'
    ) {
      return AppError.conflict(
        'A hotel service with this code or name already exists in this property.'
      );
    }
    if (pgErr.constraint === 'uq_service_requests_property_number') {
      return AppError.conflict(
        'A service request with this request number already exists in this property.'
      );
    }
    if (pgErr.constraint === 'uq_service_requests_property_idempotency') {
      return AppError.conflict(
        'Duplicate service request submission detected for this request.'
      );
    }
    if (
      pgErr.constraint === 'uq_service_charges_active_service_request' ||
      pgErr.constraint === 'uq_invoice_items_service_request_global'
    ) {
      return AppError.conflict(
        'This completed service request charge has already been posted to a guest invoice.'
      );
    }
    if (pgErr.constraint === 'uq_property_staff_profiles_property_code') {
      return AppError.conflict(
        'A staff profile with this employee code already exists in this property.'
      );
    }
    if (pgErr.constraint === 'uq_property_staff_profiles_property_user') {
      return AppError.conflict(
        'Selected system user account is already linked to another staff profile in this property.'
      );
    }
    return AppError.conflict('A record with these unique values already exists.');
  }

  if (pgErr.code === '23503') {
    return AppError.badRequest('Referenced record does not exist or cannot be removed while linked.');
  }

  if (pgErr.code === '23514') {
    if (pgErr.constraint === 'chk_inventory_products_non_negative_stock') {
      return AppError.conflict('Insufficient stock available to complete this operation.');
    }
    return AppError.badRequest('Validation constraint failed for the submitted values.');
  }

  if (
    pgErr.code === 'P0001' &&
    pgErr.message?.includes('Inventory stock movement history is immutable')
  ) {
    return AppError.conflict(
      'Inventory stock movement history is immutable and cannot be modified or deleted.'
    );
  }

  if (
    pgErr.code === 'P0001' &&
    pgErr.message?.includes('Expense audit history cannot be modified')
  ) {
    return AppError.conflict('Expense audit history is immutable and cannot be modified.');
  }

  if (
    pgErr.code === 'P0001' &&
    pgErr.message?.includes('Service request audit history cannot be modified')
  ) {
    return AppError.conflict(
      'Service request audit history is immutable and cannot be modified.'
    );
  }

  return null;
}

export function formatZodError(error: ZodError): { message: string; fieldErrors: Record<string, string> } {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form';
    if (!fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  const firstMessage = error.issues[0]?.message ?? 'Invalid input data';
  return { message: firstMessage, fieldErrors };
}
