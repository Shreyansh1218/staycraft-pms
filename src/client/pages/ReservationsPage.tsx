import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarPlus,
  CalendarRange,
  Footprints,
  Search,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Eye,
  Pencil,
  XCircle,
} from 'lucide-react';
import {
  BOOKING_SOURCES,
  BOOKING_SOURCE_LABELS,
  RESERVATION_STATUSES,
} from '@shared/constants';
import { formatDisplayDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type {
  PaginatedResult,
  ReservationDetail,
  ReservationListItem,
  RoomType,
} from '@shared/types';
import { ReservationFormModal } from '../components/reservations/ReservationFormModal';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import { ConfirmDialog } from '../components/ui/Modal';
import { HousekeepingBadge, ReservationStatusBadge } from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch } from '../lib/api';

type QuickTab =
  | ''
  | 'arrivals_today'
  | 'departures_today'
  | 'overdue_checkouts'
  | 'in_house'
  | 'upcoming'
  | 'cancelled';

export function ReservationsPage() {
  const { selectedProperty } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [data, setData] = useState<PaginatedResult<ReservationListItem> | null>(null);
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [quickFilter, setQuickFilter] = useState<QuickTab>(
    (searchParams.get('quickFilter') as QuickTab) ?? ''
  );
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') ?? '');
  const [sourceFilter, setSourceFilter] = useState('');
  const [roomTypeFilter, setRoomTypeFilter] = useState('');
  const [arrivalFrom, setArrivalFrom] = useState('');
  const [arrivalTo, setArrivalTo] = useState('');
  const [sortBy, setSortBy] = useState('arrival_date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  // Modals
  const [formMode, setFormMode] = useState<'create' | 'walk_in' | 'edit' | null>(null);
  const [editingReservation, setEditingReservation] = useState<ReservationListItem | null>(null);
  const [cancellingItem, setCancellingItem] = useState<ReservationListItem | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  // Open new modal automatically if ?new=1
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setFormMode('create');
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
    const qf = searchParams.get('quickFilter') as QuickTab | null;
    if (qf) setQuickFilter(qf);
    const st = searchParams.get('status');
    if (st) setStatusFilter(st);
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!selectedProperty) return;
    apiFetch<{ items: RoomType[] }>('/api/room-types', { propertyId: selectedProperty.id })
      .then((r) => setRoomTypes(r.items))
      .catch(() => setRoomTypes([]));
  }, [selectedProperty?.id]);

  const loadReservations = useCallback(async () => {
    if (!selectedProperty) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '12',
        sortBy,
        sortDir,
      });
      if (search.trim()) params.set('search', search.trim());
      if (quickFilter) params.set('quickFilter', quickFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (sourceFilter) params.set('source', sourceFilter);
      if (roomTypeFilter) params.set('roomTypeId', roomTypeFilter);
      if (arrivalFrom) params.set('arrivalFrom', arrivalFrom);
      if (arrivalTo) params.set('arrivalTo', arrivalTo);

      const res = await apiFetch<PaginatedResult<ReservationListItem>>(
        `/api/reservations?${params.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load reservations');
    } finally {
      setLoading(false);
    }
  }, [
    selectedProperty?.id,
    page,
    sortBy,
    sortDir,
    search,
    quickFilter,
    statusFilter,
    sourceFilter,
    roomTypeFilter,
    arrivalFrom,
    arrivalTo,
  ]);

  useEffect(() => {
    void loadReservations();
  }, [loadReservations]);

  const resetFilters = () => {
    setSearch('');
    setQuickFilter('');
    setStatusFilter('');
    setSourceFilter('');
    setRoomTypeFilter('');
    setArrivalFrom('');
    setArrivalTo('');
    setSortBy('arrival_date');
    setSortDir('desc');
    setPage(1);
    setSearchParams({}, { replace: true });
  };

  const handleConfirmCancel = async () => {
    if (!selectedProperty || !cancellingItem) return;
    if (cancelReason.trim().length < 2) {
      showToast('error', 'Please enter a cancellation reason.');
      return;
    }
    setCancelSubmitting(true);
    try {
      await apiFetch<{ reservation: ReservationDetail }>(
        `/api/reservations/${cancellingItem.id}/cancel`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: { reason: cancelReason.trim() },
        }
      );
      showToast(
        'success',
        `Cancelled ${cancellingItem.bookingReference}. Room availability released.`
      );
      setCancellingItem(null);
      setCancelReason('');
      await loadReservations();
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Cancellation failed');
    } finally {
      setCancelSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Front Office & Reservations
          </h1>
          <p className="text-sm text-slate-500">
            Manage bookings, walk-ins, room assignments, check-ins, and check-outs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            to="/calendar"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <CalendarRange className="h-4 w-4 text-indigo-600" />
            Room Calendar
          </Link>
          <button
            type="button"
            onClick={() => {
              setEditingReservation(null);
              setFormMode('walk_in');
            }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-3.5 py-2 text-xs sm:text-sm font-semibold text-emerald-900 hover:bg-emerald-100"
          >
            <Footprints className="h-4 w-4 text-emerald-700" />
            Walk-In Booking
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingReservation(null);
              setFormMode('create');
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
          >
            <CalendarPlus className="h-4 w-4" />
            New Reservation
          </button>
        </div>
      </div>

      {/* Quick Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 pb-3">
        {(
          [
            { id: '', label: 'All Bookings' },
            { id: 'arrivals_today', label: 'Arrivals Today' },
            { id: 'departures_today', label: 'Departures Today' },
            { id: 'overdue_checkouts', label: 'Overdue Check-Outs' },
            { id: 'in_house', label: 'In-House' },
            { id: 'upcoming', label: 'Upcoming' },
            { id: 'cancelled', label: 'Cancelled' },
          ] as { id: QuickTab; label: string }[]
        ).map((tab) => (
          <button
            key={tab.id || 'all'}
            type="button"
            onClick={() => {
              setQuickFilter(tab.id);
              setPage(1);
            }}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              quickFilter === tab.id
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Search, Filters & Sorting Bar */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <div className="lg:col-span-2 relative">
            <label htmlFor="res-list-search" className="sr-only">
              Search reservations
            </label>
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              id="res-list-search"
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search ref, guest, phone, room #..."
              className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="filter-status" className="sr-only">
              Filter by status
            </label>
            <select
              id="filter-status"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Statuses</option>
              {RESERVATION_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {st.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-source" className="sr-only">
              Filter by source
            </label>
            <select
              id="filter-source"
              value={sourceFilter}
              onChange={(e) => {
                setSourceFilter(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Sources</option>
              {BOOKING_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {BOOKING_SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-roomtype" className="sr-only">
              Filter by room category
            </label>
            <select
              id="filter-roomtype"
              value={roomTypeFilter}
              onChange={(e) => {
                setRoomTypeFilter(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Categories</option>
              {roomTypes.map((rt) => (
                <option key={rt.id} value={rt.id}>
                  {rt.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="sort-by" className="sr-only">
              Sort reservations
            </label>
            <select
              id="sort-by"
              value={`${sortBy}:${sortDir}`}
              onChange={(e) => {
                const [col, dir] = e.target.value.split(':');
                setSortBy(col);
                setSortDir(dir as 'asc' | 'desc');
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="arrival_date:desc">Arrival (Newest)</option>
              <option value="arrival_date:asc">Arrival (Earliest)</option>
              <option value="departure_date:asc">Departure (Earliest)</option>
              <option value="created_at:desc">Created (Latest)</option>
              <option value="estimated_total:desc">Total (High → Low)</option>
              <option value="estimated_total:asc">Total (Low → High)</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-slate-100 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <label htmlFor="filter-arr-from" className="text-slate-500 font-medium">
                Arrival From:
              </label>
              <input
                id="filter-arr-from"
                type="date"
                value={arrivalFrom}
                onChange={(e) => {
                  setArrivalFrom(e.target.value);
                  setPage(1);
                }}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label htmlFor="filter-arr-to" className="text-slate-500 font-medium">
                To:
              </label>
              <input
                id="filter-arr-to"
                type="date"
                value={arrivalTo}
                onChange={(e) => {
                  setArrivalTo(e.target.value);
                  setPage(1);
                }}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-indigo-600"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset Filters
          </button>
        </div>
      </div>

      {/* Results Table */}
      {error && <ErrorAlert message={error} onRetry={loadReservations} />}

      {loading && !data ? (
        <LoadingState label="Loading reservations..." />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          title="No matching reservations found"
          description="Try clearing filters or create a new booking."
          action={
            <button
              type="button"
              onClick={() => setFormMode('create')}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
            >
              Create Reservation
            </button>
          }
        />
      ) : (
        data && (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50/90 text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3">Booking Ref</th>
                    <th className="px-4 py-3">Guest</th>
                    <th className="px-4 py-3">Room & Housekeeping</th>
                    <th className="px-4 py-3">Stay Dates</th>
                    <th className="px-4 py-3">Guests</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">Reservation Status</th>
                    <th className="px-4 py-3 text-right">Est. Total</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((item) => {
                    const editable =
                      item.status !== 'cancelled' && item.status !== 'checked_out';
                    const cancellable =
                      item.status === 'pending' || item.status === 'confirmed';

                    return (
                      <tr key={item.id} className="hover:bg-slate-50/70 transition-colors">
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-indigo-600 whitespace-nowrap">
                          <Link to={`/reservations/${item.id}`} className="hover:underline">
                            {item.bookingReference}
                          </Link>
                          {item.isWalkIn && (
                            <span className="ml-1.5 rounded bg-emerald-50 border border-emerald-200 px-1.5 py-0.2 text-[10px] font-sans font-semibold text-emerald-700">
                              Walk-In
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-900">{item.guestName}</p>
                          <p className="text-xs text-slate-500">{item.guestPhone}</p>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-slate-800">
                              {item.roomNumber ? `Room ${item.roomNumber}` : 'Unassigned'}
                            </span>
                            {item.roomHousekeepingStatus && (
                              <HousekeepingBadge
                                status={item.roomHousekeepingStatus}
                                cleaningInProgress={item.roomCleaningInProgress}
                              />
                            )}
                          </div>
                          <p className="text-xs text-slate-500">{item.roomTypeName}</p>
                          {editable &&
                            (item.roomHasInventoryBlock ||
                              (item.roomOperationalStatus &&
                                item.roomOperationalStatus !== 'available')) && (
                              <span className="mt-1 inline-flex items-center gap-1 rounded bg-rose-50 border border-rose-200 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800">
                                <AlertTriangle className="h-3 w-3 text-rose-600" />
                                Room Unavailable — Reassign
                              </span>
                            )}
                          {editable &&
                            !item.roomHasInventoryBlock &&
                            item.roomOpenMaintenanceCount > 0 && (
                              <span className="mt-1 inline-flex items-center gap-1 rounded bg-orange-50 border border-orange-200 px-1.5 py-0.5 text-[10px] font-semibold text-orange-800">
                                Maint Open ({item.roomOpenMaintenanceCount})
                              </span>
                            )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <p className="text-slate-900 font-medium text-xs">
                            {formatDisplayDate(item.arrivalDate)} →{' '}
                            {formatDisplayDate(item.departureDate)}
                          </p>
                          <p className="text-xs text-slate-500">
                            {item.nights} night{item.nights === 1 ? '' : 's'}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600">{item.numGuests}</td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          {BOOKING_SOURCE_LABELS[item.source] ?? item.source}
                        </td>
                        <td className="px-4 py-3">
                          <ReservationStatusBadge status={item.status} />
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-900 whitespace-nowrap">
                          {formatMoney(item.estimatedTotal, item.currency)}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              title="View reservation details & check-in/out"
                              onClick={() => navigate(`/reservations/${item.id}`)}
                              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-indigo-600"
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                            {editable && (
                              <button
                                type="button"
                                title="Edit reservation"
                                onClick={() => {
                                  setEditingReservation(item);
                                  setFormMode('edit');
                                }}
                                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                            )}
                            {cancellable && (
                              <button
                                type="button"
                                title="Cancel reservation"
                                onClick={() => {
                                  setCancellingItem(item);
                                  setCancelReason('');
                                }}
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              >
                                <XCircle className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Footer */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-slate-100 px-5 py-3 bg-slate-50/50 text-xs text-slate-600">
              <span>
                Showing{' '}
                <strong>
                  {(data.page - 1) * data.pageSize + 1}–
                  {Math.min(data.page * data.pageSize, data.total)}
                </strong>{' '}
                of <strong>{data.total}</strong> reservations
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={data.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev
                </button>
                <span>
                  Page <strong>{data.page}</strong> of <strong>{data.totalPages}</strong>
                </span>
                <button
                  type="button"
                  disabled={data.page >= data.totalPages}
                  onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )
      )}

      {/* Create / Walk-In / Edit Modal */}
      <ReservationFormModal
        open={formMode !== null}
        onClose={() => {
          setFormMode(null);
          setEditingReservation(null);
        }}
        mode={formMode ?? 'create'}
        editingReservation={editingReservation}
        onSaved={() => {
          void loadReservations();
        }}
      />

      {/* Cancel Confirmation Dialog */}
      <ConfirmDialog
        open={cancellingItem !== null}
        onClose={() => setCancellingItem(null)}
        onConfirm={handleConfirmCancel}
        title={`Cancel Reservation ${cancellingItem?.bookingReference ?? ''}`}
        description={`Cancelling this reservation for ${cancellingItem?.guestName ?? ''} will immediately release Room ${cancellingItem?.roomNumber ?? ''} back into available inventory.`}
        confirmLabel="Cancel Reservation"
        variant="danger"
        isSubmitting={cancelSubmitting}
      >
        <div>
          <label
            htmlFor="cancel-reason-input"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Cancellation Reason *
          </label>
          <input
            id="cancel-reason-input"
            type="text"
            required
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="e.g., Guest travel plans changed"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-rose-500 focus:outline-none"
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
