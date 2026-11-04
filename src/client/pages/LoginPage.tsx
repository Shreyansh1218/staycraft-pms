
import React, { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { Lock, Mail, AlertCircle, CheckCircle2, Info, ShieldCheck } from 'lucide-react';
import { sanitizeInternalRedirectPath } from '../../shared/navigation';
import { useAuth } from '../context/AuthContext';
import { ApiClientError } from '../lib/api';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

export function LoginPage() {
  const { user, isLoading, sessionNotice, clearSessionNotice, login } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const resetSuccess = searchParams.get('reset') === 'success';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // PWA installation state
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setInstallPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!installPrompt) return;

    try {
      await installPrompt.prompt();
    } finally {
      setInstallPrompt(null);
    }
  };

  const rawFrom = (location.state as { from?: string } | null)?.from;
  const redirectTarget = sanitizeInternalRedirectPath(rawFrom);

  if (!isLoading && user) {
    return <Navigate to={redirectTarget} replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    clearSessionNotice();
    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setLoginError(err.message);
      } else {
        setLoginError('Unable to reach authentication server. Verify connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-slate-950">
      {/* Left Brand Showcase */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 text-white border-r border-slate-800">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-teal-400 font-bold text-lg shadow-lg">
            SC
          </div>
          <div>
            <span className="text-lg font-bold tracking-tight block">StayCraft PMS</span>
            <span className="text-xs text-indigo-300">Cloud Hospitality Operations</span>
          </div>
        </div>

        <div className="space-y-6 max-w-lg">
          <span className="inline-flex items-center gap-2 rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-200">
            <ShieldCheck className="h-3.5 w-3.5 text-teal-400" />
            Database-Backed Front Office & Room Operations
          </span>
          <h1 className="text-3xl xl:text-4xl font-bold tracking-tight leading-tight">
            Unified control for reservations, rooms, guests, and housekeeping.
          </h1>
          <p className="text-sm text-slate-300 leading-relaxed">
            Built with real-time PostgreSQL concurrency protection, property-timezone accuracy,
            separated operational and housekeeping states, and role-based access control for
            hotel administrators and front-desk receptionists.
          </p>
        </div>

        <p className="text-xs text-slate-500">
          StayCraft Property Management System • Phase 1 Core Platform
        </p>
      </div>

      {/* Right Login Card */}
      <div className="flex flex-1 items-center justify-center p-6 sm:p-12 bg-slate-50">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center lg:text-left">
            <div className="inline-flex lg:hidden h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-teal-400 text-white font-bold text-lg mb-3">
              SC
            </div>
            <h2 className="text-2xl font-bold text-slate-900">Sign in to Front Desk</h2>
            <p className="text-sm text-slate-500 mt-1">
              Enter your staff email and password to access property operations.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm">
            <form onSubmit={handleSubmit} className="space-y-4">
              {resetSuccess && !loginError && (
                <div
                  role="status"
                  data-testid="login-reset-success-banner"
                  className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900"
                >
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>
                    Your password has been updated and previous sessions were signed out.
                    Sign in with your new password.
                  </span>
                </div>
              )}

              {sessionNotice && !loginError && (
                <div
                  role="status"
                  className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900"
                >
                  <Info className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <span>{sessionNotice}</span>
                </div>
              )}

              {loginError && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800"
                >
                  <AlertCircle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                  <span>{loginError}</span>
                </div>
              )}

              <div>
                <label
                  htmlFor="login-email"
                  className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1.5"
                >
                  Staff Email
                </label>
                <div className="relative">
                  <Mail className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@property.example"
                    className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label
                    htmlFor="login-password"
                    className="block text-xs font-semibold uppercase tracking-wider text-slate-600"
                  >
                    Password
                  </label>
                  <Link
                    to="/forgot-password"
                    data-testid="login-forgot-password-link"
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <Lock className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 transition-colors"
              >
                {submitting ? 'Signing in...' : 'Sign In'}
              </button>
            </form>

            {/* Install StayCraft App */}
            {installPrompt && (
              <button
                type="button"
                onClick={handleInstallClick}
                className="mt-4 w-full rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-colors"
              >
                Install StayCraft App
              </button>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white/80 px-4 py-3 text-xs text-slate-600">
            <p className="font-semibold text-slate-800 mb-1">Role-Based Access Enabled</p>
            <p className="leading-relaxed">
              Supports <strong>Administrator</strong> and <strong>Receptionist</strong> roles with
              server-side session authorization. Refer to project setup documentation (`README.md`)
              for initial seeded staff accounts.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
