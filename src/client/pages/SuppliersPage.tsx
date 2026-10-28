import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2,
  Mail,
  MapPin,
  Package,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Truck,
  User,
} from 'lucide-react';
import { formatMoney } from '@shared/pricing';
import type { Supplier } from '@shared/types';
import { EmptyState, ErrorAlert, LoadingState } from '../components/ui/Feedback';
import { Modal } from '../components/ui/Modal';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch } from '../lib/api';

interface SupplierModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  editingSupplier: Supplier | null;
  onSaved: (supplier: Supplier) => void;
}

function SupplierModal({
  open,
  onClose,
  propertyId,
  editingSupplier,
  onSaved,
}: SupplierModalProps) {
  const { showToast } = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [taxIdentifier, setTaxIdentifier] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editingSupplier) {
      setCode(editingSupplier.code ?? '');
      setName(editingSupplier.name);
      setContactPerson(editingSupplier.contactPerson);
      setEmail(editingSupplier.email);
      setPhone(editingSupplier.phone);
      setAddress(editingSupplier.address);
      setTaxIdentifier(editingSupplier.taxIdentifier);
      setPaymentTerms(editingSupplier.paymentTerms);
      setNotes(editingSupplier.notes);
      setIsActive(editingSupplier.isActive);
    } else {
      setCode('');
      setName('');
      setContactPerson('');
      setEmail('');
      setPhone('');
      setAddress('');
      setTaxIdentifier('');
      setPaymentTerms('');
      setNotes('');
      setIsActive(true);
    }
  }, [open, editingSupplier]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        code: code.trim() ? code.trim().toUpperCase() : null,
        name: name.trim(),
        contactPerson: contactPerson.trim(),
        email: email.trim(),
        phone: phone.trim(),
        address: address.trim(),
        taxIdentifier: taxIdentifier.trim(),
        paymentTerms: paymentTerms.trim(),
        notes: notes.trim(),
        isActive,
      };

      const res = editingSupplier
        ? await apiFetch<{ supplier: Supplier }>(`/api/suppliers/${editingSupplier.id}`, {
            method: 'PUT',
            body: payload,
            propertyId,
          })
        : await apiFetch<{ supplier: Supplier }>('/api/suppliers', {
            method: 'POST',
            body: payload,
            propertyId,
          });

      showToast(
        'success',
        editingSupplier
          ? `Updated supplier "${res.supplier.name}"`
          : `Added supplier "${res.supplier.name}"`
      );
      onSaved(res.supplier);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'Failed to save supplier details'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingSupplier ? `Edit Supplier — ${editingSupplier.name}` : 'New Property Supplier'}
      maxWidthClass="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorAlert message={error} />}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label htmlFor="sup-name" className="block text-xs font-semibold text-slate-700 mb-1">
              Supplier / Vendor Name *
            </label>
            <input
              id="sup-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Fresh Harvest Foods Pvt Ltd"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="sup-code" className="block text-xs font-semibold text-slate-700 mb-1">
              Vendor Code
            </label>
            <input
              id="sup-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="VND-FHF"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono uppercase"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="sup-contact" className="block text-xs font-semibold text-slate-700 mb-1">
              Contact Person
            </label>
            <input
              id="sup-contact"
              type="text"
              value={contactPerson}
              onChange={(e) => setContactPerson(e.target.value)}
              placeholder="Rajesh Verma"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="sup-phone" className="block text-xs font-semibold text-slate-700 mb-1">
              Phone Number
            </label>
            <input
              id="sup-phone"
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98300 11223"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="sup-email" className="block text-xs font-semibold text-slate-700 mb-1">
              Email Address
            </label>
            <input
              id="sup-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="orders@vendor.example"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="sup-tax" className="block text-xs font-semibold text-slate-700 mb-1">
              Tax / GST Identifier
            </label>
            <input
              id="sup-tax"
              type="text"
              value={taxIdentifier}
              onChange={(e) => setTaxIdentifier(e.target.value)}
              placeholder="19AABCF1234D1Z5"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
            />
          </div>

          <div>
            <label htmlFor="sup-terms" className="block text-xs font-semibold text-slate-700 mb-1">
              Payment / Delivery Terms
            </label>
            <input
              id="sup-terms"
              type="text"
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              placeholder="Net 15 • Morning delivery"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label htmlFor="sup-address" className="block text-xs font-semibold text-slate-700 mb-1">
            Address
          </label>
          <input
            id="sup-address"
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street, city, postal code"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="sup-notes" className="block text-xs font-semibold text-slate-700 mb-1">
            Internal Notes
          </label>
          <textarea
            id="sup-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Lead times, minimum order notes..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs">
          <label className="inline-flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600"
            />
            Active Supplier (eligible for new item assignments and stock receipts)
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? 'Saving...' : editingSupplier ? 'Save Changes' : 'Create Supplier'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SuppliersPage() {
  const { user, selectedProperty } = useAuth();
  const { showToast } = useToast();
  const isAdmin = user?.role === 'admin';

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

  const loadSuppliers = useCallback(async () => {
    if (!selectedProperty) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (includeInactive) qs.set('includeInactive', 'true');
      if (search.trim()) qs.set('search', search.trim());
      const res = await apiFetch<{ items: Supplier[] }>(
        `/api/suppliers?${qs.toString()}`,
        { propertyId: selectedProperty.id }
      );
      setSuppliers(res.items);
    } catch (err) {
      setError((err as Error).message || 'Failed to load suppliers');
    } finally {
      setLoading(false);
    }
  }, [selectedProperty, includeInactive, search]);

  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  const metrics = useMemo(() => {
    const activeCount = suppliers.filter((s) => s.isActive).length;
    const linkedItems = suppliers.reduce((sum, s) => sum + s.linkedItemCount, 0);
    const totalReceipts = suppliers.reduce((sum, s) => sum + s.receiptCount, 0);
    const totalPurchased = suppliers.reduce((sum, s) => sum + s.totalPurchasedAmount, 0);
    return { activeCount, linkedItems, totalReceipts, totalPurchased };
  }, [suppliers]);

  const handleToggleActive = async (supplier: Supplier) => {
    if (!selectedProperty) return;
    try {
      await apiFetch(`/api/suppliers/${supplier.id}`, {
        method: 'PUT',
        body: { isActive: !supplier.isActive },
        propertyId: selectedProperty.id,
      });
      showToast(
        'success',
        `${supplier.isActive ? 'Deactivated' : 'Activated'} supplier "${supplier.name}"`
      );
      void loadSuppliers();
    } catch (err) {
      showToast('error', (err as Error).message || 'Failed to update supplier status');
    }
  };

  if (!selectedProperty) {
    return <LoadingState label="Selecting property..." />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Truck className="h-6 w-6 text-indigo-600" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Suppliers & Vendors
            </h1>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Property-scoped vendor directory, contact records, and replenishment intake partners for{' '}
            <strong className="text-slate-700">{selectedProperty.name}</strong>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/inventory"
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Package className="h-4 w-4 text-slate-500" />
            Inventory & Stock
          </Link>
          <button
            type="button"
            onClick={() => void loadSuppliers()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => {
                setEditingSupplier(null);
                setModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              New Supplier
            </button>
          )}
        </div>
      </div>

      {!isAdmin && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
          Supplier onboarding and status changes are managed by property{' '}
          <strong>Administrators</strong>. Front-desk staff can view supplier contacts and record
          incoming stock receipts in Inventory.
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Active Suppliers
          </div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900">{metrics.activeCount}</div>
          <div className="mt-0.5 text-xs text-slate-500">
            {suppliers.length} total in directory
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Linked Stock Items
          </div>
          <div className="mt-1.5 text-2xl font-bold text-indigo-700">{metrics.linkedItems}</div>
          <div className="mt-0.5 text-xs text-slate-500">Assigned primary vendor</div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Recorded Receipts
          </div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900">{metrics.totalReceipts}</div>
          <div className="mt-0.5 text-xs text-slate-500">Purchase intake batches</div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Total Purchased Value
          </div>
          <div className="mt-1.5 text-2xl font-bold text-emerald-700">
            {formatMoney(metrics.totalPurchased, selectedProperty.currency)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">Across vendor receipts</div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            aria-label="Search suppliers"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search supplier name, code, contact person, phone, or email..."
            className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2 text-sm"
          />
        </div>

        <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="rounded border-slate-300 text-indigo-600"
          />
          Show Inactive Suppliers
        </label>
      </div>

      {error && <ErrorAlert message={error} />}

      {loading ? (
        <LoadingState label="Loading property suppliers..." />
      ) : suppliers.length === 0 ? (
        <EmptyState
          title="No suppliers found"
          description="Add vendors to associate inventory items and track incoming purchase receipts."
        />
      ) : (
        <>
          {/* Desktop Table */}
          <div className="hidden lg:block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-left">Supplier</th>
                  <th className="px-4 py-3 text-left">Contact Details</th>
                  <th className="px-4 py-3 text-left">Terms & Tax ID</th>
                  <th className="px-4 py-3 text-left">Items & Receipts</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {suppliers.map((sup) => (
                  <tr
                    key={sup.id}
                    data-testid={`supplier-row-${sup.name}`}
                    className={`hover:bg-slate-50/70 ${!sup.isActive ? 'opacity-70' : ''}`}
                  >
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2">
                        {sup.code && (
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[11px] font-bold text-indigo-700">
                            {sup.code}
                          </span>
                        )}
                        <span className="font-bold text-slate-900">{sup.name}</span>
                      </div>
                      {sup.address && (
                        <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                          <MapPin className="h-3 w-3 shrink-0" />
                          <span className="truncate max-w-xs">{sup.address}</span>
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3.5 text-xs text-slate-700 space-y-0.5">
                      {sup.contactPerson && (
                        <div className="flex items-center gap-1.5 font-medium text-slate-900">
                          <User className="h-3.5 w-3.5 text-slate-400" />
                          {sup.contactPerson}
                        </div>
                      )}
                      {sup.phone && (
                        <div className="flex items-center gap-1.5">
                          <Phone className="h-3 w-3 text-slate-400" />
                          {sup.phone}
                        </div>
                      )}
                      {sup.email && (
                        <div className="flex items-center gap-1.5">
                          <Mail className="h-3 w-3 text-slate-400" />
                          {sup.email}
                        </div>
                      )}
                      {!sup.contactPerson && !sup.phone && !sup.email && (
                        <span className="text-slate-400">No contact specified</span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 text-xs text-slate-600">
                      {sup.taxIdentifier && (
                        <div className="font-mono text-[11px] text-slate-700">
                          Tax ID: {sup.taxIdentifier}
                        </div>
                      )}
                      {sup.paymentTerms ? (
                        <div className="mt-0.5">{sup.paymentTerms}</div>
                      ) : (
                        !sup.taxIdentifier && <span className="text-slate-400">—</span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 text-xs">
                      <div className="font-semibold text-slate-800">
                        {sup.activeItemCount} active / {sup.linkedItemCount} items
                      </div>
                      <div className="text-slate-500 mt-0.5">
                        {sup.receiptCount} receipt{sup.receiptCount === 1 ? '' : 's'} •{' '}
                        {formatMoney(sup.totalPurchasedAmount, selectedProperty.currency)}
                      </div>
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                          sup.isActive
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                            : 'border-slate-300 bg-slate-100 text-slate-600'
                        }`}
                      >
                        {sup.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <Link
                          to={`/inventory?supplierId=${sup.id}`}
                          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          Items
                        </Link>
                        {isAdmin && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingSupplier(sup);
                                setModalOpen(true);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              <Pencil className="h-3 w-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleToggleActive(sup)}
                              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              {sup.isActive ? 'Deactivate' : 'Activate'}
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

          {/* Mobile Cards */}
          <div className="grid grid-cols-1 gap-3 lg:hidden">
            {suppliers.map((sup) => (
              <div
                key={sup.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-2.5 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-indigo-600" />
                      <span className="font-bold text-sm text-slate-900">{sup.name}</span>
                    </div>
                    {sup.contactPerson && (
                      <div className="text-slate-600 mt-0.5">
                        {sup.contactPerson}
                        {sup.phone ? ` • ${sup.phone}` : ''}
                      </div>
                    )}
                  </div>
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                      sup.isActive
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-slate-300 bg-slate-100 text-slate-600'
                    }`}
                  >
                    {sup.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>

                <div className="flex items-center justify-between border-t border-slate-100 pt-2.5">
                  <span className="text-slate-500">
                    {sup.linkedItemCount} items • {sup.receiptCount} receipts
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Link
                      to={`/inventory?supplierId=${sup.id}`}
                      className="rounded-lg border border-slate-300 px-2.5 py-1 font-semibold text-slate-700"
                    >
                      Items
                    </Link>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSupplier(sup);
                          setModalOpen(true);
                        }}
                        className="rounded-lg border border-slate-300 px-2.5 py-1 font-semibold text-slate-700"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <SupplierModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        propertyId={selectedProperty.id}
        editingSupplier={editingSupplier}
        onSaved={() => void loadSuppliers()}
      />
    </div>
  );
}
