import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Hotel,
  Minus,
  Phone,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  ShoppingBag,
  Sparkles,
  Trash2,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import {
  DIETARY_TAG_LABELS,
  FOOD_ORDER_STATUS_LABELS,
  type DietaryTag,
  type FoodOrderStatus,
} from '@shared/constants';
import { calculateFoodOrderTotals, formatMoney } from '@shared/pricing';
import type {
  PublicGuestMenuItem,
  PublicGuestMenuPayload,
  PublicGuestOrderCreateResponse,
  PublicGuestOrderView,
} from '@shared/types';
import { DietaryBadge, FoodOrderStatusBadge } from '../components/ui/StatusBadge';
import { ApiClientError, publicApiFetch } from '../lib/api';

const MAX_GUEST_CART_ITEM_QTY = 50;

interface GuestCartLine {
  item: PublicGuestMenuItem;
  quantity: number;
  specialInstructions: string;
}

interface PublicGuestOrderTrackingResponse {
  order: PublicGuestOrderView;
  trackingExpiresAt: string;
}

function createDraftIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `guest-qr-${crypto.randomUUID()}`;
  }
  return `guest-qr-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

const TRACKING_STEPS: Array<{ key: FoodOrderStatus; label: string }> = [
  { key: 'pending', label: 'Order Received' },
  { key: 'preparing', label: 'In Kitchen' },
  { key: 'ready', label: 'Ready for Room' },
  { key: 'served', label: 'Delivered' },
];

export function GuestFoodMenuPage() {
  const { qrToken = '' } = useParams<{ qrToken: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const trackParam = searchParams.get('track') ?? '';

  const [menuData, setMenuData] = useState<PublicGuestMenuPayload | null>(null);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState<{
    title: string;
    message: string;
  } | null>(null);

  // Browsing filters
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all');
  const [selectedDietary, setSelectedDietary] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Guest order inputs
  const [roomNumber, setRoomNumber] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [cart, setCart] = useState<GuestCartLine[]>([]);
  const [cartSheetOpen, setCartSheetOpen] = useState(false);
  const [draftIdempotencyKey, setDraftIdempotencyKey] = useState<string>(() =>
    createDraftIdempotencyKey()
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Active order tracking state
  const storageKey = `staycraft.guestOrder.${qrToken}`;
  const [activeTrackingToken, setActiveTrackingToken] = useState<string>(() => {
    if (trackParam) return trackParam;
    try {
      return sessionStorage.getItem(`staycraft.guestOrder.${qrToken}`) ?? '';
    } catch {
      return '';
    }
  });
  const [trackedOrder, setTrackedOrder] = useState<PublicGuestOrderView | null>(
    null
  );
  const [trackingViewOpen, setTrackingViewOpen] = useState<boolean>(
    Boolean(trackParam)
  );
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [trackingError, setTrackingError] = useState<string | null>(null);

  const loadMenu = useCallback(async () => {
    if (!qrToken) {
      setMenuError({
        title: 'Invalid QR Menu Link',
        message: 'Please scan the QR code displayed inside your hotel room.',
      });
      setMenuLoading(false);
      return;
    }

    setMenuLoading(true);
    setMenuError(null);
    try {
      const data = await publicApiFetch<PublicGuestMenuPayload>(
        `/api/public/guest-food/menu/${encodeURIComponent(qrToken)}`
      );
      setMenuData(data);
    } catch (err) {
      const apiErr = err as ApiClientError;
      const isPaused =
        apiErr.status === 403 ||
        apiErr.message.toLowerCase().includes('paused');
      setMenuError({
        title: isPaused
          ? 'In-Room QR Ordering Temporarily Paused'
          : 'Unable to Open Hotel Menu',
        message:
          apiErr.message ||
          'Please contact the front desk or room-service extension for assistance.',
      });
    } finally {
      setMenuLoading(false);
    }
  }, [qrToken]);

  useEffect(() => {
    void loadMenu();
  }, [loadMenu]);

  const fetchTrackedOrder = useCallback(
    async (tokenToFetch: string, silent = false) => {
      if (!tokenToFetch) return;
      if (!silent) {
        setTrackingLoading(true);
        setTrackingError(null);
      }
      try {
        const res = await publicApiFetch<PublicGuestOrderTrackingResponse>(
          `/api/public/guest-food/orders/${encodeURIComponent(tokenToFetch)}`
        );
        setTrackedOrder(res.order);
        setTrackingError(null);
      } catch (err) {
        const apiErr = err as ApiClientError;
        if (!silent) {
          setTrackingError(
            apiErr.message || 'Order status link has expired or is unavailable.'
          );
        }
        if (apiErr.status === 404 || apiErr.status === 410) {
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            // ignore storage errors
          }
        }
      } finally {
        if (!silent) {
          setTrackingLoading(false);
        }
      }
    },
    [storageKey]
  );

  useEffect(() => {
    if (!activeTrackingToken) return;
    void fetchTrackedOrder(activeTrackingToken);
  }, [activeTrackingToken, fetchTrackedOrder]);

  useEffect(() => {
    if (!activeTrackingToken || !trackedOrder) return;
    if (trackedOrder.status === 'served' || trackedOrder.status === 'cancelled') {
      return;
    }
    const timer = window.setInterval(() => {
      void fetchTrackedOrder(activeTrackingToken, true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [activeTrackingToken, trackedOrder, fetchTrackedOrder]);

  const filteredItems = useMemo(() => {
    if (!menuData) return [];
    const q = searchQuery.trim().toLowerCase();
    return menuData.items.filter((item) => {
      if (selectedCategoryId !== 'all' && item.categoryId !== selectedCategoryId) {
        return false;
      }
      if (selectedDietary !== 'all' && item.dietaryTag !== selectedDietary) {
        return false;
      }
      if (
        q &&
        !item.name.toLowerCase().includes(q) &&
        !item.description.toLowerCase().includes(q) &&
        !item.categoryName.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [menuData, selectedCategoryId, selectedDietary, searchQuery]);

  const groupedItems = useMemo(() => {
    if (!menuData) return [];
    return menuData.categories
      .map((category) => ({
        category,
        items: filteredItems.filter((item) => item.categoryId === category.id),
      }))
      .filter((group) => group.items.length > 0);
  }, [menuData, filteredItems]);

  const cartItemCount = useMemo(
    () => cart.reduce((acc, line) => acc + line.quantity, 0),
    [cart]
  );

  const cartTotals = useMemo(() => {
    const taxRate = menuData?.hotel.defaultTaxRate ?? 0;
    if (cart.length === 0) {
      return {
        lineSubtotals: [] as number[],
        subtotal: 0,
        taxRate,
        taxAmount: 0,
        totalAmount: 0,
      };
    }
    return calculateFoodOrderTotals(
      cart.map((line) => ({
        unitPrice: line.item.price,
        quantity: line.quantity,
      })),
      taxRate
    );
  }, [cart, menuData]);

  const getCartQuantity = (menuItemId: string): number =>
    cart.find((line) => line.item.id === menuItemId)?.quantity ?? 0;

  const updateCartQuantity = (item: PublicGuestMenuItem, delta: number) => {
    setSubmitError(null);
    setCart((prev) => {
      const existing = prev.find((line) => line.item.id === item.id);
      if (!existing) {
        if (delta <= 0) return prev;
        return [
          ...prev,
          {
            item,
            quantity: Math.min(MAX_GUEST_CART_ITEM_QTY, delta),
            specialInstructions: '',
          },
        ];
      }
      const nextQty = Math.min(MAX_GUEST_CART_ITEM_QTY, existing.quantity + delta);
      if (nextQty <= 0) {
        return prev.filter((line) => line.item.id !== item.id);
      }
      return prev.map((line) =>
        line.item.id === item.id ? { ...line, quantity: nextQty } : line
      );
    });
    setDraftIdempotencyKey(createDraftIdempotencyKey());
  };

  const updateItemInstructions = (menuItemId: string, value: string) => {
    setCart((prev) =>
      prev.map((line) =>
        line.item.id === menuItemId
          ? { ...line, specialInstructions: value }
          : line
      )
    );
    setDraftIdempotencyKey(createDraftIdempotencyKey());
  };

  const handleSubmitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!menuData) return;

    const trimmedRoom = roomNumber.trim();
    if (!trimmedRoom) {
      setSubmitError('Please enter your room number before placing the order.');
      return;
    }
    if (cart.length === 0) {
      setSubmitError('Please add at least one dish or beverage to your order.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await publicApiFetch<PublicGuestOrderCreateResponse>(
        `/api/public/guest-food/menu/${encodeURIComponent(qrToken)}/orders`,
        {
          method: 'POST',
          body: {
            roomNumber: trimmedRoom,
            items: cart.map((line) => ({
              menuItemId: line.item.id,
              quantity: line.quantity,
              specialInstructions: line.specialInstructions.trim(),
            })),
            notes: orderNotes.trim(),
            idempotencyKey: draftIdempotencyKey,
          },
        }
      );

      setCart([]);
      setOrderNotes('');
      setCartSheetOpen(false);
      setDraftIdempotencyKey(createDraftIdempotencyKey());
      setActiveTrackingToken(res.trackingToken);
      setTrackedOrder(res.order);
      setTrackingViewOpen(true);

      try {
        sessionStorage.setItem(storageKey, res.trackingToken);
      } catch {
        // ignore storage errors
      }
      setSearchParams({ track: res.trackingToken }, { replace: true });
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartNewOrder = () => {
    setTrackingViewOpen(false);
    const next = new URLSearchParams(searchParams);
    next.delete('track');
    setSearchParams(next, { replace: true });
  };

  if (menuLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4">
        <div className="h-9 w-9 animate-spin rounded-full border-3 border-indigo-200 border-t-indigo-600" />
        <p className="mt-3 text-sm font-medium text-slate-600">
          Loading in-room dining menu...
        </p>
      </div>
    );
  }

  if (menuError || !menuData) {
    return (
      <div
        data-testid="guest-qr-error-state"
        className="min-h-screen bg-slate-50 flex items-center justify-center p-4"
      >
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm text-center space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
            <AlertCircle className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">
              {menuError?.title ?? 'Menu Unavailable'}
            </h1>
            <p className="mt-1.5 text-sm text-slate-600">
              {menuError?.message ??
                'Please contact the hotel front desk for room service.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadMenu()}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const { hotel } = menuData;
  const currency = hotel.currency;

  const activeStepIdx = trackedOrder
    ? TRACKING_STEPS.findIndex((s) => s.key === trackedOrder.status)
    : -1;

  return (
    <div
      data-testid="guest-qr-menu-page"
      className="min-h-screen bg-slate-50 pb-28 text-slate-900"
    >
      {/* Hotel Header */}
      <header className="bg-slate-900 text-white">
        <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/20 border border-indigo-400/30 text-indigo-300">
                <Hotel className="h-5 w-5" />
              </div>
              <div>
                <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-indigo-300">
                  <QrCode className="h-3.5 w-3.5" />
                  In-Room Dining & Kitchen
                </div>
                <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                  {hotel.name}
                </h1>
                <p className="text-xs text-slate-300">
                  {hotel.city ? `${hotel.city} • ` : ''}
                  Pay at hotel or post to room folio
                </p>
              </div>
            </div>

            {hotel.phone && (
              <a
                href={`tel:${hotel.phone}`}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
              >
                <Phone className="h-3.5 w-3.5 text-indigo-300" />
                <span className="hidden sm:inline">Front Desk</span>
              </a>
            )}
          </div>

          {/* Active Order Banner when browsing menu */}
          {trackedOrder && !trackingViewOpen && (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-400/30 bg-emerald-500/15 px-3.5 py-2.5 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles className="h-4 w-4 shrink-0 text-emerald-300" />
                <span className="truncate font-medium text-emerald-50">
                  Order <strong>{trackedOrder.orderReference}</strong> (Room{' '}
                  {trackedOrder.roomNumber}) •{' '}
                  {FOOD_ORDER_STATUS_LABELS[trackedOrder.status]}
                </span>
              </div>
              <button
                type="button"
                data-testid="guest-qr-view-tracker-btn"
                onClick={() => setTrackingViewOpen(true)}
                className="shrink-0 rounded-lg bg-emerald-400 px-2.5 py-1 text-xs font-bold text-slate-950 hover:bg-emerald-300"
              >
                Track Status
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-5 sm:px-6 space-y-5">
        {/* ================================================================ */}
        {/* SINGLE-ORDER LIVE TRACKING VIEW                                  */}
        {/* ================================================================ */}
        {trackingViewOpen && (
          <section
            data-testid="guest-qr-order-tracker"
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    {trackedOrder
                      ? `Order ${trackedOrder.orderReference}`
                      : 'Order Status'}
                  </h2>
                  <p className="text-xs text-slate-500">
                    {trackedOrder
                      ? `Room ${trackedOrder.roomNumber} • Placed ${new Date(
                          trackedOrder.placedAt
                        ).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}`
                      : 'Checking live kitchen status...'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {activeTrackingToken && (
                  <button
                    type="button"
                    disabled={trackingLoading}
                    onClick={() => void fetchTrackedOrder(activeTrackingToken)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${
                        trackingLoading ? 'animate-spin' : ''
                      }`}
                    />
                    Refresh
                  </button>
                )}
              </div>
            </div>

            {trackingError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800">
                {trackingError}
              </div>
            )}

            {trackedOrder && (
              <>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-600">
                      Current Kitchen Status
                    </span>
                    <FoodOrderStatusBadge status={trackedOrder.status} />
                  </div>

                  {trackedOrder.status === 'cancelled' ? (
                    <p className="text-xs font-medium text-rose-700">
                      This order was cancelled. Please contact the front desk if you
                      need assistance.
                    </p>
                  ) : (
                    <div className="grid grid-cols-4 gap-2 pt-1">
                      {TRACKING_STEPS.map((step, idx) => {
                        const completed = idx <= activeStepIdx;
                        return (
                          <div key={step.key} className="space-y-1.5">
                            <div
                              className={`h-2 rounded-full transition-colors ${
                                completed ? 'bg-emerald-500' : 'bg-slate-200'
                              }`}
                            />
                            <p
                              className={`text-[11px] font-semibold leading-tight ${
                                completed ? 'text-slate-900' : 'text-slate-400'
                              }`}
                            >
                              {step.label}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Itemized Summary */}
                <div className="space-y-2.5 text-xs">
                  <h3 className="font-bold uppercase tracking-wider text-slate-500 text-[11px]">
                    Order Summary
                  </h3>
                  <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 px-3.5">
                    {trackedOrder.items.map((line, index) => (
                      <li
                        key={`${line.itemName}-${index}`}
                        className="flex items-start justify-between gap-3 py-2.5"
                      >
                        <div>
                          <span className="font-semibold text-slate-900">
                            {line.quantity}× {line.itemName}
                          </span>
                          {line.specialInstructions && (
                            <p className="text-[11px] text-amber-800 mt-0.5">
                              Note: {line.specialInstructions}
                            </p>
                          )}
                        </div>
                        <span className="font-semibold text-slate-800">
                          {formatMoney(line.lineSubtotal, trackedOrder.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {trackedOrder.notes && (
                    <p className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-amber-900">
                      Delivery note: {trackedOrder.notes}
                    </p>
                  )}

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-1.5">
                    <div className="flex justify-between text-slate-600">
                      <span>Subtotal</span>
                      <span>
                        {formatMoney(trackedOrder.subtotal, trackedOrder.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-600">
                      <span>
                        {trackedOrder.taxName} ({trackedOrder.taxRate}%)
                      </span>
                      <span>
                        {formatMoney(trackedOrder.taxAmount, trackedOrder.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-slate-200 pt-1.5 text-sm font-bold text-slate-900">
                      <span>Total (Pay at Hotel / Room Folio)</span>
                      <span>
                        {formatMoney(
                          trackedOrder.totalAmount,
                          trackedOrder.currency
                        )}
                      </span>
                    </div>
                    <p className="pt-1 text-[11px] text-slate-500">
                      {trackedOrder.paymentNotice}
                    </p>
                  </div>
                </div>
              </>
            )}

            <div className="pt-1 flex justify-end">
              <button
                type="button"
                data-testid="guest-qr-back-to-menu-btn"
                onClick={handleStartNewOrder}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700"
              >
                <UtensilsCrossed className="h-3.5 w-3.5" />
                Browse Menu / Order More
              </button>
            </div>
          </section>
        )}

        {/* ================================================================ */}
        {/* MENU BROWSING & ROOM INPUT                                       */}
        {/* ================================================================ */}
        {!trackingViewOpen && (
          <>
            {/* Room Number Card */}
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <label
                    htmlFor="guest-qr-room-number"
                    className="block text-xs font-bold uppercase tracking-wider text-slate-700"
                  >
                    Your Room Number
                  </label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Orders are verified against active checked-in rooms at{' '}
                    {hotel.name}.
                  </p>
                </div>
                <input
                  id="guest-qr-room-number"
                  data-testid="guest-qr-room-input"
                  type="text"
                  inputMode="text"
                  maxLength={30}
                  value={roomNumber}
                  onChange={(e) => {
                    setRoomNumber(e.target.value);
                    setSubmitError(null);
                  }}
                  placeholder="e.g. 101"
                  className="w-full sm:w-44 rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm font-semibold text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>
            </section>

            {/* Search & Category / Dietary Filters */}
            <section className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="search"
                  aria-label="Search menu items"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search dishes, beverages, breakfast..."
                  className="w-full rounded-2xl border border-slate-200 bg-white pl-10 pr-4 py-2.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none"
                />
              </div>

              {menuData.categories.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  <button
                    type="button"
                    onClick={() => setSelectedCategoryId('all')}
                    className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                      selectedCategoryId === 'all'
                        ? 'bg-slate-900 text-white'
                        : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    All Categories
                  </button>
                  {menuData.categories.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setSelectedCategoryId(cat.id)}
                      className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                        selectedCategoryId === cat.id
                          ? 'bg-slate-900 text-white'
                          : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                {(['all', 'veg', 'non_veg', 'vegan', 'beverage'] as const).map(
                  (tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setSelectedDietary(tag)}
                      className={`shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-semibold border transition-colors ${
                        selectedDietary === tag
                          ? 'border-indigo-600 bg-indigo-50 text-indigo-800'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {tag === 'all'
                        ? 'All Dietary'
                        : DIETARY_TAG_LABELS[tag as DietaryTag]}
                    </button>
                  )
                )}
              </div>
            </section>

            {/* Menu Sections */}
            {menuData.items.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center space-y-2">
                <UtensilsCrossed className="mx-auto h-8 w-8 text-slate-400" />
                <h2 className="text-sm font-bold text-slate-800">
                  Kitchen Menu Currently Closed
                </h2>
                <p className="text-xs text-slate-500">
                  No menu items are currently available for self-service ordering.
                  Please call the front desk for assistance.
                </p>
              </div>
            ) : groupedItems.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
                No menu items match your search or dietary filter.
              </div>
            ) : (
              <div className="space-y-6">
                {groupedItems.map(({ category, items }) => (
                  <section key={category.id} className="space-y-3">
                    <div>
                      <h2 className="text-base font-bold text-slate-900">
                        {category.name}
                      </h2>
                      {category.description && (
                        <p className="text-xs text-slate-500">
                          {category.description}
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                      {items.map((item) => {
                        const qty = getCartQuantity(item.id);
                        return (
                          <div
                            key={item.id}
                            data-testid={`guest-menu-item-${item.id}`}
                            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm flex items-start justify-between gap-4"
                          >
                            <div className="space-y-1.5 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <DietaryBadge tag={item.dietaryTag} />
                                {item.prepTimeMinutes && (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500">
                                    <Clock className="h-3 w-3" />
                                    ~{item.prepTimeMinutes}m
                                  </span>
                                )}
                              </div>
                              <h3 className="text-sm font-bold text-slate-900">
                                {item.name}
                              </h3>
                              {item.description && (
                                <p className="text-xs text-slate-500 leading-relaxed">
                                  {item.description}
                                </p>
                              )}
                              <p className="pt-0.5 text-sm font-bold text-slate-900">
                                {formatMoney(item.price, currency)}
                              </p>
                            </div>

                            <div className="shrink-0 self-center">
                              {qty === 0 ? (
                                <button
                                  type="button"
                                  data-testid={`guest-add-item-${item.id}`}
                                  onClick={() => updateCartQuantity(item, 1)}
                                  className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-100"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  Add
                                </button>
                              ) : (
                                <div className="inline-flex items-center rounded-xl border border-indigo-600 bg-indigo-600 text-white shadow-sm">
                                  <button
                                    type="button"
                                    aria-label={`Decrease ${item.name}`}
                                    onClick={() => updateCartQuantity(item, -1)}
                                    className="px-2.5 py-2 hover:bg-indigo-700 rounded-l-xl"
                                  >
                                    <Minus className="h-3.5 w-3.5" />
                                  </button>
                                  <span
                                    data-testid={`guest-item-qty-${item.id}`}
                                    className="px-2.5 text-xs font-bold"
                                  >
                                    {qty}
                                  </span>
                                  <button
                                    type="button"
                                    disabled={qty >= MAX_GUEST_CART_ITEM_QTY}
                                    aria-label={`Increase ${item.name}`}
                                    onClick={() => updateCartQuantity(item, 1)}
                                    className="px-2.5 py-2 hover:bg-indigo-700 rounded-r-xl disabled:opacity-40"
                                  >
                                    <Plus className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* Sticky Bottom Cart Bar */}
      {!trackingViewOpen && cartItemCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur px-4 py-3 shadow-lg">
          <div className="mx-auto max-w-3xl flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-slate-500">
                {cartItemCount} {cartItemCount === 1 ? 'item' : 'items'} • Est. incl.{' '}
                {hotel.taxName}
              </p>
              <p className="text-base font-bold text-slate-900">
                {formatMoney(cartTotals.totalAmount, currency)}
              </p>
            </div>
            <button
              type="button"
              data-testid="guest-open-cart-btn"
              onClick={() => {
                setSubmitError(null);
                setCartSheetOpen(true);
              }}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white shadow-sm hover:bg-indigo-700"
            >
              <ShoppingBag className="h-4 w-4" />
              Review & Place Order
            </button>
          </div>
        </div>
      )}

      {/* Checkout / Order Review Drawer Modal */}
      {cartSheetOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 p-0 sm:p-4">
          <div
            data-testid="guest-cart-modal"
            className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl bg-white p-5 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Confirm Room-Service Order
                </h2>
                <p className="text-xs text-slate-500">{hotel.name}</p>
              </div>
              <button
                type="button"
                aria-label="Close order review"
                onClick={() => setCartSheetOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitOrder} className="space-y-4">
              {submitError && (
                <div
                  data-testid="guest-order-error"
                  className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800"
                >
                  {submitError}
                </div>
              )}

              <div>
                <label
                  htmlFor="checkout-room-number"
                  className="block text-xs font-bold text-slate-700 mb-1"
                >
                  Room Number *
                </label>
                <input
                  id="checkout-room-number"
                  data-testid="guest-checkout-room-input"
                  type="text"
                  required
                  maxLength={30}
                  value={roomNumber}
                  onChange={(e) => {
                    setRoomNumber(e.target.value);
                    setSubmitError(null);
                  }}
                  placeholder="Enter your checked-in room number (e.g. 101)"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-semibold text-slate-900 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              {/* Cart Lines */}
              <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                {cart.map((line, index) => (
                  <div
                    key={line.item.id}
                    className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 space-y-2 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-slate-900">
                          {line.item.name}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {formatMoney(line.item.price, currency)} each
                        </p>
                      </div>
                      <span className="font-bold text-slate-900">
                        {formatMoney(
                          cartTotals.lineSubtotals[index] ?? 0,
                          currency
                        )}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="inline-flex items-center rounded-lg border border-slate-300 bg-white">
                        <button
                          type="button"
                          onClick={() => updateCartQuantity(line.item, -1)}
                          className="p-1.5 text-slate-600 hover:bg-slate-100"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="px-2.5 font-bold text-slate-900">
                          {line.quantity}
                        </span>
                        <button
                          type="button"
                          disabled={line.quantity >= MAX_GUEST_CART_ITEM_QTY}
                          onClick={() => updateCartQuantity(line.item, 1)}
                          className="p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>

                      <input
                        type="text"
                        maxLength={300}
                        value={line.specialInstructions}
                        onChange={(e) =>
                          updateItemInstructions(line.item.id, e.target.value)
                        }
                        placeholder="Item note (less spicy, no ice...)"
                        className="flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                      />

                      <button
                        type="button"
                        aria-label={`Remove ${line.item.name}`}
                        onClick={() =>
                          updateCartQuantity(line.item, -line.quantity)
                        }
                        className="p-1 text-slate-400 hover:text-rose-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <label
                  htmlFor="checkout-order-notes"
                  className="block text-xs font-bold text-slate-700 mb-1"
                >
                  Delivery / Dietary Instructions (Optional)
                </label>
                <input
                  id="checkout-order-notes"
                  type="text"
                  maxLength={500}
                  value={orderNotes}
                  onChange={(e) => setOrderNotes(e.target.value)}
                  placeholder="Extra cutlery, allergy note, knock lightly..."
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                />
              </div>

              {/* Totals */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-1.5 text-xs">
                <div className="flex justify-between text-slate-600">
                  <span>Items Subtotal</span>
                  <span>{formatMoney(cartTotals.subtotal, currency)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>
                    {hotel.taxName} ({hotel.defaultTaxRate}%)
                  </span>
                  <span>{formatMoney(cartTotals.taxAmount, currency)}</span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-1.5 text-sm font-bold text-slate-900">
                  <span>Total Payable at Hotel</span>
                  <span>{formatMoney(cartTotals.totalAmount, currency)}</span>
                </div>
                <p className="pt-1 text-[11px] text-slate-500">
                  No online payment required. Charges are settled at the hotel or
                  posted to your room folio.
                </p>
              </div>

              <button
                type="submit"
                data-testid="guest-submit-order-btn"
                disabled={submitting || cart.length === 0}
                className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {submitting
                  ? 'Sending Order to Kitchen...'
                  : 'Place Room-Service Order'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
