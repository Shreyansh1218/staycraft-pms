import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  ClipboardList,
  Eye,
  FolderKanban,
  History,
  Package,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Truck,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import {
  STOCK_MOVEMENT_SOURCES,
  STOCK_MOVEMENT_SOURCE_LABELS,
  STOCK_MOVEMENT_TYPES,
  STOCK_MOVEMENT_TYPE_LABELS,
} from '@shared/constants';
import { getPropertyLocalDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type {
  InventoryCategory,
  InventoryItem,
  InventoryReceipt,
  InventoryReceiptsListResponse,
  InventorySummaryMetrics,
  StockMovementsReportResponse,
  Supplier,
} from '@shared/types';
import {
  InventoryCategoryModal,
  InventoryItemModal,
  StockAdjustmentModal,
  StockReceiptDetailModal,
  StockReceiptModal,
} from '../components/inventory/InventoryModals';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import {
  InventoryStockStatusBadge,
  StockMovementSourceBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiFetch } from '../lib/api';

type InventoryTab = 'items' | 'receipts' | 'movements' | 'categories';

export function InventoryPage() {
  const { user, selectedProperty } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const isAdmin = user?.role === 'admin';

  const rawTab = searchParams.get('tab') as InventoryTab | null;
  const activeTab: InventoryTab =
    rawTab && ['items', 'receipts', 'movements', 'categories'].includes(rawTab)
      ? rawTab
      : 'items';

  const setActiveTab = (tab: InventoryTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  // Master & KPI state
  const [summary, setSummary] = useState<InventorySummaryMetrics | null>(null);
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [allCatalogItems, setAllCatalogItems] = useState<InventoryItem[]>([]);

  // Items tab filters & state
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemSearch, setItemSearch] = useState('');
  const [itemCategoryFilter, setItemCategoryFilter] = useState('');
  const [itemSupplierFilter, setItemSupplierFilter] = useState(
    () => searchParams.get('supplierId') ?? ''
  );
  const [itemStockFilter, setItemStockFilter] = useState(
    () => searchParams.get('stockFilter') ?? 'all'
  );
  const [showInactiveItems, setShowInactiveItems] = useState(false);

  // Receipts tab filters & state
  const [receiptsData, setReceiptsData] = useState<InventoryReceiptsListResponse | null>(null);
  const [receiptsLoading, setReceiptsLoading] = useState(false);
  const [receiptSearch, setReceiptSearch] = useState('');
  const [receiptSupplierFilter, setReceiptSupplierFilter] = useState('');
  const [receiptDateFrom, setReceiptDateFrom] = useState('');
  const [receiptDateTo, setReceiptDateTo] = useState('');

  // Movements report tab filters & state
  const [movementsData, setMovementsData] = useState<StockMovementsReportResponse | null>(null);
  const [movementsLoading, setMovementsLoading] = useState(false);
  const [movProductFilter, setMovProductFilter] = useState(
    () => searchParams.get('productId') ?? ''
  );
  const [movCategoryFilter, setMovCategoryFilter] = useState('');
  const [movTypeFilter, setMovTypeFilter] = useState('');
  const [movSourceFilter, setMovSourceFilter] = useState('');
  const [movDateFrom, setMovDateFrom] = useState('');
  const [movDateTo, setMovDateTo] = useState('');
  const [movSearch, setMovSearch] = useState('');

  const [error, setError] = useState<string | null>(null);

  // Modals state
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<InventoryCategory | null>(null);

  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);

  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [preselectedReceiptItemId, setPreselectedReceiptItemId] = useState<string | null>(
    null
  );
  const [viewingReceipt, setViewingReceipt] = useState<InventoryReceipt | null>(null);

  const [adjustmentModalOpen, setAdjustmentModalOpen] = useState(false);
  const [preselectedAdjustItemId, setPreselectedAdjustItemId] = useState<string | null>(
    null
  );

  // Sync URL query params when navigated from notifications or Suppliers page
  useEffect(() => {
    const sf = searchParams.get('stockFilter');
    if (sf && sf !== itemStockFilter) {
      setItemStockFilter(sf);
    }
    const sup = searchParams.get('supplierId');
    if (sup && sup !== itemSupplierFilter) {
      setItemSupplierFilter(sup);
    }
  }, [searchParams, itemStockFilter, itemSupplierFilter]);

  const loadMasterData = useCallback(async () => {
    if (!selectedProperty) return;
    try {
      const [sumRes, catRes, supRes, catItemsRes] = await Promise.all([
        apiFetch<{ summary: InventorySummaryMetrics }>('/api/inventory/summary', {
          propertyId: selectedProperty.id,
        }),
        apiFetch<{ items: InventoryCategory[] }>(
          '/api/inventory/categories?includeInactive=true',
          { propertyId: selectedProperty.id }
        ),
        apiFetch<{ items: Supplier[] }>('/api/suppliers?includeInactive=true', {
          propertyId: selectedProperty.id,
        }),
        apiFetch<{ items: InventoryItem[] }>(
          '/api/inventory/items?includeInactive=true',
          { propertyId: selectedProperty.id }
        ),
      ]);
      setSummary(sumRes.summary);
      setCategories(catRes.items);
      setSuppliers(supRes.items);
      setAllCatalogItems(catItemsRes.items);
    } catch (err) {
      setError((err as Error).message || 'Failed to load inventory overview');
    }
  }, [selectedProperty]);

  const loadFilteredItems = useCallback(async () => {
    if (!selectedProperty) return;
    setItemsLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (itemCategoryFilter) qs.set('categoryId', itemCategoryFilter);
      if (itemSupplierFilter) qs.set('supplierId', itemSupplierFilter);
      if (itemStockFilter && itemStockFilter !== 'all') qs.set('stockFilter', itemStockFilter);
      if (showInactiveItems) qs.set('includeInactive', 'true');
      if (itemSearch.trim()) qs.set('search', itemSearch.trim());

      const res = await apiFetch<{ items: InventoryItem[] }>(
        `/api/inventory/items?${qs.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setItems(res.items);
    } catch (err) {
      setError((err as Error).message || 'Failed to load inventory items');
    } finally {
      setItemsLoading(false);
    }
  }, [
    selectedProperty,
    itemCategoryFilter,
    itemSupplierFilter,
    itemStockFilter,
    showInactiveItems,
    itemSearch,
  ]);

  const loadReceipts = useCallback(async () => {
    if (!selectedProperty) return;
    setReceiptsLoading(true);
    try {
      const qs = new URLSearchParams();
      if (receiptSupplierFilter) qs.set('supplierId', receiptSupplierFilter);
      if (receiptDateFrom) qs.set('dateFrom', receiptDateFrom);
      if (receiptDateTo) qs.set('dateTo', receiptDateTo);
      if (receiptSearch.trim()) qs.set('search', receiptSearch.trim());
      qs.set('pageSize', '50');

      const res = await apiFetch<InventoryReceiptsListResponse>(
        `/api/inventory/receipts?${qs.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setReceiptsData(res);
    } catch (err) {
      setError((err as Error).message || 'Failed to load stock receipts');
    } finally {
      setReceiptsLoading(false);
    }
  }, [
    selectedProperty,
    receiptSupplierFilter,
    receiptDateFrom,
    receiptDateTo,
    receiptSearch,
  ]);

  const loadMovements = useCallback(async () => {
    if (!selectedProperty) return;
    setMovementsLoading(true);
    try {
      const qs = new URLSearchParams();
      if (movProductFilter) qs.set('productId', movProductFilter);
      if (movCategoryFilter) qs.set('categoryId', movCategoryFilter);
      if (movTypeFilter) qs.set('movementType', movTypeFilter);
      if (movSourceFilter) qs.set('movementSource', movSourceFilter);
      if (movDateFrom) qs.set('dateFrom', movDateFrom);
      if (movDateTo) qs.set('dateTo', movDateTo);
      if (movSearch.trim()) qs.set('search', movSearch.trim());
      qs.set('pageSize', '50');

      const res = await apiFetch<StockMovementsReportResponse>(
        `/api/inventory/movements?${qs.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setMovementsData(res);
    } catch (err) {
      setError((err as Error).message || 'Failed to load inventory movement report');
    } finally {
      setMovementsLoading(false);
    }
  }, [
    selectedProperty,
    movProductFilter,
    movCategoryFilter,
    movTypeFilter,
    movSourceFilter,
    movDateFrom,
    movDateTo,
    movSearch,
  ]);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      loadMasterData(),
      loadFilteredItems(),
      loadReceipts(),
      loadMovements(),
    ]);
  }, [loadMasterData, loadFilteredItems, loadReceipts, loadMovements]);

  useEffect(() => {
    void loadMasterData();
  }, [loadMasterData]);

  useEffect(() => {
    void loadFilteredItems();
  }, [loadFilteredItems]);

  useEffect(() => {
    if (activeTab === 'receipts') {
      void loadReceipts();
    }
  }, [activeTab, loadReceipts]);

  useEffect(() => {
    if (activeTab === 'movements') {
      void loadMovements();
    }
  }, [activeTab, loadMovements]);

  const handleToggleItemActive = async (item: InventoryItem) => {
    if (!selectedProperty) return;
    try {
      await apiFetch(`/api/inventory/items/${item.id}`, {
        method: 'PUT',
        body: { isActive: !item.isActive },
        propertyId: selectedProperty.id,
      });
      showToast(
        'success',
        `${item.isActive ? 'Deactivated' : 'Activated'} item "${item.name}"`
      );
      void refreshAll();
    } catch (err) {
      showToast('error', (err as Error).message || 'Failed to update item status');
    }
  };

  const handleToggleCategoryActive = async (cat: InventoryCategory) => {
    if (!selectedProperty) return;
    try {
      await apiFetch(`/api/inventory/categories/${cat.id}`, {
        method: 'PUT',
        body: { isActive: !cat.isActive },
        propertyId: selectedProperty.id,
      });
      showToast(
        'success',
        `${cat.isActive ? 'Deactivated' : 'Activated'} category "${cat.name}"`
      );
      void refreshAll();
    } catch (err) {
      showToast('error', (err as Error).message || 'Failed to update category status');
    }
  };

  if (!selectedProperty) {
    return <LoadingState label="Selecting property..." />;
  }

  const currency = selectedProperty.currency;
  const propertyToday = getPropertyLocalDate(selectedProperty.timezone);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Package className="h-6 w-6 text-indigo-600" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Inventory & Stock Control
            </h1>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Property-scoped stock catalog, vendor receipts, controlled adjustments, kitchen recipe
            deductions, and immutable movement ledger for{' '}
            <strong className="text-slate-700">{selectedProperty.name}</strong>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/suppliers"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Truck className="h-3.5 w-3.5 text-slate-500" />
            Suppliers
          </Link>
          <button
            type="button"
            onClick={() => void refreshAll()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>

          <button
            type="button"
            onClick={() => {
              setPreselectedReceiptItemId(null);
              setReceiptModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
          >
            <PackagePlus className="h-4 w-4" />
            Receive Stock
          </button>

          {isAdmin && (
            <>
              <button
                type="button"
                onClick={() => {
                  setPreselectedAdjustItemId(null);
                  setAdjustmentModalOpen(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Adjust Stock
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingItem(null);
                  setItemModalOpen(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700"
              >
                <Plus className="h-4 w-4" />
                New Item
              </button>
            </>
          )}
        </div>
      </div>

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Active SKUs
          </div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900">
            {summary?.totalActiveItems ?? 0}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {summary?.activeCategoriesCount ?? 0} active categories
          </div>
        </div>

        <button
          type="button"
          data-testid="inventory-kpi-low-stock"
          onClick={() => {
            setActiveTab('items');
            setItemStockFilter('low_stock');
          }}
          className={`rounded-2xl border p-4 text-left shadow-sm transition-colors ${
            (summary?.lowStockCount ?? 0) > 0
              ? 'border-amber-300 bg-amber-50/70 hover:bg-amber-50'
              : 'border-slate-200 bg-white hover:bg-slate-50'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-600">
            <span>Low / Out of Stock</span>
            {(summary?.lowStockCount ?? 0) > 0 && (
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            )}
          </div>
          <div
            className={`mt-1.5 text-2xl font-bold ${
              (summary?.outOfStockCount ?? 0) > 0
                ? 'text-rose-700'
                : (summary?.lowStockCount ?? 0) > 0
                  ? 'text-amber-700'
                  : 'text-emerald-700'
            }`}
          >
            {summary?.lowStockCount ?? 0}
          </div>
          <div className="mt-0.5 text-xs text-slate-600">
            {summary?.outOfStockCount ?? 0} out of stock
          </div>
        </button>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Inventory Valuation
          </div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900">
            {formatMoney(summary?.totalInventoryValuation ?? 0, currency)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">On-hand active stock</div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Receipts (Month)
          </div>
          <div className="mt-1.5 text-2xl font-bold text-emerald-700">
            {summary?.receiptsThisMonthCount ?? 0}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {formatMoney(summary?.receiptsThisMonthAmount ?? 0, currency)}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm col-span-2 lg:col-span-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Movements Today
          </div>
          <div className="mt-1.5 text-2xl font-bold text-indigo-700">
            {summary?.movementsTodayCount ?? 0}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">Immutable ledger entries</div>
        </div>
      </div>

      {/* Low-Stock Alert Strip */}
      {summary && summary.lowStockCount > 0 && (
        <div
          data-testid="inventory-low-stock-banner"
          className="rounded-2xl border border-amber-200 bg-amber-50/90 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs">
              <div className="font-bold text-amber-950 text-sm">
                {summary.lowStockCount} active item{summary.lowStockCount === 1 ? '' : 's'} at or
                below reorder threshold
                {summary.outOfStockCount > 0 ? ` (${summary.outOfStockCount} out of stock)` : ''}
              </div>
              <div className="text-amber-900 mt-1">
                {summary.lowStockItems
                  .slice(0, 5)
                  .map(
                    (it) =>
                      `${it.name} (${it.currentStock}/${it.reorderLevel} ${it.unit})`
                  )
                  .join(' • ')}
                {summary.lowStockItems.length > 5
                  ? ` +${summary.lowStockItems.length - 5} more`
                  : ''}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setActiveTab('items');
                setItemStockFilter('low_stock');
              }}
              className="rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            >
              Filter Low Stock
            </button>
            <button
              type="button"
              onClick={() => {
                setPreselectedReceiptItemId(summary.lowStockItems[0]?.id ?? null);
                setReceiptModalOpen(true);
              }}
              className="rounded-xl bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
            >
              Replenish Now
            </button>
          </div>
        </div>
      )}

      {!isAdmin && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
          Inventory categories, SKU thresholds, and manual stock adjustments require{' '}
          <strong>Administrator</strong> privileges. Front-desk staff can view stock levels,
          movement reports, and record incoming vendor stock receipts.
        </div>
      )}

      {error && <ErrorAlert message={error} />}

      {/* Tabs Navigation */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
        {(
          [
            { key: 'items', label: 'Stock Items', icon: Package, badge: items.length },
            {
              key: 'receipts',
              label: 'Purchase Receipts',
              icon: ClipboardList,
              badge: receiptsData?.total,
            },
            {
              key: 'movements',
              label: 'Movement Reports',
              icon: History,
              badge: movementsData?.total,
            },
            {
              key: 'categories',
              label: 'Categories',
              icon: FolderKanban,
              badge: categories.length,
            },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const isCurrent = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              data-testid={`inventory-tab-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-colors ${
                isCurrent
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{tab.label}</span>
              {tab.badge !== undefined && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    isCurrent ? 'bg-slate-700 text-slate-100' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ==================================================================== */}
      {/* TAB 1: STOCK ITEMS                                                   */}
      {/* ==================================================================== */}
      {activeTab === 'items' && (
        <div data-testid="inventory-items-view" className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
            <div className="relative md:col-span-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                aria-label="Search inventory items"
                value={itemSearch}
                onChange={(e) => setItemSearch(e.target.value)}
                placeholder="Search SKU, item name, supplier..."
                className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-3">
              <select
                aria-label="Filter items by category"
                value={itemCategoryFilter}
                onChange={(e) => setItemCategoryFilter(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <select
                aria-label="Filter items by supplier"
                value={itemSupplierFilter}
                onChange={(e) => setItemSupplierFilter(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Suppliers</option>
                <option value="none">Unassigned Supplier</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <select
                aria-label="Filter items by stock status"
                value={itemStockFilter}
                onChange={(e) => setItemStockFilter(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="all">All Stock Levels</option>
                <option value="low_stock">Low Stock (≤ Reorder)</option>
                <option value="out_of_stock">Out of Stock (0)</option>
                <option value="in_stock">Healthy In Stock</option>
              </select>
            </div>

            <div className="md:col-span-1 flex items-center justify-end gap-2">
              <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 cursor-pointer whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={showInactiveItems}
                  onChange={(e) => setShowInactiveItems(e.target.checked)}
                  className="rounded border-slate-300 text-indigo-600"
                />
                Inactive
              </label>
              {(itemSearch ||
                itemCategoryFilter ||
                itemSupplierFilter ||
                itemStockFilter !== 'all') && (
                <button
                  type="button"
                  aria-label="Clear item filters"
                  onClick={() => {
                    setItemSearch('');
                    setItemCategoryFilter('');
                    setItemSupplierFilter('');
                    setItemStockFilter('all');
                    setSearchParams({ tab: 'items' }, { replace: true });
                  }}
                  className="rounded-lg border border-slate-300 p-1.5 text-slate-500 hover:bg-slate-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {itemsLoading ? (
            <LoadingState label="Loading inventory catalog..." />
          ) : items.length === 0 ? (
            <EmptyState
              title="No inventory items match your filters"
              description={
                categories.length === 0
                  ? 'Create an inventory category first, then add stock items.'
                  : 'Add stock items or clear active filters to view inventory.'
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-left">SKU & Item</th>
                    <th className="px-4 py-3 text-left">Category & Supplier</th>
                    <th className="px-4 py-3 text-right">On-Hand Stock</th>
                    <th className="px-4 py-3 text-right">Reorder Threshold</th>
                    <th className="px-4 py-3 text-right">Unit Cost & Value</th>
                    <th className="px-4 py-3 text-left">Stock Health</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      data-testid={`inventory-item-row-${item.sku}`}
                      className={`hover:bg-slate-50/70 ${!item.isActive ? 'opacity-70' : ''}`}
                    >
                      <td className="px-4 py-3.5">
                        <div className="font-mono text-[11px] font-bold text-indigo-600">
                          {item.sku}
                        </div>
                        <div className="font-bold text-sm text-slate-900 mt-0.5">{item.name}</div>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          {item.linkedMenuItemCount > 0 && (
                            <span className="inline-flex items-center gap-1 rounded bg-violet-50 border border-violet-200 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
                              <UtensilsCrossed className="h-2.5 w-2.5" />
                              {item.linkedMenuItemCount} menu recipe
                              {item.linkedMenuItemCount === 1 ? '' : 's'}
                            </span>
                          )}
                          {item.description && (
                            <span className="text-slate-500 truncate max-w-xs">
                              {item.description}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3.5">
                        <div className="font-semibold text-slate-800">{item.categoryName}</div>
                        <div className="text-slate-500 mt-0.5">
                          {item.supplierName ? (
                            <span>
                              Vendor: {item.supplierName}
                              {item.supplierIsActive === false ? ' (Inactive)' : ''}
                            </span>
                          ) : (
                            <span className="text-slate-400">No supplier assigned</span>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        <span
                          data-testid={`stock-qty-${item.sku}`}
                          className={`text-sm font-bold ${
                            item.stockStatus === 'out_of_stock'
                              ? 'text-rose-700'
                              : item.stockStatus === 'low_stock'
                                ? 'text-amber-700'
                                : 'text-slate-900'
                          }`}
                        >
                          {item.currentStock} {item.unit}
                        </span>
                      </td>

                      <td className="px-4 py-3.5 text-right whitespace-nowrap text-slate-600 font-medium">
                        {item.reorderLevel} {item.unit}
                      </td>

                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        <div className="font-semibold text-slate-900">
                          {formatMoney(item.stockValue, currency)}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          @ {formatMoney(item.unitCost, currency)} / {item.unit}
                        </div>
                      </td>

                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <InventoryStockStatusBadge
                          status={item.stockStatus}
                          isActive={item.isActive}
                        />
                      </td>

                      <td className="px-4 py-3.5 whitespace-nowrap text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {item.isActive && (
                            <button
                              type="button"
                              onClick={() => {
                                setPreselectedReceiptItemId(item.id);
                                setReceiptModalOpen(true);
                              }}
                              className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100"
                            >
                              Receive
                            </button>
                          )}
                          {isAdmin && item.isActive && (
                            <button
                              type="button"
                              onClick={() => {
                                setPreselectedAdjustItemId(item.id);
                                setAdjustmentModalOpen(true);
                              }}
                              className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              Adjust
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setMovProductFilter(item.id);
                              setActiveTab('movements');
                            }}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            History
                          </button>
                          {isAdmin && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingItem(item);
                                  setItemModalOpen(true);
                                }}
                                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleToggleItemActive(item)}
                                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                {item.isActive ? 'Deactivate' : 'Activate'}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: PURCHASE / STOCK RECEIPTS                                     */}
      {/* ==================================================================== */}
      {activeTab === 'receipts' && (
        <div data-testid="inventory-receipts-view" className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
            <div className="relative md:col-span-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                aria-label="Search stock receipts"
                value={receiptSearch}
                onChange={(e) => setReceiptSearch(e.target.value)}
                placeholder="Search receipt #, vendor invoice #, supplier..."
                className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-3">
              <select
                aria-label="Filter receipts by supplier"
                value={receiptSupplierFilter}
                onChange={(e) => setReceiptSupplierFilter(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Suppliers</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <input
                type="date"
                aria-label="Receipts from date"
                value={receiptDateFrom}
                onChange={(e) => setReceiptDateFrom(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-2">
              <input
                type="date"
                aria-label="Receipts to date"
                value={receiptDateTo}
                onChange={(e) => setReceiptDateTo(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-1 flex justify-end">
              {(receiptSearch || receiptSupplierFilter || receiptDateFrom || receiptDateTo) && (
                <button
                  type="button"
                  onClick={() => {
                    setReceiptSearch('');
                    setReceiptSupplierFilter('');
                    setReceiptDateFrom('');
                    setReceiptDateTo('');
                  }}
                  className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-50"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {receiptsLoading ? (
            <LoadingState label="Loading purchase receipts..." />
          ) : !receiptsData || receiptsData.items.length === 0 ? (
            <EmptyState
              title="No stock receipts recorded yet"
              description="Click 'Receive Stock' to record incoming vendor deliveries and update stock atomically."
            />
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-left">Receipt #</th>
                    <th className="px-4 py-3 text-left">Date</th>
                    <th className="px-4 py-3 text-left">Supplier & Invoice Ref</th>
                    <th className="px-4 py-3 text-left">Received Items</th>
                    <th className="px-4 py-3 text-left">Recorded By</th>
                    <th className="px-4 py-3 text-right">Total Value</th>
                    <th className="px-4 py-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {receiptsData.items.map((rc) => (
                    <tr
                      key={rc.id}
                      data-testid={`receipt-row-${rc.receiptNumber}`}
                      className="hover:bg-slate-50/70"
                    >
                      <td className="px-4 py-3.5 whitespace-nowrap font-mono font-bold text-indigo-700">
                        {rc.receiptNumber}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-slate-700">
                        {rc.receiptDate}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="font-semibold text-slate-900">
                          {rc.supplierName || 'Direct / Unassigned Vendor'}
                        </div>
                        {rc.vendorInvoiceNumber && (
                          <div className="font-mono text-[11px] text-slate-500">
                            Ref: {rc.vendorInvoiceNumber}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3.5 max-w-sm">
                        <p className="truncate text-slate-700">{rc.itemsSummary}</p>
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-slate-600">
                        {rc.receivedByName || 'Staff'}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-right font-bold text-slate-900">
                        {formatMoney(rc.totalAmount, rc.currency)}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-right">
                        <button
                          type="button"
                          onClick={() => setViewingReceipt(rc)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 3: IMMUTABLE INVENTORY MOVEMENT REPORTS                          */}
      {/* ==================================================================== */}
      {activeTab === 'movements' && (
        <div data-testid="inventory-movements-view" className="space-y-4">
          {/* Movement Report Summary Strip */}
          {movementsData && (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="rounded-xl border border-slate-200 bg-white p-3.5">
                <div className="text-[11px] font-semibold uppercase text-slate-500">
                  Filtered Entries
                </div>
                <div className="mt-1 text-xl font-bold text-slate-900">
                  {movementsData.summary.totalMovements}
                </div>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3.5">
                <div className="text-[11px] font-semibold uppercase text-emerald-800">
                  Total Stock In
                </div>
                <div className="mt-1 text-xl font-bold text-emerald-700">
                  +{movementsData.summary.totalInQuantity}
                </div>
              </div>
              <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3.5">
                <div className="text-[11px] font-semibold uppercase text-indigo-800">
                  Consumed / Issued
                </div>
                <div className="mt-1 text-xl font-bold text-indigo-700">
                  -{movementsData.summary.totalOutQuantity}
                </div>
              </div>
              <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-3.5">
                <div className="text-[11px] font-semibold uppercase text-rose-800">
                  Wastage Write-Off
                </div>
                <div className="mt-1 text-xl font-bold text-rose-700">
                  -{movementsData.summary.totalWastageQuantity}
                </div>
              </div>
              <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-3.5 col-span-2 lg:col-span-1">
                <div className="text-[11px] font-semibold uppercase text-violet-800">
                  Kitchen Order Deductions
                </div>
                <div className="mt-1 text-xl font-bold text-violet-700">
                  {movementsData.summary.orderConsumptionCount}
                </div>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3">
            <div className="lg:col-span-3">
              <input
                type="text"
                aria-label="Search movement ledger"
                value={movSearch}
                onChange={(e) => setMovSearch(e.target.value)}
                placeholder="Search SKU, reason, receipt #, order #..."
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
              />
            </div>

            <div className="lg:col-span-2">
              <select
                aria-label="Filter movements by item"
                value={movProductFilter}
                onChange={(e) => setMovProductFilter(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-xs"
              >
                <option value="">All Items</option>
                {allCatalogItems.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} ({it.sku})
                  </option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-2">
              <select
                aria-label="Filter movements by source"
                value={movSourceFilter}
                onChange={(e) => setMovSourceFilter(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-xs"
              >
                <option value="">All Sources</option>
                {STOCK_MOVEMENT_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {STOCK_MOVEMENT_SOURCE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-2">
              <select
                aria-label="Filter movements by type"
                value={movTypeFilter}
                onChange={(e) => setMovTypeFilter(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-xs"
              >
                <option value="">All Types</option>
                {STOCK_MOVEMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {STOCK_MOVEMENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-3 flex items-center gap-2">
              <input
                type="date"
                aria-label="Movements from date"
                value={movDateFrom}
                onChange={(e) => setMovDateFrom(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-2 py-2 text-xs"
              />
              <input
                type="date"
                aria-label="Movements to date"
                value={movDateTo}
                onChange={(e) => setMovDateTo(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-2 py-2 text-xs"
              />
              {(movSearch ||
                movProductFilter ||
                movCategoryFilter ||
                movSourceFilter ||
                movTypeFilter ||
                movDateFrom ||
                movDateTo) && (
                <button
                  type="button"
                  aria-label="Clear movement filters"
                  onClick={() => {
                    setMovSearch('');
                    setMovProductFilter('');
                    setMovCategoryFilter('');
                    setMovSourceFilter('');
                    setMovTypeFilter('');
                    setMovDateFrom('');
                    setMovDateTo('');
                  }}
                  className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {movementsLoading ? (
            <LoadingState label="Loading immutable movement report..." />
          ) : !movementsData || movementsData.items.length === 0 ? (
            <EmptyState
              title="No stock movements match your filters"
              description="Every opening balance, vendor receipt, kitchen prep deduction, and adjustment is logged here permanently."
            />
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-left">Timestamp & Staff</th>
                    <th className="px-4 py-3 text-left">SKU & Item</th>
                    <th className="px-4 py-3 text-left">Movement Source</th>
                    <th className="px-4 py-3 text-right">Change</th>
                    <th className="px-4 py-3 text-right">Stock Balance</th>
                    <th className="px-4 py-3 text-left">Reason & Reference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {movementsData.items.map((mov) => {
                    const isPositive = mov.quantityDelta >= 0;
                    return (
                      <tr key={mov.id} data-testid="movement-ledger-row" className="hover:bg-slate-50/70">
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="font-semibold text-slate-800">
                            {new Date(mov.createdAt).toLocaleString()}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            By {mov.recordedByName || 'System'}
                          </div>
                        </td>

                        <td className="px-4 py-3">
                          <div className="font-mono text-[11px] font-bold text-indigo-600">
                            {mov.productSku}
                          </div>
                          <div className="font-bold text-slate-900">{mov.productName}</div>
                        </td>

                        <td className="px-4 py-3 whitespace-nowrap">
                          <StockMovementSourceBadge source={mov.movementSource} />
                        </td>

                        <td className="px-4 py-3 whitespace-nowrap text-right">
                          <span
                            className={`inline-flex items-center gap-0.5 font-bold ${
                              isPositive ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {isPositive ? (
                              <ArrowUpRight className="h-3.5 w-3.5" />
                            ) : (
                              <ArrowDownRight className="h-3.5 w-3.5" />
                            )}
                            {isPositive ? `+${mov.quantityDelta}` : mov.quantityDelta} {mov.unit}
                          </span>
                        </td>

                        <td className="px-4 py-3 whitespace-nowrap text-right font-mono text-slate-700">
                          {mov.stockBefore} → <strong className="text-slate-900">{mov.stockAfter}</strong>{' '}
                          {mov.unit}
                        </td>

                        <td className="px-4 py-3 max-w-md">
                          <div className="font-medium text-slate-800">{mov.reason || '—'}</div>
                          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 mt-0.5">
                            {mov.receiptNumber && (
                              <span className="font-mono font-semibold text-emerald-700">
                                {mov.receiptNumber}
                              </span>
                            )}
                            {mov.foodOrderReference && (
                              <Link
                                to="/restaurant?tab=orders"
                                className="font-mono font-semibold text-violet-700 hover:underline"
                              >
                                {mov.foodOrderReference}
                              </Link>
                            )}
                            {mov.referenceNote && <span>{mov.referenceNote}</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 4: INVENTORY CATEGORIES                                          */}
      {/* ==================================================================== */}
      {activeTab === 'categories' && (
        <div data-testid="inventory-categories-view" className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-900">Inventory Categories</h2>
                <p className="text-xs text-slate-500">
                  Property-scoped storage groups ({categories.length})
                </p>
              </div>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingCategory(null);
                    setCategoryModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New Category
                </button>
              )}
            </div>

            {categories.length === 0 ? (
              <EmptyState
                title="No inventory categories yet"
                description="Create categories such as Kitchen Pantry, Beverages, Housekeeping Linen, or Amenities."
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {categories.map((cat) => (
                  <div
                    key={cat.id}
                    data-testid={`inv-category-card-${cat.code}`}
                    className={`rounded-xl border p-4 text-xs flex items-start justify-between gap-2 ${
                      cat.isActive
                        ? 'border-slate-200 bg-slate-50/60'
                        : 'border-slate-200 bg-slate-100/70 opacity-75'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-bold text-indigo-600">
                          {cat.code}
                        </span>
                        {!cat.isActive && (
                          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                            Inactive
                          </span>
                        )}
                      </div>
                      <h3 className="font-bold text-slate-900 text-sm mt-0.5">{cat.name}</h3>
                      {cat.description && (
                        <p className="text-slate-500 mt-0.5">{cat.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-2 text-[11px] font-medium text-slate-600">
                        <span>
                          {cat.activeItemCount} active / {cat.itemCount} items
                        </span>
                        {cat.lowStockItemCount > 0 && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">
                            {cat.lowStockItemCount} low
                          </span>
                        )}
                      </div>
                    </div>

                    {isAdmin && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          aria-label={`Edit category ${cat.name}`}
                          onClick={() => {
                            setEditingCategory(cat);
                            setCategoryModalOpen(true);
                          }}
                          className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggleCategoryActive(cat)}
                          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          {cat.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      <InventoryCategoryModal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        propertyId={selectedProperty.id}
        editingCategory={editingCategory}
        onSaved={() => void refreshAll()}
      />

      <InventoryItemModal
        open={itemModalOpen}
        onClose={() => setItemModalOpen(false)}
        propertyId={selectedProperty.id}
        currency={currency}
        categories={categories}
        suppliers={suppliers}
        editingItem={editingItem}
        onSaved={() => void refreshAll()}
      />

      <StockReceiptModal
        open={receiptModalOpen}
        onClose={() => setReceiptModalOpen(false)}
        propertyId={selectedProperty.id}
        currency={currency}
        defaultDate={propertyToday}
        items={allCatalogItems}
        suppliers={suppliers}
        preselectedItemId={preselectedReceiptItemId}
        onSaved={() => void refreshAll()}
      />

      <StockAdjustmentModal
        open={adjustmentModalOpen}
        onClose={() => setAdjustmentModalOpen(false)}
        propertyId={selectedProperty.id}
        items={allCatalogItems}
        preselectedItemId={preselectedAdjustItemId}
        onSaved={() => void refreshAll()}
      />

      <StockReceiptDetailModal
        open={viewingReceipt !== null}
        onClose={() => setViewingReceipt(null)}
        receipt={viewingReceipt}
      />
    </div>
  );
}
