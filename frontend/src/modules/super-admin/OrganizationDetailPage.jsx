import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Building2, ShieldCheck, Settings2, UserCheck, KeyRound, History, Power, Trash2, Pencil } from "lucide-react";
import {
  getCommercialOrganizationDetail,
  getOrganizationProfile,
  setOrganizationStatus,
  deleteOrganization,
  updateBillingClassification,
} from "../../service/commercialService";
import { PageHeader, DataTable, Modal, Field, Select, Button } from "../../components/billing-ui";
import { StatusBadge, ErrorState, PageSkeleton, EmptyState, SuccessMessage, useConfirmationDialog } from "../../components/billing-shared";
import {
  ACCOUNT_STATUS_OPTIONS,
  PLAN_STATUS_OPTIONS,
  SUBSCRIPTION_STATUS_OPTIONS,
  COMMERCIAL_CLASSIFICATION_OPTIONS,
  formatDateTime,
  formatDateOnly,
  displayValue,
  formatFeatureList,
  CommercialSourceBadge,
  CommercialClassificationBadge,
} from "./constants";

function ChangeClassificationModal({ open, onClose, currentValue, onSaved }) {
  const [value, setValue] = useState(currentValue || "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setValue(currentValue || "");
      setReason("");
      setError(null);
    }
  }, [open, currentValue]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await onSaved(value, reason);
      if (updated !== false) onClose();
    } catch (err) {
      setError(err?.message || "Failed to update billing classification.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Change billing classification" icon={ShieldCheck} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-xs text-slate-500">
          Per ZB-COM-BILL-001 Table 9 — only Commercial Standalone may create a live standalone commercial charge.
          This change is audited with a required reason and an effective timestamp.
        </p>
        <Field label="New classification" htmlFor="new-classification" required>
          <Select id="new-classification" value={value} onChange={setValue} options={COMMERCIAL_CLASSIFICATION_OPTIONS} placeholder="Select…" />
        </Field>
        <Field label="Reason" htmlFor="classification-reason" required hint="Required for the audit record.">
          <textarea
            id="classification-reason"
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!value || !reason}>Save change</Button>
        </div>
      </form>
    </Modal>
  );
}

function InfoRow({ label, value, className = "" }) {
  return (
    <div className={`flex items-start justify-between gap-4 border-b border-slate-100 py-2.5 last:border-0 ${className}`}>
      <span className="shrink-0 text-xs font-medium text-slate-400">{label}</span>
      <span className="text-right text-sm font-medium text-slate-700">{value}</span>
    </div>
  );
}

function SectionCard({ icon: Icon, title, subtitle, children, action, className = "" }) {
  return (
    <div className={`rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)] ${className}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <Icon size={17} />
          </span>
          <div>
            <h2 className="text-base font-bold text-slate-800">{title}</h2>
            {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function OrganizationDetailPage() {
  const { organizationId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [classificationModalOpen, setClassificationModalOpen] = useState(false);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, p] = await Promise.all([
        getCommercialOrganizationDetail(organizationId).catch((e) => {
          throw new Error(e?.message || "Failed to load commercial organization detail.");
        }),
        getOrganizationProfile(organizationId).catch(() => null),
      ]);
      setDetail(d);
      setProfile(p);
    } catch (err) {
      setError(err?.message || "Failed to load organization.");
      setDetail(null);
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    load();
  }, [load]);

  const orgName = detail?.organization_name || profile?.organization_name || `Organization #${organizationId}`;
  const orgCode = detail?.organization_code || profile?.organization_code || "—";

  const handleToggleStatus = useCallback(async () => {
    const suspending = detail?.is_active;
    const ok = await confirm({
      title: suspending ? "Suspend organization?" : "Activate organization?",
      message: suspending
        ? `"${orgName}" will immediately lose access to the platform. This is reversible — you can activate it again at any time.`
        : `"${orgName}" will regain access to the platform immediately.`,
      confirmLabel: suspending ? "Suspend" : "Activate",
      tone: suspending ? "danger" : "default",
    });
    if (!ok) return;

    setActionBusy(true);
    setActionError(null);
    try {
      await setOrganizationStatus(organizationId, !suspending);
      setNotice(suspending ? "Organization suspended." : "Organization activated.");
      await load();
    } catch (err) {
      setActionError(err?.message || "Failed to update organization status.");
    } finally {
      setActionBusy(false);
    }
  }, [confirm, detail, orgName, organizationId, load]);

  const handleClassificationChange = useCallback(
    async (newClassification, reason) => {
      setActionError(null);
      try {
        await updateBillingClassification(organizationId, newClassification, reason);
        setNotice(`Billing classification changed to "${newClassification}".`);
        await load();
      } catch (err) {
        throw new Error(err?.message || "Failed to update billing classification.");
      }
    },
    [organizationId, load]
  );

  const handleDelete = useCallback(async () => {
    const ok = await confirm({
      title: "Delete organization?",
      message: `This permanently hard-deletes "${orgName}" (${orgCode}) and ALL of its data — users, customers, invoices, payments. This cannot be undone.`,
      confirmLabel: "Delete permanently",
      tone: "danger",
      confirmationValue: orgCode,
    });
    if (!ok) return;

    setActionBusy(true);
    setActionError(null);
    try {
      await deleteOrganization(organizationId);
      navigate("/super-admin/organizations", {
        replace: true,
        state: { notice: `Organization "${orgName}" and all of its data were deleted.` },
      });
    } catch (err) {
      setActionError(err?.message || "Failed to delete organization.");
      setActionBusy(false);
    }
  }, [confirm, organizationId, orgName, orgCode, navigate]);

  const entitlements = useMemo(() => {
    const raw = detail?.entitlements || {};
    return {
      plan: raw.plan || null,
      limits: raw.limits || {},
      features: formatFeatureList(raw.features),
    };
  }, [detail]);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader title="Organization" icon={Building2} />
        <div className="mt-6"><PageSkeleton rows={8} /></div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader title="Organization" icon={Building2} />
        <div className="mt-6 rounded-3xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={load} title="Unable to load organization" />
        </div>
      </div>
    );
  }

  const profileRow = (label, value) => (
    <InfoRow label={label} value={displayValue(value)} />
  );

  const subscription = detail.current_subscription || null;
  const plan = detail.plan || null;
  const billingConfig = detail.billing_configuration || null;
  const historyColumns = [
    {
      key: "plan",
      label: "Plan",
      render: (row) => (
        <span>
          <span className="block font-semibold text-slate-800">{row.plan_name}</span>
          <span className="block text-xs text-slate-400">{row.plan_code}</span>
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (row) => <StatusBadge status={row.status} options={SUBSCRIPTION_STATUS_OPTIONS} />,
    },
    {
      key: "period",
      label: "Period",
      render: (row) => (
        <span className="text-xs text-slate-600">
          {formatDateOnly(row.start_at)} — {formatDateOnly(row.end_at)}
        </span>
      ),
    },
    {
      key: "current_period",
      label: "Current Period",
      render: (row) => (
        <span className="text-xs text-slate-600">
          {formatDateOnly(row.current_period_start)} — {formatDateOnly(row.current_period_end)}
        </span>
      ),
    },
    {
      key: "created_at",
      label: "Created",
      render: (row) => <span className="text-xs text-slate-500">{formatDateTime(row.created_at)}</span>,
    },
    {
      key: "updated_at",
      label: "Updated",
      render: (row) => <span className="text-xs text-slate-500">{formatDateTime(row.updated_at)}</span>,
    },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        crumbs={[
          { label: "Organizations", href: "/super-admin/organizations" },
          { label: orgCode },
        ]}
        title={orgName}
        description={`Organization ${orgCode} · consolidated commercial plane view`}
        icon={Building2}
        meta={detail ? `Commercial account status: ${detail.account?.status || "—"} · Can charge: ${detail.can_charge ? "Yes" : "No"}` : null}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleToggleStatus}
              disabled={actionBusy}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                detail.is_active
                  ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
              }`}
            >
              <Power size={15} />
              {detail.is_active ? "Suspend" : "Activate"}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={actionBusy}
              className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        }
      />

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice(null)} /></div>}
      {actionError && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {actionError}
        </div>
      )}
      {ConfirmationDialog}
      <ChangeClassificationModal
        open={classificationModalOpen}
        currentValue={detail.billing_classification}
        onClose={() => setClassificationModalOpen(false)}
        onSaved={handleClassificationChange}
      />

      <div className="mt-6 space-y-6">
        <div className="grid gap-6 lg:grid-cols-3">
          <SectionCard icon={Building2} title="Organization Identity" subtitle="Profile data (super-admin scope)" className="lg:col-span-2">
            <div className="grid gap-x-8 gap-y-0 sm:grid-cols-2">
              <div>
                {profileRow("Organization name", profile?.organization_name)}
                {profileRow("Display name", profile?.display_name)}
                {profileRow("Legal name", profile?.legal_name)}
                {profileRow("Industry", profile?.industry)}
                {profileRow("Email", profile?.email)}
                {profileRow("Phone", profile?.phone)}
                {profileRow("Website", profile?.website)}
              </div>
              <div>
                {profileRow("Address", profile?.address)}
                {profileRow("City", profile?.city)}
                {profileRow("State", profile?.state)}
                {profileRow("Country", profile?.country)}
                {profileRow("Postal code", profile?.postal_code)}
                {profileRow("Currency", profile?.currency)}
                {profileRow("Timezone", profile?.timezone)}
                {profileRow("Registration number", profile?.registration_number)}
                {profileRow("Tax number", profile?.tax_no)}
                {profileRow("Fiscal year", profile?.fiscal_year_start ? `${profile?.fiscal_year_start} — ${profile?.fiscal_year_end}` : "—")}
              </div>
            </div>
          </SectionCard>

          <SectionCard
            icon={ShieldCheck}
            title="Commercial Classification"
            subtitle="Billing source is server-stamped; classification is Super-Admin controlled"
            action={
              <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setClassificationModalOpen(true)}>
                Change
              </Button>
            }
          >
            <InfoRow label="Billing source" value={<CommercialSourceBadge value={detail.billing_source} />} />
            <InfoRow label="Classification" value={<CommercialClassificationBadge value={detail.billing_classification} />} />
            <InfoRow label="Account status" value={<StatusBadge status={detail.account?.status} options={ACCOUNT_STATUS_OPTIONS} />} />
            <InfoRow
              label="Chargeable (standalone)"
              value={
                detail.can_charge ? (
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">Can charge</span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">Disabled</span>
                )
              }
            />
            <InfoRow label="Organization active" value={detail.is_active ? "Yes" : "No"} />
            <InfoRow label="Account ID" value={displayValue(detail.account?.id)} />
          </SectionCard>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <SectionCard icon={Settings2} title="Billing Configuration" subtitle="Operational settings (Billing module)">
            {billingConfig ? (
              <>
                <InfoRow label="Company name" value={displayValue(billingConfig.company_name)} />
                <InfoRow label="Default currency" value={displayValue(billingConfig.default_currency)} />
                <InfoRow label="Timezone" value={displayValue(billingConfig.timezone)} />
                <InfoRow label="Language" value={displayValue(billingConfig.language)} />
                <InfoRow label="Invoice prefix" value={displayValue(billingConfig.invoice_prefix)} />
                <InfoRow label="Tax number" value={displayValue(billingConfig.tax_number)} />
              </>
            ) : (
              <EmptyState
                icon={Settings2}
                title="No billing configuration"
                message="This organization has no operational billing configuration yet."
              />
            )}
          </SectionCard>

          <SectionCard icon={UserCheck} title="Commercial Subscription & Plan" subtitle="Current open subscription (if any)">
            {subscription && plan ? (
              <>
                <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                  <div>
                    <p className="text-base font-bold text-slate-800">{plan.plan_name}</p>
                    <p className="text-xs text-slate-400">{plan.plan_code}</p>
                  </div>
                  <StatusBadge status={subscription.status} options={SUBSCRIPTION_STATUS_OPTIONS} />
                </div>
                <InfoRow label="Plan status" value={<StatusBadge status={plan.status} options={PLAN_STATUS_OPTIONS} />} />
                <InfoRow label="Default plan" value={plan.is_default ? "Yes" : "No"} />
                <InfoRow label="Billing interval" value={displayValue(plan.billing_interval)} />
                <InfoRow label="Currency" value={displayValue(plan.currency)} />
                <InfoRow label="Price" value={plan.price_amount === null || plan.price_amount === undefined ? "—" : `${plan.currency || "USD"} ${Number(plan.price_amount).toLocaleString()}`} />
                <InfoRow label="Effective" value={plan.effective_from ? `${formatDateOnly(plan.effective_from)} — ${formatDateOnly(plan.effective_to)}` : "—"} />
                <InfoRow label="Period" value={`${formatDateOnly(subscription.start_at)} — ${formatDateOnly(subscription.end_at)}`} />
                <InfoRow label="Current period" value={`${formatDateOnly(subscription.current_period_start)} — ${formatDateOnly(subscription.current_period_end)}`} />
                <InfoRow label="Subscription ID" value={displayValue(subscription.id)} />
              </>
            ) : (
              <EmptyState
                icon={UserCheck}
                title="No active commercial subscription"
                message="This organization has no current open subscription. Assign one from the Commercial Subscriptions page."
                actionLabel="Assign subscription"
                onAction={() => navigate("/super-admin/commercial/subscriptions")}
              />
            )}
          </SectionCard>
        </div>

        <SectionCard icon={KeyRound} title="Entitlements" subtitle="Read-only view from the current open subscription's plan">
          {entitlements.plan ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Limits</p>
                <InfoRow label="Max users" value={displayValue(entitlements.limits?.max_users)} />
                <InfoRow label="Max storage (GB)" value={displayValue(entitlements.limits?.max_storage_gb)} />
                <p className="mt-2 text-xs text-slate-400">
                  Missing (—) values are unset, not unlimited. No limits are enforced until a future phase wires entitlements into tenant modules.
                </p>
              </div>
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Features</p>
                {entitlements.features && entitlements.features.length > 0 ? (
                  entitlements.features.map(({ key, value }) => (
                    <div key={key} className="flex items-start justify-between gap-4 border-b border-slate-100 py-2.5 last:border-0">
                      <span className="text-xs font-medium text-slate-400">{key}</span>
                      <span className="text-sm font-medium text-slate-700">{displayValue(value)}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-500">No features declared on the current plan.</p>
                )}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={KeyRound}
              title="No entitlements yet"
              message="Entitlements are resolved from the current open subscription's plan. Nothing is entitled while no open subscription exists."
            />
          )}
        </SectionCard>

        <SectionCard icon={History} title="Subscription History" subtitle="All commercial subscriptions, including terminal ones">
          <DataTable
            columns={historyColumns}
            data={detail.subscription_history || []}
            loading={false}
            emptyTitle="No subscription history"
            emptyMessage="No commercial subscriptions have been created for this organization yet."
            minWidth={720}
          />
        </SectionCard>
      </div>
    </div>
  );
}
