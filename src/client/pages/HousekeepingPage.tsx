import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  ClipboardList,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
  Wrench,
} from 'lucide-react';
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
  getRoomStatusBucket,
  summarizeRoomStatusBuckets,
  type CleaningWorkflowAction,
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
import {
  HousekeepingTaskModal,
  MaintenanceCreateModal,
  MaintenanceUpdateModal,
  RestoreRoomModal,
} from '../components/housekeeping/HousekeepingModals';
import { ReservationFormModal } from '../components/reservations/ReservationFormModal';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import {
  HousekeepingBadge,
  MaintenanceStatusBadge,
  OperationalBadge,
  PriorityBadge,
  TaskStatusBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch } from '../lib/api';

type ActiveTab = 'board' | 'tasks' | 'maintenance';

export function HousekeepingPage() {
  const { user, selectedProperty } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = user?.role === 'admin';

  const initialTab = ((): ActiveTab => {
    const t = searchParams.get('tab');
    return t === 'tasks' || t === 'maintenance' ? t : 'board';
  })();

  const [activeTab, setActiveTab] = useState<ActiveTab>(initialTab);

  useEffect(() => {
    const t = searchParams.get('tab');
    if (t === 'tasks' || t === 'maintenance' || t === 'board') {
      setActiveTab(t);
    }
  }, [searchParams]);

  const switchTab = (next: ActiveTab) => {
    setActiveTab(next);
    const nextParams = new URLSearchParams(searchParams);
    if (next === 'board') {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', next);
    }
    setSearchParams(nextParams, { replace: true });
  };

  const [rooms, setRooms] = useState<Room[]>([]);
  const [tasks, setTasks] = useState<HousekeepingTask[]>([]);
  const [maintenance, setMaintenance] = useState<MaintenanceRequest[]>([]);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Room Board Filters
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get('status') ?? '');
  const [cleaningStageFilter, setCleaningStageFilter] = useState<string>('');
  const [occupancyFilter, setOccupancyFilter] = useState<'all' | 'occupied' | 'vacant'>('all');
  const [boardSearch, setBoardSearch] = useState('');
  const [updatingRoomId, setUpdatingRoomId] = useState<string | null>(null);

  // Tasks Filters
  const [taskSearch, setTaskSearch] = useState('');
  const [taskStatusFilter, setTaskStatusFilter] = useState<string>('');
  const [taskPriorityFilter, setTaskPriorityFilter] = useState<string>('');
  const [taskTypeFilter, setTaskTypeFilter] = useState<string>('');
  const [taskAssigneeFilter, setTaskAssigneeFilter] = useState<string>('');
  const [taskDueFilter, setTaskDueFilter] = useState<string>('');
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  // Task Create/Edit Modal
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<HousekeepingTask | null>(null);
  const [tfRoomId, setTfRoomId] = useState('');
  const [tfType, setTfType] = useState<HousekeepingTaskType>('turnover_clean');
  const [tfPriority, setTfPriority] = useState<TaskPriority>('normal');
  const [tfStatus, setTfStatus] = useState<HousekeepingTaskStatus>('pending');
  const [tfDueDate, setTfDueDate] = useState('');
  const [tfAssignedTo, setTfAssignedTo] = useState('');
  const [tfNotes, setTfNotes] = useState('');
  const [tfError, setTfError] = useState<string | null>(null);
  const [tfSubmitting, setTfSubmitting] = useState(false);

  // Maintenance Filters
  const [maintSearch, setMaintSearch] = useState('');
  const [maintStatusFilter, setMaintStatusFilter] = useState<string>('');
  const [maintPriorityFilter, setMaintPriorityFilter] = useState<string>('');
  const [maintCategoryFilter, setMaintCategoryFilter] = useState<string>('');
  const [maintRoomFilter, setMaintRoomFilter] = useState<string>('');

  // Maintenance Create / Out-of-Service Modal
  const [maintModalOpen, setMaintModalOpen] = useState(false);
  const [mfRoomId, setMfRoomId] = useState('');
  const [mfCategory, setMfCategory] = useState<MaintenanceCategory>('general');
  const [mfTitle, setMfTitle] = useState('');
  const [mfDescription, setMfDescription] = useState('');
  const [mfPriority, setMfPriority] = useState<TaskPriority>('normal');
  const [mfAssignedTo, setMfAssignedTo] = useState('');
  const [mfImpact, setMfImpact] = useState<MaintenanceImpact>('none');
  const [mfUnavailableFrom, setMfUnavailableFrom] = useState('');
  const [mfUnavailableTo, setMfUnavailableTo] = useState('');
  const [mfAffectedStays, setMfAffectedStays] = useState<ReservationListItem[]>([]);
  const [mfAcknowledgeAffected, setMfAcknowledgeAffected] = useState(false);
  const [mfError, setMfError] = useState<string | null>(null);
  const [mfSubmitting, setMfSubmitting] = useState(false);

  // Maintenance Update / Resolve Modal
  const [editingMaint, setEditingMaint] = useState<MaintenanceRequest | null>(null);
  const [muStatus, setMuStatus] = useState<MaintenanceStatus>('open');
  const [muPriority, setMuPriority] = useState<TaskPriority>('normal');
  const [muAssignedTo, setMuAssignedTo] = useState('');
  const [muResolutionNotes, setMuResolutionNotes] = useState('');
  const [muError, setMuError] = useState<string | null>(null);
  const [muSubmitting, setMuSubmitting] = useState(false);

  // Restore Room to Service Modal (Admin)
  const [restoreRoomTarget, setRestoreRoomTarget] = useState<Room | null>(null);
  const [restoreHkStatus, setRestoreHkStatus] = useState<'dirty' | 'clean'>('dirty');
  const [restoreNotes, setRestoreNotes] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);

  // Reassign Affected Reservation Modal
  const [reassigningStay, setReassigningStay] = useState<ReservationListItem | null>(null);

  const loadAll = useCallback(async () => {
    if (!selectedProperty) return;
    setLoading(true);
    setError(null);
    try {
      const [roomsRes, tasksRes, maintRes, staffRes] = await Promise.all([
        apiFetch<{ items: Room[] }>('/api/rooms', { propertyId: selectedProperty.id }),
        apiFetch<{ items: HousekeepingTask[] }>('/api/housekeeping/tasks', {
          propertyId: selectedProperty.id,
        }),
        apiFetch<{ items: MaintenanceRequest[] }>('/api/maintenance', {
          propertyId: selectedProperty.id,
        }),
        apiFetch<{ items: StaffOption[] }>('/api/properties/staff', {
          propertyId: selectedProperty.id,
        }),
      ]);
      setRooms(roomsRes.items);
      setTasks(tasksRes.items);
      setMaintenance(maintRes.items);
      setStaffOptions(staffRes.items);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load housekeeping data');
    } finally {
      setLoading(false);
    }
  }, [selectedProperty?.id]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const refreshAffectedStays = useCallback(async () => {
    if (!selectedProperty || !maintModalOpen || mfImpact === 'none' || !mfRoomId) {
      setMfAffectedStays([]);
      return;
    }
    try {
      const params = new URLSearchParams();
      if (mfUnavailableFrom) params.set('from', mfUnavailableFrom);
      if (mfUnavailableTo) params.set('to', mfUnavailableTo);
      const res = await apiFetch<{ items: ReservationListItem[] }>(
        `/api/rooms/${mfRoomId}/affected-reservations?${params.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setMfAffectedStays(res.items);
    } catch {
      setMfAffectedStays([]);
    }
  }, [selectedProperty?.id, maintModalOpen, mfImpact, mfRoomId, mfUnavailableFrom, mfUnavailableTo]);

  useEffect(() => {
    void refreshAffectedStays();
  }, [refreshAffectedStays]);

  const handleWorkflowTransition = async (room: Room, action: CleaningWorkflowAction) => {
    if (!selectedProperty) return;
    setUpdatingRoomId(room.id);
    try {
      await apiFetch<{ room: Room }>(`/api/rooms/${room.id}/housekeeping-workflow`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: { action },
      });
      const actionMsg: Record<CleaningWorkflowAction, string> = {
        start_cleaning: `Room ${room.roomNumber} moved to Cleaning in Progress.`,
        complete_cleaning: `Room ${room.roomNumber} cleaning completed (Clean).`,
        inspect_room: `Room ${room.roomNumber} supervisor-inspected and Ready!`,
        mark_dirty: `Room ${room.roomNumber} marked Dirty for cleaning.`,
      };
      showToast('success', actionMsg[action]);
      await loadAll();
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Workflow transition failed');
    } finally {
      setUpdatingRoomId(null);
    }
  };

  const openCreateTask = (presetRoom?: Room) => {
    if (!selectedProperty) return;
    setEditingTask(null);
    setTfRoomId(presetRoom?.id ?? rooms[0]?.id ?? '');
    setTfType(presetRoom?.housekeepingStatus === 'clean' ? 'inspection' : 'turnover_clean');
    setTfPriority('normal');
    setTfStatus('pending');
    setTfDueDate(selectedProperty.localToday);
    setTfAssignedTo('');
    setTfNotes('');
    setTfError(null);
    setTaskModalOpen(true);
  };

  const openEditTask = (task: HousekeepingTask) => {
    setEditingTask(task);
    setTfRoomId(task.roomId);
    setTfType(task.taskType);
    setTfPriority(task.priority);
    setTfStatus(task.status === 'cancelled' ? 'pending' : (task.status as HousekeepingTaskStatus));
    setTfDueDate(task.dueDate);
    setTfAssignedTo(task.assignedTo ?? '');
    setTfNotes(task.notes);
    setTfError(null);
    setTaskModalOpen(true);
  };

  const handleSaveTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProperty) return;
    setTfError(null);
    setTfSubmitting(true);
    try {
      if (editingTask) {
        await apiFetch(`/api/housekeeping/tasks/${editingTask.id}`, {
          method: 'PUT',
          propertyId: selectedProperty.id,
          body: {
            taskType: tfType,
            priority: tfPriority,
            status: tfStatus,
            dueDate: tfDueDate,
            assignedTo: tfAssignedTo || null,
            notes: tfNotes.trim(),
          },
        });
        showToast('success', `Updated task for Room ${editingTask.roomNumber}.`);
      } else {
        await apiFetch('/api/housekeeping/tasks', {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: {
            roomId: tfRoomId,
            taskType: tfType,
            priority: tfPriority,
            dueDate: tfDueDate,
            assignedTo: tfAssignedTo || null,
            notes: tfNotes.trim(),
          },
        });
        showToast('success', 'Housekeeping task created.');
      }
      await loadAll();
      setTaskModalOpen(false);
    } catch (err) {
      setTfError(err instanceof ApiClientError ? err.message : 'Unable to save task');
    } finally {
      setTfSubmitting(false);
    }
  };

  const handleStartTask = async (task: HousekeepingTask) => {
    if (!selectedProperty) return;
    setBusyTaskId(task.id);
    try {
      await apiFetch(`/api/housekeeping/tasks/${task.id}/start`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: {},
      });
      showToast(
        'success',
        `Started task on Room ${task.roomNumber} (room marked Cleaning in Progress).`
      );
      await loadAll();
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Cannot start task');
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleCompleteTask = async (task: HousekeepingTask) => {
    if (!selectedProperty) return;
    setBusyTaskId(task.id);
    try {
      await apiFetch(`/api/housekeeping/tasks/${task.id}/complete`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: {},
      });
      showToast(
        'success',
        task.taskType === 'inspection'
          ? `Inspection completed — Room ${task.roomNumber} marked Inspected!`
          : `Cleaning task completed — Room ${task.roomNumber} marked Clean!`
      );
      await loadAll();
    } catch (err) {
      showToast('error', err instanceof ApiClientError ? err.message : 'Cannot complete task');
    } finally {
      setBusyTaskId(null);
    }
  };

  const openCreateMaintenance = (
    presetRoom?: Room,
    defaultImpact: MaintenanceImpact = 'none'
  ) => {
    if (!selectedProperty) return;
    setMfRoomId(presetRoom?.id ?? rooms[0]?.id ?? '');
    setMfCategory('general');
    setMfTitle('');
    setMfDescription('');
    setMfPriority(defaultImpact !== 'none' ? 'high' : 'normal');
    setMfAssignedTo('');
    setMfImpact(isAdmin ? defaultImpact : 'none');
    setMfUnavailableFrom(selectedProperty.localToday);
    setMfUnavailableTo('');
    setMfAffectedStays([]);
    setMfAcknowledgeAffected(false);
    setMfError(null);
    setMaintModalOpen(true);
  };

  const handleCreateMaintenance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProperty) return;
    setMfError(null);
    setMfSubmitting(true);
    try {
      await apiFetch('/api/maintenance', {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: {
          roomId: mfRoomId,
          category: mfCategory,
          title: mfTitle.trim(),
          description: mfDescription.trim() || mfTitle.trim(),
          priority: mfPriority,
          assignedTo: mfAssignedTo || null,
          operationalImpact: mfImpact,
          unavailableFrom: mfImpact !== 'none' ? mfUnavailableFrom : null,
          unavailableTo: mfImpact !== 'none' && mfUnavailableTo ? mfUnavailableTo : null,
          acknowledgeAffectedStays: mfAcknowledgeAffected,
        },
      });
      showToast(
        'success',
        mfImpact !== 'none'
          ? `Maintenance recorded and room placed in ${mfImpact.replace(/_/g, ' ')}.`
          : 'Maintenance request recorded.'
      );
      await loadAll();
      setMaintModalOpen(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setMfError(err.message);
        const details = err.details as { affectedReservations?: ReservationListItem[] } | undefined;
        if (details?.affectedReservations) {
          setMfAffectedStays(details.affectedReservations);
        }
      } else {
        setMfError('Unable to save maintenance request');
      }
    } finally {
      setMfSubmitting(false);
    }
  };

  const openUpdateMaintenance = (req: MaintenanceRequest) => {
    setEditingMaint(req);
    setMuStatus(req.status);
    setMuPriority(req.priority);
    setMuAssignedTo(req.assignedTo ?? '');
    setMuResolutionNotes(req.resolutionNotes ?? '');
    setMuError(null);
  };

  const handleSaveMaintenanceUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProperty || !editingMaint) return;
    setMuError(null);
    setMuSubmitting(true);
    try {
      await apiFetch(`/api/maintenance/${editingMaint.id}`, {
        method: 'PUT',
        propertyId: selectedProperty.id,
        body: {
          status: muStatus,
          priority: muPriority,
          assignedTo: muAssignedTo || null,
          resolutionNotes: muResolutionNotes.trim(),
        },
      });
      showToast('success', `Maintenance ticket for Room ${editingMaint.roomNumber} updated.`);
      await loadAll();
      setEditingMaint(null);
    } catch (err) {
      setMuError(err instanceof ApiClientError ? err.message : 'Unable to update maintenance');
    } finally {
      setMuSubmitting(false);
    }
  };

  const openRestoreModal = (room: Room) => {
    setRestoreRoomTarget(room);
    setRestoreHkStatus(room.housekeepingStatus === 'clean' ? 'clean' : 'dirty');
    setRestoreNotes('');
    setRestoreError(null);
  };

  const handleRestoreRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProperty || !restoreRoomTarget) return;
    setRestoreError(null);
    setRestoreSubmitting(true);
    try {
      await apiFetch(`/api/rooms/${restoreRoomTarget.id}/restore-service`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: {
          housekeepingStatus: restoreHkStatus,
          resolutionNotes: restoreNotes.trim(),
        },
      });
      showToast('success', `Room ${restoreRoomTarget.roomNumber} restored to operational service.`);
      await loadAll();
      setRestoreRoomTarget(null);
    } catch (err) {
      setRestoreError(err instanceof ApiClientError ? err.message : 'Unable to restore room');
    } finally {
      setRestoreSubmitting(false);
    }
  };

  if (!selectedProperty) return null;

  const counts = summarizeRoomStatusBuckets(rooms);
  const cleaningInProgressCount = rooms.filter(
    (r) => r.operationalStatus === 'available' && r.cleaningInProgress
  ).length;
  const openTasksCount = tasks.filter(
    (t) => t.status === 'pending' || t.status === 'in_progress'
  ).length;
  const openMaintenanceCount = maintenance.filter(
    (m) => m.status === 'open' || m.status === 'in_progress'
  ).length;

  const filteredRooms = rooms.filter((r) => {
    if (statusFilter && getRoomStatusBucket(r) !== statusFilter) return false;
    if (cleaningStageFilter) {
      if (cleaningStageFilter === 'cleaning_in_progress' && !r.cleaningInProgress) return false;
      if (
        cleaningStageFilter === 'dirty_waiting' &&
        (r.housekeepingStatus !== 'dirty' || r.cleaningInProgress)
      ) {
        return false;
      }
    }
    if (occupancyFilter === 'occupied' && !r.isOccupied) return false;
    if (occupancyFilter === 'vacant' && r.isOccupied) return false;
    if (boardSearch.trim()) {
      const q = boardSearch.trim().toLowerCase();
      return (
        r.roomNumber.toLowerCase().includes(q) ||
        r.roomTypeName.toLowerCase().includes(q) ||
        (r.currentOccupancy?.guestName.toLowerCase().includes(q) ?? false) ||
        r.notes.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const filteredTasks = tasks.filter((t) => {
    if (taskStatusFilter === 'active') {
      if (t.status !== 'pending' && t.status !== 'in_progress') return false;
    } else if (taskStatusFilter && t.status !== taskStatusFilter) {
      return false;
    }
    if (taskPriorityFilter && t.priority !== taskPriorityFilter) return false;
    if (taskTypeFilter && t.taskType !== taskTypeFilter) return false;
    if (taskAssigneeFilter === 'unassigned') {
      if (t.assignedTo !== null) return false;
    } else if (taskAssigneeFilter && t.assignedTo !== taskAssigneeFilter) {
      return false;
    }
    if (taskDueFilter && t.dueDate !== taskDueFilter) return false;
    if (taskSearch.trim()) {
      const q = taskSearch.trim().toLowerCase();
      return (
        t.roomNumber.toLowerCase().includes(q) ||
        t.roomTypeName.toLowerCase().includes(q) ||
        t.notes.toLowerCase().includes(q) ||
        (t.assignedToName?.toLowerCase().includes(q) ?? false) ||
        (t.bookingReference?.toLowerCase().includes(q) ?? false)
      );
    }
    return true;
  });

  const filteredMaintenance = maintenance.filter((m) => {
    if (maintStatusFilter === 'active') {
      if (m.status !== 'open' && m.status !== 'in_progress') return false;
    } else if (maintStatusFilter && m.status !== maintStatusFilter) {
      return false;
    }
    if (maintPriorityFilter && m.priority !== maintPriorityFilter) return false;
    if (maintCategoryFilter && m.category !== maintCategoryFilter) return false;
    if (maintRoomFilter && m.roomId !== maintRoomFilter) return false;
    if (maintSearch.trim()) {
      const q = maintSearch.trim().toLowerCase();
      return (
        m.roomNumber.toLowerCase().includes(q) ||
        m.title.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.resolutionNotes.toLowerCase().includes(q) ||
        (m.assignedToName?.toLowerCase().includes(q) ?? false)
      );
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-indigo-600" />
            Housekeeping Room Status Board
          </h1>
          <p className="text-sm text-slate-500">
            Manage room cleaning &amp; inspection transitions, housekeeping tasks, and maintenance
            out-of-service blocks independently from reservation statuses.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => openCreateTask()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            New Housekeeping Task
          </button>
          <button
            type="button"
            onClick={() => openCreateMaintenance(undefined, 'none')}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs sm:text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Wrench className="h-4 w-4 text-orange-600" />
            Report Maintenance
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => openCreateMaintenance(undefined, 'out_of_service')}
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs sm:text-sm font-semibold text-rose-800 hover:bg-rose-100"
            >
              <ShieldAlert className="h-4 w-4 text-rose-600" />
              Place Room Out of Service
            </button>
          )}
        </div>
      </div>

      {/* Mutually Exclusive Room Status Bucket Summary Cards (Counted Once per Active Room) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            key: 'inspected',
            label: 'Inspected (Ready)',
            count: counts.inspected,
            sub: 'Verified for check-in',
            color: 'border-emerald-200 bg-emerald-50 text-emerald-900',
          },
          {
            key: 'clean',
            label: 'Clean',
            count: counts.clean,
            sub: 'Awaiting inspection or ready',
            color: 'border-sky-200 bg-sky-50 text-sky-900',
          },
          {
            key: 'dirty',
            label: 'Dirty (Needs Turnover)',
            count: counts.dirty,
            sub:
              cleaningInProgressCount > 0
                ? `${cleaningInProgressCount} cleaning in progress`
                : 'Awaiting cleaning',
            color: 'border-amber-200 bg-amber-50 text-amber-900',
          },
          {
            key: 'out_of_service',
            label: 'Maintenance / Out of Service',
            count: counts.out_of_service,
            sub: 'Excluded from sellable rooms',
            color: 'border-rose-200 bg-rose-50 text-rose-900',
          },
        ].map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={() => {
              if (activeTab !== 'board') switchTab('board');
              setStatusFilter((prev) => (prev === card.key ? '' : card.key));
            }}
            className={`rounded-2xl border p-4 text-left transition-all ${card.color} ${
              activeTab === 'board' && statusFilter === card.key ? 'ring-2 ring-indigo-600' : ''
            }`}
          >
            <p className="text-2xl font-bold">{card.count}</p>
            <p className="text-xs font-semibold mt-0.5">{card.label}</p>
            <p className="text-[11px] opacity-80 mt-0.5">{card.sub}</p>
          </button>
        ))}
      </div>

      {/* Workspace Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-3">
        <button
          type="button"
          onClick={() => switchTab('board')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold transition-colors ${
            activeTab === 'board'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <Sparkles className="h-4 w-4" />
          Cleaning &amp; Inspection Board ({rooms.length})
        </button>
        <button
          type="button"
          onClick={() => switchTab('tasks')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold transition-colors ${
            activeTab === 'tasks'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <ClipboardList className="h-4 w-4" />
          Housekeeping Tasks ({openTasksCount} open)
        </button>
        <button
          type="button"
          onClick={() => switchTab('maintenance')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold transition-colors ${
            activeTab === 'maintenance'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <Wrench className="h-4 w-4" />
          Maintenance &amp; Out of Service ({openMaintenanceCount} active)
        </button>
      </div>

      {error && <ErrorAlert message={error} onRetry={loadAll} />}

      {loading ? (
        <LoadingState label="Loading room operations..." />
      ) : activeTab === 'board' ? (
        /* TAB 1: ROOM CLEANING & INSPECTION BOARD */
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Search housekeeping board"
                value={boardSearch}
                onChange={(e) => setBoardSearch(e.target.value)}
                placeholder="Filter by room #, category, guest, note..."
                className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Filter housekeeping state"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Summary Buckets</option>
                <option value="inspected">Inspected</option>
                <option value="clean">Clean</option>
                <option value="dirty">Dirty (incl. Cleaning in Progress)</option>
                <option value="out_of_service">Maintenance / Out of Service</option>
              </select>

              <select
                aria-label="Filter cleaning workflow stage"
                value={cleaningStageFilter}
                onChange={(e) => setCleaningStageFilter(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All Cleaning Stages</option>
                <option value="dirty_waiting">Dirty — Not Started</option>
                <option value="cleaning_in_progress">Cleaning in Progress</option>
              </select>

              <select
                aria-label="Filter occupancy"
                value={occupancyFilter}
                onChange={(e) =>
                  setOccupancyFilter(e.target.value as 'all' | 'occupied' | 'vacant')
                }
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="all">All Occupancy</option>
                <option value="vacant">Vacant Only</option>
                <option value="occupied">Occupied Only</option>
              </select>
            </div>
          </div>

          {filteredRooms.length === 0 ? (
            <EmptyState
              title="No rooms match selected Housekeeping filter"
              description="Clear filters to view all rooms in this property."
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredRooms.map((room) => {
                const stage = room.cleaningStage;
                const isHkOos = room.housekeepingStatus === 'out_of_service';
                const isOpUnavailable = room.operationalStatus !== 'available';

                const steps: { key: string; label: string }[] = [
                  { key: 'dirty', label: 'Dirty' },
                  { key: 'cleaning_in_progress', label: 'Cleaning' },
                  { key: 'clean', label: 'Clean' },
                  { key: 'inspected', label: 'Inspected' },
                ];
                const stepOrder = ['dirty', 'cleaning_in_progress', 'clean', 'inspected'];
                const activeIdx = stepOrder.indexOf(stage);

                return (
                  <div
                    key={room.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between gap-4"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className="text-base font-bold text-slate-900">
                            Room {room.roomNumber}
                          </span>
                          <span className="block text-xs text-slate-500">
                            Floor {room.floor} • {room.roomTypeName}
                          </span>
                        </div>
                        <HousekeepingBadge
                          status={room.housekeepingStatus}
                          cleaningInProgress={room.cleaningInProgress}
                        />
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                        <OperationalBadge
                          status={room.operationalStatus}
                          isActive={room.isActive}
                        />
                        {room.currentOccupancy ? (
                          <Link
                            to={`/reservations/${room.currentOccupancy.reservationId}`}
                            className="rounded-md bg-indigo-50 border border-indigo-200 px-2 py-0.5 font-medium text-indigo-800 hover:underline truncate max-w-[180px]"
                          >
                            In-House: {room.currentOccupancy.guestName}
                          </Link>
                        ) : (
                          <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                            Vacant
                          </span>
                        )}
                      </div>

                      {(room.openTasksCount > 0 || room.openMaintenanceCount > 0) && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
                          {room.openTasksCount > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setTaskSearch(room.roomNumber);
                                switchTab('tasks');
                              }}
                              className="rounded bg-indigo-50 border border-indigo-200 px-2 py-0.5 font-semibold text-indigo-700 hover:bg-indigo-100"
                            >
                              {room.openTasksCount} open task{room.openTasksCount === 1 ? '' : 's'}
                            </button>
                          )}
                          {room.openMaintenanceCount > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setMaintRoomFilter(room.id);
                                switchTab('maintenance');
                              }}
                              className="rounded bg-orange-50 border border-orange-200 px-2 py-0.5 font-semibold text-orange-800 hover:bg-orange-100"
                            >
                              {room.openMaintenanceCount} maint issue
                              {room.openMaintenanceCount === 1 ? '' : 's'}
                            </button>
                          )}
                        </div>
                      )}

                      {room.notes && (
                        <p className="mt-2.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                          {room.notes}
                        </p>
                      )}
                    </div>

                    {/* Validated Cleaning & Inspection Stepper */}
                    <div className="border-t border-slate-100 pt-3 space-y-2.5">
                      {!isHkOos && (
                        <div>
                          <div className="grid grid-cols-4 gap-1 mb-1">
                            {steps.map((s, idx) => (
                              <div key={s.key} className="text-center">
                                <div
                                  className={`h-1.5 rounded-full ${
                                    idx <= activeIdx ? 'bg-indigo-600' : 'bg-slate-200'
                                  }`}
                                />
                                <span
                                  className={`block text-[10px] mt-1 font-medium ${
                                    idx === activeIdx
                                      ? 'text-indigo-700 font-bold'
                                      : 'text-slate-400'
                                  }`}
                                >
                                  {s.label}
                                </span>
                              </div>
                            ))}
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 mt-2">
                            {stage === 'dirty' && (
                              <button
                                type="button"
                                disabled={updatingRoomId === room.id}
                                onClick={() => void handleWorkflowTransition(room, 'start_cleaning')}
                                className="flex-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                              >
                                Start Cleaning
                              </button>
                            )}
                            {stage === 'cleaning_in_progress' && (
                              <button
                                type="button"
                                disabled={updatingRoomId === room.id}
                                onClick={() =>
                                  void handleWorkflowTransition(room, 'complete_cleaning')
                                }
                                className="flex-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
                              >
                                Mark Clean
                              </button>
                            )}
                            {stage === 'clean' && (
                              <>
                                <button
                                  type="button"
                                  disabled={updatingRoomId === room.id}
                                  onClick={() => void handleWorkflowTransition(room, 'inspect_room')}
                                  className="flex-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                                >
                                  Mark Inspected
                                </button>
                                <button
                                  type="button"
                                  disabled={updatingRoomId === room.id}
                                  onClick={() => void handleWorkflowTransition(room, 'mark_dirty')}
                                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                                >
                                  Mark Dirty
                                </button>
                              </>
                            )}
                            {stage === 'inspected' && (
                              <button
                                type="button"
                                disabled={updatingRoomId === room.id}
                                onClick={() => void handleWorkflowTransition(room, 'mark_dirty')}
                                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                              >
                                Mark Dirty for Turnover
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-1.5 pt-1 text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openCreateTask(room)}
                            className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            + Task
                          </button>
                          <button
                            type="button"
                            onClick={() => openCreateMaintenance(room, 'none')}
                            className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            + Maint
                          </button>
                        </div>

                        {isAdmin && (isOpUnavailable || isHkOos) && (
                          <button
                            type="button"
                            onClick={() => openRestoreModal(room)}
                            className="inline-flex items-center gap-1 rounded-md bg-teal-600 px-2.5 py-1 font-semibold text-white hover:bg-teal-700"
                          >
                            <RotateCcw className="h-3 w-3" />
                            Restore Service
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : activeTab === 'tasks' ? (
        /* TAB 2: HOUSEKEEPING TASKS */
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <div className="lg:col-span-2 relative">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Search housekeeping tasks"
                value={taskSearch}
                onChange={(e) => setTaskSearch(e.target.value)}
                placeholder="Search room #, assignee, notes, booking ref..."
                className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm"
              />
            </div>

            <select
              aria-label="Filter task status"
              value={taskStatusFilter}
              onChange={(e) => setTaskStatusFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Task Statuses</option>
              <option value="active">Active (Pending + In Progress)</option>
              {HOUSEKEEPING_TASK_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {HOUSEKEEPING_TASK_STATUS_LABELS[st]}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter task priority"
              value={taskPriorityFilter}
              onChange={(e) => setTaskPriorityFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Priorities</option>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter task type"
              value={taskTypeFilter}
              onChange={(e) => setTaskTypeFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Task Types</option>
              {HOUSEKEEPING_TASK_TYPES.map((tt) => (
                <option key={tt} value={tt}>
                  {HOUSEKEEPING_TASK_TYPE_LABELS[tt]}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter task assignee"
              value={taskAssigneeFilter}
              onChange={(e) => setTaskAssigneeFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Assignees</option>
              <option value="unassigned">Unassigned</option>
              {staffOptions.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.fullName} ({st.role})
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <div className="flex items-center gap-2">
              <label htmlFor="task-due-date-filter" className="font-medium">
                Due Date:
              </label>
              <input
                id="task-due-date-filter"
                type="date"
                value={taskDueFilter}
                onChange={(e) => setTaskDueFilter(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1"
              />
              {taskDueFilter && (
                <button
                  type="button"
                  onClick={() => setTaskDueFilter('')}
                  className="text-indigo-600 font-semibold hover:underline"
                >
                  Clear Date
                </button>
              )}
            </div>
            <span>Showing {filteredTasks.length} housekeeping task(s)</span>
          </div>

          {filteredTasks.length === 0 ? (
            <EmptyState
              title="No housekeeping tasks match current filter"
              description="Create a task or adjust filters to view scheduled room turnovers and inspections."
            />
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3">Room</th>
                      <th className="px-4 py-3">Task &amp; Notes</th>
                      <th className="px-4 py-3">Priority</th>
                      <th className="px-4 py-3">Due Date</th>
                      <th className="px-4 py-3">Assigned Staff</th>
                      <th className="px-4 py-3">Status &amp; Audit</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredTasks.map((task) => (
                      <tr key={task.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-3 align-top">
                          <span className="font-bold text-slate-900 block">
                            Room {task.roomNumber}
                          </span>
                          <span className="text-xs text-slate-500 block">{task.roomTypeName}</span>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <HousekeepingBadge
                              status={task.roomHousekeepingStatus}
                              cleaningInProgress={task.roomCleaningInProgress}
                            />
                            {task.isRoomOccupied && (
                              <span className="rounded bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                                Occupied
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top max-w-xs">
                          <p className="font-semibold text-slate-900">
                            {HOUSEKEEPING_TASK_TYPE_LABELS[task.taskType] ?? task.taskType}
                          </p>
                          {task.notes && (
                            <p className="text-xs text-slate-600 mt-0.5">{task.notes}</p>
                          )}
                          {task.reservationId && task.bookingReference && (
                            <Link
                              to={`/reservations/${task.reservationId}`}
                              className="inline-block mt-1 font-mono text-xs text-indigo-600 hover:underline"
                            >
                              {task.bookingReference}
                            </Link>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top">
                          <PriorityBadge priority={task.priority} />
                        </td>
                        <td className="px-4 py-3 align-top text-xs font-medium text-slate-700">
                          {formatDisplayDate(task.dueDate)}
                        </td>
                        <td className="px-4 py-3 align-top text-xs">
                          {task.assignedToName ? (
                            <div>
                              <span className="font-semibold text-slate-900 block">
                                {task.assignedToName}
                              </span>
                              <span className="text-slate-500 capitalize">
                                {task.assignedToRole}
                              </span>
                            </div>
                          ) : (
                            <span className="text-slate-400 italic">Unassigned</span>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top text-xs space-y-1">
                          <TaskStatusBadge status={task.status} />
                          {task.createdByName && (
                            <p className="text-[11px] text-slate-500">
                              Created by {task.createdByName}
                            </p>
                          )}
                          {task.startedAt && (
                            <p className="text-[11px] text-violet-700">
                              Started{' '}
                              {new Date(task.startedAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                              {task.startedByName ? ` (${task.startedByName})` : ''}
                            </p>
                          )}
                          {task.completedAt && (
                            <p className="text-[11px] text-emerald-700">
                              Completed{' '}
                              {new Date(task.completedAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                              {task.completedByName ? ` (${task.completedByName})` : ''}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            {task.status === 'pending' && (
                              <button
                                type="button"
                                disabled={busyTaskId === task.id}
                                onClick={() => void handleStartTask(task)}
                                className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                              >
                                <Play className="h-3 w-3" />
                                Start
                              </button>
                            )}
                            {(task.status === 'pending' || task.status === 'in_progress') && (
                              <button
                                type="button"
                                disabled={busyTaskId === task.id}
                                onClick={() => void handleCompleteTask(task)}
                                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                Complete
                              </button>
                            )}
                            <button
                              type="button"
                              title="Edit or assign task"
                              onClick={() => openEditTask(task)}
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                              <Pencil className="h-3.5 w-3.5 inline mr-1" />
                              Edit
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* TAB 3: MAINTENANCE & OUT OF SERVICE */
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="relative">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Search maintenance requests"
                value={maintSearch}
                onChange={(e) => setMaintSearch(e.target.value)}
                placeholder="Search room #, issue, notes..."
                className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm"
              />
            </div>

            <select
              aria-label="Filter maintenance status"
              value={maintStatusFilter}
              onChange={(e) => setMaintStatusFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Statuses (Incl. History)</option>
              <option value="active">Active (Open + In Progress)</option>
              {MAINTENANCE_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {MAINTENANCE_STATUS_LABELS[st]}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter maintenance priority"
              value={maintPriorityFilter}
              onChange={(e) => setMaintPriorityFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Priorities</option>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter maintenance category"
              value={maintCategoryFilter}
              onChange={(e) => setMaintCategoryFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Categories</option>
              {MAINTENANCE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {MAINTENANCE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter maintenance room"
              value={maintRoomFilter}
              onChange={(e) => setMaintRoomFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">All Rooms</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  Room {r.roomNumber} ({r.roomTypeName})
                </option>
              ))}
            </select>
          </div>

          {filteredMaintenance.length === 0 ? (
            <EmptyState
              title="No maintenance records match current filter"
              description="Reported room maintenance requests, out-of-service blocks, and resolved history appear here."
            />
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3">Room &amp; Operational State</th>
                      <th className="px-4 py-3">Issue &amp; Unavailable Window</th>
                      <th className="px-4 py-3">Priority</th>
                      <th className="px-4 py-3">Reported &amp; Assignee</th>
                      <th className="px-4 py-3">Status &amp; Resolution</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredMaintenance.map((req) => {
                      const roomObj = rooms.find((r) => r.id === req.roomId);
                      return (
                        <tr key={req.id} className="hover:bg-slate-50/70">
                          <td className="px-4 py-3 align-top">
                            <span className="font-bold text-slate-900 block">
                              Room {req.roomNumber}
                            </span>
                            <div className="mt-1 flex flex-wrap gap-1">
                              <OperationalBadge status={req.roomOperationalStatus} />
                              <HousekeepingBadge status={req.roomHousekeepingStatus} />
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top max-w-sm">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-slate-900">{req.title}</span>
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                                {MAINTENANCE_CATEGORY_LABELS[req.category] ?? req.category}
                              </span>
                            </div>
                            <p className="text-xs text-slate-600 mt-0.5">{req.description}</p>
                            {req.blocksInventory && req.unavailableFrom && (
                              <p className="mt-1 inline-block rounded bg-rose-50 border border-rose-200 px-2 py-0.5 text-[11px] font-semibold text-rose-800">
                                Blocks Inventory: {formatDisplayDate(req.unavailableFrom)} →{' '}
                                {req.unavailableTo
                                  ? formatDisplayDate(req.unavailableTo)
                                  : 'Until Restored'}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-3 align-top">
                            <PriorityBadge priority={req.priority} />
                          </td>
                          <td className="px-4 py-3 align-top text-xs space-y-0.5">
                            <p className="text-slate-700 font-medium">
                              {new Date(req.reportedAt).toLocaleString()}
                            </p>
                            {req.reportedByName && (
                              <p className="text-slate-500">By {req.reportedByName}</p>
                            )}
                            <p className="text-slate-600 pt-1">
                              Assigned: <strong>{req.assignedToName ?? 'Unassigned'}</strong>
                            </p>
                          </td>
                          <td className="px-4 py-3 align-top text-xs space-y-1 max-w-xs">
                            <MaintenanceStatusBadge status={req.status} />
                            {req.resolutionNotes && (
                              <p className="text-slate-600 mt-1">
                                <strong>Resolution:</strong> {req.resolutionNotes}
                              </p>
                            )}
                            {req.resolvedAt && (
                              <p className="text-[11px] text-emerald-700">
                                Resolved {new Date(req.resolvedAt).toLocaleString()}
                                {req.resolvedByName ? ` by ${req.resolvedByName}` : ''}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              {req.status !== 'resolved' &&
                                req.status !== 'cancelled' &&
                                (isAdmin ||
                                  (!req.blocksInventory && req.operationalImpact === 'none')) && (
                                  <button
                                    type="button"
                                    onClick={() => openUpdateMaintenance(req)}
                                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                                  >
                                    Update / Resolve
                                  </button>
                                )}
                              {!isAdmin &&
                                req.status !== 'resolved' &&
                                req.status !== 'cancelled' &&
                                (req.blocksInventory || req.operationalImpact !== 'none') && (
                                  <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500">
                                    Admin Managed
                                  </span>
                                )}
                              {isAdmin &&
                                roomObj &&
                                (roomObj.operationalStatus !== 'available' ||
                                  roomObj.housekeepingStatus === 'out_of_service') && (
                                  <button
                                    type="button"
                                    onClick={() => openRestoreModal(roomObj)}
                                    className="inline-flex items-center gap-1 rounded-lg bg-teal-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
                                  >
                                    <RotateCcw className="h-3 w-3" />
                                    Restore Room
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
            </div>
          )}
        </div>
      )}

      <HousekeepingTaskModal
        open={taskModalOpen}
        onClose={() => setTaskModalOpen(false)}
        editingTask={editingTask}
        rooms={rooms}
        staffOptions={staffOptions}
        tfRoomId={tfRoomId}
        setTfRoomId={setTfRoomId}
        tfType={tfType}
        setTfType={setTfType}
        tfPriority={tfPriority}
        setTfPriority={setTfPriority}
        tfStatus={tfStatus}
        setTfStatus={setTfStatus}
        tfDueDate={tfDueDate}
        setTfDueDate={setTfDueDate}
        tfAssignedTo={tfAssignedTo}
        setTfAssignedTo={setTfAssignedTo}
        tfNotes={tfNotes}
        setTfNotes={setTfNotes}
        tfError={tfError}
        tfSubmitting={tfSubmitting}
        onSubmit={handleSaveTask}
      />

      <MaintenanceCreateModal
        open={maintModalOpen}
        onClose={() => setMaintModalOpen(false)}
        isAdmin={isAdmin}
        rooms={rooms}
        staffOptions={staffOptions}
        mfRoomId={mfRoomId}
        setMfRoomId={setMfRoomId}
        mfCategory={mfCategory}
        setMfCategory={setMfCategory}
        mfTitle={mfTitle}
        setMfTitle={setMfTitle}
        mfDescription={mfDescription}
        setMfDescription={setMfDescription}
        mfPriority={mfPriority}
        setMfPriority={setMfPriority}
        mfAssignedTo={mfAssignedTo}
        setMfAssignedTo={setMfAssignedTo}
        mfImpact={mfImpact}
        setMfImpact={setMfImpact}
        mfUnavailableFrom={mfUnavailableFrom}
        setMfUnavailableFrom={setMfUnavailableFrom}
        mfUnavailableTo={mfUnavailableTo}
        setMfUnavailableTo={setMfUnavailableTo}
        mfAffectedStays={mfAffectedStays}
        mfAcknowledgeAffected={mfAcknowledgeAffected}
        setMfAcknowledgeAffected={setMfAcknowledgeAffected}
        mfError={mfError}
        mfSubmitting={mfSubmitting}
        onReassignStay={setReassigningStay}
        onSubmit={handleCreateMaintenance}
      />

      <MaintenanceUpdateModal
        editingMaint={editingMaint}
        onClose={() => setEditingMaint(null)}
        staffOptions={staffOptions}
        muStatus={muStatus}
        setMuStatus={setMuStatus}
        muPriority={muPriority}
        setMuPriority={setMuPriority}
        muAssignedTo={muAssignedTo}
        setMuAssignedTo={setMuAssignedTo}
        muResolutionNotes={muResolutionNotes}
        setMuResolutionNotes={setMuResolutionNotes}
        muError={muError}
        muSubmitting={muSubmitting}
        onSubmit={handleSaveMaintenanceUpdate}
      />

      <RestoreRoomModal
        restoreRoomTarget={restoreRoomTarget}
        onClose={() => setRestoreRoomTarget(null)}
        restoreHkStatus={restoreHkStatus}
        setRestoreHkStatus={setRestoreHkStatus}
        restoreNotes={restoreNotes}
        setRestoreNotes={setRestoreNotes}
        restoreError={restoreError}
        restoreSubmitting={restoreSubmitting}
        onSubmit={handleRestoreRoom}
      />

      <ReservationFormModal
        open={reassigningStay !== null}
        onClose={() => setReassigningStay(null)}
        mode="edit"
        editingReservation={reassigningStay}
        onSaved={() => {
          setReassigningStay(null);
          void refreshAffectedStays();
          void loadAll();
        }}
      />
    </div>
  );
}
