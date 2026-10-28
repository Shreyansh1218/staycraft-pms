import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  UserPlus,
  Search,
  Star,
  Phone,
  Mail,
  MapPin,
  Eye,
  Pencil,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { formatDisplayDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type { Guest, GuestDetail, PaginatedResult } from '@shared/types';
import { ReservationFormModal } from '../components/reservations/ReservationFormModal';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import { Modal } from '../components/ui/Modal';
import { HousekeepingBadge, ReservationStatusBadge } from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch } from '../lib/api';

export function GuestsPage() {
  const { selectedProperty } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [data, setData] = useState<PaginatedResult<Guest> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [vipOnly, setVipOnly] = useState(false);
  const [page, setPage] = useState(1);

  // Create / Edit Guest Modal
  const [formOpen, setFormOpen] = useState(false);
  const [editingGuest, setEditingGuest] = useState<Guest | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [city, setCity] = useState('');
  const [stateRegion, setStateRegion] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('');
  const [idDocType, setIdDocType] = useState('');
  const [idDocNum, setIdDocNum] = useState('');
  const [vipStatus, setVipStatus] = useState(false);
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Guest Detail Inspection Modal
  const [inspectedGuest, setInspectedGuest] = useState<GuestDetail | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);

  // Quick Book Stay for Guest
  const [bookingGuest, setBookingGuest] = useState<Guest | null>(null);

  const loadGuests = useCallback(async () => {
    if (!selectedProperty) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '15',
      });
      if (search.trim()) params.set('search', search.trim());
      if (vipOnly) params.set('vipOnly', 'true');

      const res = await apiFetch<PaginatedResult<Guest>>(`/api/guests?${params.toString()}`, {
        propertyId: selectedProperty.id,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load guest CRM records');
    } finally {
      setLoading(false);
    }
  }, [selectedProperty?.id, page, search, vipOnly]);

  useEffect(() => {
    void loadGuests();
  }, [loadGuests]);

  const inspectGuestById = useCallback(
    async (guestId: string) => {
      if (!selectedProperty) return;
      setInspectLoading(true);
      try {
        const res = await apiFetch<{ guest: GuestDetail }>(`/api/guests/${guestId}`, {
          propertyId: selectedProperty.id,
        });
        setInspectedGuest(res.guest);
      } catch (err) {
        showToast('error', err instanceof ApiClientError ? err.message : 'Unable to load guest');
      } finally {
        setInspectLoading(false);
      }
    },
    [selectedProperty?.id, showToast]
  );

  // Handle ?new=1 or ?inspect=<id>
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      openCreateGuest();
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
    const inspectId = searchParams.get('inspect');
    if (inspectId) {
      void inspectGuestById(inspectId);
      const next = new URLSearchParams(searchParams);
      next.delete('inspect');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, inspectGuestById]);

  const openCreateGuest = () => {
    setEditingGuest(null);
    setFirstName('');
    setLastName('');
    setPhone('');
    setEmail('');
    setAddressLine1('');
    setCity('');
    setStateRegion('');
    setPostalCode('');
    setCountry('');
    setIdDocType('');
    setIdDocNum('');
    setVipStatus(false);
    setNotes('');
    setFormError(null);
    setFormOpen(true);
  };

  const openEditGuest = (g: Guest) => {
    setEditingGuest(g);
    setFirstName(g.firstName);
    setLastName(g.lastName);
    setPhone(g.phone);
    setEmail(g.email);
    setAddressLine1(g.addressLine1);
    setCity(g.city);
    setStateRegion(g.stateRegion);
    setPostalCode(g.postalCode);
    setCountry(g.country);
    setIdDocType(g.idDocumentType);
    setIdDocNum(g.idDocumentNumber);
    setVipStatus(g.vipStatus);
    setNotes(g.notes);
    setFormError(null);
    setFormOpen(true);
  };

  const handleSaveGuest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProperty) return;
    setFormError(null);
    setSubmitting(true);
    try {
      const payload = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
        email: email.trim(),
        addressLine1: addressLine1.trim(),
        city: city.trim(),
        stateRegion: stateRegion.trim(),
        postalCode: postalCode.trim(),
        country: country.trim(),
        idDocumentType: idDocType.trim(),
        idDocumentNumber: idDocNum.trim(),
        vipStatus,
        notes: notes.trim(),
      };

      if (editingGuest) {
        const res = await apiFetch<{ guest: Guest }>(`/api/guests/${editingGuest.id}`, {
          method: 'PUT',
          propertyId: selectedProperty.id,
          body: payload,
        });
        showToast('success', `Updated guest record for ${res.guest.fullName}.`);
        if (inspectedGuest?.id === editingGuest.id) {
          await inspectGuestById(editingGuest.id);
        }
      } else {
        const res = await apiFetch<{ guest: Guest }>('/api/guests', {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: payload,
        });
        showToast('success', `Registered guest ${res.guest.fullName}.`);
      }

      setFormOpen(false);
      await loadGuests();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'Unable to save guest record');
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
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Guest CRM Directory</h1>
          <p className="text-sm text-slate-500">
            Manage guest contact records, preferences, notes, and linked stay histories.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateGuest}
          className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
        >
          <UserPlus className="h-4 w-4" />
          Register Guest
        </button>
      </div>

      {/* Search & VIP Filter */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            aria-label="Search guest directory"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name, phone, email, city, notes..."
            className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={vipOnly}
            onChange={(e) => {
              setVipOnly(e.target.checked);
              setPage(1);
            }}
            className="rounded border-slate-300 text-amber-500"
          />
          <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-400" />
          VIP Guests Only
        </label>
      </div>

      {error && <ErrorAlert message={error} onRetry={loadGuests} />}

      {loading && !data ? (
        <LoadingState label="Loading guests..." />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          title="No guest records found"
          description="Register a new guest or clear your search filter."
          action={
            <button
              type="button"
              onClick={openCreateGuest}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white"
            >
              Register First Guest
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
                    <th className="px-5 py-3">Guest Name</th>
                    <th className="px-5 py-3">Contact</th>
                    <th className="px-5 py-3">Location</th>
                    <th className="px-5 py-3">Bookings</th>
                    <th className="px-5 py-3">Preferences / Notes</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((g) => (
                    <tr key={g.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void inspectGuestById(g.id)}
                            className="font-semibold text-slate-900 hover:text-indigo-600 text-left"
                          >
                            {g.fullName}
                          </button>
                          {g.vipStatus && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                              ★ VIP
                            </span>
                          )}
                          {g.activeStays > 0 && (
                            <span className="rounded bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                              In-House
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-600 space-y-0.5">
                        <p className="flex items-center gap-1.5 font-medium text-slate-800">
                          <Phone className="h-3.5 w-3.5 text-slate-400" />
                          {g.phone}
                        </p>
                        {g.email && (
                          <p className="flex items-center gap-1.5">
                            <Mail className="h-3.5 w-3.5 text-slate-400" />
                            {g.email}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-600">
                        {[g.city, g.country].filter(Boolean).join(', ') || '—'}
                      </td>
                      <td className="px-5 py-3 text-xs font-semibold text-slate-700">
                        {g.totalReservations} stay{g.totalReservations === 1 ? '' : 's'}
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-500 max-w-xs truncate">
                        {g.notes || '—'}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            title="Inspect guest & stay history"
                            onClick={() => void inspectGuestById(g.id)}
                            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-indigo-600"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title="Edit guest profile"
                            onClick={() => openEditGuest(g)}
                            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title="Create reservation for this guest"
                            onClick={() => setBookingGuest(g)}
                            className="rounded-lg p-1.5 text-indigo-600 hover:bg-indigo-50"
                          >
                            <CalendarPlus className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 bg-slate-50/50 text-xs text-slate-600">
              <span>
                Total Guests: <strong>{data.total}</strong>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={data.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev
                </button>
                <span>
                  Page {data.page} of {data.totalPages}
                </span>
                <button
                  type="button"
                  disabled={data.page >= data.totalPages}
                  onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 disabled:opacity-40"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )
      )}

      {/* Create / Edit Guest Modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editingGuest ? `Edit Guest — ${editingGuest.fullName}` : 'Register New Guest'}
        maxWidthClass="max-w-xl"
      >
        <form onSubmit={handleSaveGuest} className="space-y-4">
          {formError && <ErrorAlert message={formError} />}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="g-first" className="block text-xs font-medium text-slate-700 mb-1">
                First Name *
              </label>
              <input
                id="g-first"
                type="text"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="g-last" className="block text-xs font-medium text-slate-700 mb-1">
                Last Name *
              </label>
              <input
                id="g-last"
                type="text"
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="g-phone" className="block text-xs font-medium text-slate-700 mb-1">
                Phone Number *
              </label>
              <input
                id="g-phone"
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 98..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="g-email" className="block text-xs font-medium text-slate-700 mb-1">
                Email Address
              </label>
              <input
                id="g-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="guest@example.com"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="g-addr" className="block text-xs font-medium text-slate-700 mb-1">
              Street Address (Optional)
            </label>
            <input
              id="g-addr"
              type="text"
              value={addressLine1}
              onChange={(e) => setAddressLine1(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label htmlFor="g-city" className="block text-xs font-medium text-slate-700 mb-1">
                City
              </label>
              <input
                id="g-city"
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="g-state" className="block text-xs font-medium text-slate-700 mb-1">
                State / Region
              </label>
              <input
                id="g-state"
                type="text"
                value={stateRegion}
                onChange={(e) => setStateRegion(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="g-zip" className="block text-xs font-medium text-slate-700 mb-1">
                Postal Code
              </label>
              <input
                id="g-zip"
                type="text"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="g-country" className="block text-xs font-medium text-slate-700 mb-1">
                Country
              </label>
              <input
                id="g-country"
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="g-id-type" className="block text-xs font-medium text-slate-700 mb-1">
                ID Document Type
              </label>
              <input
                id="g-id-type"
                type="text"
                value={idDocType}
                onChange={(e) => setIdDocType(e.target.value)}
                placeholder="Passport / Aadhaar / Driver License"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="g-id-num" className="block text-xs font-medium text-slate-700 mb-1">
                ID Document Number
              </label>
              <input
                id="g-id-num"
                type="text"
                value={idDocNum}
                onChange={(e) => setIdDocNum(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="g-notes" className="block text-xs font-medium text-slate-700 mb-1">
              Guest Preferences & Notes
            </label>
            <textarea
              id="g-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Dietary preferences, room floor preferences, allergies..."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={vipStatus}
              onChange={(e) => setVipStatus(e.target.checked)}
              className="rounded border-slate-300 text-amber-500"
            />
            Mark as VIP Guest
          </label>

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? 'Saving...' : editingGuest ? 'Save Changes' : 'Register Guest'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Guest Inspection & Linked Reservations Modal */}
      <Modal
        open={inspectedGuest !== null || inspectLoading}
        onClose={() => setInspectedGuest(null)}
        title={inspectedGuest ? inspectedGuest.fullName : 'Guest Profile'}
        subtitle="Guest CRM Profile & Linked Reservation History"
        maxWidthClass="max-w-2xl"
      >
        {inspectLoading || !inspectedGuest ? (
          <LoadingState label="Loading guest profile..." />
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl bg-slate-50 border border-slate-200 p-4 text-xs">
              <div className="space-y-1.5 text-slate-600">
                <p className="flex items-center gap-2 font-semibold text-slate-900 text-sm">
                  {inspectedGuest.fullName}
                  {inspectedGuest.vipStatus && (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                      ★ VIP
                    </span>
                  )}
                </p>
                <p className="flex items-center gap-2">
                  <Phone className="h-3.5 w-3.5 text-slate-400" /> {inspectedGuest.phone}
                </p>
                {inspectedGuest.email && (
                  <p className="flex items-center gap-2">
                    <Mail className="h-3.5 w-3.5 text-slate-400" /> {inspectedGuest.email}
                  </p>
                )}
                {(inspectedGuest.addressLine1 || inspectedGuest.city || inspectedGuest.country) && (
                  <p className="flex items-center gap-2">
                    <MapPin className="h-3.5 w-3.5 text-slate-400" />
                    {[
                      inspectedGuest.addressLine1,
                      inspectedGuest.city,
                      inspectedGuest.stateRegion,
                      inspectedGuest.postalCode,
                      inspectedGuest.country,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                )}
                {inspectedGuest.idDocumentNumber && (
                  <p className="text-slate-500">
                    ID ({inspectedGuest.idDocumentType || 'Document'}):{' '}
                    <strong>{inspectedGuest.idDocumentNumber}</strong>
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openEditGuest(inspectedGuest)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Edit Profile
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const g = inspectedGuest;
                    setInspectedGuest(null);
                    setBookingGuest(g);
                  }}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
                >
                  + Book Stay
                </button>
              </div>
            </div>

            {inspectedGuest.notes && (
              <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-xs text-amber-950">
                <strong>Guest Notes:</strong> {inspectedGuest.notes}
              </div>
            )}

            <div>
              <h3 className="text-sm font-semibold text-slate-900 mb-2">
                Linked Reservations ({inspectedGuest.reservations.length})
              </h3>
              {inspectedGuest.reservations.length === 0 ? (
                <p className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-200 rounded-xl">
                  No reservations linked to this guest yet.
                </p>
              ) : (
                <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 overflow-hidden">
                  {inspectedGuest.reservations.map((r) => (
                    <div
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs hover:bg-slate-50"
                    >
                      <div>
                        <Link
                          to={`/reservations/${r.id}`}
                          onClick={() => setInspectedGuest(null)}
                          className="font-mono font-bold text-indigo-600 hover:underline"
                        >
                          {r.bookingReference}
                        </Link>
                        <p className="text-slate-600 mt-0.5 flex flex-wrap items-center gap-1.5">
                          <span>
                            {formatDisplayDate(r.arrivalDate)} → {formatDisplayDate(r.departureDate)}{' '}
                            • {r.roomNumber ? `Room ${r.roomNumber}` : r.roomTypeName}
                          </span>
                          {r.roomHousekeepingStatus && (
                            <HousekeepingBadge
                              status={r.roomHousekeepingStatus}
                              cleaningInProgress={r.roomCleaningInProgress}
                            />
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-slate-900">
                          {formatMoney(r.estimatedTotal, r.currency)}
                        </span>
                        <ReservationStatusBadge status={r.status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Book Stay Modal Pre-filled for Guest */}
      <ReservationFormModal
        open={bookingGuest !== null}
        onClose={() => setBookingGuest(null)}
        mode="create"
        initialGuest={bookingGuest}
        onSaved={() => {
          void loadGuests();
        }}
      />
    </div>
  );
}
