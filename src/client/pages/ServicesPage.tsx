import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Ban,
  CheckCircle2,
  Clock,
  ConciergeBell,
  Eye,
  FolderKanban,
  Pencil,
  Play,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  SERVICE_BILLING_STATUSES,
  SERVICE_BILLING_STATUS_LABELS,
  SERVICE_CATEGORIES,
  SERVICE_CATEGORY_LABELS,
  SERVICE_PRICING_UNITS,
  SERVICE_PRICING_UNIT_LABELS,
  SERVICE_REQUEST_STATUSES,
  SERVICE_REQUEST_STATUS_LABELS,
  type ServiceCategory,
  type ServicePricingUnit,
} from '@shared/constants';
import { formatMoney, roundCurrency } from '@shared/pricing';
import type {
  EligibleServiceStay,
  Guest,
  InvoiceDetail,
  PaginatedResult,
  Room,
  ServiceCatalogItem,
  ServiceRequestDetail,
  ServiceRequestRecord,
  ServiceRequestsListResponse,
  StaffListResponse,
  StaffProfileRecord,
} from '@shared/types';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import {
  ServiceBillingStatusBadge,
  ServiceRequestStatusBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch } from '../lib/api';

type ServicesTab = 'requests' | 'catalog';

const STARTER_HOTEL_SERVICES: Array<{
  code: string;
  name: string;
  category: ServiceCategory;
  unitPrice: number;
  pricingUnit: ServicePricingUnit;
  description: string;
}> = [
  {
    code: 'SVC-LAUNDRY',
    name: 'Express Garment Laundry & Pressing',
    category: 'laundry',
    unitPrice: 450,
    pricingUnit: 'per_item',
    description: 'Same-day wash, steam press, and hanger return to guest room.',
  },
  {
    code: 'SVC-AIRPORT',
    name: 'Private Airport Sedan Transfer',
    category: 'airport_transfer',
    unitPrice: 1800,
    pricingUnit: 'per_request',
    description: 'Chauffeured AC sedan pickup or drop-off with flight tracking.',
  },
  {
    code: 'SVC-SPA-60',
    name: 'Ayurvedic Abhyanga Spa Therapy (60 min)',
    category: 'spa_wellness',
    unitPrice: 2800,
    pricingUnit: 'per_person',
    description: 'Traditional warm herbal oil relaxation massage at the wellness suite.',
  },
  {
    code: 'SVC-EXTRABED',
    name: 'Rollaway Extra Bed & Linen Setup',
    category: 'housekeeping_extra',
    unitPrice: 1200,
    pricingUnit: 'per_day',
    description: 'Orthopedic rollaway bed with full duvet and pillow set.',
  },
];

export function ServicesPage() {
  const { user, selectedProperty } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const isAdmin = user?.role === 'admin';
  const rawTab = searchParams.get('tab') as ServicesTab | null;
  const activeTab: ServicesTab =
    rawTab && ['requests', 'catalog'].includes(rawTab) ? rawTab : 'requests';

  const setActiveTab = (tab: ServicesTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  // Master data
  const [catalogItems, setCatalogItems] = useState<ServiceCatalogItem[]>([]);
  const [eligibleStays, setEligibleStays] = useState<EligibleServiceStay[]>([]);
  const [activeStaff, setActiveStaff] = useState<StaffProfileRecord[]>([]);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);

  // Requests state & filters
  const [requestsData, setRequestsData] =
    useState<ServiceRequestsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [billingFilter, setBillingFilter] = useState<string>('');
  const [staffFilter, setStaffFilter] = useState<string>('');
  const [searchInput, setSearchInput] = useState<string>('');
  const [appliedSearch, setAppliedSearch] = useState<string>('');
  const [page, setPage] = useState<number>(1);

  // Catalog filters
  const [catalogIncludeInactive, setCatalogIncludeInactive] =
    useState<boolean>(true);
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState<string>('');
  const [catalogSearch, setCatalogSearch] = useState<string>('');
  const [seedingStarter, setSeedingStarter] = useState<boolean>(false);

  // Modals
  const [catalogModalOpen, setCatalogModalOpen] = useState(false);
  const [editingCatalogItem, setEditingCatalogItem] =
    useState<ServiceCatalogItem | null>(null);
  const [toggleActiveTarget, setToggleActiveTarget] =
    useState<ServiceCatalogItem | null>(null);
  const [togglingCatalogActive, setTogglingCatalogActive] = useState(false);

  const [newRequestOpen, setNewRequestOpen] = useState(false);
  const [editRequestTarget, setEditRequestTarget] =
    useState<ServiceRequestRecord | null>(null);
  const [detailTargetId, setDetailTargetId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<ServiceRequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [transitionTarget, setTransitionTarget] = useState<{
    record: ServiceRequestRecord;
    nextStatus: 'in_progress' | 'completed';
  } | null>(null);
  const [transitionStaffId, setTransitionStaffId] = useState<string>('');
  const [transitionNote, setTransitionNote] = useState<string>('');
  const [transitionSubmitting, setTransitionSubmitting] = useState(false);

  const [cancelTarget, setCancelTarget] =
    useState<ServiceRequestRecord | null>(null);
  const [cancelReason, setCancelReason] = useState<string>('');
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [postInvoiceTarget, setPostInvoiceTarget] =
    useState<ServiceRequestRecord | null>(null);
  const [postInvoiceNote, setPostInvoiceNote] = useState<string>('');
  const [postInvoiceSubmitting, setPostInvoiceSubmitting] = useState(false);
  const [postInvoiceError, setPostInvoiceError] = useState<string | null>(null);

  const loadReferenceData = useCallback(async () => {
    if (!selectedProperty) return;
    try {
      const [catRes, staysRes, staffRes, guestsRes, roomsRes] = await Promise.all([
        apiFetch<{ items: ServiceCatalogItem[] }>(
          `/api/services/catalog?includeInactive=${catalogIncludeInactive ? 'true' : 'false'}${
            catalogCategoryFilter
              ? `&category=${encodeURIComponent(catalogCategoryFilter)}`
              : ''
          }${
            catalogSearch.trim()
              ? `&search=${encodeURIComponent(catalogSearch.trim())}`
              : ''
          }`,
          { propertyId: selectedProperty.id }
        ),
        apiFetch<{ items: EligibleServiceStay[] }>('/api/services/eligible-stays', {
          propertyId: selectedProperty.id,
        }),
        apiFetch<StaffListResponse>('/api/staff?employmentStatus=active', {
          propertyId: selectedProperty.id,
        }),
        apiFetch<PaginatedResult<Guest>>('/api/guests?pageSize=100', {
          propertyId: selectedProperty.id,
        }),
        apiFetch<{ items: Room[] }>('/api/rooms', {
          propertyId: selectedProperty.id,
        }),
      ]);

      setCatalogItems(catRes.items);
      setEligibleStays(staysRes.items);
      setActiveStaff(staffRes.items);
      setGuests(guestsRes.items);
      setRooms(roomsRes.items.filter((r) => r.isActive));
    } catch {
      // Handled by main loader if API unavailable
    }
  }, [
    selectedProperty,
    catalogIncludeInactive,
    catalogCategoryFilter,
    catalogSearch,
  ]);

  const loadRequests = useCallback(async () => {
    if (!selectedProperty) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', '25');
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (billingFilter) params.set('billingStatus', billingFilter);
      if (staffFilter) params.set('assignedStaffId', staffFilter);
      if (appliedSearch) params.set('search', appliedSearch);

      const res = await apiFetch<ServiceRequestsListResponse>(
        `/api/services/requests?${params.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setRequestsData(res);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load hotel service requests.'
      );
    } finally {
      setLoading(false);
    }
  }, [
    selectedProperty,
    page,
    statusFilter,
    categoryFilter,
    billingFilter,
    staffFilter,
    appliedSearch,
  ]);

  useEffect(() => {
    void loadReferenceData();
  }, [loadReferenceData]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  useEffect(() => {
    if (!detailTargetId || !selectedProperty) {
      setDetailData(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    apiFetch<{ serviceRequest: ServiceRequestDetail }>(
      `/api/services/requests/${detailTargetId}`,
      { propertyId: selectedProperty.id }
    )
      .then((res) => {
        if (active) setDetailData(res.serviceRequest);
      })
      .catch((err) => {
        if (active) {
          showToast(
            'error',
            err instanceof Error
              ? err.message
              : 'Failed to load service request details.'
          );
          setDetailTargetId(null);
        }
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [detailTargetId, selectedProperty, showToast]);

  const activeCatalogServices = useMemo(
    () => catalogItems.filter((s) => s.isActive),
    [catalogItems]
  );

  if (!selectedProperty) return null;

  const currency = selectedProperty.currency;
  const summary = requestsData?.summary;

  const handleSeedStarterCatalog = async () => {
    if (!isAdmin) return;
    setSeedingStarter(true);
    try {
      const existingCodes = new Set(catalogItems.map((c) => c.code.toUpperCase()));
      let createdCount = 0;
      for (const item of STARTER_HOTEL_SERVICES) {
        if (existingCodes.has(item.code)) continue;
        await apiFetch('/api/services/catalog', {
          method: 'POST',
          propertyId: selectedProperty.id,
          body: {
            ...item,
            usePropertyTaxRate: true,
            taxRate: selectedProperty.defaultTaxRate,
            isActive: true,
          },
        });
        createdCount += 1;
      }
      await Promise.all([loadReferenceData(), loadRequests()]);
      showToast(
        'success',
        createdCount > 0
          ? `Added ${createdCount} starter hotel services.`
          : 'Starter hotel services are already configured.'
      );
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Failed to create starter services.'
      );
    } finally {
      setSeedingStarter(false);
    }
  };

  const handleConfirmToggleCatalogActive = async () => {
    if (!toggleActiveTarget) return;
    setTogglingCatalogActive(true);
    try {
      const nextActive = !toggleActiveTarget.isActive;
      await apiFetch(`/api/services/catalog/${toggleActiveTarget.id}`, {
        method: 'PUT',
        propertyId: selectedProperty.id,
        body: { isActive: nextActive },
      });
      showToast(
        'success',
        `Service "${toggleActiveTarget.name}" ${
          nextActive ? 'activated' : 'deactivated'
        }.`
      );
      setToggleActiveTarget(null);
      await Promise.all([loadReferenceData(), loadRequests()]);
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Failed to update service status.'
      );
    } finally {
      setTogglingCatalogActive(false);
    }
  };

  const handleSubmitTransition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transitionTarget) return;
    setTransitionSubmitting(true);
    try {
      await apiFetch(`/api/services/requests/${transitionTarget.record.id}/status`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: {
          status: transitionTarget.nextStatus,
          assignedStaffId: transitionStaffId || null,
          note: transitionNote.trim(),
        },
      });
      showToast(
        'success',
        `Request ${transitionTarget.record.requestNumber} marked ${
          transitionTarget.nextStatus === 'in_progress'
            ? 'In Progress'
            : 'Completed'
        }.`
      );
      setTransitionTarget(null);
      setTransitionNote('');
      await Promise.all([loadRequests(), loadReferenceData()]);
    } catch (err) {
      showToast(
        'error',
        err instanceof Error
          ? err.message
          : 'Failed to update service request status.'
      );
    } finally {
      setTransitionSubmitting(false);
    }
  };

  const handleSubmitCancel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelTarget) return;
    setCancelError(null);
    setCancelSubmitting(true);
    try {
      await apiFetch(`/api/services/requests/${cancelTarget.id}/cancel`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: { reason: cancelReason.trim() },
      });
      showToast(
        'success',
        `Cancelled service request ${cancelTarget.requestNumber}.`
      );
      setCancelTarget(null);
      setCancelReason('');
      await Promise.all([loadRequests(), loadReferenceData()]);
    } catch (err) {
      setCancelError(
        err instanceof Error ? err.message : 'Failed to cancel service request.'
      );
    } finally {
      setCancelSubmitting(false);
    }
  };

  const handleSubmitPostToInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!postInvoiceTarget) return;
    setPostInvoiceError(null);
    setPostInvoiceSubmitting(true);
    try {
      const res = await apiFetch<{
        serviceRequest: ServiceRequestDetail;
        invoice: InvoiceDetail;
      }>(`/api/services/requests/${postInvoiceTarget.id}/post-to-invoice`, {
        method: 'POST',
        propertyId: selectedProperty.id,
        body: {
          createDraftInvoiceIfMissing: true,
          note: postInvoiceNote.trim(),
          idempotencyKey: `ui-post-svc-${postInvoiceTarget.id}`,
        },
      });
      showToast(
        'success',
        `Posted ${formatMoney(
          postInvoiceTarget.totalAmount,
          currency
        )} to Invoice ${res.invoice.invoiceNumber}.`
      );
      setPostInvoiceTarget(null);
      setPostInvoiceNote('');
      await loadRequests();
    } catch (err) {
      setPostInvoiceError(
        err instanceof Error
          ? err.message
          : 'Failed to post service charge to guest invoice.'
      );
    } finally {
      setPostInvoiceSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
            <ConciergeBell className="h-6 w-6 text-indigo-600" />
            Hotel Services & Guest Requests
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Property-scoped service catalog, guest request fulfillment workflow, and
            verified folio charge posting for {selectedProperty.name}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void Promise.all([loadReferenceData(), loadRequests()])}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>

          {isAdmin && (
            <button
              type="button"
              onClick={() => {
                setEditingCatalogItem(null);
                setCatalogModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
            >
              <FolderKanban className="h-4 w-4" />
              New Service Item
            </button>
          )}

          <button
            type="button"
            onClick={() => setNewRequestOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            New Service Request
          </button>
        </div>
      </div>

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Requested Queue</span>
            <Clock className="h-4 w-4 text-amber-500" />
          </div>
          <p
            data-testid="services-kpi-requested"
            className="mt-2 text-2xl font-bold text-slate-900"
          >
            {summary?.requestedCount ?? 0}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">Awaiting start</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>In Progress</span>
            <Play className="h-4 w-4 text-violet-600" />
          </div>
          <p
            data-testid="services-kpi-in-progress"
            className="mt-2 text-2xl font-bold text-slate-900"
          >
            {summary?.inProgressCount ?? 0}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">Active fulfillment</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Completed Today</span>
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          </div>
          <p
            data-testid="services-kpi-completed-today"
            className="mt-2 text-2xl font-bold text-slate-900"
          >
            {summary?.completedTodayCount ?? 0}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {summary?.activeCatalogCount ?? 0} active catalog items
          </p>
        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-semibold text-amber-800">
            <span>Unbilled Completed</span>
            <Receipt className="h-4 w-4 text-amber-600" />
          </div>
          <p
            data-testid="services-kpi-unbilled"
            className="mt-2 text-xl font-bold text-amber-950"
          >
            {formatMoney(summary?.unbilledCompletedAmount ?? 0, currency)}
          </p>
          <p className="text-[11px] text-amber-800/80 mt-0.5">
            {summary?.unbilledCompletedCount ?? 0} ready for folio posting
          </p>
        </div>

        <div className="col-span-2 lg:col-span-1 rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 shadow-xs">
          <div className="flex items-center justify-between text-xs font-semibold text-emerald-800">
            <span>Posted to Folios</span>
            <Receipt className="h-4 w-4 text-emerald-600" />
          </div>
          <p
            data-testid="services-kpi-posted"
            className="mt-2 text-xl font-bold text-emerald-950"
          >
            {formatMoney(summary?.postedAmountTotal ?? 0, currency)}
          </p>
          <p className="text-[11px] text-emerald-800/80 mt-0.5">
            Billed on guest invoices
          </p>
        </div>
      </div>

      {/* Sub-Navigation Tabs */}
      <div className="border-b border-slate-200 flex items-center gap-6">
        <button
          type="button"
          onClick={() => setActiveTab('requests')}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === 'requests'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          Service Requests ({requestsData?.total ?? 0})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('catalog')}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === 'catalog'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          Service Catalog ({catalogItems.length})
        </button>
      </div>

      {error && <ErrorAlert message={error} onRetry={() => void loadRequests()} />}

      {/* TAB 1: SERVICE REQUESTS */}
      {activeTab === 'requests' && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {(['all', ...SERVICE_REQUEST_STATUSES] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => {
                    setStatusFilter(st);
                    setPage(1);
                  }}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                    statusFilter === st
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {st === 'all'
                    ? 'All Requests'
                    : SERVICE_REQUEST_STATUS_LABELS[st]}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setAppliedSearch(searchInput.trim());
                  setPage(1);
                }}
                className="lg:col-span-2 flex gap-2"
              >
                <div className="relative flex-1">
                  <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Search request #, service, guest, room, booking..."
                    className="w-full rounded-xl border border-slate-200 pl-9 pr-8 py-2 text-xs sm:text-sm focus:border-indigo-500 focus:outline-none"
                  />
                  {searchInput && (
                    <button
                      type="button"
                      aria-label="Clear search"
                      onClick={() => {
                        setSearchInput('');
                        setAppliedSearch('');
                        setPage(1);
                      }}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <button
                  type="submit"
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Search
                </button>
              </form>

              <select
                aria-label="Filter by service category"
                value={categoryFilter}
                onChange={(e) => {
                  setCategoryFilter(e.target.value);
                  setPage(1);
                }}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs sm:text-sm text-slate-700"
              >
                <option value="">All Categories</option>
                {SERVICE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SERVICE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter by billing status"
                value={billingFilter}
                onChange={(e) => {
                  setBillingFilter(e.target.value);
                  setPage(1);
                }}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs sm:text-sm text-slate-700"
              >
                <option value="">All Billing States</option>
                {SERVICE_BILLING_STATUSES.map((b) => (
                  <option key={b} value={b}>
                    {SERVICE_BILLING_STATUS_LABELS[b]}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter by assigned staff"
                value={staffFilter}
                onChange={(e) => {
                  setStaffFilter(e.target.value);
                  setPage(1);
                }}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs sm:text-sm text-slate-700"
              >
                <option value="">All Staff Assignments</option>
                <option value="unassigned">Unassigned Only</option>
                {activeStaff.map((sp) => (
                  <option key={sp.id} value={sp.id}>
                    {sp.fullName} ({sp.employeeCode})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Requests Table */}
          {loading ? (
            <LoadingState label="Loading hotel service requests..." />
          ) : !requestsData || requestsData.items.length === 0 ? (
            <EmptyState
              title="No service requests found"
              description={
                activeCatalogServices.length === 0
                  ? 'Configure hotel services in the Service Catalog first, then record guest service requests.'
                  : 'Record laundry, airport transfers, spa sessions, or concierge requests for in-house or arriving guests.'
              }
              action={
                activeCatalogServices.length === 0 && isAdmin ? (
                  <button
                    type="button"
                    disabled={seedingStarter}
                    onClick={() => void handleSeedStarterCatalog()}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    <Sparkles className="h-4 w-4" />
                    {seedingStarter
                      ? 'Creating Starter Services...'
                      : 'Add Starter Hotel Services'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setNewRequestOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                  >
                    <Plus className="h-4 w-4" />
                    New Service Request
                  </button>
                )
              }
            />
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Request</th>
                      <th className="px-4 py-3">Guest / Stay</th>
                      <th className="px-4 py-3">Assigned Staff</th>
                      <th className="px-4 py-3 text-right">Qty & Total</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Folio Billing</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {requestsData.items.map((req) => {
                      const canPostToInvoice =
                        req.status === 'completed' &&
                        req.billingStatus === 'unbilled' &&
                        Boolean(req.reservationId) &&
                        req.totalAmount > 0;

                      return (
                        <tr
                          key={req.id}
                          data-testid={`service-request-row-${req.requestNumber}`}
                          className="hover:bg-slate-50/70"
                        >
                          <td className="px-4 py-3.5">
                            <div className="font-semibold text-slate-900">
                              {req.serviceNameSnapshot}
                            </div>
                            <div className="text-xs text-slate-500 flex flex-wrap items-center gap-1.5 mt-0.5">
                              <span className="font-mono font-medium text-indigo-700">
                                {req.requestNumber}
                              </span>
                              <span>•</span>
                              <span>
                                {SERVICE_CATEGORY_LABELS[req.categorySnapshot] ??
                                  req.categorySnapshot}
                              </span>
                            </div>
                          </td>

                          <td className="px-4 py-3.5">
                            <div className="font-medium text-slate-900">
                              {req.guestName ?? 'Guest'}
                            </div>
                            <div className="text-xs text-slate-500 flex flex-wrap items-center gap-1.5 mt-0.5">
                              {req.roomNumber && (
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
                                  Room {req.roomNumber}
                                </span>
                              )}
                              {req.reservationId && req.bookingReference && (
                                <Link
                                  to={`/reservations/${req.reservationId}`}
                                  className="text-indigo-600 hover:underline font-mono"
                                >
                                  {req.bookingReference}
                                </Link>
                              )}
                            </div>
                          </td>

                          <td className="px-4 py-3.5 text-xs">
                            {req.assignedStaffName ? (
                              <div>
                                <span className="font-medium text-slate-800">
                                  {req.assignedStaffName}
                                </span>
                                {req.assignedStaffEmploymentStatus === 'inactive' && (
                                  <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                                    Inactive
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-400 italic">Unassigned</span>
                            )}
                          </td>

                          <td className="px-4 py-3.5 text-right">
                            <div className="font-semibold text-slate-900">
                              {formatMoney(req.totalAmount, req.currency)}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {req.quantity} × {formatMoney(req.unitPrice, req.currency)}
                              {req.taxAmount > 0 ? ` (+${req.taxRate}% tax)` : ''}
                            </div>
                          </td>

                          <td className="px-4 py-3.5">
                            <ServiceRequestStatusBadge status={req.status} />
                          </td>

                          <td className="px-4 py-3.5">
                            <div className="flex flex-col items-start gap-1">
                              <ServiceBillingStatusBadge status={req.billingStatus} />
                              {req.postedInvoiceId && req.postedInvoiceNumber && (
                                <Link
                                  to={`/invoices/${req.postedInvoiceId}`}
                                  className="text-[11px] font-mono font-semibold text-indigo-600 hover:underline"
                                >
                                  {req.postedInvoiceNumber}
                                </Link>
                              )}
                            </div>
                          </td>

                          <td className="px-4 py-3.5">
                            <div className="flex items-center justify-end gap-1.5 flex-wrap">
                              {req.status === 'requested' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTransitionTarget({
                                      record: req,
                                      nextStatus: 'in_progress',
                                    });
                                    setTransitionStaffId(req.assignedStaffId ?? '');
                                    setTransitionNote('');
                                  }}
                                  className="rounded-lg bg-violet-50 border border-violet-200 px-2.5 py-1 text-xs font-semibold text-violet-800 hover:bg-violet-100"
                                >
                                  Start
                                </button>
                              )}

                              {req.status === 'in_progress' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTransitionTarget({
                                      record: req,
                                      nextStatus: 'completed',
                                    });
                                    setTransitionStaffId(req.assignedStaffId ?? '');
                                    setTransitionNote('');
                                  }}
                                  className="rounded-lg bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                                >
                                  Complete
                                </button>
                              )}

                              {canPostToInvoice && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPostInvoiceTarget(req);
                                    setPostInvoiceNote('');
                                    setPostInvoiceError(null);
                                  }}
                                  className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
                                >
                                  Post to Folio
                                </button>
                              )}

                              {(req.status === 'requested' ||
                                req.status === 'in_progress') && (
                                <>
                                  <button
                                    type="button"
                                    aria-label={`Edit ${req.requestNumber}`}
                                    onClick={() => setEditRequestTarget(req)}
                                    className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Cancel ${req.requestNumber}`}
                                    onClick={() => {
                                      setCancelTarget(req);
                                      setCancelReason('');
                                      setCancelError(null);
                                    }}
                                    className="rounded-lg border border-rose-200 p-1.5 text-rose-600 hover:bg-rose-50"
                                  >
                                    <Ban className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}

                              <button
                                type="button"
                                aria-label={`View ${req.requestNumber}`}
                                onClick={() => setDetailTargetId(req.id)}
                                className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100"
                              >
                                <Eye className="h-3.5 w-3.5" />
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
        </div>
      )}

      {/* TAB 2: SERVICE CATALOG */}
      {activeTab === 'catalog' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 flex-1">
              <div className="relative min-w-[220px] flex-1 max-w-sm">
                <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={catalogSearch}
                  onChange={(e) => setCatalogSearch(e.target.value)}
                  placeholder="Filter catalog by name or code..."
                  className="w-full rounded-xl border border-slate-200 pl-9 pr-3 py-2 text-xs sm:text-sm"
                />
              </div>

              <select
                aria-label="Filter catalog category"
                value={catalogCategoryFilter}
                onChange={(e) => setCatalogCategoryFilter(e.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs sm:text-sm"
              >
                <option value="">All Categories</option>
                {SERVICE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SERVICE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>

              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={catalogIncludeInactive}
                  onChange={(e) => setCatalogIncludeInactive(e.target.checked)}
                  className="rounded border-slate-300 text-indigo-600"
                />
                Include inactive services
              </label>
            </div>

            {isAdmin && (
              <div className="flex items-center gap-2">
                {catalogItems.length === 0 && (
                  <button
                    type="button"
                    disabled={seedingStarter}
                    onClick={() => void handleSeedStarterCatalog()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Seed Starter Catalog
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setEditingCatalogItem(null);
                    setCatalogModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                >
                  <Plus className="h-4 w-4" />
                  Add Service
                </button>
              </div>
            )}
          </div>

          {catalogItems.length === 0 ? (
            <EmptyState
              title="No hotel services configured"
              description="Define property services such as laundry, airport transfers, spa treatments, and extra beds."
              action={
                isAdmin ? (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingCatalogItem(null);
                      setCatalogModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                  >
                    <Plus className="h-4 w-4" />
                    Create First Service
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Code & Service</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3 text-right">Price & Unit</th>
                      <th className="px-4 py-3">Tax Config</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Requests</th>
                      {isAdmin && <th className="px-4 py-3 text-right">Manage</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {catalogItems.map((svc) => (
                      <tr
                        key={svc.id}
                        data-testid={`service-catalog-row-${svc.code}`}
                        className="hover:bg-slate-50/70"
                      >
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700">
                              {svc.code}
                            </span>
                            <span className="font-semibold text-slate-900">
                              {svc.name}
                            </span>
                          </div>
                          {svc.description && (
                            <p className="text-xs text-slate-500 mt-1 line-clamp-1">
                              {svc.description}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-xs font-medium text-slate-700">
                          {SERVICE_CATEGORY_LABELS[svc.category] ?? svc.category}
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <div className="font-semibold text-slate-900">
                            {formatMoney(svc.unitPrice, currency)}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {SERVICE_PRICING_UNIT_LABELS[svc.pricingUnit]}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-xs text-slate-600">
                          {svc.effectiveTaxRate}% {selectedProperty.taxName}{' '}
                          <span className="text-slate-400">
                            ({svc.usePropertyTaxRate ? 'Property default' : 'Custom'})
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          {svc.isActive ? (
                            <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                              Inactive
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-right text-xs text-slate-600">
                          {svc.totalRequestsCount} total
                          {svc.openRequestsCount > 0 && (
                            <span className="ml-1 text-amber-700 font-semibold">
                              ({svc.openRequestsCount} open)
                            </span>
                          )}
                        </td>
                        {isAdmin && (
                          <td className="px-4 py-3.5 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCatalogItem(svc);
                                  setCatalogModalOpen(true);
                                }}
                                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => setToggleActiveTarget(svc)}
                                className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                                  svc.isActive
                                    ? 'border-rose-200 text-rose-700 hover:bg-rose-50'
                                    : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                                }`}
                              >
                                {svc.isActive ? 'Deactivate' : 'Activate'}
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
      )}

      {/* Catalog Create/Edit Modal */}
      {catalogModalOpen && (
        <ServiceCatalogModal
          open={catalogModalOpen}
          onClose={() => {
            setCatalogModalOpen(false);
            setEditingCatalogItem(null);
          }}
          propertyId={selectedProperty.id}
          currency={currency}
          propertyTaxName={selectedProperty.taxName}
          propertyDefaultTaxRate={selectedProperty.defaultTaxRate}
          editing={editingCatalogItem}
          onSaved={async () => {
            setCatalogModalOpen(false);
            setEditingCatalogItem(null);
            await Promise.all([loadReferenceData(), loadRequests()]);
          }}
        />
      )}

      {/* Catalog Activate/Deactivate Confirmation */}
      {toggleActiveTarget && (
        <ConfirmDialog
          open={Boolean(toggleActiveTarget)}
          onClose={() => setToggleActiveTarget(null)}
          onConfirm={handleConfirmToggleCatalogActive}
          isSubmitting={togglingCatalogActive}
          variant={toggleActiveTarget.isActive ? 'danger' : 'primary'}
          title={
            toggleActiveTarget.isActive
              ? `Deactivate "${toggleActiveTarget.name}"?`
              : `Activate "${toggleActiveTarget.name}"?`
          }
          description={
            toggleActiveTarget.isActive
              ? 'Deactivated services cannot be selected for new guest service requests, while all historical requests and posted invoice charges remain preserved.'
              : 'Reactivating this service allows staff to record new guest service requests for it.'
          }
          confirmLabel={
            toggleActiveTarget.isActive ? 'Deactivate Service' : 'Activate Service'
          }
        />
      )}

      {/* New Service Request Modal */}
      {newRequestOpen && (
        <ServiceRequestCreateModal
          open={newRequestOpen}
          onClose={() => setNewRequestOpen(false)}
          propertyId={selectedProperty.id}
          currency={currency}
          taxName={selectedProperty.taxName}
          services={activeCatalogServices}
          eligibleStays={eligibleStays}
          guests={guests}
          rooms={rooms}
          activeStaff={activeStaff}
          onCreated={async () => {
            setNewRequestOpen(false);
            await Promise.all([loadRequests(), loadReferenceData()]);
          }}
        />
      )}

      {/* Edit Service Request Modal */}
      {editRequestTarget && (
        <ServiceRequestEditModal
          open={Boolean(editRequestTarget)}
          onClose={() => setEditRequestTarget(null)}
          propertyId={selectedProperty.id}
          currency={currency}
          record={editRequestTarget}
          activeStaff={activeStaff}
          onSaved={async () => {
            setEditRequestTarget(null);
            await Promise.all([loadRequests(), loadReferenceData()]);
          }}
        />
      )}

      {/* Status Transition Modal (Start / Complete) */}
      {transitionTarget && (
        <Modal
          open={Boolean(transitionTarget)}
          onClose={() => setTransitionTarget(null)}
          title={
            transitionTarget.nextStatus === 'in_progress'
              ? `Start Service — ${transitionTarget.record.requestNumber}`
              : `Complete Service — ${transitionTarget.record.requestNumber}`
          }
          subtitle={transitionTarget.record.serviceNameSnapshot}
          maxWidthClass="max-w-md"
        >
          <form onSubmit={handleSubmitTransition} className="space-y-4">
            <div>
              <label
                htmlFor="svc-trans-staff"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Assigned Staff Member
              </label>
              <select
                id="svc-trans-staff"
                value={transitionStaffId}
                onChange={(e) => setTransitionStaffId(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Unassigned</option>
                {activeStaff.map((sp) => (
                  <option key={sp.id} value={sp.id}>
                    {sp.fullName} — {sp.jobTitle} ({sp.employeeCode})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="svc-trans-note"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Fulfillment Note (Optional)
              </label>
              <textarea
                id="svc-trans-note"
                rows={2}
                value={transitionNote}
                onChange={(e) => setTransitionNote(e.target.value)}
                placeholder="Record pickup time, therapist room, or delivery confirmation..."
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setTransitionTarget(null)}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={transitionSubmitting}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {transitionSubmitting
                  ? 'Saving...'
                  : transitionTarget.nextStatus === 'in_progress'
                    ? 'Mark In Progress'
                    : 'Mark Completed'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Cancel Service Request Modal */}
      {cancelTarget && (
        <Modal
          open={Boolean(cancelTarget)}
          onClose={() => setCancelTarget(null)}
          title={`Cancel Request ${cancelTarget.requestNumber}`}
          subtitle={cancelTarget.serviceNameSnapshot}
          maxWidthClass="max-w-md"
        >
          <form onSubmit={handleSubmitCancel} className="space-y-4">
            {cancelError && <ErrorAlert message={cancelError} />}
            <p className="text-xs text-slate-600">
              Cancelling stops fulfillment and marks this request non-billable while
              retaining append-only audit history.
            </p>
            <div>
              <label
                htmlFor="svc-cancel-reason"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Cancellation Reason *
              </label>
              <textarea
                id="svc-cancel-reason"
                required
                minLength={3}
                rows={3}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="e.g. Guest rescheduled flight pickup"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setCancelTarget(null)}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
              >
                Keep Request
              </button>
              <button
                type="submit"
                disabled={cancelSubmitting}
                className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {cancelSubmitting ? 'Cancelling...' : 'Confirm Cancellation'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Post Completed Charge to Folio Confirmation Modal */}
      {postInvoiceTarget && (
        <Modal
          open={Boolean(postInvoiceTarget)}
          onClose={() => setPostInvoiceTarget(null)}
          title={`Post Service Charge to Folio`}
          subtitle={`${postInvoiceTarget.requestNumber} • ${postInvoiceTarget.serviceNameSnapshot}`}
          maxWidthClass="max-w-md"
        >
          <form onSubmit={handleSubmitPostToInvoice} className="space-y-4">
            {postInvoiceError && <ErrorAlert message={postInvoiceError} />}

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-500">Reservation</span>
                <span className="font-mono font-semibold text-slate-900">
                  {postInvoiceTarget.bookingReference}
                  {postInvoiceTarget.roomNumber
                    ? ` (Room ${postInvoiceTarget.roomNumber})`
                    : ''}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Guest</span>
                <span className="font-medium text-slate-900">
                  {postInvoiceTarget.guestName}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Subtotal</span>
                <span>
                  {formatMoney(
                    postInvoiceTarget.subtotal,
                    postInvoiceTarget.currency
                  )}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">
                  {postInvoiceTarget.taxName} ({postInvoiceTarget.taxRate}%)
                </span>
                <span>
                  {formatMoney(
                    postInvoiceTarget.taxAmount,
                    postInvoiceTarget.currency
                  )}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1.5 font-bold text-slate-900 text-sm">
                <span>Total Folio Charge</span>
                <span>
                  {formatMoney(
                    postInvoiceTarget.totalAmount,
                    postInvoiceTarget.currency
                  )}
                </span>
              </div>
            </div>

            <div>
              <label
                htmlFor="svc-post-note"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Folio Posting Note (Optional)
              </label>
              <input
                id="svc-post-note"
                type="text"
                value={postInvoiceNote}
                onChange={(e) => setPostInvoiceNote(e.target.value)}
                placeholder="Optional billing note on invoice line"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setPostInvoiceTarget(null)}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={postInvoiceSubmitting}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {postInvoiceSubmitting
                  ? 'Posting Charge...'
                  : 'Confirm & Post to Invoice'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Detail & Append-Only Audit History Modal */}
      {detailTargetId && (
        <Modal
          open={Boolean(detailTargetId)}
          onClose={() => setDetailTargetId(null)}
          title={
            detailData
              ? `Service Request ${detailData.requestNumber}`
              : 'Service Request Details'
          }
          subtitle={detailData?.serviceNameSnapshot}
          maxWidthClass="max-w-2xl"
        >
          {detailLoading || !detailData ? (
            <LoadingState label="Loading request audit trail..." />
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-xs">
                <div>
                  <span className="text-slate-500 block">Status</span>
                  <div className="mt-1">
                    <ServiceRequestStatusBadge status={detailData.status} />
                  </div>
                </div>
                <div>
                  <span className="text-slate-500 block">Billing Status</span>
                  <div className="mt-1">
                    <ServiceBillingStatusBadge status={detailData.billingStatus} />
                  </div>
                </div>
                <div>
                  <span className="text-slate-500 block">Total Amount</span>
                  <p className="font-bold text-slate-900 text-sm mt-1">
                    {formatMoney(detailData.totalAmount, detailData.currency)}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500 block">Guest / Room</span>
                  <p className="font-semibold text-slate-900 mt-0.5">
                    {detailData.guestName ?? '—'}
                    {detailData.roomNumber ? ` • Room ${detailData.roomNumber}` : ''}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500 block">Assigned Staff</span>
                  <p className="font-semibold text-slate-900 mt-0.5">
                    {detailData.assignedStaffName ?? 'Unassigned'}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500 block">Requested Time</span>
                  <p className="font-medium text-slate-800 mt-0.5">
                    {new Date(detailData.requestedFor).toLocaleString()}
                  </p>
                </div>
              </div>

              {detailData.notes && (
                <div className="rounded-xl border border-slate-200 p-3 text-xs">
                  <span className="font-semibold text-slate-700 block mb-1">
                    Request Notes
                  </span>
                  <p className="text-slate-600">{detailData.notes}</p>
                </div>
              )}

              {detailData.cancelReason && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
                  <span className="font-semibold block mb-0.5">
                    Cancellation Reason
                  </span>
                  {detailData.cancelReason}
                </div>
              )}

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2.5">
                  Lifecycle & Billing History ({detailData.history.length})
                </h3>
                <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                  {detailData.history.map((h) => (
                    <div
                      key={h.id}
                      className="px-3.5 py-2.5 text-xs flex items-start justify-between gap-3"
                    >
                      <div>
                        <p className="font-semibold text-slate-900">
                          {h.action.replace(/_/g, ' ').toUpperCase()}
                          {h.toStatus ? ` (${h.toStatus})` : ''}
                        </p>
                        {h.note && <p className="text-slate-600 mt-0.5">{h.note}</p>}
                        {h.actorName && (
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            By {h.actorName}
                          </p>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-400 shrink-0">
                        {new Date(h.createdAt).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function ServiceCatalogModal({
  open,
  onClose,
  propertyId,
  currency,
  propertyTaxName,
  propertyDefaultTaxRate,
  editing,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  currency: string;
  propertyTaxName: string;
  propertyDefaultTaxRate: number;
  editing: ServiceCatalogItem | null;
  onSaved: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [code, setCode] = useState(editing?.code ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [category, setCategory] = useState<ServiceCategory>(
    editing?.category ?? 'laundry'
  );
  const [pricingUnit, setPricingUnit] = useState<ServicePricingUnit>(
    editing?.pricingUnit ?? 'per_request'
  );
  const [unitPrice, setUnitPrice] = useState(
    editing ? String(editing.unitPrice) : ''
  );
  const [usePropertyTaxRate, setUsePropertyTaxRate] = useState(
    editing ? editing.usePropertyTaxRate : true
  );
  const [taxRate, setTaxRate] = useState(
    editing ? String(editing.taxRate) : String(propertyDefaultTaxRate)
  );
  const [description, setDescription] = useState(editing?.description ?? '');
  const [isActive, setIsActive] = useState(editing ? editing.isActive : true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        category,
        pricingUnit,
        unitPrice: Number(unitPrice),
        usePropertyTaxRate,
        taxRate: usePropertyTaxRate ? propertyDefaultTaxRate : Number(taxRate),
        description: description.trim(),
        isActive,
      };

      if (editing) {
        await apiFetch(`/api/services/catalog/${editing.id}`, {
          method: 'PUT',
          propertyId,
          body: payload,
        });
        showToast('success', `Updated service "${name.trim()}".`);
      } else {
        await apiFetch('/api/services/catalog', {
          method: 'POST',
          propertyId,
          body: payload,
        });
        showToast('success', `Created service "${name.trim()}".`);
      }
      await onSaved();
    } catch (err) {
      setError(
        err instanceof ApiClientError || err instanceof Error
          ? err.message
          : 'Failed to save service catalog item.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit Service — ${editing.code}` : 'New Hotel Service'}
      subtitle="Configure property-scoped pricing and applicable tax behavior."
      maxWidthClass="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label
              htmlFor="svc-cat-code"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Service Code *
            </label>
            <input
              id="svc-cat-code"
              type="text"
              required
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="SVC-SPA"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>
          <div className="sm:col-span-2">
            <label
              htmlFor="svc-cat-name"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Service Name *
            </label>
            <input
              id="svc-cat-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Airport Sedan Pickup"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label
              htmlFor="svc-cat-category"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Category *
            </label>
            <select
              id="svc-cat-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as ServiceCategory)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {SERVICE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {SERVICE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="svc-cat-price"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Unit Price ({currency}) *
            </label>
            <input
              id="svc-cat-price"
              type="number"
              required
              min="0"
              step="0.01"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              placeholder="1500"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="svc-cat-unit"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Pricing Unit
            </label>
            <select
              id="svc-cat-unit"
              value={pricingUnit}
              onChange={(e) => setPricingUnit(e.target.value as ServicePricingUnit)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {SERVICE_PRICING_UNITS.map((u) => (
                <option key={u} value={u}>
                  {SERVICE_PRICING_UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-2.5">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={usePropertyTaxRate}
              onChange={(e) => setUsePropertyTaxRate(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600"
            />
            Use property default {propertyTaxName} rate ({propertyDefaultTaxRate}%)
          </label>

          {!usePropertyTaxRate && (
            <div>
              <label
                htmlFor="svc-cat-tax"
                className="block text-xs font-medium text-slate-600 mb-1"
              >
                Custom {propertyTaxName} Rate (%)
              </label>
              <input
                id="svc-cat-tax"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                className="w-40 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
              />
            </div>
          )}
        </div>

        <div>
          <label
            htmlFor="svc-cat-desc"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Description
          </label>
          <textarea
            id="svc-cat-desc"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Operational notes, turnaround hours, or inclusions..."
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="rounded border-slate-300 text-indigo-600"
          />
          Service is active for new guest requests
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
            {submitting
              ? 'Saving...'
              : editing
                ? 'Save Changes'
                : 'Create Service'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ServiceRequestCreateModal({
  open,
  onClose,
  propertyId,
  currency,
  taxName,
  services,
  eligibleStays,
  guests,
  rooms,
  activeStaff,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  currency: string;
  taxName: string;
  services: ServiceCatalogItem[];
  eligibleStays: EligibleServiceStay[];
  guests: Guest[];
  rooms: Room[];
  activeStaff: StaffProfileRecord[];
  onCreated: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [linkMode, setLinkMode] = useState<'stay' | 'guest'>(
    eligibleStays.length > 0 ? 'stay' : 'guest'
  );
  const [serviceId, setServiceId] = useState<string>(services[0]?.id ?? '');
  const [reservationId, setReservationId] = useState<string>(
    eligibleStays[0]?.reservationId ?? ''
  );
  const [guestId, setGuestId] = useState<string>(guests[0]?.id ?? '');
  const [roomId, setRoomId] = useState<string>('');
  const [assignedStaffId, setAssignedStaffId] = useState<string>('');
  const [quantity, setQuantity] = useState<string>('1');
  const [notes, setNotes] = useState<string>('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedService = useMemo(
    () => services.find((s) => s.id === serviceId) ?? null,
    [services, serviceId]
  );

  const qtyNum = Number(quantity) > 0 ? Number(quantity) : 0;
  const subtotal = selectedService
    ? roundCurrency(qtyNum * selectedService.unitPrice)
    : 0;
  const taxAmt = selectedService
    ? roundCurrency((subtotal * selectedService.effectiveTaxRate) / 100)
    : 0;
  const totalAmt = roundCurrency(subtotal + taxAmt);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload =
        linkMode === 'stay'
          ? {
              serviceId,
              reservationId: reservationId || null,
              assignedStaffId: assignedStaffId || null,
              quantity: Number(quantity),
              notes: notes.trim(),
            }
          : {
              serviceId,
              reservationId: null,
              guestId: guestId || null,
              roomId: roomId || null,
              assignedStaffId: assignedStaffId || null,
              quantity: Number(quantity),
              notes: notes.trim(),
            };

      const res = await apiFetch<{ serviceRequest: ServiceRequestDetail }>(
        '/api/services/requests',
        {
          method: 'POST',
          propertyId,
          body: payload,
        }
      );
      showToast(
        'success',
        `Created service request ${res.serviceRequest.requestNumber}.`
      );
      await onCreated();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create service request.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Guest Service Request"
      subtitle="Log a hotel service request and assign operational staff."
      maxWidthClass="max-w-lg"
    >
      {services.length === 0 ? (
        <div className="text-sm text-slate-600 py-4">
          No active services exist in this property’s catalog yet. Ask an
          administrator to add an active service in the Service Catalog tab first.
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <ErrorAlert message={error} />}

          <div>
            <label
              htmlFor="sr-service"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Hotel Service *
            </label>
            <select
              id="sr-service"
              required
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code}) — {formatMoney(s.unitPrice, currency)} /{' '}
                  {SERVICE_PRICING_UNIT_LABELS[s.pricingUnit]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLinkMode('stay')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold border ${
                linkMode === 'stay'
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 bg-white text-slate-600'
              }`}
            >
              Link to Reservation Stay
            </button>
            <button
              type="button"
              onClick={() => setLinkMode('guest')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold border ${
                linkMode === 'guest'
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 bg-white text-slate-600'
              }`}
            >
              Registered Guest (Non-Folio)
            </button>
          </div>

          {linkMode === 'stay' ? (
            <div>
              <label
                htmlFor="sr-stay"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Active Reservation *
              </label>
              <select
                id="sr-stay"
                required
                value={reservationId}
                onChange={(e) => setReservationId(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Select reservation...</option>
                {eligibleStays.map((st) => (
                  <option key={st.reservationId} value={st.reservationId}>
                    {st.roomNumber ? `Room ${st.roomNumber} • ` : ''}
                    {st.guestName} ({st.bookingReference} — {st.status})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="sr-guest"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Guest *
                </label>
                <select
                  id="sr-guest"
                  required
                  value={guestId}
                  onChange={(e) => setGuestId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">Select guest...</option>
                  {guests.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.fullName} ({g.phone})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="sr-room"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Room (Optional)
                </label>
                <select
                  id="sr-room"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">No specific room</option>
                  {rooms.map((rm) => (
                    <option key={rm.id} value={rm.id}>
                      Room {rm.roomNumber} ({rm.roomTypeName})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="sr-qty"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Quantity *
              </label>
              <input
                id="sr-qty"
                type="number"
                required
                min="0.01"
                step="0.01"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="sr-staff"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Assign Staff Member
              </label>
              <select
                id="sr-staff"
                value={assignedStaffId}
                onChange={(e) => setAssignedStaffId(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Assign later</option>
                {activeStaff.map((sp) => (
                  <option key={sp.id} value={sp.id}>
                    {sp.fullName} ({sp.jobTitle})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label
              htmlFor="sr-notes"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Instructions / Notes
            </label>
            <textarea
              id="sr-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Flight number, garment count, preferred timing..."
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          {selectedService && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal</span>
                <span>{formatMoney(subtotal, currency)}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>
                  {taxName} ({selectedService.effectiveTaxRate}%)
                </span>
                <span>{formatMoney(taxAmt, currency)}</span>
              </div>
              <div className="flex justify-between font-bold text-slate-900 pt-1 border-t border-slate-200">
                <span>Estimated Total</span>
                <span>{formatMoney(totalAmt, currency)}</span>
              </div>
            </div>
          )}

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
              {submitting ? 'Creating...' : 'Create Service Request'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function ServiceRequestEditModal({
  open,
  onClose,
  propertyId,
  currency,
  record,
  activeStaff,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  currency: string;
  record: ServiceRequestRecord;
  activeStaff: StaffProfileRecord[];
  onSaved: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [assignedStaffId, setAssignedStaffId] = useState<string>(
    record.assignedStaffId ?? ''
  );
  const [quantity, setQuantity] = useState<string>(String(record.quantity));
  const [notes, setNotes] = useState<string>(record.notes);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/services/requests/${record.id}`, {
        method: 'PUT',
        propertyId,
        body: {
          assignedStaffId: assignedStaffId || null,
          quantity: Number(quantity),
          notes: notes.trim(),
        },
      });
      showToast('success', `Updated ${record.requestNumber}.`);
      await onSaved();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to update service request.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Update Request ${record.requestNumber}`}
      subtitle={`${record.serviceNameSnapshot} (${formatMoney(
        record.unitPrice,
        currency
      )} each)`}
      maxWidthClass="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div>
          <label
            htmlFor="sr-edit-staff"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Assigned Staff
          </label>
          <select
            id="sr-edit-staff"
            value={assignedStaffId}
            onChange={(e) => setAssignedStaffId(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">Unassigned</option>
            {activeStaff.map((sp) => (
              <option key={sp.id} value={sp.id}>
                {sp.fullName} — {sp.jobTitle} ({sp.employeeCode})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="sr-edit-qty"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Quantity
          </label>
          <input
            id="sr-edit-qty"
            type="number"
            required
            min="0.01"
            step="0.01"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="sr-edit-notes"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Notes
          </label>
          <textarea
            id="sr-edit-notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
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
            {submitting ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
