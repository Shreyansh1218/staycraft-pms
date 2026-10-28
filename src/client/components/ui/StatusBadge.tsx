import {
  CLEANING_STAGE_LABELS,
  DIETARY_TAG_LABELS,
  EXPENSE_PAYMENT_METHOD_LABELS,
  EXPENSE_STATUS_LABELS,
  FOOD_BILLING_STATUS_LABELS,
  FOOD_ORDER_SOURCE_LABELS,
  FOOD_ORDER_STATUS_LABELS,
  FOOD_ORDER_TYPE_LABELS,
  HOUSEKEEPING_TASK_STATUS_LABELS,
  INVENTORY_STOCK_STATUS_LABELS,
  INVOICE_ITEM_TYPE_LABELS,
  INVOICE_STATUS_LABELS,
  MAINTENANCE_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  SERVICE_BILLING_STATUS_LABELS,
  SERVICE_REQUEST_STATUS_LABELS,
  STAFF_EMPLOYMENT_STATUS_LABELS,
  STOCK_MOVEMENT_SOURCE_LABELS,
  TASK_PRIORITY_LABELS,
  type AllHousekeepingTaskStatus,
  type CleaningStage,
  type DietaryTag,
  type ExpensePaymentMethod,
  type ExpenseStatus,
  type FoodBillingStatus,
  type FoodOrderSource,
  type FoodOrderStatus,
  type FoodOrderType,
  type HousekeepingStatus,
  type InventoryStockStatus,
  type InvoiceItemType,
  type InvoiceStatus,
  type MaintenanceStatus,
  type OperationalStatus,
  type PaymentMethod,
  type ReservationStatus,
  type ServiceBillingStatus,
  type ServiceRequestStatus,
  type StaffEmploymentStatus,
  type StockMovementSource,
  type TaskPriority,
  type UserRole,
} from '@shared/constants';

export function ReservationStatusBadge({ status }: { status: ReservationStatus }) {
  const map: Record<ReservationStatus, { label: string; classes: string }> = {
    pending: {
      label: 'Pending',
      classes: 'bg-amber-50 text-amber-800 border-amber-200',
    },
    confirmed: {
      label: 'Confirmed',
      classes: 'bg-blue-50 text-blue-800 border-blue-200',
    },
    checked_in: {
      label: 'Checked In',
      classes: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    },
    checked_out: {
      label: 'Checked Out',
      classes: 'bg-slate-100 text-slate-700 border-slate-200',
    },
    cancelled: {
      label: 'Cancelled',
      classes: 'bg-rose-50 text-rose-700 border-rose-200',
    },
  };

  const item = map[status] ?? map.pending;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${item.classes}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {item.label}
    </span>
  );
}

export function HousekeepingBadge({
  status,
  cleaningInProgress = false,
}: {
  status: HousekeepingStatus;
  cleaningInProgress?: boolean;
}) {
  if (status === 'dirty' && cleaningInProgress) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800">
        <span className="h-1.5 w-1.5 rounded-full bg-violet-600 animate-pulse" />
        Cleaning in Progress
      </span>
    );
  }

  const map: Record<HousekeepingStatus, { label: string; classes: string }> = {
    inspected: {
      label: 'Inspected',
      classes: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    },
    clean: {
      label: 'Clean',
      classes: 'bg-sky-50 text-sky-800 border-sky-200',
    },
    dirty: {
      label: 'Dirty',
      classes: 'bg-amber-50 text-amber-800 border-amber-200',
    },
    out_of_service: {
      label: 'Out of Service',
      classes: 'bg-rose-50 text-rose-800 border-rose-200',
    },
  };

  const item = map[status] ?? map.clean;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${item.classes}`}
    >
      {item.label}
    </span>
  );
}

export function CleaningStageBadge({ stage }: { stage: CleaningStage }) {
  const classes: Record<CleaningStage, string> = {
    dirty: 'bg-amber-50 text-amber-800 border-amber-200',
    cleaning_in_progress: 'bg-violet-50 text-violet-800 border-violet-200',
    clean: 'bg-sky-50 text-sky-800 border-sky-200',
    inspected: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    out_of_service: 'bg-rose-50 text-rose-800 border-rose-200',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${classes[stage]}`}
    >
      {stage === 'cleaning_in_progress' && (
        <span className="h-1.5 w-1.5 rounded-full bg-violet-600 animate-pulse" />
      )}
      {CLEANING_STAGE_LABELS[stage]}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const map: Record<TaskPriority, string> = {
    low: 'bg-slate-100 text-slate-700 border-slate-200',
    normal: 'bg-blue-50 text-blue-700 border-blue-200',
    high: 'bg-amber-50 text-amber-800 border-amber-200',
    urgent: 'bg-rose-50 text-rose-800 border-rose-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${map[priority]}`}
    >
      {TASK_PRIORITY_LABELS[priority]}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: AllHousekeepingTaskStatus }) {
  const map: Record<AllHousekeepingTaskStatus, string> = {
    pending: 'bg-amber-50 text-amber-800 border-amber-200',
    in_progress: 'bg-violet-50 text-violet-800 border-violet-200',
    completed: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${map[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {HOUSEKEEPING_TASK_STATUS_LABELS[status]}
    </span>
  );
}

export function MaintenanceStatusBadge({ status }: { status: MaintenanceStatus }) {
  const map: Record<MaintenanceStatus, string> = {
    open: 'bg-rose-50 text-rose-800 border-rose-200',
    in_progress: 'bg-amber-50 text-amber-800 border-amber-200',
    resolved: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${map[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {MAINTENANCE_STATUS_LABELS[status]}
    </span>
  );
}

export function OperationalBadge({
  status,
  isActive = true,
}: {
  status: OperationalStatus;
  isActive?: boolean;
}) {
  if (!isActive) {
    return (
      <span className="inline-flex items-center rounded-md border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
        Deactivated
      </span>
    );
  }

  const map: Record<OperationalStatus, { label: string; classes: string }> = {
    available: {
      label: 'Operational',
      classes: 'bg-teal-50 text-teal-800 border-teal-200',
    },
    maintenance: {
      label: 'Maintenance',
      classes: 'bg-orange-50 text-orange-800 border-orange-200',
    },
    out_of_service: {
      label: 'Out of Service',
      classes: 'bg-rose-50 text-rose-800 border-rose-200',
    },
  };

  const item = map[status] ?? map.available;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${item.classes}`}
    >
      {item.label}
    </span>
  );
}

export function RoleBadge({ role }: { role: UserRole }) {
  return role === 'admin' ? (
    <span className="inline-flex items-center rounded-full bg-indigo-50 border border-indigo-200 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
      Administrator
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-slate-100 border border-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
      Receptionist
    </span>
  );
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const map: Record<InvoiceStatus, { label: string; classes: string }> = {
    draft: {
      label: INVOICE_STATUS_LABELS.draft,
      classes: 'bg-slate-100 text-slate-700 border-slate-300',
    },
    issued: {
      label: INVOICE_STATUS_LABELS.issued,
      classes: 'bg-amber-50 text-amber-800 border-amber-200',
    },
    partially_paid: {
      label: INVOICE_STATUS_LABELS.partially_paid,
      classes: 'bg-sky-50 text-sky-800 border-sky-200',
    },
    paid: {
      label: INVOICE_STATUS_LABELS.paid,
      classes: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    },
    void: {
      label: INVOICE_STATUS_LABELS.void,
      classes: 'bg-rose-50 text-rose-700 border-rose-200 line-through',
    },
  };

  const item = map[status] ?? map.draft;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${item.classes}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {item.label}
    </span>
  );
}

export function InvoiceItemTypeBadge({ itemType }: { itemType: InvoiceItemType }) {
  const classes: Record<InvoiceItemType, string> = {
    room_charge: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    service_charge: 'bg-teal-50 text-teal-800 border-teal-200',
    fee: 'bg-amber-50 text-amber-800 border-amber-200',
    adjustment: 'bg-violet-50 text-violet-800 border-violet-200',
    discount: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${classes[itemType]}`}
    >
      {INVOICE_ITEM_TYPE_LABELS[itemType]}
    </span>
  );
}

export function PaymentMethodBadge({ method }: { method: PaymentMethod }) {
  const classes: Record<PaymentMethod, string> = {
    cash: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    card: 'bg-indigo-50 text-indigo-800 border-indigo-200',
    upi: 'bg-violet-50 text-violet-800 border-violet-200',
    bank_transfer: 'bg-sky-50 text-sky-800 border-sky-200',
    online: 'bg-teal-50 text-teal-800 border-teal-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${classes[method]}`}
    >
      {PAYMENT_METHOD_LABELS[method]}
    </span>
  );
}

export function FoodOrderStatusBadge({ status }: { status: FoodOrderStatus }) {
  const classes: Record<FoodOrderStatus, string> = {
    pending: 'bg-amber-50 text-amber-800 border-amber-200',
    preparing: 'bg-violet-50 text-violet-800 border-violet-200',
    ready: 'bg-sky-50 text-sky-800 border-sky-200',
    served: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    cancelled: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${classes[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {FOOD_ORDER_STATUS_LABELS[status]}
    </span>
  );
}

export function FoodOrderTypeBadge({ orderType }: { orderType: FoodOrderType }) {
  const classes: Record<FoodOrderType, string> = {
    restaurant: 'bg-indigo-50 text-indigo-800 border-indigo-200',
    takeaway: 'bg-amber-50 text-amber-800 border-amber-200',
    room_service: 'bg-teal-50 text-teal-800 border-teal-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${classes[orderType]}`}
    >
      {FOOD_ORDER_TYPE_LABELS[orderType]}
    </span>
  );
}

export function FoodOrderSourceBadge({
  orderSource = 'staff_pos',
  showStaffPos = false,
}: {
  orderSource?: FoodOrderSource;
  showStaffPos?: boolean;
}) {
  if (orderSource !== 'guest_qr' && !showStaffPos) {
    return null;
  }

  const classes: Record<FoodOrderSource, string> = {
    guest_qr: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    staff_pos: 'bg-slate-100 text-slate-700 border-slate-200',
  };

  return (
    <span
      data-testid={`food-order-source-${orderSource}`}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${classes[orderSource]}`}
    >
      {orderSource === 'guest_qr' && (
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
      )}
      {FOOD_ORDER_SOURCE_LABELS[orderSource]}
    </span>
  );
}

export function FoodBillingStatusBadge({ status }: { status: FoodBillingStatus }) {
  const classes: Record<FoodBillingStatus, string> = {
    not_applicable: 'bg-slate-100 text-slate-600 border-slate-200',
    unbilled: 'bg-amber-50 text-amber-800 border-amber-200',
    posted: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    reversed: 'bg-rose-50 text-rose-800 border-rose-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${classes[status]}`}
    >
      {FOOD_BILLING_STATUS_LABELS[status]}
    </span>
  );
}

export function DietaryBadge({ tag }: { tag: DietaryTag }) {
  const classes: Record<DietaryTag, string> = {
    veg: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    non_veg: 'bg-rose-50 text-rose-800 border-rose-200',
    vegan: 'bg-lime-50 text-lime-800 border-lime-200',
    beverage: 'bg-sky-50 text-sky-800 border-sky-200',
    other: 'bg-slate-100 text-slate-700 border-slate-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${classes[tag]}`}
    >
      {DIETARY_TAG_LABELS[tag]}
    </span>
  );
}

export function InventoryStockStatusBadge({
  status,
  isActive = true,
}: {
  status: InventoryStockStatus;
  isActive?: boolean;
}) {
  if (!isActive) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
        Inactive
      </span>
    );
  }

  const classes: Record<InventoryStockStatus, string> = {
    in_stock: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    low_stock: 'bg-amber-50 text-amber-800 border-amber-200',
    out_of_stock: 'bg-rose-50 text-rose-800 border-rose-200',
  };

  return (
    <span
      data-testid={`stock-status-${status}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${classes[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {INVENTORY_STOCK_STATUS_LABELS[status]}
    </span>
  );
}

export function StockMovementSourceBadge({ source }: { source: StockMovementSource }) {
  const classes: Record<StockMovementSource, string> = {
    opening_stock: 'bg-slate-100 text-slate-700 border-slate-200',
    purchase_receipt: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    manual_adjustment: 'bg-indigo-50 text-indigo-800 border-indigo-200',
    wastage: 'bg-rose-50 text-rose-800 border-rose-200',
    department_issue: 'bg-amber-50 text-amber-800 border-amber-200',
    order_consumption: 'bg-violet-50 text-violet-800 border-violet-200',
  };

  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${classes[source]}`}
    >
      {STOCK_MOVEMENT_SOURCE_LABELS[source]}
    </span>
  );
}

export function ExpenseStatusBadge({ status }: { status: ExpenseStatus }) {
  const classes: Record<ExpenseStatus, string> = {
    recorded: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    voided: 'bg-rose-50 text-rose-700 border-rose-200 line-through',
  };

  return (
    <span
      data-testid={`expense-status-${status}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${classes[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {EXPENSE_STATUS_LABELS[status]}
    </span>
  );
}

export function ExpensePaymentMethodBadge({ method }: { method: ExpensePaymentMethod }) {
  return (
    <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700">
      {EXPENSE_PAYMENT_METHOD_LABELS[method] ?? method}
    </span>
  );
}

export function ServiceRequestStatusBadge({ status }: { status: ServiceRequestStatus }) {
  const classes: Record<ServiceRequestStatus, string> = {
    requested: 'bg-amber-50 text-amber-800 border-amber-200',
    in_progress: 'bg-violet-50 text-violet-800 border-violet-200',
    completed: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    cancelled: 'bg-rose-50 text-rose-700 border-rose-200',
  };

  return (
    <span
      data-testid={`service-request-status-${status}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${classes[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {SERVICE_REQUEST_STATUS_LABELS[status]}
    </span>
  );
}

export function ServiceBillingStatusBadge({ status }: { status: ServiceBillingStatus }) {
  const classes: Record<ServiceBillingStatus, string> = {
    not_billable: 'bg-slate-100 text-slate-600 border-slate-200',
    unbilled: 'bg-amber-50 text-amber-800 border-amber-200',
    posted: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  };

  return (
    <span
      data-testid={`service-billing-status-${status}`}
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${classes[status]}`}
    >
      {SERVICE_BILLING_STATUS_LABELS[status]}
    </span>
  );
}

export function StaffEmploymentStatusBadge({
  status,
}: {
  status: StaffEmploymentStatus;
}) {
  const classes: Record<StaffEmploymentStatus, string> = {
    active: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    on_leave: 'bg-amber-50 text-amber-800 border-amber-200',
    inactive: 'bg-slate-100 text-slate-600 border-slate-300',
  };

  return (
    <span
      data-testid={`staff-status-${status}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${classes[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {STAFF_EMPLOYMENT_STATUS_LABELS[status]}
    </span>
  );
}





