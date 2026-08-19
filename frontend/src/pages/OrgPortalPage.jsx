import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Building2, LogOut, UserCircle2, Loader2, AlertCircle, RefreshCw } from "lucide-react";

import { apiFetch, clearSession, getStoredUser } from "../api/client";
import { AUTH_INVALID_EVENT } from "../service/api";
import { ROLE_LABELS, ROLES } from "../config/roles";

export default function OrgPortalPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [organization, setOrganization] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [orgError, setOrgError] = useState("");
  const [retrying, setRetrying] = useState(false);

  function loadPortalData(isRetry = false) {
    if (isRetry) setRetrying(true);
    setLoading(true);
    setError("");
    setOrgError("");

    apiFetch("/api/auth/me")
      .then((me) => {
        setUser(me);
        setLoading(false);
        return apiFetch("/api/organizations/me/detail");
      })
      .then((org) => {
        setOrganization(org);
      })
      .catch((err) => {
        setLoading(false);
        setRetrying(false);
        if (err.status === 401 || err.status === 403 || err.authInvalid) {
          clearSession();
          navigate("/login", { replace: true });
          return;
        }
        if (err.status === 0 || err.message?.includes("Failed to fetch") || err.message?.includes("timed out")) {
          setError(
            "Unable to connect to the server. Please check your network connection and try again."
          );
        } else {
          setError(err.message || "Failed to load your session.");
        }
      });

    apiFetch("/api/organizations/me/detail")
      .then(setOrganization)
      .catch((err) => {
        if (err.status === 0 || err.message?.includes("Failed to fetch") || err.message?.includes("timed out")) {
          setOrgError("Unable to load organization information.");
        } else if (err.status !== 401 && err.status !== 403) {
          setOrgError(err.message || "Unable to load organization.");
        }
      });
  }

  useEffect(() => {
    loadPortalData();
  }, []);

  useEffect(() => {
    function onSessionInvalid() {
      clearSession();
      navigate("/login", { replace: true });
    }
    window.addEventListener(AUTH_INVALID_EVENT, onSessionInvalid);
    return () => window.removeEventListener(AUTH_INVALID_EVENT, onSessionInvalid);
  }, [navigate]);

  function logout() {
    clearSession();
    navigate("/login", { replace: true });
  }

  const roleLabel = user?.role ? ROLE_LABELS[user.role] || user.role : "—";

  if (loading && !retrying) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-orange-50 px-4">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={28} className="animate-spin text-indigo-500" />
          <p className="text-sm text-slate-500">Loading your portal…</p>
        </div>
      </div>
    );
  }

  if (error && !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-orange-50 px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200/80 bg-white p-8 shadow-xl text-center">
          <div className="flex justify-center mb-4">
            <div className="grid h-14 w-14 place-items-center rounded-full bg-red-50">
              <AlertCircle size={24} className="text-red-500" />
            </div>
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">Unable to load portal</h2>
          <p className="text-sm text-slate-500 mb-6">{error}</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => loadPortalData(true)}
              disabled={retrying}
              className="flex items-center gap-2 rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-600 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={retrying ? "animate-spin" : ""} />
              {retrying ? "Retrying…" : "Retry"}
            </button>
            <button
              onClick={logout}
              className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-orange-50 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2">
          <span
            className="grid h-10 w-10 place-items-center rounded-lg text-lg font-bold italic text-white"
            style={{ background: "linear-gradient(135deg, #f97316 40%, #3b82f6 100%)" }}
          >
            1
          </span>
          <span className="text-lg font-bold tracking-tight text-slate-900">Zoiko Billing</span>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-8 shadow-xl shadow-slate-900/[0.04]">
          <div className="flex justify-center">
            <div className="grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/25">
              <UserCircle2 size={32} className="text-white" />
            </div>
          </div>

          <h1 className="mt-5 text-center text-xl font-semibold tracking-tight text-slate-900">
            Welcome, {user?.first_name || "there"}
          </h1>
          <p className="mt-1 text-center text-sm text-slate-500">{user?.email || ""}</p>

          <div className="mt-6 space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Role</span>
              <span className="inline-block rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
                {roleLabel}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Organization</span>
              <span className="flex items-center gap-1.5 font-medium text-slate-700">
                <Building2 size={14} className="text-slate-400" />
                {organization?.name || user?.organization_code || "—"}
              </span>
            </div>
          </div>

          {orgError && (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
              <AlertCircle size={14} className="text-amber-500 mt-0.5 flex-shrink-0" />
              <span className="text-xs text-amber-700">{orgError}</span>
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              <AlertCircle size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
              <span className="text-xs text-red-700">{error}</span>
            </div>
          )}

          <p className="mt-6 text-center text-xs leading-relaxed text-slate-400">
            Your billing workspace is ready. Your organization admin can invite you to manage
            customers, invoices and subscriptions.
          </p>

          {(user?.role === ROLES.ORG_ADMIN || user?.role === ROLES.BILLING_ADMIN) && (
            <Link
              to="/billing"
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 px-4 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:from-indigo-600 hover:to-violet-700"
            >
              Go to Billing
            </Link>
          )}

          <button
            onClick={logout}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
