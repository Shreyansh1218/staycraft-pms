import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Building2,
  Check,
  Copy,
  Eye,
  Info,
  KeyRound,
  Link2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  UserCheck,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  STAFF_DEPARTMENTS,
  STAFF_DEPARTMENT_LABELS,
  STAFF_EMPLOYMENT_STATUSES,
  STAFF_EMPLOYMENT_STATUS_LABELS,
  STAFF_SHIFT_TYPES,
  STAFF_SHIFT_TYPE_LABELS,
  USER_ROLES,
  type StaffDepartment,
  type StaffEmploymentStatus,
  type StaffShiftType,
  type UserRole,
} from '@shared/constants';
import { formatMoney } from '@shared/pricing';
import type {
  AdminPasswordResetInitiateResponse,
  ManagedUserAccount,
  StaffListResponse,
  StaffProfileDetail,
  StaffProfileRecord,
} from '@shared/types';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import {
  RoleBadge,
  ServiceRequestStatusBadge,
  StaffEmploymentStatusBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiFetch } from '../lib/api';

type StaffTab = 'directory' | 'users';

interface PrefillUserForStaff {
  userId: string;
  fullName: string;
  email: string;
  phone: string;
  role: UserRole;
}

export function StaffPage() {
  const { user, properties, selectedProperty } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const isAdmin = user?.role === 'admin';
  const rawTab = searchParams.get('tab') as StaffTab | null;
  const activeTab: StaffTab =
    rawTab && ['directory', 'users'].includes(rawTab) ? rawTab : 'directory';

  const setActiveTab = (tab: StaffTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  // Staff Directory state
  const [staffData, setStaffData] = useState<StaffListResponse | null>(null);
  const [staffLoading, setStaffLoading] = useState(true);
  const [staffError, setStaffError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [departmentFilter, setDepartmentFilter] = useState<string>('');
  const [shiftFilter, setShiftFilter] = useState<string>('');
  const [staffSearch, setStaffSearch] = useState<string>('');

  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<StaffProfileRecord | null>(
    null
  );
  const [prefillUserForStaff, setPrefillUserForStaff] =
    useState<PrefillUserForStaff | null>(null);
  const [staffDetailId, setStaffDetailId] = useState<string | null>(null);
  const [staffDetail, setStaffDetail] = useState<StaffProfileDetail | null>(
    null
  );
  const [staffDetailLoading, setStaffDetailLoading] = useState(false);
  const [deactivateStaffTarget, setDeactivateStaffTarget] =
    useState<StaffProfileRecord | null>(null);
  const [deactivatingStaff, setDeactivatingStaff] = useState(false);

  // Managed Users state (Admin-only, filtered for System Users tab)
  const [managedUsers, setManagedUsers] = useState<ManagedUserAccount[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [userRoleFilter, setUserRoleFilter] = useState<string>('');
  const [userActiveFilter, setUserActiveFilter] = useState<string>('all');
  const [userSearch, setUserSearch] = useState<string>('');

  // Unfiltered property-authorized login accounts (Admin-only) so staff modal & unlinked-login callout
  // are never starved when filters are active on the System Users tab.
  const [propertyUsers, setPropertyUsers] = useState<ManagedUserAccount[]>([]);

  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [editUserTarget, setEditUserTarget] =
    useState<ManagedUserAccount | null>(null);
  const [accessModalTarget, setAccessModalTarget] =
    useState<ManagedUserAccount | null>(null);
  const [resetPasswordTarget, setResetPasswordTarget] =
    useState<ManagedUserAccount | null>(null);

  // Request sequence guards prevent stale responses from overwriting state on rapid property switches
  const staffReqSeqRef = useRef(0);
  const usersReqSeqRef = useRef(0);
  const propUsersReqSeqRef = useRef(0);

  // Reset property-scoped modals and stale directory state when switching properties
  const selectedPropertyId = selectedProperty?.id ?? null;
  useEffect(() => {
    setStaffData(null);
    setStaffModalOpen(false);
    setEditingStaff(null);
    setPrefillUserForStaff(null);
    setStaffDetailId(null);
    setStaffDetail(null);
    setDeactivateStaffTarget(null);
    setPropertyUsers([]);
  }, [selectedPropertyId]);

  const loadStaff = useCallback(async () => {
    if (!selectedProperty) return;
    const reqSeq = ++staffReqSeqRef.current;
    setStaffLoading(true);
    setStaffError(null);
    try {
      const params = new URLSearchParams();
      params.set('includeInactive', 'true');
      if (statusFilter !== 'all') params.set('employmentStatus', statusFilter);
      if (departmentFilter) params.set('department', departmentFilter);
      if (shiftFilter) params.set('shiftType', shiftFilter);
      if (staffSearch.trim()) params.set('search', staffSearch.trim());

      const res = await apiFetch<StaffListResponse>(
        `/api/staff?${params.toString()}`,
        { propertyId: selectedProperty.id }
      );
      if (reqSeq === staffReqSeqRef.current) {
        setStaffData(res);
      }
    } catch (err) {
      if (reqSeq === staffReqSeqRef.current) {
        setStaffError(
          err instanceof Error ? err.message : 'Failed to load property staff.'
        );
      }
    } finally {
      if (reqSeq === staffReqSeqRef.current) {
        setStaffLoading(false);
      }
    }
  }, [
    selectedProperty,
    statusFilter,
    departmentFilter,
    shiftFilter,
    staffSearch,
  ]);

  const loadManagedUsers = useCallback(async () => {
    if (!selectedProperty || !isAdmin) return;
    const reqSeq = ++usersReqSeqRef.current;
    setUsersLoading(true);
    setUsersError(null);
    try {
      const params = new URLSearchParams();
      if (userRoleFilter) params.set('role', userRoleFilter);
      if (userActiveFilter === 'active') params.set('isActive', 'true');
      if (userActiveFilter === 'inactive') params.set('isActive', 'false');
      if (userSearch.trim()) params.set('search', userSearch.trim());

      const res = await apiFetch<{ items: ManagedUserAccount[] }>(
        `/api/users?${params.toString()}`,
        { propertyId: selectedProperty.id }
      );
      if (reqSeq === usersReqSeqRef.current) {
        setManagedUsers(res.items);
      }
    } catch (err) {
      if (reqSeq === usersReqSeqRef.current) {
        setUsersError(
          err instanceof Error ? err.message : 'Failed to load system users.'
        );
      }
    } finally {
      if (reqSeq === usersReqSeqRef.current) {
        setUsersLoading(false);
      }
    }
  }, [
    selectedProperty,
    isAdmin,
    userRoleFilter,
    userActiveFilter,
    userSearch,
  ]);

  const loadPropertyUsers = useCallback(async () => {
    if (!selectedProperty || !isAdmin) return;
    const reqSeq = ++propUsersReqSeqRef.current;
    try {
      const params = new URLSearchParams();
      params.set('filterPropertyId', selectedProperty.id);
      const res = await apiFetch<{ items: ManagedUserAccount[] }>(
        `/api/users?${params.toString()}`,
        { propertyId: selectedProperty.id }
      );
      if (reqSeq === propUsersReqSeqRef.current) {
        setPropertyUsers(res.items);
      }
    } catch {
      // Non-blocking auxiliary fetch; primary users tab surfaces any /api/users error
    }
  }, [selectedProperty, isAdmin]);

  const refreshAllAdminViews = useCallback(async () => {
    await Promise.all([
      loadStaff(),
      isAdmin ? loadManagedUsers() : Promise.resolve(),
      isAdmin ? loadPropertyUsers() : Promise.resolve(),
    ]);
  }, [loadStaff, loadManagedUsers, loadPropertyUsers, isAdmin]);

  useEffect(() => {
    void loadStaff();
  }, [loadStaff]);

  useEffect(() => {
    if (isAdmin) {
      void loadManagedUsers();
    }
  }, [isAdmin, loadManagedUsers]);

  useEffect(() => {
    if (isAdmin) {
      void loadPropertyUsers();
    }
  }, [isAdmin, loadPropertyUsers]);

  useEffect(() => {
    if (!staffDetailId || !selectedProperty) {
      setStaffDetail(null);
      return;
    }
    let active = true;
    setStaffDetailLoading(true);
    apiFetch<{ staff: StaffProfileDetail }>(`/api/staff/${staffDetailId}`, {
      propertyId: selectedProperty.id,
    })
      .then((res) => {
        if (active) setStaffDetail(res.staff);
      })
      .catch((err) => {
        if (active) {
          showToast(
            'error',
            err instanceof Error ? err.message : 'Failed to load staff profile.'
          );
          setStaffDetailId(null);
        }
      })
      .finally(() => {
        if (active) setStaffDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [staffDetailId, selectedProperty, showToast]);

  if (!selectedProperty || !user) return null;

  const summary = staffData?.summary;
  const hasActiveStaffFilters =
    statusFilter !== 'all' ||
    Boolean(departmentFilter) ||
    Boolean(shiftFilter) ||
    Boolean(staffSearch.trim());

  const clearStaffFilters = () => {
    setStatusFilter('all');
    setDepartmentFilter('');
    setShiftFilter('');
    setStaffSearch('');
  };

  // Active login accounts that hold access to selectedProperty (`users` + `user_property_access`)
  // but do NOT yet have a linked `property_staff_profiles` row in selectedProperty.
  const unlinkedActivePropertyUsers = isAdmin
    ? propertyUsers.filter(
        (u) =>
          u.isActive &&
          (u.role === 'admin' ||
            (u.propertyAccess ?? []).some(
              (pa) => pa.propertyId === selectedProperty.id
            )) &&
          !(u.linkedStaffProfiles ?? []).some(
            (sp) => sp.propertyId === selectedProperty.id
          )
      )
    : [];

  const openCreateStaffForUser = (u: ManagedUserAccount) => {
    setEditingStaff(null);
    setPrefillUserForStaff({
      userId: u.id,
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      role: u.role,
    });
    setStaffModalOpen(true);
  };

  const handleToggleStaffActive = async () => {
    if (!deactivateStaffTarget) return;
    setDeactivatingStaff(true);
    try {
      const nextStatus: StaffEmploymentStatus =
        deactivateStaffTarget.employmentStatus === 'inactive'
          ? 'active'
          : 'inactive';
      await apiFetch(`/api/staff/${deactivateStaffTarget.id}`, {
        method: 'PUT',
        propertyId: selectedProperty.id,
        body: { employmentStatus: nextStatus },
      });
      showToast(
        'success',
        nextStatus === 'inactive'
          ? `Deactivated staff profile "${deactivateStaffTarget.fullName}".`
          : `Reactivated staff profile "${deactivateStaffTarget.fullName}".`
      );
      setDeactivateStaffTarget(null);
      await refreshAllAdminViews();
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Failed to update staff status.'
      );
    } finally {
      setDeactivatingStaff(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
            <Users className="h-6 w-6 text-indigo-600" />
            Staff Directory & User Access
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Property staff roster for {selectedProperty.name} ({selectedProperty.code}),
            separated cleanly from system login accounts, roles, and property access controls.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              void refreshAllAdminViews();
            }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>

          {isAdmin && activeTab === 'users' && (
            <button
              type="button"
              onClick={() => setCreateUserOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              New System User
            </button>
          )}

          {isAdmin && activeTab === 'directory' && (
            <button
              type="button"
              onClick={() => {
                setEditingStaff(null);
                setPrefillUserForStaff(null);
                setStaffModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              New Staff Profile
            </button>
          )}
        </div>
      </div>

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Total Roster</span>
            <Users className="h-4 w-4 text-indigo-600" />
          </div>
          <p
            data-testid="staff-kpi-total"
            className="mt-2 text-2xl font-bold text-slate-900"
          >
            {summary?.totalStaffCount ?? 0}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {selectedProperty.code} staff profiles
          </p>
        </div>

        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-semibold text-emerald-800">
            <span>Active Staff</span>
            <UserCheck className="h-4 w-4 text-emerald-600" />
          </div>
          <p
            data-testid="staff-kpi-active"
            className="mt-2 text-2xl font-bold text-emerald-950"
          >
            {summary?.activeCount ?? 0}
          </p>
          <p className="text-[11px] text-emerald-800/80 mt-0.5">
            Eligible for assignments
          </p>
        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-semibold text-amber-800">
            <span>On Leave</span>
            <UserCog className="h-4 w-4 text-amber-600" />
          </div>
          <p
            data-testid="staff-kpi-on-leave"
            className="mt-2 text-2xl font-bold text-amber-950"
          >
            {summary?.onLeaveCount ?? 0}
          </p>
          <p className="text-[11px] text-amber-800/80 mt-0.5">Temporary leave</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Deactivated</span>
            <UserMinus className="h-4 w-4 text-slate-400" />
          </div>
          <p
            data-testid="staff-kpi-inactive"
            className="mt-2 text-2xl font-bold text-slate-900"
          >
            {summary?.inactiveCount ?? 0}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            History preserved
          </p>
        </div>

        <div className="col-span-2 lg:col-span-1 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-semibold text-indigo-800">
            <span>Linked Login Accounts</span>
            <Shield className="h-4 w-4 text-indigo-600" />
          </div>
          <p
            data-testid="staff-kpi-linked-users"
            className="mt-2 text-2xl font-bold text-indigo-950"
          >
            {summary?.linkedUsersCount ?? 0}
          </p>
          <p className="text-[11px] text-indigo-800/80 mt-0.5">
            Active {selectedProperty.code} staff w/ login
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200 flex items-center gap-6">
        <button
          type="button"
          onClick={() => setActiveTab('directory')}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === 'directory'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          Property Staff Directory ({staffData?.items.length ?? 0})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('users')}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'users'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Shield className="h-3.5 w-3.5" />
          System Users & Property Access
          {isAdmin ? ` (${managedUsers.length})` : ''}
        </button>
      </div>

      {/* TAB 1: PROPERTY STAFF DIRECTORY */}
      {activeTab === 'directory' && (
        <div className="space-y-4">
          {staffError && (
            <ErrorAlert message={staffError} onRetry={() => void loadStaff()} />
          )}

          {/* Honest Distinction & Guided Creation Banner for Unlinked Property Logins */}
          {isAdmin &&
            !staffLoading &&
            unlinkedActivePropertyUsers.length > 0 && (
              <div
                data-testid="unlinked-property-logins-banner"
                className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3"
              >
                <div className="flex items-start gap-3">
                  <Info className="h-5 w-5 text-indigo-600 shrink-0 mt-0.5" />
                  <div className="space-y-1 text-xs text-slate-700 leading-relaxed">
                    <p className="font-bold text-slate-900">
                      {unlinkedActivePropertyUsers.length} active PMS login account
                      {unlinkedActivePropertyUsers.length === 1 ? ' has' : 's have'}{' '}
                      {selectedProperty.code} property access without a linked{' '}
                      {selectedProperty.code} staff profile
                    </p>
                    <p>
                      System user accounts (<code className="font-mono text-[11px]">users</code>{' '}
                      + <code className="font-mono text-[11px]">user_property_access</code>)
                      control PMS sign-in and permissions, whereas{' '}
                      <strong>Property Staff Directory</strong> tracks operational{' '}
                      {selectedProperty.code} staff profiles (departments, shifts, and
                      service assignments). Login accounts are never counted as staff
                      profiles automatically—create and link a profile below if they also
                      serve on the {selectedProperty.code} property roster.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pl-8">
                  {unlinkedActivePropertyUsers.map((u) => (
                    <div
                      key={u.id}
                      className="inline-flex items-center gap-2.5 rounded-xl border border-indigo-200/80 bg-white px-3 py-1.5 text-xs shadow-2xs"
                    >
                      <div>
                        <span className="font-semibold text-slate-900">
                          {u.fullName}
                        </span>{' '}
                        <span className="text-slate-500">({u.email})</span>
                      </div>
                      <RoleBadge role={u.role} />
                      <button
                        type="button"
                        data-testid={`create-staff-from-user-${u.email}`}
                        onClick={() => openCreateStaffForUser(u)}
                        className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700"
                      >
                        <UserPlus className="h-3 w-3" />
                        Create & Link {selectedProperty.code} Profile
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {(['all', ...STAFF_EMPLOYMENT_STATUSES] as const).map((st) => {
                const count =
                  st === 'all'
                    ? summary?.totalStaffCount
                    : st === 'active'
                      ? summary?.activeCount
                      : st === 'on_leave'
                        ? summary?.onLeaveCount
                        : summary?.inactiveCount;
                return (
                  <button
                    key={st}
                    type="button"
                    data-testid={`staff-filter-${st}`}
                    onClick={() => setStatusFilter(st)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                      statusFilter === st
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {st === 'all'
                      ? 'All Staff'
                      : STAFF_EMPLOYMENT_STATUS_LABELS[st]}
                    {count !== undefined ? ` (${count})` : ''}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="relative">
                <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={staffSearch}
                  onChange={(e) => setStaffSearch(e.target.value)}
                  placeholder="Search name, code, job title, phone..."
                  className="w-full rounded-xl border border-slate-200 pl-9 pr-8 py-2 text-xs sm:text-sm"
                />
                {staffSearch && (
                  <button
                    type="button"
                    aria-label="Clear staff search"
                    onClick={() => setStaffSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <select
                aria-label="Filter by department"
                value={departmentFilter}
                onChange={(e) => setDepartmentFilter(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs sm:text-sm"
              >
                <option value="">All Departments</option>
                {STAFF_DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {STAFF_DEPARTMENT_LABELS[d]}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter by shift"
                value={shiftFilter}
                onChange={(e) => setShiftFilter(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs sm:text-sm"
              >
                <option value="">All Shifts</option>
                {STAFF_SHIFT_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {STAFF_SHIFT_TYPE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {staffLoading ? (
            <LoadingState label="Loading property staff directory..." />
          ) : !staffData || staffData.items.length === 0 ? (
            (summary?.totalStaffCount ?? 0) > 0 && hasActiveStaffFilters ? (
              <EmptyState
                title="No matching staff profiles"
                description={`None of the ${summary?.totalStaffCount ?? 0} staff profile(s) registered for ${selectedProperty.name} (${selectedProperty.code}) match your active filter criteria.`}
                action={
                  <button
                    type="button"
                    onClick={clearStaffFilters}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <X className="h-3.5 w-3.5" />
                    Clear Filters
                  </button>
                }
              />
            ) : (
              <EmptyState
                title={`No staff profiles registered for ${selectedProperty.code} yet`}
                description={
                  isAdmin
                    ? `No operational staff profiles exist in ${selectedProperty.name} (${selectedProperty.code}) yet. System login accounts with ${selectedProperty.code} access are managed separately and are only linked when you create or edit a property staff profile.`
                    : `No operational staff profiles have been created for ${selectedProperty.name} (${selectedProperty.code}) yet. Your PMS login (${user.email}) grants system access to ${selectedProperty.code}; an Administrator can add property staff profiles.`
                }
                action={
                  isAdmin ? (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingStaff(null);
                        setPrefillUserForStaff(null);
                        setStaffModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                    >
                      <Plus className="h-4 w-4" />
                      Add First Staff Profile
                    </button>
                  ) : undefined
                }
              />
            )
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Staff Member</th>
                      <th className="px-4 py-3">Department & Role</th>
                      <th className="px-4 py-3">Contact</th>
                      <th className="px-4 py-3">PMS Account</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Service Load</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {staffData.items.map((sp) => (
                      <tr
                        key={sp.id}
                        data-testid={`staff-row-${sp.employeeCode}`}
                        className="hover:bg-slate-50/70"
                      >
                        <td className="px-4 py-3.5">
                          <div className="font-semibold text-slate-900">
                            {sp.fullName}
                          </div>
                          <div className="text-xs text-slate-500 font-mono">
                            {sp.employeeCode} •{' '}
                            {STAFF_SHIFT_TYPE_LABELS[sp.shiftType]}
                          </div>
                        </td>

                        <td className="px-4 py-3.5">
                          <div className="font-medium text-slate-800">
                            {sp.jobTitle}
                          </div>
                          <div className="text-xs text-slate-500">
                            {STAFF_DEPARTMENT_LABELS[sp.department]}
                          </div>
                        </td>

                        <td className="px-4 py-3.5 text-xs text-slate-600">
                          {sp.phone && <div>{sp.phone}</div>}
                          {sp.email && (
                            <div className="text-slate-400">{sp.email}</div>
                          )}
                          {!sp.phone && !sp.email && (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>

                        <td className="px-4 py-3.5 text-xs">
                          {sp.linkedUserEmail && sp.linkedUserRole ? (
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <RoleBadge role={sp.linkedUserRole} />
                                {sp.linkedUserIsActive === false && (
                                  <span className="rounded bg-rose-50 border border-rose-200 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                                    Login Disabled
                                  </span>
                                )}
                                {sp.linkedUserIsActive !== false &&
                                  sp.linkedUserHasPropertyAccess === false && (
                                    <span className="rounded bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                      No {selectedProperty.code} Access
                                    </span>
                                  )}
                              </div>
                              <div className="text-[11px] text-slate-500 truncate max-w-[180px]">
                                {sp.linkedUserEmail}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-400">
                              Operational Roster Only
                            </span>
                          )}
                        </td>

                        <td className="px-4 py-3.5">
                          <StaffEmploymentStatusBadge
                            status={sp.employmentStatus}
                          />
                        </td>

                        <td className="px-4 py-3.5 text-right text-xs text-slate-600">
                          <div>{sp.assignedOpenRequestsCount} open</div>
                          <div className="text-slate-400">
                            {sp.completedRequestsCount} completed
                          </div>
                        </td>

                        <td className="px-4 py-3.5 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              aria-label={`View ${sp.fullName}`}
                              onClick={() => setStaffDetailId(sp.id)}
                              className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>

                            {isAdmin && (
                              <>
                                <button
                                  type="button"
                                  aria-label={`Edit ${sp.fullName}`}
                                  onClick={() => {
                                    setPrefillUserForStaff(null);
                                    setEditingStaff(sp);
                                    setStaffModalOpen(true);
                                  }}
                                  className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeactivateStaffTarget(sp)}
                                  className={`rounded-lg border px-2 py-1 text-xs font-semibold ${
                                    sp.employmentStatus === 'inactive'
                                      ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                                      : 'border-rose-200 text-rose-700 hover:bg-rose-50'
                                  }`}
                                >
                                  {sp.employmentStatus === 'inactive'
                                    ? 'Reactivate'
                                    : 'Deactivate'}
                                </button>
                              </>
                            )}
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
      )}

      {/* TAB 2: SYSTEM USERS & PROPERTY ACCESS */}
      {activeTab === 'users' && (
        <div className="space-y-4">
          {!isAdmin ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-6 flex items-start gap-4">
              <ShieldAlert className="h-6 w-6 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-amber-950">
                  Administrator Privileges Required
                </h3>
                <p className="text-xs text-amber-900/90 leading-relaxed max-w-2xl">
                  System login creation, role elevation, password resets, and
                  multi-property access assignments are restricted to
                  Administrators under StayCraft PMS least-privilege access
                  controls. You can view the operational Property Staff
                  Directory in the first tab.
                </p>
              </div>
            </div>
          ) : (
            <>
              {usersError && (
                <ErrorAlert
                  message={usersError}
                  onRetry={() => void loadManagedUsers()}
                />
              )}

              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="relative">
                  <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    placeholder="Search user name or email..."
                    className="w-full rounded-xl border border-slate-200 pl-9 pr-3 py-2 text-xs sm:text-sm"
                  />
                </div>

                <select
                  aria-label="Filter users by role"
                  value={userRoleFilter}
                  onChange={(e) => setUserRoleFilter(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs sm:text-sm"
                >
                  <option value="">All Roles</option>
                  {USER_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r === 'admin' ? 'Administrator' : 'Receptionist'}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Filter users by status"
                  value={userActiveFilter}
                  onChange={(e) => setUserActiveFilter(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs sm:text-sm"
                >
                  <option value="all">All Account States</option>
                  <option value="active">Active Logins Only</option>
                  <option value="inactive">Disabled Logins Only</option>
                </select>
              </div>

              {usersLoading ? (
                <LoadingState label="Loading system accounts & property grants..." />
              ) : managedUsers.length === 0 ? (
                <EmptyState
                  title="No matching system users"
                  description="Create receptionist or administrator login accounts and assign explicit property access."
                />
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-slate-50 border-b border-slate-100 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <tr>
                          <th className="px-4 py-3">User Account</th>
                          <th className="px-4 py-3">Role</th>
                          <th className="px-4 py-3">Property Access</th>
                          <th className="px-4 py-3">
                            {selectedProperty.code} Staff Profile
                          </th>
                          <th className="px-4 py-3">Account State</th>
                          <th className="px-4 py-3 text-right">Controls</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {managedUsers.map((u) => {
                          const isSelf = u.id === user.id;
                          const hasSelectedPropAccess =
                            u.role === 'admin' ||
                            u.propertyAccess.some(
                              (pa) => pa.propertyId === selectedProperty.id
                            );
                          const linkedInSelectedProp = (
                            u.linkedStaffProfiles ?? []
                          ).find((sp) => sp.propertyId === selectedProperty.id);

                          return (
                            <tr
                              key={u.id}
                              data-testid={`managed-user-row-${u.email}`}
                              className="hover:bg-slate-50/70"
                            >
                              <td className="px-4 py-3.5">
                                <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                                  <span>{u.fullName}</span>
                                  {isSelf && (
                                    <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                                      You
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {u.email}
                                  {u.phone ? ` • ${u.phone}` : ''}
                                </div>
                              </td>

                              <td className="px-4 py-3.5">
                                <RoleBadge role={u.role} />
                              </td>

                              <td className="px-4 py-3.5">
                                {u.role === 'admin' ? (
                                  <span className="text-xs font-medium text-indigo-700">
                                    All Active Properties (Global Admin)
                                  </span>
                                ) : u.propertyAccess.length > 0 ? (
                                  <div className="flex flex-wrap gap-1">
                                    {u.propertyAccess.map((pa) => (
                                      <span
                                        key={pa.propertyId}
                                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700"
                                      >
                                        {pa.propertyCode}
                                        {pa.isDefault && (
                                          <span className="text-[10px] text-indigo-600 font-bold">
                                            ★
                                          </span>
                                        )}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-xs text-rose-600 font-medium">
                                    No property access assigned
                                  </span>
                                )}
                              </td>

                              <td className="px-4 py-3.5 text-xs">
                                {linkedInSelectedProp ? (
                                  <div className="space-y-1">
                                    <div className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
                                      <Link2 className="h-3.5 w-3.5 text-indigo-600" />
                                      <span className="font-mono">
                                        {linkedInSelectedProp.employeeCode}
                                      </span>
                                      <StaffEmploymentStatusBadge
                                        status={
                                          linkedInSelectedProp.employmentStatus
                                        }
                                      />
                                    </div>
                                    <div className="text-[11px] text-slate-500">
                                      {linkedInSelectedProp.jobTitle}
                                    </div>
                                  </div>
                                ) : hasSelectedPropAccess && u.isActive ? (
                                  <div className="space-y-1">
                                    <div className="text-slate-400">
                                      Not on {selectedProperty.code} staff roster
                                    </div>
                                    <button
                                      type="button"
                                      data-testid={`users-tab-create-staff-${u.email}`}
                                      onClick={() => openCreateStaffForUser(u)}
                                      className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50/70 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100"
                                    >
                                      <UserPlus className="h-3 w-3" />
                                      Create & Link {selectedProperty.code} Profile
                                    </button>
                                  </div>
                                ) : (
                                  <span className="text-slate-400">
                                    {!u.isActive
                                      ? 'Login disabled'
                                      : `No ${selectedProperty.code} access`}
                                  </span>
                                )}
                              </td>

                              <td className="px-4 py-3.5">
                                {u.isActive ? (
                                  <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                                    Active
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                                    Disabled
                                  </span>
                                )}
                              </td>

                              <td className="px-4 py-3.5 text-right">
                                <div className="inline-flex items-center gap-1.5 flex-wrap justify-end">
                                  <button
                                    type="button"
                                    onClick={() => setAccessModalTarget(u)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                                  >
                                    <Building2 className="h-3.5 w-3.5" />
                                    Properties
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => setEditUserTarget(u)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                    Edit / Role
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => setResetPasswordTarget(u)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50/60 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                                  >
                                    <KeyRound className="h-3.5 w-3.5" />
                                    Reset Password
                                  </button>
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
            </>
          )}
        </div>
      )}

      {/* Staff Create / Edit Modal */}
      {staffModalOpen && (
        <StaffProfileFormModal
          open={staffModalOpen}
          onClose={() => {
            setStaffModalOpen(false);
            setEditingStaff(null);
            setPrefillUserForStaff(null);
          }}
          propertyId={selectedProperty.id}
          propertyCode={selectedProperty.code}
          editing={editingStaff}
          prefillUser={prefillUserForStaff}
          availableUsers={propertyUsers.length > 0 ? propertyUsers : managedUsers}
          onSaved={async () => {
            setStaffModalOpen(false);
            setEditingStaff(null);
            setPrefillUserForStaff(null);
            await refreshAllAdminViews();
          }}
        />
      )}

      {/* Staff Deactivate / Reactivate Confirmation */}
      {deactivateStaffTarget && (
        <ConfirmDialog
          open={Boolean(deactivateStaffTarget)}
          onClose={() => setDeactivateStaffTarget(null)}
          onConfirm={handleToggleStaffActive}
          isSubmitting={deactivatingStaff}
          variant={
            deactivateStaffTarget.employmentStatus === 'inactive'
              ? 'primary'
              : 'danger'
          }
          title={
            deactivateStaffTarget.employmentStatus === 'inactive'
              ? `Reactivate ${deactivateStaffTarget.fullName}?`
              : `Deactivate ${deactivateStaffTarget.fullName}?`
          }
          description={
            deactivateStaffTarget.employmentStatus === 'inactive'
              ? 'Reactivating restores this staff member to active roster eligibility for new service assignments.'
              : 'Deactivating removes this staff member from new assignment dropdowns while preserving all historical service requests and audit trails.'
          }
          confirmLabel={
            deactivateStaffTarget.employmentStatus === 'inactive'
              ? 'Reactivate Staff'
              : 'Deactivate Staff'
          }
        />
      )}

      {/* Staff Profile Detail Modal */}
      {staffDetailId && (
        <Modal
          open={Boolean(staffDetailId)}
          onClose={() => setStaffDetailId(null)}
          title={
            staffDetail
              ? `${staffDetail.fullName} (${staffDetail.employeeCode})`
              : 'Staff Profile'
          }
          subtitle={
            staffDetail
              ? `${staffDetail.jobTitle} • ${
                  STAFF_DEPARTMENT_LABELS[staffDetail.department]
                }`
              : undefined
          }
          maxWidthClass="max-w-2xl"
        >
          {staffDetailLoading || !staffDetail ? (
            <LoadingState label="Loading staff profile & assignment history..." />
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-xs">
                <div>
                  <span className="text-slate-500 block">Status</span>
                  <div className="mt-1">
                    <StaffEmploymentStatusBadge
                      status={staffDetail.employmentStatus}
                    />
                  </div>
                </div>
                <div>
                  <span className="text-slate-500 block">Shift</span>
                  <p className="font-semibold text-slate-900 mt-1">
                    {STAFF_SHIFT_TYPE_LABELS[staffDetail.shiftType]}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500 block">Joined Date</span>
                  <p className="font-semibold text-slate-900 mt-1">
                    {staffDetail.joinedOn ?? '—'}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500 block">Contact</span>
                  <p className="font-medium text-slate-800 mt-0.5">
                    {staffDetail.phone || staffDetail.email || '—'}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500 block">Emergency Contact</span>
                  <p className="font-medium text-slate-800 mt-0.5">
                    {staffDetail.emergencyContact || '—'}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500 block">Linked PMS Login</span>
                  <p className="font-medium text-slate-800 mt-0.5">
                    {staffDetail.linkedUserEmail ?? 'None'}
                  </p>
                </div>
              </div>

              {staffDetail.notes && (
                <div className="rounded-xl border border-slate-200 p-3 text-xs text-slate-700">
                  <span className="font-semibold block mb-1">Profile Notes</span>
                  {staffDetail.notes}
                </div>
              )}

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                  Assigned Service Requests (
                  {staffDetail.recentServiceRequests.length})
                </h3>
                {staffDetail.recentServiceRequests.length === 0 ? (
                  <p className="text-xs text-slate-500 italic">
                    No service requests assigned yet.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                    {staffDetail.recentServiceRequests.map((sr) => (
                      <div
                        key={sr.id}
                        className="px-3.5 py-2.5 text-xs flex items-center justify-between gap-3"
                      >
                        <div>
                          <span className="font-mono font-semibold text-indigo-700">
                            {sr.requestNumber}
                          </span>{' '}
                          <span className="font-medium text-slate-900">
                            {sr.serviceNameSnapshot}
                          </span>
                          <div className="text-slate-500 mt-0.5">
                            {sr.guestName ?? 'Guest'}
                            {sr.roomNumber ? ` • Room ${sr.roomNumber}` : ''} •{' '}
                            {formatMoney(sr.totalAmount, sr.currency)}
                          </div>
                        </div>
                        <ServiceRequestStatusBadge status={sr.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* Admin Create User Modal */}
      {createUserOpen && isAdmin && (
        <CreateManagedUserModal
          open={createUserOpen}
          onClose={() => setCreateUserOpen(false)}
          contextPropertyId={selectedProperty.id}
          properties={properties}
          onCreated={async () => {
            setCreateUserOpen(false);
            await refreshAllAdminViews();
          }}
        />
      )}

      {/* Admin Edit User & Role Modal */}
      {editUserTarget && isAdmin && (
        <EditManagedUserModal
          open={Boolean(editUserTarget)}
          onClose={() => setEditUserTarget(null)}
          contextPropertyId={selectedProperty.id}
          currentActorId={user.id}
          target={editUserTarget}
          onSaved={async () => {
            setEditUserTarget(null);
            await refreshAllAdminViews();
          }}
        />
      )}

      {/* Admin Property Access Modal */}
      {accessModalTarget && isAdmin && (
        <ManageUserPropertyAccessModal
          open={Boolean(accessModalTarget)}
          onClose={() => setAccessModalTarget(null)}
          contextPropertyId={selectedProperty.id}
          properties={properties}
          target={accessModalTarget}
          onSaved={async () => {
            setAccessModalTarget(null);
            await refreshAllAdminViews();
          }}
        />
      )}

      {/* Admin Reset Password Modal */}
      {resetPasswordTarget && isAdmin && (
        <ResetManagedUserPasswordModal
          open={Boolean(resetPasswordTarget)}
          onClose={() => setResetPasswordTarget(null)}
          contextPropertyId={selectedProperty.id}
          target={resetPasswordTarget}
          onSaved={async () => {
            setResetPasswordTarget(null);
          }}
        />
      )}
    </div>
  );
}

function StaffProfileFormModal({
  open,
  onClose,
  propertyId,
  propertyCode,
  editing,
  prefillUser,
  availableUsers,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  propertyCode: string;
  editing: StaffProfileRecord | null;
  prefillUser: PrefillUserForStaff | null;
  availableUsers: ManagedUserAccount[];
  onSaved: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [employeeCode, setEmployeeCode] = useState(
    editing?.employeeCode ?? ''
  );
  const [fullName, setFullName] = useState(
    editing?.fullName ?? prefillUser?.fullName ?? ''
  );
  const [department, setDepartment] = useState<StaffDepartment>(
    editing?.department ??
      (prefillUser?.role === 'admin' ? 'management' : 'front_office')
  );
  const [jobTitle, setJobTitle] = useState(
    editing?.jobTitle ??
      (prefillUser
        ? prefillUser.role === 'admin'
          ? 'General Manager'
          : 'Front Desk Receptionist'
        : '')
  );
  const [employmentStatus, setEmploymentStatus] =
    useState<StaffEmploymentStatus>(editing?.employmentStatus ?? 'active');
  const [shiftType, setShiftType] = useState<StaffShiftType>(
    editing?.shiftType ?? 'day'
  );
  const [email, setEmail] = useState(
    editing?.email ?? prefillUser?.email ?? ''
  );
  const [phone, setPhone] = useState(
    editing?.phone ?? prefillUser?.phone ?? ''
  );
  const [joinedOn, setJoinedOn] = useState(editing?.joinedOn ?? '');
  const [emergencyContact, setEmergencyContact] = useState(
    editing?.emergencyContact ?? ''
  );
  const [userId, setUserId] = useState<string>(
    editing?.userId ?? prefillUser?.userId ?? ''
  );
  const [notes, setNotes] = useState(editing?.notes ?? '');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const propertyEligibleUsers = availableUsers.filter(
    (u) =>
      (u.isActive || u.id === editing?.userId) &&
      (u.role === 'admin' ||
        u.propertyAccess.some((pa) => pa.propertyId === propertyId))
  );

  // If editing a staff profile whose linked user is not in `availableUsers` (e.g. disabled), preserve option
  const hasCurrentLinkedOption =
    !editing?.userId ||
    propertyEligibleUsers.some((u) => u.id === editing.userId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        employeeCode: employeeCode.trim().toUpperCase(),
        fullName: fullName.trim(),
        department,
        jobTitle: jobTitle.trim(),
        employmentStatus,
        shiftType,
        email: email.trim(),
        phone: phone.trim(),
        joinedOn: joinedOn || null,
        emergencyContact: emergencyContact.trim(),
        userId: userId || null,
        notes: notes.trim(),
      };

      if (editing) {
        await apiFetch(`/api/staff/${editing.id}`, {
          method: 'PUT',
          propertyId,
          body: payload,
        });
        showToast('success', `Updated staff profile "${fullName.trim()}".`);
      } else {
        await apiFetch('/api/staff', {
          method: 'POST',
          propertyId,
          body: payload,
        });
        showToast('success', `Created staff profile "${fullName.trim()}".`);
      }
      await onSaved();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save staff profile.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        editing
          ? `Edit Staff Profile — ${editing.employeeCode}`
          : prefillUser
            ? `Create & Link ${propertyCode} Staff Profile`
            : `New ${propertyCode} Staff Profile`
      }
      subtitle="Manage property roster details independently of user credentials."
      maxWidthClass="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        {prefillUser && !editing && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 text-xs text-indigo-950">
            Linking to existing PMS login{' '}
            <strong>{prefillUser.fullName}</strong> ({prefillUser.email}). Enter
            their {propertyCode} employee code, department, and job title below
            to add them to this property&apos;s operational staff directory.
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label
              htmlFor="sp-code"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Employee Code *
            </label>
            <input
              id="sp-code"
              type="text"
              required
              value={employeeCode}
              onChange={(e) => setEmployeeCode(e.target.value.toUpperCase())}
              placeholder="EMP-101"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>
          <div className="sm:col-span-2">
            <label
              htmlFor="sp-name"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Full Name *
            </label>
            <input
              id="sp-name"
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Meera Nair"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="sp-dept"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Department *
            </label>
            <select
              id="sp-dept"
              value={department}
              onChange={(e) => setDepartment(e.target.value as StaffDepartment)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {STAFF_DEPARTMENTS.map((d) => (
                <option key={d} value={d}>
                  {STAFF_DEPARTMENT_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="sp-title"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Job Title *
            </label>
            <input
              id="sp-title"
              type="text"
              required
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="Senior Concierge"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label
              htmlFor="sp-status"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Employment Status
            </label>
            <select
              id="sp-status"
              value={employmentStatus}
              onChange={(e) =>
                setEmploymentStatus(e.target.value as StaffEmploymentStatus)
              }
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {STAFF_EMPLOYMENT_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {STAFF_EMPLOYMENT_STATUS_LABELS[st]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="sp-shift"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Shift
            </label>
            <select
              id="sp-shift"
              value={shiftType}
              onChange={(e) => setShiftType(e.target.value as StaffShiftType)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {STAFF_SHIFT_TYPES.map((s) => (
                <option key={s} value={s}>
                  {STAFF_SHIFT_TYPE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="sp-joined"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Joined Date
            </label>
            <input
              id="sp-joined"
              type="date"
              value={joinedOn}
              onChange={(e) => setJoinedOn(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="sp-phone"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Phone
            </label>
            <input
              id="sp-phone"
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="sp-email"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Work Email
            </label>
            <input
              id="sp-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="staff@hotel.com"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="sp-emergency"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Emergency Contact
            </label>
            <input
              id="sp-emergency"
              type="text"
              value={emergencyContact}
              onChange={(e) => setEmergencyContact(e.target.value)}
              placeholder="Name & phone"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="sp-linked-user"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Link PMS System Account (Optional)
            </label>
            <select
              id="sp-linked-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">No login linked (Roster only)</option>
              {!hasCurrentLinkedOption && editing?.userId && (
                <option value={editing.userId}>
                  {editing.linkedUserEmail ?? 'Linked user'} (currently linked
                  {editing.linkedUserIsActive === false
                    ? ' — login disabled'
                    : ''}
                  )
                </option>
              )}
              {propertyEligibleUsers.map((u) => {
                const existingLinkInProp = (u.linkedStaffProfiles ?? []).find(
                  (sp) => sp.propertyId === propertyId
                );
                const linkedToAnotherStaff =
                  Boolean(existingLinkInProp) &&
                  existingLinkInProp?.staffId !== editing?.id;
                return (
                  <option
                    key={u.id}
                    value={u.id}
                    disabled={linkedToAnotherStaff}
                  >
                    {u.fullName} ({u.email} — {u.role})
                    {!u.isActive ? ' [Login Disabled]' : ''}
                    {linkedToAnotherStaff && existingLinkInProp
                      ? ` [Already linked to ${existingLinkInProp.employeeCode}]`
                      : ''}
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        <div>
          <label
            htmlFor="sp-notes"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Notes
          </label>
          <textarea
            id="sp-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Certifications, languages spoken, shift notes..."
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting
              ? 'Saving...'
              : editing
                ? 'Save Profile'
                : 'Create Staff Profile'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreateManagedUserModal({
  open,
  onClose,
  contextPropertyId,
  properties,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  contextPropertyId: string;
  properties: Array<{ id: string; code: string; name: string }>;
  onCreated: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<UserRole>('receptionist');
  const [password, setPassword] = useState('');
  const [selectedPropertyIds, setSelectedPropertyIds] = useState<string[]>([
    contextPropertyId,
  ]);
  const [defaultPropertyId, setDefaultPropertyId] =
    useState<string>(contextPropertyId);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleProperty = (propId: string) => {
    setSelectedPropertyIds((prev) => {
      const next = prev.includes(propId)
        ? prev.filter((id) => id !== propId)
        : [...prev, propId];
      if (!next.includes(defaultPropertyId)) {
        setDefaultPropertyId(next[0] ?? '');
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        propertyId: contextPropertyId,
        body: {
          fullName: fullName.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          role,
          password,
          isActive: true,
          propertyIds: selectedPropertyIds,
          defaultPropertyId: selectedPropertyIds.includes(defaultPropertyId)
            ? defaultPropertyId
            : selectedPropertyIds[0] ?? null,
        },
      });
      showToast('success', `Created user account for ${email.trim()}.`);
      await onCreated();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create user account.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create System User Account"
      subtitle="Assign role and explicit property access."
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="cu-name"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Full Name *
            </label>
            <input
              id="cu-name"
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Rohan Verma"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="cu-role"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              System Role *
            </label>
            <select
              id="cu-role"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="receptionist">Receptionist (Property-Scoped)</option>
              <option value="admin">Administrator (Full Access)</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="cu-email"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Login Email *
            </label>
            <input
              id="cu-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="reception.desk@hotel.com"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label
              htmlFor="cu-phone"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Phone
            </label>
            <input
              id="cu-phone"
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98000 00000"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="cu-password"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Initial Password (min 8 chars) *
          </label>
          <input
            id="cu-password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••••"
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-2">
          <div className="text-xs font-semibold text-slate-700">
            Assigned Properties
          </div>
          <div className="space-y-1.5">
            {properties.map((p) => {
              const checked = selectedPropertyIds.includes(p.id);
              return (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-800">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleProperty(p.id)}
                      className="rounded border-slate-300 text-indigo-600"
                    />
                    <span>
                      {p.name} ({p.code})
                    </span>
                  </label>
                  {checked && (
                    <button
                      type="button"
                      onClick={() => setDefaultPropertyId(p.id)}
                      className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                        defaultPropertyId === p.id
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white border border-slate-200 text-slate-600'
                      }`}
                    >
                      {defaultPropertyId === p.id ? 'Default' : 'Set Default'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? 'Creating Account...' : 'Create User'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditManagedUserModal({
  open,
  onClose,
  contextPropertyId,
  currentActorId,
  target,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  contextPropertyId: string;
  currentActorId: string;
  target: ManagedUserAccount;
  onSaved: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const isSelf = target.id === currentActorId;
  const canEditEmail = target.role === 'receptionist' || isSelf;
  const [fullName, setFullName] = useState(target.fullName);
  const [email, setEmail] = useState(target.email);
  const [phone, setPhone] = useState(target.phone);
  const [role, setRole] = useState<UserRole>(target.role);
  const [isActive, setIsActive] = useState<boolean>(target.isActive);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      await apiFetch(`/api/users/${target.id}`, {
        method: 'PUT',
        propertyId: contextPropertyId,
        body: {
          fullName: fullName.trim(),
          ...(canEditEmail && normalizedEmail !== target.email.toLowerCase()
            ? { email: normalizedEmail }
            : {}),
          phone: phone.trim(),
          role,
          isActive,
        },
      });
      showToast('success', `Updated user ${normalizedEmail || target.email}.`);
      await onSaved();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to update user account.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Manage User — ${target.email}`}
      subtitle="Update account details, system role, or login activation state."
      maxWidthClass="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div>
          <label
            htmlFor="eu-name"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Full Name *
          </label>
          <input
            id="eu-name"
            type="text"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="eu-email"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Login Email *
          </label>
          <input
            id="eu-email"
            data-testid="eu-email-input"
            type="email"
            required
            disabled={!canEditEmail}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
          />
          {!canEditEmail ? (
            <p className="text-[11px] text-slate-500 mt-1">
              Other administrators manage their own login email via Account &
              Security Settings.
            </p>
          ) : (
            <p className="text-[11px] text-slate-500 mt-1">
              Changing email revokes active sessions on other devices and records
              an audit entry.
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="eu-phone"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Phone
          </label>
          <input
            id="eu-phone"
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="eu-role"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Role
          </label>
          <select
            id="eu-role"
            disabled={isSelf}
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
          >
            <option value="receptionist">Receptionist</option>
            <option value="admin">Administrator</option>
          </select>
          {isSelf && (
            <p className="text-[11px] text-slate-500 mt-1">
              Self-demotion and self-deactivation are blocked to prevent admin
              lockout.
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            disabled={isSelf}
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="rounded border-slate-300 text-indigo-600"
          />
          Account is active (disabling revokes all active login sessions)
        </label>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? 'Saving...' : 'Save Account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ManageUserPropertyAccessModal({
  open,
  onClose,
  contextPropertyId,
  properties,
  target,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  contextPropertyId: string;
  properties: Array<{ id: string; code: string; name: string }>;
  target: ManagedUserAccount;
  onSaved: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [selectedIds, setSelectedIds] = useState<string[]>(
    target.propertyAccess.map((pa) => pa.propertyId)
  );
  const [defaultId, setDefaultId] = useState<string>(
    target.propertyAccess.find((pa) => pa.isDefault)?.propertyId ??
      target.propertyAccess[0]?.propertyId ??
      ''
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleProp = (propId: string) => {
    setSelectedIds((prev) => {
      const next = prev.includes(propId)
        ? prev.filter((id) => id !== propId)
        : [...prev, propId];
      if (!next.includes(defaultId)) {
        setDefaultId(next[0] ?? '');
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/users/${target.id}/property-access`, {
        method: 'PUT',
        propertyId: contextPropertyId,
        body: {
          propertyIds: selectedIds,
          defaultPropertyId: selectedIds.includes(defaultId)
            ? defaultId
            : selectedIds[0] ?? null,
        },
      });
      showToast('success', `Updated property access for ${target.email}.`);
      await onSaved();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to update user property access.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Property Access — ${target.fullName}`}
      subtitle={target.email}
      maxWidthClass="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        {target.role === 'admin' && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-3 text-xs text-indigo-900">
            Administrators automatically hold access across all active properties.
            Default property selection below sets their preferred landing
            property.
          </div>
        )}

        <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {properties.map((p) => {
            const checked = selectedIds.includes(p.id);
            return (
              <div
                key={p.id}
                className="flex items-center justify-between px-3.5 py-2.5 text-xs"
              >
                <label className="flex items-center gap-2.5 cursor-pointer font-medium text-slate-800">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleProp(p.id)}
                    className="rounded border-slate-300 text-indigo-600"
                  />
                  <span>
                    {p.name} ({p.code})
                  </span>
                </label>

                {checked && (
                  <button
                    type="button"
                    onClick={() => setDefaultId(p.id)}
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                      defaultId === p.id
                        ? 'bg-indigo-600 text-white'
                        : 'border border-slate-200 text-slate-600'
                    }`}
                  >
                    {defaultId === p.id ? 'Default' : 'Make Default'}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? 'Saving...' : 'Save Property Access'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetManagedUserPasswordModal({
  open,
  onClose,
  contextPropertyId,
  target,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  contextPropertyId: string;
  target: ManagedUserAccount;
  onSaved: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sendingLink, setSendingLink] = useState(false);
  const [linkResult, setLinkResult] =
    useState<AdminPasswordResetInitiateResponse | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSendResetLink = async () => {
    setError(null);
    setSendingLink(true);
    setCopiedLink(false);
    try {
      const res = await apiFetch<AdminPasswordResetInitiateResponse>(
        `/api/users/${target.id}/send-reset-link`,
        {
          method: 'POST',
          propertyId: contextPropertyId,
        }
      );
      setLinkResult(res);
      showToast(
        'success',
        res.deliveryMode === 'email'
          ? `Sent single-use password reset link to ${target.email}.`
          : `Generated single-use password reset link for ${target.email}.`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to generate password reset link.'
      );
    } finally {
      setSendingLink(false);
    }
  };

  const handleCopyLink = async () => {
    if (!linkResult?.resetUrl) return;
    try {
      await navigator.clipboard.writeText(linkResult.resetUrl);
      setCopiedLink(true);
      showToast('info', 'Copied one-time reset link to clipboard.');
    } catch {
      // Fallback: user can still highlight and copy input value
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/users/${target.id}/reset-password`, {
        method: 'POST',
        propertyId: contextPropertyId,
        body: { newPassword },
      });
      showToast(
        'success',
        `Password updated and active sessions rotated for ${target.email}.`
      );
      await onSaved();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to reset user password.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Reset Password — ${target.fullName}`}
      subtitle={target.email}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-5">
        {error && <ErrorAlert message={error} />}

        {/* Option 1: Single-Use Recovery Link */}
        <div
          data-testid="admin-reset-link-panel"
          className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 space-y-3 text-xs"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="font-bold text-slate-900 flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 text-indigo-600" />
                Single-Use Password Recovery Link (Recommended)
              </h4>
              <p className="text-slate-600 mt-0.5 leading-relaxed">
                Issues a 60-minute single-use reset link so {target.fullName} sets
                their own password securely without sharing credentials.
              </p>
            </div>
            <button
              type="button"
              data-testid="admin-send-reset-link-btn"
              disabled={sendingLink || !target.isActive}
              onClick={() => void handleSendResetLink()}
              className="shrink-0 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {sendingLink ? 'Issuing Link...' : 'Issue Reset Link'}
            </button>
          </div>

          {!target.isActive && (
            <p className="text-[11px] font-medium text-amber-800">
              Reactivate this account first before issuing a recovery link.
            </p>
          )}

          {linkResult && (
            <div className="rounded-xl border border-indigo-200 bg-white p-3 space-y-2">
              <p className="font-semibold text-emerald-800">
                {linkResult.deliveryMode === 'email'
                  ? `Recovery email dispatched to ${target.email}`
                  : 'One-time recovery link ready to share securely'}
              </p>
              <p className="text-[11px] text-slate-500">
                Expires at{' '}
                {new Date(linkResult.expiresAt).toLocaleString([], {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
                . Previous unused reset links for this user were invalidated.
              </p>
              {linkResult.resetUrl && (
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    readOnly
                    data-testid="admin-generated-reset-url"
                    value={linkResult.resetUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-slate-800"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCopyLink()}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    {copiedLink ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-emerald-600" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        Copy
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Option 2: Direct Temporary Password Override */}
        <form
          onSubmit={handleSubmit}
          className="space-y-4 border-t border-slate-200 pt-4"
        >
          <div>
            <h4 className="text-xs font-bold text-slate-900">
              Or Set Temporary Password Directly
            </h4>
            <p className="text-xs text-slate-600 mt-0.5">
              Immediately updates the password hash and invalidates existing
              sessions and unused reset links for this user.
            </p>
          </div>
          <div>
            <label
              htmlFor="rp-password"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              New Password (min 8 chars) *
            </label>
            <input
              id="rp-password"
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-xl bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {submitting ? 'Resetting...' : 'Reset Password'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
