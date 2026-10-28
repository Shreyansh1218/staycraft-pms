import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  INVENTORY_UNITS,
  INVENTORY_UNIT_LABELS,
  STOCK_ADJUSTMENT_OPERATIONS,
  STOCK_ADJUSTMENT_OPERATION_LABELS,
  type InventoryUnit,
  type StockAdjustmentOperation,
} from '@shared/constants';
import { formatMoney, roundCurrency } from '@shared/pricing';
import type {
  InventoryCategory,
  InventoryItem,
  InventoryReceipt,
  StockMovementRecord,
  Supplier,
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

// ============================================================================
// 1. Inventory Category Create / Edit Modal (Admin)
// ============================================================================

interface InventoryCategoryModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  editingCategory: InventoryCategory | null;
  onSaved: (category: InventoryCategory) => void;
}

export function InventoryCategoryModal({
  open,
  onClose,
  propertyId,
  editingCategory,
  onSaved,
}: InventoryCategoryModalProps) {
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
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description: description.trim(),
        displayOrder: Number(displayOrder || 0),
        isActive,
      };
      const res = editingCategory
        ? await apiFetch<{ category: InventoryCategory }>(
            `/api/inventory/categories/${editingCategory.id}`,
            { method: 'PUT', body: payload, propertyId }
          )
        : await apiFetch<{ category: InventoryCategory }>('/api/inventory/categories', {
            method: 'POST',
            body: payload,
            propertyId,
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
      setError(
        err instanceof ApiClientError ? err.message : 'Failed to save inventory category'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingCategory ? `Edit Category — ${editingCategory.name}` : 'New Inventory Category'}
      maxWidthClass="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="inv-cat-code" className="block text-xs font-semibold text-slate-700 mb-1">
              Code *
            </label>
            <input
              id="inv-cat-code"
              type="text"
              required
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="PANTRY"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="inv-cat-name" className="block text-xs font-semibold text-slate-700 mb-1">
              Category Name *
            </label>
            <input
              id="inv-cat-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Kitchen Pantry & Dry Goods"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label htmlFor="inv-cat-desc" className="block text-xs font-semibold text-slate-700 mb-1">
            Description
          </label>
          <input
            id="inv-cat-desc"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Grains, dairy, cooking oils, spices..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 items-center">
          <div>
            <label htmlFor="inv-cat-order" className="block text-xs font-semibold text-slate-700 mb-1">
              Display Order
            </label>
            <input
              id="inv-cat-order"
              type="number"
              min="0"
              max="9999"
              value={displayOrder}
              onChange={(e) => setDisplayOrder(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <label className="mt-5 inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600"
            />
            Active Category
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
// 2. Inventory Item Create / Edit Modal (Admin)
// ============================================================================

interface InventoryItemModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  currency: string;
  categories: InventoryCategory[];
  suppliers: Supplier[];
  editingItem: InventoryItem | null;
  onSaved: (item: InventoryItem) => void;
}

export function InventoryItemModal({
  open,
  onClose,
  propertyId,
  currency,
  categories,
  suppliers,
  editingItem,
  onSaved,
}: InventoryItemModalProps) {
  const { showToast } = useToast();
  const activeCategories = useMemo(
    () =>
      categories.filter(
        (c) => c.isActive || (editingItem && c.id === editingItem.categoryId)
      ),
    [categories, editingItem]
  );
  const activeSuppliers = useMemo(
    () =>
      suppliers.filter(
        (s) => s.isActive || (editingItem && s.id === editingItem.supplierId)
      ),
    [suppliers, editingItem]
  );

  const [categoryId, setCategoryId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState<InventoryUnit>('pcs');
  const [openingStock, setOpeningStock] = useState('0');
  const [reorderLevel, setReorderLevel] = useState('5');
  const [unitCost, setUnitCost] = useState('0');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editingItem) {
      setCategoryId(editingItem.categoryId ?? activeCategories[0]?.id ?? '');
      setSupplierId(editingItem.supplierId ?? '');
      setSku(editingItem.sku);
      setName(editingItem.name);
      setDescription(editingItem.description);
      setUnit((editingItem.unit as InventoryUnit) || 'pcs');
      setOpeningStock(String(editingItem.currentStock));
      setReorderLevel(String(editingItem.reorderLevel));
      setUnitCost(editingItem.unitCost.toFixed(2));
      setIsActive(editingItem.isActive);
    } else {
      setCategoryId(activeCategories[0]?.id ?? '');
      setSupplierId('');
      setSku('');
      setName('');
      setDescription('');
      setUnit('pcs');
      setOpeningStock('0');
      setReorderLevel('5');
      setUnitCost('0.00');
      setIsActive(true);
    }
  }, [open, editingItem, activeCategories]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (editingItem) {
        const res = await apiFetch<{ item: InventoryItem }>(
          `/api/inventory/items/${editingItem.id}`,
          {
            method: 'PUT',
            body: {
              categoryId,
              supplierId: supplierId || null,
              sku: sku.trim().toUpperCase(),
              name: name.trim(),
              description: description.trim(),
              unit,
              reorderLevel: Number(reorderLevel || 0),
              unitCost: Number(unitCost || 0),
              isActive,
            },
            propertyId,
          }
        );
        showToast('success', `Updated item "${res.item.name}"`);
        onSaved(res.item);
      } else {
        const res = await apiFetch<{ item: InventoryItem }>('/api/inventory/items', {
          method: 'POST',
          body: {
            categoryId,
            supplierId: supplierId || null,
            sku: sku.trim().toUpperCase(),
            name: name.trim(),
            description: description.trim(),
            unit,
            openingStock: Number(openingStock || 0),
            reorderLevel: Number(reorderLevel || 0),
            unitCost: Number(unitCost || 0),
            isActive,
          },
          propertyId,
        });
        showToast('success', `Created item "${res.item.name}" (${res.item.sku})`);
        onSaved(res.item);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save inventory item');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingItem ? `Edit Inventory Item — ${editingItem.name}` : 'New Inventory Item'}
      maxWidthClass="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="inv-sku" className="block text-xs font-semibold text-slate-700 mb-1">
              SKU *
            </label>
            <input
              id="inv-sku"
              type="text"
              required
              value={sku}
              onChange={(e) => setSku(e.target.value.toUpperCase())}
              placeholder="ING-PANEER"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="inv-name" className="block text-xs font-semibold text-slate-700 mb-1">
              Item Name *
            </label>
            <input
              id="inv-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Fresh Malai Paneer"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="inv-category" className="block text-xs font-semibold text-slate-700 mb-1">
              Category *
            </label>
            <select
              id="inv-category"
              required
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Select category...</option>
              {activeCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="inv-supplier" className="block text-xs font-semibold text-slate-700 mb-1">
              Preferred Supplier (Optional)
            </label>
            <select
              id="inv-supplier"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">No supplier linked</option>
              {activeSuppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {!s.isActive ? ' (Inactive)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label htmlFor="inv-unit" className="block text-xs font-semibold text-slate-700 mb-1">
              Unit of Measure *
            </label>
            <select
              id="inv-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value as InventoryUnit)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {INVENTORY_UNITS.map((u) => (
                <option key={u} value={u}>
                  {INVENTORY_UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          </div>

          {!editingItem ? (
            <div>
              <label
                htmlFor="inv-opening-stock"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Opening Stock
              </label>
              <input
                id="inv-opening-stock"
                type="number"
                step="0.01"
                min="0"
                value={openingStock}
                onChange={(e) => setOpeningStock(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                Current Stock
              </label>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700">
                {editingItem.currentStock} {editingItem.unit}
              </div>
            </div>
          )}

          <div>
            <label htmlFor="inv-reorder" className="block text-xs font-semibold text-slate-700 mb-1">
              Reorder Threshold
            </label>
            <input
              id="inv-reorder"
              type="number"
              step="0.01"
              min="0"
              value={reorderLevel}
              onChange={(e) => setReorderLevel(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="inv-cost" className="block text-xs font-semibold text-slate-700 mb-1">
              Unit Cost ({currency})
            </label>
            <input
              id="inv-cost"
              type="number"
              step="0.01"
              min="0"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label htmlFor="inv-desc" className="block text-xs font-semibold text-slate-700 mb-1">
            Description / Storage Notes
          </label>
          <input
            id="inv-desc"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Chilled storage 2–4°C..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        {editingItem && (
          <p className="text-[11px] text-slate-500">
            Note: Stock quantities are updated strictly via Purchase Receipts, Controlled Stock
            Adjustments, or Kitchen Order Consumption so the movement ledger remains 100% auditable.
          </p>
        )}

        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs">
          <label className="inline-flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600"
            />
            Active Inventory Item
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
            disabled={submitting || activeCategories.length === 0}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? 'Saving...' : editingItem ? 'Save Item' : 'Create Item'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// 3. Purchase / Stock Receipt Modal (Transactional + Idempotency-Protected)
// ============================================================================

interface StockReceiptModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  currency: string;
  defaultDate: string;
  items: InventoryItem[];
  suppliers: Supplier[];
  preselectedItemId?: string | null;
  onSaved: (receipt: InventoryReceipt) => void;
}

interface ReceiptDraftLine {
  key: string;
  productId: string;
  quantity: string;
  unitCost: string;
}

export function StockReceiptModal({
  open,
  onClose,
  propertyId,
  currency,
  defaultDate,
  items,
  suppliers,
  preselectedItemId,
  onSaved,
}: StockReceiptModalProps) {
  const { showToast } = useToast();
  const activeItems = useMemo(() => items.filter((i) => i.isActive), [items]);
  const activeSuppliers = useMemo(() => suppliers.filter((s) => s.isActive), [suppliers]);

  const [supplierId, setSupplierId] = useState('');
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = useState('');
  const [receiptDate, setReceiptDate] = useState(defaultDate);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<ReceiptDraftLine[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => makeIdempotencyKey('rcv'));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setIdempotencyKey(makeIdempotencyKey('rcv'));
    setVendorInvoiceNumber('');
    setReceiptDate(defaultDate);
    setNotes('');

    const initialItem =
      activeItems.find((i) => i.id === preselectedItemId) ?? activeItems[0];

    setSupplierId(initialItem?.supplierId ?? '');
    if (initialItem) {
      setLines([
        {
          key: 'line-1',
          productId: initialItem.id,
          quantity: '10',
          unitCost: initialItem.unitCost.toFixed(2),
        },
      ]);
    } else {
      setLines([]);
    }
  }, [open, activeItems, preselectedItemId, defaultDate]);

  // Reset idempotency key only when form values intentionally change
  const bumpIdempotencyOnChange = () => {
    setIdempotencyKey(makeIdempotencyKey('rcv'));
  };

  const addLine = () => {
    const fallback = activeItems[0];
    if (!fallback) return;
    bumpIdempotencyOnChange();
    setLines((prev) => [
      ...prev,
      {
        key: `line-${Date.now()}-${prev.length}`,
        productId: fallback.id,
        quantity: '1',
        unitCost: fallback.unitCost.toFixed(2),
      },
    ]);
  };

  const updateLine = (key: string, patch: Partial<ReceiptDraftLine>) => {
    bumpIdempotencyOnChange();
    setLines((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l;
        const updated = { ...l, ...patch };
        if (patch.productId && patch.productId !== l.productId) {
          const found = activeItems.find((i) => i.id === patch.productId);
          if (found) {
            updated.unitCost = found.unitCost.toFixed(2);
          }
        }
        return updated;
      })
    );
  };

  const removeLine = (key: string) => {
    bumpIdempotencyOnChange();
    setLines((prev) => prev.filter((l) => l.key !== key));
  };

  const totalPreview = useMemo(() => {
    return roundCurrency(
      lines.reduce((sum, l) => {
        const q = Number(l.quantity);
        const c = Number(l.unitCost);
        if (!Number.isFinite(q) || !Number.isFinite(c) || q <= 0 || c < 0) return sum;
        return sum + roundCurrency(q * c);
      }, 0)
    );
  }, [lines]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ receipt: InventoryReceipt }>('/api/inventory/receipts', {
        method: 'POST',
        body: {
          supplierId: supplierId || null,
          vendorInvoiceNumber: vendorInvoiceNumber.trim(),
          receiptDate: receiptDate || null,
          notes: notes.trim(),
          idempotencyKey,
          items: lines.map((l) => ({
            productId: l.productId,
            quantity: Number(l.quantity),
            unitCost: Number(l.unitCost || 0),
          })),
        },
        propertyId,
      });

      showToast(
        'success',
        `Recorded stock receipt ${res.receipt.receiptNumber} (+${res.receipt.lineCount} item line(s))`
      );
      onSaved(res.receipt);
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to record stock receipt');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record Purchase / Stock Receipt"
      maxWidthClass="max-w-2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="rcv-supplier" className="block text-xs font-semibold text-slate-700 mb-1">
              Supplier (Optional)
            </label>
            <select
              id="rcv-supplier"
              value={supplierId}
              onChange={(e) => {
                bumpIdempotencyOnChange();
                setSupplierId(e.target.value);
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Direct / Unassigned Vendor</option>
              {activeSuppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="rcv-inv" className="block text-xs font-semibold text-slate-700 mb-1">
              Vendor Invoice / Challan #
            </label>
            <input
              id="rcv-inv"
              type="text"
              value={vendorInvoiceNumber}
              onChange={(e) => {
                bumpIdempotencyOnChange();
                setVendorInvoiceNumber(e.target.value);
              }}
              placeholder="INV-2026-884"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="rcv-date" className="block text-xs font-semibold text-slate-700 mb-1">
              Receipt Date *
            </label>
            <input
              id="rcv-date"
              type="date"
              required
              value={receiptDate}
              onChange={(e) => {
                bumpIdempotencyOnChange();
                setReceiptDate(e.target.value);
              }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        {/* Line Items */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
              Received Items ({lines.length})
            </span>
            <button
              type="button"
              disabled={activeItems.length === 0}
              onClick={addLine}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Item Line
            </button>
          </div>

          {activeItems.length === 0 ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              No active inventory items exist yet. Ask an Administrator to create inventory items
              before recording receipts.
            </p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {lines.map((line, index) => {
                const selectedProd = activeItems.find((i) => i.id === line.productId);
                return (
                  <div
                    key={line.key}
                    data-testid={`receipt-line-${index}`}
                    className="grid grid-cols-12 gap-2 items-end rounded-xl border border-slate-200 bg-slate-50/70 p-2.5"
                  >
                    <div className="col-span-12 sm:col-span-6">
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Inventory Item
                      </label>
                      <select
                        aria-label={`Receipt item ${index + 1}`}
                        value={line.productId}
                        onChange={(e) => updateLine(line.key, { productId: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                      >
                        {activeItems.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name} ({it.sku}) — {it.currentStock} {it.unit} on hand
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="col-span-5 sm:col-span-3">
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Qty ({selectedProd?.unit ?? 'units'})
                      </label>
                      <input
                        aria-label={`Receipt quantity ${index + 1}`}
                        type="number"
                        step="0.01"
                        min="0.01"
                        required
                        value={line.quantity}
                        onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                      />
                    </div>

                    <div className="col-span-5 sm:col-span-2">
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Unit Cost
                      </label>
                      <input
                        aria-label={`Receipt unit cost ${index + 1}`}
                        type="number"
                        step="0.01"
                        min="0"
                        value={line.unitCost}
                        onChange={(e) => updateLine(line.key, { unitCost: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                      />
                    </div>

                    <div className="col-span-2 sm:col-span-1 flex justify-end">
                      <button
                        type="button"
                        disabled={lines.length <= 1}
                        aria-label={`Remove line ${index + 1}`}
                        onClick={() => removeLine(line.key)}
                        className="rounded-lg p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <label htmlFor="rcv-notes" className="block text-xs font-semibold text-slate-700 mb-1">
            Receiving Notes
          </label>
          <input
            id="rcv-notes"
            type="text"
            value={notes}
            onChange={(e) => {
              bumpIdempotencyOnChange();
              setNotes(e.target.value);
            }}
            placeholder="Checked cold-chain temperature on arrival..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs">
          <span className="font-semibold text-slate-600">Estimated Receipt Value</span>
          <span className="text-sm font-bold text-emerald-700">
            {formatMoney(totalPreview, currency)}
          </span>
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
            disabled={submitting || lines.length === 0}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? 'Recording Receipt...' : 'Post Stock Receipt'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// 4. Controlled Stock Adjustment Modal (Admin Only)
// ============================================================================

interface StockAdjustmentModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  items: InventoryItem[];
  preselectedItemId?: string | null;
  onSaved: (movement: StockMovementRecord, item: InventoryItem) => void;
}

export function StockAdjustmentModal({
  open,
  onClose,
  propertyId,
  items,
  preselectedItemId,
  onSaved,
}: StockAdjustmentModalProps) {
  const { showToast } = useToast();
  const activeItems = useMemo(() => items.filter((i) => i.isActive), [items]);

  const [productId, setProductId] = useState('');
  const [operation, setOperation] = useState<StockAdjustmentOperation>('decrease');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [referenceNote, setReferenceNote] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => makeIdempotencyKey('adj'));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setIdempotencyKey(makeIdempotencyKey('adj'));
    const initial =
      activeItems.find((i) => i.id === preselectedItemId) ?? activeItems[0];
    setProductId(initial?.id ?? '');
    setOperation('decrease');
    setQuantity('1');
    setReason('');
    setReferenceNote('');
  }, [open, activeItems, preselectedItemId]);

  const selectedItem = activeItems.find((i) => i.id === productId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ movement: StockMovementRecord; item: InventoryItem }>(
        '/api/inventory/adjustments',
        {
          method: 'POST',
          body: {
            productId,
            operation,
            quantity: Number(quantity),
            reason: reason.trim(),
            referenceNote: referenceNote.trim(),
            idempotencyKey,
          },
          propertyId,
        }
      );

      showToast(
        'success',
        `Adjusted "${res.item.name}" stock: ${res.movement.stockBefore} → ${res.movement.stockAfter} ${res.item.unit}`
      );
      onSaved(res.movement, res.item);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'Failed to record stock adjustment'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Controlled Stock Adjustment"
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div>
          <label htmlFor="adj-item" className="block text-xs font-semibold text-slate-700 mb-1">
            Inventory Item *
          </label>
          <select
            id="adj-item"
            required
            value={productId}
            onChange={(e) => {
              setIdempotencyKey(makeIdempotencyKey('adj'));
              setProductId(e.target.value);
            }}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {activeItems.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name} ({it.sku}) — Available: {it.currentStock} {it.unit}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="adj-op" className="block text-xs font-semibold text-slate-700 mb-1">
              Adjustment Type *
            </label>
            <select
              id="adj-op"
              value={operation}
              onChange={(e) => {
                setIdempotencyKey(makeIdempotencyKey('adj'));
                setOperation(e.target.value as StockAdjustmentOperation);
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {STOCK_ADJUSTMENT_OPERATIONS.map((op) => (
                <option key={op} value={op}>
                  {STOCK_ADJUSTMENT_OPERATION_LABELS[op]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="adj-qty" className="block text-xs font-semibold text-slate-700 mb-1">
              Quantity ({selectedItem?.unit ?? 'units'}) *
            </label>
            <input
              id="adj-qty"
              type="number"
              step="0.01"
              min="0.01"
              required
              value={quantity}
              onChange={(e) => {
                setIdempotencyKey(makeIdempotencyKey('adj'));
                setQuantity(e.target.value);
              }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold"
            />
          </div>
        </div>

        <div>
          <label htmlFor="adj-reason" className="block text-xs font-semibold text-slate-700 mb-1">
            Audit Reason (Required) *
          </label>
          <input
            id="adj-reason"
            type="text"
            required
            minLength={3}
            value={reason}
            onChange={(e) => {
              setIdempotencyKey(makeIdempotencyKey('adj'));
              setReason(e.target.value);
            }}
            placeholder="e.g., Physical cycle count reconciliation / Kitchen dairy spoilage"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="adj-ref" className="block text-xs font-semibold text-slate-700 mb-1">
            Reference Note (Optional)
          </label>
          <input
            id="adj-ref"
            type="text"
            value={referenceNote}
            onChange={(e) => {
              setIdempotencyKey(makeIdempotencyKey('adj'));
              setReferenceNote(e.target.value);
            }}
            placeholder="Room 204 linen refresh / Cycle count sheet #12"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600">
          Every adjustment records an immutable stock movement entry with before/after quantities,
          staff attribution, and timestamp. Stock cannot be reduced below zero.
        </p>

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
            disabled={submitting || !productId}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? 'Recording...' : 'Record Adjustment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// 5. Stock Receipt Detail Modal
// ============================================================================

interface StockReceiptDetailModalProps {
  open: boolean;
  onClose: () => void;
  receipt: InventoryReceipt | null;
}

export function StockReceiptDetailModal({
  open,
  onClose,
  receipt,
}: StockReceiptDetailModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={receipt ? `Stock Receipt ${receipt.receiptNumber}` : 'Stock Receipt'}
      maxWidthClass="max-w-xl"
    >
      {receipt && (
        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
            <div>
              <div className="text-slate-500">Supplier</div>
              <div className="font-bold text-slate-900 mt-0.5">
                {receipt.supplierName || 'Direct / Unassigned'}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Receipt Date</div>
              <div className="font-bold text-slate-900 mt-0.5">{receipt.receiptDate}</div>
            </div>
            <div>
              <div className="text-slate-500">Vendor Invoice / Ref</div>
              <div className="font-mono font-semibold text-slate-800 mt-0.5">
                {receipt.vendorInvoiceNumber || '—'}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Received By</div>
              <div className="font-semibold text-slate-800 mt-0.5">
                {receipt.receivedByName || 'Staff'} •{' '}
                {new Date(receipt.receivedAt).toLocaleString()}
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Item</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Unit Cost</th>
                  <th className="px-3 py-2 text-right">Line Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {receipt.items.map((line) => (
                  <tr key={line.id}>
                    <td className="px-3 py-2">
                      <div className="font-bold text-slate-900">{line.productNameSnapshot}</div>
                      <div className="font-mono text-[11px] text-slate-500">{line.skuSnapshot}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-800">
                      +{line.quantity} {line.unitSnapshot}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-600">
                      {formatMoney(line.unitCost, receipt.currency)}
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-slate-900">
                      {formatMoney(line.lineTotal, receipt.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {receipt.notes && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-slate-700">
              <strong>Notes:</strong> {receipt.notes}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-slate-200 pt-3">
            <span className="font-bold text-slate-700">Total Receipt Value</span>
            <span className="text-base font-bold text-emerald-700">
              {formatMoney(receipt.totalAmount, receipt.currency)}
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}
