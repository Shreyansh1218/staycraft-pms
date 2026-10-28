import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ChefHat,
  CheckCircle2,
  ClipboardList,
  Clock,
  Eye,
  Minus,
  Pencil,
  Plus,
  QrCode,
  Receipt,
  RefreshCw,
  Search,
  ShoppingBag,
  Trash2,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import {
  DIETARY_TAGS,
  DIETARY_TAG_LABELS,
  FOOD_BILLING_STATUSES,
  FOOD_BILLING_STATUS_LABELS,
  FOOD_ORDER_SOURCES,
  FOOD_ORDER_SOURCE_LABELS,
  FOOD_ORDER_STATUSES,
  FOOD_ORDER_STATUS_LABELS,
  FOOD_ORDER_TYPES,
  FOOD_ORDER_TYPE_LABELS,
  type FoodOrderType,
} from '@shared/constants';
import { calculateFoodOrderTotals, formatMoney } from '@shared/pricing';
import type {
  EligibleRoomServiceStay,
  FoodCategory,
  FoodMenuItem,
  FoodOrderDetail,
  FoodOrderListItem,
  FoodOrdersListResponse,
  InvoiceDetail,
} from '@shared/types';
import {
  FoodCategoryModal,
  FoodMenuItemModal,
  FoodOrderDetailModal,
  GuestQrConfigModal,
  MenuItemRecipeModal,
} from '../components/restaurant/RestaurantModals';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import {
  DietaryBadge,
  FoodBillingStatusBadge,
  FoodOrderSourceBadge,
  FoodOrderStatusBadge,
  FoodOrderTypeBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch } from '../lib/api';

type RestaurantTab = 'pos' | 'kitchen' | 'orders' | 'menu';

const MAX_CART_ITEM_QUANTITY = 500;

interface CartLine {
  menuItem: FoodMenuItem;
  quantity: number;
  specialInstructions: string;
}

function makeOrderIdempotencyKey(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `ord-${rand}`;
}

function formatElapsedTime(placedIso: string, nowMs: number): string {
  const diffMin = Math.max(0, Math.floor((nowMs - new Date(placedIso).getTime()) / 60000));
  if (diffMin < 1) return '0m elapsed';
  if (diffMin < 60) return `${diffMin}m elapsed`;
  const hrs = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return `${hrs}h ${mins}m elapsed`;
}

export function RestaurantPage() {
  const { user, selectedProperty } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialTab = (searchParams.get('tab') as RestaurantTab) || 'pos';
  const validInitialTab: RestaurantTab = ['pos', 'kitchen', 'orders', 'menu'].includes(
    initialTab
  )
    ? initialTab
    : 'pos';

  const [activeTab, setActiveTab] = useState<RestaurantTab>(validInitialTab);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Catalog state
  const [categories, setCategories] = useState<FoodCategory[]>([]);
  const [menuItems, setMenuItems] = useState<FoodMenuItem[]>([]);
  const [eligibleStays, setEligibleStays] = useState<EligibleRoomServiceStay[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);

  // Orders & Kitchen state
  const [ordersData, setOrdersData] = useState<FoodOrdersListResponse | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  // POS Cart state
  const [posCategoryId, setPosCategoryId] = useState<string>('');
  const [posDietary, setPosDietary] = useState<string>('');
  const [posSearch, setPosSearch] = useState('');
  const [orderType, setOrderType] = useState<FoodOrderType>('restaurant');
  const [tableLabel, setTableLabel] = useState('Table 1');
  const [customerName, setCustomerName] = useState('');
  const [selectedReservationId, setSelectedReservationId] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderIdemKey, setOrderIdemKey] = useState(() => makeOrderIdempotencyKey());
  const [placingOrder, setPlacingOrder] = useState(false);
  const [posError, setPosError] = useState<string | null>(null);

  // Orders Ledger filter state
  const [filterOrderType, setFilterOrderType] = useState('');
  const [filterOrderSource, setFilterOrderSource] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterBillingStatus, setFilterBillingStatus] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [showCancelledKitchen, setShowCancelledKitchen] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(
    () => searchParams.get('qr') === '1'
  );

  // Menu Management state
  const [menuSearch, setMenuSearch] = useState('');
  const [menuCategoryFilter, setMenuCategoryFilter] = useState('');
  const [showInactiveMenu, setShowInactiveMenu] = useState(true);

  // Modals
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<FoodCategory | null>(null);
  const [menuItemModalOpen, setMenuItemModalOpen] = useState(false);
  const [editingMenuItem, setEditingMenuItem] = useState<FoodMenuItem | null>(null);
  const [recipeMenuItem, setRecipeMenuItem] = useState<FoodMenuItem | null>(null);
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const [busyOrderActionId, setBusyOrderActionId] = useState<string | null>(null);

  // Update elapsed clock every 30s
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const loadCatalogAndStays = useCallback(async () => {
    if (!selectedProperty) return;
    setCatalogLoading(true);
    try {
      const [catRes, itemRes, staysRes] = await Promise.all([
        apiFetch<{ items: FoodCategory[] }>(
          '/api/restaurant/categories?includeInactive=true',
          { propertyId: selectedProperty.id }
        ),
        apiFetch<{ items: FoodMenuItem[] }>(
          '/api/restaurant/menu-items?includeInactive=true',
          { propertyId: selectedProperty.id }
        ),
        apiFetch<{ items: EligibleRoomServiceStay[] }>(
          '/api/restaurant/eligible-stays',
          { propertyId: selectedProperty.id }
        ),
      ]);
      setCategories(catRes.items);
      setMenuItems(itemRes.items);
      setEligibleStays(staysRes.items);

      const urlResId = searchParams.get('reservationId');
      if (urlResId && staysRes.items.some((s) => s.reservationId === urlResId)) {
        setOrderType('room_service');
        setSelectedReservationId(urlResId);
      } else if (
        staysRes.items.length > 0 &&
        !staysRes.items.some((s) => s.reservationId === selectedReservationId)
      ) {
        setSelectedReservationId(staysRes.items[0].reservationId);
      }
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setCatalogLoading(false);
    }
  }, [selectedProperty?.id]);

  const loadOrders = useCallback(async () => {
    if (!selectedProperty) return;
    setOrdersLoading(true);
    setPageError(null);
    try {
      if (activeTab === 'kitchen') {
        const activeQs = new URLSearchParams();
        activeQs.set('kitchenActiveOnly', 'true');
        activeQs.set('pageSize', '100');

        const servedQs = new URLSearchParams();
        servedQs.set('status', 'served');
        servedQs.set('pageSize', '20');

        const requests: Array<Promise<FoodOrdersListResponse>> = [
          apiFetch<FoodOrdersListResponse>(
            `/api/restaurant/orders?${activeQs.toString()}`,
            { propertyId: selectedProperty.id }
          ),
          apiFetch<FoodOrdersListResponse>(
            `/api/restaurant/orders?${servedQs.toString()}`,
            { propertyId: selectedProperty.id }
          ),
        ];

        if (showCancelledKitchen) {
          const cancelledQs = new URLSearchParams();
          cancelledQs.set('status', 'cancelled');
          cancelledQs.set('pageSize', '20');
          requests.push(
            apiFetch<FoodOrdersListResponse>(
              `/api/restaurant/orders?${cancelledQs.toString()}`,
              { propertyId: selectedProperty.id }
            )
          );
        }

        const [activeRes, servedRes, cancelledRes] = await Promise.all(requests);
        const mergedById = new Map<string, FoodOrderListItem>();
        for (const item of [
          ...activeRes.items,
          ...servedRes.items,
          ...(cancelledRes?.items ?? []),
        ]) {
          if (!mergedById.has(item.id)) {
            mergedById.set(item.id, item);
          }
        }

        setOrdersData({
          ...activeRes,
          items: Array.from(mergedById.values()),
        });
        return;
      }

      const qs = new URLSearchParams();
      qs.set('pageSize', '80');
      if (activeTab === 'orders') {
        if (filterOrderType) qs.set('orderType', filterOrderType);
        if (filterOrderSource) qs.set('orderSource', filterOrderSource);
        if (filterStatus) qs.set('status', filterStatus);
        if (filterBillingStatus) qs.set('billingStatus', filterBillingStatus);
        if (filterSearch.trim()) qs.set('search', filterSearch.trim());
      }
      const res = await apiFetch<FoodOrdersListResponse>(
        `/api/restaurant/orders?${qs.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setOrdersData(res);
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setOrdersLoading(false);
    }
  }, [
    selectedProperty?.id,
    activeTab,
    showCancelledKitchen,
    filterOrderType,
    filterOrderSource,
    filterStatus,
    filterBillingStatus,
    filterSearch,
  ]);

  // Reset cart when switching property
  useEffect(() => {
    setCart([]);
    setPosError(null);
    setOrderIdemKey(makeOrderIdempotencyKey());
    void loadCatalogAndStays();
  }, [selectedProperty?.id, loadCatalogAndStays]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const switchTab = (tab: RestaurantTab) => {
    setActiveTab(tab);
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  // POS orderable items (strictly active category + active item + available)
  const posItems = useMemo(() => {
    return menuItems.filter((item) => {
      if (!item.isActive || !item.categoryIsActive || !item.isAvailable) return false;
      if (posCategoryId && item.categoryId !== posCategoryId) return false;
      if (posDietary && item.dietaryTag !== posDietary) return false;
      if (posSearch.trim()) {
        const q = posSearch.trim().toLowerCase();
        if (
          !item.name.toLowerCase().includes(q) &&
          !item.sku.toLowerCase().includes(q) &&
          !item.categoryName.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [menuItems, posCategoryId, posDietary, posSearch]);

  const managedMenuItems = useMemo(() => {
    return menuItems.filter((item) => {
      if (!showInactiveMenu && (!item.isActive || !item.categoryIsActive)) return false;
      if (menuCategoryFilter && item.categoryId !== menuCategoryFilter) return false;
      if (menuSearch.trim()) {
        const q = menuSearch.trim().toLowerCase();
        if (
          !item.name.toLowerCase().includes(q) &&
          !item.sku.toLowerCase().includes(q) &&
          !item.categoryName.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [menuItems, showInactiveMenu, menuCategoryFilter, menuSearch]);

  const cartTotals = useMemo(() => {
    if (!selectedProperty || cart.length === 0) {
      return {
        subtotal: 0,
        taxAmount: 0,
        totalAmount: 0,
        lineSubtotals: [] as number[],
        calculationError: null as string | null,
      };
    }
    try {
      const totals = calculateFoodOrderTotals(
        cart.map((c) => ({ quantity: c.quantity, unitPrice: c.menuItem.price })),
        selectedProperty.defaultTaxRate
      );
      return {
        ...totals,
        calculationError: null as string | null,
      };
    } catch (err) {
      return {
        subtotal: 0,
        taxAmount: 0,
        totalAmount: 0,
        lineSubtotals: [] as number[],
        calculationError:
          (err as Error).message || 'Unable to compute order totals for current cart.',
      };
    }
  }, [cart, selectedProperty]);

  const addToCart = (item: FoodMenuItem) => {
    setPosError(null);
    setCart((prev) => {
      const existing = prev.find((c) => c.menuItem.id === item.id);
      if (existing) {
        if (existing.quantity >= MAX_CART_ITEM_QUANTITY) {
          return prev;
        }
        return prev.map((c) =>
          c.menuItem.id === item.id
            ? { ...c, quantity: Math.min(MAX_CART_ITEM_QUANTITY, c.quantity + 1) }
            : c
        );
      }
      return [...prev, { menuItem: item, quantity: 1, specialInstructions: '' }];
    });
  };

  const updateCartQuantity = (menuItemId: string, delta: number) => {
    setPosError(null);
    setCart((prev) =>
      prev
        .map((c) => {
          if (c.menuItem.id !== menuItemId) return c;
          const nextQty = Math.min(MAX_CART_ITEM_QUANTITY, c.quantity + delta);
          return { ...c, quantity: nextQty };
        })
        .filter((c) => c.quantity > 0)
    );
  };

  const updateCartInstructions = (menuItemId: string, text: string) => {
    setCart((prev) =>
      prev.map((c) =>
        c.menuItem.id === menuItemId ? { ...c, specialInstructions: text } : c
      )
    );
  };

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProperty) return;
    setPosError(null);

    if (cart.length === 0) {
      setPosError('Add at least one menu item to place an order.');
      return;
    }
    if (orderType === 'restaurant' && !tableLabel.trim()) {
      setPosError('Enter a table or dining area label for Restaurant / Dine-In orders.');
      return;
    }
    if (orderType === 'room_service' && !selectedReservationId) {
      setPosError('Select a Checked-In in-house reservation for Room Service.');
      return;
    }

    setPlacingOrder(true);
    try {
      const res = await apiFetch<{ order: FoodOrderDetail }>('/api/restaurant/orders', {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: {
          orderType,
          tableLabel: orderType === 'room_service' ? '' : tableLabel.trim(),
          customerName: customerName.trim(),
          reservationId: orderType === 'room_service' ? selectedReservationId : null,
          notes: orderNotes.trim(),
          items: cart.map((c) => ({
            menuItemId: c.menuItem.id,
            quantity: c.quantity,
            specialInstructions: c.specialInstructions.trim(),
          })),
          idempotencyKey: orderIdemKey,
        },
      });

      showToast(
        'success',
        `Placed order ${res.order.orderReference} (${formatMoney(res.order.totalAmount, res.order.currency)})`
      );
      setCart([]);
      setOrderNotes('');
      setCustomerName('');
      setOrderIdemKey(makeOrderIdempotencyKey());
      await loadOrders();
      setDetailOrderId(res.order.id);
    } catch (err) {
      if (err instanceof ApiClientError && err.fieldErrors) {
        setPosError(Object.values(err.fieldErrors)[0] || err.message);
      } else {
        setPosError((err as Error).message);
      }
      if (err instanceof ApiClientError && err.status === 400) {
        setOrderIdemKey(makeOrderIdempotencyKey());
      }
    } finally {
      setPlacingOrder(false);
    }
  };

  const handleQuickKitchenAdvance = async (
    order: FoodOrderListItem,
    nextStatus: 'preparing' | 'ready' | 'served'
  ) => {
    if (!selectedProperty) return;
    setBusyOrderActionId(order.id);
    try {
      const res = await apiFetch<{ order: FoodOrderDetail }>(
        `/api/restaurant/orders/${order.id}/status`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: { status: nextStatus },
        }
      );
      showToast('success', `${res.order.orderReference} → ${FOOD_ORDER_STATUS_LABELS[nextStatus]}`);
      await loadOrders();
      if (nextStatus === 'preparing') {
        void loadCatalogAndStays();
      }
    } catch (err) {
      showToast('error', (err as Error).message);
    } finally {
      setBusyOrderActionId(null);
    }
  };

  const handleQuickPostToFolio = async (order: FoodOrderListItem) => {
    if (!selectedProperty) return;
    setBusyOrderActionId(order.id);
    try {
      const res = await apiFetch<{ order: FoodOrderDetail; invoice: InvoiceDetail }>(
        `/api/restaurant/orders/${order.id}/post-to-invoice`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: { createDraftInvoiceIfMissing: true },
        }
      );
      showToast(
        'success',
        `Posted ${order.orderReference} to Invoice ${res.invoice.invoiceNumber}`
      );
      await Promise.all([loadOrders(), loadCatalogAndStays()]);
    } catch (err) {
      showToast('error', (err as Error).message);
    } finally {
      setBusyOrderActionId(null);
    }
  };

  const handleToggleItemAvailability = async (item: FoodMenuItem) => {
    if (!selectedProperty) return;
    try {
      await apiFetch<{ menuItem: FoodMenuItem }>(
        `/api/restaurant/menu-items/${item.id}`,
        {
          method: 'PUT',
          propertyId: selectedProperty.id,
          body: { isAvailable: !item.isAvailable },
        }
      );
      showToast(
        'info',
        `"${item.name}" marked ${!item.isAvailable ? 'Available' : 'Unavailable (Sold Out)'}`
      );
      await loadCatalogAndStays();
    } catch (err) {
      showToast('error', (err as Error).message);
    }
  };

  const handleToggleItemActive = async (item: FoodMenuItem) => {
    if (!selectedProperty) return;
    try {
      await apiFetch<{ menuItem: FoodMenuItem }>(
        `/api/restaurant/menu-items/${item.id}`,
        {
          method: 'PUT',
          propertyId: selectedProperty.id,
          body: { isActive: !item.isActive },
        }
      );
      showToast(
        'info',
        `"${item.name}" ${!item.isActive ? 'reactivated' : 'deactivated'}`
      );
      await loadCatalogAndStays();
    } catch (err) {
      showToast('error', (err as Error).message);
    }
  };

  const handleToggleCategoryActive = async (cat: FoodCategory) => {
    if (!selectedProperty) return;
    try {
      await apiFetch<{ category: FoodCategory }>(
        `/api/restaurant/categories/${cat.id}`,
        {
          method: 'PUT',
          propertyId: selectedProperty.id,
          body: { isActive: !cat.isActive },
        }
      );
      showToast(
        'info',
        `Category "${cat.name}" ${!cat.isActive ? 'activated' : 'deactivated'}`
      );
      await loadCatalogAndStays();
    } catch (err) {
      showToast('error', (err as Error).message);
    }
  };

  if (!selectedProperty) {
    return <LoadingState label="Selecting property..." />;
  }

  const isAdmin = user?.role === 'admin';
  const currency = selectedProperty.currency;
  const summary = ordersData?.summary;
  const allOrders = ordersData?.items ?? [];

  const selectedStay = eligibleStays.find(
    (s) => s.reservationId === selectedReservationId
  );

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Restaurant, Room Service & Kitchen POS
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Property-scoped dining menu, POS & in-house room-service tickets, kitchen board, and
            guest folio posting for{' '}
            <span className="font-medium text-slate-700">{selectedProperty.name}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          <button
            type="button"
            data-testid="open-hotel-qr-modal-btn"
            onClick={() => setQrModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
          >
            <QrCode className="h-3.5 w-3.5" />
            Hotel QR Menu
          </button>

          <button
            type="button"
            onClick={() => {
              void loadCatalogAndStays();
              void loadOrders();
            }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5 text-slate-500" />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-amber-200/80 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Pending Kitchen</span>
              <Clock className="h-4 w-4 text-amber-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-amber-800">{summary.pendingCount}</p>
            <p className="mt-0.5 text-xs text-slate-500">New tickets awaiting prep</p>
          </div>

          <div className="rounded-2xl border border-violet-200/80 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Preparing</span>
              <ChefHat className="h-4 w-4 text-violet-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-violet-800">{summary.preparingCount}</p>
            <p className="mt-0.5 text-xs text-slate-500">Active on kitchen line</p>
          </div>

          <div className="rounded-2xl border border-sky-200/80 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Ready to Serve</span>
              <CheckCircle2 className="h-4 w-4 text-sky-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-sky-800">{summary.readyCount}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {summary.servedTodayCount} served today
            </p>
          </div>

          <div className="rounded-2xl border border-indigo-200/80 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Unbilled Room Service</span>
              <Receipt className="h-4 w-4 text-indigo-600" />
            </div>
            <p className="mt-2 text-2xl font-bold text-indigo-700">
              {formatMoney(summary.unbilledRoomServiceAmount, currency)}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {summary.unbilledRoomServiceCount} room order
              {summary.unbilledRoomServiceCount === 1 ? '' : 's'} ready to post
            </p>
          </div>
        </div>
      )}

      {/* Workspace Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-3">
        <button
          type="button"
          onClick={() => switchTab('pos')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-colors ${
            activeTab === 'pos'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <ShoppingBag className="h-4 w-4" />
          New Order / POS
        </button>

        <button
          type="button"
          onClick={() => switchTab('kitchen')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-colors ${
            activeTab === 'kitchen'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <ChefHat className="h-4 w-4" />
          Kitchen Order Board
          {summary && summary.pendingCount + summary.preparingCount + summary.readyCount > 0 && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                activeTab === 'kitchen'
                  ? 'bg-white/20 text-white'
                  : 'bg-amber-100 text-amber-800'
              }`}
            >
              {summary.pendingCount + summary.preparingCount + summary.readyCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => switchTab('orders')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-colors ${
            activeTab === 'orders'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <ClipboardList className="h-4 w-4" />
          Orders & Room Folios
        </button>

        <button
          type="button"
          onClick={() => switchTab('menu')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-colors ${
            activeTab === 'menu'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <UtensilsCrossed className="h-4 w-4" />
          Menu & Categories
        </button>
      </div>

      {pageError && <ErrorAlert message={pageError} onRetry={() => void loadOrders()} />}

      {/* ==================================================================== */}
      {/* TAB 1: NEW ORDER / POS                                               */}
      {/* ==================================================================== */}
      {activeTab === 'pos' && (
        <div
          data-testid="restaurant-pos-view"
          className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"
        >
          {/* Left: Menu Selection Grid */}
          <div className="lg:col-span-7 xl:col-span-8 space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPosCategoryId('')}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                    posCategoryId === ''
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                  }`}
                >
                  All Categories
                </button>
                {categories
                  .filter((c) => c.isActive)
                  .map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setPosCategoryId(cat.id)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                        posCategoryId === cat.id
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                      }`}
                    >
                      {cat.name}
                    </button>
                  ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="relative sm:col-span-8">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    aria-label="Search POS menu"
                    value={posSearch}
                    onChange={(e) => setPosSearch(e.target.value)}
                    placeholder="Search dish name, SKU, or category..."
                    className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2 text-sm"
                  />
                </div>
                <div className="sm:col-span-4">
                  <select
                    aria-label="Filter dietary type"
                    value={posDietary}
                    onChange={(e) => setPosDietary(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">All Dietary</option>
                    {DIETARY_TAGS.map((t) => (
                      <option key={t} value={t}>
                        {DIETARY_TAG_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {catalogLoading ? (
              <LoadingState label="Loading property menu..." />
            ) : posItems.length === 0 ? (
              <EmptyState
                title={
                  menuItems.length === 0
                    ? 'No menu items configured for this property yet'
                    : 'No available menu items match your filter'
                }
                description={
                  menuItems.length === 0
                    ? isAdmin
                      ? 'Create food categories and menu items in Menu & Categories to begin taking orders.'
                      : 'Ask a property Administrator to configure categories and menu items for this property.'
                    : 'Clear your category/search filter or mark items Available in Menu & Categories.'
                }
                action={
                  menuItems.length === 0 && isAdmin ? (
                    <button
                      type="button"
                      onClick={() => switchTab('menu')}
                      className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                    >
                      Configure Menu & Categories
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {posItems.map((item) => {
                  const inCart = cart.find((c) => c.menuItem.id === item.id);
                  const isAtMaxQuantity = Boolean(
                    inCart && inCart.quantity >= MAX_CART_ITEM_QUANTITY
                  );
                  return (
                    <div
                      key={item.id}
                      data-testid={`pos-menu-card-${item.sku}`}
                      className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-300 transition-colors"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                            {item.categoryName} • {item.sku}
                          </span>
                          <DietaryBadge tag={item.dietaryTag} />
                        </div>
                        <h3 className="text-sm font-bold text-slate-900 mt-1">{item.name}</h3>
                        {item.description && (
                          <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                            {item.description}
                          </p>
                        )}
                        {(item.ingredientCount ?? 0) > 0 && item.hasLowOrOutIngredient && (
                          <span
                            data-testid={`pos-low-ingredient-${item.sku}`}
                            className="mt-1.5 inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
                          >
                            Low Recipe Stock
                          </span>
                        )}
                      </div>

                      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                        <div>
                          <span className="text-sm font-bold text-slate-900">
                            {formatMoney(item.price, currency)}
                          </span>
                          {item.prepTimeMinutes && (
                            <span className="block text-[11px] text-slate-400">
                              ~{item.prepTimeMinutes}m prep
                            </span>
                          )}
                        </div>

                        <button
                          type="button"
                          disabled={isAtMaxQuantity}
                          title={
                            isAtMaxQuantity
                              ? `Maximum ${MAX_CART_ITEM_QUANTITY} units per item reached`
                              : undefined
                          }
                          onClick={() => addToCart(item)}
                          className="inline-flex items-center gap-1 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {inCart ? `Add (${inCart.quantity})` : 'Add'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: Live Order Ticket */}
          <form
            onSubmit={(e) => void handlePlaceOrder(e)}
            className="lg:col-span-5 xl:col-span-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">Current Order Ticket</h2>
                <p className="text-xs text-slate-500">
                  Prices snapshotted in {currency} + {selectedProperty.taxName} (
                  {selectedProperty.defaultTaxRate}%)
                </p>
              </div>
              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCart([])}
                  className="text-xs font-medium text-rose-600 hover:underline"
                >
                  Clear
                </button>
              )}
            </div>

            {(posError || cartTotals.calculationError) && (
              <ErrorAlert message={posError ?? cartTotals.calculationError!} />
            )}

            {/* Order Channel Selector */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Service Channel *
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {FOOD_ORDER_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      setOrderType(type);
                      setPosError(null);
                    }}
                    className={`rounded-xl border px-2.5 py-2 text-xs font-semibold transition-colors ${
                      orderType === type
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {type === 'restaurant'
                      ? 'Dine-In'
                      : type === 'takeaway'
                        ? 'Takeaway'
                        : 'Room Service'}
                  </button>
                ))}
              </div>
            </div>

            {/* Dynamic Context Fields */}
            {orderType === 'room_service' ? (
              <div className="space-y-2">
                <label
                  htmlFor="pos-room-service-stay"
                  className="block text-xs font-semibold text-slate-700"
                >
                  In-House Checked-In Guest & Room *
                </label>
                {eligibleStays.length === 0 ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    No Checked-In reservations currently exist in {selectedProperty.name}. Only
                    in-house guests can receive Room Service orders.
                  </div>
                ) : (
                  <>
                    <select
                      id="pos-room-service-stay"
                      value={selectedReservationId}
                      onChange={(e) => setSelectedReservationId(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                    >
                      {eligibleStays.map((stay) => (
                        <option key={stay.reservationId} value={stay.reservationId}>
                          Room {stay.roomNumber} — {stay.guestName} ({stay.bookingReference})
                        </option>
                      ))}
                    </select>
                    {selectedStay && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                        Stay: {selectedStay.arrivalDate} → {selectedStay.departureDate} • Folio:{' '}
                        <strong>
                          {selectedStay.activeInvoiceNumber
                            ? `${selectedStay.activeInvoiceNumber} (${selectedStay.activeInvoiceStatus?.replace('_', ' ')})`
                            : 'Draft folio will be created on posting'}
                        </strong>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {orderType === 'restaurant' && (
                  <div>
                    <label
                      htmlFor="pos-table-label"
                      className="block text-xs font-semibold text-slate-700 mb-1"
                    >
                      Table / Area *
                    </label>
                    <input
                      id="pos-table-label"
                      type="text"
                      required
                      maxLength={60}
                      value={tableLabel}
                      onChange={(e) => setTableLabel(e.target.value)}
                      placeholder="e.g. Table 4"
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}
                <div className={orderType === 'takeaway' ? 'sm:col-span-2' : ''}>
                  <label
                    htmlFor="pos-customer-name"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    {orderType === 'takeaway' ? 'Customer / Parcel Name' : 'Guest Name (Optional)'}
                  </label>
                  <input
                    id="pos-customer-name"
                    type="text"
                    maxLength={160}
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Walk-in diner or parcel tag..."
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>
            )}

            {/* Cart Items */}
            <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
              {cart.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 py-8 text-center text-xs text-slate-500">
                  Select dishes from the menu to build an order ticket.
                </div>
              ) : (
                cart.map((line, idx) => (
                  <div
                    key={line.menuItem.id}
                    className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 space-y-2 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-slate-900">{line.menuItem.name}</p>
                        <p className="text-[11px] text-slate-500">
                          {formatMoney(line.menuItem.price, currency)} each
                        </p>
                      </div>
                      <span className="font-bold text-slate-900">
                        {formatMoney(cartTotals.lineSubtotals[idx] ?? 0, currency)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <div className="inline-flex items-center rounded-lg border border-slate-300 bg-white">
                        <button
                          type="button"
                          aria-label={`Decrease ${line.menuItem.name}`}
                          onClick={() => updateCartQuantity(line.menuItem.id, -1)}
                          className="p-1.5 text-slate-600 hover:bg-slate-100"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="px-2.5 font-bold text-slate-900">{line.quantity}</span>
                        <button
                          type="button"
                          disabled={line.quantity >= MAX_CART_ITEM_QUANTITY}
                          title={
                            line.quantity >= MAX_CART_ITEM_QUANTITY
                              ? `Maximum ${MAX_CART_ITEM_QUANTITY} units per item reached`
                              : undefined
                          }
                          aria-label={`Increase ${line.menuItem.name}`}
                          onClick={() => updateCartQuantity(line.menuItem.id, 1)}
                          className="p-1.5 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>

                      <input
                        type="text"
                        aria-label={`Instructions for ${line.menuItem.name}`}
                        value={line.specialInstructions}
                        onChange={(e) =>
                          updateCartInstructions(line.menuItem.id, e.target.value)
                        }
                        placeholder="Item note (e.g. less spicy)..."
                        className="flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs"
                      />

                      <button
                        type="button"
                        aria-label={`Remove ${line.menuItem.name}`}
                        onClick={() =>
                          updateCartQuantity(line.menuItem.id, -line.quantity)
                        }
                        className="p-1 text-slate-400 hover:text-rose-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {line.quantity >= MAX_CART_ITEM_QUANTITY && (
                      <p
                        data-testid="cart-max-qty-notice"
                        className="text-[11px] font-medium text-amber-700"
                      >
                        Maximum {MAX_CART_ITEM_QUANTITY} units per item reached.
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>

            <div>
              <label
                htmlFor="pos-order-notes"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Order / Delivery Instructions (Optional)
              </label>
              <input
                id="pos-order-notes"
                type="text"
                maxLength={500}
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                placeholder="Cutlery count, allergy alert, knock softly..."
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
              />
            </div>

            {/* Totals Breakdown */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal</span>
                <span className="font-semibold text-slate-900">
                  {formatMoney(cartTotals.subtotal, currency)}
                </span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>
                  {selectedProperty.taxName} ({selectedProperty.defaultTaxRate}%)
                </span>
                <span className="font-semibold text-slate-900">
                  {formatMoney(cartTotals.taxAmount, currency)}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-sm font-bold text-slate-900">
                <span>Order Total</span>
                <span className="text-indigo-700">
                  {formatMoney(cartTotals.totalAmount, currency)}
                </span>
              </div>
            </div>

            <button
              type="submit"
              disabled={
                placingOrder ||
                cart.length === 0 ||
                Boolean(cartTotals.calculationError) ||
                (orderType === 'room_service' && eligibleStays.length === 0)
              }
              className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              {placingOrder ? 'Placing Order...' : 'Place Kitchen Order'}
            </button>
          </form>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: KITCHEN ORDER BOARD                                           */}
      {/* ==================================================================== */}
      {activeTab === 'kitchen' && (
        <div data-testid="kitchen-order-board" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">
              Live kitchen workflow: <strong>Pending → Preparing → Ready → Served</strong>. Serving
              an order never auto-marks a guest invoice paid.
            </p>
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={showCancelledKitchen}
                onChange={(e) => setShowCancelledKitchen(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600"
              />
              Show Cancelled Tickets
            </label>
          </div>

          {ordersLoading ? (
            <LoadingState label="Loading kitchen order board..." />
          ) : (
            <div
              className={`grid grid-cols-1 md:grid-cols-2 ${
                showCancelledKitchen ? 'xl:grid-cols-5' : 'xl:grid-cols-4'
              } gap-4`}
            >
              {(
                [
                  { key: 'pending', title: 'Pending', next: 'preparing', nextLabel: 'Start Preparing' },
                  { key: 'preparing', title: 'Preparing', next: 'ready', nextLabel: 'Mark Ready' },
                  { key: 'ready', title: 'Ready', next: 'served', nextLabel: 'Mark Served' },
                  { key: 'served', title: 'Served (Recent)', next: null, nextLabel: '' },
                  ...(showCancelledKitchen
                    ? [{ key: 'cancelled', title: 'Cancelled', next: null, nextLabel: '' }]
                    : []),
                ] as const
              ).map((col) => {
                const colOrders = allOrders.filter((o) => o.status === col.key);
                return (
                  <div
                    key={col.key}
                    data-testid={`kitchen-col-${col.key}`}
                    className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-3"
                  >
                    <div className="flex items-center justify-between px-1">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                        {col.title}
                      </h3>
                      <span className="rounded-full bg-white border border-slate-200 px-2 py-0.5 text-xs font-bold text-slate-700">
                        {colOrders.length}
                      </span>
                    </div>

                    {colOrders.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-white/70 py-8 text-center text-xs text-slate-400">
                        No {col.title.toLowerCase()} orders
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {colOrders.map((order) => (
                          <div
                            key={order.id}
                            data-testid={`kitchen-card-${order.orderReference}`}
                            className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm space-y-2.5 text-xs"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <span className="font-mono font-bold text-indigo-700">
                                  {order.orderReference}
                                </span>
                                <div className="font-semibold text-slate-900 mt-0.5">
                                  {order.orderType === 'room_service'
                                    ? `Room ${order.roomNumber} (${order.guestName})`
                                    : order.orderType === 'restaurant'
                                      ? order.tableLabel || 'Dining Room'
                                      : `Takeaway${order.customerName ? ` • ${order.customerName}` : ''}`}
                                </div>
                              </div>
                              <FoodOrderStatusBadge status={order.status} />
                            </div>

                            <div className="flex items-center justify-between text-[11px] text-slate-500">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <FoodOrderTypeBadge orderType={order.orderType} />
                                <FoodOrderSourceBadge orderSource={order.orderSource} />
                              </div>
                              <span className="inline-flex items-center gap-1 font-medium">
                                <Clock className="h-3 w-3" />
                                {formatElapsedTime(order.placedAt, nowMs)}
                              </span>
                            </div>

                            <ul className="divide-y divide-slate-100 border-y border-slate-100 py-1.5 space-y-1.5">
                              {order.items.map((it) => (
                                <li key={it.id} className="pt-1 first:pt-0">
                                  <div className="font-semibold text-slate-800">
                                    {it.quantity}× {it.itemNameSnapshot}
                                  </div>
                                  {it.specialInstructions && (
                                    <div className="text-[11px] font-medium text-amber-800 bg-amber-50 rounded px-1.5 py-0.5 mt-0.5">
                                      ↳ {it.specialInstructions}
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>

                            {order.notes && (
                              <p className="rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1.5 text-[11px] font-medium text-amber-950">
                                Ticket Note: {order.notes}
                              </p>
                            )}

                            <div className="flex items-center justify-between gap-2 pt-1">
                              <button
                                type="button"
                                onClick={() => setDetailOrderId(order.id)}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                <Eye className="h-3.5 w-3.5" />
                                Details
                              </button>

                              {col.next && (
                                <button
                                  type="button"
                                  disabled={busyOrderActionId === order.id}
                                  onClick={() =>
                                    void handleQuickKitchenAdvance(
                                      order,
                                      col.next as 'preparing' | 'ready' | 'served'
                                    )
                                  }
                                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                                >
                                  {col.nextLabel}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 3: ORDERS & ROOM FOLIOS LEDGER                                   */}
      {/* ==================================================================== */}
      {activeTab === 'orders' && (
        <div data-testid="orders-ledger-view" className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="relative md:col-span-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                aria-label="Search food orders"
                value={filterSearch}
                onChange={(e) => setFilterSearch(e.target.value)}
                placeholder="Search order #, room, booking ref, guest, table..."
                className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-2">
              <select
                aria-label="Filter order channel"
                value={filterOrderType}
                onChange={(e) => setFilterOrderType(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Channels</option>
                {FOOD_ORDER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FOOD_ORDER_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <select
                aria-label="Filter order source"
                value={filterOrderSource}
                onChange={(e) => setFilterOrderSource(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Sources</option>
                {FOOD_ORDER_SOURCES.map((src) => (
                  <option key={src} value={src}>
                    {FOOD_ORDER_SOURCE_LABELS[src]}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <select
                aria-label="Filter kitchen status"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Statuses</option>
                {FOOD_ORDER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {FOOD_ORDER_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <select
                aria-label="Filter folio status"
                value={filterBillingStatus}
                onChange={(e) => setFilterBillingStatus(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Folio States</option>
                {FOOD_BILLING_STATUSES.map((b) => (
                  <option key={b} value={b}>
                    {FOOD_BILLING_STATUS_LABELS[b]}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-1 flex items-center justify-end">
              {(filterOrderType ||
                filterOrderSource ||
                filterStatus ||
                filterBillingStatus ||
                filterSearch) && (
                <button
                  type="button"
                  onClick={() => {
                    setFilterOrderType('');
                    setFilterOrderSource('');
                    setFilterStatus('');
                    setFilterBillingStatus('');
                    setFilterSearch('');
                  }}
                  className="inline-flex items-center gap-1 rounded-xl border border-slate-300 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {ordersLoading ? (
            <LoadingState label="Loading orders ledger..." />
          ) : allOrders.length === 0 ? (
            <EmptyState
              title="No food orders match your filter"
              description="Place a Restaurant, Takeaway, or Room Service order in New Order / POS."
            />
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden lg:block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3 text-left">Order #</th>
                      <th className="px-4 py-3 text-left">Channel & Target</th>
                      <th className="px-4 py-3 text-left">Items</th>
                      <th className="px-4 py-3 text-left">Kitchen Status</th>
                      <th className="px-4 py-3 text-left">Folio Posting</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {allOrders.map((order) => (
                      <tr key={order.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setDetailOrderId(order.id)}
                            className="font-mono text-xs font-bold text-indigo-600 hover:underline"
                          >
                            {order.orderReference}
                          </button>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            {new Date(order.placedAt).toLocaleTimeString()}
                          </div>
                        </td>

                        <td className="px-4 py-3.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <FoodOrderTypeBadge orderType={order.orderType} />
                            <FoodOrderSourceBadge orderSource={order.orderSource} />
                          </div>
                          <div className="text-xs font-medium text-slate-800 mt-1">
                            {order.orderType === 'room_service'
                              ? `Room ${order.roomNumber} • ${order.guestName}`
                              : order.orderType === 'restaurant'
                                ? order.tableLabel
                                : order.customerName || 'Takeaway Counter'}
                          </div>
                        </td>

                        <td className="px-4 py-3.5 max-w-xs">
                          <p className="text-xs text-slate-700 truncate">{order.itemsSummary}</p>
                        </td>

                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <FoodOrderStatusBadge status={order.status} />
                        </td>

                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <div className="flex flex-col items-start gap-1">
                            <FoodBillingStatusBadge status={order.billingStatus} />
                            {order.postedInvoiceId && order.postedInvoiceNumber && (
                              <Link
                                to={`/invoices/${order.postedInvoiceId}`}
                                className="font-mono text-[11px] font-semibold text-indigo-600 hover:underline"
                              >
                                {order.postedInvoiceNumber}
                              </Link>
                            )}
                          </div>
                        </td>

                        <td className="px-4 py-3.5 whitespace-nowrap text-right font-bold text-slate-900">
                          {formatMoney(order.totalAmount, order.currency)}
                        </td>

                        <td className="px-4 py-3.5 whitespace-nowrap text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {order.orderType === 'room_service' &&
                              order.status !== 'cancelled' &&
                              order.billingStatus === 'unbilled' && (
                                <button
                                  type="button"
                                  disabled={busyOrderActionId === order.id}
                                  onClick={() => void handleQuickPostToFolio(order)}
                                  className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                                >
                                  Post to Folio
                                </button>
                              )}
                            <button
                              type="button"
                              onClick={() => setDetailOrderId(order.id)}
                              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              Manage
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Cards */}
              <div className="grid grid-cols-1 gap-3 lg:hidden">
                {allOrders.map((order) => (
                  <div
                    key={order.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-2.5 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-bold text-indigo-600">
                            {order.orderReference}
                          </span>
                          <FoodOrderSourceBadge orderSource={order.orderSource} />
                        </div>
                        <p className="font-semibold text-slate-900 mt-0.5">
                          {order.orderType === 'room_service'
                            ? `Room ${order.roomNumber} • ${order.guestName}`
                            : order.tableLabel || order.customerName || 'Takeaway'}
                        </p>
                      </div>
                      <FoodOrderStatusBadge status={order.status} />
                    </div>
                    <p className="text-slate-600">{order.itemsSummary}</p>
                    <div className="flex items-center justify-between border-t border-slate-100 pt-2.5">
                      <FoodBillingStatusBadge status={order.billingStatus} />
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-slate-900">
                          {formatMoney(order.totalAmount, order.currency)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setDetailOrderId(order.id)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1 font-semibold text-slate-700"
                        >
                          Open
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 4: MENU & CATEGORIES MANAGEMENT                                  */}
      {/* ==================================================================== */}
      {activeTab === 'menu' && (
        <div data-testid="menu-management-view" className="space-y-6">
          {!isAdmin && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
              Menu catalog prices and active status are managed by property{' '}
              <strong>Administrators</strong>. Receptionists have full access to place orders,
              manage kitchen tickets, and post room-service charges to guest folios.
            </div>
          )}

          {/* Categories Strip */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-900">Food Categories</h2>
                <p className="text-xs text-slate-500">
                  Property-scoped menu sections ({categories.length})
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
              <p className="text-xs text-slate-500">
                No food categories created for this property yet.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {categories.map((cat) => (
                  <div
                    key={cat.id}
                    className={`rounded-xl border p-3.5 text-xs flex items-start justify-between gap-2 ${
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
                      <p className="text-slate-500 mt-0.5">
                        {cat.activeItemCount} active / {cat.itemCount} total items
                      </p>
                    </div>

                    {isAdmin && (
                      <div className="flex items-center gap-1">
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

          {/* Menu Items Table */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">Menu Items</h2>
                <p className="text-xs text-slate-500">
                  Price updates apply only to new orders; historical order snapshots never change.
                </p>
              </div>
              {isAdmin && (
                <button
                  type="button"
                  disabled={categories.length === 0}
                  onClick={() => {
                    setEditingMenuItem(null);
                    setMenuItemModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New Menu Item
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
              <div className="relative sm:col-span-6">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  aria-label="Search managed menu items"
                  value={menuSearch}
                  onChange={(e) => setMenuSearch(e.target.value)}
                  placeholder="Search SKU or dish name..."
                  className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2 text-sm"
                />
              </div>

              <div className="sm:col-span-4">
                <select
                  aria-label="Filter menu items by category"
                  value={menuCategoryFilter}
                  onChange={(e) => setMenuCategoryFilter(e.target.value)}
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

              <label className="sm:col-span-2 flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showInactiveMenu}
                  onChange={(e) => setShowInactiveMenu(e.target.checked)}
                  className="rounded border-slate-300 text-indigo-600"
                />
                Show Inactive
              </label>
            </div>

            {managedMenuItems.length === 0 ? (
              <EmptyState
                title="No menu items found"
                description="Add categories and menu items to make dishes orderable in POS and Room Service."
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-3.5 py-2.5 text-left">SKU & Item</th>
                      <th className="px-3.5 py-2.5 text-left">Category</th>
                      <th className="px-3.5 py-2.5 text-left">Dietary</th>
                      <th className="px-3.5 py-2.5 text-left">Recipe</th>
                      <th className="px-3.5 py-2.5 text-right">Price</th>
                      <th className="px-3.5 py-2.5 text-left">Availability</th>
                      <th className="px-3.5 py-2.5 text-left">Status</th>
                      {isAdmin && <th className="px-3.5 py-2.5 text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {managedMenuItems.map((item) => (
                      <tr key={item.id} data-testid={`managed-menu-row-${item.sku}`}>
                        <td className="px-3.5 py-3">
                          <div className="font-mono text-[11px] font-semibold text-slate-500">
                            {item.sku}
                          </div>
                          <div className="font-bold text-slate-900 text-sm">{item.name}</div>
                          {item.description && (
                            <div className="text-slate-500 mt-0.5">{item.description}</div>
                          )}
                        </td>
                        <td className="px-3.5 py-3 text-slate-700 whitespace-nowrap">
                          {item.categoryName}
                        </td>
                        <td className="px-3.5 py-3 whitespace-nowrap">
                          <DietaryBadge tag={item.dietaryTag} />
                        </td>
                        <td className="px-3.5 py-3 whitespace-nowrap">
                          {(item.ingredientCount ?? 0) > 0 ? (
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                                item.hasLowOrOutIngredient
                                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                                  : 'border-violet-200 bg-violet-50 text-violet-700'
                              }`}
                            >
                              {item.ingredientCount} ingr.
                              {item.hasLowOrOutIngredient ? ' (Low)' : ''}
                            </span>
                          ) : (
                            <span className="text-slate-400">None</span>
                          )}
                        </td>
                        <td className="px-3.5 py-3 text-right font-bold text-slate-900 whitespace-nowrap">
                          {formatMoney(item.price, currency)}
                        </td>
                        <td className="px-3.5 py-3 whitespace-nowrap">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                              item.isAvailable
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                : 'border-amber-200 bg-amber-50 text-amber-800'
                            }`}
                          >
                            {item.isAvailable ? 'Available' : 'Sold Out'}
                          </span>
                        </td>
                        <td className="px-3.5 py-3 whitespace-nowrap">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                              item.isActive
                                ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                                : 'border-slate-300 bg-slate-100 text-slate-600'
                            }`}
                          >
                            {item.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        {isAdmin && (
                          <td className="px-3.5 py-3 whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setRecipeMenuItem(item)}
                                className="rounded-lg border border-violet-200 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-100"
                              >
                                Recipe
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleToggleItemAvailability(item)}
                                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                {item.isAvailable ? 'Mark Sold Out' : 'Mark Available'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMenuItem(item);
                                  setMenuItemModalOpen(true);
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
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      <FoodCategoryModal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        propertyId={selectedProperty.id}
        editingCategory={editingCategory}
        onSaved={() => void loadCatalogAndStays()}
      />

      <FoodMenuItemModal
        open={menuItemModalOpen}
        onClose={() => setMenuItemModalOpen(false)}
        propertyId={selectedProperty.id}
        currency={currency}
        categories={categories}
        editingItem={editingMenuItem}
        onSaved={() => void loadCatalogAndStays()}
      />

      <MenuItemRecipeModal
        open={recipeMenuItem !== null}
        onClose={() => setRecipeMenuItem(null)}
        propertyId={selectedProperty.id}
        menuItem={recipeMenuItem}
        onSaved={() => void loadCatalogAndStays()}
      />

      {user && (
        <FoodOrderDetailModal
          open={detailOrderId !== null}
          onClose={() => setDetailOrderId(null)}
          orderId={detailOrderId}
          propertyId={selectedProperty.id}
          userRole={user.role}
          onUpdated={() => {
            void loadOrders();
            void loadCatalogAndStays();
          }}
        />
      )}

      {user && (
        <GuestQrConfigModal
          open={qrModalOpen}
          onClose={() => setQrModalOpen(false)}
          propertyId={selectedProperty.id}
          userRole={user.role}
        />
      )}
    </div>
  );
}
