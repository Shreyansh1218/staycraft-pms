import type {
  BookingSource,
  InvoiceItemType,
  PaymentMethod,
  ReservationStatus,
  StockMovementSource,
} from '../../../shared/constants.js';
import {
  addDays,
  diffDays,
  getPropertyLocalDate,
  isValidIsoDate,
} from '../../../shared/dates.js';
import { roundCurrency } from '../../../shared/pricing.js';
import type {
  ExpenseCategoryBreakdownItem,
  ExpensePaymentMethodBreakdownItem,
  Property,
  PropertyFinancialOperationalReport,
} from '../../../shared/types.js';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../errors.js';

const MAX_REPORT_DAYS = 731;

function roundOneDecimal(val: number): number {
  return Math.round((val + Number.EPSILON) * 10) / 10;
}

export interface ReportFilterInput {
  dateFrom?: string;
  dateTo?: string;
}

export function resolveReportPeriod(
  property: Property,
  filter: ReportFilterInput = {}
): {
  dateFrom: string;
  dateTo: string;
  periodEndExclusive: string;
  dayCount: number;
} {
  const propertyToday = getPropertyLocalDate(property.timezone);
  const defaultFrom = `${propertyToday.slice(0, 7)}-01`;

  const rawFrom = filter.dateFrom?.trim() || defaultFrom;
  const rawTo = filter.dateTo?.trim() || propertyToday;

  if (!isValidIsoDate(rawFrom)) {
    throw AppError.badRequest('Invalid dateFrom parameter (expected YYYY-MM-DD)');
  }
  if (!isValidIsoDate(rawTo)) {
    throw AppError.badRequest('Invalid dateTo parameter (expected YYYY-MM-DD)');
  }
  if (rawFrom > rawTo) {
    throw AppError.badRequest('dateFrom cannot be after dateTo');
  }

  const periodEndExclusive = addDays(rawTo, 1);
  const dayCount = diffDays(rawFrom, periodEndExclusive);
  if (dayCount < 1 || dayCount > MAX_REPORT_DAYS) {
    throw AppError.badRequest(
      `Report date range must span between 1 and ${MAX_REPORT_DAYS} days`
    );
  }

  return {
    dateFrom: rawFrom,
    dateTo: rawTo,
    periodEndExclusive,
    dayCount,
  };
}

export async function getPropertyFinancialOperationalReport(
  property: Property,
  filter: ReportFilterInput = {}
): Promise<PropertyFinancialOperationalReport> {
  const pool = getPool();
  const { dateFrom, dateTo, periodEndExclusive, dayCount } = resolveReportPeriod(
    property,
    filter
  );

  const [
    expTotalsRes,
    expByCatRes,
    expByMethodRes,
    expDailyRes,
    invPeriodRes,
    invOpenAllRes,
    invLinesRes,
    paymentsSumRes,
    paymentsByMethodRes,
    posSummaryRes,
    roomsSummaryRes,
    resOverlapAggRes,
    resArrDepRes,
    resByStatusRes,
    resBySourceRes,
    invProductsRes,
    invValByCatRes,
    invReceiptsRes,
    invMovSumRes,
    invMovBySourceRes,
  ] = await Promise.all([
    // 1. Expenses totals (recorded vs voided strictly separated)
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'recorded')::int AS recorded_count,
         COALESCE(SUM(amount) FILTER (WHERE status = 'recorded'), 0) AS recorded_total,
         COALESCE(SUM(tax_amount) FILTER (WHERE status = 'recorded'), 0) AS recorded_tax_total,
         COUNT(*) FILTER (WHERE status = 'voided')::int AS voided_count,
         COALESCE(SUM(amount) FILTER (WHERE status = 'voided'), 0) AS voided_total
       FROM expenses
       WHERE property_id = $1
         AND expense_date >= $2::date
         AND expense_date <= $3::date`,
      [property.id, dateFrom, dateTo]
    ),
    // 2. Expenses by category (recorded only)
    pool.query(
      `SELECT
         e.category_id,
         COALESCE(ec.code, e.category, 'GENERAL') AS category_code,
         COALESCE(ec.name, NULLIF(e.category_name_snapshot, ''), e.category, 'Uncategorized') AS category_name,
         COALESCE(ec.is_active, TRUE) AS is_category_active,
         COUNT(*)::int AS recorded_count,
         COALESCE(SUM(e.amount), 0) AS recorded_amount
       FROM expenses e
       LEFT JOIN expense_categories ec
         ON ec.id = e.category_id AND ec.property_id = e.property_id
       WHERE e.property_id = $1
         AND e.status = 'recorded'
         AND e.expense_date >= $2::date
         AND e.expense_date <= $3::date
       GROUP BY e.category_id, ec.code, ec.name, ec.is_active, e.category_name_snapshot, e.category
       ORDER BY recorded_amount DESC, category_name ASC`,
      [property.id, dateFrom, dateTo]
    ),
    // 3. Expenses by payment method (recorded only)
    pool.query(
      `SELECT
         payment_method,
         COUNT(*)::int AS recorded_count,
         COALESCE(SUM(amount), 0) AS recorded_amount
       FROM expenses
       WHERE property_id = $1
         AND status = 'recorded'
         AND expense_date >= $2::date
         AND expense_date <= $3::date
       GROUP BY payment_method
       ORDER BY recorded_amount DESC, payment_method ASC`,
      [property.id, dateFrom, dateTo]
    ),
    // 4. Daily recorded expense trend
    pool.query(
      `SELECT
         expense_date::text AS date,
         COUNT(*)::int AS recorded_count,
         COALESCE(SUM(amount), 0) AS recorded_amount
       FROM expenses
       WHERE property_id = $1
         AND status = 'recorded'
         AND expense_date >= $2::date
         AND expense_date <= $3::date
       GROUP BY expense_date
       ORDER BY expense_date ASC`,
      [property.id, dateFrom, dateTo]
    ),
    // 5. Invoices issued in period (active vs voided strictly separated)
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status != 'void')::int AS active_count,
         COUNT(*) FILTER (WHERE status = 'draft')::int AS draft_count,
         COUNT(*) FILTER (WHERE status = 'issued')::int AS issued_unpaid_count,
         COUNT(*) FILTER (WHERE status = 'partially_paid')::int AS partially_paid_count,
         COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
         COALESCE(SUM(subtotal) FILTER (WHERE status != 'void'), 0) AS billed_subtotal,
         COALESCE(SUM(discount_total) FILTER (WHERE status != 'void'), 0) AS discount_total,
         COALESCE(SUM(tax_total) FILTER (WHERE status != 'void'), 0) AS tax_total,
         COALESCE(SUM(grand_total) FILTER (WHERE status != 'void'), 0) AS billed_total,
         COALESCE(
           SUM(grand_total) FILTER (WHERE status IN ('issued', 'partially_paid', 'paid')),
           0
         ) AS issued_or_paid_total,
         COALESCE(SUM(grand_total) FILTER (WHERE status = 'draft'), 0) AS draft_total,
         COALESCE(SUM(balance_due) FILTER (WHERE status != 'void'), 0) AS period_outstanding,
         COUNT(*) FILTER (WHERE status = 'void')::int AS void_count,
         COALESCE(SUM(grand_total) FILTER (WHERE status = 'void'), 0) AS void_total
       FROM invoices
       WHERE property_id = $1
         AND issue_date >= $2::date
         AND issue_date <= $3::date`,
      [property.id, dateFrom, dateTo]
    ),
    // 6. Property-wide open invoice balance across all non-void invoices
    pool.query(
      `SELECT COALESCE(SUM(balance_due), 0) AS total_open_balance
       FROM invoices
       WHERE property_id = $1 AND status != 'void'`,
      [property.id]
    ),
    // 7. Non-void invoice line-item type breakdown in period
    pool.query(
      `SELECT
         ili.item_type,
         COUNT(*)::int AS line_count,
         COALESCE(SUM(ili.net_amount), 0) AS net_amount,
         COALESCE(SUM(ili.tax_amount), 0) AS tax_amount,
         COALESCE(SUM(ili.line_total), 0) AS line_total
       FROM invoice_line_items ili
       JOIN invoices i ON i.id = ili.invoice_id
       WHERE i.property_id = $1
         AND i.status != 'void'
         AND i.issue_date >= $2::date
         AND i.issue_date <= $3::date
       GROUP BY ili.item_type
       ORDER BY ABS(SUM(ili.line_total)) DESC, ili.item_type ASC`,
      [property.id, dateFrom, dateTo]
    ),
    // 8. Payments received in period (by payment_date)
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE p.status = 'completed')::int AS completed_count,
         COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'completed'), 0) AS completed_total,
         COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'refunded'), 0) AS refunded_total
       FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.property_id = $1
         AND p.payment_date >= $2::date
         AND p.payment_date <= $3::date
         AND (i.id IS NULL OR i.status != 'void')`,
      [property.id, dateFrom, dateTo]
    ),
    // 9. Completed payments by payment method
    pool.query(
      `SELECT
         p.payment_method,
         COUNT(*)::int AS payment_count,
         COALESCE(SUM(p.amount), 0) AS total_amount
       FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.property_id = $1
         AND p.status = 'completed'
         AND p.payment_date >= $2::date
         AND p.payment_date <= $3::date
         AND (i.id IS NULL OR i.status != 'void')
       GROUP BY p.payment_method
       ORDER BY total_amount DESC, p.payment_method ASC`,
      [property.id, dateFrom, dateTo]
    ),
    // 10. Restaurant POS & Room-Service context in period
    pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE order_type IN ('restaurant', 'takeaway') AND status = 'served'
         )::int AS pos_served_count,
         COALESCE(
           SUM(total_amount) FILTER (
             WHERE order_type IN ('restaurant', 'takeaway') AND status = 'served'
           ),
           0
         ) AS pos_served_total,
         COALESCE(
           SUM(total_amount) FILTER (
             WHERE order_type = 'room_service' AND billing_status = 'posted'
           ),
           0
         ) AS room_service_posted_total
       FROM food_orders
       WHERE property_id = $1
         AND (placed_at AT TIME ZONE $2)::date >= $3::date
         AND (placed_at AT TIME ZONE $2)::date <= $4::date`,
      [property.id, property.timezone, dateFrom, dateTo]
    ),
    // 11. Active physical & sellable room inventory
    pool.query(
      `SELECT
         COUNT(*)::int AS total_active_rooms,
         COUNT(*) FILTER (
           WHERE operational_status = 'available' AND housekeeping_status != 'out_of_service'
         )::int AS sellable_rooms
       FROM rooms
       WHERE property_id = $1 AND is_active = TRUE`,
      [property.id]
    ),
    // 12. Overlapping room nights & ADR numerator across [dateFrom, periodEndExclusive)
    pool.query(
      `SELECT
         COUNT(*)::int AS overlapping_total,
         COALESCE(
           SUM(
             GREATEST(
               0,
               (LEAST(departure_date, $3::date) - GREATEST(arrival_date, $2::date))
             )
           ) FILTER (WHERE status IN ('checked_in', 'checked_out')),
           0
         )::int AS occupied_nights_actual,
         COALESCE(
           SUM(
             GREATEST(
               0,
               (LEAST(departure_date, $3::date) - GREATEST(arrival_date, $2::date))
             )
           ) FILTER (WHERE status IN ('confirmed', 'checked_in', 'checked_out')),
           0
         )::int AS committed_nights,
         COALESCE(
           SUM(
             GREATEST(
               0,
               (LEAST(departure_date, $3::date) - GREATEST(arrival_date, $2::date))
             ) * GREATEST(0, nightly_rate - (discount_amount / GREATEST(1, nights)))
           ) FILTER (WHERE status IN ('checked_in', 'checked_out')),
           0
         ) AS occupied_room_net_revenue
       FROM reservations
       WHERE property_id = $1
         AND arrival_date < $3::date
         AND departure_date > $2::date`,
      [property.id, dateFrom, periodEndExclusive]
    ),
    // 13. Arrivals and departures falling inside [dateFrom, dateTo]
    pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE arrival_date >= $2::date AND arrival_date <= $3::date AND status != 'cancelled'
         )::int AS arrivals_count,
         COUNT(*) FILTER (
           WHERE departure_date >= $2::date AND departure_date <= $3::date AND status IN ('checked_in', 'checked_out')
         )::int AS departures_count
       FROM reservations
       WHERE property_id = $1`,
      [property.id, dateFrom, dateTo]
    ),
    // 14. Overlapping reservations breakdown by status
    pool.query(
      `SELECT
         status,
         COUNT(*)::int AS reservation_count,
         COALESCE(
           SUM(
             GREATEST(
               0,
               (LEAST(departure_date, $3::date) - GREATEST(arrival_date, $2::date))
             )
           ),
           0
         )::int AS room_nights_in_period,
         COALESCE(SUM(estimated_total), 0) AS estimated_total_value
       FROM reservations
       WHERE property_id = $1
         AND arrival_date < $3::date
         AND departure_date > $2::date
       GROUP BY status
       ORDER BY reservation_count DESC, status ASC`,
      [property.id, dateFrom, periodEndExclusive]
    ),
    // 15. Overlapping non-cancelled reservations breakdown by booking source
    pool.query(
      `SELECT
         source,
         COUNT(*)::int AS reservation_count,
         COALESCE(SUM(estimated_total), 0) AS estimated_total_value
       FROM reservations
       WHERE property_id = $1
         AND status != 'cancelled'
         AND arrival_date < $3::date
         AND departure_date > $2::date
       GROUP BY source
       ORDER BY estimated_total_value DESC, reservation_count DESC, source ASC`,
      [property.id, dateFrom, periodEndExclusive]
    ),
    // 16. Inventory current valuation snapshot
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active_items_count,
         COUNT(*) FILTER (WHERE is_active = FALSE)::int AS inactive_items_count,
         COUNT(*) FILTER (WHERE is_active = TRUE AND current_stock <= reorder_level)::int AS low_stock_count,
         COUNT(*) FILTER (WHERE is_active = TRUE AND current_stock <= 0)::int AS out_of_stock_count,
         COALESCE(
           SUM(ROUND(current_stock * unit_cost, 2)) FILTER (WHERE is_active = TRUE),
           0
         ) AS total_valuation
       FROM inventory_products
       WHERE property_id = $1`,
      [property.id]
    ),
    // 17. Inventory valuation by category
    pool.query(
      `SELECT
         ip.category_id,
         COALESCE(ic.name, ip.category, 'Uncategorized') AS category_name,
         COUNT(*) FILTER (WHERE ip.is_active = TRUE)::int AS active_item_count,
         COUNT(*) FILTER (WHERE ip.is_active = TRUE AND ip.current_stock <= ip.reorder_level)::int AS low_stock_count,
         COALESCE(SUM(ip.current_stock) FILTER (WHERE ip.is_active = TRUE), 0) AS total_units,
         COALESCE(
           SUM(ROUND(ip.current_stock * ip.unit_cost, 2)) FILTER (WHERE ip.is_active = TRUE),
           0
         ) AS valuation_amount
       FROM inventory_products ip
       LEFT JOIN inventory_categories ic
         ON ic.id = ip.category_id AND ic.property_id = ip.property_id
       WHERE ip.property_id = $1
       GROUP BY ip.category_id, COALESCE(ic.name, ip.category, 'Uncategorized')
       HAVING COUNT(*) FILTER (WHERE ip.is_active = TRUE) > 0
       ORDER BY valuation_amount DESC, category_name ASC`,
      [property.id]
    ),
    // 18. Inventory purchase receipts in period
    pool.query(
      `SELECT
         COUNT(*)::int AS cnt,
         COALESCE(SUM(total_amount), 0) AS total_amount
       FROM inventory_receipts
       WHERE property_id = $1
         AND receipt_date >= $2::date
         AND receipt_date <= $3::date`,
      [property.id, dateFrom, dateTo]
    ),
    // 19. Stock movements summary in period
    pool.query(
      `SELECT
         COUNT(*)::int AS total_movements,
         COALESCE(SUM(quantity) FILTER (WHERE quantity_delta > 0), 0) AS total_in_qty,
         COALESCE(SUM(quantity) FILTER (WHERE quantity_delta < 0), 0) AS total_out_qty,
         COALESCE(SUM(quantity) FILTER (WHERE movement_source = 'wastage'), 0) AS total_wastage_qty,
         COALESCE(SUM(quantity_delta), 0) AS net_delta
       FROM stock_movements
       WHERE property_id = $1
         AND (created_at AT TIME ZONE $2)::date >= $3::date
         AND (created_at AT TIME ZONE $2)::date <= $4::date`,
      [property.id, property.timezone, dateFrom, dateTo]
    ),
    // 20. Stock movements by movement_source in period
    pool.query(
      `SELECT
         movement_source,
         COUNT(*)::int AS movement_count,
         COALESCE(SUM(quantity), 0) AS total_quantity,
         COALESCE(SUM(quantity_delta), 0) AS net_delta,
         COALESCE(SUM(ROUND(quantity_delta * unit_cost, 2)), 0) AS estimated_value_impact
       FROM stock_movements
       WHERE property_id = $1
         AND (created_at AT TIME ZONE $2)::date >= $3::date
         AND (created_at AT TIME ZONE $2)::date <= $4::date
       GROUP BY movement_source
       ORDER BY movement_count DESC, movement_source ASC`,
      [property.id, property.timezone, dateFrom, dateTo]
    ),
  ]);

  // Assemble Expenses Section
  const expRow = expTotalsRes.rows[0] ?? {};
  const recordedExpensesTotal = roundCurrency(Number(expRow.recorded_total ?? 0));

  const expensesByCategory: ExpenseCategoryBreakdownItem[] = expByCatRes.rows.map((r) => {
    const amt = roundCurrency(Number(r.recorded_amount ?? 0));
    const sharePercent =
      recordedExpensesTotal > 0 ? roundOneDecimal((amt / recordedExpensesTotal) * 100) : 0;
    return {
      categoryId: r.category_id ? String(r.category_id) : null,
      categoryCode: String(r.category_code),
      categoryName: String(r.category_name),
      isCategoryActive: Boolean(r.is_category_active),
      recordedCount: Number(r.recorded_count ?? 0),
      recordedAmount: amt,
      sharePercent,
    };
  });

  const expensesByMethod: ExpensePaymentMethodBreakdownItem[] = expByMethodRes.rows.map(
    (r) => ({
      paymentMethod: r.payment_method,
      recordedCount: Number(r.recorded_count ?? 0),
      recordedAmount: roundCurrency(Number(r.recorded_amount ?? 0)),
    })
  );

  // Assemble Billing & Revenue Section
  const invRow = invPeriodRes.rows[0] ?? {};
  const payRow = paymentsSumRes.rows[0] ?? {};
  const posRow = posSummaryRes.rows[0] ?? {};
  const recordedBilledTotal = roundCurrency(Number(invRow.billed_total ?? 0));
  const paymentsReceivedTotal = roundCurrency(Number(payRow.completed_total ?? 0));

  // Assemble Occupancy Section
  const roomRow = roomsSummaryRes.rows[0] ?? {};
  const totalActiveRooms = Number(roomRow.total_active_rooms ?? 0);
  const currentSellableRooms = Number(roomRow.sellable_rooms ?? 0);
  const unavailableRoomsCount = Math.max(0, totalActiveRooms - currentSellableRooms);
  const availableRoomNights = currentSellableRooms * dayCount;

  const occRow = resOverlapAggRes.rows[0] ?? {};
  const occupiedRoomNightsActual = Number(occRow.occupied_nights_actual ?? 0);
  const committedRoomNightsIncludingConfirmed = Number(occRow.committed_nights ?? 0);
  const occupiedRoomNetRevenue = Number(occRow.occupied_room_net_revenue ?? 0);

  const occupancyRatePercent =
    availableRoomNights > 0
      ? roundOneDecimal((occupiedRoomNightsActual / availableRoomNights) * 100)
      : 0;
  const committedOccupancyRatePercent =
    availableRoomNights > 0
      ? roundOneDecimal(
          (committedRoomNightsIncludingConfirmed / availableRoomNights) * 100
        )
      : 0;
  const averageDailyRateEstimate =
    occupiedRoomNightsActual > 0
      ? roundCurrency(occupiedRoomNetRevenue / occupiedRoomNightsActual)
      : 0;

  const arrDepRow = resArrDepRes.rows[0] ?? {};

  // Assemble Inventory Section
  const invProdRow = invProductsRes.rows[0] ?? {};
  const invRecRow = invReceiptsRes.rows[0] ?? {};
  const invMovRow = invMovSumRes.rows[0] ?? {};

  return {
    property,
    period: {
      dateFrom,
      dateTo,
      dayCount,
      timezone: property.timezone,
      currency: property.currency,
      generatedAt: new Date().toISOString(),
    },
    expenses: {
      recordedCount: Number(expRow.recorded_count ?? 0),
      recordedTotal: recordedExpensesTotal,
      recordedTaxTotal: roundCurrency(Number(expRow.recorded_tax_total ?? 0)),
      voidedCount: Number(expRow.voided_count ?? 0),
      voidedTotal: roundCurrency(Number(expRow.voided_total ?? 0)),
      byCategory: expensesByCategory,
      byPaymentMethod: expensesByMethod,
      dailyTrend: expDailyRes.rows.map((r) => ({
        date: String(r.date).slice(0, 10),
        recordedCount: Number(r.recorded_count ?? 0),
        recordedAmount: roundCurrency(Number(r.recorded_amount ?? 0)),
      })),
    },
    billing: {
      activeInvoicesCount: Number(invRow.active_count ?? 0),
      draftInvoicesCount: Number(invRow.draft_count ?? 0),
      issuedUnpaidCount: Number(invRow.issued_unpaid_count ?? 0),
      partiallyPaidCount: Number(invRow.partially_paid_count ?? 0),
      paidInvoicesCount: Number(invRow.paid_count ?? 0),
      recordedBilledSubtotal: roundCurrency(Number(invRow.billed_subtotal ?? 0)),
      recordedDiscountTotal: roundCurrency(Number(invRow.discount_total ?? 0)),
      recordedTaxTotal: roundCurrency(Number(invRow.tax_total ?? 0)),
      recordedBilledTotal,
      issuedOrPaidBilledTotal: roundCurrency(Number(invRow.issued_or_paid_total ?? 0)),
      draftBilledTotal: roundCurrency(Number(invRow.draft_total ?? 0)),
      periodInvoicesOutstandingBalance: roundCurrency(
        Number(invRow.period_outstanding ?? 0)
      ),
      propertyTotalOutstandingBalance: roundCurrency(
        Number(invOpenAllRes.rows[0]?.total_open_balance ?? 0)
      ),
      voidedInvoicesCount: Number(invRow.void_count ?? 0),
      voidedInvoicesTotal: roundCurrency(Number(invRow.void_total ?? 0)),
      paymentsReceivedCount: Number(payRow.completed_count ?? 0),
      paymentsReceivedTotal,
      refundedPaymentsTotal: roundCurrency(Number(payRow.refunded_total ?? 0)),
      byLineItemType: invLinesRes.rows.map((r) => ({
        itemType: r.item_type as InvoiceItemType,
        lineCount: Number(r.line_count ?? 0),
        netAmount: roundCurrency(Number(r.net_amount ?? 0)),
        taxAmount: roundCurrency(Number(r.tax_amount ?? 0)),
        lineTotal: roundCurrency(Number(r.line_total ?? 0)),
      })),
      paymentsByMethod: paymentsByMethodRes.rows.map((r) => ({
        paymentMethod: r.payment_method as PaymentMethod,
        paymentCount: Number(r.payment_count ?? 0),
        totalAmount: roundCurrency(Number(r.total_amount ?? 0)),
      })),
      directRestaurantPosServedCount: Number(posRow.pos_served_count ?? 0),
      directRestaurantPosServedTotal: roundCurrency(Number(posRow.pos_served_total ?? 0)),
      roomServicePostedToFolioTotal: roundCurrency(
        Number(posRow.room_service_posted_total ?? 0)
      ),
    },
    operatingComparison: {
      recordedBilledRevenue: recordedBilledTotal,
      paymentsReceived: paymentsReceivedTotal,
      recordedOperatingExpenses: recordedExpensesTotal,
      billedRevenueMinusExpenses: roundCurrency(
        recordedBilledTotal - recordedExpensesTotal
      ),
      paymentsReceivedMinusExpenses: roundCurrency(
        paymentsReceivedTotal - recordedExpensesTotal
      ),
      disclaimerTitle:
        'Operational Revenue vs. Recorded Expenses — Not Audited Profit',
      exclusionsAndLimitations: [
        'Figures represent internal PMS operational summaries and must not be treated as audited GAAP/IFRS net profit or statutory tax filings.',
        'Voided invoices and voided operating expenses are strictly excluded from active revenue, balance due, and operating expense totals and are reported separately for audit transparency.',
        'Invoice revenue is bucketed by invoice issue_date, payments received by payment_date (completed status), and operating expenses by expense_date.',
        'Inventory stock purchase receipts (Phase 5) update on-hand stock valuation and are tracked separately from operating expense vouchers unless an explicit expense entry is recorded.',
        'Uninvoiced stays, standalone walk-in POS tickets not billed on guest folios, depreciation, financing charges, unrecorded payroll, and corporate income taxes are excluded from invoice-vs-expense differences.',
      ],
    },
    occupancy: {
      totalActiveRooms,
      currentSellableRooms,
      unavailableRoomsCount,
      availableRoomNights,
      occupiedRoomNightsActual,
      committedRoomNightsIncludingConfirmed,
      occupancyRatePercent,
      committedOccupancyRatePercent,
      averageDailyRateEstimate,
      overlappingReservationsTotal: Number(occRow.overlapping_total ?? 0),
      arrivalsInPeriodCount: Number(arrDepRow.arrivals_count ?? 0),
      departuresInPeriodCount: Number(arrDepRow.departures_count ?? 0),
      byStatus: resByStatusRes.rows.map((r) => ({
        status: r.status as ReservationStatus,
        reservationCount: Number(r.reservation_count ?? 0),
        roomNightsInPeriod: Number(r.room_nights_in_period ?? 0),
        estimatedTotalValue: roundCurrency(Number(r.estimated_total_value ?? 0)),
      })),
      bySource: resBySourceRes.rows.map((r) => ({
        source: r.source as BookingSource,
        reservationCount: Number(r.reservation_count ?? 0),
        estimatedTotalValue: roundCurrency(Number(r.estimated_total_value ?? 0)),
      })),
    },
    inventory: {
      activeItemsCount: Number(invProdRow.active_items_count ?? 0),
      inactiveItemsCount: Number(invProdRow.inactive_items_count ?? 0),
      lowStockCount: Number(invProdRow.low_stock_count ?? 0),
      outOfStockCount: Number(invProdRow.out_of_stock_count ?? 0),
      totalInventoryValuation: roundCurrency(Number(invProdRow.total_valuation ?? 0)),
      receiptsInPeriodCount: Number(invRecRow.cnt ?? 0),
      receiptsInPeriodAmount: roundCurrency(Number(invRecRow.total_amount ?? 0)),
      movementsInPeriodCount: Number(invMovRow.total_movements ?? 0),
      totalInQuantity: roundCurrency(Number(invMovRow.total_in_qty ?? 0)),
      totalOutQuantity: roundCurrency(Number(invMovRow.total_out_qty ?? 0)),
      totalWastageQuantity: roundCurrency(Number(invMovRow.total_wastage_qty ?? 0)),
      netQuantityDelta: roundCurrency(Number(invMovRow.net_delta ?? 0)),
      valuationByCategory: invValByCatRes.rows.map((r) => ({
        categoryId: r.category_id ? String(r.category_id) : null,
        categoryName: String(r.category_name),
        activeItemCount: Number(r.active_item_count ?? 0),
        lowStockCount: Number(r.low_stock_count ?? 0),
        totalUnits: roundCurrency(Number(r.total_units ?? 0)),
        valuationAmount: roundCurrency(Number(r.valuation_amount ?? 0)),
      })),
      movementsBySource: invMovBySourceRes.rows.map((r) => ({
        movementSource: r.movement_source as StockMovementSource,
        movementCount: Number(r.movement_count ?? 0),
        totalQuantity: roundCurrency(Number(r.total_quantity ?? 0)),
        netQuantityDelta: roundCurrency(Number(r.net_delta ?? 0)),
        estimatedValueImpact: roundCurrency(Number(r.estimated_value_impact ?? 0)),
      })),
    },
  };
}
