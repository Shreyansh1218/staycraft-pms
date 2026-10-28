import React, { useEffect, useMemo, useState } from 'react';
import { CreditCard, FilePlus2, PlusCircle, ShieldAlert } from 'lucide-react';
import {
  INVOICE_ITEM_TYPE_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type InvoiceItemType,
  type PaymentMethod,
  type UserRole,
} from '@shared/constants';
import { formatMoney } from '@shared/pricing';
import type {
  InvoiceDetail,
  PaginatedResult,
  ReservationListItem,
} from '@shared/types';
import { useToast } from '../../context/ToastContext';
import { ApiClientError, apiFetch } from '../../lib/api';
import { ErrorAlert } from '../ui/Feedback';
import { Modal } from '../ui/Modal';

function makeIdempotencyKey(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rand}`;
}

interface RecordPaymentModalProps {
  open: boolean;
  onClose: () => void;
  invoice: Pick<
    InvoiceDetail,
    | 'id'
    | 'invoiceNumber'
    | 'grandTotal'
    | 'amountPaid'
    | 'balanceDue'
    | 'currency'
  >;
  propertyId: string;
  defaultDate: string;
  onSuccess: (updated: InvoiceDetail) => void;
}

export function RecordPaymentModal({
  open,
  onClose,
  invoice,
  propertyId,
  defaultDate,
  onSuccess,
}: RecordPaymentModalProps) {
  const { showToast } = useToast();
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [paymentDate, setPaymentDate] = useState(defaultDate);
  const [paymentReference, setPaymentReference] = useState('');
  const [notes, setNotes] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => makeIdempotencyKey('pay'));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAmount(invoice.balanceDue > 0 ? invoice.balanceDue.toFixed(2) : '');
      setPaymentMethod('cash');
      setPaymentDate(defaultDate);
      setPaymentReference('');
      setNotes('');
      setIdempotencyKey(makeIdempotencyKey('pay'));
      setError(null);
    }
  }, [open, invoice.id, invoice.balanceDue, defaultDate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError('Enter a positive payment amount greater than 0.00.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{ invoice: InvoiceDetail }>(
        `/api/invoices/${invoice.id}/payments`,
        {
          method: 'POST',
          propertyId,
          body: {
            amount: parsedAmount,
            paymentMethod,
            paymentDate: paymentDate || null,
            paymentReference,
            notes,
            idempotencyKey,
          },
        }
      );
      showToast(
        'success',
        `Recorded ${formatMoney(parsedAmount, invoice.currency)} payment on ${invoice.invoiceNumber}`
      );
      onSuccess(res.invoice);
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError && err.fieldErrors) {
        const firstFieldErr = Object.values(err.fieldErrors)[0];
        setError(firstFieldErr || err.message);
      } else {
        setError((err as Error).message);
      }
      // Rotate idempotency key only if validation rejected the payload before saving
      if (err instanceof ApiClientError && err.status === 400) {
        setIdempotencyKey(makeIdempotencyKey('pay'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const halfBalance = Math.max(0.01, Math.round((invoice.balanceDue / 2) * 100) / 100);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Record Payment — ${invoice.invoiceNumber}`}
      subtitle="Record an authorized front-desk or bank settlement against this invoice"
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="grid grid-cols-3 gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs">
          <div>
            <p className="text-slate-500">Invoice Total</p>
            <p className="mt-0.5 text-sm font-bold text-slate-900">
              {formatMoney(invoice.grandTotal, invoice.currency)}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Paid So Far</p>
            <p className="mt-0.5 text-sm font-bold text-emerald-700">
              {formatMoney(invoice.amountPaid, invoice.currency)}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Balance Due</p>
            <p className="mt-0.5 text-sm font-bold text-amber-800">
              {formatMoney(invoice.balanceDue, invoice.currency)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label
                htmlFor="payment-amount"
                className="block text-xs font-semibold text-slate-700"
              >
                Payment Amount ({invoice.currency}) *
              </label>
              <div className="flex items-center gap-1.5">
                {invoice.balanceDue > 0.02 && (
                  <button
                    type="button"
                    onClick={() => setAmount(halfBalance.toFixed(2))}
                    className="text-[11px] font-semibold text-slate-600 hover:text-indigo-600"
                  >
                    50%
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setAmount(invoice.balanceDue.toFixed(2))}
                  className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-700"
                >
                  Full Balance
                </button>
              </div>
            </div>
            <input
              id="payment-amount"
              type="number"
              step="0.01"
              min="0.01"
              max={invoice.balanceDue > 0 ? invoice.balanceDue : undefined}
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-900 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="payment-method"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Payment Method *
            </label>
            <select
              id="payment-method"
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label
              htmlFor="payment-date"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Payment Date *
            </label>
            <input
              id="payment-date"
              type="date"
              required
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="payment-reference"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Receipt / UTR Reference (Optional)
            </label>
            <input
              id="payment-reference"
              type="text"
              maxLength={60}
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder="e.g. UPI-884920, POS-4912"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="payment-notes"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Notes (Optional)
          </label>
          <input
            id="payment-notes"
            type="text"
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Front desk settlement note..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Security policy: never enter full card numbers. Record only terminal receipt IDs or
            UPI/bank references.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <CreditCard className="h-3.5 w-3.5" />
            {submitting ? 'Recording Payment...' : 'Record Payment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface AddInvoiceItemModalProps {
  open: boolean;
  onClose: () => void;
  invoice: Pick<InvoiceDetail, 'id' | 'invoiceNumber' | 'taxRate' | 'taxName' | 'currency'>;
  propertyId: string;
  userRole: UserRole;
  onSuccess: (updated: InvoiceDetail) => void;
}

export function AddInvoiceItemModal({
  open,
  onClose,
  invoice,
  propertyId,
  userRole,
  onSuccess,
}: AddInvoiceItemModalProps) {
  const { showToast } = useToast();
  const allowedTypes = useMemo<InvoiceItemType[]>(
    () =>
      userRole === 'admin'
        ? ['service_charge', 'fee', 'adjustment', 'discount']
        : ['service_charge', 'fee'],
    [userRole]
  );

  const [itemType, setItemType] = useState<InvoiceItemType>('service_charge');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [taxRate, setTaxRate] = useState(String(invoice.taxRate));
  const [idempotencyKey, setIdempotencyKey] = useState(() => makeIdempotencyKey('item'));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setItemType('service_charge');
      setDescription('');
      setQuantity('1');
      setUnitPrice('');
      setTaxRate(String(invoice.taxRate));
      setIdempotencyKey(makeIdempotencyKey('item'));
      setError(null);
    }
  }, [open, invoice.id, invoice.taxRate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ invoice: InvoiceDetail }>(
        `/api/invoices/${invoice.id}/items`,
        {
          method: 'POST',
          propertyId,
          body: {
            itemType,
            description,
            quantity: Number(quantity),
            unitPrice: Number(unitPrice),
            taxRate: itemType === 'discount' ? 0 : Number(taxRate),
            idempotencyKey,
          },
        }
      );
      showToast(
        'success',
        `Added ${INVOICE_ITEM_TYPE_LABELS[itemType]} to ${invoice.invoiceNumber}`
      );
      onSuccess(res.invoice);
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError && err.fieldErrors) {
        setError(Object.values(err.fieldErrors)[0] || err.message);
      } else {
        setError((err as Error).message);
      }
      if (err instanceof ApiClientError && err.status === 400) {
        setIdempotencyKey(makeIdempotencyKey('item'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Add Folio Item — ${invoice.invoiceNumber}`}
      subtitle="Post an itemized charge, fee, or authorized discount to this invoice"
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label
              htmlFor="folio-item-type"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Item Category *
            </label>
            <select
              id="folio-item-type"
              value={itemType}
              onChange={(e) => setItemType(e.target.value as InvoiceItemType)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            >
              {allowedTypes.map((t) => (
                <option key={t} value={t}>
                  {INVOICE_ITEM_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="folio-item-tax"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              {invoice.taxName} Rate (%)
            </label>
            <input
              id="folio-item-tax"
              type="number"
              step="0.01"
              min="0"
              max="100"
              disabled={itemType === 'discount'}
              value={itemType === 'discount' ? '0' : taxRate}
              onChange={(e) => setTaxRate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="folio-item-description"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Description *
          </label>
          <input
            id="folio-item-description"
            type="text"
            required
            maxLength={255}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              itemType === 'discount'
                ? 'e.g. Loyalty goodwill discount'
                : 'e.g. Airport transfer, Extra bed, Late checkout fee'
            }
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-3.5">
          <div>
            <label
              htmlFor="folio-item-qty"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Quantity *
            </label>
            <input
              id="folio-item-qty"
              type="number"
              step="0.01"
              min="0.01"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="folio-item-price"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              {itemType === 'discount' ? 'Discount Amount' : 'Unit Price'} ({invoice.currency}) *
            </label>
            <input
              id="folio-item-price"
              type="number"
              step="0.01"
              min="0.01"
              required
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <PlusCircle className="h-3.5 w-3.5" />
            {submitting ? 'Posting Item...' : 'Post Folio Item'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface GenerateInvoiceModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  currency: string;
  onCreated: (invoice: InvoiceDetail) => void;
}

export function GenerateInvoiceModal({
  open,
  onClose,
  propertyId,
  currency,
  onCreated,
}: GenerateInvoiceModalProps) {
  const { showToast } = useToast();
  const [reservations, setReservations] = useState<ReservationListItem[]>([]);
  const [loadingRes, setLoadingRes] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedReservationId, setSelectedReservationId] = useState('');
  const [issueImmediately, setIssueImmediately] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !propertyId) return;
    setError(null);
    setNotes('');
    setIssueImmediately(false);
    setLoadingRes(true);
    apiFetch<PaginatedResult<ReservationListItem>>(
      `/api/reservations?pageSize=50&search=${encodeURIComponent(search)}`,
      { propertyId }
    )
      .then((res) => {
        const eligible = res.items.filter((r) => r.status !== 'cancelled');
        setReservations(eligible);
        if (eligible.length > 0 && !eligible.some((r) => r.id === selectedReservationId)) {
          setSelectedReservationId(eligible[0].id);
        }
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoadingRes(false));
  }, [open, propertyId, search]);

  const selectedReservation = useMemo(
    () => reservations.find((r) => r.id === selectedReservationId) ?? null,
    [reservations, selectedReservationId]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedReservationId) {
      setError('Select an active reservation first.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ invoice: InvoiceDetail; created: boolean }>(
        `/api/invoices/from-reservation/${selectedReservationId}`,
        {
          method: 'POST',
          propertyId,
          body: {
            issueImmediately,
            notes: notes.trim() || undefined,
          },
        }
      );
      showToast(
        'success',
        res.created
          ? `Generated invoice ${res.invoice.invoiceNumber}`
          : `Opened synchronized invoice ${res.invoice.invoiceNumber}`
      );
      onCreated(res.invoice);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate Reservation Invoice"
      subtitle="Create or synchronize a guest tax invoice from an existing reservation"
      maxWidthClass="max-w-xl"
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div>
          <label
            htmlFor="invoice-res-search"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Filter Reservations
          </label>
          <input
            id="invoice-res-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search booking reference, guest name, or room number..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="invoice-reservation-select"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Select Reservation *
          </label>
          {loadingRes ? (
            <p className="text-xs text-slate-500 py-2">Loading reservations...</p>
          ) : reservations.length === 0 ? (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              No non-cancelled reservations match your filter.
            </p>
          ) : (
            <select
              id="invoice-reservation-select"
              value={selectedReservationId}
              onChange={(e) => setSelectedReservationId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            >
              {reservations.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.bookingReference} — {r.guestName} (
                  {r.roomNumber ? `Room ${r.roomNumber}` : r.roomTypeName}, {r.arrivalDate} →{' '}
                  {r.departureDate})
                </option>
              ))}
            </select>
          )}
        </div>

        {selectedReservation && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-900">
                {selectedReservation.guestName} ({selectedReservation.bookingReference})
              </span>
              <span className="font-semibold text-indigo-700">
                Est. Stay Total: {formatMoney(selectedReservation.estimatedTotal, currency)}
              </span>
            </div>
            <p className="text-slate-600">
              {selectedReservation.roomNumber
                ? `Room ${selectedReservation.roomNumber}`
                : selectedReservation.roomTypeName}{' '}
              • {selectedReservation.nights} night
              {selectedReservation.nights === 1 ? '' : 's'} ({selectedReservation.arrivalDate} to{' '}
              {selectedReservation.departureDate}) • Status:{' '}
              <span className="uppercase font-medium">
                {selectedReservation.status.replace('_', ' ')}
              </span>
            </p>
          </div>
        )}

        <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 p-3 cursor-pointer hover:bg-slate-50">
          <input
            type="checkbox"
            checked={issueImmediately}
            onChange={(e) => setIssueImmediately(e.target.checked)}
            className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <div className="text-xs">
            <span className="font-semibold text-slate-900 block">
              Issue invoice immediately (Unpaid)
            </span>
            <span className="text-slate-500">
              Leave unchecked to create as a Draft folio while the stay is still in progress.
            </span>
          </div>
        </label>

        <div>
          <label
            htmlFor="invoice-create-notes"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Invoice Notes (Optional)
          </label>
          <input
            id="invoice-create-notes"
            type="text"
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Company GST / billing instructions..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !selectedReservationId}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            {submitting
              ? 'Generating...'
              : issueImmediately
                ? 'Generate & Issue Invoice'
                : 'Generate Draft Invoice'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface VoidInvoiceModalProps {
  open: boolean;
  onClose: () => void;
  invoiceNumber: string;
  invoiceId: string;
  propertyId: string;
  onSuccess: (updated: InvoiceDetail) => void;
}

export function VoidInvoiceModal({
  open,
  onClose,
  invoiceNumber,
  invoiceId,
  propertyId,
  onSuccess,
}: VoidInvoiceModalProps) {
  const { showToast } = useToast();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ invoice: InvoiceDetail }>(
        `/api/invoices/${invoiceId}/void`,
        {
          method: 'POST',
          propertyId,
          body: { reason },
        }
      );
      showToast('info', `Invoice ${invoiceNumber} voided`);
      onSuccess(res.invoice);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Void Invoice ${invoiceNumber}`}
      subtitle="Voided invoices remain permanently in the audit ledger with zero balance due"
      maxWidthClass="max-w-md"
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
          <p>
            Only unpaid invoices can be voided. Once voided, a replacement invoice can be generated
            for the reservation if needed.
          </p>
        </div>

        <div>
          <label
            htmlFor="void-invoice-reason"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Void Reason *
          </label>
          <input
            id="void-invoice-reason"
            type="text"
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Duplicate draft created before stay amendment"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {submitting ? 'Voiding...' : 'Confirm Void Invoice'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
