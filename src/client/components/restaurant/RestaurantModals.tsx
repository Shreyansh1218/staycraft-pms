import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  Check,
  ChefHat,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Package,
  Plus,
  Printer,
  QrCode,
  Receipt,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  UtensilsCrossed,
} from 'lucide-react';
import {
  DIETARY_TAGS,
  DIETARY_TAG_LABELS,
  type DietaryTag,
  type FoodOrderStatus,
  type UserRole,
} from '@shared/constants';
import { formatMoney } from '@shared/pricing';
import type {
  FoodCategory,
  FoodMenuItem,
  FoodOrderDetail,
  InventoryItem,
  InvoiceDetail,
  PropertyQrFoodConfig,
} from '@shared/types';
import { useToast } from '../../context/ToastContext';
import { ApiClientError, apiFetch } from '../../lib/api';
import { ErrorAlert } from '../ui/Feedback';
import { Modal } from '../ui/Modal';
import {
  FoodBillingStatusBadge,
  FoodOrderSourceBadge,
  FoodOrderStatusBadge,
  FoodOrderTypeBadge,
} from '../ui/StatusBadge';

// ============================================================================
// 1. Food Category Create / Edit Modal (Admin)
// ============================================================================

interface FoodCategoryModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  editingCategory: FoodCategory | null;
  onSaved: (category: FoodCategory) => void;
}

export function FoodCategoryModal({
  open,
  onClose,
  propertyId,
  editingCategory,
  onSaved,
}: FoodCategoryModalProps) {
  const { showToast } = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [displayOrder, setDisplayOrder] = useState('0');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editingCategory) {
      setCode(editingCategory.code);
      setName(editingCategory.name);
      setDescription(editingCategory.description);
      setDisplayOrder(String(editingCategory.displayOrder));
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
    setError(null);
    setSubmitting(true);
    try {
      const path = editingCategory
        ? `/api/restaurant/categories/${editingCategory.id}`
        : '/api/restaurant/categories';
      const method = editingCategory ? 'PUT' : 'POST';

      const res = await apiFetch<{ category: FoodCategory }>(path, {
        method,
        propertyId,
        body: {
          code: code.trim().toUpperCase(),
          name: name.trim(),
          description: description.trim(),
          displayOrder: Number(displayOrder || 0),
          isActive,
        },
      });
      showToast(
        'success',
        editingCategory
          ? `Updated category "${res.category.name}"`
          : `Created category "${res.category.name}"`
      );
      onSaved(res.category);
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError && err.fieldErrors) {
        setError(Object.values(err.fieldErrors)[0] || err.message);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingCategory ? `Edit Category — ${editingCategory.name}` : 'New Food Category'}
      subtitle="Organize property menu items by dining section"
      maxWidthClass="max-w-md"
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-1">
            <label htmlFor="cat-code" className="block text-xs font-semibold text-slate-700 mb-1">
              Code *
            </label>
            <input
              id="cat-code"
              type="text"
              required
              maxLength={30}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="MAIN"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>
          <div className="col-span-2">
            <label htmlFor="cat-name" className="block text-xs font-semibold text-slate-700 mb-1">
              Category Name *
            </label>
            <input
              id="cat-name"
              type="text"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="North Indian Mains"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label htmlFor="cat-desc" className="block text-xs font-semibold text-slate-700 mb-1">
            Description (Optional)
          </label>
          <input
            id="cat-desc"
            type="text"
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Signature curries, tandoor breads, and rice..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 items-center">
          <div>
            <label htmlFor="cat-sort" className="block text-xs font-semibold text-slate-700 mb-1">
              Sort Order
            </label>
            <input
              id="cat-sort"
              type="number"
              min="0"
              max="9999"
              value={displayOrder}
              onChange={(e) => setDisplayOrder(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 pt-5 text-xs font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600"
            />
            Active in POS
          </label>
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
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? 'Saving...' : editingCategory ? 'Save Category' : 'Create Category'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// 2. Menu Item Create / Edit Modal (Admin)
// ============================================================================

interface FoodMenuItemModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  currency: string;
  categories: FoodCategory[];
  editingItem: FoodMenuItem | null;
  onSaved: (item: FoodMenuItem) => void;
}

export function FoodMenuItemModal({
  open,
  onClose,
  propertyId,
  currency,
  categories,
  editingItem,
  onSaved,
}: FoodMenuItemModalProps) {
  const { showToast } = useToast();
  const [categoryId, setCategoryId] = useState('');
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [dietaryTag, setDietaryTag] = useState<DietaryTag>('veg');
  const [prepTimeMinutes, setPrepTimeMinutes] = useState('15');
  const [isAvailable, setIsAvailable] = useState(true);
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editingItem) {
      setCategoryId(editingItem.categoryId);
      setSku(editingItem.sku);
      setName(editingItem.name);
      setDescription(editingItem.description);
      setPrice(editingItem.price.toFixed(2));
      setDietaryTag(editingItem.dietaryTag);
      setPrepTimeMinutes(
        editingItem.prepTimeMinutes !== null ? String(editingItem.prepTimeMinutes) : ''
      );
      setIsAvailable(editingItem.isAvailable);
      setIsActive(editingItem.isActive);
    } else {
      const firstActiveCat = categories.find((c) => c.isActive) ?? categories[0];
      setCategoryId(firstActiveCat?.id ?? '');
      setSku('');
      setName('');
      setDescription('');
      setPrice('');
      setDietaryTag('veg');
      setPrepTimeMinutes('15');
      setIsAvailable(true);
      setIsActive(true);
    }
  }, [open, editingItem, categories]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const path = editingItem
        ? `/api/restaurant/menu-items/${editingItem.id}`
        : '/api/restaurant/menu-items';
      const method = editingItem ? 'PUT' : 'POST';

      const res = await apiFetch<{ menuItem: FoodMenuItem }>(path, {
        method,
        propertyId,
        body: {
          categoryId,
          sku: sku.trim().toUpperCase(),
          name: name.trim(),
          description: description.trim(),
          price: Number(price),
          dietaryTag,
          prepTimeMinutes: prepTimeMinutes.trim() ? Number(prepTimeMinutes) : null,
          isAvailable,
          isActive,
        },
      });
      showToast(
        'success',
        editingItem
          ? `Updated menu item "${res.menuItem.name}"`
          : `Added menu item "${res.menuItem.name}"`
      );
      onSaved(res.menuItem);
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError && err.fieldErrors) {
        setError(Object.values(err.fieldErrors)[0] || err.message);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingItem ? `Edit Menu Item — ${editingItem.name}` : 'New Menu Item'}
      subtitle="Historical orders keep their snapshotted item name and price when updated"
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label htmlFor="menu-category" className="block text-xs font-semibold text-slate-700 mb-1">
              Category *
            </label>
            <select
              id="menu-category"
              required
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name} {!cat.isActive ? '(Inactive)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="menu-sku" className="block text-xs font-semibold text-slate-700 mb-1">
              Item Code / SKU *
            </label>
            <input
              id="menu-sku"
              type="text"
              required
              maxLength={40}
              value={sku}
              onChange={(e) => setSku(e.target.value.toUpperCase())}
              placeholder="MAIN-PNR-01"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>
        </div>

        <div>
          <label htmlFor="menu-name" className="block text-xs font-semibold text-slate-700 mb-1">
            Dish / Item Name *
          </label>
          <input
            id="menu-name"
            type="text"
            required
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Paneer Lababdar"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="menu-desc" className="block text-xs font-semibold text-slate-700 mb-1">
            Description (Optional)
          </label>
          <input
            id="menu-desc"
            type="text"
            maxLength={600}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Cottage cheese simmered in spiced tomato-cashew gravy"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
          <div>
            <label htmlFor="menu-price" className="block text-xs font-semibold text-slate-700 mb-1">
              Unit Price ({currency}) *
            </label>
            <input
              id="menu-price"
              type="number"
              step="0.01"
              min="0.01"
              required
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="420.00"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold"
            />
          </div>

          <div>
            <label htmlFor="menu-dietary" className="block text-xs font-semibold text-slate-700 mb-1">
              Dietary Type
            </label>
            <select
              id="menu-dietary"
              value={dietaryTag}
              onChange={(e) => setDietaryTag(e.target.value as DietaryTag)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {DIETARY_TAGS.map((t) => (
                <option key={t} value={t}>
                  {DIETARY_TAG_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="menu-prep" className="block text-xs font-semibold text-slate-700 mb-1">
              Est. Prep (mins)
            </label>
            <input
              id="menu-prep"
              type="number"
              min="1"
              max="240"
              value={prepTimeMinutes}
              onChange={(e) => setPrepTimeMinutes(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-6 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs">
          <label className="flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={isAvailable}
              onChange={(e) => setIsAvailable(e.target.checked)}
              className="rounded border-slate-300 text-emerald-600"
            />
            Available Today (In Kitchen Stock)
          </label>
          <label className="flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600"
            />
            Active Menu Item
          </label>
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
            disabled={submitting || categories.length === 0}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? 'Saving...' : editingItem ? 'Save Item' : 'Create Menu Item'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// 3. Food Order Detail, Kitchen Workflow, Folio Posting & Auditable Reversal Modal
// ============================================================================

interface FoodOrderDetailModalProps {
  open: boolean;
  onClose: () => void;
  orderId: string | null;
  propertyId: string;
  userRole: UserRole;
  onUpdated: (order: FoodOrderDetail) => void;
}

export function FoodOrderDetailModal({
  open,
  onClose,
  orderId,
  propertyId,
  userRole,
  onUpdated,
}: FoodOrderDetailModalProps) {
  const { showToast } = useToast();
  const [order, setOrder] = useState<FoodOrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [notesEdit, setNotesEdit] = useState('');
  const [tableEdit, setTableEdit] = useState('');

  const [cancelMode, setCancelMode] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const [reverseMode, setReverseMode] = useState(false);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseAlsoCancel, setReverseAlsoCancel] = useState(false);

  useEffect(() => {
    if (!open || !orderId || !propertyId) return;
    setLoading(true);
    setError(null);
    setCancelMode(false);
    setCancelReason('');
    setReverseMode(false);
    setReverseReason('');
    setReverseAlsoCancel(false);

    apiFetch<{ order: FoodOrderDetail }>(`/api/restaurant/orders/${orderId}`, {
      propertyId,
    })
      .then((res) => {
        setOrder(res.order);
        setNotesEdit(res.order.notes);
        setTableEdit(res.order.tableLabel);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [open, orderId, propertyId]);

  const applyOrder = (updated: FoodOrderDetail) => {
    setOrder(updated);
    setNotesEdit(updated.notes);
    setTableEdit(updated.tableLabel);
    onUpdated(updated);
  };

  const handleStatusTransition = async (nextStatus: 'preparing' | 'ready' | 'served') => {
    if (!order) return;
    setBusyAction(`status-${nextStatus}`);
    setError(null);
    try {
      const res = await apiFetch<{ order: FoodOrderDetail }>(
        `/api/restaurant/orders/${order.id}/status`,
        {
          method: 'POST',
          propertyId,
          body: { status: nextStatus },
        }
      );
      applyOrder(res.order);
      showToast('success', `Order ${res.order.orderReference} marked ${nextStatus}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSavePendingNotes = async () => {
    if (!order) return;
    setBusyAction('save-notes');
    setError(null);
    try {
      const res = await apiFetch<{ order: FoodOrderDetail }>(
        `/api/restaurant/orders/${order.id}`,
        {
          method: 'PUT',
          propertyId,
          body: {
            notes: notesEdit,
            tableLabel: order.orderType === 'room_service' ? undefined : tableEdit,
          },
        }
      );
      applyOrder(res.order);
      showToast('success', 'Updated pending order instructions');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handlePostToInvoice = async () => {
    if (!order) return;
    setBusyAction('post-folio');
    setError(null);
    try {
      const res = await apiFetch<{ order: FoodOrderDetail; invoice: InvoiceDetail }>(
        `/api/restaurant/orders/${order.id}/post-to-invoice`,
        {
          method: 'POST',
          propertyId,
          body: { createDraftInvoiceIfMissing: true },
        }
      );
      applyOrder(res.order);
      showToast(
        'success',
        `Posted ${formatMoney(res.order.totalAmount, res.order.currency)} to Invoice ${res.invoice.invoiceNumber}`
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!order) return;
    setBusyAction('cancel');
    setError(null);
    try {
      const res = await apiFetch<{ order: FoodOrderDetail }>(
        `/api/restaurant/orders/${order.id}/cancel`,
        {
          method: 'POST',
          propertyId,
          body: { reason: cancelReason },
        }
      );
      applyOrder(res.order);
      setCancelMode(false);
      showToast('info', `Order ${res.order.orderReference} cancelled`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleReverseCharge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!order) return;
    setBusyAction('reverse');
    setError(null);
    try {
      const res = await apiFetch<{ order: FoodOrderDetail; invoice: InvoiceDetail }>(
        `/api/restaurant/orders/${order.id}/reverse-charge`,
        {
          method: 'POST',
          propertyId,
          body: {
            reason: reverseReason,
            cancelOrder: reverseAlsoCancel,
          },
        }
      );
      applyOrder(res.order);
      setReverseMode(false);
      showToast(
        'info',
        `Reversed folio charge on Invoice ${res.invoice.invoiceNumber}`
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const nextKitchenStep: Record<
    FoodOrderStatus,
    { next: 'preparing' | 'ready' | 'served'; label: string } | null
  > = {
    pending: { next: 'preparing', label: 'Start Preparing' },
    preparing: { next: 'ready', label: 'Mark Ready' },
    ready: { next: 'served', label: 'Mark Served' },
    served: null,
    cancelled: null,
  };

  const nextAction = order ? nextKitchenStep[order.status] : null;
  const canEditPending =
    order?.status === 'pending' &&
    order.billingStatus !== 'posted' &&
    order.billingStatus !== 'reversed';
  const canCancel =
    order &&
    ['pending', 'preparing', 'ready'].includes(order.status) &&
    order.billingStatus !== 'posted';
  const canPostToInvoice =
    order &&
    order.orderType === 'room_service' &&
    order.status !== 'cancelled' &&
    order.billingStatus === 'unbilled';
  const canReversePosted =
    userRole === 'admin' && order?.billingStatus === 'posted';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={order ? `Order ${order.orderReference}` : 'Order Details'}
      subtitle="Itemized kitchen ticket, historical price snapshot, and guest folio status"
      maxWidthClass="max-w-2xl"
    >
      {loading || !order ? (
        <div className="py-10 text-center text-sm text-slate-500">
          {error ? <ErrorAlert message={error} /> : 'Loading order details...'}
        </div>
      ) : (
        <div className="space-y-5 text-xs">
          {error && <ErrorAlert message={error} />}

          {/* Header Badges & Context */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <FoodOrderTypeBadge orderType={order.orderType} />
                <FoodOrderSourceBadge orderSource={order.orderSource} />
                <FoodOrderStatusBadge status={order.status} />
                <FoodBillingStatusBadge status={order.billingStatus} />
              </div>
              <p className="text-slate-600 pt-1">
                {order.orderType === 'room_service' ? (
                  <>
                    <strong>Room {order.roomNumber}</strong> • {order.guestName} (
                    {order.reservationId ? (
                      <Link
                        to={`/reservations/${order.reservationId}`}
                        className="font-semibold text-indigo-600 hover:underline"
                      >
                        {order.bookingReference}
                      </Link>
                    ) : (
                      order.bookingReference
                    )}
                    )
                  </>
                ) : order.orderType === 'restaurant' ? (
                  <>
                    <strong>{order.tableLabel || 'Dining Room'}</strong>
                    {order.customerName ? ` • ${order.customerName}` : ''}
                  </>
                ) : (
                  <>
                    <strong>Takeaway Parcel</strong>
                    {order.customerName ? ` • ${order.customerName}` : ''}
                  </>
                )}
              </p>
            </div>

            <div className="text-right">
              <p className="text-slate-400">Placed</p>
              <p className="font-semibold text-slate-800">
                {new Date(order.placedAt).toLocaleString()}
              </p>
              {order.createdByName && (
                <p className="text-[11px] text-slate-500">by {order.createdByName}</p>
              )}
            </div>
          </div>

          {/* Room-Service Folio Banner */}
          {order.orderType === 'room_service' && (
            <div
              data-testid="order-folio-panel"
              className={`rounded-xl border p-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
                order.billingStatus === 'posted'
                  ? 'border-emerald-200 bg-emerald-50/80 text-emerald-950'
                  : order.billingStatus === 'reversed'
                    ? 'border-rose-200 bg-rose-50/80 text-rose-950'
                    : 'border-amber-200 bg-amber-50/80 text-amber-950'
              }`}
            >
              <div className="space-y-0.5">
                <p className="font-bold flex items-center gap-1.5">
                  <Receipt className="h-4 w-4 shrink-0" />
                  {order.billingStatus === 'posted'
                    ? `Posted to Guest Invoice ${order.postedInvoiceNumber}`
                    : order.billingStatus === 'reversed'
                      ? `Charge Reversed on Invoice ${order.postedInvoiceNumber}`
                      : 'Unbilled Room-Service Charge'}
                </p>
                <p className="text-[11px] opacity-90">
                  {order.billingStatus === 'posted'
                    ? `Added to invoice balance due (${order.postedInvoiceStatus?.replace('_', ' ')}) without marking paid.`
                    : order.billingStatus === 'reversed'
                      ? `Reason: ${order.reversalReason} (${order.reversedByName ?? 'Admin'})`
                      : 'Post this order to the guest folio so it settles cleanly on their stay invoice.'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {order.postedInvoiceId && (
                  <Link
                    to={`/invoices/${order.postedInvoiceId}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                  >
                    <FileText className="h-3.5 w-3.5 text-indigo-600" />
                    Open Invoice
                  </Link>
                )}
                {canPostToInvoice && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => void handlePostToInvoice()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    <Receipt className="h-3.5 w-3.5" />
                    {busyAction === 'post-folio' ? 'Posting...' : 'Post to Guest Folio'}
                  </button>
                )}
                {canReversePosted && !reverseMode && (
                  <button
                    type="button"
                    onClick={() => setReverseMode(true)}
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reverse Charge
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Auditable Charge Reversal Form (Admin) */}
          {reverseMode && (
            <form
              onSubmit={(e) => void handleReverseCharge(e)}
              className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 space-y-3"
            >
              <p className="font-bold text-rose-900">
                Auditable Invoice Charge Reversal (Preserves Ledger History)
              </p>
              <div>
                <label
                  htmlFor="reverse-charge-reason"
                  className="block font-semibold text-rose-900 mb-1"
                >
                  Reversal Reason *
                </label>
                <input
                  id="reverse-charge-reason"
                  type="text"
                  required
                  minLength={3}
                  value={reverseReason}
                  onChange={(e) => setReverseReason(e.target.value)}
                  placeholder="e.g. Guest returned cold dish — manager comped"
                  className="w-full rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm"
                />
              </div>
              {['pending', 'preparing', 'ready'].includes(order.status) && (
                <label className="flex items-center gap-2 font-medium text-rose-900 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reverseAlsoCancel}
                    onChange={(e) => setReverseAlsoCancel(e.target.checked)}
                    className="rounded border-rose-300 text-rose-600"
                  />
                  Also cancel active kitchen ticket
                </label>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReverseMode(false)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={busyAction !== null}
                  className="rounded-lg bg-rose-600 px-3.5 py-1.5 font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {busyAction === 'reverse' ? 'Reversing...' : 'Confirm Charge Reversal'}
                </button>
              </div>
            </form>
          )}

          {/* Snapshotted Order Items Table */}
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3.5 py-2.5 text-left">Item (Snapshotted)</th>
                  <th className="px-3.5 py-2.5 text-right">Qty</th>
                  <th className="px-3.5 py-2.5 text-right">Unit Price</th>
                  <th className="px-3.5 py-2.5 text-right">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {order.items.map((it) => (
                  <tr key={it.id}>
                    <td className="px-3.5 py-2.5">
                      <div className="font-semibold text-slate-900">{it.itemNameSnapshot}</div>
                      {it.categoryNameSnapshot && (
                        <div className="text-[11px] text-slate-400">{it.categoryNameSnapshot}</div>
                      )}
                      {it.specialInstructions && (
                        <div className="mt-1 inline-block rounded bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] font-medium text-amber-900">
                          Note: {it.specialInstructions}
                        </div>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-semibold text-slate-800">
                      {it.quantity}
                    </td>
                    <td className="px-3.5 py-2.5 text-right text-slate-600">
                      {formatMoney(it.unitPrice, order.currency)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-bold text-slate-900">
                      {formatMoney(it.lineSubtotal, order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals & Notes */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div className="sm:col-span-7 space-y-2">
              {canEditPending ? (
                <div className="rounded-xl border border-slate-200 p-3 space-y-2.5">
                  <p className="font-semibold text-slate-800">Edit Pending Ticket Details</p>
                  {order.orderType !== 'room_service' && (
                    <div>
                      <label htmlFor="edit-order-table" className="block text-[11px] text-slate-500 mb-0.5">
                        Table / Parcel Label
                      </label>
                      <input
                        id="edit-order-table"
                        type="text"
                        value={tableEdit}
                        onChange={(e) => setTableEdit(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                      />
                    </div>
                  )}
                  <div>
                    <label htmlFor="edit-order-notes" className="block text-[11px] text-slate-500 mb-0.5">
                      Kitchen / Delivery Notes
                    </label>
                    <input
                      id="edit-order-notes"
                      type="text"
                      value={notesEdit}
                      onChange={(e) => setNotesEdit(e.target.value)}
                      placeholder="Allergy or delivery instructions..."
                      className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => void handleSavePendingNotes()}
                    className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    <Save className="h-3.5 w-3.5" />
                    Save Changes
                  </button>
                </div>
              ) : (
                order.notes && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="font-semibold text-slate-700 mb-0.5">Order Notes</p>
                    <p className="text-slate-600">{order.notes}</p>
                  </div>
                )
              )}

              {order.status === 'cancelled' && order.cancelReason && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-900">
                  <p className="font-semibold">Cancelled: {order.cancelReason}</p>
                  {order.cancelledByName && (
                    <p className="text-[11px] mt-0.5">by {order.cancelledByName}</p>
                  )}
                </div>
              )}
            </div>

            <div className="sm:col-span-5 rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-1.5">
              <div className="flex justify-between text-slate-600">
                <span>Items Subtotal</span>
                <span className="font-semibold text-slate-900">
                  {formatMoney(order.subtotal, order.currency)}
                </span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>
                  {order.taxName} ({order.taxRate}%)
                </span>
                <span className="font-semibold text-slate-900">
                  {formatMoney(order.taxAmount, order.currency)}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-sm font-bold text-slate-900">
                <span>Order Total</span>
                <span className="text-indigo-700">
                  {formatMoney(order.totalAmount, order.currency)}
                </span>
              </div>
            </div>
          </div>

          {/* Cancel Confirmation Form */}
          {cancelMode && (
            <form
              onSubmit={(e) => void handleCancelOrder(e)}
              className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 space-y-2.5"
            >
              <label htmlFor="cancel-order-reason" className="block font-semibold text-rose-900">
                Cancellation Reason *
              </label>
              <input
                id="cancel-order-reason"
                type="text"
                required
                minLength={3}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Guest changed mind before serving..."
                className="w-full rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCancelMode(false)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={busyAction !== null}
                  className="rounded-lg bg-rose-600 px-3.5 py-1.5 font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {busyAction === 'cancel' ? 'Cancelling...' : 'Confirm Cancel Order'}
                </button>
              </div>
            </form>
          )}

          {/* Ingredient Inventory Deductions (Phase 5 Recipe Integration) */}
          {order.stockMovements && order.stockMovements.length > 0 && (
            <div className="border-t border-slate-200 pt-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-bold uppercase tracking-wider text-[11px] text-slate-400">
                  Kitchen Ingredient Stock Deductions
                </h4>
                <span className="text-[11px] font-semibold text-violet-700">
                  Deducted on Prep Start • Non-auto-restoring
                </span>
              </div>
              <div className="space-y-1.5">
                {order.stockMovements.map((mov) => (
                  <div
                    key={mov.id}
                    data-testid={`order-stock-deduction-${mov.productSku}`}
                    className="flex items-center justify-between rounded-lg border border-violet-100 bg-violet-50/60 px-3 py-1.5 text-[11px]"
                  >
                    <div className="flex items-center gap-2 text-slate-800">
                      <Package className="h-3.5 w-3.5 text-violet-600 shrink-0" />
                      <span className="font-semibold">{mov.productName}</span>
                      <span className="font-mono text-slate-500">({mov.productSku})</span>
                    </div>
                    <span className="font-mono font-bold text-rose-700">
                      {mov.quantityDelta} {mov.unit} ({mov.stockBefore} → {mov.stockAfter})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Kitchen & Lifecycle History */}
          <div className="border-t border-slate-200 pt-4">
            <h4 className="font-bold uppercase tracking-wider text-[11px] text-slate-400 mb-2">
              Kitchen & Status Timeline
            </h4>
            <div className="space-y-1.5">
              {order.statusHistory.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-[11px]"
                >
                  <div className="flex items-center gap-2 text-slate-700">
                    <Clock className="h-3 w-3 text-slate-400 shrink-0" />
                    <span className="font-semibold uppercase">
                      {h.fromStatus ? `${h.fromStatus} → ${h.toStatus}` : h.toStatus}
                    </span>
                    {h.note && <span className="text-slate-500">— {h.note}</span>}
                  </div>
                  <span className="text-slate-400 shrink-0">
                    {h.changedByName ? `${h.changedByName} • ` : ''}
                    {new Date(h.createdAt).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Bottom Actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100">
            <div>
              {canCancel && !cancelMode && (
                <button
                  type="button"
                  onClick={() => setCancelMode(true)}
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                >
                  <Ban className="h-3.5 w-3.5" />
                  Cancel Order
                </button>
              )}
              {order.billingStatus === 'posted' &&
                ['pending', 'preparing', 'ready'].includes(order.status) && (
                  <span className="text-[11px] text-slate-500">
                    Posted orders require charge reversal before cancellation.
                  </span>
                )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
              >
                Close
              </button>
              {nextAction && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleStatusTransition(nextAction.next)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {nextAction.next === 'served' ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : nextAction.next === 'ready' ? (
                    <UtensilsCrossed className="h-3.5 w-3.5" />
                  ) : (
                    <ChefHat className="h-3.5 w-3.5" />
                  )}
                  {nextAction.label}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ============================================================================
// 4. Menu Item Ingredient Recipe Modal (Admin — Phase 5 Integration)
// ============================================================================

interface MenuItemRecipeModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  menuItem: FoodMenuItem | null;
  onSaved: (updated: FoodMenuItem) => void;
}

interface RecipeDraftLine {
  key: string;
  productId: string;
  quantityRequired: string;
}

export function MenuItemRecipeModal({
  open,
  onClose,
  propertyId,
  menuItem,
  onSaved,
}: MenuItemRecipeModalProps) {
  const { showToast } = useToast();
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [lines, setLines] = useState<RecipeDraftLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !menuItem || !propertyId) return;
    setError(null);
    setLoadingCatalog(true);

    const existingIngredients = menuItem.ingredients ?? [];
    setLines(
      existingIngredients.map((ing, idx) => ({
        key: `rec-${idx}-${ing.productId}`,
        productId: ing.productId,
        quantityRequired: String(ing.quantityRequired),
      }))
    );

    apiFetch<{ items: InventoryItem[] }>('/api/inventory/items', { propertyId })
      .then((res) => setInventoryItems(res.items))
      .catch((err) => setError((err as Error).message || 'Failed to load inventory items'))
      .finally(() => setLoadingCatalog(false));
  }, [open, menuItem, propertyId]);

  const addIngredientLine = () => {
    const usedIds = new Set(lines.map((l) => l.productId));
    const nextAvailable =
      inventoryItems.find((it) => !usedIds.has(it.id)) ?? inventoryItems[0];
    if (!nextAvailable) return;
    setLines((prev) => [
      ...prev,
      {
        key: `rec-${Date.now()}-${prev.length}`,
        productId: nextAvailable.id,
        quantityRequired: '0.25',
      },
    ]);
  };

  const updateLine = (key: string, patch: Partial<RecipeDraftLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const removeLine = (key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!menuItem) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ menuItem: FoodMenuItem }>(
        `/api/restaurant/menu-items/${menuItem.id}/ingredients`,
        {
          method: 'PUT',
          body: {
            ingredients: lines.map((l) => ({
              productId: l.productId,
              quantityRequired: Number(l.quantityRequired),
            })),
          },
          propertyId,
        }
      );
      showToast(
        'success',
        `Saved recipe for "${res.menuItem.name}" (${res.menuItem.ingredientCount ?? 0} ingredient(s))`
      );
      onSaved(res.menuItem);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'Failed to update menu item recipe'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        menuItem
          ? `Ingredient Recipe — ${menuItem.name} (${menuItem.sku})`
          : 'Menu Item Recipe'
      }
      maxWidthClass="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          Mapped ingredients are deducted automatically per dish quantity when a kitchen order
          transitions from <strong>Pending → Preparing</strong>. If stock is insufficient, prep
          start is blocked cleanly without partial deduction.
        </p>

        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
            Recipe Ingredients per 1 Dish ({lines.length})
          </span>
          <button
            type="button"
            disabled={loadingCatalog || inventoryItems.length === 0}
            onClick={addIngredientLine}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Ingredient
          </button>
        </div>

        {inventoryItems.length === 0 && !loadingCatalog ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            No active inventory items exist in this property yet. Add kitchen ingredients in{' '}
            <Link to="/inventory" className="font-semibold underline">
              Inventory & Stock Control
            </Link>{' '}
            first.
          </div>
        ) : lines.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-xs text-slate-500">
            No recipe ingredients linked (dish can be prepared without inventory stock deduction).
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {lines.map((line, index) => {
              const selectedProd = inventoryItems.find((i) => i.id === line.productId);
              return (
                <div
                  key={line.key}
                  data-testid={`recipe-line-${index}`}
                  className="grid grid-cols-12 gap-2 items-end rounded-xl border border-slate-200 bg-slate-50/70 p-2.5"
                >
                  <div className="col-span-7">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Inventory Ingredient
                    </label>
                    <select
                      aria-label={`Recipe ingredient ${index + 1}`}
                      value={line.productId}
                      onChange={(e) => updateLine(line.key, { productId: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                    >
                      {inventoryItems.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name} ({it.sku}) — {it.currentStock} {it.unit} on hand
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="col-span-4">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Qty per Dish ({selectedProd?.unit ?? 'units'})
                    </label>
                    <input
                      aria-label={`Recipe quantity ${index + 1}`}
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      value={line.quantityRequired}
                      onChange={(e) =>
                        updateLine(line.key, { quantityRequired: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                    />
                  </div>

                  <div className="col-span-1 flex justify-end">
                    <button
                      type="button"
                      aria-label={`Remove recipe ingredient ${index + 1}`}
                      onClick={() => removeLine(line.key)}
                      className="rounded-lg p-1.5 text-slate-400 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

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
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {submitting ? 'Saving Recipe...' : 'Save Recipe'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// 5. Common Per-Hotel Guest Self-Service QR Code Modal
// ============================================================================

export function GuestQrConfigModal({
  open,
  onClose,
  propertyId,
  userRole,
}: {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  userRole: UserRole;
}) {
  const { showToast } = useToast();
  const isAdmin = userRole === 'admin';
  const [config, setConfig] = useState<PropertyQrFoodConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [devUrlInput, setDevUrlInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !propertyId) return;
    setLoading(true);
    setError(null);
    setCopied(false);
    setConfirmRotate(false);

    apiFetch<{ config: PropertyQrFoodConfig }>('/api/restaurant/qr-config', {
      propertyId,
    })
      .then((res) => {
        setConfig(res.config);
        setDevUrlInput(res.config.configuredPublicAppUrl ?? '');
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [open, propertyId]);

  const resolvedMenuUrl = config?.guestMenuUrl ?? '';
  const qrReady = Boolean(config?.qrReady && config.guestMenuUrl && config.qrSvg);
  const activeConfigError =
    !qrReady && config
      ? config.configurationError ??
        config.configurationNotice ??
        'PUBLIC_APP_URL is missing or invalid.'
      : null;

  const urlEnvironmentInfo = (() => {
    if (!config) return null;
    switch (config.urlMode) {
      case 'production':
        return {
          kind: 'production' as const,
          label: 'Stable Production URL',
          note:
            config.configurationNotice ??
            'Configured via PUBLIC_APP_URL — ready for printed in-room QR tent cards.',
          badgeClasses: 'bg-emerald-50 text-emerald-800 border-emerald-200',
        };
      case 'local_lan':
        return {
          kind: 'local_lan' as const,
          label: 'Local Wi-Fi / LAN Demo URL',
          note:
            config.configurationNotice ??
            'Configured via PUBLIC_APP_URL — phones on the same Wi-Fi network can scan this QR code directly.',
          badgeClasses: 'bg-sky-50 text-sky-800 border-sky-200',
        };
      case 'local_dev':
        return {
          kind: 'local_dev' as const,
          label: 'Local Development URL',
          note:
            config.configurationNotice ??
            'Same-machine loopback URL. Set PUBLIC_APP_URL=http://<your-laptop-lan-ip>:3000 in .env to scan from a phone on the same Wi-Fi, or https://<your-public-domain> in production.',
          badgeClasses: 'bg-slate-100 text-slate-700 border-slate-300',
        };
      case 'dev_unconfigured':
        return {
          kind: 'dev_unconfigured' as const,
          label: 'Missing PUBLIC_APP_URL (Development)',
          note:
            config.configurationError ??
            'Set PUBLIC_APP_URL=http://<your-laptop-wifi-ip>:3000 in .env (or apply it below) to generate the QR code.',
          badgeClasses: 'bg-rose-50 text-rose-800 border-rose-200',
        };
      case 'invalid_config':
        return {
          kind: 'invalid_config' as const,
          label: 'Invalid PUBLIC_APP_URL',
          note:
            config.configurationError ??
            'PUBLIC_APP_URL failed validation. Fix PUBLIC_APP_URL to generate the QR code.',
          badgeClasses: 'bg-rose-50 text-rose-800 border-rose-200',
        };
      case 'preview_unconfigured':
        return {
          kind: 'preview_unconfigured' as const,
          label: 'Missing PUBLIC_APP_URL',
          note:
            config.configurationError ??
            config.configurationNotice ??
            'Arena’s private sandbox preview requires a platform traffic token and cannot be scanned by external phones.',
          badgeClasses: 'bg-rose-50 text-rose-800 border-rose-200',
        };
      case 'production_unconfigured':
        return {
          kind: 'production_unconfigured' as const,
          label: 'PUBLIC_APP_URL Required',
          note:
            config.configurationError ??
            config.configurationNotice ??
            'Set PUBLIC_APP_URL=https://<your-public-domain> on your production server.',
          badgeClasses: 'bg-rose-50 text-rose-800 border-rose-200',
        };
    }
  })();

  const hasSeparateLocalBrowserPreview = (() => {
    if (!config || !config.guestMenuUrl || typeof window === 'undefined') {
      return false;
    }
    try {
      return new URL(config.guestMenuUrl).origin !== window.location.origin;
    } catch {
      return false;
    }
  })();

  const svgDataUri =
    qrReady && config?.qrSvg
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(config.qrSvg)}`
      : '';

  const handleCopyUrl = async () => {
    if (!qrReady || !resolvedMenuUrl) return;
    try {
      await navigator.clipboard.writeText(resolvedMenuUrl);
      setCopied(true);
      showToast('info', 'Copied hotel guest QR menu link.');
    } catch {
      // Fallback: user can copy directly from input
    }
  };

  const handleDownloadSvg = () => {
    if (!qrReady || !config?.qrSvg) return;
    const blob = new Blob([config.qrSvg], {
      type: 'image/svg+xml;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${config.propertyCode.toLowerCase()}-guest-food-qr.svg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handlePrintTentCard = () => {
    if (!qrReady) return;
    window.print();
  };

  const handleToggleEnabled = async () => {
    if (!config || !isAdmin) return;
    setBusyAction('toggle');
    setError(null);
    try {
      const res = await apiFetch<{ config: PropertyQrFoodConfig }>(
        '/api/restaurant/qr-config',
        {
          method: 'PUT',
          propertyId,
          body: { enabled: !config.enabled },
        }
      );
      setConfig(res.config);
      showToast(
        'success',
        res.config.enabled
          ? 'Guest QR food ordering enabled.'
          : 'Guest QR food ordering paused.'
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRotateToken = async () => {
    if (!config || !isAdmin) return;
    setBusyAction('rotate');
    setError(null);
    try {
      const res = await apiFetch<{ config: PropertyQrFoodConfig }>(
        '/api/restaurant/qr-config/regenerate',
        {
          method: 'POST',
          propertyId,
        }
      );
      setConfig(res.config);
      setConfirmRotate(false);
      showToast(
        'success',
        'Rotated hotel QR menu link. Remember to reprint room tent cards.'
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleApplyDevBaseUrl = async (
    e: React.FormEvent | null,
    nextUrlValue: string
  ) => {
    if (e) e.preventDefault();
    if (!config || !isAdmin || !config.canConfigureDevUrl) return;
    setBusyAction('dev-url');
    setError(null);
    setCopied(false);
    try {
      const res = await apiFetch<{ config: PropertyQrFoodConfig }>(
        '/api/restaurant/qr-config/dev-base-url',
        {
          method: 'PUT',
          propertyId,
          body: { publicAppUrl: nextUrlValue.trim() },
        }
      );
      setConfig(res.config);
      setDevUrlInput(res.config.configuredPublicAppUrl ?? '');
      showToast(
        'success',
        res.config.qrReady
          ? `Generated Guest QR code using ${res.config.configuredPublicAppUrl}`
          : 'Cleared runtime development PUBLIC_APP_URL override.'
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Hotel Guest Self-Service QR Menu"
      subtitle="One common QR code for all guest rooms in this hotel — no guest login required"
      maxWidthClass="max-w-xl"
    >
      {loading || !config ? (
        <div className="py-10 text-center text-sm text-slate-500">
          {error ? <ErrorAlert message={error} /> : 'Loading hotel QR configuration...'}
        </div>
      ) : (
        <div data-testid="guest-qr-config-modal" className="space-y-5 text-xs">
          {error && (
            <div data-testid="hotel-qr-action-error">
              <ErrorAlert message={error} />
            </div>
          )}
          {activeConfigError && (
            <div
              data-testid={
                config.urlMode === 'production_unconfigured'
                  ? 'hotel-qr-production-missing-alert'
                  : 'hotel-qr-config-error-alert'
              }
            >
              <ErrorAlert message={activeConfigError} />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-5 items-center rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="sm:col-span-5 flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-3 shadow-xs min-h-[224px]">
              {qrReady && svgDataUri ? (
                <>
                  <img
                    src={svgDataUri}
                    alt={`In-room dining QR code for ${config.propertyName}`}
                    data-testid="hotel-qr-svg-img"
                    className="h-44 w-44 object-contain"
                  />
                  <span className="mt-1.5 font-semibold text-slate-800 text-center">
                    {config.propertyName}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    Scan • Enter Room # • Order
                  </span>
                </>
              ) : (
                <div
                  data-testid="hotel-qr-unconfigured-placeholder"
                  className="flex flex-col items-center text-center px-2 py-4 space-y-2"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-50 border border-rose-200 text-rose-700">
                    <AlertTriangle className="h-5 w-5" />
                  </div>
                  <p className="font-bold text-rose-900 text-xs">
                    QR Configuration Error
                  </p>
                  <p className="text-[11px] text-slate-600 leading-relaxed">
                    {activeConfigError}
                  </p>
                </div>
              )}
            </div>

            <div className="sm:col-span-7 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <QrCode className="h-4 w-4 text-indigo-600" />
                <span className="font-bold text-slate-900 text-sm">
                  {config.propertyName} ({config.propertyCode})
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    config.enabled
                      ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                      : 'bg-amber-50 text-amber-800 border border-amber-200'
                  }`}
                >
                  {config.enabled ? 'Ordering Active' : 'Paused'}
                </span>
              </div>

              <p className="text-slate-600 leading-relaxed">
                Print and place this single QR code across rooms at{' '}
                <strong>{config.propertyName}</strong>. Guests scan with their
                phone camera, enter their checked-in room number, and submit
                orders directly to your Kitchen & Dashboard boards.
              </p>

              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    {qrReady ? 'Public Guest Menu Link' : 'Guest Menu Route & Base URL Status'}
                  </label>
                  {urlEnvironmentInfo && (
                    <span
                      data-testid="hotel-qr-url-env"
                      data-url-kind={urlEnvironmentInfo.kind}
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${urlEnvironmentInfo.badgeClasses}`}
                    >
                      {urlEnvironmentInfo.label}
                    </span>
                  )}
                </div>

                {qrReady ? (
                  <>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        readOnly
                        data-testid="hotel-qr-menu-url"
                        value={resolvedMenuUrl}
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-[11px] text-slate-800"
                      />
                      <button
                        type="button"
                        onClick={() => void handleCopyUrl()}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-100"
                      >
                        {copied ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            Copy
                          </>
                        )}
                      </button>
                    </div>
                    {urlEnvironmentInfo && (
                      <p className="text-[11px] text-slate-500">
                        {urlEnvironmentInfo.note}
                      </p>
                    )}
                  </>
                ) : (
                  <div
                    data-testid="hotel-qr-config-required"
                    className="rounded-xl border border-rose-200 bg-rose-50/70 p-3 space-y-2 text-rose-950"
                  >
                    <p className="text-[11px] font-medium leading-relaxed">
                      {activeConfigError}
                    </p>
                    <p className="text-[11px] text-slate-700">
                      Existing guest menu route:{' '}
                      <code
                        data-testid="hotel-qr-route-path"
                        className="font-mono font-semibold text-slate-900"
                      >
                        {config.guestMenuPath}
                      </code>
                    </p>
                  </div>
                )}

                {isAdmin && config.canConfigureDevUrl && (
                  <form
                    data-testid="hotel-qr-dev-url-form"
                    onSubmit={(e) => void handleApplyDevBaseUrl(e, devUrlInput)}
                    className="mt-2 rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 space-y-2"
                  >
                    <label
                      htmlFor="hotel-qr-dev-url-input"
                      className="block text-[11px] font-bold text-indigo-950"
                    >
                      Development Base URL (PUBLIC_APP_URL)
                    </label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input
                        id="hotel-qr-dev-url-input"
                        data-testid="hotel-qr-dev-url-input"
                        type="text"
                        value={devUrlInput}
                        onChange={(e) => setDevUrlInput(e.target.value)}
                        placeholder="http://<your-laptop-wifi-ip>:3000"
                        className="flex-1 min-w-[190px] rounded-lg border border-indigo-300 bg-white px-2.5 py-1.5 font-mono text-[11px] text-slate-900"
                      />
                      <button
                        type="submit"
                        data-testid="hotel-qr-dev-url-apply-btn"
                        disabled={busyAction !== null || !devUrlInput.trim()}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {busyAction === 'dev-url' ? 'Generating...' : 'Generate QR'}
                      </button>
                      {config.configuredPublicAppUrl && (
                        <button
                          type="button"
                          data-testid="hotel-qr-dev-url-clear-btn"
                          disabled={busyAction !== null}
                          onClick={() => void handleApplyDevBaseUrl(null, '')}
                          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-indigo-900 leading-relaxed">
                      Enter your laptop’s Wi-Fi LAN origin (or set{' '}
                      <code className="font-mono font-semibold">PUBLIC_APP_URL</code>{' '}
                      in <code className="font-mono">.env</code>) to render the QR for{' '}
                      <code className="font-mono">{config.guestMenuPath}</code>.
                    </p>
                  </form>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <a
                  href={qrReady ? resolvedMenuUrl : config.guestMenuPath}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="hotel-qr-open-preview-link"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-700"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {qrReady ? 'Open Guest Menu' : 'Open Guest Menu (Browser Preview)'}
                </a>
                {qrReady && hasSeparateLocalBrowserPreview && (
                  <a
                    href={config.guestMenuPath}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="hotel-qr-local-preview-link"
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Browser Preview
                  </a>
                )}
                <button
                  type="button"
                  disabled={!qrReady}
                  onClick={handleDownloadSvg}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download SVG
                </button>
                <button
                  type="button"
                  disabled={!qrReady}
                  onClick={handlePrintTentCard}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Print
                </button>
              </div>
            </div>
          </div>

          {isAdmin && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-bold text-slate-900">
                    Administrator QR Controls
                  </p>
                  <p className="text-slate-500 mt-0.5">
                    Temporarily pause self-service QR ordering during kitchen
                    closures, or rotate the QR link if printed cards are retired.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="hotel-qr-toggle-btn"
                    disabled={busyAction !== null}
                    onClick={() => void handleToggleEnabled()}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {config.enabled
                      ? 'Pause QR Ordering'
                      : 'Enable QR Ordering'}
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => setConfirmRotate((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Rotate QR Link
                  </button>
                </div>
              </div>

              {confirmRotate && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-amber-950 font-medium">
                    Rotating replaces the hotel QR link immediately — previously
                    printed QR cards will stop working until reprinted.
                  </p>
                  <button
                    type="button"
                    data-testid="hotel-qr-confirm-rotate-btn"
                    disabled={busyAction !== null}
                    onClick={() => void handleRotateToken()}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    {busyAction === 'rotate'
                      ? 'Rotating...'
                      : 'Confirm Rotate Link'}
                  </button>
                </div>
              )}
            </div>
          )}

          {qrReady &&
            typeof document !== 'undefined' &&
            createPortal(
              <div
                id="hotel-qr-print-card"
                data-testid="hotel-qr-print-card"
                className="hidden flex-col items-center justify-center rounded-3xl border-2 border-slate-900 bg-white p-10 text-center text-slate-900 mx-auto max-w-md"
              >
                <p className="text-xs font-bold uppercase tracking-widest text-indigo-700">
                  In-Room Self-Service Dining
                </p>
                <h2 className="mt-1 text-2xl font-bold text-slate-900">
                  {config.propertyName}
                </h2>
                {svgDataUri && (
                  <img
                    src={svgDataUri}
                    alt={`Printable QR menu for ${config.propertyName}`}
                    data-testid="hotel-qr-print-svg-img"
                    className="my-6 h-64 w-64 object-contain"
                  />
                )}
                <p className="text-sm font-semibold text-slate-800">
                  Scan with your phone camera • Enter your Room Number • Place order
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  No login required • Pay at hotel or post to your room folio
                </p>
                <p
                  data-testid="hotel-qr-print-url"
                  className="mt-4 break-all font-mono text-[11px] text-slate-700"
                >
                  {resolvedMenuUrl}
                </p>
              </div>,
              document.body
            )}
        </div>
      )}
    </Modal>
  );
}


