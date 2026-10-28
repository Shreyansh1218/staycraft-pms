import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import {
  HOUSEKEEPING_TASK_STATUSES,
  HOUSEKEEPING_TASK_STATUS_LABELS,
  HOUSEKEEPING_TASK_TYPES,
  HOUSEKEEPING_TASK_TYPE_LABELS,
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_CATEGORY_LABELS,
  MAINTENANCE_STATUSES,
  MAINTENANCE_STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type HousekeepingTaskStatus,
  type HousekeepingTaskType,
  type MaintenanceCategory,
  type MaintenanceImpact,
  type MaintenanceStatus,
  type TaskPriority,
} from '@shared/constants';
import { formatDisplayDate } from '@shared/dates';
import type {
  HousekeepingTask,
  MaintenanceRequest,
  ReservationListItem,
  Room,
  StaffOption,
} from '@shared/types';
import { ErrorAlert } from '../ui/Feedback';
import { Modal } from '../ui/Modal';
import { ReservationStatusBadge } from '../ui/StatusBadge';

export interface TaskModalProps {
  open: boolean;
  onClose: () => void;
  editingTask: HousekeepingTask | null;
  rooms: Room[];
  staffOptions: StaffOption[];
  tfRoomId: string;
  setTfRoomId: (v: string) => void;
  tfType: HousekeepingTaskType;
  setTfType: (v: HousekeepingTaskType) => void;
  tfPriority: TaskPriority;
  setTfPriority: (v: TaskPriority) => void;
  tfStatus: HousekeepingTaskStatus;
  setTfStatus: (v: HousekeepingTaskStatus) => void;
  tfDueDate: string;
  setTfDueDate: (v: string) => void;
  tfAssignedTo: string;
  setTfAssignedTo: (v: string) => void;
  tfNotes: string;
  setTfNotes: (v: string) => void;
  tfError: string | null;
  tfSubmitting: boolean;
  onSubmit: (e: React.FormEvent) => void;
}

export function HousekeepingTaskModal({
  open,
  onClose,
  editingTask,
  rooms,
  staffOptions,
  tfRoomId,
  setTfRoomId,
  tfType,
  setTfType,
  tfPriority,
  setTfPriority,
  tfStatus,
  setTfStatus,
  tfDueDate,
  setTfDueDate,
  tfAssignedTo,
  setTfAssignedTo,
  tfNotes,
  setTfNotes,
  tfError,
  tfSubmitting,
  onSubmit,
}: TaskModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        editingTask
          ? `Edit Housekeeping Task — Room ${editingTask.roomNumber}`
          : 'Create Housekeeping Task'
      }
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {tfError && <ErrorAlert message={tfError} />}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="hk-task-room" className="block text-xs font-medium text-slate-700 mb-1">
              Room *
            </label>
            <select
              id="hk-task-room"
              required
              disabled={Boolean(editingTask)}
              value={tfRoomId}
              onChange={(e) => setTfRoomId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
            >
              <option value="">-- Select room --</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  Room {r.roomNumber} — {r.roomTypeName} ({r.housekeepingStatus})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="hk-task-type" className="block text-xs font-medium text-slate-700 mb-1">
              Task Type *
            </label>
            <select
              id="hk-task-type"
              value={tfType}
              onChange={(e) => setTfType(e.target.value as HousekeepingTaskType)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {HOUSEKEEPING_TASK_TYPES.map((tt) => (
                <option key={tt} value={tt}>
                  {HOUSEKEEPING_TASK_TYPE_LABELS[tt]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label
              htmlFor="hk-task-priority"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Priority *
            </label>
            <select
              id="hk-task-priority"
              value={tfPriority}
              onChange={(e) => setTfPriority(e.target.value as TaskPriority)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="hk-task-due" className="block text-xs font-medium text-slate-700 mb-1">
              Due Date *
            </label>
            <input
              id="hk-task-due"
              type="date"
              required
              value={tfDueDate}
              onChange={(e) => setTfDueDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>

          {editingTask && (
            <div>
              <label
                htmlFor="hk-task-status"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Status
              </label>
              <select
                id="hk-task-status"
                value={tfStatus}
                disabled={editingTask.status === 'completed'}
                onChange={(e) => setTfStatus(e.target.value as HousekeepingTaskStatus)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
              >
                {HOUSEKEEPING_TASK_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {HOUSEKEEPING_TASK_STATUS_LABELS[st]}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div>
          <label
            htmlFor="hk-task-assignee"
            className="block text-xs font-medium text-slate-700 mb-1"
          >
            Assign to Staff Account (Optional)
          </label>
          <select
            id="hk-task-assignee"
            value={tfAssignedTo}
            onChange={(e) => setTfAssignedTo(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">-- Unassigned --</option>
            {staffOptions.map((st) => (
              <option key={st.id} value={st.id}>
                {st.fullName} ({st.role} • {st.email})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="hk-task-notes" className="block text-xs font-medium text-slate-700 mb-1">
            Instructions / Notes
          </label>
          <textarea
            id="hk-task-notes"
            rows={3}
            value={tfNotes}
            onChange={(e) => setTfNotes(e.target.value)}
            placeholder="VIP arrival amenities, extra towels, minibar restock..."
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={tfSubmitting}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {tfSubmitting ? 'Saving...' : editingTask ? 'Save Task' : 'Create Task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface MaintenanceCreateModalProps {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  rooms: Room[];
  staffOptions: StaffOption[];
  mfRoomId: string;
  setMfRoomId: (v: string) => void;
  mfCategory: MaintenanceCategory;
  setMfCategory: (v: MaintenanceCategory) => void;
  mfTitle: string;
  setMfTitle: (v: string) => void;
  mfDescription: string;
  setMfDescription: (v: string) => void;
  mfPriority: TaskPriority;
  setMfPriority: (v: TaskPriority) => void;
  mfAssignedTo: string;
  setMfAssignedTo: (v: string) => void;
  mfImpact: MaintenanceImpact;
  setMfImpact: (v: MaintenanceImpact) => void;
  mfUnavailableFrom: string;
  setMfUnavailableFrom: (v: string) => void;
  mfUnavailableTo: string;
  setMfUnavailableTo: (v: string) => void;
  mfAffectedStays: ReservationListItem[];
  mfAcknowledgeAffected: boolean;
  setMfAcknowledgeAffected: (v: boolean) => void;
  mfError: string | null;
  mfSubmitting: boolean;
  onReassignStay: (stay: ReservationListItem) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function MaintenanceCreateModal({
  open,
  onClose,
  isAdmin,
  rooms,
  staffOptions,
  mfRoomId,
  setMfRoomId,
  mfCategory,
  setMfCategory,
  mfTitle,
  setMfTitle,
  mfDescription,
  setMfDescription,
  mfPriority,
  setMfPriority,
  mfAssignedTo,
  setMfAssignedTo,
  mfImpact,
  setMfImpact,
  mfUnavailableFrom,
  setMfUnavailableFrom,
  mfUnavailableTo,
  setMfUnavailableTo,
  mfAffectedStays,
  mfAcknowledgeAffected,
  setMfAcknowledgeAffected,
  mfError,
  mfSubmitting,
  onReassignStay,
  onSubmit,
}: MaintenanceCreateModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record Maintenance Request / Out-of-Service Block"
      maxWidthClass="max-w-2xl"
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {mfError && <ErrorAlert message={mfError} />}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="maint-room" className="block text-xs font-medium text-slate-700 mb-1">
              Room *
            </label>
            <select
              id="maint-room"
              required
              value={mfRoomId}
              onChange={(e) => {
                setMfRoomId(e.target.value);
                setMfAcknowledgeAffected(false);
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">-- Select room --</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  Room {r.roomNumber} ({r.roomTypeName})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="maint-cat" className="block text-xs font-medium text-slate-700 mb-1">
              Category *
            </label>
            <select
              id="maint-cat"
              value={mfCategory}
              onChange={(e) => setMfCategory(e.target.value as MaintenanceCategory)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {MAINTENANCE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {MAINTENANCE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="maint-priority"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Priority *
            </label>
            <select
              id="maint-priority"
              value={mfPriority}
              onChange={(e) => setMfPriority(e.target.value as TaskPriority)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="maint-title" className="block text-xs font-medium text-slate-700 mb-1">
            Issue Summary *
          </label>
          <input
            id="maint-title"
            type="text"
            required
            value={mfTitle}
            onChange={(e) => setMfTitle(e.target.value)}
            placeholder="e.g., Split AC water leak / Bathroom mixer valve replacement"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="maint-desc" className="block text-xs font-medium text-slate-700 mb-1">
            Detailed Description *
          </label>
          <textarea
            id="maint-desc"
            rows={2}
            required
            value={mfDescription}
            onChange={(e) => setMfDescription(e.target.value)}
            placeholder="Describe observed issue, guest impact, and required repair..."
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="maint-assignee"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Assign Staff (Optional)
            </label>
            <select
              id="maint-assignee"
              value={mfAssignedTo}
              onChange={(e) => setMfAssignedTo(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">-- Unassigned --</option>
              {staffOptions.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.fullName} ({st.role})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="maint-impact"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Room Inventory Availability Impact
            </label>
            <select
              id="maint-impact"
              value={mfImpact}
              disabled={!isAdmin}
              onChange={(e) => {
                setMfImpact(e.target.value as MaintenanceImpact);
                setMfAcknowledgeAffected(false);
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
            >
              <option value="none">Minor Issue — Keep Room Sellable</option>
              <option value="maintenance">Place Room in Maintenance (Blocks Bookings)</option>
              <option value="out_of_service">Place Room Out of Service (Blocks Bookings)</option>
            </select>
            {!isAdmin && (
              <p className="text-[11px] text-slate-500 mt-1">
                Receptionists can report maintenance issues; an Administrator is required to place a
                room Out of Service.
              </p>
            )}
          </div>
        </div>

        {mfImpact !== 'none' && (
          <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3.5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="maint-from" className="block text-xs font-medium text-rose-950 mb-1">
                  Unavailable From (Inclusive) *
                </label>
                <input
                  id="maint-from"
                  type="date"
                  required
                  value={mfUnavailableFrom}
                  onChange={(e) => setMfUnavailableFrom(e.target.value)}
                  className="w-full rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label htmlFor="maint-to" className="block text-xs font-medium text-rose-950 mb-1">
                  Estimated Return Date (Exclusive, Optional)
                </label>
                <input
                  id="maint-to"
                  type="date"
                  value={mfUnavailableTo}
                  onChange={(e) => setMfUnavailableTo(e.target.value)}
                  className="w-full rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm"
                />
              </div>
            </div>

            {mfAffectedStays.length > 0 && (
              <div
                role="region"
                aria-label="Affected stays conflicting with unavailable period"
                className="rounded-xl border border-rose-300 bg-white p-3.5 space-y-2.5 text-xs"
              >
                <div className="flex items-start gap-2 text-rose-900 font-semibold">
                  <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                  <span>
                    {mfAffectedStays.length} Existing Reservation
                    {mfAffectedStays.length === 1 ? '' : 's'} Overlap This Unavailable Period
                  </span>
                </div>
                <p className="text-slate-600">
                  Existing reservations are never silently cancelled or altered. Reassign affected
                  stays to another available room below, or confirm an explicit out-of-service hold
                  for upcoming stays.
                </p>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                  {mfAffectedStays.map((st) => (
                    <div
                      key={st.id}
                      className="p-2.5 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div>
                        <Link
                          to={`/reservations/${st.id}`}
                          className="font-mono font-bold text-indigo-600 hover:underline"
                        >
                          {st.bookingReference}
                        </Link>{' '}
                        <span className="font-semibold text-slate-900">• {st.guestName}</span>
                        <p className="text-slate-500 mt-0.5">
                          {formatDisplayDate(st.arrivalDate)} →{' '}
                          {formatDisplayDate(st.departureDate)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <ReservationStatusBadge status={st.status} />
                        <button
                          type="button"
                          onClick={() => onReassignStay(st)}
                          className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
                        >
                          Reassign Room
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {mfAffectedStays.every((s) => s.status !== 'checked_in') ? (
                  <label className="flex items-start gap-2 pt-1 cursor-pointer text-rose-900 font-medium">
                    <input
                      type="checkbox"
                      checked={mfAcknowledgeAffected}
                      onChange={(e) => setMfAcknowledgeAffected(e.target.checked)}
                      className="mt-0.5 rounded border-rose-400 text-rose-600"
                    />
                    <span>
                      Authorized Hold: Keep existing upcoming reservation(s) intact and place room
                      Out of Service now (check-in will remain blocked until reassigned or room is
                      restored).
                    </span>
                  </label>
                ) : (
                  <p className="text-rose-700 font-semibold">
                    An in-house Checked-In guest occupies this room. Reassign the guest to another
                    clean room before placing this room Out of Service.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mfSubmitting}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {mfSubmitting ? 'Saving...' : 'Save Maintenance Request'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface MaintenanceUpdateModalProps {
  editingMaint: MaintenanceRequest | null;
  onClose: () => void;
  staffOptions: StaffOption[];
  muStatus: MaintenanceStatus;
  setMuStatus: (v: MaintenanceStatus) => void;
  muPriority: TaskPriority;
  setMuPriority: (v: TaskPriority) => void;
  muAssignedTo: string;
  setMuAssignedTo: (v: string) => void;
  muResolutionNotes: string;
  setMuResolutionNotes: (v: string) => void;
  muError: string | null;
  muSubmitting: boolean;
  onSubmit: (e: React.FormEvent) => void;
}

export function MaintenanceUpdateModal({
  editingMaint,
  onClose,
  staffOptions,
  muStatus,
  setMuStatus,
  muPriority,
  setMuPriority,
  muAssignedTo,
  setMuAssignedTo,
  muResolutionNotes,
  setMuResolutionNotes,
  muError,
  muSubmitting,
  onSubmit,
}: MaintenanceUpdateModalProps) {
  return (
    <Modal
      open={editingMaint !== null}
      onClose={onClose}
      title={
        editingMaint
          ? `Update Maintenance — Room ${editingMaint.roomNumber}`
          : 'Update Maintenance'
      }
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {muError && <ErrorAlert message={muError} />}
        {editingMaint && (
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs space-y-1">
            <p className="font-bold text-slate-900">{editingMaint.title}</p>
            <p className="text-slate-600">{editingMaint.description}</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="mu-status" className="block text-xs font-medium text-slate-700 mb-1">
              Status *
            </label>
            <select
              id="mu-status"
              value={muStatus}
              onChange={(e) => setMuStatus(e.target.value as MaintenanceStatus)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {MAINTENANCE_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {MAINTENANCE_STATUS_LABELS[st]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="mu-priority" className="block text-xs font-medium text-slate-700 mb-1">
              Priority *
            </label>
            <select
              id="mu-priority"
              value={muPriority}
              onChange={(e) => setMuPriority(e.target.value as TaskPriority)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="mu-assignee" className="block text-xs font-medium text-slate-700 mb-1">
            Assigned Staff
          </label>
          <select
            id="mu-assignee"
            value={muAssignedTo}
            onChange={(e) => setMuAssignedTo(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">-- Unassigned --</option>
            {staffOptions.map((st) => (
              <option key={st.id} value={st.id}>
                {st.fullName} ({st.role})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="mu-notes" className="block text-xs font-medium text-slate-700 mb-1">
            Resolution / Progress Notes {muStatus === 'resolved' ? '*' : ''}
          </label>
          <textarea
            id="mu-notes"
            rows={3}
            required={muStatus === 'resolved'}
            value={muResolutionNotes}
            onChange={(e) => setMuResolutionNotes(e.target.value)}
            placeholder="Describe repair completed, parts replaced, and verification..."
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={muSubmitting}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {muSubmitting ? 'Saving...' : 'Save Update'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface RestoreRoomModalProps {
  restoreRoomTarget: Room | null;
  onClose: () => void;
  restoreHkStatus: 'dirty' | 'clean';
  setRestoreHkStatus: (v: 'dirty' | 'clean') => void;
  restoreNotes: string;
  setRestoreNotes: (v: string) => void;
  restoreError: string | null;
  restoreSubmitting: boolean;
  onSubmit: (e: React.FormEvent) => void;
}

export function RestoreRoomModal({
  restoreRoomTarget,
  onClose,
  restoreHkStatus,
  setRestoreHkStatus,
  restoreNotes,
  setRestoreNotes,
  restoreError,
  restoreSubmitting,
  onSubmit,
}: RestoreRoomModalProps) {
  return (
    <Modal
      open={restoreRoomTarget !== null}
      onClose={onClose}
      title={
        restoreRoomTarget
          ? `Restore Room ${restoreRoomTarget.roomNumber} to Operational Service`
          : 'Restore Room'
      }
      maxWidthClass="max-w-md"
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {restoreError && <ErrorAlert message={restoreError} />}
        <p className="text-xs text-slate-600">
          Restoring sets physical operational status back to <strong>Operational</strong>, resolves
          active maintenance blocks on this room, and sets the post-maintenance housekeeping state.
        </p>

        <div>
          <label
            htmlFor="restore-hk-status"
            className="block text-xs font-medium text-slate-700 mb-1"
          >
            Post-Maintenance Housekeeping Status *
          </label>
          <select
            id="restore-hk-status"
            value={restoreHkStatus}
            onChange={(e) => setRestoreHkStatus(e.target.value as 'dirty' | 'clean')}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="dirty">Dirty — Requires Post-Maintenance Cleaning</option>
            <option value="clean">Clean — Ready for Supervisor Inspection</option>
          </select>
        </div>

        <div>
          <label htmlFor="restore-notes" className="block text-xs font-medium text-slate-700 mb-1">
            Restoration / Sign-Off Notes *
          </label>
          <textarea
            id="restore-notes"
            rows={3}
            required
            value={restoreNotes}
            onChange={(e) => setRestoreNotes(e.target.value)}
            placeholder="e.g., Compressor replaced and pressure-tested; safe to return to inventory."
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={restoreSubmitting}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {restoreSubmitting ? 'Restoring...' : 'Restore to Service'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
