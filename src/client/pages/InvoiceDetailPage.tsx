import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  CreditCard,
  Eye,
  FileCheck2,
  PlusCircle,
  Printer,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { formatDisplayDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type { InvoiceDetail } from '@shared/types';
import {
  AddInvoiceItemModal,
  RecordPaymentModal,
  VoidInvoiceModal,
} from '../components/billing/BillingModals';
import { ErrorAlert, LoadingState } from '../components/ui/Feedback';
import {
  InvoiceItemTypeBadge,
  InvoiceStatusBadge,
  PaymentMethodBadge,
  ReservationStatusBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiFetch } from '../lib/api';

export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, selectedProperty } = useAuth();
  const { showToast } = useToast();

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [printPreview, setPrintPreview] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [addItemModalOpen, setAddItemModalOpen] = useState(false);
  const [voidModalOpen, setVoidModalOpen] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dueDateEdit, setDueDateEdit] = useState('');
  const [notesEdit, setNotesEdit] = useState('');

  const loadDetail = useCallback(async () => {
    if (!selectedProperty || !id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ invoice: InvoiceDetail }>(`/api/invoices/${id}`, {
        propertyId: selectedProperty.id,
      });
      setInvoice(res.invoice);
      setDueDateEdit(res.invoice.dueDate ?? '');
      setNotesEdit(res.invoice.notes ?? '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedProperty, id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const applyUpdatedInvoice = (updated: InvoiceDetail) => {
    setInvoice(updated);
    setDueDateEdit(updated.dueDate ?? '');
    setNotesEdit(updated.notes ?? '');
  };

  const handleIssue = async () => {
    if (!selectedProperty || !invoice) return;
    setBusyAction('issue');
    try {
      const res = await apiFetch<{ invoice: InvoiceDetail }>(
        `/api/invoices/${invoice.id}/issue`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
        }
      );
      applyUpdatedInvoice(res.invoice);
      showToast('success', `Invoice ${res.invoice.invoiceNumber} issued`);
    } catch (err) {
      showToast('error', (err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSyncReservation = async () => {
    if (!selectedProperty || !invoice) return;
    setBusyAction('sync');
    try {
      const res = await apiFetch<{ invoice: InvoiceDetail }>(
        `/api/invoices/${invoice.id}/sync-reservation`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
        }
      );
      applyUpdatedInvoice(res.invoice);
      showToast('success', 'Synchronized room charges with reservation stay');
    } catch (err) {
      showToast('error', (err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteLineItem = async (itemId: string) => {
    if (!selectedProperty || !invoice) return;
    setBusyAction(`del-${itemId}`);
    try {
      const res = await apiFetch<{ invoice: InvoiceDetail }>(
        `/api/invoices/${invoice.id}/items/${itemId}`,
        {
          method: 'DELETE',
          propertyId: selectedProperty.id,
        }
      );
      applyUpdatedInvoice(res.invoice);
      showToast('info', 'Removed folio item');
    } catch (err) {
      showToast('error', (err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveMetadata = async () => {
    if (!selectedProperty || !invoice) return;
    setBusyAction('meta');
    try {
      const res = await apiFetch<{ invoice: InvoiceDetail }>(
        `/api/invoices/${invoice.id}`,
        {
          method: 'PATCH',
          propertyId: selectedProperty.id,
          body: {
            dueDate: dueDateEdit || null,
            notes: notesEdit,
          },
        }
      );
      applyUpdatedInvoice(res.invoice);
      showToast('success', 'Saved invoice notes & due date');
    } catch (err) {
      showToast('error', (err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  if (!selectedProperty || loading) {
    return <LoadingState label="Loading invoice details..." />;
  }

  if (error || !invoice) {
    return (
      <div className="space-y-4">
        <Link
          to="/invoices"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Invoices
        </Link>
        <ErrorAlert
          message={error ?? 'Invoice not found'}
          onRetry={() => void loadDetail()}
        />
      </div>
    );
  }

  const isAdmin = user?.role === 'admin';
  const canRecordPayment = invoice.status !== 'void' && invoice.balanceDue > 0;
  const canAddLineItem = invoice.status !== 'void' && invoice.status !== 'paid';
  const canVoid = isAdmin && invoice.status !== 'void' && invoice.amountPaid === 0;
  const propToday = selectedProperty.localToday ?? invoice.issueDate;

  return (
    <div className="space-y-6">
      {/* Top Toolbar (Hidden when printing) */}
      <div className="no-print flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/invoices"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All Invoices
          </Link>

          {invoice.reservationId && (
            <Link
              to={`/reservations/${invoice.reservationId}`}
              className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50/70 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100/70"
            >
              Booking {invoice.bookingReference}
            </Link>
          )}

          <InvoiceStatusBadge status={invoice.status} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {invoice.status === 'draft' && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleIssue()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              <FileCheck2 className="h-3.5 w-3.5" />
              {busyAction === 'issue' ? 'Issuing...' : 'Issue Invoice'}
            </button>
          )}

          {canRecordPayment && (
            <button
              type="button"
              onClick={() => setPaymentModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              <CreditCard className="h-3.5 w-3.5" />
              Record Payment
            </button>
          )}

          {canAddLineItem && (
            <button
              type="button"
              onClick={() => setAddItemModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <PlusCircle className="h-3.5 w-3.5 text-indigo-600" />
              Add Folio Item
            </button>
          )}

          {invoice.reservationId && invoice.status !== 'void' && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleSyncReservation()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 text-slate-500 ${
                  busyAction === 'sync' ? 'animate-spin' : ''
                }`}
              />
              Sync Stay
            </button>
          )}

          <button
            type="button"
            onClick={() => setPrintPreview((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
              printPreview
                ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Eye className="h-3.5 w-3.5" />
            {printPreview ? 'Exit Print View' : 'Print View'}
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
          >
            <Printer className="h-3.5 w-3.5 text-slate-600" />
            Print / PDF
          </button>

          {canVoid && (
            <button
              type="button"
              onClick={() => setVoidModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100"
            >
              <Ban className="h-3.5 w-3.5" />
              Void
            </button>
          )}
        </div>
      </div>

      {/* Void Banner */}
      {invoice.status === 'void' && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 px-5 py-3.5 text-xs text-rose-900">
          <p className="font-bold text-sm">VOIDED INVOICE</p>
          <p className="mt-0.5">
            Reason: <strong>{invoice.voidReason || 'Administrative void'}</strong>
            {invoice.voidedByName ? ` • Voided by ${invoice.voidedByName}` : ''}
            {invoice.voidedAt ? ` on ${new Date(invoice.voidedAt).toLocaleString()}` : ''}
          </p>
        </div>
      )}

      {/* Printable Tax Invoice Document Sheet */}
      <div
        data-testid="invoice-print-sheet"
        className={`invoice-print-sheet rounded-2xl border border-slate-200 bg-white shadow-sm ${
          printPreview ? 'mx-auto max-w-4xl p-8 sm:p-10 ring-2 ring-indigo-100' : 'p-6 sm:p-8'
        }`}
      >
        {/* Property Letterhead & Invoice Meta */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6 border-b border-slate-200 pb-6">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-indigo-600">
              {invoice.status === 'draft' ? 'Proforma / Draft Folio' : 'Tax Invoice'}
            </p>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">
              {invoice.propertyHeader.name}
            </h1>
            <div className="mt-1.5 text-xs text-slate-600 space-y-0.5">
              <p>
                {invoice.propertyHeader.addressLine1}
                {invoice.propertyHeader.addressLine2
                  ? `, ${invoice.propertyHeader.addressLine2}`
                  : ''}
              </p>
              <p>
                {invoice.propertyHeader.city}
                {invoice.propertyHeader.stateRegion
                  ? `, ${invoice.propertyHeader.stateRegion}`
                  : ''}{' '}
                {invoice.propertyHeader.postalCode} • {invoice.propertyHeader.country}
              </p>
              <p>
                {invoice.propertyHeader.phone} • {invoice.propertyHeader.email}
              </p>
              {invoice.propertyTaxId && (
                <p className="font-semibold text-slate-800 pt-0.5">
                  Tax ID / GSTIN: {invoice.propertyTaxId}
                </p>
              )}
            </div>
          </div>

          <div className="sm:text-right space-y-1.5">
            <div className="inline-flex sm:justify-end">
              <InvoiceStatusBadge status={invoice.status} />
            </div>
            <div className="font-mono text-lg font-bold text-slate-900">
              {invoice.invoiceNumber}
            </div>
            <div className="text-xs text-slate-600 space-y-0.5">
              <p>
                <span className="text-slate-400">Issue Date:</span>{' '}
                <strong className="text-slate-800">{formatDisplayDate(invoice.issueDate)}</strong>
              </p>
              {invoice.dueDate && (
                <p>
                  <span className="text-slate-400">Due Date:</span>{' '}
                  <strong className="text-slate-800">{formatDisplayDate(invoice.dueDate)}</strong>
                </p>
              )}
              <p>
                <span className="text-slate-400">Currency:</span>{' '}
                <strong className="text-slate-800">{invoice.currency}</strong>
              </p>
            </div>
          </div>
        </div>

        {/* Bill To & Stay Details */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-6 border-b border-slate-200 text-xs">
          <div>
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Billed To
            </h2>
            <p className="mt-1.5 text-sm font-bold text-slate-900">{invoice.guest.fullName}</p>
            <div className="mt-1 text-slate-600 space-y-0.5">
              {invoice.guest.email && <p>{invoice.guest.email}</p>}
              {invoice.guest.phone && <p>{invoice.guest.phone}</p>}
              {(invoice.guest.addressLine1 || invoice.guest.city) && (
                <p>
                  {[
                    invoice.guest.addressLine1,
                    invoice.guest.city,
                    invoice.guest.stateRegion,
                    invoice.guest.postalCode,
                    invoice.guest.country,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              )}
            </div>
          </div>

          {invoice.reservationId && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Stay Reference
                </span>
                {invoice.reservationStatus && (
                  <ReservationStatusBadge status={invoice.reservationStatus} />
                )}
              </div>
              <p className="text-sm font-bold text-slate-900">{invoice.bookingReference}</p>
              <p className="text-slate-600">
                {invoice.roomNumber ? `Room ${invoice.roomNumber}` : 'Unassigned Room'}
                {invoice.roomTypeName ? ` • ${invoice.roomTypeName}` : ''}
              </p>
              {invoice.arrivalDate && invoice.departureDate && (
                <p className="text-slate-600">
                  Check-In: <strong>{invoice.arrivalDate}</strong> → Check-Out:{' '}
                  <strong>{invoice.departureDate}</strong>
                </p>
              )}
            </div>
          )}
        </div>

        {/* Itemized Charges Table */}
        <div className="py-6">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
            Itemized Charges & Credits
          </h2>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3.5 py-2.5 text-left">Type</th>
                  <th className="px-3.5 py-2.5 text-left">Description</th>
                  <th className="px-3.5 py-2.5 text-right">Qty</th>
                  <th className="px-3.5 py-2.5 text-right">Rate</th>
                  <th className="px-3.5 py-2.5 text-right">Amount</th>
                  <th className="px-3.5 py-2.5 text-right">{invoice.taxName}</th>
                  <th className="px-3.5 py-2.5 text-right">Line Total</th>
                  {!printPreview && isAdmin && canAddLineItem && (
                    <th className="no-print px-3 py-2.5 text-right w-10" />
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {invoice.lineItems.map((item) => {
                  const isLockedReservationRow =
                    item.sourceKey === 'reservation_room_charge' ||
                    item.sourceKey === 'reservation_discount' ||
                    Boolean(item.sourceKey?.startsWith('food_order:')) ||
                    Boolean(item.sourceKey?.startsWith('food_order_reversal:')) ||
                    Boolean(item.sourceKey?.startsWith('voided_food_order:'));
                  const isDiscount = item.itemType === 'discount';
                  return (
                    <tr key={item.id}>
                      <td className="px-3.5 py-3 whitespace-nowrap">
                        <InvoiceItemTypeBadge itemType={item.itemType} />
                      </td>
                      <td className="px-3.5 py-3 text-slate-800 font-medium">
                        {item.description}
                      </td>
                      <td className="px-3.5 py-3 whitespace-nowrap text-right text-slate-600">
                        {item.quantity}
                      </td>
                      <td className="px-3.5 py-3 whitespace-nowrap text-right text-slate-600">
                        {isDiscount ? '—' : formatMoney(item.unitPrice, invoice.currency)}
                      </td>
                      <td
                        className={`px-3.5 py-3 whitespace-nowrap text-right font-medium ${
                          isDiscount ? 'text-emerald-700' : 'text-slate-800'
                        }`}
                      >
                        {formatMoney(item.netAmount, invoice.currency)}
                      </td>
                      <td className="px-3.5 py-3 whitespace-nowrap text-right text-slate-600">
                        {isDiscount
                          ? '—'
                          : `${formatMoney(item.taxAmount, invoice.currency)} (${item.taxRate}%)`}
                      </td>
                      <td
                        className={`px-3.5 py-3 whitespace-nowrap text-right font-bold ${
                          isDiscount ? 'text-emerald-700' : 'text-slate-900'
                        }`}
                      >
                        {formatMoney(item.lineTotal, invoice.currency)}
                      </td>
                      {!printPreview && isAdmin && canAddLineItem && (
                        <td className="no-print px-3 py-3 text-right">
                          {!isLockedReservationRow && (
                            <button
                              type="button"
                              aria-label={`Remove ${item.description}`}
                              disabled={busyAction !== null}
                              onClick={() => void handleDeleteLineItem(item.id)}
                              className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Financial Summary & Notes */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 border-t border-slate-200 pt-6">
          <div className="lg:col-span-7 space-y-3 text-xs text-slate-600">
            {invoice.notes && (
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                <p className="font-semibold text-slate-700 mb-1">Invoice Notes</p>
                <p className="whitespace-pre-line">{invoice.notes}</p>
              </div>
            )}
            {invoice.footerNote && (
              <p className="text-[11px] text-slate-500 italic pt-1">{invoice.footerNote}</p>
            )}
          </div>

          <div className="lg:col-span-5">
            <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4 space-y-2 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span>Subtotal (Charges)</span>
                <span className="font-semibold text-slate-900">
                  {formatMoney(invoice.subtotal, invoice.currency)}
                </span>
              </div>

              {invoice.discountTotal > 0 && (
                <>
                  <div className="flex items-center justify-between text-emerald-700">
                    <span>Total Discounts</span>
                    <span className="font-semibold">
                      -{formatMoney(invoice.discountTotal, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-600">
                    <span>Taxable Subtotal</span>
                    <span className="font-medium text-slate-800">
                      {formatMoney(invoice.taxableSubtotal, invoice.currency)}
                    </span>
                  </div>
                </>
              )}

              <div className="flex items-center justify-between text-slate-600">
                <span>
                  {invoice.taxName} ({invoice.taxRate}%)
                </span>
                <span className="font-semibold text-slate-900">
                  {formatMoney(invoice.taxTotal, invoice.currency)}
                </span>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 pt-2.5 text-sm font-bold text-slate-900">
                <span>Invoice Grand Total</span>
                <span>{formatMoney(invoice.grandTotal, invoice.currency)}</span>
              </div>

              <div className="flex items-center justify-between text-emerald-700 font-semibold">
                <span>Amount Paid</span>
                <span>{formatMoney(invoice.amountPaid, invoice.currency)}</span>
              </div>

              <div
                data-testid="invoice-balance-due"
                className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-bold ${
                  invoice.status === 'void'
                    ? 'bg-slate-200/70 text-slate-600'
                    : invoice.balanceDue > 0
                      ? 'bg-amber-100/80 text-amber-900'
                      : 'bg-emerald-100/80 text-emerald-900'
                }`}
              >
                <span>Balance Due</span>
                <span>{formatMoney(invoice.balanceDue, invoice.currency)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Payment History Section (Included on printed receipt if payments exist) */}
        <div
          className={`mt-8 border-t border-slate-200 pt-6 ${
            invoice.payments.length === 0 ? 'no-print' : ''
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Payment History ({invoice.payments.length})
            </h2>
            {invoice.status === 'paid' && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Settled in Full
              </span>
            )}
          </div>

          {invoice.payments.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-6 text-center text-xs text-slate-500">
              No payments have been recorded against this invoice yet.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3.5 py-2.5 text-left">Reference</th>
                    <th className="px-3.5 py-2.5 text-left">Payment Date</th>
                    <th className="px-3.5 py-2.5 text-left">Method</th>
                    <th className="px-3.5 py-2.5 text-left">Recorded By</th>
                    <th className="px-3.5 py-2.5 text-left">Notes</th>
                    <th className="px-3.5 py-2.5 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {invoice.payments.map((pay) => (
                    <tr key={pay.id}>
                      <td className="px-3.5 py-2.5 font-mono font-semibold text-slate-800 whitespace-nowrap">
                        {pay.paymentReference}
                      </td>
                      <td className="px-3.5 py-2.5 text-slate-600 whitespace-nowrap">
                        {formatDisplayDate(pay.paymentDate)}
                      </td>
                      <td className="px-3.5 py-2.5 whitespace-nowrap">
                        <PaymentMethodBadge method={pay.paymentMethod} />
                      </td>
                      <td className="px-3.5 py-2.5 text-slate-700 whitespace-nowrap">
                        {pay.receivedByName ?? 'Staff'}
                      </td>
                      <td className="px-3.5 py-2.5 text-slate-500">{pay.notes || '—'}</td>
                      <td className="px-3.5 py-2.5 text-right font-bold text-emerald-700 whitespace-nowrap">
                        {formatMoney(pay.amount, pay.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Editable Billing Metadata Card (Screen-only, non-void) */}
      {!printPreview && invoice.status !== 'void' && (
        <div className="no-print rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">
            Billing Terms & Notes
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            <div className="md:col-span-3">
              <label
                htmlFor="invoice-due-date"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Due Date
              </label>
              <input
                id="invoice-due-date"
                type="date"
                value={dueDateEdit}
                onChange={(e) => setDueDateEdit(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-7">
              <label
                htmlFor="invoice-notes-input"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Invoice Notes (Shown on printed invoice)
              </label>
              <input
                id="invoice-notes-input"
                type="text"
                maxLength={1000}
                value={notesEdit}
                onChange={(e) => setNotesEdit(e.target.value)}
                placeholder="Optional company tax ID, PO number, or settlement instructions..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-2 flex justify-end">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleSaveMetadata()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {busyAction === 'meta' ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      <RecordPaymentModal
        open={paymentModalOpen}
        onClose={() => setPaymentModalOpen(false)}
        invoice={invoice}
        propertyId={selectedProperty.id}
        defaultDate={propToday}
        onSuccess={applyUpdatedInvoice}
      />

      {user && (
        <AddInvoiceItemModal
          open={addItemModalOpen}
          onClose={() => setAddItemModalOpen(false)}
          invoice={invoice}
          propertyId={selectedProperty.id}
          userRole={user.role}
          onSuccess={applyUpdatedInvoice}
        />
      )}

      <VoidInvoiceModal
        open={voidModalOpen}
        onClose={() => setVoidModalOpen(false)}
        invoiceId={invoice.id}
        invoiceNumber={invoice.invoiceNumber}
        propertyId={selectedProperty.id}
        onSuccess={applyUpdatedInvoice}
      />
    </div>
  );
}
