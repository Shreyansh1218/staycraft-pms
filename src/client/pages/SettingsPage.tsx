import React, { useEffect, useState } from 'react';
import { Building2, KeyRound, Lock, Mail, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { Property } from '@shared/types';
import { ErrorAlert } from '../components/ui/Feedback';
import { RoleBadge } from '../components/ui/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch } from '../lib/api';

const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

const COMMON_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'JPY'];

export function SettingsPage() {
  const { user, selectedProperty, refreshSession } = useAuth();
  const { showToast } = useToast();
  const isAdmin = user?.role === 'admin';

  // Property settings state (matches propertySettingsSchema & Property)
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [currency, setCurrency] = useState('INR');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateRegion, setStateRegion] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [standardCheckInTime, setStandardCheckInTime] = useState('14:00');
  const [standardCheckOutTime, setStandardCheckOutTime] = useState('11:00');
  const [taxName, setTaxName] = useState('GST');
  const [defaultTaxRate, setDefaultTaxRate] = useState('12');
  const [cancellationPolicy, setCancellationPolicy] = useState('');
  const [bookingTerms, setBookingTerms] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Self-service account email state
  const [accountEmail, setAccountEmail] = useState(user?.email ?? '');
  const [emailCurrentPassword, setEmailCurrentPassword] = useState('');
  const [savingAccountEmail, setSavingAccountEmail] = useState(false);
  const [accountEmailError, setAccountEmailError] = useState<string | null>(null);

  // Self-service password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.email) {
      setAccountEmail(user.email);
    }
  }, [user?.email]);

  useEffect(() => {
    if (!selectedProperty) return;
    setName(selectedProperty.name);
    setTimezone(selectedProperty.timezone);
    setCurrency(selectedProperty.currency);
    setAddressLine1(selectedProperty.addressLine1);
    setAddressLine2(selectedProperty.addressLine2);
    setCity(selectedProperty.city);
    setStateRegion(selectedProperty.stateRegion);
    setPostalCode(selectedProperty.postalCode);
    setCountry(selectedProperty.country);
    setPhone(selectedProperty.phone);
    setEmail(selectedProperty.email);
    setWebsite(selectedProperty.website);
    setStandardCheckInTime(selectedProperty.standardCheckInTime);
    setStandardCheckOutTime(selectedProperty.standardCheckOutTime);
    setTaxName(selectedProperty.taxName ?? 'GST');
    setDefaultTaxRate(String(selectedProperty.defaultTaxRate ?? 12));
    setCancellationPolicy(selectedProperty.cancellationPolicy ?? '');
    setBookingTerms(selectedProperty.bookingTerms ?? '');
  }, [selectedProperty]);

  const handleSaveProperty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProperty || !isAdmin) return;
    setError(null);
    setSaving(true);
    try {
      await apiFetch<{ property: Property }>('/api/properties/current', {
        method: 'PUT',
        propertyId: selectedProperty.id,
        body: {
          name,
          email,
          phone,
          website,
          addressLine1,
          addressLine2,
          city,
          stateRegion,
          postalCode,
          country,
          timezone,
          currency,
          defaultTaxRate: Number(defaultTaxRate) || 0,
          taxName: taxName.trim() || 'GST',
          standardCheckInTime,
          standardCheckOutTime,
          cancellationPolicy,
          bookingTerms,
          invoiceSettings: selectedProperty.invoiceSettings,
        },
      });
      await refreshSession();
      showToast('success', 'Property settings updated');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAccountEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setAccountEmailError(null);
    const trimmedEmail = accountEmail.trim().toLowerCase();

    if (!trimmedEmail) {
      setAccountEmailError('Please enter a valid email address.');
      return;
    }
    if (!emailCurrentPassword) {
      setAccountEmailError('Enter your current password to confirm this email change.');
      return;
    }

    setSavingAccountEmail(true);
    try {
      await apiFetch('/api/auth/account/email', {
        method: 'PUT',
        skipUnauthorizedHandling: true,
        body: {
          newEmail: trimmedEmail,
          currentPassword: emailCurrentPassword,
        },
      });
      setEmailCurrentPassword('');
      await refreshSession();
      showToast('success', 'Your login email address has been updated.');
    } catch (err) {
      const apiErr = err as ApiClientError;
      setAccountEmailError(apiErr.message || 'Unable to update email address.');
    } finally {
      setSavingAccountEmail(false);
    }
  };

  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);

    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError('New password and confirmation do not match.');
      return;
    }

    setSavingPassword(true);
    try {
      await apiFetch('/api/auth/account/password', {
        method: 'PUT',
        skipUnauthorizedHandling: true,
        body: {
          currentPassword,
          newPassword,
        },
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      showToast(
        'success',
        'Password updated. Other active sessions on different devices were signed out.'
      );
    } catch (err) {
      const apiErr = err as ApiClientError;
      setPasswordError(apiErr.message || 'Unable to change password.');
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Settings & Account Security
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Manage your personal login credentials and hotel property operational defaults.
        </p>
      </div>

      {/* ==================================================================== */}
      {/* SELF-SERVICE ACCOUNT & SECURITY (Admin + Receptionist)               */}
      {/* ==================================================================== */}
      {user && (
        <section
          id="account-security"
          data-testid="account-security-section"
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-600">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  My Account & Security
                </h2>
                <p className="text-xs text-slate-500">
                  Signed in as <strong>{user.fullName}</strong> ({user.email})
                </p>
              </div>
            </div>
            <RoleBadge role={user.role} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Update Email Form */}
            <form
              onSubmit={handleSaveAccountEmail}
              data-testid="self-service-email-form"
              className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3.5"
            >
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-indigo-600" />
                <h3 className="text-sm font-bold text-slate-900">
                  Change Login Email
                </h3>
              </div>
              <p className="text-xs text-slate-500">
                Updates your login email while keeping your current session active.
              </p>

              {accountEmailError && <ErrorAlert message={accountEmailError} />}

              <div>
                <label
                  htmlFor="acct-new-email"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  New Email Address *
                </label>
                <input
                  id="acct-new-email"
                  data-testid="acct-new-email-input"
                  type="email"
                  required
                  value={accountEmail}
                  onChange={(e) => setAccountEmail(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label
                  htmlFor="acct-email-current-password"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Confirm Current Password *
                </label>
                <input
                  id="acct-email-current-password"
                  data-testid="acct-email-password-input"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={emailCurrentPassword}
                  onChange={(e) => setEmailCurrentPassword(e.target.value)}
                  placeholder="Enter current password"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                />
              </div>

              <div className="pt-1 flex justify-end">
                <button
                  type="submit"
                  data-testid="acct-save-email-btn"
                  disabled={savingAccountEmail}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {savingAccountEmail ? 'Updating Email...' : 'Update Email'}
                </button>
              </div>
            </form>

            {/* Change Password Form */}
            <form
              onSubmit={handleSavePassword}
              data-testid="self-service-password-form"
              className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3.5"
            >
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-indigo-600" />
                <h3 className="text-sm font-bold text-slate-900">
                  Change Password
                </h3>
              </div>
              <p className="text-xs text-slate-500">
                Requires your current password and signs out other devices.
              </p>

              {passwordError && <ErrorAlert message={passwordError} />}

              <div>
                <label
                  htmlFor="acct-current-password"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Current Password *
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                  <input
                    id="acct-current-password"
                    data-testid="acct-current-password-input"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Current password"
                    className="w-full rounded-xl border border-slate-300 bg-white pl-9 pr-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="acct-new-password"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    New Password *
                  </label>
                  <input
                    id="acct-new-password"
                    data-testid="acct-new-password-input"
                    type="password"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min. 8 chars"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label
                    htmlFor="acct-confirm-password"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Confirm New *
                  </label>
                  <input
                    id="acct-confirm-password"
                    data-testid="acct-confirm-password-input"
                    type="password"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Re-enter"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="pt-1 flex justify-end">
                <button
                  type="submit"
                  data-testid="acct-save-password-btn"
                  disabled={savingPassword}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {savingPassword ? 'Updating Password...' : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        </section>
      )}

      {/* ==================================================================== */}
      {/* PROPERTY SETTINGS (Admin-writable, Receptionist read-only)           */}
      {/* ==================================================================== */}
      {!isAdmin && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
          <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Property Settings Read-Only Access</p>
            <p className="mt-0.5">
              Receptionists can view property configuration and manage their own
              account credentials above, while hotel-wide settings require an{' '}
              <strong>Administrator</strong> account.
            </p>
          </div>
        </div>
      )}

      {selectedProperty && (
        <form
          onSubmit={handleSaveProperty}
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-6"
        >
          <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
            <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-600">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                {selectedProperty.name}
              </h2>
              <p className="text-xs text-slate-500">
                Property Code:{' '}
                <strong className="font-mono">{selectedProperty.code}</strong> • Local
                Date: <strong>{selectedProperty.localToday}</strong>
              </p>
            </div>
          </div>

          {error && <ErrorAlert message={error} />}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label
                htmlFor="prop-name"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Property Display Name *
              </label>
              <input
                id="prop-name"
                type="text"
                required
                disabled={!isAdmin}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="prop-tz"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                IANA Timezone * (Controls Arrivals & Departures Today)
              </label>
              <select
                id="prop-tz"
                disabled={!isAdmin}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-50"
              >
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="prop-curr"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Default Currency *
              </label>
              <select
                id="prop-curr"
                disabled={!isAdmin}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-50"
              >
                {COMMON_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="prop-ci"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Standard Check-In Time *
              </label>
              <input
                id="prop-ci"
                type="time"
                disabled={!isAdmin}
                value={standardCheckInTime}
                onChange={(e) => setStandardCheckInTime(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="prop-co"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Standard Check-Out Time *
              </label>
              <input
                id="prop-co"
                type="time"
                disabled={!isAdmin}
                value={standardCheckOutTime}
                onChange={(e) => setStandardCheckOutTime(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="prop-tax-name"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Tax / Levy Label * (Shown on Invoices & Guest QR Menu)
              </label>
              <input
                id="prop-tax-name"
                type="text"
                required
                maxLength={40}
                disabled={!isAdmin}
                value={taxName}
                onChange={(e) => setTaxName(e.target.value)}
                placeholder="e.g. GST, VAT, City Tax"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="prop-tax-rate"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Default Tax Rate (%) *
              </label>
              <input
                id="prop-tax-rate"
                type="number"
                min="0"
                max="100"
                step="0.01"
                required
                disabled={!isAdmin}
                value={defaultTaxRate}
                onChange={(e) => setDefaultTaxRate(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div className="sm:col-span-2">
              <label
                htmlFor="prop-addr"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Street Address Line 1 *
              </label>
              <input
                id="prop-addr"
                type="text"
                required
                disabled={!isAdmin}
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div className="sm:col-span-2">
              <label
                htmlFor="prop-addr2"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Address Line 2
              </label>
              <input
                id="prop-addr2"
                type="text"
                disabled={!isAdmin}
                value={addressLine2}
                onChange={(e) => setAddressLine2(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="prop-city"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                City *
              </label>
              <input
                id="prop-city"
                type="text"
                required
                disabled={!isAdmin}
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="prop-state"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                State / Region
              </label>
              <input
                id="prop-state"
                type="text"
                disabled={!isAdmin}
                value={stateRegion}
                onChange={(e) => setStateRegion(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="prop-postal"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Postal Code
              </label>
              <input
                id="prop-postal"
                type="text"
                disabled={!isAdmin}
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="prop-country"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Country *
              </label>
              <input
                id="prop-country"
                type="text"
                required
                disabled={!isAdmin}
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="prop-phone"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Front Desk Phone *
              </label>
              <input
                id="prop-phone"
                type="text"
                required
                disabled={!isAdmin}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="prop-email"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Reservations Contact Email *
              </label>
              <input
                id="prop-email"
                type="email"
                required
                disabled={!isAdmin}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>
          </div>

          {isAdmin && (
            <div className="flex justify-end border-t border-slate-100 pt-4">
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? 'Saving Settings...' : 'Save Property Configuration'}
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
