import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Hotel, KeyRound, Lock } from 'lucide-react';
import { publicApiFetch } from '../lib/api';

interface VerifyPasswordResetTokenResponse {
  valid: boolean;
  expiresAt: string;
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = (searchParams.get('token') ?? '').trim();

  const [verifying, setVerifying] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || token.length < 16) {
      setTokenValid(false);
      setVerifying(false);
      return;
    }

    let cancelled = false;
    setVerifying(true);
    publicApiFetch<VerifyPasswordResetTokenResponse>(
      `/api/auth/reset-password/verify?token=${encodeURIComponent(token)}`
    )
      .then((res) => {
        if (cancelled) return;
        setTokenValid(Boolean(res.valid));
        setExpiresAt(res.expiresAt);
      })
      .catch(() => {
        if (cancelled) return;
        setTokenValid(false);
      })
      .finally(() => {
        if (!cancelled) setVerifying(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await publicApiFetch<{ success: boolean }>('/api/auth/reset-password', {
        method: 'POST',
        body: {
          token,
          newPassword,
        },
      });
      navigate('/login?reset=success', { replace: true });
    } catch (err) {
      setError(
        (err as Error).message ||
          'This password reset link is invalid, expired, or has already been used.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-md rounded-3xl bg-white p-7 sm:p-9 shadow-2xl space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-sm">
            <Hotel className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-indigo-600">
              StayCraft PMS
            </p>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Set New Password
            </h1>
          </div>
        </div>

        {verifying ? (
          <div className="py-8 text-center space-y-3">
            <div className="mx-auto h-7 w-7 animate-spin rounded-full border-3 border-indigo-200 border-t-indigo-600" />
            <p className="text-xs font-medium text-slate-500">
              Verifying single-use reset link...
            </p>
          </div>
        ) : !tokenValid ? (
          <div
            data-testid="reset-password-invalid"
            className="space-y-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-900"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="h-5 w-5 shrink-0 text-rose-600 mt-0.5" />
              <div className="space-y-1.5">
                <p className="text-sm font-semibold">
                  Reset Link Invalid or Expired
                </p>
                <p className="leading-relaxed">
                  For security, password reset links are single-use and expire after
                  60 minutes. Request a new link or ask an Administrator to initiate
                  a fresh password reset.
                </p>
              </div>
            </div>
            <Link
              to="/forgot-password"
              className="inline-flex w-full items-center justify-center rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700"
            >
              Request New Reset Link
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {expiresAt && (
              <p className="rounded-xl border border-indigo-100 bg-indigo-50/70 px-3.5 py-2 text-xs text-indigo-900">
                Single-use recovery link verified • Valid until{' '}
                <strong>
                  {new Date(expiresAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </strong>
              </p>
            )}

            {error && (
              <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs font-medium text-rose-800">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label
                htmlFor="reset-new-password"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                New Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  id="reset-new-password"
                  data-testid="reset-password-new-input"
                  type="password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  className="w-full rounded-xl border border-slate-300 pl-10 pr-3.5 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="reset-confirm-password"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Confirm New Password
              </label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  id="reset-confirm-password"
                  data-testid="reset-password-confirm-input"
                  type="password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  className="w-full rounded-xl border border-slate-300 pl-10 pr-3.5 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>
            </div>

            <button
              type="submit"
              data-testid="reset-password-submit-btn"
              disabled={submitting}
              className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
            >
              {submitting ? 'Updating Password...' : 'Save New Password'}
            </button>
          </form>
        )}

        <div className="border-t border-slate-100 pt-4">
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-indigo-600"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
