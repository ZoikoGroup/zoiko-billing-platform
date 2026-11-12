import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Loader2, Eye, EyeOff, AlertCircle, ChevronRight, Building2 } from "lucide-react";
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

const MicrosoftIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
    <rect x="0" y="0" width="10" height="10" fill="#F25022" />
    <rect x="12" y="0" width="10" height="10" fill="#7FBA00" />
    <rect x="0" y="12" width="10" height="10" fill="#00A4EF" />
    <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
  </svg>
);

const AppleIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="#111827" aria-hidden="true">
    <path d="M16.37 12.6c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3-.79-1.55.02-2.97.9-3.77 2.28-1.6 2.78-.41 6.9 1.15 9.15.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.78.74 2.99.72 1.24-.02 2.02-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.38-3.68zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.01.61-2.67 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.06-.52 2.69-1.28z" />
  </svg>
);

const CompanySsoIcon = () => <Building2 size={22} className="text-slate-800" aria-hidden="true" />;

// Order and labels follow the approved design. Only Google has a backend
// flow today (auth/google_oauth.py); the others say so honestly on click
// instead of pretending to start a sign-in.
const PROVIDERS = [
  { key: "microsoft", label: "Continue with Microsoft", Icon: MicrosoftIcon },
  { key: "google", label: "Continue with Google", Icon: GoogleIcon },
  { key: "apple", label: "Continue with Apple", Icon: AppleIcon },
  { key: "sso", label: "Continue with Company SSO", Icon: CompanySsoIcon },
];

const PROVIDER_UNAVAILABLE = {
  microsoft: "Microsoft sign-in isn't available yet. Continue with Google or sign in with your work email.",
  apple: "Apple sign-in isn't available yet. Continue with Google or sign in with your work email.",
  sso: "Company SSO isn't set up for this workspace yet. Continue with Google or sign in with your work email.",
};

// Desktop fit: after the height-based spacing has shrunk, scale the whole card
// uniformly (CSS zoom, so layout and centering follow) until it fits the
// column — the page never scrolls and nothing is cut off. Floor at 0.72 so
// text stays readable; on very short windows the column scrolls instead.
// Below lg the page scrolls normally and no zoom is applied.
const MIN_CARD_ZOOM = 0.72;

function useFitToHeight(containerRef, contentRef) {
  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined") return undefined;
    const desktop = window.matchMedia("(min-width: 1024px)");
    let frame = 0;

    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        content.style.zoom = "";
        if (!desktop.matches) return;
        const styles = getComputedStyle(container);
        // -4px absorbs sub-pixel rounding of the zoomed layout.
        const available =
          container.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom) - 4;
        const natural = content.offsetHeight;
        if (natural > available && available > 0) {
          content.style.zoom = String(Math.max(MIN_CARD_ZOOM, available / natural));
        }
      });
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    desktop.addEventListener?.("change", fit);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      desktop.removeEventListener?.("change", fit);
    };
  }, [containerRef, contentRef]);
}

// Survives the Google redirect round-trip so "Remember me" applies there too.
const REMEMBER_FLAG_KEY = "zoiko_login_remember";

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
  const [remember, setRemember] = useState(true);

  // Ref-based in-flight guard: the disabled attribute alone leaves a window
  // between two synchronous clicks before React re-renders with disabled=true.
  const submittingRef = useRef(false);
  const mainRef = useRef(null);
  const cardRef = useRef(null);
  useFitToHeight(mainRef, cardRef);

  function defaultRedirectFor(role) {
    return VALID_ROLES.includes(role)
      ? ROLE_DEFAULT_REDIRECT[role]
      : "/login";
  }

  function completeLogin(data, { persist = true } = {}) {
    if (persist) setSession(data);
    else setSession(data, { persist: false });
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
    const rememberedChoice = sessionStorage.getItem(REMEMBER_FLAG_KEY);
    sessionStorage.removeItem(REMEMBER_FLAG_KEY);
    if (frag.get("access_token")) {
      window.history.replaceState(null, "", window.location.pathname);
      try {
        completeLogin(
          {
            access_token: frag.get("access_token"),
            refresh_token: frag.get("refresh_token"),
            user: JSON.parse(frag.get("user")),
          },
          { persist: rememberedChoice !== "0" }
        );
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
      completeLogin(data, { persist: remember });
    } catch (err) {
      setLocalError(messageForAuthError(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleProviderSignIn(provider) {
    setLocalError(null);
    setFieldErrors({});
    if (provider !== "google") {
      setOauthNotice(PROVIDER_UNAVAILABLE[provider]);
      return;
    }
    setOauthNotice(null);
    sessionStorage.setItem(REMEMBER_FLAG_KEY, remember ? "1" : "0");
    window.location.href = apiUrl("/api/auth/google/login");
  }

  const inputClass = (hasError) =>
    `block w-full rounded-xl border bg-white px-4 py-3 text-[length:var(--input-font-size,15px)] text-slate-900 placeholder:text-slate-400 transition autofill:shadow-[inset_0_0_0_1000px_#fff] autofill:[-webkit-text-fill-color:#0f172a] focus:outline-none focus:ring-4 lg:py-[clamp(7px,1.25vh,12px)] ${
      hasError ? "border-red-500 focus:border-red-500 focus:ring-red-100" : "border-slate-200 hover:border-slate-300 focus:border-sky-500 focus:ring-sky-100"
    }`;

  const fieldErrorText = (message, id) =>
    message ? (
      <p id={id} role="alert" className="mt-1.5 text-xs font-medium text-red-600">
        {message}
      </p>
    ) : null;

  const providerButtonClass =
    "group flex w-full items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-3 text-[15px] font-semibold text-slate-800 transition hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-60 lg:py-[clamp(6px,1.15vh,12px)]";

  return (
    // Desktop: exactly one viewport tall with no page scroll. Artwork and a
    // fixed-width form column sit in one rounded frame, centred and inset from
    // the window edges. The artwork column is sized from the frame height so
    // the image is shown whole, and only the form column scrolls if a short
    // window can't fit the card.
    // Below lg the artwork stacks above the form and the page scrolls.
    <div className="min-h-dvh bg-[#EEF2F8] font-sans lg:flex lg:h-dvh lg:p-[clamp(10px,2.6vh,40px)] xl:px-[clamp(24px,5vw,120px)]">
      <div className="lg:mx-auto lg:flex lg:h-full lg:max-w-full lg:overflow-hidden lg:rounded-[28px] lg:bg-white lg:shadow-[0_30px_80px_-40px_rgba(15,23,42,0.45)] lg:ring-1 lg:ring-slate-200/70">
        {/* ── Left: brand artwork, cropped as-is from the approved design ── */}
        <aside className="relative overflow-hidden bg-[#06122B] lg:h-full lg:shrink-0">
          <img
            src="/login-hero.webp"
            alt=""
            width="828"
            height="1024"
            decoding="async"
            fetchPriority="high"
            className="block max-h-[48vh] w-full object-cover object-top lg:h-full lg:max-h-none lg:w-auto lg:max-w-[56vw] lg:object-left-top"
          />
          {/* The artwork's words, for screen readers (the image is decorative). */}
          <div className="sr-only">
            <p>Zoiko Billing</p>
            <p>Billing clarity. From invoice to payment.</p>
            <p>Invoices, payments, reconciliation and financial records — all in one secure platform.</p>
            <ul>
              <li>Create and send invoices</li>
              <li>Collect payments</li>
              <li>Reconciliation and reporting</li>
              <li>Enterprise-grade security</li>
            </ul>
          </div>
        </aside>

        {/* ── Right: sign-in ── */}
        <main ref={mainRef} className="flex min-w-0 flex-1 flex-col items-center px-4 py-8 sm:px-8 lg:h-full lg:w-[clamp(460px,36vw,660px)] lg:flex-none lg:overflow-y-auto lg:px-[clamp(24px,2.8vw,52px)] lg:py-[clamp(8px,1.6vh,24px)]">
          <div ref={cardRef} className="my-auto w-full max-w-[600px]">
            <div className="rounded-[28px] border border-slate-200/70 bg-[#F7F9FC] p-2.5 shadow-[0_24px_60px_-30px_rgba(15,23,42,0.35)] sm:p-3 lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
              <nav aria-label="Account" className="grid grid-cols-3 whitespace-nowrap lg:border-b lg:border-slate-200 text-center text-[15px] font-medium sm:text-[17px]">
                <span aria-current="page" className="relative py-4 font-semibold text-sky-600 lg:py-[clamp(9px,1.7vh,16px)]">
                  Login
                  <span className="absolute inset-x-6 bottom-0 h-1 rounded-full bg-linear-to-r from-blue-600 to-sky-400" aria-hidden="true" />
                </span>
                <Link to="/register" className="py-4 text-slate-800 transition hover:text-sky-600 lg:py-[clamp(9px,1.7vh,16px)]">Register</Link>
                <Link to="/forgot-password" className="py-4 text-slate-800 transition hover:text-sky-600 lg:py-[clamp(9px,1.7vh,16px)]">Reset Password</Link>
              </nav>

              <div className="mt-1 rounded-[22px] bg-white px-5 py-7 sm:px-8 lg:mt-0 lg:px-0 sm:py-8 lg:pt-[clamp(14px,2.8vh,30px)] lg:pb-[clamp(6px,1.2vh,16px)]">
                {/* No logo here: the artwork beside (or above) the form already
                    carries it large, and repeating it cost the form the height
                    it needs to show at full size on common laptop screens. */}
                <h1 className="text-center text-[32px] font-extrabold leading-tight tracking-tight text-slate-950 sm:text-[38px] lg:text-[clamp(30px,3.8vh,40px)]">
                  Welcome back!
                </h1>
                <p className="mt-1 text-center text-[16px] text-slate-500 sm:text-[17px] lg:text-[clamp(14px,1.6vh,17px)]">Sign in to your Zoiko Billing workspace.</p>

                {(localError || oauthNotice) && (
                  <div
                    role="alert"
                    className={`mt-5 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${
                      localError ? "border-red-200 bg-red-50 text-red-700" : "border-sky-200 bg-sky-50 text-sky-800"
                    }`}
                  >
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    <span>{localError || oauthNotice}</span>
                  </div>
                )}

                <div className="mt-6 space-y-3 lg:mt-[clamp(12px,2.4vh,24px)] lg:space-y-[clamp(6px,1.1vh,12px)]">
                  {PROVIDERS.map(({ key, label, Icon }) => (
                    <button
                      key={key}
                      type="button"
                      disabled={submitting}
                      onClick={() => handleProviderSignIn(key)}
                      className={providerButtonClass}
                    >
                      <Icon />
                      <span className="flex-1 text-left">{label}</span>
                      <ChevronRight size={18} className="text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-slate-700" />
                    </button>
                  ))}
                </div>

                <div className="my-6 flex items-center gap-4 text-[15px] text-slate-500 lg:my-[clamp(10px,2.2vh,24px)]">
                  <span className="h-px flex-1 bg-slate-200" />
                  or sign in with email
                  <span className="h-px flex-1 bg-slate-200" />
                </div>

                <form onSubmit={handleSubmit} noValidate className="space-y-5 lg:space-y-[clamp(10px,2vh,20px)]">
                  <div>
                    <label htmlFor="email" className="mb-2 block text-[15px] font-semibold text-slate-900 lg:mb-[clamp(4px,0.8vh,8px)]">
                      Work email
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
                    <label htmlFor="password" className="mb-2 block text-[15px] font-semibold text-slate-900 lg:mb-[clamp(4px,0.8vh,8px)]">
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
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                      >
                        {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                      </button>
                    </div>
                    {fieldErrorText(fieldErrors.password, "password-error")}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label htmlFor="remember" className="inline-flex cursor-pointer items-center gap-3 text-[15px] text-slate-800">
                      <input
                        id="remember"
                        type="checkbox"
                        checked={remember}
                        onChange={(e) => setRemember(e.target.checked)}
                        className="h-5 w-5 cursor-pointer rounded border-slate-300 accent-blue-600"
                      />
                      Remember me
                    </label>
                    <Link to="/forgot-password" className="text-[15px] font-semibold text-sky-600 hover:text-sky-700 hover:underline">
                      Forgot password?
                    </Link>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    aria-busy={submitting}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-r from-blue-600 via-sky-500 to-cyan-400 px-4 py-3.5 text-lg font-semibold text-white shadow-[0_12px_28px_-12px_rgba(14,116,244,0.8)] transition hover:brightness-105 focus:outline-none focus-visible:ring-4 focus-visible:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-60 lg:py-[clamp(9px,1.5vh,14px)]"
                  >
                    {submitting && <Loader2 size={18} className="animate-spin" />}
                    {submitting ? "Signing in…" : "Log In"}
                  </button>
                </form>

                <p className="mt-6 text-center text-[16px] text-slate-700 lg:mt-[clamp(10px,2.2vh,24px)]">
                  New to Zoiko Billing?{" "}
                  <Link to="/register" className="font-bold text-sky-600 hover:text-sky-700 hover:underline">
                    Register
                  </Link>
                </p>
              </div>
            </div>

            <footer className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4 pt-5 text-sm text-slate-500 lg:pt-[clamp(8px,1.8vh,20px)]">
              <ul className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {["Privacy", "Terms", "Accessibility", "Help"].map((item, idx) => (
                  <li key={item} className="flex items-center gap-2">
                    {idx > 0 && <span aria-hidden="true">•</span>}
                    {item}
                  </li>
                ))}
              </ul>
              <p>© {new Date().getFullYear()} Zoiko Tech Inc.</p>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}
