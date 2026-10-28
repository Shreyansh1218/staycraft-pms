import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  BedDouble,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  FilePlus2,
  FileText,
  LogIn,
  LogOut,
  Mail,
  Pencil,
  Phone,
  Sparkles,
  User,
  UtensilsCrossed,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { BOOKING_SOURCE_LABELS, type CleaningWorkflowAction } from '@shared/constants';
import { addDays, diffDays, formatDisplayDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type { InvoiceDetail, ReservationDetail } from '@shared/types';
import { RecordPaymentModal } from '../components/billing/BillingModals';
import { ReservationFormModal } from '../components/reservations/ReservationFormModal';
import { ErrorAlert, LoadingState } from '../components/ui/Feedback';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import {
  HousekeepingBadge,
  InvoiceStatusBadge,
  OperationalBadge,
  ReservationStatusBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch } from '../lib/api';

export function ReservationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { selectedProperty } = useAuth();
  const { showToast } = useToast();

  const [reservation, setReservation] = useState<ReservationDetail | null>(null);
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [checkInNote, setCheckInNote] = useState('');
  const [checkOutOpen, setCheckOutOpen] = useState(false);
  const [checkOutNote, setCheckOutNote] = useState('');
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const refreshInvoice = useCallback(async () => {
    if (!selectedProperty || !id) return;
    try {
      const invRes = await apiFetch<{ invoice: InvoiceDetail | null }>(
        `/api/reservations/${id}/invoice`,
        { propertyId: selectedProperty.id }
      );
      setInvoice(invRes.invoice);
    } catch {
      // Non-fatal; reservation detail remains primary
    }
  }, [selectedProperty?.id, id]);

  const loadDetail = useCallback(async () => {
    if (!selectedProperty || !id) return;
    setLoading(true);
    setError(null);
    try {
      const [res, invRes] = await Promise.all([
        apiFetch<{ reservation: ReservationDetail }>(`/api/reservations/${id}`, {
          propertyId: selectedProperty.id,
        }),
        apiFetch<{ invoice: InvoiceDetail | null }>(`/api/reservations/${id}/invoice`, {
          propertyId: selectedProperty.id,
        }).catch(() => ({ invoice: null })),
      ]);
      setReservation(res.reservation);
      setInvoice(invRes.invoice);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load reservation');
    } finally {
      setLoading(false);
    }
  }, [selectedProperty?.id, id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  if (loading && !reservation) return <LoadingState label="Loading booking details..." />;
  if (error || !reservation || !selectedProperty) {
    return <ErrorAlert message={error ?? 'Reservation not found'} onRetry={loadDetail} />;
  }

  const propToday = selectedProperty.localToday;
  const arrivalMatchesToday = reservation.arrivalDate === propToday;
  const departureMatchesToday = reservation.departureDate === propToday;

  const handleConfirmStatus = async () => {
    setSubmitting(true);
    try {
      const res = await apiFetch<{ reservation: ReservationDetail }>(
        `/api/reservations/${reservation.id}`,
        {
          method: 'PUT',
          propertyId: selectedProperty.id,
          body: { status: 'confirmed', editReason: 'Confirmed tentative booking' },
        }
      );
      setReservation(res.reservation);
      showToast('success', 'Reservation marked as Confirmed.');
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Update failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoomWorkflow = async (action: CleaningWorkflowAction) => {
    if (!reservation.roomId) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/rooms/${reservation.roomId}/housekeeping-workflow`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: { action },
      });
      const labels: Record<CleaningWorkflowAction, string> = {
        start_cleaning: `Room ${reservation.roomNumber} moved to Cleaning in Progress.`,
        complete_cleaning: `Room ${reservation.roomNumber} marked Clean.`,
        inspect_room: `Room ${reservation.roomNumber} marked Inspected.`,
        mark_dirty: `Room ${reservation.roomNumber} marked Dirty.`,
      };
      showToast('success', labels[action]);
      await loadDetail();
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Failed to update room');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMarkRoomClean = async () => {
    await handleRoomWorkflow('complete_cleaning');
  };

  const roomBlockedForCheckIn =
    reservation.roomHasInventoryBlock ||
    Boolean(reservation.roomOperationalStatus && reservation.roomOperationalStatus !== 'available') ||
    reservation.roomHousekeepingStatus === 'out_of_service';

  const handleDeliberateDateEditAndCheckIn = async () => {
    setSubmitting(true);
    try {
      const nextDeparture =
        diffDays(propToday, reservation.departureDate) >= 1
          ? reservation.departureDate
          : addDays(propToday, Math.max(1, reservation.nights));

      await apiFetch<{ reservation: ReservationDetail }>(`/api/reservations/${reservation.id}`, {
        method: 'PUT',
        propertyId: selectedProperty.id,
        body: {
          arrivalDate: propToday,
          departureDate: nextDeparture,
          editReason: `Deliberate arrival date adjustment to ${propToday} for check-in`,
        },
      });

      const checkedIn = await apiFetch<{ reservation: ReservationDetail }>(
        `/api/reservations/${reservation.id}/check-in`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: { note: checkInNote.trim() },
        }
      );
      setReservation(checkedIn.reservation);
      setCheckInOpen(false);
      setCheckInNote('');
      showToast('success', 'Dates validated and guest checked in!');
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Check-in failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckIn = async () => {
    setSubmitting(true);
    try {
      const res = await apiFetch<{ reservation: ReservationDetail }>(
        `/api/reservations/${reservation.id}/check-in`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: { note: checkInNote.trim() },
        }
      );
      setReservation(res.reservation);
      setCheckInOpen(false);
      setCheckInNote('');
      showToast('success', `Checked in ${reservation.guestName} into Room ${reservation.roomNumber}.`);
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Check-in failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeliberateDateEditAndCheckOut = async () => {
    if (diffDays(reservation.arrivalDate, propToday) < 1) {
      showToast(
        'error',
        `Same-day check-out on arrival date (${propToday}) requires minimum 1 night or cancellation prior to check-in. Adjust dates in Edit Reservation if needed.`
      );
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch<{ reservation: ReservationDetail }>(`/api/reservations/${reservation.id}`, {
        method: 'PUT',
        propertyId: selectedProperty.id,
        body: {
          departureDate: propToday,
          editReason: `Deliberate departure date adjustment to ${propToday} for check-out`,
        },
      });

      const checkedOut = await apiFetch<{ reservation: ReservationDetail }>(
        `/api/reservations/${reservation.id}/check-out`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: { note: checkOutNote.trim() },
        }
      );
      setReservation(checkedOut.reservation);
      await refreshInvoice();
      setCheckOutOpen(false);
      setCheckOutNote('');
      showToast('success', 'Departure date updated and guest checked out!');
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Check-out failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckOut = async () => {
    setSubmitting(true);
    try {
      const res = await apiFetch<{ reservation: ReservationDetail }>(
        `/api/reservations/${reservation.id}/check-out`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: { note: checkOutNote.trim() },
        }
      );
      setReservation(res.reservation);
      await refreshInvoice();
      setCheckOutOpen(false);
      setCheckOutNote('');
      showToast(
        'success',
        `Checked out ${reservation.guestName}; Room ${reservation.roomNumber} marked Dirty.`
      );
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Check-out failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleGenerateReservationInvoice = async (issueImmediately: boolean) => {
    setSubmitting(true);
    try {
      const res = await apiFetch<{ invoice: InvoiceDetail; created: boolean }>(
        `/api/invoices/from-reservation/${reservation.id}`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: { issueImmediately },
        }
      );
      setInvoice(res.invoice);
      showToast(
        'success',
        issueImmediately
          ? `Issued invoice ${res.invoice.invoiceNumber}`
          : `Generated draft invoice ${res.invoice.invoiceNumber}`
      );
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Failed to generate invoice');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (cancelReason.trim().length < 2) {
      showToast('error', 'Please enter a cancellation reason.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ reservation: ReservationDetail }>(
        `/api/reservations/${reservation.id}/cancel`,
        {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: { reason: cancelReason.trim() },
        }
      );
      setReservation(res.reservation);
      setCancelOpen(false);
      setCancelReason('');
      showToast('success', 'Reservation cancelled and room released.');
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Cancellation failed');
    } finally {
      setSubmitting(false);
    }
  };

  const steps = ['pending', 'confirmed', 'checked_in', 'checked_out'] as const;
  const currentStepIdx =
    reservation.status === 'cancelled' ? -1 : steps.indexOf(reservation.status);

  return (
    <div className="space-y-6">
      {/* Top Breadcrumb & Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <Link
            to="/reservations"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-indigo-600 mb-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Reservations
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900 font-mono">
              {reservation.bookingReference}
            </h1>
            <ReservationStatusBadge status={reservation.status} />
            {reservation.isWalkIn && (
              <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                Walk-In Stay
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Source: {BOOKING_SOURCE_LABELS[reservation.source] ?? reservation.source} • Created{' '}
            {new Date(reservation.createdAt).toLocaleString()}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {reservation.status === 'pending' && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleConfirmStatus()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-2 text-xs sm:text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" />
              Confirm Booking
            </button>
          )}

          {(reservation.status === 'pending' || reservation.status === 'confirmed') && (
            <button
              type="button"
              onClick={() => setCheckInOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-emerald-700"
            >
              <LogIn className="h-4 w-4" />
              Check In Guest
            </button>
          )}

          {reservation.status === 'checked_in' && (
            <>
              <Link
                to={`/restaurant?tab=pos&reservationId=${reservation.id}`}
                className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs sm:text-sm font-semibold text-indigo-700 hover:bg-indigo-100"
              >
                <UtensilsCrossed className="h-4 w-4" />
                Order Room Service
              </Link>
              <button
                type="button"
                onClick={() => setCheckOutOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-amber-700"
              >
                <LogOut className="h-4 w-4" />
                Check Out Guest
              </button>
            </>
          )}

          {reservation.status !== 'cancelled' && reservation.status !== 'checked_out' && (
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <Pencil className="h-4 w-4" />
              Edit Reservation
            </button>
          )}

          {(reservation.status === 'pending' || reservation.status === 'confirmed') && (
            <button
              type="button"
              onClick={() => setCancelOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs sm:text-sm font-semibold text-rose-700 hover:bg-rose-100"
            >
              <XCircle className="h-4 w-4" />
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Booking Lifecycle Bar */}
      {reservation.status === 'cancelled' ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          <p className="font-semibold">This reservation was cancelled</p>
          <p className="text-xs text-rose-700 mt-0.5">
            Reason: {reservation.cancellationReason || 'No reason specified'} •{' '}
            {reservation.cancelledAt ? new Date(reservation.cancelledAt).toLocaleString() : ''}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="grid grid-cols-4 gap-2">
            {[
              { key: 'pending', label: '1. Pending' },
              { key: 'confirmed', label: '2. Confirmed' },
              { key: 'checked_in', label: '3. Checked In' },
              { key: 'checked_out', label: '4. Checked Out' },
            ].map((step, idx) => {
              const done = idx <= currentStepIdx;
              return (
                <div key={step.key} className="space-y-1.5">
                  <div
                    className={`h-2 rounded-full ${
                      done ? 'bg-indigo-600' : 'bg-slate-100'
                    }`}
                  />
                  <p
                    className={`text-xs font-semibold ${
                      done ? 'text-indigo-700' : 'text-slate-400'
                    }`}
                  >
                    {step.label}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Detail Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Columns */}
        <div className="lg:col-span-2 space-y-6">
          {/* Stay & Room Card */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <BedDouble className="h-4 w-4 text-indigo-600" />
              Stay & Room Allocation
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-100">
                <p className="text-xs text-slate-500 flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" /> Arrival (Check-In)
                </p>
                <p className="font-semibold text-slate-900 mt-1">
                  {formatDisplayDate(reservation.arrivalDate)}
                </p>
                <p className="text-xs text-slate-500">
                  Policy after {selectedProperty.standardCheckInTime}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-100">
                <p className="text-xs text-slate-500 flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" /> Departure (Check-Out)
                </p>
                <p className="font-semibold text-slate-900 mt-1">
                  {formatDisplayDate(reservation.departureDate)}
                </p>
                <p className="text-xs text-slate-500">
                  {reservation.nights} night{reservation.nights === 1 ? '' : 's'} • Before{' '}
                  {selectedProperty.standardCheckOutTime}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-100">
                <p className="text-xs text-slate-500">Assigned Room</p>
                <p className="font-semibold text-slate-900 mt-1">
                  {reservation.roomNumber
                    ? `Room ${reservation.roomNumber} (Floor ${reservation.floor})`
                    : 'Unassigned'}
                </p>
                <p className="text-xs text-slate-500">
                  {reservation.roomTypeName} • {reservation.adults} Adult
                  {reservation.adults === 1 ? '' : 's'}
                  {reservation.children > 0 ? `, ${reservation.children} Child` : ''}
                </p>
              </div>
            </div>

            {/* Clear Separation of Operational & Housekeeping Status */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3 bg-white text-xs">
              <div className="flex flex-wrap items-center gap-4">
                <span className="inline-flex items-center gap-1.5 text-slate-600">
                  <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                  Housekeeping State:{' '}
                  {reservation.roomHousekeepingStatus ? (
                    <HousekeepingBadge
                      status={reservation.roomHousekeepingStatus}
                      cleaningInProgress={reservation.roomCleaningInProgress}
                    />
                  ) : (
                    'N/A'
                  )}
                </span>
                {reservation.roomOperationalStatus && (
                  <span className="inline-flex items-center gap-1.5 text-slate-600">
                    Physical Status:{' '}
                    <OperationalBadge status={reservation.roomOperationalStatus} />
                  </span>
                )}
              </div>

              {(reservation.status === 'pending' || reservation.status === 'confirmed') && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {reservation.roomHousekeepingStatus === 'dirty' &&
                    !reservation.roomCleaningInProgress && (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => void handleRoomWorkflow('start_cleaning')}
                        className="rounded-lg bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-700"
                      >
                        Start Cleaning
                      </button>
                    )}
                  {reservation.roomHousekeepingStatus === 'dirty' &&
                    reservation.roomCleaningInProgress && (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => void handleMarkRoomClean()}
                        className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-700"
                      >
                        Mark Room Clean
                      </button>
                    )}
                  {reservation.roomHousekeepingStatus === 'clean' && (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void handleRoomWorkflow('inspect_room')}
                      className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                      Mark Inspected
                    </button>
                  )}
                </div>
              )}
            </div>

            {(reservation.status === 'pending' || reservation.status === 'confirmed') &&
              roomBlockedForCheckIn && (
                <div className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-900 flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="font-semibold flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 text-rose-600" />
                      Assigned Room {reservation.roomNumber} is Unavailable (Maintenance / Out of Service)
                    </p>
                    <p className="text-rose-800">
                      Check-in is blocked while this room is out of service. Reassign this booking to
                      an available room or restore the room in Maintenance.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditOpen(true)}
                      className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800"
                    >
                      Reassign Room
                    </button>
                    <Link
                      to="/housekeeping?tab=maintenance"
                      className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-800 hover:bg-rose-100"
                    >
                      View Maintenance
                    </Link>
                  </div>
                </div>
              )}

            {(reservation.status === 'pending' || reservation.status === 'confirmed') &&
              !roomBlockedForCheckIn &&
              reservation.roomOpenMaintenanceCount > 0 && (
                <div className="rounded-xl border border-orange-200 bg-orange-50 px-3.5 py-2.5 text-xs text-orange-900 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4 text-orange-600 shrink-0" />
                    Room {reservation.roomNumber} has {reservation.roomOpenMaintenanceCount} open
                    maintenance request(s). Verify repair status prior to arrival.
                  </span>
                  <Link
                    to="/housekeeping?tab=maintenance"
                    className="font-semibold text-orange-800 hover:underline shrink-0"
                  >
                    Inspect
                  </Link>
                </div>
              )}

            {(reservation.specialRequests || reservation.internalNotes) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100 text-xs">
                <div>
                  <p className="font-semibold text-slate-700 mb-1">Guest Special Requests</p>
                  <p className="text-slate-600 whitespace-pre-line">
                    {reservation.specialRequests || 'None'}
                  </p>
                </div>
                <div>
                  <p className="font-semibold text-slate-700 mb-1">Internal Staff Notes</p>
                  <p className="text-slate-600 whitespace-pre-line">
                    {reservation.internalNotes || 'None'}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Status & Audit Timeline */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <Clock className="h-4 w-4 text-indigo-600" />
              Reservation Status & Change History
            </h2>
            <ol className="relative border-l border-slate-200 ml-3 space-y-4">
              {reservation.history.map((h) => (
                <li key={h.id} className="ml-5">
                  <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-indigo-600" />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-900">
                      {h.note || h.action}
                    </p>
                    <time className="text-[11px] text-slate-400">
                      {new Date(h.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {h.fromStatus ? `${h.fromStatus} → ${h.toStatus}` : `Status: ${h.toStatus}`}
                    {h.changedByName ? ` • By ${h.changedByName} (${h.changedByRole})` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {/* Right Column: Guest Card & Financial Breakdown */}
        <div className="space-y-6">
          {/* Guest CRM Card */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <User className="h-4 w-4 text-indigo-600" />
                Guest Profile
              </h2>
              <Link
                to={`/guests?inspect=${reservation.guest.id}`}
                className="text-xs font-semibold text-indigo-600 hover:underline"
              >
                Open in CRM
              </Link>
            </div>
            <div>
              <p className="text-sm font-bold text-slate-900">
                {reservation.guest.fullName}
                {reservation.guest.vipStatus && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                    VIP
                  </span>
                )}
              </p>
              <div className="mt-2 space-y-1.5 text-xs text-slate-600">
                <p className="flex items-center gap-2">
                  <Phone className="h-3.5 w-3.5 text-slate-400" />
                  {reservation.guest.phone}
                </p>
                {reservation.guest.email && (
                  <p className="flex items-center gap-2">
                    <Mail className="h-3.5 w-3.5 text-slate-400" />
                    {reservation.guest.email}
                  </p>
                )}
                {(reservation.guest.city || reservation.guest.country) && (
                  <p className="text-slate-500">
                    {[reservation.guest.city, reservation.guest.country].filter(Boolean).join(', ')}
                  </p>
                )}
              </div>
              {reservation.guest.notes && (
                <div className="mt-3 rounded-lg bg-amber-50/70 border border-amber-100 p-2.5 text-xs text-amber-900">
                  <strong>CRM Note:</strong> {reservation.guest.notes}
                </div>
              )}
            </div>
          </div>

          {/* Financial Estimate Breakdown */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-3">
            <h2 className="text-base font-semibold text-slate-900">Stay Charges Summary</h2>
            <div className="space-y-2 text-xs text-slate-600">
              <div className="flex justify-between">
                <span>
                  Nightly Rate × {reservation.nights} night{reservation.nights === 1 ? '' : 's'}
                </span>
                <span className="font-medium text-slate-900">
                  {formatMoney(
                    reservation.nightlyRate * reservation.nights,
                    reservation.currency
                  )}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Discount</span>
                <span className="font-medium text-emerald-700">
                  -{formatMoney(reservation.discountAmount, reservation.currency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>
                  {selectedProperty.taxName} ({reservation.taxRate}%)
                </span>
                <span className="font-medium text-slate-900">
                  {formatMoney(reservation.taxAmount, reservation.currency)}
                </span>
              </div>
              <div className="border-t border-slate-200 pt-2.5 flex justify-between items-baseline">
                <span className="text-sm font-semibold text-slate-900">Estimated Total</span>
                <span className="text-lg font-bold text-indigo-700">
                  {formatMoney(reservation.estimatedTotal, reservation.currency)}
                </span>
              </div>
            </div>

            {/* Live Phase 3 Invoice & Settlement Panel */}
            <div
              data-testid="reservation-billing-panel"
              className="mt-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3.5 space-y-2.5"
            >
              {invoice ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to={`/invoices/${invoice.id}`}
                      className="font-mono text-xs font-bold text-indigo-600 hover:underline"
                    >
                      {invoice.invoiceNumber}
                    </Link>
                    <InvoiceStatusBadge status={invoice.status} />
                  </div>

                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between text-slate-600">
                      <span>Invoice Total</span>
                      <span className="font-semibold text-slate-900">
                        {formatMoney(invoice.grandTotal, invoice.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between text-emerald-700">
                      <span>Amount Paid</span>
                      <span className="font-semibold">
                        {formatMoney(invoice.amountPaid, invoice.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between font-bold pt-1 border-t border-slate-200/80">
                      <span className="text-slate-800">Balance Due</span>
                      <span
                        className={
                          invoice.balanceDue > 0 ? 'text-amber-800' : 'text-emerald-700'
                        }
                      >
                        {formatMoney(invoice.balanceDue, invoice.currency)}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1">
                    <Link
                      to={`/invoices/${invoice.id}`}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <FileText className="h-3.5 w-3.5 text-slate-500" />
                      Open Invoice
                    </Link>
                    {invoice.status !== 'void' && invoice.balanceDue > 0 && (
                      <button
                        type="button"
                        onClick={() => setPaymentModalOpen(true)}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        <CreditCard className="h-3.5 w-3.5" />
                        Record Payment
                      </button>
                    )}
                  </div>
                </>
              ) : reservation.status === 'cancelled' ? (
                <p className="text-xs text-slate-500">
                  Cancelled reservations have no active invoice.
                </p>
              ) : (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-700">Invoice Status</span>
                    <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      Not Generated
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void handleGenerateReservationInvoice(false)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <FilePlus2 className="h-3.5 w-3.5 text-indigo-600" />
                      Create Draft
                    </button>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void handleGenerateReservationInvoice(true)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Issue Invoice
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      <ReservationFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        mode="edit"
        editingReservation={reservation}
        onSaved={(updated) => {
          setReservation(updated);
          void refreshInvoice();
        }}
      />

      {/* Explicit Check-In Modal with Date & Housekeeping Validation */}
      <Modal
        open={checkInOpen}
        onClose={() => setCheckInOpen(false)}
        title={`Check In Guest — ${reservation.bookingReference}`}
        maxWidthClass="max-w-lg"
      >
        <div className="space-y-4 text-sm">
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 text-xs space-y-1">
            <p>
              <strong>Guest:</strong> {reservation.guestName} ({reservation.numGuests} guest
              {reservation.numGuests === 1 ? '' : 's'})
            </p>
            <p>
              <strong>Room:</strong> Room {reservation.roomNumber} ({reservation.roomTypeName})
            </p>
            <p>
              <strong>Scheduled Stay:</strong> {reservation.arrivalDate} →{' '}
              {reservation.departureDate}
            </p>
          </div>

          {roomBlockedForCheckIn && (
            <div className="rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-900 space-y-2">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-rose-600" />
                Room {reservation.roomNumber} is Out of Service / In Maintenance
              </p>
              <p>
                Guests cannot be checked into an unavailable room. Reassign this reservation to an
                available clean room first.
              </p>
              <button
                type="button"
                onClick={() => {
                  setCheckInOpen(false);
                  setEditOpen(true);
                }}
                className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800"
              >
                Reassign Room Now
              </button>
            </div>
          )}

          {reservation.roomHousekeepingStatus === 'dirty' && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-900 space-y-2">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                {reservation.roomCleaningInProgress
                  ? `Room ${reservation.roomNumber} is currently in Cleaning in Progress`
                  : `Room ${reservation.roomNumber} is currently marked Dirty`}
              </p>
              <p>
                Update housekeeping status to Clean or Inspected before checking in the guest.
              </p>
              <div className="flex flex-wrap gap-2">
                {!reservation.roomCleaningInProgress && (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void handleRoomWorkflow('start_cleaning')}
                    className="rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800"
                  >
                    Start Cleaning
                  </button>
                )}
                {reservation.roomCleaningInProgress && (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void handleMarkRoomClean()}
                    className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
                  >
                    Mark Room Clean Now
                  </button>
                )}
              </div>
            </div>
          )}

          {!arrivalMatchesToday && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3.5 text-xs text-indigo-950 space-y-2">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-indigo-600" />
                Arrival Date Mismatch ({reservation.arrivalDate} vs Property Today {propToday})
              </p>
              <p>
                Early or late arrival check-ins require a deliberate, validated stay date update so
                room availability and nightly charges remain accurate.
              </p>
            </div>
          )}

          <div>
            <label htmlFor="checkin-note" className="block text-xs font-medium text-slate-700 mb-1">
              Check-In Desk Note (Optional)
            </label>
            <input
              id="checkin-note"
              type="text"
              value={checkInNote}
              onChange={(e) => setCheckInNote(e.target.value)}
              placeholder="ID verified, keycards issued..."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setCheckInOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
            >
              Close
            </button>
            {!arrivalMatchesToday ? (
              <button
                type="button"
                disabled={
                  submitting ||
                  reservation.roomHousekeepingStatus === 'dirty' ||
                  roomBlockedForCheckIn
                }
                onClick={() => void handleDeliberateDateEditAndCheckIn()}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {submitting
                  ? 'Validating...'
                  : `Update Arrival to ${propToday} & Check In`}
              </button>
            ) : (
              <button
                type="button"
                disabled={
                  submitting ||
                  reservation.roomHousekeepingStatus === 'dirty' ||
                  roomBlockedForCheckIn
                }
                onClick={() => void handleCheckIn()}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {submitting ? 'Checking In...' : 'Complete Check-In'}
              </button>
            )}
          </div>
        </div>
      </Modal>

      {/* Explicit Check-Out Modal with Early/Late Departure Validation */}
      <Modal
        open={checkOutOpen}
        onClose={() => setCheckOutOpen(false)}
        title={`Check Out Guest — ${reservation.bookingReference}`}
        maxWidthClass="max-w-lg"
      >
        <div className="space-y-4 text-sm">
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 text-xs space-y-1">
            <p>
              <strong>Guest:</strong> {reservation.guestName} • Room {reservation.roomNumber}
            </p>
            <p>
              <strong>Scheduled Departure:</strong> {reservation.departureDate} (Property Today:{' '}
              {propToday})
            </p>
            <p className="text-slate-500">
              Checking out releases room occupancy immediately and transitions Room{' '}
              {reservation.roomNumber} to <strong>Dirty</strong> for housekeeping turnover.
            </p>
          </div>

          <div
            className={`rounded-xl border p-3.5 text-xs space-y-1 ${
              invoice?.status === 'paid'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
                : 'border-sky-200 bg-sky-50 text-sky-950'
            }`}
          >
            {invoice?.status === 'paid' ? (
              <p className="font-semibold">
                Billing Settled: Invoice {invoice.invoiceNumber} is Paid in full (
                {formatMoney(0, invoice.currency)} balance due).
              </p>
            ) : (
              <>
                <p className="font-semibold">
                  Billing Policy: Checkout will not auto-mark unpaid balances as Paid
                </p>
                <p>
                  {invoice
                    ? `Invoice ${invoice.invoiceNumber} has an open balance of ${formatMoney(invoice.balanceDue, invoice.currency)} and will remain Unpaid / Open Balance until payment is recorded.`
                    : `An itemized Issued (Unpaid) invoice (${formatMoney(reservation.estimatedTotal, reservation.currency)}) will be generated on check-out without blocking departure.`}
                </p>
              </>
            )}
          </div>

          {!departureMatchesToday && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950 space-y-2">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                Early / Late Departure Detected ({reservation.departureDate} vs Today {propToday})
              </p>
              <p>
                Checking out on a different date requires updating the departure date to{' '}
                <strong>{propToday}</strong> so nights, availability, and estimated charges are
                recalculated cleanly.
              </p>
            </div>
          )}

          <div>
            <label htmlFor="checkout-note" className="block text-xs font-medium text-slate-700 mb-1">
              Check-Out Note (Optional)
            </label>
            <input
              id="checkout-note"
              type="text"
              value={checkOutNote}
              onChange={(e) => setCheckOutNote(e.target.value)}
              placeholder="Keys returned, minibar checked..."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setCheckOutOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
            >
              Close
            </button>
            {!departureMatchesToday ? (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleDeliberateDateEditAndCheckOut()}
                className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {submitting
                  ? 'Updating & Checking Out...'
                  : `Update Departure to ${propToday} & Check Out`}
              </button>
            ) : (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleCheckOut()}
                className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {submitting ? 'Checking Out...' : 'Complete Check-Out'}
              </button>
            )}
          </div>
        </div>
      </Modal>

      {/* Cancel Dialog */}
      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={handleCancel}
        title={`Cancel Reservation ${reservation.bookingReference}`}
        description="Cancelling releases room availability for these dates and preserves the booking in history."
        confirmLabel="Confirm Cancellation"
        variant="danger"
        isSubmitting={submitting}
      >
        <div>
          <label
            htmlFor="detail-cancel-reason"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Cancellation Reason *
          </label>
          <input
            id="detail-cancel-reason"
            type="text"
            required
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Reason for cancellation..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      </ConfirmDialog>

      {invoice && (
        <RecordPaymentModal
          open={paymentModalOpen}
          onClose={() => setPaymentModalOpen(false)}
          invoice={invoice}
          propertyId={selectedProperty.id}
          defaultDate={propToday}
          onSuccess={(updated) => setInvoice(updated)}
        />
      )}
    </div>
  );
}
