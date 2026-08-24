import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Settings2,
  RefreshCw,
  Code2,
  Database,
  ServerCog,
  EyeOff,
  HelpCircle,
} from "lucide-react";
import { getConfigurationInventory } from "../../service/commandCenterService";
import { PageHeader, Button } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";

/**
 * Phase 4 (G-03) — Configuration Governance. One authoritative inventory of
 * everything that governs this control plane, composed server-side from the
 * three real sources that exist:
 *
 *   1. DB-backed platform settings (mutations audited since Phase 4);
 *   2. code-declared operational thresholds, imported LIVE from the modules
 *      that enforce them — this view cannot drift from enforcement;
 *   3. environment capability status (CONFIGURED / NOT_CONFIGURED presence
 *      only — secret values are never exposed).
 *
 * Honesty rules rendered here: UNKNOWN actor/date means no recorded evidence
 * exists; masked values can never be revealed back through the API.
 */

const CATEGORY_META = {
  platform_setting: {
    label: "Platform Settings",
    icon: Database,
    blurb:
      "Mutable rows in platform_settings. Every change now requires the platform_config.manage capability and is written to the platform audit trail in the same transaction.",
    badge: "bg-indigo-100 text-indigo-700",
  },
  operational_threshold: {
    label: "Operational Thresholds (Code Baselines)",
    icon: Code2,
    blurb:
      "Imported live from the owning modules at read time. Read-only here: changing a threshold means changing the code that enforces it, through review.",
    badge: "bg-slate-200 text-slate-700",
  },
  environment_capability: {
    label: "Environment Capabilities",
    icon: ServerCog,
    blurb:
      "Deployment-dependent integrations report presence only — CONFIGURED or NOT_CONFIGURED. Secret values are never exposed by any endpoint.",
    badge: "bg-cyan-100 text-cyan-800",
  },
};

function UnknownChip({ title }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500"
      title={title}
    >
      <HelpCircle size={11} /> UNKNOWN
    </span>
  );
}

function EntryRow({ entry, isFirst }) {
  const valueCell = () => {
    if (entry.value_kind === "masked") {
      return (
        <span
          className="inline-flex items-center gap-1 font-mono text-xs text-slate-500"
          title="Sensitive value — masked on every read; write-only via settings"
        >
          <EyeOff size={12} /> {entry.value}
        </span>
      );
    }
    if (entry.value_kind === "status") {
      return (
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
            entry.value === "CONFIGURED"
              ? "bg-emerald-100 text-emerald-700"
              : "bg-amber-100 text-amber-800"
          }`}
        >
          {entry.value}
        </span>
      );
    }
    if (entry.value == null) {
      return <UnknownChip title="No recorded evidence exists for this field." />;
    }
    const asText = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
    return <span className="font-mono text-xs text-slate-800">{asText}</span>;
  };

  return (
    <div
      className={`flex flex-wrap items-start justify-between gap-x-6 gap-y-2 p-4 ${
        isFirst ? "" : "border-t border-slate-100"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
          <span className="font-mono">{entry.name}</span>
          {entry.is_sensitive && (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">
              SENSITIVE
            </span>
          )}
          {!entry.mutable && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
              READ-ONLY
            </span>
          )}
        </p>
        <p className="mt-1 text-xs text-slate-500">{entry.description || entry.source}</p>
        <p className="mt-0.5 text-[10px] text-slate-400">{entry.source}</p>
      </div>
      <div className="flex flex-col items-start gap-1 sm:min-w-[220px] sm:items-end">
        {valueCell()}
        <div className="flex flex-wrap items-center justify-start gap-x-3 gap-y-1 text-[10px] text-slate-500 sm:justify-end">
          <span>
            Updated by:{" "}
            {entry.updated_by ? (
              <strong className="text-slate-700">{entry.updated_by}</strong>
            ) : (
              <UnknownChip title="No recorded actor exists — not fabricated." />
            )}
          </span>
          <span>
            At:{" "}
            {entry.last_updated_at ? (
              new Date(entry.last_updated_at).toLocaleString()
            ) : (
              <UnknownChip title="No recorded timestamp exists." />
            )}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-bold text-slate-600">
            {entry.audit_status}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function ConfigurationGovernancePage() {
  const [inventory, setInventory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getConfigurationInventory()
      .then((res) => setInventory(res))
      .catch((e) => setError(e?.message || "Failed to load configuration inventory."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
    const map = { platform_setting: [], operational_threshold: [], environment_capability: [] };
    for (const entry of inventory?.entries ?? []) {
      (map[entry.category] ??= []).push(entry);
    }
    for (const list of Object.values(map)) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [inventory]);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Configuration Governance"
        description="One authoritative inventory of the configuration that governs this control plane: DB-backed platform settings (audited mutations), code-declared operational thresholds imported live from their enforcing modules, and environment capability status (presence only). UNKNOWN means no recorded evidence exists — never a guess."
        icon={Settings2}
        meta={
          inventory?.generated_at
            ? `Generated ${new Date(inventory.generated_at).toLocaleString()}`
            : null
        }
        actions={
          <Button variant="secondary" icon={RefreshCw} onClick={load} loading={loading}>
            Refresh
          </Button>
        }
      />

      {inventory?.honesty_notes?.length > 0 && (
        <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50 p-4 text-xs text-blue-800">
          <p className="font-bold">How to read this page</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {inventory.honesty_notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 space-y-6">
        {loading && !inventory ? (
          <Spinner />
        ) : error ? (
          <ErrorState
            message={
              error ||
              "Reading configuration requires the platform_config.read capability."
            }
            onRetry={load}
            title="Unable to load configuration governance"
          />
        ) : (
          Object.entries(CATEGORY_META).map(([category, meta]) => {
            const entries = grouped[category] ?? [];
            const Icon = meta.icon;
            const count = inventory?.summary?.[category] ?? entries.length;
            return (
              <div
                key={category}
                className="rounded-3xl border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.02)]"
              >
                <div className="border-b border-slate-100 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-800">
                      <span className={`rounded-xl p-1.5 ${meta.badge}`}>
                        <Icon size={15} />
                      </span>
                      {meta.label}
                    </h3>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">
                      {count} entr{count === 1 ? "y" : "ies"}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-slate-500">{meta.blurb}</p>
                </div>
                {entries.length === 0 ? (
                  <p className="p-5 text-xs text-slate-500">None present.</p>
                ) : (
                  entries.map((entry, idx) => (
                    <EntryRow key={`${category}-${entry.name}`} entry={entry} isFirst={idx === 0} />
                  ))
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
