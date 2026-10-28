import type {
  AllHousekeepingTaskStatus,
  BookingSource,
  CleaningStage,
  DietaryTag,
  ExpenseHistoryAction,
  ExpensePaymentMethod,
  ExpenseStatus,
  FoodBillingStatus,
  FoodOrderSource,
  FoodOrderStatus,
  FoodOrderType,
  HousekeepingStatus,
  HousekeepingTaskType,
  InventoryStockStatus,
  InventoryUnit,
  InvoiceItemType,
  InvoiceStatus,
  MaintenanceCategory,
  MaintenanceImpact,
  MaintenanceStatus,
  OperationalStatus,
  PaymentMethod,
  PaymentStatus,
  ReservationStatus,
  ServiceBillingStatus,
  ServiceCategory,
  ServicePricingUnit,
  ServiceRequestHistoryAction,
  ServiceRequestStatus,
  StaffDepartment,
  StaffEmploymentStatus,
  StaffShiftType,
  StockMovementSource,
  StockMovementType,
  TaskPriority,
  UserRole,
} from './constants.js';

export interface InvoiceSettings {
  prefix: string;
  nextNumber: number;
  taxId: string;
  footerNote: string;
}

export interface Property {
  id: string;
  code: string;
  name: string;
  email: string;
  phone: string;
  website: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateRegion: string;
  postalCode: string;
  country: string;
  timezone: string;
  currency: string;
  defaultTaxRate: number;
  taxName: string;
  standardCheckInTime: string;
  standardCheckOutTime: string;
  cancellationPolicy: string;
  bookingTerms: string;
  invoiceSettings: InvoiceSettings;
  isActive: boolean;
  localToday: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserSummary {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  phone: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuthSessionPayload {
  user: UserSummary;
  properties: Property[];
  defaultPropertyId: string;
  sessionToken?: string;
}

export interface RoomType {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  description: string;
  baseCapacity: number;
  maxCapacity: number;
  baseRate: number;
  amenities: string[];
  isActive: boolean;
  totalRoomsCount: number;
  activeRoomsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoomCurrentOccupancy {
  reservationId: string;
  bookingReference: string;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
  status: ReservationStatus;
}

export interface Room {
  id: string;
  propertyId: string;
  roomTypeId: string;
  roomTypeName: string;
  roomTypeCode: string;
  baseCapacity: number;
  maxCapacity: number;
  baseRate: number;
  roomNumber: string;
  floor: string;
  operationalStatus: OperationalStatus;
  housekeepingStatus: HousekeepingStatus;
  cleaningInProgress: boolean;
  cleaningStage: CleaningStage;
  cleaningStartedAt: string | null;
  lastCleanedAt: string | null;
  lastInspectedAt: string | null;
  openTasksCount: number;
  openMaintenanceCount: number;
  activeMaintenanceSummary: string | null;
  notes: string;
  isActive: boolean;
  isOccupied: boolean;
  currentOccupancy: RoomCurrentOccupancy | null;
  availableForDates?: boolean;
  conflictingBookingRef?: string | null;
  conflictingMaintenanceTitle?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Guest {
  id: string;
  propertyId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  addressLine1: string;
  city: string;
  stateRegion: string;
  postalCode: string;
  country: string;
  idDocumentType: string;
  idDocumentNumber: string;
  vipStatus: boolean;
  notes: string;
  totalReservations: number;
  activeStays: number;
  createdAt: string;
  updatedAt: string;
}

export interface GuestDetail extends Guest {
  reservations: ReservationListItem[];
}

export interface ReservationListItem {
  id: string;
  propertyId: string;
  bookingReference: string;
  guestId: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  roomTypeId: string;
  roomTypeName: string;
  roomTypeCode: string;
  roomId: string | null;
  roomNumber: string | null;
  floor: string | null;
  roomHousekeepingStatus: HousekeepingStatus | null;
  roomOperationalStatus: OperationalStatus | null;
  roomCleaningInProgress: boolean;
  roomCleaningStage: CleaningStage | null;
  roomOpenMaintenanceCount: number;
  roomHasInventoryBlock: boolean;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  numGuests: number;
  nights: number;
  nightlyRate: number;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  estimatedTotal: number;
  currency: string;
  source: BookingSource;
  isWalkIn: boolean;
  status: ReservationStatus;
  specialRequests: string;
  internalNotes: string;
  cancellationReason: string;
  cancelledAt: string | null;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationHistoryItem {
  id: string;
  reservationId: string;
  fromStatus: ReservationStatus | null;
  toStatus: ReservationStatus;
  action: string;
  note: string;
  metadata: Record<string, unknown>;
  changedByName: string | null;
  changedByRole: UserRole | null;
  createdAt: string;
}

export interface ReservationDetail extends ReservationListItem {
  maxCapacity: number;
  guest: Guest;
  history: ReservationHistoryItem[];
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface NotificationItem {
  id: string;
  severity: 'info' | 'warning' | 'urgent';
  title: string;
  description: string;
  href: string;
}

export interface DashboardFoodOrdersSummary {
  pendingCount: number;
  preparingCount: number;
  readyCount: number;
  activeGuestQrCount: number;
  unbilledRoomServiceCount: number;
}

export interface DashboardSummary {
  property: Property;
  propertyToday: string;
  metrics: {
    totalRooms: number;
    sellableRooms: number;
    occupiedRooms: number;
    availableRooms: number;
    unavailableOperationalRooms: number;
    occupancyPercentage: number;
    arrivalsTodayTotal: number;
    arrivalsPendingCheckIn: number;
    arrivalsCheckedIn: number;
    departuresTodayTotal: number;
    departuresPendingCheckOut: number;
    departuresCheckedOut: number;
    overdueCheckOutsCount: number;
    activeBookingsCount: number;
    inHouseGuestsCount: number;
    tonightInHouseRoomRevenue: number;
    currentMonthConfirmedBookingValue: number;
    cleaningInProgressRoomsCount: number;
    openHousekeepingTasksCount: number;
    openMaintenanceRequestsCount: number;
    affectedStaysOnUnavailableRoomsCount: number;
  };
  housekeepingCounts: {
    clean: number;
    inspected: number;
    dirty: number;
    out_of_service: number;
  };
  foodOrdersSummary: DashboardFoodOrdersSummary;
  activeFoodOrders: FoodOrderListItem[];
  todayArrivals: ReservationListItem[];
  todayDepartures: ReservationListItem[];
  overdueCheckOuts: ReservationListItem[];
  inHouseStays: ReservationListItem[];
  recentBookings: ReservationListItem[];
  roomRack: Room[];
  notifications: NotificationItem[];
}

export interface StaffOption {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
}

export interface HousekeepingTask {
  id: string;
  propertyId: string;
  roomId: string;
  roomNumber: string;
  floor: string;
  roomTypeName: string;
  roomHousekeepingStatus: HousekeepingStatus;
  roomOperationalStatus: OperationalStatus;
  roomCleaningStage: CleaningStage;
  roomCleaningInProgress: boolean;
  isRoomOccupied: boolean;
  reservationId: string | null;
  bookingReference: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  assignedToRole: UserRole | null;
  taskType: HousekeepingTaskType;
  priority: TaskPriority;
  status: AllHousekeepingTaskStatus;
  dueDate: string;
  notes: string;
  startedAt: string | null;
  startedBy: string | null;
  startedByName: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completedByName: string | null;
  createdBy: string | null;
  createdByName: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceRequest {
  id: string;
  propertyId: string;
  roomId: string;
  roomNumber: string;
  floor: string;
  roomTypeName: string;
  roomOperationalStatus: OperationalStatus;
  roomHousekeepingStatus: HousekeepingStatus;
  isRoomOccupied: boolean;
  category: MaintenanceCategory;
  title: string;
  description: string;
  priority: TaskPriority;
  status: MaintenanceStatus;
  operationalImpact: MaintenanceImpact;
  blocksInventory: boolean;
  unavailableFrom: string | null;
  unavailableTo: string | null;
  reportedBy: string | null;
  reportedByName: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  assignedToRole: UserRole | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolutionNotes: string;
  reportedAt: string;
  startedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarMaintenanceBlock {
  id: string;
  roomId: string;
  roomNumber: string;
  title: string;
  priority: TaskPriority;
  status: MaintenanceStatus;
  operationalImpact: MaintenanceImpact;
  unavailableFrom: string;
  unavailableTo: string | null;
}

export interface RoomCalendarPayload {
  property: Property;
  propertyToday: string;
  startDate: string;
  endDate: string;
  days: number;
  dates: string[];
  rooms: Room[];
  reservations: ReservationListItem[];
  maintenanceBlocks: CalendarMaintenanceBlock[];
}

// Phase 3: Billing, Invoices & Payments Types

export interface InvoiceLineItem {
  id: string;
  invoiceId: string;
  serviceChargeId: string | null;
  sourceKey: string | null;
  itemType: InvoiceItemType;
  description: string;
  quantity: number;
  unitPrice: number;
  netAmount: number;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
  sortOrder: number;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface PaymentRecord {
  id: string;
  propertyId: string;
  invoiceId: string;
  reservationId: string | null;
  paymentReference: string;
  amount: number;
  currency: string;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  paymentDate: string;
  paidAt: string;
  receivedBy: string | null;
  receivedByName: string | null;
  receivedByRole: UserRole | null;
  notes: string;
  createdAt: string;
}

export interface InvoiceListItem {
  id: string;
  propertyId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  reservationId: string | null;
  bookingReference: string | null;
  reservationStatus: ReservationStatus | null;
  roomNumber: string | null;
  roomTypeName: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  guestId: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  issueDate: string;
  dueDate: string | null;
  subtotal: number;
  discountTotal: number;
  taxName: string;
  taxRate: number;
  taxTotal: number;
  grandTotal: number;
  amountPaid: number;
  balanceDue: number;
  currency: string;
  notes: string;
  issuedAt: string | null;
  voidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceSummaryMetrics {
  totalInvoices: number;
  draftCount: number;
  issuedUnpaidCount: number;
  partiallyPaidCount: number;
  paidCount: number;
  voidCount: number;
  totalBilled: number;
  totalCollected: number;
  totalOutstandingBalance: number;
  currency: string;
}

export interface InvoiceListResponse extends PaginatedResult<InvoiceListItem> {
  summary: InvoiceSummaryMetrics;
}

export interface InvoicePropertyHeader {
  id: string;
  code: string;
  name: string;
  email: string;
  phone: string;
  website: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateRegion: string;
  postalCode: string;
  country: string;
  currency: string;
}

export interface InvoiceDetail extends InvoiceListItem {
  taxableSubtotal: number;
  propertyTaxId: string;
  footerNote: string;
  issuedBy: string | null;
  issuedByName: string | null;
  voidedBy: string | null;
  voidedByName: string | null;
  voidReason: string;
  createdBy: string | null;
  createdByName: string | null;
  propertyHeader: InvoicePropertyHeader;
  guest: {
    id: string;
    fullName: string;
    email: string;
    phone: string;
    addressLine1: string;
    city: string;
    stateRegion: string;
    postalCode: string;
    country: string;
  };
  lineItems: InvoiceLineItem[];
  payments: PaymentRecord[];
}

// Phase 4: Food Ordering & Restaurant Management Types

export interface FoodCategory {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  description: string;
  displayOrder: number;
  isActive: boolean;
  itemCount: number;
  activeItemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FoodMenuItemIngredient {
  id: string;
  menuItemId: string;
  productId: string;
  productSku: string;
  productName: string;
  unit: InventoryUnit | string;
  quantityRequired: number;
  currentStock: number;
  reorderLevel: number;
  productIsActive: boolean;
  stockStatus: InventoryStockStatus;
  isInsufficientForOneUnit: boolean;
}

export interface FoodMenuItem {
  id: string;
  propertyId: string;
  categoryId: string;
  categoryName: string;
  categoryIsActive: boolean;
  sku: string;
  name: string;
  description: string;
  price: number;
  dietaryTag: DietaryTag;
  prepTimeMinutes: number | null;
  isAvailable: boolean;
  isActive: boolean;
  displayOrder: number;
  ingredientCount?: number;
  hasLowOrOutIngredient?: boolean;
  ingredients?: FoodMenuItemIngredient[];
  createdAt: string;
  updatedAt: string;
}

export interface FoodOrderItem {
  id: string;
  orderId: string;
  menuItemId: string;
  itemNameSnapshot: string;
  categoryNameSnapshot: string;
  quantity: number;
  unitPrice: number;
  lineSubtotal: number;
  specialInstructions: string;
  sortOrder: number;
  createdAt: string;
}

export interface FoodOrderStatusHistoryEntry {
  id: string;
  orderId: string;
  fromStatus: FoodOrderStatus | null;
  toStatus: FoodOrderStatus;
  note: string;
  changedBy: string | null;
  changedByName: string | null;
  createdAt: string;
}

export interface FoodOrderListItem {
  id: string;
  propertyId: string;
  orderReference: string;
  orderType: FoodOrderType;
  orderSource: FoodOrderSource;
  status: FoodOrderStatus;
  tableLabel: string;
  customerName: string;
  reservationId: string | null;
  bookingReference: string | null;
  reservationStatus: ReservationStatus | null;
  roomId: string | null;
  roomNumber: string | null;
  guestId: string | null;
  guestName: string | null;
  subtotal: number;
  taxName: string;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  notes: string;
  billingStatus: FoodBillingStatus;
  postedInvoiceId: string | null;
  postedInvoiceNumber: string | null;
  postedInvoiceStatus: InvoiceStatus | null;
  postedAt: string | null;
  postedByName: string | null;
  reversedAt: string | null;
  reversedByName: string | null;
  reversalReason: string;
  placedAt: string;
  preparingAt: string | null;
  preparingByName: string | null;
  readyAt: string | null;
  readyByName: string | null;
  servedAt: string | null;
  servedByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string;
  inventoryDeductedAt?: string | null;
  createdByName: string | null;
  itemCount: number;
  itemsSummary: string;
  items: FoodOrderItem[];
  createdAt: string;
  updatedAt: string;
}

export interface FoodOrderDetail extends FoodOrderListItem {
  statusHistory: FoodOrderStatusHistoryEntry[];
  stockMovements?: StockMovementRecord[];
}

export interface FoodOrdersSummaryMetrics {
  pendingCount: number;
  preparingCount: number;
  readyCount: number;
  servedTodayCount: number;
  cancelledTodayCount: number;
  unbilledRoomServiceCount: number;
  unbilledRoomServiceAmount: number;
  currency: string;
}

export interface FoodOrdersListResponse extends PaginatedResult<FoodOrderListItem> {
  summary: FoodOrdersSummaryMetrics;
}

export interface EligibleRoomServiceStay {
  reservationId: string;
  bookingReference: string;
  roomId: string;
  roomNumber: string;
  roomTypeName: string;
  guestId: string;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
  activeInvoiceId: string | null;
  activeInvoiceNumber: string | null;
  activeInvoiceStatus: InvoiceStatus | null;
}

// Phase 5: Inventory, Suppliers, Stock Receipts & Immutable Movement Ledger Types

export interface Supplier {
  id: string;
  propertyId: string;
  code: string | null;
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  taxIdentifier: string;
  paymentTerms: string;
  notes: string;
  isActive: boolean;
  linkedItemCount: number;
  activeItemCount: number;
  receiptCount: number;
  totalPurchasedAmount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryCategory {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  description: string;
  displayOrder: number;
  isActive: boolean;
  itemCount: number;
  activeItemCount: number;
  lowStockItemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryItem {
  id: string;
  propertyId: string;
  categoryId: string | null;
  categoryName: string;
  categoryCode: string;
  supplierId: string | null;
  supplierName: string | null;
  supplierIsActive: boolean | null;
  sku: string;
  name: string;
  description: string;
  unit: InventoryUnit | string;
  currentStock: number;
  reorderLevel: number;
  unitCost: number;
  stockValue: number;
  isActive: boolean;
  stockStatus: InventoryStockStatus;
  isLowStock: boolean;
  linkedMenuItemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InventorySummaryMetrics {
  totalActiveItems: number;
  totalInactiveItems: number;
  lowStockCount: number;
  outOfStockCount: number;
  activeCategoriesCount: number;
  activeSuppliersCount: number;
  totalInventoryValuation: number;
  movementsTodayCount: number;
  receiptsThisMonthCount: number;
  receiptsThisMonthAmount: number;
  currency: string;
  lowStockItems: InventoryItem[];
}

export interface InventoryReceiptItem {
  id: string;
  receiptId: string;
  productId: string;
  productNameSnapshot: string;
  skuSnapshot: string;
  unitSnapshot: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  movementId: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface InventoryReceipt {
  id: string;
  propertyId: string;
  receiptNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  vendorInvoiceNumber: string;
  receiptDate: string;
  totalAmount: number;
  currency: string;
  notes: string;
  receivedBy: string | null;
  receivedByName: string | null;
  receivedAt: string;
  lineCount: number;
  itemsSummary: string;
  items: InventoryReceiptItem[];
  createdAt: string;
}

export interface InventoryReceiptsSummaryMetrics {
  totalReceipts: number;
  totalAmount: number;
  currency: string;
}

export interface InventoryReceiptsListResponse extends PaginatedResult<InventoryReceipt> {
  summary: InventoryReceiptsSummaryMetrics;
}

export interface StockMovementRecord {
  id: string;
  propertyId: string;
  productId: string;
  productSku: string;
  productName: string;
  categoryName: string;
  unit: string;
  movementType: StockMovementType;
  movementSource: StockMovementSource;
  quantity: number;
  quantityDelta: number;
  stockBefore: number;
  stockAfter: number;
  unitCost: number;
  reason: string;
  referenceNote: string;
  supplierId: string | null;
  supplierName: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
  foodOrderId: string | null;
  foodOrderReference: string | null;
  recordedBy: string | null;
  recordedByName: string | null;
  createdAt: string;
}

export interface StockMovementsSummaryMetrics {
  totalMovements: number;
  totalInQuantity: number;
  totalOutQuantity: number;
  totalWastageQuantity: number;
  netQuantityDelta: number;
  receiptsMovementCount: number;
  orderConsumptionCount: number;
  manualAdjustmentCount: number;
}

export interface StockMovementsReportResponse extends PaginatedResult<StockMovementRecord> {
  summary: StockMovementsSummaryMetrics;
}

// Phase 6: Operating Expenses & Financial / Operational Reports Types

export interface ExpenseCategory {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  description: string;
  displayOrder: number;
  isActive: boolean;
  recordedExpenseCount: number;
  totalExpenseCount: number;
  recordedTotalAmount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseHistoryEntry {
  id: string;
  expenseId: string;
  propertyId: string;
  action: ExpenseHistoryAction;
  reason: string;
  previousSnapshot: Record<string, unknown> | null;
  newSnapshot: Record<string, unknown>;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface ExpenseRecord {
  id: string;
  propertyId: string;
  expenseNumber: string;
  categoryId: string | null;
  categoryCode: string;
  categoryName: string;
  categoryIsActive: boolean;
  supplierId: string | null;
  supplierName: string | null;
  vendorName: string;
  title: string;
  description: string;
  amount: number;
  taxAmount: number;
  currency: string;
  expenseDate: string;
  paymentMethod: ExpensePaymentMethod;
  referenceNumber: string;
  notes: string;
  status: ExpenseStatus;
  recordedBy: string | null;
  recordedByName: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidedByName: string | null;
  voidReason: string;
  updatedBy: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseDetail extends ExpenseRecord {
  history: ExpenseHistoryEntry[];
}

export interface ExpenseCategoryBreakdownItem {
  categoryId: string | null;
  categoryCode: string;
  categoryName: string;
  isCategoryActive: boolean;
  recordedCount: number;
  recordedAmount: number;
  sharePercent: number;
}

export interface ExpensePaymentMethodBreakdownItem {
  paymentMethod: ExpensePaymentMethod;
  recordedCount: number;
  recordedAmount: number;
}

export interface ExpensesSummaryMetrics {
  recordedCount: number;
  recordedTotal: number;
  recordedTaxTotal: number;
  voidedCount: number;
  voidedTotal: number;
  thisMonthRecordedCount: number;
  thisMonthRecordedTotal: number;
  activeCategoriesCount: number;
  currency: string;
  byCategory: ExpenseCategoryBreakdownItem[];
}

export interface ExpensesListResponse extends PaginatedResult<ExpenseRecord> {
  summary: ExpensesSummaryMetrics;
}

export interface ReportPeriodInfo {
  dateFrom: string;
  dateTo: string;
  dayCount: number;
  timezone: string;
  currency: string;
  generatedAt: string;
}

export interface ReportExpensesSection {
  recordedCount: number;
  recordedTotal: number;
  recordedTaxTotal: number;
  voidedCount: number;
  voidedTotal: number;
  byCategory: ExpenseCategoryBreakdownItem[];
  byPaymentMethod: ExpensePaymentMethodBreakdownItem[];
  dailyTrend: Array<{
    date: string;
    recordedCount: number;
    recordedAmount: number;
  }>;
}

export interface ReportInvoiceLineBreakdownItem {
  itemType: InvoiceItemType;
  lineCount: number;
  netAmount: number;
  taxAmount: number;
  lineTotal: number;
}

export interface ReportPaymentMethodBreakdownItem {
  paymentMethod: PaymentMethod;
  paymentCount: number;
  totalAmount: number;
}

export interface ReportBillingRevenueSection {
  activeInvoicesCount: number;
  draftInvoicesCount: number;
  issuedUnpaidCount: number;
  partiallyPaidCount: number;
  paidInvoicesCount: number;
  recordedBilledSubtotal: number;
  recordedDiscountTotal: number;
  recordedTaxTotal: number;
  recordedBilledTotal: number;
  issuedOrPaidBilledTotal: number;
  draftBilledTotal: number;
  periodInvoicesOutstandingBalance: number;
  propertyTotalOutstandingBalance: number;
  voidedInvoicesCount: number;
  voidedInvoicesTotal: number;
  paymentsReceivedCount: number;
  paymentsReceivedTotal: number;
  refundedPaymentsTotal: number;
  byLineItemType: ReportInvoiceLineBreakdownItem[];
  paymentsByMethod: ReportPaymentMethodBreakdownItem[];
  directRestaurantPosServedCount: number;
  directRestaurantPosServedTotal: number;
  roomServicePostedToFolioTotal: number;
}

export interface ReportOperatingComparisonSection {
  recordedBilledRevenue: number;
  paymentsReceived: number;
  recordedOperatingExpenses: number;
  billedRevenueMinusExpenses: number;
  paymentsReceivedMinusExpenses: number;
  disclaimerTitle: string;
  exclusionsAndLimitations: string[];
}

export interface ReportOccupancyReservationSection {
  totalActiveRooms: number;
  currentSellableRooms: number;
  unavailableRoomsCount: number;
  availableRoomNights: number;
  occupiedRoomNightsActual: number;
  committedRoomNightsIncludingConfirmed: number;
  occupancyRatePercent: number;
  committedOccupancyRatePercent: number;
  averageDailyRateEstimate: number;
  overlappingReservationsTotal: number;
  arrivalsInPeriodCount: number;
  departuresInPeriodCount: number;
  byStatus: Array<{
    status: ReservationStatus;
    reservationCount: number;
    roomNightsInPeriod: number;
    estimatedTotalValue: number;
  }>;
  bySource: Array<{
    source: BookingSource;
    reservationCount: number;
    estimatedTotalValue: number;
  }>;
}

export interface ReportInventorySection {
  activeItemsCount: number;
  inactiveItemsCount: number;
  lowStockCount: number;
  outOfStockCount: number;
  totalInventoryValuation: number;
  receiptsInPeriodCount: number;
  receiptsInPeriodAmount: number;
  movementsInPeriodCount: number;
  totalInQuantity: number;
  totalOutQuantity: number;
  totalWastageQuantity: number;
  netQuantityDelta: number;
  valuationByCategory: Array<{
    categoryId: string | null;
    categoryName: string;
    activeItemCount: number;
    lowStockCount: number;
    totalUnits: number;
    valuationAmount: number;
  }>;
  movementsBySource: Array<{
    movementSource: StockMovementSource;
    movementCount: number;
    totalQuantity: number;
    netQuantityDelta: number;
    estimatedValueImpact: number;
  }>;
}

export interface PropertyFinancialOperationalReport {
  property: Property;
  period: ReportPeriodInfo;
  expenses: ReportExpensesSection;
  billing: ReportBillingRevenueSection;
  operatingComparison: ReportOperatingComparisonSection;
  occupancy: ReportOccupancyReservationSection;
  inventory: ReportInventorySection;
}

// Phase 7: Services, Service Requests, Staff Profiles & User Access Types

export interface ServiceCatalogItem {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  description: string;
  category: ServiceCategory;
  unitPrice: number;
  pricingUnit: ServicePricingUnit;
  usePropertyTaxRate: boolean;
  taxRate: number;
  effectiveTaxRate: number;
  isActive: boolean;
  totalRequestsCount: number;
  openRequestsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceRequestHistoryEntry {
  id: string;
  serviceRequestId: string;
  propertyId: string;
  action: ServiceRequestHistoryAction;
  fromStatus: ServiceRequestStatus | null;
  toStatus: ServiceRequestStatus | null;
  note: string;
  metadata: Record<string, unknown>;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface ServiceRequestRecord {
  id: string;
  propertyId: string;
  requestNumber: string;
  serviceId: string;
  serviceCodeSnapshot: string;
  serviceNameSnapshot: string;
  categorySnapshot: ServiceCategory;
  pricingUnitSnapshot: ServicePricingUnit;
  serviceIsActive: boolean;
  reservationId: string | null;
  bookingReference: string | null;
  reservationStatus: ReservationStatus | null;
  guestId: string | null;
  guestName: string | null;
  guestPhone: string | null;
  roomId: string | null;
  roomNumber: string | null;
  assignedStaffId: string | null;
  assignedStaffName: string | null;
  assignedStaffDepartment: StaffDepartment | null;
  assignedStaffEmploymentStatus: StaffEmploymentStatus | null;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  taxName: string;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  status: ServiceRequestStatus;
  requestedFor: string;
  notes: string;
  billingStatus: ServiceBillingStatus;
  postedInvoiceId: string | null;
  postedInvoiceNumber: string | null;
  postedInvoiceStatus: InvoiceStatus | null;
  postedLineItemId: string | null;
  postedServiceChargeId: string | null;
  postedAt: string | null;
  postedByName: string | null;
  startedAt: string | null;
  startedByName: string | null;
  completedAt: string | null;
  completedByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceRequestDetail extends ServiceRequestRecord {
  history: ServiceRequestHistoryEntry[];
}

export interface ServiceRequestsSummaryMetrics {
  requestedCount: number;
  inProgressCount: number;
  completedTodayCount: number;
  cancelledTodayCount: number;
  unbilledCompletedCount: number;
  unbilledCompletedAmount: number;
  postedAmountTotal: number;
  activeCatalogCount: number;
  currency: string;
}

export interface ServiceRequestsListResponse extends PaginatedResult<ServiceRequestRecord> {
  summary: ServiceRequestsSummaryMetrics;
}

export interface EligibleServiceStay {
  reservationId: string;
  bookingReference: string;
  status: ReservationStatus;
  roomId: string | null;
  roomNumber: string | null;
  roomTypeName: string;
  guestId: string;
  guestName: string;
  guestPhone: string;
  arrivalDate: string;
  departureDate: string;
  activeInvoiceId: string | null;
  activeInvoiceNumber: string | null;
  activeInvoiceStatus: InvoiceStatus | null;
}

export interface StaffProfileRecord {
  id: string;
  propertyId: string;
  userId: string | null;
  linkedUserEmail: string | null;
  linkedUserRole: UserRole | null;
  linkedUserIsActive: boolean | null;
  linkedUserHasPropertyAccess: boolean | null;
  employeeCode: string;
  fullName: string;
  email: string;
  phone: string;
  department: StaffDepartment;
  jobTitle: string;
  employmentStatus: StaffEmploymentStatus;
  shiftType: StaffShiftType;
  joinedOn: string | null;
  emergencyContact: string;
  notes: string;
  deactivatedAt: string | null;
  assignedOpenRequestsCount: number;
  completedRequestsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StaffProfileDetail extends StaffProfileRecord {
  recentServiceRequests: ServiceRequestRecord[];
}

export interface StaffListSummaryMetrics {
  totalStaffCount: number;
  activeCount: number;
  onLeaveCount: number;
  inactiveCount: number;
  linkedUsersCount: number;
  byDepartment: Array<{
    department: StaffDepartment;
    activeCount: number;
    totalCount: number;
  }>;
}

export interface StaffListResponse {
  items: StaffProfileRecord[];
  summary: StaffListSummaryMetrics;
}

export interface ManagedUserPropertyAccessItem {
  propertyId: string;
  propertyCode: string;
  propertyName: string;
  isDefault: boolean;
  grantedAt: string;
}

export interface LinkedStaffProfileSummary {
  staffId: string;
  propertyId: string;
  propertyCode: string;
  propertyName: string;
  employeeCode: string;
  fullName: string;
  department: StaffDepartment;
  jobTitle: string;
  employmentStatus: StaffEmploymentStatus;
}

export interface ManagedUserAccount {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  phone: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  propertyAccess: ManagedUserPropertyAccessItem[];
  linkedStaffCount: number;
  linkedStaffProfiles: LinkedStaffProfileSummary[];
}

// Guest Self-Service QR Food Ordering & Account Security Types

export type GuestQrUrlMode =
  | 'production'
  | 'local_lan'
  | 'local_dev'
  | 'dev_unconfigured'
  | 'preview_unconfigured'
  | 'production_unconfigured'
  | 'invalid_config';

export interface PropertyQrFoodConfig {
  propertyId: string;
  propertyName: string;
  propertyCode: string;
  enabled: boolean;
  qrToken: string;
  guestMenuPath: string;
  urlMode: GuestQrUrlMode;
  qrReady: boolean;
  guestMenuUrl: string | null;
  qrSvg: string | null;
  configurationNotice: string | null;
  configurationError: string | null;
  configuredPublicAppUrl: string | null;
  canConfigureDevUrl: boolean;
}

export interface PublicGuestHotelInfo {
  name: string;
  code: string;
  city: string;
  currency: string;
  taxName: string;
  defaultTaxRate: number;
  phone: string;
}

export interface PublicGuestMenuCategory {
  id: string;
  name: string;
  description: string;
  displayOrder: number;
}

export interface PublicGuestMenuItem {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  description: string;
  price: number;
  dietaryTag: DietaryTag;
  prepTimeMinutes: number | null;
  displayOrder: number;
}

export interface PublicGuestMenuPayload {
  hotel: PublicGuestHotelInfo;
  categories: PublicGuestMenuCategory[];
  items: PublicGuestMenuItem[];
}

export interface PublicGuestOrderItemView {
  itemName: string;
  categoryName: string;
  quantity: number;
  unitPrice: number;
  lineSubtotal: number;
  specialInstructions: string;
}

export interface PublicGuestOrderView {
  hotelName: string;
  orderReference: string;
  status: FoodOrderStatus;
  roomNumber: string;
  items: PublicGuestOrderItemView[];
  subtotal: number;
  taxName: string;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  notes: string;
  paymentNotice: string;
  placedAt: string;
  preparingAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  cancelledAt: string | null;
}

export interface PublicGuestOrderCreateResponse {
  order: PublicGuestOrderView;
  trackingToken: string;
  trackingExpiresAt: string;
}

export interface AdminPasswordResetInitiateResponse {
  success: true;
  deliveryMode: 'email' | 'manual_link_fallback';
  expiresAt: string;
  resetUrl?: string;
}





