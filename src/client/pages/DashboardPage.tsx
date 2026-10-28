import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  BedDouble,
  CalendarPlus,
  CalendarRange,
  DoorOpen,
  LogIn,
  LogOut,
  Percent,
  Sparkles,
  TrendingUp,
  UserPlus,
  Users,
  ArrowRight,
  AlertTriangle,
  Clock,
  Footprints,
  QrCode,
  UtensilsCrossed,
} from 'lucide-react';
import { BOOKING_SOURCE_LABELS } from '@shared/constants';
import { formatDisplayDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type {
  DashboardSummary,
  FoodOrderListItem,
  ReservationDetail,
  ReservationListItem,
} from '@shared/types';
import { ReservationFormModal } from '../components/reservations/ReservationFormModal';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import {
  FoodOrderSourceBadge,
  FoodOrderStatusBadge,
  FoodOrderTypeBadge,
  HousekeepingBadge,
  ReservationStatusBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch } from '../lib/api';

export function DashboardPage() {
  const { selectedProperty } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeMovementTab, setActiveMovementTab] = useState<
    'arrivals' | 'departures' | 'overdue' | 'inhouse'
  >('arrivals');
  const [modalMode, setModalMode] = useState<'create' | 'walk_in' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    if (!selectedProperty) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<DashboardSummary>('/api/dashboard', {
        propertyId: selectedProperty.id,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  }, [selectedProperty?.id]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const handleQuickCheckIn = async (resItem: ReservationListItem) => {
    if (!selectedProperty) return;
    setBusyId(resItem.id);
    try {
      await apiFetch<{ reservation: ReservationDetail }>(`/api/reservations/${resItem.id}/check-in`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: {},
      });
      showToast('success', `Checked in ${resItem.guestName} (Room ${resItem.roomNumber ?? ''}).`);
      await loadDashboard();
    } catch (err) {
      if (err instanceof ApiClientError) {
        showToast('error', err.message);
        navigate(`/reservations/${resItem.id}`);
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleQuickCheckOut = async (resItem: ReservationListItem) => {
    if (!selectedProperty) return;
    setBusyId(resItem.id);
    try {
      await apiFetch<{ reservation: ReservationDetail }>(`/api/reservations/${resItem.id}/check-out`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: {},
      });
      showToast('success', `Checked out ${resItem.guestName}; Room ${resItem.roomNumber ?? ''} marked Dirty.`);
      await loadDashboard();
    } catch (err) {
      if (err instanceof ApiClientError) {
        showToast('error', err.message);
        navigate(`/reservations/${resItem.id}`);
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleQuickAdvanceFoodOrder = async (
    order: FoodOrderListItem,
    nextStatus: 'preparing' | 'ready' | 'served'
  ) => {
    if (!selectedProperty) return;
    setBusyId(order.id);
    try {
      await apiFetch(`/api/restaurant/orders/${order.id}/status`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: { status: nextStatus },
      });
      showToast(
        'success',
        `Order ${order.orderReference} moved to ${nextStatus}.`
      );
      await loadDashboard();
    } catch (err) {
      showToast(
        'error',
        err instanceof ApiClientError
          ? err.message
          : 'Unable to update food order status.'
      );
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !data) return <LoadingState label="Loading live front-office metrics..." />;
  if (error && !data) return <ErrorAlert message={error} onRetry={loadDashboard} />;
  if (!data || !selectedProperty) return null;

  const { metrics, housekeepingCounts } = data;
  const currency = data.property.currency;

  const overdueCheckOuts = data.overdueCheckOuts ?? [];

  const movementItems =
    activeMovementTab === 'arrivals'
      ? data.todayArrivals
      : activeMovementTab === 'departures'
        ? data.todayDepartures
        : activeMovementTab === 'overdue'
          ? overdueCheckOuts
          : data.inHouseStays;

  return (
    <div className="space-y-6">
      {/* Top Header & Quick Shortcuts */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-indigo-600 mb-1">
            <Clock className="h-3.5 w-3.5" />
            <span>
              Property Date: {formatDisplayDate(data.propertyToday)} ({data.property.timezone})
            </span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Front Office Dashboard
          </h1>
          <p className="text-sm text-slate-500">
            Live room availability, guest movements, and stay revenue for {data.property.name}.
          </p>
        </div>

        {/* Shortcut Bar */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setModalMode('create')}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
          >
            <CalendarPlus className="h-4 w-4" />
            New Reservation
          </button>
          <button
            type="button"
            onClick={() => setModalMode('walk_in')}
            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-3.5 py-2 text-xs sm:text-sm font-semibold text-emerald-900 hover:bg-emerald-100"
          >
            <Footprints className="h-4 w-4 text-emerald-700" />
            Walk-In
          </button>
          <button
            type="button"
            onClick={() => navigate('/calendar')}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <CalendarRange className="h-4 w-4 text-indigo-600" />
            Room Calendar
          </button>
          <button
            type="button"
            onClick={() => navigate('/guests?new=1')}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <UserPlus className="h-4 w-4 text-slate-500" />
            Register Guest
          </button>
          <button
            type="button"
            onClick={() => navigate('/rooms')}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <BedDouble className="h-4 w-4 text-slate-500" />
            Manage Rooms
          </button>
        </div>
      </div>

      {/* KPI Cards Grid (BookOne-inspired operational overview) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-4">
        {/* 1. Occupancy % */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Occupancy
            </span>
            <div className="rounded-lg bg-indigo-50 p-2 text-indigo-600">
              <Percent className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3">
            <p className="text-2xl font-bold text-slate-900">{metrics.occupancyPercentage}%</p>
            <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-indigo-600 transition-all"
                style={{ width: `${Math.min(100, metrics.occupancyPercentage)}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              {metrics.occupiedRooms} of {metrics.sellableRooms} sellable rooms
            </p>
          </div>
        </div>

        {/* 2. Available vs Occupied Rooms */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Room Inventory
            </span>
            <div className="rounded-lg bg-teal-50 p-2 text-teal-600">
              <DoorOpen className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3">
            <p className="text-2xl font-bold text-slate-900">
              {metrics.availableRooms}{' '}
              <span className="text-sm font-medium text-slate-500">avail</span>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {metrics.totalRooms} total • {metrics.occupiedRooms} occupied
              {metrics.unavailableOperationalRooms > 0
                ? ` • ${metrics.unavailableOperationalRooms} OOS`
                : ''}
            </p>
          </div>
        </div>

        {/* 3. Today's Arrivals */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Arrivals Today
            </span>
            <div className="rounded-lg bg-sky-50 p-2 text-sky-600">
              <LogIn className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3">
            <p className="text-2xl font-bold text-slate-900">{metrics.arrivalsTodayTotal}</p>
            <p className="mt-1 text-xs text-slate-500">
              {metrics.arrivalsPendingCheckIn} pending • {metrics.arrivalsCheckedIn} arrived
            </p>
          </div>
        </div>

        {/* 4. Today's Departures */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Departures Today
            </span>
            <div className="rounded-lg bg-amber-50 p-2 text-amber-600">
              <LogOut className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3">
            <p className="text-2xl font-bold text-slate-900">{metrics.departuresTodayTotal}</p>
            <p className="mt-1 text-xs text-slate-500">
              {metrics.departuresPendingCheckOut} due out • {metrics.departuresCheckedOut} departed
            </p>
            {metrics.overdueCheckOutsCount > 0 && (
              <p className="mt-1 text-xs font-semibold text-rose-600">
                {metrics.overdueCheckOutsCount} overdue past departure
              </p>
            )}
          </div>
        </div>

        {/* 5. Active Bookings */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Active Bookings
            </span>
            <div className="rounded-lg bg-violet-50 p-2 text-violet-600">
              <Users className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3">
            <p className="text-2xl font-bold text-slate-900">{metrics.activeBookingsCount}</p>
            <p className="mt-1 text-xs text-slate-500">
              {metrics.inHouseGuestsCount} guest{metrics.inHouseGuestsCount === 1 ? '' : 's'} currently in-house
            </p>
          </div>
        </div>

        {/* 6. Reservation-backed Revenue */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Tonight Room Rev
            </span>
            <div className="rounded-lg bg-emerald-50 p-2 text-emerald-600">
              <TrendingUp className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-3">
            <p className="text-xl font-bold text-slate-900 truncate">
              {formatMoney(metrics.tonightInHouseRoomRevenue, currency)}
            </p>
            <p
              className="mt-1 text-xs text-slate-500 truncate"
              title="Sum of estimated_total for non-cancelled bookings arriving this month"
            >
              Month booked: {formatMoney(metrics.currentMonthConfirmedBookingValue, currency)}
            </p>
          </div>
        </div>
      </div>

      {/* Urgent Overdue Check-Outs Section (distinct from normal Departures Today) */}
      {overdueCheckOuts.length > 0 && (
        <div
          role="region"
          aria-label="Overdue check-outs requiring resolution"
          className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4 sm:p-5 shadow-xs space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-rose-900">
              <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
              <h2 className="text-sm font-bold">
                Overdue Check-Outs Requiring Resolution ({overdueCheckOuts.length})
              </h2>
            </div>
            <Link
              to="/reservations?quickFilter=overdue_checkouts"
              className="text-xs font-semibold text-rose-700 hover:text-rose-900 inline-flex items-center gap-1"
            >
              View in Reservations <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <p className="text-xs text-rose-800">
            These stays are still Checked In past their scheduled departure date ({data.propertyToday}{' '}
            in {data.property.timezone}). Rooms remain occupied until staff deliberately extend the
            stay or update the departure date and complete check-out.
          </p>
          <div className="divide-y divide-rose-200/70 rounded-xl border border-rose-200 bg-white px-4">
            {overdueCheckOuts.map((item) => (
              <div
                key={item.id}
                className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      to={`/reservations/${item.id}`}
                      className="text-sm font-semibold text-slate-900 hover:text-indigo-600"
                    >
                      {item.guestName}
                    </Link>
                    <span className="rounded-full bg-rose-100 border border-rose-200 px-2 py-0.5 text-[11px] font-semibold text-rose-800">
                      Overdue Check-Out
                    </span>
                    <span className="text-xs font-mono text-slate-400">
                      {item.bookingReference}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    Room <strong>{item.roomNumber ?? 'Unassigned'}</strong> ({item.roomTypeName}) •
                    Scheduled Departure:{' '}
                    <strong className="text-rose-700">
                      {formatDisplayDate(item.departureDate)}
                    </strong>
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Link
                    to={`/reservations/${item.id}`}
                    className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
                  >
                    Resolve &amp; Check Out
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Middle Split: Front Desk Movements + Room Status Rack */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 7 Cols: Today's Movements */}
        <div className="lg:col-span-7 rounded-2xl border border-slate-200 bg-white shadow-xs flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <h2 className="text-base font-semibold text-slate-900">Today&apos;s Front Desk Deskboard</h2>
            <div className="inline-flex rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setActiveMovementTab('arrivals')}
                className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
                  activeMovementTab === 'arrivals'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Arrivals ({data.todayArrivals.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveMovementTab('departures')}
                className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
                  activeMovementTab === 'departures'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Departures ({data.todayDepartures.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveMovementTab('overdue')}
                className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
                  activeMovementTab === 'overdue'
                    ? 'bg-white text-rose-700 shadow-xs'
                    : overdueCheckOuts.length > 0
                      ? 'text-rose-700 hover:text-rose-900'
                      : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Overdue ({overdueCheckOuts.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveMovementTab('inhouse')}
                className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
                  activeMovementTab === 'inhouse'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                In-House ({data.inHouseStays.length})
              </button>
            </div>
          </div>

          <div className="p-5 flex-1">
            {movementItems.length === 0 ? (
              <EmptyState
                title={`No ${
                  activeMovementTab === 'inhouse'
                    ? 'in-house guests'
                    : activeMovementTab === 'overdue'
                      ? 'overdue check-outs'
                      : `${activeMovementTab} scheduled today`
                }`}
                description="Bookings matching the selected front-desk movement category will appear here."
              />
            ) : (
              <div className="divide-y divide-slate-100">
                {movementItems.map((item) => (
                  <div
                    key={item.id}
                    className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          to={`/reservations/${item.id}`}
                          className="text-sm font-semibold text-slate-900 hover:text-indigo-600 truncate"
                        >
                          {item.guestName}
                        </Link>
                        <ReservationStatusBadge status={item.status} />
                        {item.status === 'checked_in' && item.departureDate < data.propertyToday && (
                          <span className="rounded-full bg-rose-100 border border-rose-200 px-2 py-0.5 text-[11px] font-semibold text-rose-800">
                            Overdue
                          </span>
                        )}
                        <span className="text-xs font-mono text-slate-400">
                          {item.bookingReference}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                        <span>
                          Room <strong>{item.roomNumber ?? 'Unassigned'}</strong> ({item.roomTypeName})
                        </span>
                        <span>•</span>
                        <span>
                          {formatDisplayDate(item.arrivalDate)} → {formatDisplayDate(item.departureDate)}
                        </span>
                        {item.roomHousekeepingStatus && (
                          <>
                            <span>•</span>
                            <HousekeepingBadge status={item.roomHousekeepingStatus} />
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {(item.status === 'pending' || item.status === 'confirmed') &&
                        item.arrivalDate === data.propertyToday && (
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => void handleQuickCheckIn(item)}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            {busyId === item.id ? '...' : 'Check In'}
                          </button>
                        )}
                      {item.status === 'checked_in' &&
                        item.departureDate === data.propertyToday && (
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => void handleQuickCheckOut(item)}
                            className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                          >
                            {busyId === item.id ? '...' : 'Check Out'}
                          </button>
                        )}
                      {item.status === 'checked_in' &&
                        item.departureDate < data.propertyToday && (
                          <Link
                            to={`/reservations/${item.id}`}
                            className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
                          >
                            Resolve Stay
                          </Link>
                        )}
                      <Link
                        to={`/reservations/${item.id}`}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Details
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right 5 Cols: Live Room Rack & Housekeeping Summary */}
        <div className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white shadow-xs flex flex-col">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-600" />
              <h2 className="text-base font-semibold text-slate-900">Room Rack & Housekeeping</h2>
            </div>
            <Link
              to="/housekeeping"
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1"
            >
              Full Board <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="p-5 space-y-4">
            {/* Housekeeping Status Pill Summary */}
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-2.5">
                <p className="text-lg font-bold text-emerald-800">{housekeepingCounts.inspected}</p>
                <p className="text-[11px] font-medium text-emerald-700">Inspected</p>
              </div>
              <div className="rounded-xl bg-sky-50 border border-sky-100 p-2.5">
                <p className="text-lg font-bold text-sky-800">{housekeepingCounts.clean}</p>
                <p className="text-[11px] font-medium text-sky-700">Clean</p>
              </div>
              <div className="rounded-xl bg-amber-50 border border-amber-100 p-2.5">
                <p className="text-lg font-bold text-amber-800">{housekeepingCounts.dirty}</p>
                <p className="text-[11px] font-medium text-amber-700">Dirty</p>
              </div>
              <div className="rounded-xl bg-rose-50 border border-rose-100 p-2.5">
                <p className="text-lg font-bold text-rose-800">{housekeepingCounts.out_of_service}</p>
                <p className="text-[11px] font-medium text-rose-700">Maint/OOS</p>
              </div>
            </div>

            {/* Phase 2 Live Room-Operations Indicators */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2 text-xs">
              <Link
                to="/housekeeping?tab=tasks"
                className="font-medium text-slate-700 hover:text-indigo-600"
              >
                Open HK Tasks: <strong>{metrics.openHousekeepingTasksCount}</strong>
              </Link>
              <span className="text-slate-300">•</span>
              <Link
                to="/housekeeping"
                className="font-medium text-violet-700 hover:underline"
              >
                Cleaning in Progress: <strong>{metrics.cleaningInProgressRoomsCount}</strong>
              </Link>
              <span className="text-slate-300">•</span>
              <Link
                to="/housekeeping?tab=maintenance"
                className="font-medium text-orange-800 hover:underline"
              >
                Active Maint: <strong>{metrics.openMaintenanceRequestsCount}</strong>
              </Link>
            </div>

            {metrics.affectedStaysOnUnavailableRoomsCount > 0 && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900 flex items-center justify-between gap-2">
                <span className="font-semibold">
                  {metrics.affectedStaysOnUnavailableRoomsCount} stay(s) assigned to unavailable
                  room(s)
                </span>
                <Link to="/reservations" className="font-bold text-rose-700 hover:underline">
                  Reassign →
                </Link>
              </div>
            )}

            {/* Compact Room Rack Cards (inspired by BookOne room status tiles) */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-72 overflow-y-auto pr-1">
              {data.roomRack.map((rm) => {
                const isOos =
                  rm.operationalStatus !== 'available' || rm.housekeepingStatus === 'out_of_service';
                const cardStyle = isOos
                  ? 'border-rose-200 bg-rose-50/50'
                  : rm.isOccupied
                    ? 'border-indigo-200 bg-indigo-50/50'
                    : rm.housekeepingStatus === 'dirty'
                      ? 'border-amber-200 bg-amber-50/40'
                      : 'border-slate-200 bg-white';

                return (
                  <button
                    key={rm.id}
                    type="button"
                    onClick={() =>
                      rm.currentOccupancy
                        ? navigate(`/reservations/${rm.currentOccupancy.reservationId}`)
                        : navigate('/housekeeping')
                    }
                    className={`rounded-xl border p-2.5 text-left hover:shadow-xs transition-all ${cardStyle}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-bold text-slate-900">#{rm.roomNumber}</span>
                      <span className="text-[10px] font-semibold uppercase text-slate-500">
                        {rm.roomTypeCode}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] font-medium truncate text-slate-700">
                      {isOos
                        ? 'Out of Service'
                        : rm.currentOccupancy
                          ? rm.currentOccupancy.guestName
                          : 'Vacant'}
                    </p>
                    <div className="mt-1.5">
                      <HousekeepingBadge
                        status={rm.housekeepingStatus}
                        cleaningInProgress={rm.cleaningInProgress}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Active Food & Room-Service Orders (POS + Guest QR) */}
      <div
        data-testid="dashboard-food-orders-panel"
        className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
              <UtensilsCrossed className="h-4 w-4" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-slate-900">
                  Active Food &amp; Room-Service Orders
                </h2>
                {data.foodOrdersSummary &&
                  data.foodOrdersSummary.activeGuestQrCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                      <QrCode className="h-3 w-3" />
                      {data.foodOrdersSummary.activeGuestQrCount} Guest QR Active
                    </span>
                  )}
              </div>
              <p className="text-xs text-slate-500">
                Live kitchen &amp; in-room QR orders requiring preparation, delivery,
                or folio posting
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {data.foodOrdersSummary && (
              <div className="hidden sm:flex items-center gap-1.5 text-xs">
                <span className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 font-semibold text-amber-800">
                  {data.foodOrdersSummary.pendingCount} Pending
                </span>
                <span className="rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1 font-semibold text-violet-800">
                  {data.foodOrdersSummary.preparingCount} Preparing
                </span>
                <span className="rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1 font-semibold text-sky-800">
                  {data.foodOrdersSummary.readyCount} Ready
                </span>
              </div>
            )}
            <Link
              to="/restaurant?qr=1"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <QrCode className="h-3.5 w-3.5 text-indigo-600" />
              Hotel QR
            </Link>
            <Link
              to="/restaurant?tab=kitchen"
              className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800"
            >
              Open Kitchen Board <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {!data.activeFoodOrders || data.activeFoodOrders.length === 0 ? (
          <div className="px-5 py-6 text-center text-xs text-slate-500">
            No pending, preparing, or ready kitchen orders right now. Guest QR and
            POS orders appear here automatically.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {data.activeFoodOrders.map((fo) => {
              const nextAction =
                fo.status === 'pending'
                  ? ({ status: 'preparing', label: 'Start Prep' } as const)
                  : fo.status === 'preparing'
                    ? ({ status: 'ready', label: 'Mark Ready' } as const)
                    : fo.status === 'ready'
                      ? ({ status: 'served', label: 'Mark Served' } as const)
                      : null;

              return (
                <div
                  key={fo.id}
                  data-testid={`dashboard-food-order-${fo.orderReference}`}
                  className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/70"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to="/restaurant?tab=kitchen"
                        className="font-mono text-xs font-bold text-indigo-600 hover:underline"
                      >
                        {fo.orderReference}
                      </Link>
                      <FoodOrderTypeBadge orderType={fo.orderType} />
                      <FoodOrderSourceBadge orderSource={fo.orderSource} />
                      <FoodOrderStatusBadge status={fo.status} />
                    </div>
                    <p className="text-xs font-medium text-slate-900">
                      {fo.orderType === 'room_service'
                        ? `Room ${fo.roomNumber ?? '—'}${
                            fo.guestName ? ` • ${fo.guestName}` : ''
                          }`
                        : fo.orderType === 'restaurant'
                          ? fo.tableLabel || 'Dining Room'
                          : fo.customerName || 'Takeaway'}
                      <span className="text-slate-400"> • </span>
                      <span className="text-slate-600 font-normal">
                        {fo.itemsSummary}
                      </span>
                    </p>
                  </div>

                  <div className="flex items-center gap-2.5 shrink-0">
                    <span className="text-xs font-bold text-slate-900">
                      {formatMoney(fo.totalAmount, fo.currency)}
                    </span>
                    {nextAction && (
                      <button
                        type="button"
                        disabled={busyId === fo.id}
                        onClick={() =>
                          void handleQuickAdvanceFoodOrder(fo, nextAction.status)
                        }
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {nextAction.label}
                      </button>
                    )}
                    <Link
                      to="/restaurant?tab=orders"
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      Manage
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Bookings Table */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Recent Reservations</h2>
            <p className="text-xs text-slate-500">
              Latest bookings recorded in PostgreSQL (estimated stay totals include configured tax)
            </p>
          </div>
          <Link
            to="/reservations"
            className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800"
          >
            View All Reservations <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {data.recentBookings.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="No reservations yet"
              description="Create your first reservation or walk-in booking to populate front-office activity."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-100">
                <tr>
                  <th className="px-5 py-3">Booking Ref</th>
                  <th className="px-5 py-3">Guest Name</th>
                  <th className="px-5 py-3">Room</th>
                  <th className="px-5 py-3">Arrival</th>
                  <th className="px-5 py-3">Departure</th>
                  <th className="px-5 py-3">Source</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Estimated Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.recentBookings.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-5 py-3 font-mono text-xs font-semibold text-indigo-600">
                      <Link to={`/reservations/${b.id}`} className="hover:underline">
                        {b.bookingReference}
                      </Link>
                    </td>
                    <td className="px-5 py-3 font-medium text-slate-900">{b.guestName}</td>
                    <td className="px-5 py-3 text-slate-600">
                      {b.roomNumber ? `${b.roomNumber} (${b.roomTypeCode})` : b.roomTypeName}
                    </td>
                    <td className="px-5 py-3 text-slate-600">{formatDisplayDate(b.arrivalDate)}</td>
                    <td className="px-5 py-3 text-slate-600">
                      {formatDisplayDate(b.departureDate)}
                    </td>
                    <td className="px-5 py-3 text-slate-600 text-xs">
                      {BOOKING_SOURCE_LABELS[b.source] ?? b.source}
                    </td>
                    <td className="px-5 py-3">
                      <ReservationStatusBadge status={b.status} />
                    </td>
                    <td className="px-5 py-3 text-right font-semibold text-slate-900">
                      {formatMoney(b.estimatedTotal, b.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / Walk-In Reservation Modal */}
      <ReservationFormModal
        open={modalMode !== null}
        onClose={() => setModalMode(null)}
        mode={modalMode ?? 'create'}
        onSaved={() => {
          void loadDashboard();
        }}
      />
    </div>
  );
}
