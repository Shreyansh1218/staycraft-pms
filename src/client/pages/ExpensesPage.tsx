import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Ban,
  BarChart3,
  Calendar,
  Eye,
  FolderKanban,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import {
  EXPENSE_PAYMENT_METHODS,
  EXPENSE_PAYMENT_METHOD_LABELS,
} from '@shared/constants';
import { formatDisplayDate, getPropertyLocalDate } from '@shared/dates';
import { formatMoney } from '@shared/pricing';
import type {
  ExpenseCategory,
  ExpenseRecord,
  ExpensesListResponse,
  Supplier,
} from '@shared/types';
import {
  ExpenseCategoryModal,
  ExpenseDetailModal,
  ExpenseFormModal,
  VoidExpenseModal,
} from '../components/expenses/ExpenseModals';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import { ConfirmDialog } from '../components/ui/Modal';
import {
  ExpensePaymentMethodBadge,
  ExpenseStatusBadge,
} from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiFetch } from '../lib/api';

type ExpensesTab = 'expenses' | 'categories';

const STATUS_FILTER_TABS = [
  { key: 'all', label: 'All History' },
  { key: 'recorded', label: 'Recorded (Active)' },
  { key: 'voided', label: 'Voided Only' },
] as const;

const STARTER_HOTEL_EXPENSE_CATEGORIES = [
  {
    code: 'UTILITIES',
    name: 'Electricity, Water & Fuel',
    description: 'Commercial power, backup generator diesel, water supply, and gas bills.',
    displayOrder: 10,
  },
  {
    code: 'MAINTENANCE',
    name: 'Repairs & Facility Maintenance',
    description: 'Plumbing, HVAC servicing, carpentry, electrical repairs, and AMC contracts.',
    displayOrder: 20,
  },
  {
    code: 'LAUNDRY_HK',
    name: 'Housekeeping & Laundry',
    description: 'Outsourced linen laundry, cleaning consumables, and guest room upkeep.',
    displayOrder: 30,
  },
  {
    code: 'FNB_OPS',
    name: 'Kitchen & Restaurant Operations',
    description: 'Direct kitchen fuel, urgent perishables, and dining service supplies.',
    displayOrder: 40,
  },
  {
    code: 'ADMIN_MKTG',
    name: 'Admin, Telecom & Marketing',
    description: 'Internet leased lines, stationery, OTA promotions, and municipal fees.',
    displayOrder: 50,
  },
];

export function ExpensesPage() {
  const { user, selectedProperty } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const isAdmin = user?.role === 'admin';

  const rawTab = searchParams.get('tab') as ExpensesTab | null;
  const activeTab: ExpensesTab =
    rawTab && ['expenses', 'categories'].includes(rawTab) ? rawTab : 'expenses';

  const setActiveTab = (tab: ExpensesTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  // Master reference lists
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [showInactiveCategories, setShowInactiveCategories] = useState(true);
  const [seedingDefaults, setSeedingDefaults] = useState(false);

  // Expenses list & filters
  const [expensesData, setExpensesData] = useState<ExpensesListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);

  // Modal states
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ExpenseCategory | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<ExpenseCategory | null>(null);
  const [deletingCategoryBusy, setDeletingCategoryBusy] = useState(false);

  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<ExpenseRecord | null>(null);
  const [voidingExpense, setVoidingExpense] = useState<ExpenseRecord | null>(null);
  const [viewingExpenseId, setViewingExpenseId] = useState<string | null>(null);

  const loadReferenceData = useCallback(async () => {
    if (!selectedProperty) return;
    const [catRes, supRes] = await Promise.all([
      apiFetch<{ items: ExpenseCategory[] }>(
        `/api/expenses/categories?includeInactive=true`,
        { propertyId: selectedProperty.id }
      ),
      apiFetch<{ items: Supplier[] }>(`/api/suppliers?includeInactive=true`, {
        propertyId: selectedProperty.id,
      }),
    ]);
    setCategories(catRes.items);
    setSuppliers(supRes.items);
  }, [selectedProperty]);

  const loadExpenses = useCallback(async () => {
    if (!selectedProperty) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('pageSize', '25');
      qs.set('status', statusFilter);
      if (categoryFilter) qs.set('categoryId', categoryFilter);
      if (supplierFilter) qs.set('supplierId', supplierFilter);
      if (paymentMethodFilter) qs.set('paymentMethod', paymentMethodFilter);
      if (dateFrom) qs.set('dateFrom', dateFrom);
      if (dateTo) qs.set('dateTo', dateTo);
      if (search.trim()) qs.set('search', search.trim());

      const res = await apiFetch<ExpensesListResponse>(
        `/api/expenses?${qs.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setExpensesData(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [
    selectedProperty,
    page,
    statusFilter,
    categoryFilter,
    supplierFilter,
    paymentMethodFilter,
    dateFrom,
    dateTo,
    search,
  ]);

  const refreshAll = useCallback(async () => {
    if (!selectedProperty) return;
    try {
      await Promise.all([loadReferenceData(), loadExpenses()]);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selectedProperty, loadReferenceData, loadExpenses]);

  useEffect(() => {
    void loadReferenceData().catch((err) => setError((err as Error).message));
  }, [loadReferenceData]);

  useEffect(() => {
    void loadExpenses();
  }, [loadExpenses]);

  if (!selectedProperty) {
    return <LoadingState label="Selecting property..." />;
  }

  const currency = selectedProperty.currency;
  const summary = expensesData?.summary;
  const expenses = expensesData?.items ?? [];
  const activeCategories = categories.filter((c) => c.isActive);
  const displayedCategories = showInactiveCategories
    ? categories
    : activeCategories;

  const hasFilters = Boolean(
    statusFilter !== 'all' ||
      search.trim() ||
      categoryFilter ||
      supplierFilter ||
      paymentMethodFilter ||
      dateFrom ||
      dateTo
  );

  const clearFilters = () => {
    setStatusFilter('all');
    setSearch('');
    setCategoryFilter('');
    setSupplierFilter('');
    setPaymentMethodFilter('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  const applyCurrentMonthRange = () => {
    const today = getPropertyLocalDate(selectedProperty.timezone);
    setDateFrom(`${today.slice(0, 7)}-01`);
    setDateTo(today);
    setPage(1);
  };

  const handleSeedStarterCategories = async () => {
    if (!isAdmin || seedingDefaults) return;
    setSeedingDefaults(true);
    try {
      for (const preset of STARTER_HOTEL_EXPENSE_CATEGORIES) {
        const exists = categories.some(
          (c) =>
            c.code.toUpperCase() === preset.code ||
            c.name.toLowerCase() === preset.name.toLowerCase()
        );
        if (!exists) {
          await apiFetch('/api/expenses/categories', {
            method: 'POST',
            propertyId: selectedProperty.id,
            body: { ...preset, isActive: true },
          });
        }
      }
      showToast('success', 'Added standard hotel expense categories');
      await refreshAll();
    } catch (err) {
      showToast('error', (err as Error).message);
    } finally {
      setSeedingDefaults(false);
    }
  };

  const handleToggleCategoryActive = async (cat: ExpenseCategory) => {
    try {
      await apiFetch(`/api/expenses/categories/${cat.id}`, {
        method: 'PUT',
        propertyId: selectedProperty.id,
        body: { isActive: !cat.isActive },
      });
      showToast(
        'success',
        cat.isActive
          ? `Deactivated "${cat.name}" (historical expenses preserved)`
          : `Reactivated "${cat.name}"`
      );
      await refreshAll();
    } catch (err) {
      showToast('error', (err as Error).message);
    }
  };

  const handleConfirmDeleteCategory = async () => {
    if (!deletingCategory) return;
    setDeletingCategoryBusy(true);
    try {
      await apiFetch(`/api/expenses/categories/${deletingCategory.id}`, {
        method: 'DELETE',
        propertyId: selectedProperty.id,
      });
      showToast('success', `Deleted unused category "${deletingCategory.name}"`);
      setDeletingCategory(null);
      await refreshAll();
    } catch (err) {
      showToast('error', (err as Error).message);
    } finally {
      setDeletingCategoryBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Operating Expenses
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Property-scoped expense vouchers, vendor disbursements, category controls, and
            audit history for{' '}
            <span className="font-medium text-slate-700">{selectedProperty.name}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            to="/reports"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <BarChart3 className="h-4 w-4 text-indigo-600" />
            Financial Reports
          </Link>

          {isAdmin && (
            <button
              type="button"
              onClick={() => {
                setEditingCategory(null);
                setCategoryModalOpen(true);
              }}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <FolderKanban className="h-4 w-4 text-slate-600" />
              New Category
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              if (activeCategories.length === 0) {
                if (isAdmin) {
                  setActiveTab('categories');
                  setEditingCategory(null);
                  setCategoryModalOpen(true);
                } else {
                  showToast(
                    'error',
                    'Ask an administrator to create an active expense category first.'
                  );
                }
                return;
              }
              setEditingExpense(null);
              setExpenseModalOpen(true);
            }}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Record Expense
          </button>
        </div>
      </div>

      {/* KPI Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Active Recorded Spend
              </span>
              <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600">
                <Wallet className="h-4 w-4" />
              </div>
            </div>
            <p
              data-testid="expenses-recorded-total"
              className="mt-2 text-2xl font-bold text-slate-900"
            >
              {formatMoney(summary.recordedTotal, currency)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {summary.recordedCount} recorded voucher
              {summary.recordedCount === 1 ? '' : 's'} · Voided excluded
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                This Month Recorded
              </span>
              <div className="rounded-xl bg-emerald-50 p-2 text-emerald-600">
                <Calendar className="h-4 w-4" />
              </div>
            </div>
            <p
              data-testid="expenses-month-total"
              className="mt-2 text-2xl font-bold text-slate-900"
            >
              {formatMoney(summary.thisMonthRecordedTotal, currency)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {summary.thisMonthRecordedCount} active voucher
              {summary.thisMonthRecordedCount === 1 ? '' : 's'} month-to-date
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Voided in History
              </span>
              <div className="rounded-xl bg-rose-50 p-2 text-rose-600">
                <Ban className="h-4 w-4" />
              </div>
            </div>
            <p
              data-testid="expenses-voided-total"
              className="mt-2 text-2xl font-bold text-slate-700"
            >
              {formatMoney(summary.voidedTotal, currency)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {summary.voidedCount} voided voucher
              {summary.voidedCount === 1 ? '' : 's'} (excluded from active totals)
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Expense Categories
              </span>
              <div className="rounded-xl bg-amber-50 p-2 text-amber-600">
                <FolderKanban className="h-4 w-4" />
              </div>
            </div>
            <p
              data-testid="expenses-active-categories"
              className="mt-2 text-2xl font-bold text-slate-900"
            >
              {summary.activeCategoriesCount}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {categories.length} total configured ·{' '}
              <button
                type="button"
                onClick={() => setActiveTab('categories')}
                className="font-semibold text-indigo-600 hover:underline"
              >
                Manage
              </button>
            </p>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="border-b border-slate-200 flex items-center justify-between gap-4">
        <nav className="flex items-center gap-6" aria-label="Expenses navigation">
          <button
            type="button"
            onClick={() => setActiveTab('expenses')}
            className={`pb-3 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'expenses'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Receipt className="h-4 w-4" />
            Expense History & Ledger
            {expensesData && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                {expensesData.total}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('categories')}
            className={`pb-3 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'categories'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <FolderKanban className="h-4 w-4" />
            Expense Categories
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
              {categories.length}
            </span>
          </button>
        </nav>

        <button
          type="button"
          onClick={() => void refreshAll()}
          className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {error && <ErrorAlert message={error} onRetry={() => void refreshAll()} />}

      {/*Starter Banner when 0 categories exist */}
      {categories.length === 0 && !loading && (
        <div className="rounded-2xl border border-indigo-200 bg-indigo-50/70 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-bold text-indigo-950">
              No expense categories configured for {selectedProperty.name} yet
            </h3>
            <p className="text-xs text-indigo-900/80">
              Configure property-scoped expense categories (such as Utilities, Maintenance,
              and Housekeeping) before recording operating expense vouchers.
            </p>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={seedingDefaults}
                onClick={() => void handleSeedStarterCategories()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {seedingDefaults
                  ? 'Creating...'
                  : 'Add Standard Hotel Categories'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* TAB 1: OPERATING EXPENSES LEDGER */}
      {activeTab === 'expenses' && (
        <div className="space-y-4">
          {/* Category Breakdown Bar for Filtered Active Spend */}
          {summary && summary.byCategory.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Recorded Spend Breakdown by Category (Filtered Period)
                </h2>
                <span className="text-xs font-semibold text-slate-700">
                  Total Active: {formatMoney(summary.recordedTotal, currency)} (incl. tax{' '}
                  {formatMoney(summary.recordedTaxTotal, currency)})
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {summary.byCategory.slice(0, 8).map((cat) => (
                  <div
                    key={cat.categoryId ?? cat.categoryCode}
                    className="rounded-xl border border-slate-100 bg-slate-50/70 p-3"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-slate-800 truncate">
                        {cat.categoryName}
                      </span>
                      <span className="font-mono text-[11px] font-semibold text-indigo-700">
                        {cat.sharePercent}%
                      </span>
                    </div>
                    <p className="mt-1 text-sm font-bold text-slate-900">
                      {formatMoney(cat.recordedAmount, currency)}
                    </p>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-indigo-600"
                        style={{ width: `${Math.min(100, Math.max(4, cat.sharePercent))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Filter Controls */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {STATUS_FILTER_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => {
                      setStatusFilter(tab.key);
                      setPage(1);
                    }}
                    className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                      statusFilter === tab.key
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={applyCurrentMonthRange}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  This Month
                </button>
                {hasFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <X className="h-3.5 w-3.5" />
                    Clear Filters
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
              <div className="relative lg:col-span-2">
                <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  aria-label="Search expenses"
                  placeholder="Search voucher #, title, vendor, ref..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2 text-xs focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <select
                aria-label="Filter by expense category"
                value={categoryFilter}
                onChange={(e) => {
                  setCategoryFilter(e.target.value);
                  setPage(1);
                }}
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none"
              >
                <option value="">All Categories</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                    {!cat.isActive ? ' (Inactive)' : ''}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter by payment method"
                value={paymentMethodFilter}
                onChange={(e) => {
                  setPaymentMethodFilter(e.target.value);
                  setPage(1);
                }}
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none"
              >
                <option value="">All Payment Methods</option>
                {EXPENSE_PAYMENT_METHODS.map((pm) => (
                  <option key={pm} value={pm}>
                    {EXPENSE_PAYMENT_METHOD_LABELS[pm]}
                  </option>
                ))}
              </select>

              <input
                type="date"
                aria-label="Expense date from"
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setPage(1);
                }}
                className="rounded-xl border border-slate-300 px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none"
              />

              <input
                type="date"
                aria-label="Expense date to"
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setPage(1);
                }}
                className="rounded-xl border border-slate-300 px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none"
              />
            </div>

            {suppliers.length > 0 && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs font-medium text-slate-500">Supplier:</span>
                <select
                  aria-label="Filter by supplier"
                  value={supplierFilter}
                  onChange={(e) => {
                    setSupplierFilter(e.target.value);
                    setPage(1);
                  }}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="">All Suppliers & Direct Payees</option>
                  <option value="none">Direct Payee Only (No Linked Supplier)</option>
                  {suppliers.map((sup) => (
                    <option key={sup.id} value={sup.id}>
                      {sup.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Expenses Table */}
          {loading ? (
            <LoadingState label="Loading operating expenses..." />
          ) : expenses.length === 0 ? (
            <EmptyState
              title={
                hasFilters
                  ? 'No expenses match your current filters'
                  : 'No operating expenses recorded yet'
              }
              description={
                hasFilters
                  ? 'Try adjusting the date range, status filter, or category filter.'
                  : 'Record property utility bills, maintenance repairs, housekeeping supplies, and vendor disbursements with full audit history.'
              }
              action={
                hasFilters ? (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Reset Filters
                  </button>
                ) : activeCategories.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingExpense(null);
                      setExpenseModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                  >
                    <Plus className="h-4 w-4" />
                    Record First Expense
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3 text-left">Voucher & Date</th>
                      <th className="px-4 py-3 text-left">Expense & Category</th>
                      <th className="px-4 py-3 text-left">Vendor / Reference</th>
                      <th className="px-4 py-3 text-left">Method & Staff</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                      <th className="px-4 py-3 text-left">Status</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {expenses.map((exp) => {
                      const isVoided = exp.status === 'voided';
                      return (
                        <tr
                          key={exp.id}
                          data-testid={`expense-row-${exp.expenseNumber}`}
                          className={
                            isVoided
                              ? 'bg-rose-50/25 hover:bg-rose-50/40 transition-colors'
                              : 'hover:bg-slate-50/80 transition-colors'
                          }
                        >
                          <td className="px-4 py-3.5 align-top whitespace-nowrap">
                            <p className="font-mono text-xs font-bold text-indigo-700">
                              {exp.expenseNumber}
                            </p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {formatDisplayDate(exp.expenseDate)}
                            </p>
                          </td>

                          <td className="px-4 py-3.5 align-top max-w-xs">
                            <p
                              className={`font-semibold ${
                                isVoided ? 'text-slate-500 line-through' : 'text-slate-900'
                              }`}
                            >
                              {exp.title}
                            </p>
                            {exp.description && (
                              <p className="text-xs text-slate-500 line-clamp-1 mt-0.5">
                                {exp.description}
                              </p>
                            )}
                            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                              <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                                {exp.categoryName}
                              </span>
                              {!exp.categoryIsActive && (
                                <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                  Inactive Category
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="px-4 py-3.5 align-top">
                            <p className="text-xs font-medium text-slate-800">
                              {exp.supplierName || exp.vendorName || '—'}
                            </p>
                            {exp.referenceNumber && (
                              <p className="font-mono text-[11px] text-slate-500 mt-0.5">
                                Ref: {exp.referenceNumber}
                              </p>
                            )}
                          </td>

                          <td className="px-4 py-3.5 align-top whitespace-nowrap">
                            <ExpensePaymentMethodBadge method={exp.paymentMethod} />
                            <p className="text-[11px] text-slate-500 mt-1">
                              By {exp.recordedByName ?? 'Staff'}
                            </p>
                          </td>

                          <td className="px-4 py-3.5 align-top text-right whitespace-nowrap">
                            <p
                              className={`font-bold ${
                                isVoided
                                  ? 'text-rose-700 line-through'
                                  : 'text-slate-900'
                              }`}
                            >
                              {formatMoney(exp.amount, exp.currency)}
                            </p>
                            {exp.taxAmount > 0 && (
                              <p className="text-[11px] text-slate-500">
                                Tax: {formatMoney(exp.taxAmount, exp.currency)}
                              </p>
                            )}
                          </td>

                          <td className="px-4 py-3.5 align-top">
                            <ExpenseStatusBadge status={exp.status} />
                            {isVoided && exp.voidReason && (
                              <p
                                className="mt-1 max-w-[180px] text-[11px] text-rose-700 line-clamp-2"
                                title={exp.voidReason}
                              >
                                {exp.voidReason}
                              </p>
                            )}
                          </td>

                          <td className="px-4 py-3.5 align-top text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                title="View voucher & audit history"
                                aria-label={`View ${exp.expenseNumber}`}
                                onClick={() => setViewingExpenseId(exp.id)}
                                className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50 hover:text-indigo-600"
                              >
                                <Eye className="h-4 w-4" />
                              </button>

                              {isAdmin && !isVoided && (
                                <>
                                  <button
                                    type="button"
                                    title="Edit expense"
                                    aria-label={`Edit ${exp.expenseNumber}`}
                                    onClick={() => {
                                      setEditingExpense(exp);
                                      setExpenseModalOpen(true);
                                    }}
                                    className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50 hover:text-indigo-600"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </button>

                                  <button
                                    type="button"
                                    title="Void expense"
                                    aria-label={`Void ${exp.expenseNumber}`}
                                    onClick={() => setVoidingExpense(exp)}
                                    className="rounded-lg border border-rose-200 bg-white p-1.5 text-rose-600 hover:bg-rose-50"
                                  >
                                    <Ban className="h-4 w-4" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {expensesData && expensesData.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs text-slate-600">
                  <span>
                    Page {expensesData.page} of {expensesData.totalPages} ({expensesData.total}{' '}
                    records)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1 font-medium disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={page >= expensesData.totalPages}
                      onClick={() => setPage((p) => p + 1)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1 font-medium disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: EXPENSE CATEGORIES */}
      {activeTab === 'categories' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                Property Expense Categories
              </h2>
              <p className="text-xs text-slate-500">
                Deactivating a category prevents new assignments while safely preserving all
                historical expense records.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showInactiveCategories}
                  onChange={(e) => setShowInactiveCategories(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                />
                Show inactive categories
              </label>

              {isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingCategory(null);
                    setCategoryModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                >
                  <Plus className="h-4 w-4" />
                  Add Category
                </button>
              )}
            </div>
          </div>

          {displayedCategories.length === 0 ? (
            <EmptyState
              title="No expense categories to display"
              description="Create property-scoped expense categories to organize operating expenditures."
              action={
                isAdmin ? (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingCategory(null);
                      setCategoryModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
                  >
                    <Plus className="h-4 w-4" />
                    New Expense Category
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3 text-left">Code</th>
                      <th className="px-4 py-3 text-left">Category Name</th>
                      <th className="px-4 py-3 text-right">Recorded Vouchers</th>
                      <th className="px-4 py-3 text-right">Recorded Spend</th>
                      <th className="px-4 py-3 text-left">Status</th>
                      {isAdmin && <th className="px-4 py-3 text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {displayedCategories.map((cat) => (
                      <tr key={cat.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-3.5 font-mono text-xs font-bold text-indigo-700">
                          {cat.code}
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="font-semibold text-slate-900">{cat.name}</p>
                          {cat.description && (
                            <p className="text-xs text-slate-500 mt-0.5">
                              {cat.description}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-right text-xs font-medium text-slate-700">
                          {cat.recordedExpenseCount} active ({cat.totalExpenseCount} total)
                        </td>
                        <td className="px-4 py-3.5 text-right font-semibold text-slate-900">
                          {formatMoney(cat.recordedTotalAmount, currency)}
                        </td>
                        <td className="px-4 py-3.5">
                          {cat.isActive ? (
                            <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                              Deactivated
                            </span>
                          )}
                        </td>
                        {isAdmin && (
                          <td className="px-4 py-3.5 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCategory(cat);
                                  setCategoryModalOpen(true);
                                }}
                                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleToggleCategoryActive(cat)}
                                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                              >
                                {cat.isActive ? 'Deactivate' : 'Activate'}
                              </button>
                              {cat.totalExpenseCount === 0 && (
                                <button
                                  type="button"
                                  aria-label={`Delete category ${cat.name}`}
                                  onClick={() => setDeletingCategory(cat)}
                                  className="rounded-lg border border-rose-200 bg-white p-1.5 text-rose-600 hover:bg-rose-50"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
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

      {/* Modals */}
      <ExpenseCategoryModal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        property={selectedProperty}
        editingCategory={editingCategory}
        onSaved={() => void refreshAll()}
      />

      <ExpenseFormModal
        open={expenseModalOpen}
        onClose={() => setExpenseModalOpen(false)}
        property={selectedProperty}
        categories={categories}
        suppliers={suppliers}
        editingExpense={editingExpense}
        onSaved={() => void refreshAll()}
      />

      <VoidExpenseModal
        open={Boolean(voidingExpense)}
        onClose={() => setVoidingExpense(null)}
        property={selectedProperty}
        expense={voidingExpense}
        onVoided={() => void refreshAll()}
      />

      <ExpenseDetailModal
        open={Boolean(viewingExpenseId)}
        onClose={() => setViewingExpenseId(null)}
        property={selectedProperty}
        expenseId={viewingExpenseId}
      />

      <ConfirmDialog
        open={Boolean(deletingCategory)}
        onClose={() => setDeletingCategory(null)}
        onConfirm={handleConfirmDeleteCategory}
        title="Delete Unused Expense Category"
        description={
          deletingCategory
            ? `Permanently delete unused category "${deletingCategory.name}" (${deletingCategory.code})? Categories with historical expenses can only be deactivated.`
            : ''
        }
        confirmLabel="Delete Category"
        variant="danger"
        isSubmitting={deletingCategoryBusy}
      />
    </div>
  );
}
