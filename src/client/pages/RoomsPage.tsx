import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BedDouble,
  Layers,
  Plus,
  Search,
  Pencil,
  Power,
  CalendarSearch,
  ShieldAlert,
  Wrench,
} from 'lucide-react';
import {
  HOUSEKEEPING_STATUSES,
  OPERATIONAL_STATUSES,
  type HousekeepingStatus,
  type OperationalStatus,
} from '@shared/constants';
import { addDays, diffDays, formatDisplayDate, isValidIsoDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type { MaintenanceRequest, Room, RoomType } from '@shared/types';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import {
  HousekeepingBadge,
  MaintenanceStatusBadge,
  OperationalBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch } from '../lib/api';

export function RoomsPage() {
  const { user, selectedProperty } = useAuth();
  const { showToast } = useToast();
  const isAdmin = user?.role === 'admin';

  const [tab, setTab] = useState<'rooms' | 'categories'>('rooms');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [roomTypeFilter, setRoomTypeFilter] = useState('');
  const [operationalFilter, setOperationalFilter] = useState('');
  const [housekeepingFilter, setHousekeepingFilter] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  // Optional Date-Based Availability Lookup
  const [checkDatesEnabled, setCheckDatesEnabled] = useState(false);
  const [availFrom, setAvailFrom] = useState('');
  const [availTo, setAvailTo] = useState('');

  // Room Maintenance History Drawer Modal
  const [maintHistoryRoom, setMaintHistoryRoom] = useState<Room | null>(null);
  const [maintHistoryItems, setMaintHistoryItems] = useState<MaintenanceRequest[]>([]);
  const [maintHistoryLoading, setMaintHistoryLoading] = useState(false);

  const openRoomMaintHistory = async (room: Room) => {
    if (!selectedProperty) return;
    setMaintHistoryRoom(room);
    setMaintHistoryLoading(true);
    try {
      const res = await apiFetch<{ items: MaintenanceRequest[] }>(
        `/api/rooms/${room.id}/maintenance`,
        { propertyId: selectedProperty.id }
      );
      setMaintHistoryItems(res.items);
    } catch {
      setMaintHistoryItems([]);
    } finally {
      setMaintHistoryLoading(false);
    }
  };

  // Room Modal State
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [rmNumber, setRmNumber] = useState('');
  const [rmFloor, setRmFloor] = useState('1');
  const [rmTypeId, setRmTypeId] = useState('');
  const [rmOpStatus, setRmOpStatus] = useState<OperationalStatus>('available');
  const [rmHkStatus, setRmHkStatus] = useState<HousekeepingStatus>('clean');
  const [rmNotes, setRmNotes] = useState('');
  const [rmFormError, setRmFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Room Type Modal State
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<RoomType | null>(null);
  const [catCode, setCatCode] = useState('');
  const [catName, setCatName] = useState('');
  const [catDesc, setCatDesc] = useState('');
  const [catBaseCap, setCatBaseCap] = useState(2);
  const [catMaxCap, setCatMaxCap] = useState(2);
  const [catRate, setCatRate] = useState('4500');
  const [catAmenities, setCatAmenities] = useState('Wi-Fi, Air Conditioning');
  const [catFormError, setCatFormError] = useState<string | null>(null);

  // Deactivation Confirmations
  const [toggleRoomTarget, setToggleRoomTarget] = useState<Room | null>(null);
  const [toggleCatTarget, setToggleCatTarget] = useState<RoomType | null>(null);

  useEffect(() => {
    if (selectedProperty) {
      setAvailFrom(selectedProperty.localToday);
      setAvailTo(addDays(selectedProperty.localToday, 2));
    }
  }, [selectedProperty?.id]);

  const loadAll = useCallback(async () => {
    if (!selectedProperty) return;
    setLoading(true);
    setError(null);
    try {
      const roomParams = new URLSearchParams();
      if (search.trim()) roomParams.set('search', search.trim());
      if (roomTypeFilter) roomParams.set('roomTypeId', roomTypeFilter);
      if (operationalFilter) roomParams.set('operationalStatus', operationalFilter);
      if (housekeepingFilter) roomParams.set('housekeepingStatus', housekeepingFilter);
      if (includeInactive) roomParams.set('includeInactive', 'true');
      if (
        checkDatesEnabled &&
        isValidIsoDate(availFrom) &&
        isValidIsoDate(availTo) &&
        diffDays(availFrom, availTo) >= 1
      ) {
        roomParams.set('availableFrom', availFrom);
        roomParams.set('availableTo', availTo);
      }

      const [roomsRes, typesRes] = await Promise.all([
        apiFetch<{ items: Room[] }>(`/api/rooms?${roomParams.toString()}`, {
          propertyId: selectedProperty.id,
        }),
        apiFetch<{ items: RoomType[] }>(
          `/api/room-types?includeInactive=${includeInactive ? 'true' : 'false'}`,
          { propertyId: selectedProperty.id }
        ),
      ]);
      setRooms(roomsRes.items);
      setRoomTypes(typesRes.items);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load room inventory');
    } finally {
      setLoading(false);
    }
  }, [
    selectedProperty?.id,
    search,
    roomTypeFilter,
    operationalFilter,
    housekeepingFilter,
    includeInactive,
    checkDatesEnabled,
    availFrom,
    availTo,
  ]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const openCreateRoom = () => {
    setEditingRoom(null);
    setRmNumber('');
    setRmFloor('1');
    setRmTypeId(roomTypes.find((t) => t.isActive)?.id ?? '');
    setRmOpStatus('available');
    setRmHkStatus('clean');
    setRmNotes('');
    setRmFormError(null);
    setRoomModalOpen(true);
  };

  const openEditRoom = (r: Room) => {
    setEditingRoom(r);
    setRmNumber(r.roomNumber);
    setRmFloor(r.floor);
    setRmTypeId(r.roomTypeId);
    setRmOpStatus(r.operationalStatus);
    setRmHkStatus(r.housekeepingStatus);
    setRmNotes(r.notes);
    setRmFormError(null);
    setRoomModalOpen(true);
  };

  const handleSaveRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProperty) return;
    setRmFormError(null);
    setSubmitting(true);
    try {
      const payload = {
        roomTypeId: rmTypeId,
        roomNumber: rmNumber.trim(),
        floor: rmFloor.trim(),
        operationalStatus: rmOpStatus,
        housekeepingStatus: rmHkStatus,
        notes: rmNotes.trim(),
      };
      if (editingRoom) {
        await apiFetch(`/api/rooms/${editingRoom.id}`, {
          method: 'PUT',
          propertyId: selectedProperty.id,
          body: payload,
        });
        showToast('success', `Room ${rmNumber} updated.`);
      } else {
        await apiFetch('/api/rooms', {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: payload,
        });
        showToast('success', `Room ${rmNumber} added to inventory.`);
      }
      setRoomModalOpen(false);
      await loadAll();
    } catch (err) {
      setRmFormError(err instanceof ApiClientError ? err.message : 'Unable to save room');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleRoomActive = async () => {
    if (!selectedProperty || !toggleRoomTarget) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/rooms/${toggleRoomTarget.id}`, {
        method: 'PUT',
        propertyId: selectedProperty.id,
        body: { isActive: !toggleRoomTarget.isActive },
      });
      showToast(
        'success',
        `Room ${toggleRoomTarget.roomNumber} ${toggleRoomTarget.isActive ? 'deactivated' : 'reactivated'}.`
      );
      setToggleRoomTarget(null);
      await loadAll();
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Action failed');
    } finally {
      setSubmitting(false);
    }
  };

  const openCreateCategory = () => {
    setEditingCat(null);
    setCatCode('');
    setCatName('');
    setCatDesc('');
    setCatBaseCap(2);
    setCatMaxCap(2);
    setCatRate('4500');
    setCatAmenities('Wi-Fi, Air Conditioning');
    setCatFormError(null);
    setCatModalOpen(true);
  };

  const openEditCategory = (rt: RoomType) => {
    setEditingCat(rt);
    setCatCode(rt.code);
    setCatName(rt.name);
    setCatDesc(rt.description);
    setCatBaseCap(rt.baseCapacity);
    setCatMaxCap(rt.maxCapacity);
    setCatRate(String(rt.baseRate));
    setCatAmenities(rt.amenities.join(', '));
    setCatFormError(null);
    setCatModalOpen(true);
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProperty) return;
    setCatFormError(null);
    setSubmitting(true);
    try {
      const amenitiesArr = catAmenities
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const payload = {
        code: catCode.trim().toUpperCase(),
        name: catName.trim(),
        description: catDesc.trim(),
        baseCapacity: Number(catBaseCap),
        maxCapacity: Number(catMaxCap),
        baseRate: Number(catRate),
        amenities: amenitiesArr,
      };

      if (editingCat) {
        await apiFetch(`/api/room-types/${editingCat.id}`, {
          method: 'PUT',
          propertyId: selectedProperty.id,
          body: payload,
        });
        showToast('success', `Category "${catName}" updated.`);
      } else {
        await apiFetch('/api/room-types', {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: payload,
        });
        showToast('success', `Category "${catName}" created.`);
      }
      setCatModalOpen(false);
      await loadAll();
    } catch (err) {
      setCatFormError(err instanceof ApiClientError ? err.message : 'Unable to save category');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleCatActive = async () => {
    if (!selectedProperty || !toggleCatTarget) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/room-types/${toggleCatTarget.id}`, {
        method: 'PUT',
        propertyId: selectedProperty.id,
        body: { isActive: !toggleCatTarget.isActive },
      });
      showToast(
        'success',
        `Category "${toggleCatTarget.name}" ${toggleCatTarget.isActive ? 'deactivated' : 'reactivated'}.`
      );
      setToggleCatTarget(null);
      await loadAll();
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Action failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (!selectedProperty) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Room Types & Room Inventory
          </h1>
          <p className="text-sm text-slate-500">
            Configure room categories, base nightly rates, physical operational status, and
            date-range availability.
          </p>
        </div>

        {isAdmin ? (
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={openCreateCategory}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Layers className="h-4 w-4 text-indigo-600" />
              New Category
            </button>
            <button
              type="button"
              onClick={openCreateRoom}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              Add Room
            </button>
          </div>
        ) : (
          <div className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            Administrator role required to add/edit room inventory
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center justify-between flex-wrap gap-3 border-b border-slate-200 pb-3">
        <div className="inline-flex rounded-xl bg-slate-200/70 p-1">
          <button
            type="button"
            onClick={() => setTab('rooms')}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-1.5 text-xs sm:text-sm font-semibold transition-colors ${
              tab === 'rooms' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            <BedDouble className="h-4 w-4" />
            Physical Rooms ({rooms.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('categories')}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-1.5 text-xs sm:text-sm font-semibold transition-colors ${
              tab === 'categories' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            <Layers className="h-4 w-4" />
            Room Categories ({roomTypes.length})
          </button>
        </div>

        <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="rounded border-slate-300 text-indigo-600"
          />
          Show deactivated records
        </label>
      </div>

      {error && <ErrorAlert message={error} onRetry={loadAll} />}

      {tab === 'rooms' ? (
        <div className="space-y-4">
          {/* Filters + Optional Date-Based Availability Lookup */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="relative">
                <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  aria-label="Search rooms"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search room #, category, notes..."
                  className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm"
                />
              </div>

              <select
                aria-label="Filter by category"
                value={roomTypeFilter}
                onChange={(e) => setRoomTypeFilter(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Room Categories</option>
                {roomTypes.map((rt) => (
                  <option key={rt.id} value={rt.id}>
                    {rt.name} ({rt.code})
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter by operational status"
                value={operationalFilter}
                onChange={(e) => setOperationalFilter(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Operational Statuses</option>
                <option value="available">Operational</option>
                <option value="maintenance">Maintenance</option>
                <option value="out_of_service">Out of Service</option>
              </select>

              <select
                aria-label="Filter by housekeeping status"
                value={housekeepingFilter}
                onChange={(e) => setHousekeepingFilter(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Housekeeping States</option>
                <option value="inspected">Inspected</option>
                <option value="clean">Clean</option>
                <option value="dirty">Dirty</option>
                <option value="out_of_service">Out of Service</option>
              </select>
            </div>

            {/* Date-Based Booking Availability Checker */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 text-xs">
              <label className="inline-flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={checkDatesEnabled}
                  onChange={(e) => setCheckDatesEnabled(e.target.checked)}
                  className="rounded border-slate-300 text-indigo-600"
                />
                <CalendarSearch className="h-4 w-4 text-indigo-600" />
                Check Date-Based Booking Availability (separate from physical room status)
              </label>

              {checkDatesEnabled && (
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="rm-avail-from" className="text-slate-500">
                    Arrival:
                  </label>
                  <input
                    id="rm-avail-from"
                    type="date"
                    value={availFrom}
                    onChange={(e) => setAvailFrom(e.target.value)}
                    className="rounded-md border border-slate-300 px-2 py-1"
                  />
                  <label htmlFor="rm-avail-to" className="text-slate-500">
                    Departure:
                  </label>
                  <input
                    id="rm-avail-to"
                    type="date"
                    value={availTo}
                    onChange={(e) => setAvailTo(e.target.value)}
                    className="rounded-md border border-slate-300 px-2 py-1"
                  />
                </div>
              )}
            </div>
          </div>

          {loading ? (
            <LoadingState label="Loading rooms..." />
          ) : rooms.length === 0 ? (
            <EmptyState
              title="No rooms match your filter"
              description="Adjust filters or add rooms to this property."
            />
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50/90 text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3">Room #</th>
                      <th className="px-4 py-3">Category & Capacity</th>
                      <th className="px-4 py-3">Base Rate</th>
                      <th className="px-4 py-3">Physical Status</th>
                      <th className="px-4 py-3">Housekeeping</th>
                      <th className="px-4 py-3">Current Occupancy</th>
                      {checkDatesEnabled && <th className="px-4 py-3">Date Availability</th>}
                      {isAdmin && <th className="px-4 py-3 text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rooms.map((r) => (
                      <tr
                        key={r.id}
                        className={`hover:bg-slate-50/70 ${!r.isActive ? 'opacity-60' : ''}`}
                      >
                        <td className="px-4 py-3">
                          <span className="font-bold text-slate-900">Room {r.roomNumber}</span>
                          <span className="block text-xs text-slate-500">Floor {r.floor}</span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-900">{r.roomTypeName}</p>
                          <p className="text-xs text-slate-500">
                            Base {r.baseCapacity} • Max {r.maxCapacity} guests
                          </p>
                        </td>
                        <td className="px-4 py-3 font-semibold text-slate-900">
                          {formatMoney(r.baseRate, selectedProperty.currency)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <OperationalBadge status={r.operationalStatus} isActive={r.isActive} />
                            {r.openMaintenanceCount > 0 && (
                              <button
                                type="button"
                                onClick={() => void openRoomMaintHistory(r)}
                                className="inline-flex items-center gap-1 rounded bg-orange-50 border border-orange-200 px-1.5 py-0.5 text-[10px] font-semibold text-orange-800 hover:bg-orange-100"
                              >
                                <Wrench className="h-3 w-3" />
                                {r.openMaintenanceCount} open
                              </button>
                            )}
                          </div>
                          {r.notes && (
                            <p className="text-[11px] text-slate-500 mt-1 max-w-xs truncate">
                              {r.notes}
                            </p>
                          )}
                          <button
                            type="button"
                            onClick={() => void openRoomMaintHistory(r)}
                            className="mt-1 text-[11px] font-medium text-indigo-600 hover:underline"
                          >
                            Maintenance History
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <HousekeepingBadge
                            status={r.housekeepingStatus}
                            cleaningInProgress={r.cleaningInProgress}
                          />
                          {r.openTasksCount > 0 && (
                            <Link
                              to="/housekeeping?tab=tasks"
                              className="block mt-1 text-[11px] font-medium text-indigo-600 hover:underline"
                            >
                              {r.openTasksCount} open task{r.openTasksCount === 1 ? '' : 's'}
                            </Link>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {r.currentOccupancy ? (
                            <div>
                              <span className="inline-block rounded bg-indigo-50 border border-indigo-200 px-2 py-0.5 font-semibold text-indigo-800">
                                Occupied: {r.currentOccupancy.guestName}
                              </span>
                              <Link
                                to={`/reservations/${r.currentOccupancy.reservationId}`}
                                className="block text-indigo-600 hover:underline mt-0.5 font-mono"
                              >
                                {r.currentOccupancy.bookingReference}
                              </Link>
                            </div>
                          ) : (
                            <span className="text-slate-500 font-medium">Vacant</span>
                          )}
                        </td>
                        {checkDatesEnabled && (
                          <td className="px-4 py-3 text-xs">
                            {r.availableForDates ? (
                              <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 font-semibold text-emerald-700">
                                Available
                              </span>
                            ) : (
                              <span className="rounded-full bg-rose-50 border border-rose-200 px-2.5 py-0.5 font-semibold text-rose-700">
                                {r.conflictingMaintenanceTitle
                                  ? `Maint (${r.conflictingMaintenanceTitle})`
                                  : r.conflictingBookingRef
                                    ? `Booked (${r.conflictingBookingRef})`
                                    : 'Unavailable'}
                              </span>
                            )}
                          </td>
                        )}
                        {isAdmin && (
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                title="Edit room"
                                onClick={() => openEditRoom(r)}
                                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                title={r.isActive ? 'Deactivate room' : 'Reactivate room'}
                                onClick={() => setToggleRoomTarget(r)}
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              >
                                <Power className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Room Categories Tab */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {roomTypes.map((rt) => (
            <div
              key={rt.id}
              className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-xs flex flex-col justify-between gap-4 ${
                !rt.isActive ? 'opacity-60' : ''
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-indigo-50 px-2 py-0.5 text-xs font-mono font-bold text-indigo-700">
                        {rt.code}
                      </span>
                      <h3 className="text-base font-bold text-slate-900">{rt.name}</h3>
                      {!rt.isActive && (
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                          Inactive
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                      {rt.description || 'No category description provided.'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-lg font-bold text-slate-900">
                      {formatMoney(rt.baseRate, selectedProperty.currency)}
                    </span>
                    <span className="block text-[11px] text-slate-500">per night</span>
                  </div>
                </div>

                {rt.amenities.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {rt.amenities.map((a) => (
                      <span
                        key={a}
                        className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-600">
                <span>
                  Capacity: <strong>{rt.baseCapacity}</strong> base /{' '}
                  <strong>{rt.maxCapacity}</strong> max •{' '}
                  <strong>{rt.activeRoomsCount}</strong> active room
                  {rt.activeRoomsCount === 1 ? '' : 's'}
                </span>

                {isAdmin && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openEditCategory(rt)}
                      className="font-semibold text-indigo-600 hover:underline"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setToggleCatTarget(rt)}
                      className="font-semibold text-slate-500 hover:text-rose-600"
                    >
                      {rt.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit Room Modal */}
      <Modal
        open={roomModalOpen}
        onClose={() => setRoomModalOpen(false)}
        title={editingRoom ? `Edit Room ${editingRoom.roomNumber}` : 'Add Physical Room'}
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleSaveRoom} className="space-y-4">
          {rmFormError && <ErrorAlert message={rmFormError} />}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="rm-number" className="block text-xs font-medium text-slate-700 mb-1">
                Room Number *
              </label>
              <input
                id="rm-number"
                type="text"
                required
                value={rmNumber}
                onChange={(e) => setRmNumber(e.target.value)}
                placeholder="e.g., 105"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="rm-floor" className="block text-xs font-medium text-slate-700 mb-1">
                Floor *
              </label>
              <input
                id="rm-floor"
                type="text"
                required
                value={rmFloor}
                onChange={(e) => setRmFloor(e.target.value)}
                placeholder="e.g., 1"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="rm-cat" className="block text-xs font-medium text-slate-700 mb-1">
              Room Category *
            </label>
            <select
              id="rm-cat"
              required
              value={rmTypeId}
              onChange={(e) => setRmTypeId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">-- Select category --</option>
              {roomTypes
                .filter((t) => t.isActive || t.id === rmTypeId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({formatMoney(t.baseRate, selectedProperty.currency)}/night, Max{' '}
                    {t.maxCapacity})
                  </option>
                ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="rm-op" className="block text-xs font-medium text-slate-700 mb-1">
                Physical Operational Status
              </label>
              <select
                id="rm-op"
                value={rmOpStatus}
                onChange={(e) => setRmOpStatus(e.target.value as OperationalStatus)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                {OPERATIONAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="rm-hk" className="block text-xs font-medium text-slate-700 mb-1">
                Housekeeping Status
              </label>
              <select
                id="rm-hk"
                value={rmHkStatus}
                onChange={(e) => setRmHkStatus(e.target.value as HousekeepingStatus)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                {HOUSEKEEPING_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="rm-notes" className="block text-xs font-medium text-slate-700 mb-1">
              Operational / Maintenance Notes
            </label>
            <textarea
              id="rm-notes"
              rows={2}
              value={rmNotes}
              onChange={(e) => setRmNotes(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setRoomModalOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? 'Saving...' : editingRoom ? 'Save Room' : 'Create Room'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Create / Edit Category Modal */}
      <Modal
        open={catModalOpen}
        onClose={() => setCatModalOpen(false)}
        title={editingCat ? `Edit Category — ${editingCat.name}` : 'Create Room Category'}
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleSaveCategory} className="space-y-4">
          {catFormError && <ErrorAlert message={catFormError} />}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="cat-code" className="block text-xs font-medium text-slate-700 mb-1">
                Short Code *
              </label>
              <input
                id="cat-code"
                type="text"
                required
                value={catCode}
                onChange={(e) => setCatCode(e.target.value.toUpperCase())}
                placeholder="DLX"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
              />
            </div>
            <div className="col-span-2">
              <label htmlFor="cat-name" className="block text-xs font-medium text-slate-700 mb-1">
                Category Name *
              </label>
              <input
                id="cat-name"
                type="text"
                required
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                placeholder="Deluxe King Room"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="cat-base-cap" className="block text-xs font-medium text-slate-700 mb-1">
                Base Capacity *
              </label>
              <input
                id="cat-base-cap"
                type="number"
                min={1}
                max={20}
                required
                value={catBaseCap}
                onChange={(e) => setCatBaseCap(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="cat-max-cap" className="block text-xs font-medium text-slate-700 mb-1">
                Max Capacity *
              </label>
              <input
                id="cat-max-cap"
                type="number"
                min={1}
                max={30}
                required
                value={catMaxCap}
                onChange={(e) => setCatMaxCap(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="cat-rate" className="block text-xs font-medium text-slate-700 mb-1">
                Base Rate ({selectedProperty.currency}) *
              </label>
              <input
                id="cat-rate"
                type="number"
                step="0.01"
                min={0}
                required
                value={catRate}
                onChange={(e) => setCatRate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="cat-desc" className="block text-xs font-medium text-slate-700 mb-1">
              Description
            </label>
            <textarea
              id="cat-desc"
              rows={2}
              value={catDesc}
              onChange={(e) => setCatDesc(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="cat-amenities" className="block text-xs font-medium text-slate-700 mb-1">
              Amenities (comma-separated)
            </label>
            <input
              id="cat-amenities"
              type="text"
              value={catAmenities}
              onChange={(e) => setCatAmenities(e.target.value)}
              placeholder="Wi-Fi, Balcony, Minibar"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setCatModalOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? 'Saving...' : editingCat ? 'Save Category' : 'Create Category'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Deactivate/Reactivate Confirmations */}
      <ConfirmDialog
        open={toggleRoomTarget !== null}
        onClose={() => setToggleRoomTarget(null)}
        onConfirm={handleToggleRoomActive}
        title={
          toggleRoomTarget?.isActive
            ? `Deactivate Room ${toggleRoomTarget.roomNumber}?`
            : `Reactivate Room ${toggleRoomTarget?.roomNumber ?? ''}?`
        }
        description={
          toggleRoomTarget?.isActive
            ? 'Deactivated rooms cannot accept new bookings, while preserving historical reservation records.'
            : 'Reactivating restores this room to property inventory.'
        }
        confirmLabel={toggleRoomTarget?.isActive ? 'Deactivate Room' : 'Reactivate Room'}
        variant={toggleRoomTarget?.isActive ? 'danger' : 'primary'}
        isSubmitting={submitting}
      />

      <ConfirmDialog
        open={toggleCatTarget !== null}
        onClose={() => setToggleCatTarget(null)}
        onConfirm={handleToggleCatActive}
        title={
          toggleCatTarget?.isActive
            ? `Deactivate Category "${toggleCatTarget.name}"?`
            : `Reactivate Category "${toggleCatTarget?.name ?? ''}"?`
        }
        description={
          toggleCatTarget?.isActive
            ? 'Deactivating hides this room category from new room creation while keeping existing records intact.'
            : 'Reactivating makes this room category active again.'
        }
        confirmLabel={toggleCatTarget?.isActive ? 'Deactivate' : 'Reactivate'}
        variant={toggleCatTarget?.isActive ? 'danger' : 'primary'}
        isSubmitting={submitting}
      />
      {/* Room Maintenance History Modal */}
      <Modal
        open={maintHistoryRoom !== null}
        onClose={() => setMaintHistoryRoom(null)}
        title={
          maintHistoryRoom
            ? `Room ${maintHistoryRoom.roomNumber} — Maintenance & Out-of-Service History`
            : 'Maintenance History'
        }
        maxWidthClass="max-w-xl"
      >
        {maintHistoryLoading ? (
          <LoadingState label="Loading room maintenance history..." />
        ) : maintHistoryItems.length === 0 ? (
          <div className="space-y-3 text-center py-4">
            <p className="text-sm text-slate-600">
              No maintenance requests or out-of-service blocks recorded for this room.
            </p>
            <Link
              to="/housekeeping?tab=maintenance"
              onClick={() => setMaintHistoryRoom(null)}
              className="inline-block rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
            >
              Open Maintenance Management
            </Link>
          </div>
        ) : (
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1 text-xs">
            {maintHistoryItems.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-slate-900">{item.title}</span>
                  <MaintenanceStatusBadge status={item.status} />
                </div>
                <p className="text-slate-600">{item.description}</p>
                {item.blocksInventory && item.unavailableFrom && (
                  <p className="text-rose-800 font-semibold">
                    Unavailable Window: {formatDisplayDate(item.unavailableFrom)} →{' '}
                    {item.unavailableTo
                      ? formatDisplayDate(item.unavailableTo)
                      : 'Until Restored'}
                  </p>
                )}
                <p className="text-slate-500">
                  Reported {new Date(item.reportedAt).toLocaleString()}
                  {item.assignedToName ? ` • Assigned: ${item.assignedToName}` : ''}
                </p>
                {item.resolutionNotes && (
                  <p className="text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5">
                    <strong>Resolution:</strong> {item.resolutionNotes}
                    {item.resolvedAt
                      ? ` (${new Date(item.resolvedAt).toLocaleString()})`
                      : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
