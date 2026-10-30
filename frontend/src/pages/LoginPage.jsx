import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Loader2, Eye, EyeOff, AlertCircle, ArrowRight } from "lucide-react";
import { apiFetch, setSession } from "../api/client";
import { ROLE_DEFAULT_REDIRECT, VALID_ROLES } from "../config/roles";
import { apiUrl } from "../config/apiBase";
import { useAuth } from "../context/AuthContext";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MESSAGES = {
  invalidEmail: "Enter a valid email address.",
  missingPassword: "Enter your password.",
  invalidCredentials: "Invalid email or password.",
  serverError: "We couldn't sign you in right now. Please try again.",
  networkError: "Unable to connect. Check your internet connection and try again.",
  rateLimited: "Too many sign-in attempts. Please wait a minute and try again.",
};

// Maps a thrown apiFetch error to the correct user-facing message.
// Only an actual authentication rejection (401/403 from the login endpoint)
// produces "Invalid email or password." — server outages, rate limiting,
// malformed responses and network failures each get their own honest copy.
function messageForAuthError(err) {
  if (!err || err.network || err.status === 0) return MESSAGES.networkError;
  const status = err.status;
  if (status === 401 || status === 403) {
    // Account-state rejections arrive as our own API's detail text; masking
    // "organization suspended" as bad credentials would mislead the user.
    const detail = (err.serverDetail || "").toLowerCase();
    if (detail.includes("suspended") || detail.includes("deactivated")) {
      return err.serverDetail;
    }
    return MESSAGES.invalidCredentials;
  }
  if (status === 422) {
    const fields = Array.isArray(err.serverFields) ? err.serverFields : [];
    if (fields.includes("email")) return MESSAGES.invalidEmail;
    if (fields.includes("password")) return MESSAGES.missingPassword;
    return MESSAGES.serverError;
  }
  if (status === 429) return MESSAGES.rateLimited;
  if (status >= 500) return MESSAGES.serverError;
  return err.message || MESSAGES.serverError;
}

const GOOGLE_ERRORS = {
  cancelled: "Google sign-in was cancelled.",
  not_configured: "Google sign-in is not configured for this environment yet. Please sign in with your email and password.",
  invalid_state: "Google sign-in expired. Please try again.",
  exchange_failed: "We couldn't complete Google sign-in. Please try again.",
  unverified_email: "Your Google email address is not verified.",
  no_account: "No Zoiko account exists for this Google email. Ask your administrator for an invitation.",
  inactive: "Your account or organization is not active. Please contact support.",
};

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [oauthNotice, setOauthNotice] = useState(null);

  // Ref-based in-flight guard: the disabled attribute alone leaves a window
  // between two synchronous clicks before React re-renders with disabled=true.
  const submittingRef = useRef(false);

  function defaultRedirectFor(role) {
    return VALID_ROLES.includes(role)
      ? ROLE_DEFAULT_REDIRECT[role]
      : "/login";
  }

  function completeLogin(data) {
    setSession(data);
    login(data.user).then(() => {
      const fallback = defaultRedirectFor(data.user?.role);
      const from = location.state?.from?.pathname || fallback;
      navigate(from, { replace: true });
    });
  }

  // Google sign-in returns here: success arrives as a URL fragment (never sent
  // to servers), failure as ?google_error=<reason>.
  useEffect(() => {
    const frag = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    if (frag.get("access_token")) {
      window.history.replaceState(null, "", window.location.pathname);
      try {
        completeLogin({
          access_token: frag.get("access_token"),
          refresh_token: frag.get("refresh_token"),
          user: JSON.parse(frag.get("user")),
        });
      } catch {
        setLocalError(MESSAGES.serverError);
      }
    } else if (query.get("google_error")) {
      const reason = query.get("google_error");
      window.history.replaceState(null, "", window.location.pathname);
      setLocalError(GOOGLE_ERRORS[reason] || GOOGLE_ERRORS.exchange_failed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearStaleErrors(field) {
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
    setLocalError(null);
    setOauthNotice(null);
  }

  function handleEmailChange(e) {
    setEmail(e.target.value);
    clearStaleErrors("email");
  }

  function handlePasswordChange(e) {
    setPassword(e.target.value);
    clearStaleErrors("password");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submittingRef.current) return;

    const nextFieldErrors = {};
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !EMAIL_PATTERN.test(trimmedEmail)) {
      nextFieldErrors.email = MESSAGES.invalidEmail;
    }
    // Presence only — the password value itself is never trimmed or altered.
    if (!password) {
      nextFieldErrors.password = MESSAGES.missingPassword;
    }

    setFieldErrors(nextFieldErrors);
    setLocalError(null);
    setOauthNotice(null);
    if (Object.keys(nextFieldErrors).length > 0) return;

    submittingRef.current = true;
    setSubmitting(true);
    try {
      // ZB-SA-CMD-003 v3.0: a valid password completes the login for EVERY
      // role — including Super Admin. There is no MFA screen at login; MFA
      // is enforced only as a step-up when a privileged action demands it.
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: { email: trimmedEmail, password },
      });
      if (!data?.access_token || !data?.user) {
        // A 2xx without a usable session payload is a broken/malformed
        // response — treat it as a server failure, never as success and
        // never as bad credentials.
        throw { status: 502 };
      }
      completeLogin(data);
    } catch (err) {
      setLocalError(messageForAuthError(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleGoogleSignIn() {
    setLocalError(null);
    setFieldErrors({});
    setOauthNotice(null);
    window.location.href = apiUrl("/api/auth/google/login");
  }

  const inputClass = (hasError) =>
    `block w-full rounded-xl border bg-white px-4 py-3 text-[length:var(--input-font-size,15px)] text-slate-900 placeholder:text-slate-400 shadow-sm transition focus:outline-none focus:ring-4 ${
      hasError ? "border-red-500 focus:border-red-500 focus:ring-red-100" : "border-slate-200 hover:border-slate-300 focus:border-sky-500 focus:ring-sky-100"
    }`;

  const fieldErrorText = (message, id) =>
    message ? (
      <p id={id} role="alert" className="mt-1.5 text-xs font-medium text-red-600">
        {message}
      </p>
    ) : null;

  return (
    // The whole page scrolls as one document (no fixed-height panes): on
    // wide screens the artwork column stretches with the form; on small
    // screens the artwork stacks above the form.
    <div className="min-h-dvh bg-slate-100 font-sans lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* ── Left: brand artwork (cropped from the approved design) ── */}
      <aside className="relative h-[52vh] min-h-[340px] overflow-hidden bg-[#0B1F4B] lg:h-auto lg:min-h-dvh">
        <img
          src="/login-hero.webp"
          alt=""
          width="1498"
          height="1800"
          decoding="async"
          fetchPriority="high"
          className="absolute inset-0 h-full w-full object-cover object-left-top"
        />
        {/* The artwork's words, for screen readers (the image is decorative). */}
        <div className="sr-only">
          <p>Zoiko Billing</p>
          <p>Billing clarity. From quote to payment.</p>
          <p>Create invoices, manage customers, track payments and gain real-time financial insights — all in one secure platform.</p>
          <ul>
            <li>Professional invoicing</li>
            <li>Financial insights</li>
            <li>Payments and reconciliation</li>
            <li>Secure and reliable</li>
          </ul>
        </div>
      </aside>

      {/* ── Right: sign-in ── */}
      <main className="flex justify-center px-4 py-10 sm:px-8 lg:items-center lg:py-12">
        <div className="w-full max-w-[480px] rounded-[28px] bg-white p-3 shadow-[0_24px_60px_-28px_rgba(15,23,42,0.35)] sm:p-4">
          <nav aria-label="Account" className="grid grid-cols-3 border-b border-slate-100 px-2 text-center text-sm font-semibold">
            <span aria-current="page" className="border-b-[3px] border-sky-600 py-3.5 text-sky-700">Login</span>
            <Link to="/register" className="border-b-[3px] border-transparent py-3.5 text-slate-700 transition hover:text-sky-700">Register</Link>
            <Link to="/forgot-password" className="border-b-[3px] border-transparent py-3.5 text-slate-700 transition hover:text-sky-700">Reset Password</Link>
          </nav>

          <div className="mt-3 rounded-[22px] border border-slate-100 px-5 py-7 sm:px-8 sm:py-9">
            <h1 className="text-[34px] font-extrabold leading-tight tracking-tight text-[#0B1F4B] sm:text-4xl">Welcome back!</h1>
            <p className="mt-1.5 text-[15px] text-slate-500">Sign in to your Zoiko Billing account.</p>

            {(localError || oauthNotice) && (
              <div
                role="alert"
                className={`mt-6 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${
                  localError ? "border-red-200 bg-red-50 text-red-700" : "border-sky-200 bg-sky-50 text-sky-800"
                }`}
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{localError || oauthNotice}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate className="mt-7 space-y-5">
              <div>
                <label htmlFor="email" className="mb-2 block text-sm font-semibold text-slate-800">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={handleEmailChange}
                  placeholder="name@company.com"
                  aria-invalid={Boolean(fieldErrors.email)}
                  aria-describedby={fieldErrors.email ? "email-error" : undefined}
                  className={inputClass(fieldErrors.email)}
                />
                {fieldErrorText(fieldErrors.email, "email-error")}
              </div>

              <div>
                <label htmlFor="password" className="mb-2 block text-sm font-semibold text-slate-800">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={handlePasswordChange}
                    placeholder="Enter your password"
                    aria-invalid={Boolean(fieldErrors.password)}
                    aria-describedby={fieldErrors.password ? "password-error" : undefined}
                    className={`${inputClass(fieldErrors.password)} pr-12`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                {fieldErrorText(fieldErrors.password, "password-error")}
                <div className="mt-3 flex justify-end">
                  <Link to="/forgot-password" className="text-sm font-semibold text-sky-700 hover:text-sky-800 hover:underline">
                    Forgot password?
                  </Link>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                aria-busy={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-r from-sky-600 to-blue-600 px-4 py-3.5 text-base font-bold text-white shadow-[0_10px_24px_-10px_rgba(2,132,199,0.75)] transition hover:from-sky-700 hover:to-blue-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting && <Loader2 size={18} className="animate-spin" />}
                {submitting ? "Signing in…" : "Log In"}
              </button>
            </form>

            <div className="my-7 flex items-center gap-3 text-xs text-slate-500">
              <span className="h-px flex-1 bg-slate-200" />
              or continue with
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <button
              type="button"
              disabled={submitting}
              onClick={handleGoogleSignIn}
              className="group flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-[15px] font-semibold text-slate-800 transition hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <GoogleIcon />
              <span className="flex-1 text-left">Continue with Google</span>
              <ArrowRight size={16} className="text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-slate-600" />
            </button>

            <p className="mt-7 text-center text-[15px] text-slate-700">
              New to Zoiko Billing?{" "}
              <Link to="/register" className="font-bold text-sky-700 hover:text-sky-800 hover:underline">
                Register
              </Link>
            </p>
          </div>

          <p className="px-4 py-5 text-center text-xs text-slate-500">
            © {new Date().getFullYear()} Zoiko Tech Inc.
          </p>
        </div>
      </main>
    </div>
  );
}
