import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowLeft, CheckCircle2, Hotel, Mail } from 'lucide-react';
import { publicApiFetch } from '../lib/api';

interface ForgotPasswordResponse {
  success: boolean;
  message: string;
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await publicApiFetch<ForgotPasswordResponse>(
        '/api/auth/forgot-password',
        {
          method: 'POST',
          body: { email: email.trim().toLowerCase() },
        }
      );
      setSubmittedMessage(res.message);
    } catch (err) {
      setError((err as Error).message || 'Unable to process request right now.');
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
              Password Recovery
            </h1>
          </div>
        </div>

        {submittedMessage ? (
          <div
            data-testid="forgot-password-success"
            className="space-y-4 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-950"
          >
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 mt-0.5" />
              <div className="space-y-1.5">
                <p className="font-semibold">Check your email or contact an administrator</p>
                <p className="text-xs text-emerald-900 leading-relaxed">
                  {submittedMessage}
                </p>
                <p className="text-[11px] text-emerald-800">
                  Reset links are single-use and expire automatically after 60 minutes.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-600 leading-relaxed">
              Enter your staff login email address. If an active StayCraft PMS
              account matches, we will issue a time-limited, single-use password
              reset link.
            </p>

            {error && (
              <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs font-medium text-rose-800">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="forgot-email"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
                >
                  Work Email Address
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                  <input
                    id="forgot-email"
                    data-testid="forgot-password-email-input"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="staff@staycraft.local"
                    className="w-full rounded-xl border border-slate-300 pl-10 pr-3.5 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  />
                </div>
              </div>

              <button
                type="submit"
                data-testid="forgot-password-submit-btn"
                disabled={submitting}
                className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
              >
                {submitting ? 'Sending Recovery Instructions...' : 'Send Reset Link'}
              </button>
            </form>
          </>
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
