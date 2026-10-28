import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  BedDouble,
  Building2,
  Calendar,
  CreditCard,
  Info,
  Package,
  Receipt,
  RefreshCw,
  Scale,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import {
  BOOKING_SOURCE_LABELS,
  EXPENSE_PAYMENT_METHOD_LABELS,
  INVOICE_ITEM_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  STOCK_MOVEMENT_SOURCE_LABELS,
} from '@shared/constants';
import { addDays, formatDisplayDate, getPropertyLocalDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type { PropertyFinancialOperationalReport } from '@shared/types';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import {
  ReservationStatusBadge,
  StockMovementSourceBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';

type DatePresetKey = 'today' | 'last7' | 'mtd' | 'last30' | 'last90' | 'custom';

export function ReportsPage() {
  const { selectedProperty } = useAuth();

  const [preset, setPreset] = useState<DatePresetKey>('mtd');
  const [dateFromInput, setDateFromInput] = useState('');
  const [dateToInput, setDateToInput] = useState('');
  const [appliedRange, setAppliedRange] = useState<{
    dateFrom: string;
    dateTo: string;
  } | null>(null);

  const [report, setReport] = useState<PropertyFinancialOperationalReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initialize default Month-to-Date range when property loads or changes
  useEffect(() => {
    if (!selectedProperty) return;
    const today = getPropertyLocalDate(selectedProperty.timezone);
    const monthStart = `${today.slice(0, 7)}-01`;
    setPreset('mtd');
    setDateFromInput(monthStart);
    setDateToInput(today);
    setAppliedRange({ dateFrom: monthStart, dateTo: today });
  }, [selectedProperty?.id, selectedProperty?.timezone]);

  const loadReport = useCallback(async () => {
    if (!selectedProperty || !appliedRange) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        dateFrom: appliedRange.dateFrom,
        dateTo: appliedRange.dateTo,
      });
      const res = await apiFetch<{ report: PropertyFinancialOperationalReport }>(
        `/api/reports/overview?${qs.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setReport(res.report);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedProperty, appliedRange]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  if (!selectedProperty) {
    return <LoadingState label="Selecting property..." />;
  }

  const applyPreset = (nextPreset: Exclude<DatePresetKey, 'custom'>) => {
    const today = getPropertyLocalDate(selectedProperty.timezone);
    let from = today;
    const to = today;

    if (nextPreset === 'today') {
      from = today;
    } else if (nextPreset === 'last7') {
      from = addDays(today, -6);
    } else if (nextPreset === 'mtd') {
      from = `${today.slice(0, 7)}-01`;
    } else if (nextPreset === 'last30') {
      from = addDays(today, -29);
    } else if (nextPreset === 'last90') {
      from = addDays(today, -89);
    }

    setPreset(nextPreset);
    setDateFromInput(from);
    setDateToInput(to);
    setAppliedRange({ dateFrom: from, dateTo: to });
  };

  const handleApplyCustomRange = (e: React.FormEvent) => {
    e.preventDefault();
    setPreset('custom');
    setAppliedRange({
      dateFrom: dateFromInput.trim(),
      dateTo: dateToInput.trim(),
    });
  };

  const currency = selectedProperty.currency;

  const maxComparisonBar = report
    ? Math.max(
        1,
        report.operatingComparison.recordedBilledRevenue,
        report.operatingComparison.paymentsReceived,
        report.operatingComparison.recordedOperatingExpenses
      )
    : 1;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Financial & Operational Reports
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Server-aggregated billing, payments, operating expenses, room occupancy, and
            stock valuation for{' '}
            <span className="font-medium text-slate-700">{selectedProperty.name}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            to="/expenses"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Wallet className="h-4 w-4 text-indigo-600" />
            Manage Expenses
          </Link>
          <Link
            to="/invoices"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Receipt className="h-4 w-4 text-indigo-600" />
            Invoices & Folios
          </Link>
          <button
            type="button"
            onClick={() => void loadReport()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Date Range Filter Bar */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { key: 'today', label: 'Today' },
                { key: 'last7', label: 'Last 7 Days' },
                { key: 'mtd', label: 'Month to Date' },
                { key: 'last30', label: 'Last 30 Days' },
                { key: 'last90', label: 'Last 90 Days' },
              ] as const
            ).map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p.key)}
                className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                  preset === p.key
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <form
            onSubmit={handleApplyCustomRange}
            className="flex flex-wrap items-center gap-2"
          >
            <label className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 text-slate-400" />
              From
              <input
                type="date"
                aria-label="Report start date"
                required
                value={dateFromInput}
                onChange={(e) => setDateFromInput(e.target.value)}
                className="rounded-xl border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-800 focus:border-indigo-500 focus:outline-none"
              />
            </label>
            <label className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
              To
              <input
                type="date"
                aria-label="Report end date"
                required
                value={dateToInput}
                onChange={(e) => setDateToInput(e.target.value)}
                className="rounded-xl border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-800 focus:border-indigo-500 focus:outline-none"
              />
            </label>
            <button
              type="submit"
              className="rounded-xl bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Apply Range
            </button>
          </form>
        </div>

        {report && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-xs text-slate-500">
            <span>
              Reporting Window:{' '}
              <strong className="text-slate-800">
                {formatDisplayDate(report.period.dateFrom)} —{' '}
                {formatDisplayDate(report.period.dateTo)}
              </strong>{' '}
              ({report.period.dayCount} day{report.period.dayCount === 1 ? '' : 's'},{' '}
              {report.period.timezone})
            </span>
            <span>Currency: {report.period.currency}</span>
          </div>
        )}
      </div>

      {error && <ErrorAlert message={error} onRetry={() => void loadReport()} />}

      {loading ? (
        <LoadingState label="Aggregating property financial & operational metrics..." />
      ) : !report ? (
        <EmptyState
          title="Report unavailable"
          description="Select a valid reporting date range to load operational metrics."
        />
      ) : (
        <div className="space-y-6">
          {/* Top 6 KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Recorded Billed Revenue
                </span>
                <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600">
                  <Receipt className="h-4 w-4" />
                </div>
              </div>
              <p
                data-testid="report-billed-revenue"
                className="mt-2 text-2xl font-bold text-slate-900"
              >
                {formatMoney(report.billing.recordedBilledTotal, currency)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {report.billing.activeInvoicesCount} active invoice
                {report.billing.activeInvoicesCount === 1 ? '' : 's'} (
                {report.billing.voidedInvoicesCount} void excluded)
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Payments Received
                </span>
                <div className="rounded-xl bg-emerald-50 p-2 text-emerald-600">
                  <CreditCard className="h-4 w-4" />
                </div>
              </div>
              <p
                data-testid="report-payments-received"
                className="mt-2 text-2xl font-bold text-emerald-700"
              >
                {formatMoney(report.billing.paymentsReceivedTotal, currency)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {report.billing.paymentsReceivedCount} completed settlement
                {report.billing.paymentsReceivedCount === 1 ? '' : 's'} in range
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Outstanding Folio Balances
                </span>
                <div className="rounded-xl bg-amber-50 p-2 text-amber-600">
                  <Building2 className="h-4 w-4" />
                </div>
              </div>
              <p
                data-testid="report-outstanding-balance"
                className="mt-2 text-2xl font-bold text-amber-700"
              >
                {formatMoney(report.billing.periodInvoicesOutstandingBalance, currency)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Property-wide open folios:{' '}
                {formatMoney(report.billing.propertyTotalOutstandingBalance, currency)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Recorded Operating Expenses
                </span>
                <div className="rounded-xl bg-rose-50 p-2 text-rose-600">
                  <Wallet className="h-4 w-4" />
                </div>
              </div>
              <p
                data-testid="report-recorded-expenses"
                className="mt-2 text-2xl font-bold text-slate-900"
              >
                {formatMoney(report.expenses.recordedTotal, currency)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {report.expenses.recordedCount} active voucher
                {report.expenses.recordedCount === 1 ? '' : 's'} (
                {report.expenses.voidedCount} voided excluded)
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Room Occupancy (Actual)
                </span>
                <div className="rounded-xl bg-sky-50 p-2 text-sky-600">
                  <BedDouble className="h-4 w-4" />
                </div>
              </div>
              <p
                data-testid="report-occupancy-rate"
                className="mt-2 text-2xl font-bold text-slate-900"
              >
                {report.occupancy.occupancyRatePercent.toFixed(1)}%
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {report.occupancy.occupiedRoomNightsActual} /{' '}
                {report.occupancy.availableRoomNights} room-nights · Est. ADR{' '}
                {formatMoney(report.occupancy.averageDailyRateEstimate, currency)}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Current Stock Valuation
                </span>
                <div className="rounded-xl bg-teal-50 p-2 text-teal-600">
                  <Package className="h-4 w-4" />
                </div>
              </div>
              <p
                data-testid="report-inventory-valuation"
                className="mt-2 text-2xl font-bold text-slate-900"
              >
                {formatMoney(report.inventory.totalInventoryValuation, currency)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {report.inventory.activeItemsCount} active items ·{' '}
                {report.inventory.lowStockCount} low-stock alert
                {report.inventory.lowStockCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          {/* SECTION 1: OPERATING REVENUE VS. RECORDED EXPENSES + HONEST DISCLAIMER */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-5">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Scale className="h-5 w-5 text-indigo-600" />
                  {report.operatingComparison.disclaimerTitle}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Side-by-side comparison of recorded guest billing, completed payment
                  collections, and recorded operating expenses for the selected window.
                </p>
              </div>

              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900 shrink-0">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                Unaudited Operational Summary
              </span>
            </div>

            {/* Visual Bar Comparison & Net Operational Differences */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-center">
              <div className="lg:col-span-7 space-y-3.5">
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-semibold text-slate-700">
                      Recorded Billed Revenue (Non-Void Invoices)
                    </span>
                    <span className="font-bold text-slate-900">
                      {formatMoney(
                        report.operatingComparison.recordedBilledRevenue,
                        currency
                      )}
                    </span>
                  </div>
                  <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-indigo-600"
                      style={{
                        width: `${Math.min(
                          100,
                          (report.operatingComparison.recordedBilledRevenue /
                            maxComparisonBar) *
                            100
                        )}%`,
                      }}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-semibold text-slate-700">
                      Completed Payments Received
                    </span>
                    <span className="font-bold text-emerald-700">
                      {formatMoney(report.operatingComparison.paymentsReceived, currency)}
                    </span>
                  </div>
                  <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{
                        width: `${Math.min(
                          100,
                          (report.operatingComparison.paymentsReceived /
                            maxComparisonBar) *
                            100
                        )}%`,
                      }}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-semibold text-slate-700">
                      Recorded Operating Expenses (Active Vouchers)
                    </span>
                    <span className="font-bold text-rose-700">
                      {formatMoney(
                        report.operatingComparison.recordedOperatingExpenses,
                        currency
                      )}
                    </span>
                  </div>
                  <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-rose-500"
                      style={{
                        width: `${Math.min(
                          100,
                          (report.operatingComparison.recordedOperatingExpenses /
                            maxComparisonBar) *
                            100
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="lg:col-span-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3.5">
                  <p className="text-xs font-semibold text-slate-600">
                    Billed Revenue Minus Recorded Expenses
                  </p>
                  <p
                    data-testid="report-billed-minus-expenses"
                    className={`mt-1 text-xl font-bold ${
                      report.operatingComparison.billedRevenueMinusExpenses >= 0
                        ? 'text-slate-900'
                        : 'text-rose-700'
                    }`}
                  >
                    {formatMoney(
                      report.operatingComparison.billedRevenueMinusExpenses,
                      currency
                    )}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Unaudited operational billing difference (not GAAP net profit)
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3.5">
                  <p className="text-xs font-semibold text-slate-600">
                    Payments Received Minus Recorded Expenses
                  </p>
                  <p
                    data-testid="report-payments-minus-expenses"
                    className={`mt-1 text-xl font-bold ${
                      report.operatingComparison.paymentsReceivedMinusExpenses >= 0
                        ? 'text-emerald-700'
                        : 'text-rose-700'
                    }`}
                  >
                    {formatMoney(
                      report.operatingComparison.paymentsReceivedMinusExpenses,
                      currency
                    )}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Unaudited collected receipts minus expense vouchers
                  </p>
                </div>
              </div>
            </div>

            {/* Exclusions & Limitations Disclosure */}
            <div
              data-testid="report-exclusions-panel"
              className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-xs text-amber-950 space-y-1.5"
            >
              <p className="font-bold flex items-center gap-1.5">
                <Info className="h-4 w-4 text-amber-700 shrink-0" />
                Scope, Exclusions & Accounting Limitations (Not Audited Profit)
              </p>
              <ul className="list-disc pl-5 space-y-1 text-amber-900/90 leading-relaxed">
                {report.operatingComparison.exclusionsAndLimitations.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          </div>

          {/* SECTION 2: BILLING, INVOICES, PAYMENTS & VOIDED INVOICES */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Invoice & Charge Breakdown */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Revenue & Invoice Summary
                  </h2>
                  <p className="text-xs text-slate-500">
                    Active invoices issued during the selected period
                  </p>
                </div>
                <Receipt className="h-5 w-5 text-indigo-600" />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Draft</span>
                  <p className="text-sm font-bold text-slate-800 mt-0.5">
                    {report.billing.draftInvoicesCount}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {formatMoney(report.billing.draftBilledTotal, currency)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Issued Unpaid</span>
                  <p className="text-sm font-bold text-amber-700 mt-0.5">
                    {report.billing.issuedUnpaidCount}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Partially Paid</span>
                  <p className="text-sm font-bold text-sky-700 mt-0.5">
                    {report.billing.partiallyPaidCount}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Paid in Full</span>
                  <p className="text-sm font-bold text-emerald-700 mt-0.5">
                    {report.billing.paidInvoicesCount}
                  </p>
                </div>
              </div>

              {/* Separate Voided Invoices Box */}
              <div
                data-testid="report-voided-invoices-box"
                className="rounded-xl border border-rose-200 bg-rose-50/60 px-3.5 py-2.5 flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-2 text-rose-900">
                  <Ban className="h-4 w-4 text-rose-600 shrink-0" />
                  <div>
                    <p className="font-semibold">
                      Voided Invoices (Shown Separately — Excluded from Revenue)
                    </p>
                    <p className="text-rose-700">
                      {report.billing.voidedInvoicesCount} voided invoice
                      {report.billing.voidedInvoicesCount === 1 ? '' : 's'} in period
                    </p>
                  </div>
                </div>
                <span className="font-bold text-rose-800 whitespace-nowrap">
                  {formatMoney(report.billing.voidedInvoicesTotal, currency)}
                </span>
              </div>

              {/* Line Item Breakdown */}
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                  Billed Charges by Folio Line Type
                </h3>
                {report.billing.byLineItemType.length === 0 ? (
                  <p className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-200 rounded-xl">
                    No active invoice line items issued in this date range.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200 text-xs">
                      <thead className="bg-slate-50 font-semibold text-slate-600">
                        <tr>
                          <th className="px-3 py-2 text-left">Charge Category</th>
                          <th className="px-3 py-2 text-right">Lines</th>
                          <th className="px-3 py-2 text-right">Net</th>
                          <th className="px-3 py-2 text-right">Tax</th>
                          <th className="px-3 py-2 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {report.billing.byLineItemType.map((line) => (
                          <tr key={line.itemType}>
                            <td className="px-3 py-2 font-medium text-slate-800">
                              {INVOICE_ITEM_TYPE_LABELS[line.itemType] ?? line.itemType}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600">
                              {line.lineCount}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-700">
                              {formatMoney(line.netAmount, currency)}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600">
                              {formatMoney(line.taxAmount, currency)}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-slate-900">
                              {formatMoney(line.lineTotal, currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Payments Received & Outstanding Summary */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Payments Received & Open Balances
                  </h2>
                  <p className="text-xs text-slate-500">
                    Completed settlements by payment date and method
                  </p>
                </div>
                <CreditCard className="h-5 w-5 text-emerald-600" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                  <span className="text-emerald-800 font-semibold">
                    Completed Payments (Period)
                  </span>
                  <p className="text-lg font-bold text-emerald-900 mt-0.5">
                    {formatMoney(report.billing.paymentsReceivedTotal, currency)}
                  </p>
                  <p className="text-emerald-700">
                    {report.billing.paymentsReceivedCount} payment record
                    {report.billing.paymentsReceivedCount === 1 ? '' : 's'}
                  </p>
                </div>

                <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                  <span className="text-amber-900 font-semibold">
                    Open Balance (Period Invoices)
                  </span>
                  <p className="text-lg font-bold text-amber-900 mt-0.5">
                    {formatMoney(
                      report.billing.periodInvoicesOutstandingBalance,
                      currency
                    )}
                  </p>
                  <p className="text-amber-800">
                    All open folios:{' '}
                    {formatMoney(report.billing.propertyTotalOutstandingBalance, currency)}
                  </p>
                </div>
              </div>

              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                  Payments by Method
                </h3>
                {report.billing.paymentsByMethod.length === 0 ? (
                  <p className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-200 rounded-xl">
                    No completed invoice payments recorded in this date range.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200 text-xs">
                      <thead className="bg-slate-50 font-semibold text-slate-600">
                        <tr>
                          <th className="px-3 py-2 text-left">Payment Method</th>
                          <th className="px-3 py-2 text-right">Transactions</th>
                          <th className="px-3 py-2 text-right">Amount Received</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {report.billing.paymentsByMethod.map((pm) => (
                          <tr key={pm.paymentMethod}>
                            <td className="px-3 py-2 font-medium text-slate-800">
                              {PAYMENT_METHOD_LABELS[pm.paymentMethod] ?? pm.paymentMethod}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600">
                              {pm.paymentCount}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-emerald-700">
                              {formatMoney(pm.totalAmount, currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Restaurant & Room-Service POS Context */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
                <p className="font-semibold text-slate-800">
                  Food & Restaurant Activity (Informational Context)
                </p>
                <p className="text-slate-600">
                  Room-service posted to guest folios:{' '}
                  <strong>
                    {formatMoney(report.billing.roomServicePostedToFolioTotal, currency)}
                  </strong>{' '}
                  · Served walk-in/takeaway POS tickets:{' '}
                  <strong>
                    {formatMoney(report.billing.directRestaurantPosServedTotal, currency)}
                  </strong>{' '}
                  ({report.billing.directRestaurantPosServedCount} order
                  {report.billing.directRestaurantPosServedCount === 1 ? '' : 's'}).
                </p>
              </div>
            </div>
          </div>

          {/* SECTION 3: OPERATING EXPENSE BREAKDOWN */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Operating Expense Breakdown
                </h2>
                <p className="text-xs text-slate-500">
                  Active recorded operating expenses by category and disbursement method
                </p>
              </div>
              <div className="text-right text-xs">
                <span className="font-bold text-slate-900">
                  Active Spend: {formatMoney(report.expenses.recordedTotal, currency)}
                </span>
                <span className="block text-rose-700">
                  Voided (Excluded): {formatMoney(report.expenses.voidedTotal, currency)} (
                  {report.expenses.voidedCount})
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                  By Expense Category
                </h3>
                {report.expenses.byCategory.length === 0 ? (
                  <p className="text-xs text-slate-500 py-6 text-center border border-dashed border-slate-200 rounded-xl">
                    No active operating expenses recorded in this date range.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200 text-xs">
                      <thead className="bg-slate-50 font-semibold text-slate-600">
                        <tr>
                          <th className="px-3 py-2 text-left">Category</th>
                          <th className="px-3 py-2 text-right">Vouchers</th>
                          <th className="px-3 py-2 text-right">Share</th>
                          <th className="px-3 py-2 text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {report.expenses.byCategory.map((cat) => (
                          <tr key={cat.categoryId ?? cat.categoryCode}>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-slate-800">
                                  {cat.categoryName}
                                </span>
                                {!cat.isCategoryActive && (
                                  <span className="rounded bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                    Inactive
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 h-1.5 w-full max-w-[200px] rounded-full bg-slate-100 overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-rose-500"
                                  style={{
                                    width: `${Math.min(100, Math.max(4, cat.sharePercent))}%`,
                                  }}
                                />
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right text-slate-600">
                              {cat.recordedCount}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-slate-600">
                              {cat.sharePercent.toFixed(1)}%
                            </td>
                            <td className="px-3 py-2.5 text-right font-bold text-slate-900">
                              {formatMoney(cat.recordedAmount, currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="lg:col-span-5 space-y-4">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                    By Payment Method
                  </h3>
                  {report.expenses.byPaymentMethod.length === 0 ? (
                    <p className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-200 rounded-xl">
                      No expense disbursements in period.
                    </p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="min-w-full divide-y divide-slate-200 text-xs">
                        <thead className="bg-slate-50 font-semibold text-slate-600">
                          <tr>
                            <th className="px-3 py-2 text-left">Method</th>
                            <th className="px-3 py-2 text-right">Count</th>
                            <th className="px-3 py-2 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {report.expenses.byPaymentMethod.map((pm) => (
                            <tr key={pm.paymentMethod}>
                              <td className="px-3 py-2 font-medium text-slate-800">
                                {EXPENSE_PAYMENT_METHOD_LABELS[pm.paymentMethod] ??
                                  pm.paymentMethod}
                              </td>
                              <td className="px-3 py-2 text-right text-slate-600">
                                {pm.recordedCount}
                              </td>
                              <td className="px-3 py-2 text-right font-semibold text-slate-900">
                                {formatMoney(pm.recordedAmount, currency)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {report.expenses.dailyTrend.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                      Daily Recorded Spend Dates ({report.expenses.dailyTrend.length})
                    </h3>
                    <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100 text-xs">
                      {report.expenses.dailyTrend.map((pt) => (
                        <div
                          key={pt.date}
                          className="flex items-center justify-between px-3 py-1.5"
                        >
                          <span className="text-slate-600">
                            {formatDisplayDate(pt.date)} ({pt.recordedCount})
                          </span>
                          <span className="font-semibold text-slate-900">
                            {formatMoney(pt.recordedAmount, currency)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* SECTION 4: OCCUPANCY & RESERVATIONS + SECTION 5: INVENTORY & STOCK MOVEMENTS */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Occupancy & Reservation Summary */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Occupancy & Reservation Summary
                  </h2>
                  <p className="text-xs text-slate-500">
                    Room-night utilization across {report.occupancy.currentSellableRooms}{' '}
                    sellable rooms ({report.occupancy.totalActiveRooms} total active)
                  </p>
                </div>
                <TrendingUp className="h-5 w-5 text-sky-600" />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Actual Occ.</span>
                  <p className="text-sm font-bold text-slate-900 mt-0.5">
                    {report.occupancy.occupancyRatePercent.toFixed(1)}%
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {report.occupancy.occupiedRoomNightsActual} nights
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Committed</span>
                  <p className="text-sm font-bold text-indigo-700 mt-0.5">
                    {report.occupancy.committedOccupancyRatePercent.toFixed(1)}%
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {report.occupancy.committedRoomNightsIncludingConfirmed} nights
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Arrivals</span>
                  <p className="text-sm font-bold text-emerald-700 mt-0.5">
                    {report.occupancy.arrivalsInPeriodCount}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Departures</span>
                  <p className="text-sm font-bold text-slate-800 mt-0.5">
                    {report.occupancy.departuresInPeriodCount}
                  </p>
                </div>
              </div>

              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                  Overlapping Reservations by Status
                </h3>
                {report.occupancy.byStatus.length === 0 ? (
                  <p className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-200 rounded-xl">
                    No reservations overlap this reporting window.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200 text-xs">
                      <thead className="bg-slate-50 font-semibold text-slate-600">
                        <tr>
                          <th className="px-3 py-2 text-left">Status</th>
                          <th className="px-3 py-2 text-right">Bookings</th>
                          <th className="px-3 py-2 text-right">Nights in Window</th>
                          <th className="px-3 py-2 text-right">Est. Stay Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {report.occupancy.byStatus.map((row) => (
                          <tr key={row.status}>
                            <td className="px-3 py-2">
                              <ReservationStatusBadge status={row.status} />
                            </td>
                            <td className="px-3 py-2 text-right font-medium text-slate-800">
                              {row.reservationCount}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600">
                              {row.roomNightsInPeriod}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-slate-900">
                              {formatMoney(row.estimatedTotalValue, currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {report.occupancy.bySource.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                    Non-Cancelled Bookings by Source
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {report.occupancy.bySource.map((src) => (
                      <div
                        key={src.source}
                        className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs"
                      >
                        <span className="font-semibold text-slate-800">
                          {BOOKING_SOURCE_LABELS[src.source] ?? src.source}
                        </span>
                        <span className="text-slate-500 ml-1.5">
                          ({src.reservationCount}) ·{' '}
                          {formatMoney(src.estimatedTotalValue, currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Inventory Valuation & Stock Movement Summary */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Inventory Valuation & Stock Movements
                  </h2>
                  <p className="text-xs text-slate-500">
                    Current on-hand valuation and period ledger movements
                  </p>
                </div>
                <Package className="h-5 w-5 text-teal-600" />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Receipts</span>
                  <p className="text-sm font-bold text-slate-900 mt-0.5">
                    {report.inventory.receiptsInPeriodCount}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {formatMoney(report.inventory.receiptsInPeriodAmount, currency)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Stock In</span>
                  <p className="text-sm font-bold text-emerald-700 mt-0.5">
                    +{report.inventory.totalInQuantity}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Stock Out</span>
                  <p className="text-sm font-bold text-amber-700 mt-0.5">
                    -{report.inventory.totalOutQuantity}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                  <span className="text-slate-500">Wastage Qty</span>
                  <p className="text-sm font-bold text-rose-700 mt-0.5">
                    {report.inventory.totalWastageQuantity}
                  </p>
                </div>
              </div>

              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                  Current On-Hand Valuation by Category
                </h3>
                {report.inventory.valuationByCategory.length === 0 ? (
                  <p className="text-xs text-slate-500 py-3 text-center border border-dashed border-slate-200 rounded-xl">
                    No active inventory items configured.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200 text-xs">
                      <thead className="bg-slate-50 font-semibold text-slate-600">
                        <tr>
                          <th className="px-3 py-2 text-left">Category</th>
                          <th className="px-3 py-2 text-right">Items</th>
                          <th className="px-3 py-2 text-right">Low Stock</th>
                          <th className="px-3 py-2 text-right">Valuation</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {report.inventory.valuationByCategory.map((cat) => (
                          <tr key={cat.categoryId ?? cat.categoryName}>
                            <td className="px-3 py-2 font-medium text-slate-800">
                              {cat.categoryName}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600">
                              {cat.activeItemCount}
                            </td>
                            <td className="px-3 py-2 text-right text-amber-700 font-medium">
                              {cat.lowStockCount}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-slate-900">
                              {formatMoney(cat.valuationAmount, currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                  Stock Movements in Period ({report.inventory.movementsInPeriodCount})
                </h3>
                {report.inventory.movementsBySource.length === 0 ? (
                  <p className="text-xs text-slate-500 py-3 text-center border border-dashed border-slate-200 rounded-xl">
                    No stock ledger movements recorded in this date range.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200 text-xs">
                      <thead className="bg-slate-50 font-semibold text-slate-600">
                        <tr>
                          <th className="px-3 py-2 text-left">Source</th>
                          <th className="px-3 py-2 text-right">Entries</th>
                          <th className="px-3 py-2 text-right">Net Qty</th>
                          <th className="px-3 py-2 text-right">Est. Value Delta</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {report.inventory.movementsBySource.map((mv) => (
                          <tr key={mv.movementSource}>
                            <td className="px-3 py-2">
                              <StockMovementSourceBadge
                                source={mv.movementSource}
                              />
                              <span className="sr-only">
                                {STOCK_MOVEMENT_SOURCE_LABELS[mv.movementSource]}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600">
                              {mv.movementCount}
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-medium text-slate-800">
                              {mv.netQuantityDelta > 0
                                ? `+${mv.netQuantityDelta}`
                                : mv.netQuantityDelta}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-slate-900">
                              {formatMoney(mv.estimatedValueImpact, currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
