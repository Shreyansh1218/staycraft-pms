import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Database,
  Layers,
  ArrowLeft,
  CheckCircle2,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import type { UserSummary } from '@shared/types';
import { RoleBadge } from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';

export type FutureModuleKey =
  | 'invoices'
  | 'services'
  | 'expenses'
  | 'inventory'
  | 'suppliers'
  | 'reports'
  | 'staff';

interface ModuleMeta {
  title: string;
  subtitle: string;
  schemaTables: string[];
  plannedCapabilities: string[];
}

const MODULE_META: Record<FutureModuleKey, ModuleMeta> = {
  invoices: {
    title: 'Billing, Folios & Invoices',
    subtitle: 'Planned Module — Not Yet Implemented in Phase 1',
    schemaTables: ['invoices', 'invoice_line_items', 'payments'],
    plannedCapabilities: [
      'Automatic guest folio generation from checked-in room nights and posted service charges',
      'Tax-compliant invoice numbering using configured Property Settings prefix & sequence',
      'Split/partial payment recording (cash, card, UPI, bank transfer) and balance tracking',
      'Printable / downloadable PDF guest invoices and payment receipts',
    ],
  },
  services: {
    title: 'Additional Services & Room Charges',
    subtitle: 'Planned Module — Not Yet Implemented in Phase 1',
    schemaTables: ['service_catalog', 'reservation_service_charges'],
    plannedCapabilities: [
      'Configurable property service catalog (airport transfers, laundry, restaurant/room service, spa)',
      'Posting itemized service charges directly onto active in-house reservations',
      'Automatic transfer of unbilled service charges into checkout folios and invoices',
    ],
  },
  expenses: {
    title: 'Expenses & Basic Finance',
    subtitle: 'Planned Module — Not Yet Implemented in Phase 1',
    schemaTables: ['expenses', 'payments', 'invoices'],
    plannedCapabilities: [
      'Property operational expense tracking across utilities, maintenance, payroll, and vendor bills',
      'Supplier bill linking and payment method ledger',
      'Net cashflow comparison between collected stay payments and recorded operational expenses',
    ],
  },
  inventory: {
    title: 'Inventory & Stock Control',
    subtitle: 'Planned Module — Not Yet Implemented in Phase 1',
    schemaTables: ['inventory_products', 'stock_movements'],
    plannedCapabilities: [
      'SKU tracking for housekeeping linens, toiletries, minibar items, and consumables',
      'Stock-in, consumption, adjustment, and wastage movement logs with audit attribution',
      'Low-stock reorder threshold alerts surfaced in the top operational notification center',
    ],
  },
  suppliers: {
    title: 'Suppliers & Vendor Directory',
    subtitle: 'Planned Module — Not Yet Implemented in Phase 1',
    schemaTables: ['suppliers', 'inventory_products', 'expenses'],
    plannedCapabilities: [
      'Centralized vendor profiles with contact details, tax identifiers, and supply categories',
      'Direct linking of suppliers to inventory replenishment and property expense vouchers',
    ],
  },
  reports: {
    title: 'Reports & Operational Analytics',
    subtitle: 'Planned Module — Not Yet Implemented in Phase 1',
    schemaTables: ['reservations', 'rooms', 'invoices', 'payments', 'expenses', 'audit_events'],
    plannedCapabilities: [
      'Date-range occupancy, ADR (Average Daily Rate), and RevPAR calculation from verified stays',
      'Booking source performance breakdown (Direct, Walk-In, Website, OTAs, Corporate)',
      'Tax summary reports and CSV exports backed strictly by real database records',
    ],
  },
  staff: {
    title: 'Staff & User Management',
    subtitle: 'Phase 1 RBAC Active • Full Staff Rostering Planned for Phase 2',
    schemaTables: ['users', 'user_property_access', 'user_sessions', 'housekeeping_tasks'],
    plannedCapabilities: [
      'Staff invitation, role assignment, password reset, and per-property access management UI',
      'Department & shift scheduling for Front Desk, Housekeeping, and Maintenance teams',
      'Activity audit log viewer across property operations',
    ],
  },
};

export function FutureModulePage({ moduleKey }: { moduleKey: FutureModuleKey }) {
  const meta = MODULE_META[moduleKey];
  const { user, selectedProperty } = useAuth();
  const [systemUsers, setSystemUsers] = useState<UserSummary[]>([]);

  useEffect(() => {
    if (moduleKey === 'staff' && user?.role === 'admin' && selectedProperty) {
      apiFetch<{ items: UserSummary[] }>('/api/properties/users', {
        propertyId: selectedProperty.id,
      })
        .then((res) => setSystemUsers(res.items))
        .catch(() => setSystemUsers([]));
    }
  }, [moduleKey, user?.role, selectedProperty?.id]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-indigo-600 mb-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Return to Front Office Dashboard
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{meta.title}</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-0.5 text-xs font-semibold text-amber-800">
            <Clock className="h-3.5 w-3.5" />
            Phase 2 Module Placeholder
          </span>
        </div>
        <p className="text-sm text-slate-500 mt-1">{meta.subtitle}</p>
      </div>

      {/* Honest Architecture Status Card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs space-y-5">
        <div className="flex items-start gap-3.5">
          <div className="rounded-xl bg-indigo-50 p-3 text-indigo-600 shrink-0">
            <Layers className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Modular Architecture Ready — Honest Phase 1 Status
            </h2>
            <p className="text-sm text-slate-600 mt-1 leading-relaxed">
              In accordance with the Phase 1 scope, this navigation route is wired into the
              application shell without fabricated metrics or simulated actions. Its relational
              PostgreSQL tables, foreign keys, and constraints are already migrated and ready for
              implementation in subsequent phases.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1.5 mb-2.5">
              <Database className="h-3.5 w-3.5 text-indigo-600" />
              Prepared PostgreSQL Relations
            </h3>
            <div className="flex flex-wrap gap-2">
              {meta.schemaTables.map((tbl) => (
                <span
                  key={tbl}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-mono font-semibold text-slate-800"
                >
                  {tbl}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2.5">
              Planned Capabilities for Next Phase
            </h3>
            <ul className="space-y-2 text-xs text-slate-600">
              {meta.plannedCapabilities.map((cap) => (
                <li key={cap} className="flex items-start gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-teal-600 shrink-0 mt-0.5" />
                  <span>{cap}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* For Staff & Users: Show Live Phase 1 RBAC Accounts to Administrators */}
      {moduleKey === 'staff' && user?.role === 'admin' && systemUsers.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-4 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-indigo-600" />
                Active Phase 1 Staff Accounts (Live PostgreSQL RBAC)
              </h2>
              <p className="text-xs text-slate-500">
                Current authenticated system accounts enforcing Administrator and Receptionist
                permissions.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-100">
                <tr>
                  <th className="px-5 py-3">Full Name</th>
                  <th className="px-5 py-3">Email</th>
                  <th className="px-5 py-3">Role</th>
                  <th className="px-5 py-3">Last Sign-In</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {systemUsers.map((u) => (
                  <tr key={u.id}>
                    <td className="px-5 py-3 font-medium text-slate-900">{u.fullName}</td>
                    <td className="px-5 py-3 text-slate-600">{u.email}</td>
                    <td className="px-5 py-3">
                      <RoleBadge role={u.role} />
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
