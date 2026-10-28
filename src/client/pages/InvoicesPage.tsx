import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  Clock,
  FilePlus2,
  FileText,
  Receipt,
  Search,
  Wallet,
  X,
} from 'lucide-react';
import { formatDisplayDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type { InvoiceDetail, InvoiceListItem, InvoiceListResponse } from '@shared/types';
import { GenerateInvoiceModal } from '../components/billing/BillingModals';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import { InvoiceStatusBadge } from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';

const STATUS_TABS = [
  { key: '', label: 'All Invoices' },
  { key: 'open_balance', label: 'Open Balance' },
  { key: 'draft', label: 'Draft' },
  { key: 'issued', label: 'Issued (Unpaid)' },
  { key: 'partially_paid', label: 'Partially Paid' },
  { key: 'paid', label: 'Paid' },
  { key: 'void', label: 'Void' },
] as const;

export function InvoicesPage() {
  const { selectedProperty } = useAuth();
  const navigate = useNavigate();

  const [data, setData] = useState<InvoiceListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [issueFrom, setIssueFrom] = useState('');
  const [issueTo, setIssueTo] = useState('');
  const [page, setPage] = useState(1);

  const [generateOpen, setGenerateOpen] = useState(false);

  const loadInvoices = useCallback(async () => {
    if (!selectedProperty) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('pageSize', '20');
      if (statusFilter) qs.set('status', statusFilter);
      if (search.trim()) qs.set('search', search.trim());
      if (issueFrom) qs.set('issueFrom', issueFrom);
      if (issueTo) qs.set('issueTo', issueTo);

      const res = await apiFetch<InvoiceListResponse>(`/api/invoices?${qs.toString()}`, {
        propertyId: selectedProperty.id,
      });
      setData(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedProperty, page, statusFilter, search, issueFrom, issueTo]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  if (!selectedProperty) {
    return <LoadingState label="Selecting property..." />;
  }

  const currency = selectedProperty.currency;
  const summary = data?.summary;
  const items: InvoiceListItem[] = data?.items ?? [];
  const hasFilters = Boolean(statusFilter || search.trim() || issueFrom || issueTo);

  const clearFilters = () => {
    setStatusFilter('');
    setSearch('');
    setIssueFrom('');
    setIssueTo('');
    setPage(1);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Billing & Invoices
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Guest stay folios, tax invoices, payment settlements, and open balances for{' '}
            <span className="font-medium text-slate-700">{selectedProperty.name}</span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => setGenerateOpen(true)}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors"
        >
          <FilePlus2 className="h-4 w-4" />
          Generate Invoice
        </button>
      </div>

      {/* KPI Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Total Billed (Active)</span>
              <Receipt className="h-4 w-4 text-indigo-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-slate-900">
              {formatMoney(summary.totalBilled, currency)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {summary.totalInvoices - summary.voidCount} active invoice
              {summary.totalInvoices - summary.voidCount === 1 ? '' : 's'}
            </p>
          </div>

          <div className="rounded-2xl border border-emerald-200/80 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Collected Payments</span>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-emerald-700">
              {formatMoney(summary.totalCollected, currency)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {summary.paidCount} paid in full • {summary.partiallyPaidCount} partial
            </p>
          </div>

          <div className="rounded-2xl border border-amber-200/80 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Outstanding Balance</span>
              <Wallet className="h-4 w-4 text-amber-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-amber-800">
              {formatMoney(summary.totalOutstandingBalance, currency)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {summary.issuedUnpaidCount} unpaid issued • {summary.partiallyPaidCount} partially paid
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Draft Folios</span>
              <Clock className="h-4 w-4 text-slate-500" />
            </div>
            <p className="mt-2 text-2xl font-bold text-slate-900">{summary.draftCount}</p>
            <p className="mt-1 text-xs text-slate-500">
              {summary.voidCount > 0 ? `${summary.voidCount} voided in history` : 'Awaiting issue'}
            </p>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_TABS.map((tab) => {
            const active = statusFilter === tab.key;
            return (
              <button
                key={tab.key || 'all'}
                type="button"
                onClick={() => {
                  setStatusFilter(tab.key);
                  setPage(1);
                }}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  active
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="relative md:col-span-6">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              aria-label="Search invoices"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search invoice #, booking ref, guest name, email, or room..."
              className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <input
              type="date"
              aria-label="Issue date from"
              value={issueFrom}
              onChange={(e) => {
                setIssueFrom(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-700"
            />
          </div>

          <div className="md:col-span-2">
            <input
              type="date"
              aria-label="Issue date to"
              value={issueTo}
              onChange={(e) => {
                setIssueTo(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-700"
            />
          </div>

          <div className="md:col-span-2 flex items-center justify-end">
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                <X className="h-3.5 w-3.5" />
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      {error ? (
        <ErrorAlert message={error} onRetry={() => void loadInvoices()} />
      ) : loading ? (
        <LoadingState label="Loading property invoices..." />
      ) : items.length === 0 ? (
        <EmptyState
          title={hasFilters ? 'No matching invoices found' : 'No invoices generated yet'}
          description={
            hasFilters
              ? 'Adjust your status or search filters to view matching guest invoices.'
              : 'Generate a draft or issued tax invoice from any active reservation, or check out an in-house stay.'
          }
          action={
            hasFilters ? (
              <button
                type="button"
                onClick={clearFilters}
                className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Clear Filters
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setGenerateOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
              >
                <FilePlus2 className="h-3.5 w-3.5" />
                Generate First Invoice
              </button>
            )
          }
        />
      ) : (
        <>
          {/* Desktop Table */}
          <div className="hidden lg:block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-left">Invoice #</th>
                  <th className="px-4 py-3 text-left">Guest & Stay</th>
                  <th className="px-4 py-3 text-left">Issue Date</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 text-right">Paid</th>
                  <th className="px-4 py-3 text-right">Balance Due</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <Link
                        to={`/invoices/${inv.id}`}
                        className="font-mono text-xs font-bold text-indigo-600 hover:text-indigo-800 hover:underline"
                      >
                        {inv.invoiceNumber}
                      </Link>
                      {inv.bookingReference && (
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          Booking:{' '}
                          {inv.reservationId ? (
                            <Link
                              to={`/reservations/${inv.reservationId}`}
                              className="font-medium text-slate-700 hover:text-indigo-600 hover:underline"
                            >
                              {inv.bookingReference}
                            </Link>
                          ) : (
                            inv.bookingReference
                          )}
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{inv.guestName}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {inv.roomNumber ? `Room ${inv.roomNumber}` : inv.roomTypeName ?? '—'}
                        {inv.arrivalDate && inv.departureDate
                          ? ` • ${inv.arrivalDate} → ${inv.departureDate}`
                          : ''}
                      </div>
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap text-xs text-slate-600">
                      <div>{formatDisplayDate(inv.issueDate)}</div>
                      {inv.dueDate && (
                        <div className="text-[11px] text-slate-400">Due {inv.dueDate}</div>
                      )}
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <InvoiceStatusBadge status={inv.status} />
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap text-right font-semibold text-slate-900">
                      {formatMoney(inv.grandTotal, inv.currency)}
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap text-right font-medium text-emerald-700">
                      {formatMoney(inv.amountPaid, inv.currency)}
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap text-right">
                      <span
                        className={`font-bold ${
                          inv.status === 'void'
                            ? 'text-slate-400'
                            : inv.balanceDue > 0
                              ? 'text-amber-700'
                              : 'text-emerald-700'
                        }`}
                      >
                        {formatMoney(inv.balanceDue, inv.currency)}
                      </span>
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap text-right">
                      <Link
                        to={`/invoices/${inv.id}`}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <FileText className="h-3.5 w-3.5 text-slate-500" />
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Responsive Cards */}
          <div className="grid grid-cols-1 gap-3 lg:hidden">
            {items.map((inv) => (
              <Link
                key={inv.id}
                to={`/invoices/${inv.id}`}
                className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-300 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-mono text-xs font-bold text-indigo-600">
                      {inv.invoiceNumber}
                    </span>
                    <h3 className="text-sm font-semibold text-slate-900 mt-0.5">
                      {inv.guestName}
                    </h3>
                  </div>
                  <InvoiceStatusBadge status={inv.status} />
                </div>

                <div className="mt-2 text-xs text-slate-500">
                  {inv.bookingReference ? `${inv.bookingReference} • ` : ''}
                  {inv.roomNumber ? `Room ${inv.roomNumber} • ` : ''}
                  Issued {formatDisplayDate(inv.issueDate)}
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2.5 text-xs">
                  <div>
                    <span className="text-slate-400 block">Total</span>
                    <span className="font-semibold text-slate-900">
                      {formatMoney(inv.grandTotal, inv.currency)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Paid</span>
                    <span className="font-semibold text-emerald-700">
                      {formatMoney(inv.amountPaid, inv.currency)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-slate-400 block">Balance</span>
                    <span
                      className={`font-bold ${
                        inv.balanceDue > 0 ? 'text-amber-700' : 'text-emerald-700'
                      }`}
                    >
                      {formatMoney(inv.balanceDue, inv.currency)}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
              <span>
                Page {data.page} of {data.totalPages} ({data.total} total)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={page >= data.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <GenerateInvoiceModal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        propertyId={selectedProperty.id}
        currency={currency}
        onCreated={(inv: InvoiceDetail) => navigate(`/invoices/${inv.id}`)}
      />
    </div>
  );
}
