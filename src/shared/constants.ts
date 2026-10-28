export const USER_ROLES = ['admin', 'receptionist'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const OPERATIONAL_STATUSES = ['available', 'maintenance', 'out_of_service'] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

export const HOUSEKEEPING_STATUSES = ['clean', 'dirty', 'inspected', 'out_of_service'] as const;
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];

export type EffectiveRoomStatusBucket = 'inspected' | 'clean' | 'dirty' | 'out_of_service';

/**
 * Classifies a physical room into one mutually exclusive operational/housekeeping bucket
 * for dashboard and housekeeping summary counts without conflating the underlying fields:
 * any room not operationally 'available' (e.g. 'maintenance' or 'out_of_service') or
 * explicitly marked 'out_of_service' in housekeeping belongs in 'out_of_service' and is
 * never counted as 'clean', 'dirty', or 'inspected'.
 */
export function getRoomStatusBucket(room: {
  operationalStatus: OperationalStatus;
  housekeepingStatus: HousekeepingStatus;
}): EffectiveRoomStatusBucket {
  if (room.operationalStatus !== 'available' || room.housekeepingStatus === 'out_of_service') {
    return 'out_of_service';
  }
  return room.housekeepingStatus;
}

export function summarizeRoomStatusBuckets(
  rooms: ReadonlyArray<{
    operationalStatus: OperationalStatus;
    housekeepingStatus: HousekeepingStatus;
  }>
): Record<EffectiveRoomStatusBucket, number> {
  const counts: Record<EffectiveRoomStatusBucket, number> = {
    clean: 0,
    inspected: 0,
    dirty: 0,
    out_of_service: 0,
  };
  for (const room of rooms) {
    counts[getRoomStatusBucket(room)] += 1;
  }
  return counts;
}

export const RESERVATION_STATUSES = [
  'pending',
  'confirmed',
  'checked_in',
  'checked_out',
  'cancelled',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const ACTIVE_RESERVATION_STATUSES: readonly ReservationStatus[] = [
  'pending',
  'confirmed',
  'checked_in',
];

export const BOOKING_SOURCES = [
  'direct',
  'walk_in',
  'phone',
  'website',
  'ota_booking',
  'ota_expedia',
  'corporate',
] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const BOOKING_SOURCE_LABELS: Record<BookingSource, string> = {
  direct: 'Direct',
  walk_in: 'Walk-In',
  phone: 'Phone',
  website: 'Hotel Website',
  ota_booking: 'Booking.com',
  ota_expedia: 'Expedia',
  corporate: 'Corporate',
};

export const SUPPORTED_CURRENCIES = [
  'INR',
  'USD',
  'EUR',
  'GBP',
  'AED',
  'SGD',
  'AUD',
  'CAD',
] as const;

export const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;

export const ALLOWED_STATUS_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  pending: ['confirmed', 'checked_in', 'cancelled'],
  confirmed: ['pending', 'checked_in', 'cancelled'],
  checked_in: ['checked_out'],
  checked_out: [],
  cancelled: [],
};

export function canTransitionReservationStatus(
  from: ReservationStatus,
  to: ReservationStatus
): boolean {
  if (from === to) return true;
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

// Phase 2: Cleaning & Inspection Workflow, Housekeeping Tasks & Maintenance Constants

export const CLEANING_STAGES = [
  'dirty',
  'cleaning_in_progress',
  'clean',
  'inspected',
  'out_of_service',
] as const;
export type CleaningStage = (typeof CLEANING_STAGES)[number];

export const CLEANING_STAGE_LABELS: Record<CleaningStage, string> = {
  dirty: 'Dirty',
  cleaning_in_progress: 'Cleaning in Progress',
  clean: 'Clean',
  inspected: 'Inspected',
  out_of_service: 'Out of Service',
};

export function getRoomCleaningStage(room: {
  housekeepingStatus: HousekeepingStatus;
  cleaningInProgress?: boolean;
}): CleaningStage {
  if (room.housekeepingStatus === 'out_of_service') {
    return 'out_of_service';
  }
  if (room.housekeepingStatus === 'dirty' && room.cleaningInProgress) {
    return 'cleaning_in_progress';
  }
  return room.housekeepingStatus;
}

export const CLEANING_WORKFLOW_ACTIONS = [
  'mark_dirty',
  'start_cleaning',
  'complete_cleaning',
  'inspect_room',
] as const;
export type CleaningWorkflowAction = (typeof CLEANING_WORKFLOW_ACTIONS)[number];

export const HOUSEKEEPING_TASK_TYPES = [
  'turnover_clean',
  'stayover_service',
  'deep_clean',
  'inspection',
  'turndown',
  'linen_refresh',
] as const;
export type HousekeepingTaskType = (typeof HOUSEKEEPING_TASK_TYPES)[number];

export const HOUSEKEEPING_TASK_TYPE_LABELS: Record<HousekeepingTaskType, string> = {
  turnover_clean: 'Turnover Clean',
  stayover_service: 'Stayover Service',
  deep_clean: 'Deep Clean',
  inspection: 'Supervisor Inspection',
  turndown: 'Turndown Service',
  linen_refresh: 'Linen & Amenity Refresh',
};

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const HOUSEKEEPING_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type HousekeepingTaskStatus = (typeof HOUSEKEEPING_TASK_STATUSES)[number];

export const ALL_HOUSEKEEPING_TASK_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type AllHousekeepingTaskStatus = (typeof ALL_HOUSEKEEPING_TASK_STATUSES)[number];

export const HOUSEKEEPING_TASK_STATUS_LABELS: Record<AllHousekeepingTaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const MAINTENANCE_CATEGORIES = [
  'hvac',
  'plumbing',
  'electrical',
  'furniture',
  'appliance',
  'safety',
  'general',
] as const;
export type MaintenanceCategory = (typeof MAINTENANCE_CATEGORIES)[number];

export const MAINTENANCE_CATEGORY_LABELS: Record<MaintenanceCategory, string> = {
  hvac: 'HVAC / Air Conditioning',
  plumbing: 'Plumbing & Bath',
  electrical: 'Electrical & Lighting',
  furniture: 'Carpentry & Furniture',
  appliance: 'In-Room Appliance / TV',
  safety: 'Locks & Safety',
  general: 'General Maintenance',
};

export const MAINTENANCE_STATUSES = ['open', 'in_progress', 'resolved', 'cancelled'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
};

export const MAINTENANCE_IMPACTS = ['none', 'maintenance', 'out_of_service'] as const;
export type MaintenanceImpact = (typeof MAINTENANCE_IMPACTS)[number];

// Phase 3: Billing, Invoices & Payments Constants

export const INVOICE_STATUSES = [
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'void',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  issued: 'Issued (Unpaid)',
  partially_paid: 'Partially Paid',
  paid: 'Paid',
  void: 'Void',
};

export const INVOICE_ITEM_TYPES = [
  'room_charge',
  'service_charge',
  'fee',
  'adjustment',
  'discount',
] as const;
export type InvoiceItemType = (typeof INVOICE_ITEM_TYPES)[number];

export const INVOICE_ITEM_TYPE_LABELS: Record<InvoiceItemType, string> = {
  room_charge: 'Room Charge',
  service_charge: 'Additional Service',
  fee: 'Fee / Surcharge',
  adjustment: 'Rate Adjustment',
  discount: 'Discount',
};

export const PAYMENT_METHODS = [
  'cash',
  'card',
  'upi',
  'bank_transfer',
  'online',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card (POS Terminal)',
  upi: 'UPI',
  bank_transfer: 'Bank Transfer / NEFT',
  online: 'Online Transfer',
};

export const PAYMENT_STATUSES = [
  'pending',
  'completed',
  'refunded',
  'failed',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// Phase 4: Food Ordering & Restaurant Management Constants

export const DIETARY_TAGS = [
  'veg',
  'non_veg',
  'vegan',
  'beverage',
  'other',
] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];

export const DIETARY_TAG_LABELS: Record<DietaryTag, string> = {
  veg: 'Vegetarian',
  non_veg: 'Non-Veg',
  vegan: 'Vegan',
  beverage: 'Beverage',
  other: 'Standard',
};

export const FOOD_ORDER_TYPES = [
  'restaurant',
  'takeaway',
  'room_service',
] as const;
export type FoodOrderType = (typeof FOOD_ORDER_TYPES)[number];

export const FOOD_ORDER_TYPE_LABELS: Record<FoodOrderType, string> = {
  restaurant: 'Restaurant / Dine-In',
  takeaway: 'Takeaway',
  room_service: 'Room Service',
};

export const FOOD_ORDER_SOURCES = ['staff_pos', 'guest_qr'] as const;
export type FoodOrderSource = (typeof FOOD_ORDER_SOURCES)[number];

export const FOOD_ORDER_SOURCE_LABELS: Record<FoodOrderSource, string> = {
  staff_pos: 'Staff POS',
  guest_qr: 'Guest QR',
};

export const FOOD_ORDER_STATUSES = [
  'pending',
  'preparing',
  'ready',
  'served',
  'cancelled',
] as const;
export type FoodOrderStatus = (typeof FOOD_ORDER_STATUSES)[number];

export const FOOD_ORDER_STATUS_LABELS: Record<FoodOrderStatus, string> = {
  pending: 'Pending',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  cancelled: 'Cancelled',
};

export const ALLOWED_FOOD_ORDER_TRANSITIONS: Record<
  FoodOrderStatus,
  readonly FoodOrderStatus[]
> = {
  pending: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served', 'cancelled'],
  served: [],
  cancelled: [],
};

export function canTransitionFoodOrderStatus(
  from: FoodOrderStatus,
  to: FoodOrderStatus
): boolean {
  return ALLOWED_FOOD_ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export const FOOD_BILLING_STATUSES = [
  'not_applicable',
  'unbilled',
  'posted',
  'reversed',
] as const;
export type FoodBillingStatus = (typeof FOOD_BILLING_STATUSES)[number];

export const FOOD_BILLING_STATUS_LABELS: Record<FoodBillingStatus, string> = {
  not_applicable: 'Direct POS',
  unbilled: 'Unbilled Folio',
  posted: 'Posted to Invoice',
  reversed: 'Charge Reversed',
};

// Phase 5: Inventory, Suppliers & Stock Ledger Constants

export const INVENTORY_UNITS = [
  'pcs',
  'kg',
  'g',
  'l',
  'ml',
  'pack',
  'box',
  'bottle',
  'can',
  'roll',
  'set',
] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];

export const INVENTORY_UNIT_LABELS: Record<InventoryUnit, string> = {
  pcs: 'Pieces (pcs)',
  kg: 'Kilograms (kg)',
  g: 'Grams (g)',
  l: 'Liters (l)',
  ml: 'Milliliters (ml)',
  pack: 'Packs (pack)',
  box: 'Boxes (box)',
  bottle: 'Bottles (bottle)',
  can: 'Cans (can)',
  roll: 'Rolls (roll)',
  set: 'Sets (set)',
};

export const STOCK_MOVEMENT_TYPES = ['in', 'out', 'adjustment', 'wastage'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const STOCK_MOVEMENT_TYPE_LABELS: Record<StockMovementType, string> = {
  in: 'Stock In',
  out: 'Stock Out',
  adjustment: 'Adjustment',
  wastage: 'Wastage',
};

export const STOCK_MOVEMENT_SOURCES = [
  'opening_stock',
  'purchase_receipt',
  'manual_adjustment',
  'wastage',
  'department_issue',
  'order_consumption',
] as const;
export type StockMovementSource = (typeof STOCK_MOVEMENT_SOURCES)[number];

export const STOCK_MOVEMENT_SOURCE_LABELS: Record<StockMovementSource, string> = {
  opening_stock: 'Opening Stock',
  purchase_receipt: 'Purchase Receipt',
  manual_adjustment: 'Manual Adjustment',
  wastage: 'Wastage / Spoilage',
  department_issue: 'Department Issue',
  order_consumption: 'Kitchen Order Consumption',
};

export const STOCK_ADJUSTMENT_OPERATIONS = [
  'increase',
  'decrease',
  'wastage',
  'department_issue',
] as const;
export type StockAdjustmentOperation = (typeof STOCK_ADJUSTMENT_OPERATIONS)[number];

export const STOCK_ADJUSTMENT_OPERATION_LABELS: Record<StockAdjustmentOperation, string> = {
  increase: 'Stock Increase (+)',
  decrease: 'Stock Decrease / Shrinkage (−)',
  wastage: 'Wastage / Spoilage Write-Off (−)',
  department_issue: 'Housekeeping / Department Issue (−)',
};

export const INVENTORY_STOCK_STATUSES = [
  'in_stock',
  'low_stock',
  'out_of_stock',
] as const;
export type InventoryStockStatus = (typeof INVENTORY_STOCK_STATUSES)[number];

export const INVENTORY_STOCK_STATUS_LABELS: Record<InventoryStockStatus, string> = {
  in_stock: 'In Stock',
  low_stock: 'Low Stock',
  out_of_stock: 'Out of Stock',
};

export function getInventoryStockStatus(
  currentStock: number,
  reorderLevel: number
): InventoryStockStatus {
  if (currentStock <= 0) {
    return 'out_of_stock';
  }
  if (currentStock <= reorderLevel) {
    return 'low_stock';
  }
  return 'in_stock';
}

// Phase 6: Operating Expenses & Reports Constants

export const EXPENSE_STATUSES = ['recorded', 'voided'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  recorded: 'Recorded',
  voided: 'Voided',
};

export const EXPENSE_PAYMENT_METHODS = [
  'cash',
  'card',
  'upi',
  'bank_transfer',
  'online',
  'cheque',
  'petty_cash',
] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

export const EXPENSE_PAYMENT_METHOD_LABELS: Record<ExpensePaymentMethod, string> = {
  cash: 'Cash',
  card: 'Corporate Card',
  upi: 'UPI',
  bank_transfer: 'Bank Transfer / NEFT',
  online: 'Online Portal',
  cheque: 'Cheque / DD',
  petty_cash: 'Petty Cash',
};

export const EXPENSE_HISTORY_ACTIONS = ['created', 'updated', 'voided'] as const;
export type ExpenseHistoryAction = (typeof EXPENSE_HISTORY_ACTIONS)[number];

export const EXPENSE_HISTORY_ACTION_LABELS: Record<ExpenseHistoryAction, string> = {
  created: 'Created',
  updated: 'Updated',
  voided: 'Voided',
};

// Phase 7: Services, Staff Profiles & Users Constants

export const SERVICE_CATEGORIES = [
  'laundry',
  'airport_transfer',
  'spa_wellness',
  'room_service',
  'concierge',
  'transport',
  'housekeeping_extra',
  'recreation',
  'business_center',
  'other',
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = {
  laundry: 'Laundry & Dry Cleaning',
  airport_transfer: 'Airport & Station Transfer',
  spa_wellness: 'Spa & Wellness',
  room_service: 'In-Room Dining & Minibar',
  concierge: 'Concierge & Tours',
  transport: 'Chauffeur & Local Transport',
  housekeeping_extra: 'Extra Bed & Housekeeping',
  recreation: 'Pool, Gym & Recreation',
  business_center: 'Business Center & Events',
  other: 'General Hotel Service',
};

export const SERVICE_PRICING_UNITS = [
  'per_request',
  'per_item',
  'per_person',
  'per_hour',
  'per_day',
] as const;
export type ServicePricingUnit = (typeof SERVICE_PRICING_UNITS)[number];

export const SERVICE_PRICING_UNIT_LABELS: Record<ServicePricingUnit, string> = {
  per_request: 'Per Request',
  per_item: 'Per Item',
  per_person: 'Per Person',
  per_hour: 'Per Hour',
  per_day: 'Per Day',
};

export const SERVICE_REQUEST_STATUSES = [
  'requested',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];

export const SERVICE_REQUEST_STATUS_LABELS: Record<ServiceRequestStatus, string> = {
  requested: 'Requested',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const ALLOWED_SERVICE_REQUEST_TRANSITIONS: Record<
  ServiceRequestStatus,
  readonly ServiceRequestStatus[]
> = {
  requested: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransitionServiceRequestStatus(
  from: ServiceRequestStatus,
  to: ServiceRequestStatus
): boolean {
  return ALLOWED_SERVICE_REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}

export const SERVICE_BILLING_STATUSES = [
  'not_billable',
  'unbilled',
  'posted',
] as const;
export type ServiceBillingStatus = (typeof SERVICE_BILLING_STATUSES)[number];

export const SERVICE_BILLING_STATUS_LABELS: Record<ServiceBillingStatus, string> = {
  not_billable: 'Non-Folio / Direct',
  unbilled: 'Unbilled Folio',
  posted: 'Posted to Invoice',
};

export const SERVICE_REQUEST_HISTORY_ACTIONS = [
  'created',
  'updated',
  'assigned',
  'status_in_progress',
  'status_completed',
  'cancelled',
  'posted_to_invoice',
  'folio_released_on_void',
] as const;
export type ServiceRequestHistoryAction =
  (typeof SERVICE_REQUEST_HISTORY_ACTIONS)[number];

export const STAFF_DEPARTMENTS = [
  'front_office',
  'housekeeping',
  'maintenance',
  'food_beverage',
  'concierge_spa',
  'transport',
  'security',
  'management',
  'finance',
] as const;
export type StaffDepartment = (typeof STAFF_DEPARTMENTS)[number];

export const STAFF_DEPARTMENT_LABELS: Record<StaffDepartment, string> = {
  front_office: 'Front Office & Reception',
  housekeeping: 'Housekeeping',
  maintenance: 'Engineering & Maintenance',
  food_beverage: 'Food & Beverage',
  concierge_spa: 'Concierge & Spa',
  transport: 'Transport & Valet',
  security: 'Security',
  management: 'Hotel Management',
  finance: 'Finance & Accounts',
};

export const STAFF_EMPLOYMENT_STATUSES = [
  'active',
  'on_leave',
  'inactive',
] as const;
export type StaffEmploymentStatus = (typeof STAFF_EMPLOYMENT_STATUSES)[number];

export const STAFF_EMPLOYMENT_STATUS_LABELS: Record<StaffEmploymentStatus, string> = {
  active: 'Active',
  on_leave: 'On Leave',
  inactive: 'Inactive',
};

export const STAFF_SHIFT_TYPES = [
  'morning',
  'day',
  'evening',
  'night',
  'rotational',
] as const;
export type StaffShiftType = (typeof STAFF_SHIFT_TYPES)[number];

export const STAFF_SHIFT_TYPE_LABELS: Record<StaffShiftType, string> = {
  morning: 'Morning Shift',
  day: 'Day Shift',
  evening: 'Evening Shift',
  night: 'Night Shift',
  rotational: 'Rotational',
};






