import React, { useEffect, useMemo, useState } from 'react';
import { UserPlus, Search, CheckCircle2, AlertTriangle } from 'lucide-react';
import { BOOKING_SOURCES, BOOKING_SOURCE_LABELS, type BookingSource } from '@shared/constants';
import { addDays, diffDays, isValidIsoDate } from '@shared/dates';
import { calculateReservationFinancials, formatMoney } from '@shared/pricing';
import type {
  Guest,
  PaginatedResult,
  ReservationDetail,
  ReservationListItem,
  Room,
} from '@shared/types';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { ApiClientError, apiFetch } from '../../lib/api';
import { Modal } from '../ui/Modal';
import { HousekeepingBadge, OperationalBadge } from '../ui/StatusBadge';

export interface ReservationFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: 'create' | 'walk_in' | 'edit';
  initialGuest?: Guest | null;
  initialRoomId?: string;
  initialArrivalDate?: string;
  initialDepartureDate?: string;
  editingReservation?: ReservationListItem | ReservationDetail | null;
  onSaved: (reservation: ReservationDetail) => void;
}

export function ReservationFormModal({
  open,
  onClose,
  mode,
  initialGuest = null,
  initialRoomId,
  initialArrivalDate,
  initialDepartureDate,
  editingReservation = null,
  onSaved,
}: ReservationFormModalProps) {
  const { selectedProperty } = useAuth();
  const { showToast } = useToast();

  const today = selectedProperty?.localToday ?? new Date().toISOString().slice(0, 10);

  // Guest state (create / walk-in)
  const [guestSearch, setGuestSearch] = useState('');
  const [guests, setGuests] = useState<Guest[]>([]);
  const [selectedGuestId, setSelectedGuestId] = useState('');
  const [creatingNewGuest, setCreatingNewGuest] = useState(false);
  const [newGuestFirstName, setNewGuestFirstName] = useState('');
  const [newGuestLastName, setNewGuestLastName] = useState('');
  const [newGuestPhone, setNewGuestPhone] = useState('');
  const [newGuestEmail, setNewGuestEmail] = useState('');

  // Stay & Room state
  const [arrivalDate, setArrivalDate] = useState(today);
  const [departureDate, setDepartureDate] = useState(addDays(today, 2));
  const [adults, setAdults] = useState(2);
  const [childrenCount, setChildrenCount] = useState(0);
  const [roomId, setRoomId] = useState('');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);

  // Pricing & Meta
  const [nightlyRate, setNightlyRate] = useState<string>('');
  const [rateManuallyEdited, setRateManuallyEdited] = useState(false);
  const [discountAmount, setDiscountAmount] = useState<string>('0');
  const [source, setSource] = useState<BookingSource>('direct');
  const [status, setStatus] = useState<'pending' | 'confirmed'>('confirmed');
  const [checkInImmediately, setCheckInImmediately] = useState(false);
  const [specialRequests, setSpecialRequests] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [editReason, setEditReason] = useState('');

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize form whenever opened
  useEffect(() => {
    if (!open || !selectedProperty) return;
    setErrorMessage(null);
    setCreatingNewGuest(false);
    setNewGuestFirstName('');
    setNewGuestLastName('');
    setNewGuestPhone('');
    setNewGuestEmail('');

    if (mode === 'edit' && editingReservation) {
      setSelectedGuestId(editingReservation.guestId);
      setArrivalDate(editingReservation.arrivalDate);
      setDepartureDate(editingReservation.departureDate);
      setAdults(editingReservation.adults);
      setChildrenCount(editingReservation.children);
      setRoomId(editingReservation.roomId ?? '');
      setNightlyRate(String(editingReservation.nightlyRate));
      setRateManuallyEdited(true);
      setDiscountAmount(String(editingReservation.discountAmount));
      setSource(editingReservation.source);
      if (editingReservation.status === 'pending' || editingReservation.status === 'confirmed') {
        setStatus(editingReservation.status);
      }
      setCheckInImmediately(false);
      setSpecialRequests(editingReservation.specialRequests ?? '');
      setInternalNotes(editingReservation.internalNotes ?? '');
      setEditReason('');
    } else {
      const propToday = selectedProperty.localToday;
      const startArr =
        initialArrivalDate && isValidIsoDate(initialArrivalDate) && initialArrivalDate >= propToday
          ? initialArrivalDate
          : propToday;
      const startDep =
        initialDepartureDate &&
        isValidIsoDate(initialDepartureDate) &&
        diffDays(startArr, initialDepartureDate) >= 1
          ? initialDepartureDate
          : addDays(startArr, mode === 'walk_in' ? 1 : 2);
      setSelectedGuestId(initialGuest?.id ?? '');
      setArrivalDate(startArr);
      setDepartureDate(startDep);
      setAdults(2);
      setChildrenCount(0);
      setRoomId(initialRoomId ?? '');
      setNightlyRate('');
      setRateManuallyEdited(false);
      setDiscountAmount('0');
      setSource(mode === 'walk_in' ? 'walk_in' : 'direct');
      setStatus('confirmed');
      setCheckInImmediately(mode === 'walk_in' && startArr === propToday);
      setSpecialRequests('');
      setInternalNotes('');
      setEditReason('');
    }
  }, [
    open,
    mode,
    editingReservation,
    initialGuest,
    initialRoomId,
    initialArrivalDate,
    initialDepartureDate,
    selectedProperty,
  ]);

  // Load guests list for selector
  useEffect(() => {
    if (!open || !selectedProperty || mode === 'edit') return;
    let active = true;
    const params = new URLSearchParams({ pageSize: '50' });
    if (guestSearch.trim()) params.set('search', guestSearch.trim());
    apiFetch<PaginatedResult<Guest>>(`/api/guests?${params.toString()}`, {
      propertyId: selectedProperty.id,
    })
      .then((res) => {
        if (!active) return;
        let list = res.items;
        if (initialGuest && !list.some((g) => g.id === initialGuest.id)) {
          list = [initialGuest, ...list];
        }
        setGuests(list);
      })
      .catch(() => {
        if (active) setGuests([]);
      });
    return () => {
      active = false;
    };
  }, [open, selectedProperty?.id, guestSearch, mode, initialGuest]);

  const arrivalInPastForNewBooking =
    mode !== 'edit' &&
    Boolean(selectedProperty) &&
    isValidIsoDate(arrivalDate) &&
    arrivalDate < selectedProperty!.localToday;

  // Load rooms with date availability whenever dates change
  const datesValid =
    isValidIsoDate(arrivalDate) &&
    isValidIsoDate(departureDate) &&
    diffDays(arrivalDate, departureDate) >= 1 &&
    !arrivalInPastForNewBooking;

  useEffect(() => {
    if (!open || !selectedProperty || !datesValid) {
      setRooms([]);
      return;
    }
    let active = true;
    setRoomsLoading(true);
    const params = new URLSearchParams({
      availableFrom: arrivalDate,
      availableTo: departureDate,
    });
    if (mode === 'edit' && editingReservation) {
      params.set('excludeReservationId', editingReservation.id);
    }

    apiFetch<{ items: Room[] }>(`/api/rooms?${params.toString()}`, {
      propertyId: selectedProperty.id,
    })
      .then((res) => {
        if (!active) return;
        setRooms(res.items);
      })
      .catch(() => {
        if (active) setRooms([]);
      })
      .finally(() => {
        if (active) setRoomsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open, selectedProperty?.id, arrivalDate, departureDate, datesValid, mode, editingReservation]);

  const totalGuests = Number(adults) + Number(childrenCount);
  const selectedRoom = useMemo(() => rooms.find((r) => r.id === roomId) ?? null, [rooms, roomId]);

  // Auto-set default nightly rate from selected room when not manually edited
  useEffect(() => {
    if (selectedRoom && !rateManuallyEdited) {
      setNightlyRate(String(selectedRoom.baseRate));
    }
  }, [selectedRoom, rateManuallyEdited]);

  const nights = datesValid ? diffDays(arrivalDate, departureDate) : 0;

  const pricingPreview = useMemo(() => {
    if (!selectedProperty || nights < 1) return null;
    const rateNum = Number(nightlyRate);
    const discNum = Number(discountAmount || 0);
    if (!Number.isFinite(rateNum) || rateNum < 0 || !Number.isFinite(discNum) || discNum < 0) {
      return null;
    }
    const taxRate =
      mode === 'edit' && editingReservation
        ? editingReservation.taxRate
        : selectedProperty.defaultTaxRate;
    try {
      return calculateReservationFinancials({
        nights,
        nightlyRate: rateNum,
        discountAmount: discNum,
        taxRate,
      });
    } catch {
      return null;
    }
  }, [selectedProperty, nights, nightlyRate, discountAmount, mode, editingReservation]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProperty) return;
    setErrorMessage(null);

    if (arrivalInPastForNewBooking) {
      setErrorMessage(
        `Arrival date (${arrivalDate}) cannot be earlier than the property's current local date (${selectedProperty.localToday} in ${selectedProperty.timezone}).`
      );
      return;
    }

    if (!datesValid) {
      setErrorMessage('Departure date must be at least 1 night after arrival date.');
      return;
    }

    if (!roomId) {
      setErrorMessage('Please select an available room for this reservation.');
      return;
    }

    setIsSubmitting(true);
    try {
      let targetGuestId = selectedGuestId;

      if (mode !== 'edit' && creatingNewGuest) {
        if (!newGuestFirstName.trim() || !newGuestLastName.trim() || !newGuestPhone.trim()) {
          setErrorMessage('First name, last name, and phone number are required to register a guest.');
          setIsSubmitting(false);
          return;
        }
        const createdGuest = await apiFetch<{ guest: Guest }>('/api/guests', {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: {
            firstName: newGuestFirstName.trim(),
            lastName: newGuestLastName.trim(),
            phone: newGuestPhone.trim(),
            email: newGuestEmail.trim(),
          },
        });
        targetGuestId = createdGuest.guest.id;
      }

      if (mode !== 'edit' && !targetGuestId) {
        setErrorMessage('Please select an existing guest or register a new guest.');
        setIsSubmitting(false);
        return;
      }

      if (mode === 'edit' && editingReservation) {
        const body: Record<string, unknown> = {
          roomId,
          arrivalDate,
          departureDate,
          adults: Number(adults),
          children: Number(childrenCount),
          nightlyRate: Number(nightlyRate),
          discountAmount: Number(discountAmount || 0),
          source,
          specialRequests,
          internalNotes,
          editReason: editReason.trim() || undefined,
        };
        if (
          editingReservation.status === 'pending' ||
          editingReservation.status === 'confirmed'
        ) {
          body.status = status;
        }

        const res = await apiFetch<{ reservation: ReservationDetail }>(
          `/api/reservations/${editingReservation.id}`,
          {
            method: 'PUT',
            propertyId: selectedProperty.id,
            body,
          }
        );
        showToast('success', `Reservation ${res.reservation.bookingReference} updated.`);
        onSaved(res.reservation);
        onClose();
      } else {
        const res = await apiFetch<{ reservation: ReservationDetail }>('/api/reservations', {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: {
            guestId: targetGuestId,
            roomId,
            arrivalDate,
            departureDate,
            adults: Number(adults),
            children: Number(childrenCount),
            nightlyRate: nightlyRate !== '' ? Number(nightlyRate) : undefined,
            discountAmount: Number(discountAmount || 0),
            source: mode === 'walk_in' ? 'walk_in' : source,
            isWalkIn: mode === 'walk_in' || source === 'walk_in',
            checkInImmediately: checkInImmediately,
            status,
            specialRequests,
            internalNotes,
          },
        });
        showToast(
          'success',
          checkInImmediately
            ? `Walk-in booking ${res.reservation.bookingReference} created and checked in!`
            : `Reservation ${res.reservation.bookingReference} created.`
        );
        onSaved(res.reservation);
        onClose();
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Unable to save reservation. Please verify inputs and try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!selectedProperty) return null;

  const modalTitle =
    mode === 'edit'
      ? `Edit Reservation ${editingReservation?.bookingReference ?? ''}`
      : mode === 'walk_in'
        ? 'Walk-In Reservation & Check-In'
        : 'Create New Reservation';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={modalTitle}
      subtitle={`${selectedProperty.name} • Property Date: ${selectedProperty.localToday} (${selectedProperty.timezone})`}
      maxWidthClass="max-w-3xl"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {errorMessage && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800 flex items-start gap-2.5"
          >
            <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Section 1: Guest Selection */}
        {mode !== 'edit' ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">
                1. Guest Information
              </span>
              <button
                type="button"
                onClick={() => setCreatingNewGuest((v) => !v)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-800"
              >
                <UserPlus className="h-3.5 w-3.5" />
                {creatingNewGuest ? 'Select Existing Guest' : 'Quick Register New Guest'}
              </button>
            </div>

            {!creatingNewGuest ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="res-guest-search" className="block text-xs font-medium text-slate-600 mb-1">
                    Search Guest Directory
                  </label>
                  <div className="relative">
                    <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="res-guest-search"
                      type="text"
                      value={guestSearch}
                      onChange={(e) => setGuestSearch(e.target.value)}
                      placeholder="Filter by name, phone, email..."
                      className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="res-guest-select" className="block text-xs font-medium text-slate-600 mb-1">
                    Select Guest *
                  </label>
                  <select
                    id="res-guest-select"
                    value={selectedGuestId}
                    onChange={(e) => setSelectedGuestId(e.target.value)}
                    required={!creatingNewGuest}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="">-- Choose a guest --</option>
                    {guests.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.fullName} ({g.phone}){g.vipStatus ? ' ★ VIP' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="ng-first" className="block text-xs font-medium text-slate-600 mb-1">
                    First Name *
                  </label>
                  <input
                    id="ng-first"
                    type="text"
                    required
                    value={newGuestFirstName}
                    onChange={(e) => setNewGuestFirstName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="ng-last" className="block text-xs font-medium text-slate-600 mb-1">
                    Last Name *
                  </label>
                  <input
                    id="ng-last"
                    type="text"
                    required
                    value={newGuestLastName}
                    onChange={(e) => setNewGuestLastName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="ng-phone" className="block text-xs font-medium text-slate-600 mb-1">
                    Phone Number *
                  </label>
                  <input
                    id="ng-phone"
                    type="tel"
                    required
                    value={newGuestPhone}
                    onChange={(e) => setNewGuestPhone(e.target.value)}
                    placeholder="+91 98..."
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="ng-email" className="block text-xs font-medium text-slate-600 mb-1">
                    Email (Optional)
                  </label>
                  <input
                    id="ng-email"
                    type="email"
                    value={newGuestEmail}
                    onChange={(e) => setNewGuestEmail(e.target.value)}
                    placeholder="guest@example.com"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500">Guest</p>
              <p className="text-sm font-semibold text-slate-900">
                {editingReservation?.guestName} ({editingReservation?.guestPhone})
              </p>
            </div>
            <span className="text-xs font-medium text-slate-500">
              Ref: {editingReservation?.bookingReference}
            </span>
          </div>
        )}

        {/* Section 2: Dates & Occupancy */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <label htmlFor="res-arrival" className="block text-xs font-medium text-slate-700 mb-1">
              Arrival Date (Inclusive) *
            </label>
            <input
              id="res-arrival"
              type="date"
              required
              min={mode !== 'edit' ? selectedProperty.localToday : undefined}
              value={arrivalDate}
              onChange={(e) => setArrivalDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="res-departure" className="block text-xs font-medium text-slate-700 mb-1">
              Departure Date (Exclusive) *
            </label>
            <input
              id="res-departure"
              type="date"
              required
              min={
                isValidIsoDate(arrivalDate)
                  ? addDays(arrivalDate, 1)
                  : mode !== 'edit'
                    ? addDays(selectedProperty.localToday, 1)
                    : undefined
              }
              value={departureDate}
              onChange={(e) => setDepartureDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="res-adults" className="block text-xs font-medium text-slate-700 mb-1">
              Adults *
            </label>
            <input
              id="res-adults"
              type="number"
              min={1}
              max={20}
              required
              value={adults}
              onChange={(e) => setAdults(Math.max(1, Number(e.target.value)))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="res-children" className="block text-xs font-medium text-slate-700 mb-1">
              Children
            </label>
            <input
              id="res-children"
              type="number"
              min={0}
              max={15}
              value={childrenCount}
              onChange={(e) => setChildrenCount(Math.max(0, Number(e.target.value)))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
        </div>

        {/* Section 3: Room Assignment with Live Availability */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="res-room-select" className="block text-xs font-semibold uppercase tracking-wider text-slate-600">
              2. Room Assignment ({nights > 0 ? `${nights} night${nights === 1 ? '' : 's'}, ${totalGuests} guest${totalGuests === 1 ? '' : 's'}` : 'Select valid dates'})
            </label>
            {roomsLoading && <span className="text-xs text-indigo-600">Checking availability...</span>}
          </div>

          <select
            id="res-room-select"
            value={roomId}
            onChange={(e) => {
              setRoomId(e.target.value);
              if (mode !== 'edit') setRateManuallyEdited(false);
            }}
            required
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
          >
            <option value="">-- Select an available room --</option>
            {rooms.map((rm) => {
              const capacityOk = rm.maxCapacity >= totalGuests;
              const isAvailable = Boolean(rm.availableForDates) && capacityOk;
              let statusSuffix = 'Available';
              if (!rm.availableForDates) {
                if (rm.conflictingMaintenanceTitle) {
                  statusSuffix = `Unavailable (Maint: ${rm.conflictingMaintenanceTitle})`;
                } else if (
                  rm.operationalStatus !== 'available' ||
                  rm.housekeepingStatus === 'out_of_service'
                ) {
                  statusSuffix = `Unavailable (${rm.operationalStatus})`;
                } else if (rm.conflictingBookingRef) {
                  statusSuffix = `Booked (${rm.conflictingBookingRef})`;
                } else {
                  statusSuffix = 'Unavailable';
                }
              } else if (!capacityOk) {
                statusSuffix = `Max capacity ${rm.maxCapacity}`;
              }

              const hkLabel =
                rm.housekeepingStatus === 'dirty' && rm.cleaningInProgress
                  ? 'cleaning in progress'
                  : rm.housekeepingStatus;

              return (
                <option key={rm.id} value={rm.id} disabled={!isAvailable}>
                  Room {rm.roomNumber} — {rm.roomTypeName} (Max {rm.maxCapacity},{' '}
                  {formatMoney(rm.baseRate, selectedProperty.currency)}/night, HK: {hkLabel}) — [
                  {statusSuffix}]
                </option>
              );
            })}
          </select>

          {selectedRoom && (
            <div className="mt-2.5 space-y-2">
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                <span>
                  Selected: <strong>Room {selectedRoom.roomNumber}</strong> (Floor{' '}
                  {selectedRoom.floor}, {selectedRoom.roomTypeName})
                </span>
                <span className="inline-flex items-center gap-1">
                  Operational: <OperationalBadge status={selectedRoom.operationalStatus} />
                </span>
                <span className="inline-flex items-center gap-1">
                  Cleanliness:{' '}
                  <HousekeepingBadge
                    status={selectedRoom.housekeepingStatus}
                    cleaningInProgress={selectedRoom.cleaningInProgress}
                  />
                </span>
              </div>

              {selectedRoom.housekeepingStatus === 'dirty' && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <span>
                    {selectedRoom.cleaningInProgress
                      ? `Room ${selectedRoom.roomNumber} is currently in Cleaning in Progress.`
                      : `Room ${selectedRoom.roomNumber} is currently marked Dirty.`}{' '}
                    {checkInImmediately
                      ? 'Immediate check-in is blocked until housekeeping marks the room Clean or Inspected.'
                      : 'Booking can be saved, and housekeeping must complete cleaning before guest check-in.'}
                  </span>
                </div>
              )}

              {selectedRoom.openMaintenanceCount > 0 && (
                <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-900 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-orange-600 shrink-0 mt-0.5" />
                  <span>
                    <strong>Maintenance Warning:</strong> Room {selectedRoom.roomNumber} has{' '}
                    {selectedRoom.openMaintenanceCount} open maintenance request
                    {selectedRoom.openMaintenanceCount === 1 ? '' : 's'}
                    {selectedRoom.activeMaintenanceSummary
                      ? ` ("${selectedRoom.activeMaintenanceSummary}")`
                      : ''}
                    . Verify readiness with maintenance before arrival.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Section 4: Rate, Discount, Source & Status */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <label htmlFor="res-rate" className="block text-xs font-medium text-slate-700 mb-1">
              Nightly Rate ({selectedProperty.currency}) *
            </label>
            <input
              id="res-rate"
              type="number"
              step="0.01"
              min={0}
              required
              value={nightlyRate}
              onChange={(e) => {
                setNightlyRate(e.target.value);
                setRateManuallyEdited(true);
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="res-discount" className="block text-xs font-medium text-slate-700 mb-1">
              Total Discount ({selectedProperty.currency})
            </label>
            <input
              id="res-discount"
              type="number"
              step="0.01"
              min={0}
              value={discountAmount}
              onChange={(e) => setDiscountAmount(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="res-source" className="block text-xs font-medium text-slate-700 mb-1">
              Booking Source
            </label>
            <select
              id="res-source"
              value={source}
              onChange={(e) => setSource(e.target.value as BookingSource)}
              disabled={mode === 'walk_in'}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
            >
              {BOOKING_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {BOOKING_SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="res-status" className="block text-xs font-medium text-slate-700 mb-1">
              Initial / Booking Status
            </label>
            {mode === 'edit' && editingReservation?.status === 'checked_in' ? (
              <input
                id="res-status"
                type="text"
                disabled
                value="Checked In"
                className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-600"
              />
            ) : (
              <select
                id="res-status"
                value={status}
                disabled={checkInImmediately}
                onChange={(e) => setStatus(e.target.value as 'pending' | 'confirmed')}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
              >
                <option value="confirmed">Confirmed</option>
                <option value="pending">Pending</option>
              </select>
            )}
          </div>
        </div>

        {/* Walk-in / Immediate Check-in Toggle */}
        {mode !== 'edit' && arrivalDate === selectedProperty.localToday && (
          <label className="flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={checkInImmediately}
              onChange={(e) => setCheckInImmediately(e.target.checked)}
              className="h-4 w-4 rounded border-emerald-400 text-emerald-600 focus:ring-emerald-500"
            />
            <div className="text-xs">
              <span className="font-semibold text-emerald-950 flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                Check guest in immediately upon saving
              </span>
              <span className="text-emerald-700">
                Marks booking Checked In right now (requires room to be Clean or Inspected).
              </span>
            </div>
          </label>
        )}

        {/* Notes & Requests */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="res-requests" className="block text-xs font-medium text-slate-700 mb-1">
              Guest Special Requests
            </label>
            <textarea
              id="res-requests"
              rows={2}
              value={specialRequests}
              onChange={(e) => setSpecialRequests(e.target.value)}
              placeholder="Dietary needs, airport pickup, bedding preferences..."
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="res-internal" className="block text-xs font-medium text-slate-700 mb-1">
              Front Desk Internal Notes
            </label>
            <textarea
              id="res-internal"
              rows={2}
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              placeholder="Staff-only operational notes..."
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
        </div>

        {mode === 'edit' && (
          <div>
            <label htmlFor="res-edit-reason" className="block text-xs font-medium text-slate-700 mb-1">
              Reason for Modification (logged in status history)
            </label>
            <input
              id="res-edit-reason"
              type="text"
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              placeholder="e.g., Guest requested early departure / room upgrade"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
        )}

        {/* Financial Summary Preview */}
        {pricingPreview && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="space-y-0.5 text-slate-600">
              <div>
                Room Subtotal ({pricingPreview.nights} ×{' '}
                {formatMoney(pricingPreview.nightlyRate, selectedProperty.currency)}):{' '}
                <strong className="text-slate-900">
                  {formatMoney(pricingPreview.roomSubtotal, selectedProperty.currency)}
                </strong>
              </div>
              <div>
                Discount:{' '}
                <strong className="text-slate-900">
                  -{formatMoney(pricingPreview.discountAmount, selectedProperty.currency)}
                </strong>{' '}
                • {selectedProperty.taxName} ({pricingPreview.taxRate}%):{' '}
                <strong className="text-slate-900">
                  {formatMoney(pricingPreview.taxAmount, selectedProperty.currency)}
                </strong>
              </div>
            </div>
            <div className="text-right">
              <span className="block text-[11px] uppercase tracking-wider text-slate-500">
                Estimated Stay Total
              </span>
              <span className="text-lg font-bold text-indigo-700">
                {formatMoney(pricingPreview.estimatedTotal, selectedProperty.currency)}
              </span>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            {isSubmitting
              ? 'Saving...'
              : mode === 'edit'
                ? 'Save Changes'
                : checkInImmediately
                  ? 'Create & Check In'
                  : 'Create Reservation'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
