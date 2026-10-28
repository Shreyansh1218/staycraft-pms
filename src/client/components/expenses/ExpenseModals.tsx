import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  FileText,
  History,
  Receipt,
  User,
} from 'lucide-react';
import {
  EXPENSE_HISTORY_ACTION_LABELS,
  EXPENSE_PAYMENT_METHODS,
  EXPENSE_PAYMENT_METHOD_LABELS,
  type ExpensePaymentMethod,
} from '@shared/constants';
import { formatDisplayDate, getPropertyLocalDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type {
  ExpenseCategory,
  ExpenseDetail,
  ExpenseRecord,
  Property,
  Supplier,
} from '@shared/types';
import { useToast } from '../../context/ToastContext';
import { apiFetch, ApiClientError } from '../../lib/api';
import { Modal } from '../ui/Modal';
import { ExpensePaymentMethodBadge, ExpenseStatusBadge } from '../ui/StatusBadge';

function makeClientIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `exp-${crypto.randomUUID()}`;
  }
  return `exp-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

// ============================================================================
// 1. EXPENSE CATEGORY CREATE / EDIT MODAL
// ============================================================================

interface ExpenseCategoryModalProps {
  open: boolean;
  onClose: () => void;
  property: Property;
  editingCategory: ExpenseCategory | null;
  onSaved: (category: ExpenseCategory) => void;
}

export function ExpenseCategoryModal({
  open,
  onClose,
  property,
  editingCategory,
  onSaved,
}: ExpenseCategoryModalProps) {
  const { showToast } = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [displayOrder, setDisplayOrder] = useState('0');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    if (editingCategory) {
      setCode(editingCategory.code);
      setName(editingCategory.name);
      setDescription(editingCategory.description ?? '');
      setDisplayOrder(String(editingCategory.displayOrder ?? 0));
      setIsActive(editingCategory.isActive);
    } else {
      setCode('');
      setName('');
      setDescription('');
      setDisplayOrder('0');
      setIsActive(true);
    }
  }, [open, editingCategory]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    setSubmitting(true);

    try {
      const payload = {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description: description.trim(),
        displayOrder: Number(displayOrder || 0),
        isActive,
      };

      const res = editingCategory
        ? await apiFetch<{ category: ExpenseCategory }>(
            `/api/expenses/categories/${editingCategory.id}`,
            {
              method: 'PUT',
              propertyId: property.id,
              body: payload,
            }
          )
        : await apiFetch<{ category: ExpenseCategory }>('/api/expenses/categories', {
            method: 'POST',
            propertyId: property.id,
            body: payload,
          });

      showToast(
        'success',
        editingCategory
          ? `Updated expense category "${res.category.name}"`
          : `Created expense category "${res.category.name}"`
      );
      onSaved(res.category);
      onClose();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingCategory ? 'Edit Expense Category' : 'New Expense Category'}
      subtitle={`Property-scoped operating cost classification for ${property.name}`}
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {formError && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800"
          >
            {formError}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Category Code *
            </label>
            <input
              type="text"
              required
              maxLength={40}
              placeholder="UTILITIES"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm uppercase focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Category Name *
            </label>
            <input
              type="text"
              required
              maxLength={120}
              placeholder="Electricity & Water Utilities"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Description
          </label>
          <textarea
            rows={2}
            maxLength={500}
            placeholder="Monthly power, generator fuel, water supply, and municipal utility bills."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Display Order
            </label>
            <input
              type="number"
              min={0}
              max={9999}
              value={displayOrder}
              onChange={(e) => setDisplayOrder(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <label className="flex items-center gap-2.5 pt-4 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-sm font-medium text-slate-700">
              Active for new expenses
            </span>
          </label>
        </div>

        {editingCategory && editingCategory.totalExpenseCount > 0 && !isActive && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
            Deactivating this category will prevent new expenses from selecting it while
            preserving all {editingCategory.totalExpenseCount} historical expense record
            {editingCategory.totalExpenseCount === 1 ? '' : 's'}.
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting
              ? 'Saving...'
              : editingCategory
                ? 'Save Category'
                : 'Create Category'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// 2. OPERATING EXPENSE CREATE / EDIT MODAL
// ============================================================================

interface ExpenseFormModalProps {
  open: boolean;
  onClose: () => void;
  property: Property;
  categories: ExpenseCategory[];
  suppliers: Supplier[];
  editingExpense: ExpenseRecord | null;
  onSaved: (expense: ExpenseDetail) => void;
}

export function ExpenseFormModal({
  open,
  onClose,
  property,
  categories,
  suppliers,
  editingExpense,
  onSaved,
}: ExpenseFormModalProps) {
  const { showToast } = useToast();
  const idempotencyKeyRef = useRef<string>(makeClientIdempotencyKey());

  const [categoryId, setCategoryId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [taxAmount, setTaxAmount] = useState('0');
  const [expenseDate, setExpenseDate] = useState('');
  const [paymentMethod, setPaymentMethod] =
    useState<ExpensePaymentMethod>('bank_transfer');
  const [supplierId, setSupplierId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const selectableCategories = categories.filter(
    (c) => c.isActive || (editingExpense && c.id === editingExpense.categoryId)
  );
  const selectableSuppliers = suppliers.filter(
    (s) => s.isActive || (editingExpense && s.id === editingExpense.supplierId)
  );

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setFieldErrors({});
    idempotencyKeyRef.current = makeClientIdempotencyKey();

    if (editingExpense) {
      setCategoryId(editingExpense.categoryId ?? '');
      setTitle(editingExpense.title);
      setDescription(editingExpense.description ?? '');
      setAmount(editingExpense.amount.toFixed(2));
      setTaxAmount(editingExpense.taxAmount.toFixed(2));
      setExpenseDate(editingExpense.expenseDate);
      setPaymentMethod(editingExpense.paymentMethod);
      setSupplierId(editingExpense.supplierId ?? '');
      setVendorName(editingExpense.vendorName ?? '');
      setReferenceNumber(editingExpense.referenceNumber ?? '');
      setNotes(editingExpense.notes ?? '');
    } else {
      const firstActiveCat = categories.find((c) => c.isActive);
      setCategoryId(firstActiveCat?.id ?? '');
      setTitle('');
      setDescription('');
      setAmount('');
      setTaxAmount('0');
      setExpenseDate(getPropertyLocalDate(property.timezone));
      setPaymentMethod('bank_transfer');
      setSupplierId('');
      setVendorName('');
      setReferenceNumber('');
      setNotes('');
    }
  }, [open, editingExpense, categories, property.timezone]);

  const handlePayloadChangeResetIdempotency = () => {
    if (!editingExpense && !submitting) {
      idempotencyKeyRef.current = makeClientIdempotencyKey();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    setFormError(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      const parsedAmount = Number(amount);
      const parsedTax = Number(taxAmount || 0);

      if (editingExpense) {
        const res = await apiFetch<{ expense: ExpenseDetail }>(
          `/api/expenses/${editingExpense.id}`,
          {
            method: 'PUT',
            propertyId: property.id,
            body: {
              categoryId: categoryId || undefined,
              supplierId: supplierId ? supplierId : null,
              vendorName: vendorName.trim(),
              title: title.trim(),
              description: description.trim(),
              amount: parsedAmount,
              taxAmount: parsedTax,
              expenseDate,
              paymentMethod,
              referenceNumber: referenceNumber.trim(),
              notes: notes.trim(),
            },
          }
        );
        showToast('success', `Updated expense ${res.expense.expenseNumber}`);
        onSaved(res.expense);
        onClose();
      } else {
        const res = await apiFetch<{ expense: ExpenseDetail; idempotentReplay: boolean }>(
          '/api/expenses',
          {
            method: 'POST',
            propertyId: property.id,
            body: {
              categoryId,
              supplierId: supplierId ? supplierId : null,
              vendorName: vendorName.trim(),
              title: title.trim(),
              description: description.trim(),
              amount: parsedAmount,
              taxAmount: parsedTax,
              expenseDate,
              paymentMethod,
              referenceNumber: referenceNumber.trim(),
              notes: notes.trim(),
              idempotencyKey: idempotencyKeyRef.current,
            },
          }
        );
        showToast('success', `Recorded expense ${res.expense.expenseNumber}`);
        onSaved(res.expense);
        onClose();
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.fieldErrors) {
        setFieldErrors(err.fieldErrors);
      }
      setFormError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        editingExpense
          ? `Edit Expense ${editingExpense.expenseNumber}`
          : 'Record Operating Expense'
      }
      subtitle={`Property voucher ledger for ${property.name} (${property.currency})`}
      maxWidthClass="max-w-2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {formError && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800"
          >
            {formError}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="expense-category-select"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Expense Category *
            </label>
            <select
              id="expense-category-select"
              required
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                handlePayloadChangeResetIdempotency();
              }}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            >
              <option value="">Select category...</option>
              {selectableCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code}){!c.isActive ? ' — Inactive' : ''}
                </option>
              ))}
            </select>
            {fieldErrors.categoryId && (
              <p className="mt-1 text-xs text-rose-600">{fieldErrors.categoryId}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="expense-date-input"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Expense Date *
            </label>
            <input
              id="expense-date-input"
              type="date"
              required
              value={expenseDate}
              onChange={(e) => {
                setExpenseDate(e.target.value);
                handlePayloadChangeResetIdempotency();
              }}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            {fieldErrors.expenseDate && (
              <p className="mt-1 text-xs text-rose-600">{fieldErrors.expenseDate}</p>
            )}
          </div>
        </div>

        <div>
          <label
            htmlFor="expense-title-input"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Expense Title / Summary *
          </label>
          <input
            id="expense-title-input"
            type="text"
            required
            maxLength={180}
            placeholder="Monthly Commercial Electricity Bill — Main Meter"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              handlePayloadChangeResetIdempotency();
            }}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          {fieldErrors.title && (
            <p className="mt-1 text-xs text-rose-600">{fieldErrors.title}</p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="expense-amount-input"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Total Amount ({property.currency}) *
            </label>
            <input
              id="expense-amount-input"
              type="number"
              required
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                handlePayloadChangeResetIdempotency();
              }}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium focus:border-indigo-500 focus:outline-none"
            />
            {fieldErrors.amount && (
              <p className="mt-1 text-xs text-rose-600">{fieldErrors.amount}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="expense-tax-input"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Included Tax ({property.currency})
            </label>
            <input
              id="expense-tax-input"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={taxAmount}
              onChange={(e) => {
                setTaxAmount(e.target.value);
                handlePayloadChangeResetIdempotency();
              }}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            {fieldErrors.taxAmount && (
              <p className="mt-1 text-xs text-rose-600">{fieldErrors.taxAmount}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="expense-payment-method-select"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Payment Method *
            </label>
            <select
              id="expense-payment-method-select"
              value={paymentMethod}
              onChange={(e) => {
                setPaymentMethod(e.target.value as ExpensePaymentMethod);
                handlePayloadChangeResetIdempotency();
              }}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            >
              {EXPENSE_PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {EXPENSE_PAYMENT_METHOD_LABELS[method]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="expense-supplier-select"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Registered Supplier (Optional)
            </label>
            <select
              id="expense-supplier-select"
              value={supplierId}
              onChange={(e) => {
                const nextId = e.target.value;
                setSupplierId(nextId);
                if (nextId && !vendorName.trim()) {
                  const found = selectableSuppliers.find((s) => s.id === nextId);
                  if (found) setVendorName(found.name);
                }
                handlePayloadChangeResetIdempotency();
              }}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            >
              <option value="">None / Direct Payee</option>
              {selectableSuppliers.map((sup) => (
                <option key={sup.id} value={sup.id}>
                  {sup.name}
                  {!sup.isActive ? ' (Inactive)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="expense-vendor-input"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Payee / Vendor Name
            </label>
            <input
              id="expense-vendor-input"
              type="text"
              maxLength={160}
              placeholder="Purvanchal Power Corp"
              value={vendorName}
              onChange={(e) => {
                setVendorName(e.target.value);
                handlePayloadChangeResetIdempotency();
              }}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="expense-reference-input"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Bill / Reference #
            </label>
            <input
              id="expense-reference-input"
              type="text"
              maxLength={100}
              placeholder="UTR-884120 / BILL-104"
              value={referenceNumber}
              onChange={(e) => {
                setReferenceNumber(e.target.value);
                handlePayloadChangeResetIdempotency();
              }}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="expense-description-input"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Description
          </label>
          <textarea
            id="expense-description-input"
            rows={2}
            maxLength={2000}
            placeholder="Detailed scope of work, billing period, or itemization..."
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              handlePayloadChangeResetIdempotency();
            }}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="expense-notes-input"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Internal Accounting Notes
          </label>
          <input
            id="expense-notes-input"
            type="text"
            maxLength={1500}
            placeholder="Approved by duty manager; receipt filed in October folder."
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              handlePayloadChangeResetIdempotency();
            }}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || selectableCategories.length === 0}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting
              ? 'Saving...'
              : editingExpense
                ? 'Save Changes'
                : 'Record Expense'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// 3. VOID EXPENSE MODAL (Auditable Reason Required)
// ============================================================================

interface VoidExpenseModalProps {
  open: boolean;
  onClose: () => void;
  property: Property;
  expense: ExpenseRecord | null;
  onVoided: (expense: ExpenseDetail) => void;
}

export function VoidExpenseModal({
  open,
  onClose,
  property,
  expense,
  onVoided,
}: VoidExpenseModalProps) {
  const { showToast } = useToast();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setError(null);
  }, [open]);

  if (!expense) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    try {
      const res = await apiFetch<{ expense: ExpenseDetail }>(
        `/api/expenses/${expense.id}/void`,
        {
          method: 'POST',
          propertyId: property.id,
          body: { reason: reason.trim() },
        }
      );
      showToast('success', `Voided expense ${res.expense.expenseNumber}`);
      onVoided(res.expense);
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
      title={`Void Expense ${expense.expenseNumber}`}
      subtitle="Voided expenses are excluded from active totals while permanently retained in audit history."
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800"
          >
            {error}
          </div>
        )}

        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-900 space-y-1">
            <p className="font-semibold">
              {expense.title} — {formatMoney(expense.amount, expense.currency)}
            </p>
            <p>
              This action is irreversible. The voucher will remain visible in expense
              history marked as <strong>Voided</strong> with your name, timestamp, and
              reason, and will be excluded from active operating expense totals.
            </p>
          </div>
        </div>

        <div>
          <label
            htmlFor="void-expense-reason"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Void Reason (Required for Audit Trail) *
          </label>
          <textarea
            id="void-expense-reason"
            required
            minLength={3}
            maxLength={500}
            rows={3}
            placeholder="e.g., Duplicate vendor bill entry; superseded by corrected voucher."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-rose-500 focus:outline-none"
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || reason.trim().length < 3}
            className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-rose-700 disabled:opacity-50"
          >
            <Ban className="h-4 w-4" />
            {submitting ? 'Voiding...' : 'Confirm Void Expense'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// 4. EXPENSE DETAIL & AUDIT HISTORY MODAL
// ============================================================================

interface ExpenseDetailModalProps {
  open: boolean;
  onClose: () => void;
  property: Property;
  expenseId: string | null;
}

export function ExpenseDetailModal({
  open,
  onClose,
  property,
  expenseId,
}: ExpenseDetailModalProps) {
  const [detail, setDetail] = useState<ExpenseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !expenseId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiFetch<{ expense: ExpenseDetail }>(`/api/expenses/${expenseId}`, {
      propertyId: property.id,
    })
      .then((res) => {
        if (!cancelled) setDetail(res.expense);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, expenseId, property.id]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={detail ? `Expense Voucher ${detail.expenseNumber}` : 'Expense Voucher Details'}
      subtitle={`Complete record and immutable audit trail for ${property.name}`}
      maxWidthClass="max-w-2xl"
    >
      {loading && (
        <div className="py-10 text-center text-sm text-slate-500">
          Loading expense voucher details...
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          {error}
        </div>
      )}

      {!loading && !error && detail && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50/80 p-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="font-mono text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded">
                  {detail.expenseNumber}
                </span>
                <ExpenseStatusBadge status={detail.status} />
                <span className="inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-700">
                  {detail.categoryName}
                </span>
              </div>
              <h3 className="text-base font-bold text-slate-900 pt-1">{detail.title}</h3>
              {detail.description && (
                <p className="text-xs text-slate-600 leading-relaxed">
                  {detail.description}
                </p>
              )}
            </div>

            <div className="text-right">
              <p className="text-xs font-medium text-slate-500">Voucher Amount</p>
              <p
                className={`text-xl font-bold ${
                  detail.status === 'voided'
                    ? 'text-rose-700 line-through'
                    : 'text-slate-900'
                }`}
              >
                {formatMoney(detail.amount, detail.currency)}
              </p>
              {detail.taxAmount > 0 && (
                <p className="text-xs text-slate-500">
                  Includes tax: {formatMoney(detail.taxAmount, detail.currency)}
                </p>
              )}
            </div>
          </div>

          {detail.status === 'voided' && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs text-rose-900 space-y-1">
              <p className="font-semibold flex items-center gap-1.5">
                <Ban className="h-4 w-4 text-rose-600" />
                Voided Voucher — Excluded from Active Operating Expense Totals
              </p>
              <p>
                <strong>Reason:</strong> {detail.voidReason || 'Not specified'}
              </p>
              <p className="text-rose-700">
                Voided by {detail.voidedByName ?? 'Administrator'} on{' '}
                {detail.voidedAt ? new Date(detail.voidedAt).toLocaleString() : 'N/A'}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-slate-200 p-3 space-y-1.5">
              <p className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                Payment & Reference
              </p>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" /> Expense Date
                </span>
                <span className="font-semibold text-slate-800">
                  {formatDisplayDate(detail.expenseDate)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 flex items-center gap-1">
                  <Receipt className="h-3.5 w-3.5" /> Payment Method
                </span>
                <ExpensePaymentMethodBadge method={detail.paymentMethod} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 flex items-center gap-1">
                  <FileText className="h-3.5 w-3.5" /> Reference #
                </span>
                <span className="font-mono font-medium text-slate-800">
                  {detail.referenceNumber || '—'}
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 p-3 space-y-1.5">
              <p className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                Vendor & Attribution
              </p>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 flex items-center gap-1">
                  <Building2 className="h-3.5 w-3.5" /> Supplier / Payee
                </span>
                <span className="font-semibold text-slate-800">
                  {detail.supplierName || detail.vendorName || '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 flex items-center gap-1">
                  <User className="h-3.5 w-3.5" /> Recorded By
                </span>
                <span className="font-medium text-slate-800">
                  {detail.recordedByName ?? 'System'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" /> Created At
                </span>
                <span className="text-slate-700">
                  {new Date(detail.createdAt).toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          {detail.notes && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700">
              <span className="font-semibold text-slate-800">Notes: </span>
              {detail.notes}
            </div>
          )}

          {/* Immutable Audit History */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5 mb-2.5">
              <History className="h-4 w-4 text-indigo-600" />
              Audit History ({detail.history.length})
            </h4>
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
              {detail.history.map((entry) => (
                <div key={entry.id} className="px-3.5 py-2.5 text-xs flex items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      {entry.action === 'voided' ? (
                        <Ban className="h-3.5 w-3.5 text-rose-600" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      )}
                      <span className="font-semibold text-slate-900">
                        {EXPENSE_HISTORY_ACTION_LABELS[entry.action] ?? entry.action}
                      </span>
                      <span className="text-slate-500">
                        by {entry.actorName ?? 'Staff'}
                      </span>
                    </div>
                    {entry.reason && (
                      <p className="text-slate-600 pl-5">{entry.reason}</p>
                    )}
                  </div>
                  <span className="text-slate-400 shrink-0">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
