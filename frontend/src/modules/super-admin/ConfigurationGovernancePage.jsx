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
import { PageHeader, Button, SectionCard } from "../../components/billing-ui";
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

/**
 * "Updated by" and "At" only mean something for values that were actually
 * written somewhere. Code-declared thresholds live in source files and
 * environment capabilities are read from the process environment — neither was
 * ever "updated" by an actor, so labelling them UNKNOWN claimed missing
 * evidence where in fact the field is not applicable. That is the same
 * dishonesty UNKNOWN exists to prevent, just pointed the other way.
 */
const PROVENANCE = {
  platform_setting: {
    actor: null, // unknown means unknown
    at: null,
  },
  operational_threshold: {
    actor: "Code-declared",
    at: "Declared in source",
  },
  environment_capability: {
    actor: "Environment-derived",
    at: "Read from environment",
  },
};

function ProvenanceCell({ category, field, children, title }) {
  const label = PROVENANCE[category]?.[field];
  if (label) {
    return <span className="text-[10px] font-semibold text-slate-500">{label}</span>;
  }
  return children;
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
            <ProvenanceCell category={entry.category} field="actor">
              {entry.updated_by ? (
                <strong className="text-slate-700">{entry.updated_by}</strong>
              ) : (
                <UnknownChip title="No recorded actor exists — not fabricated." />
              )}
            </ProvenanceCell>
          </span>
          <span>
            At:{" "}
            <ProvenanceCell category={entry.category} field="at">
              {entry.last_updated_at ? (
                new Date(entry.last_updated_at).toLocaleString()
              ) : (
                <UnknownChip title="No recorded timestamp exists." />
              )}
            </ProvenanceCell>
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-bold text-slate-600">
            {entry.audit_status}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function ConfigurationGovernancePage({ embedded = false } = {}) {
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
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      {embedded ? (
        // Embedded as a tab of the Audit & Evidence hub: the hub renders the
        // tab-aware PageHeader itself, so this page suppresses its own (which
        // would otherwise stack a second header directly beneath the hub's).
        // The refresh action and the "generated at" stamp lived in that header,
        // so they are repeated here rather than dropped.
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            {inventory?.generated_at
              ? `Generated ${new Date(inventory.generated_at).toLocaleString()}`
              : "Inventory not generated yet."}
          </p>
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={load} loading={loading}>
            Refresh
          </Button>
        </div>
      ) : (
        <PageHeader
          title="Configuration Governance"
          description="One authoritative inventory of the configuration that governs this control plane: DB-backed platform settings (audited mutations), code-declared operational thresholds imported live from their enforcing modules, and environment capability status (presence only). UNKNOWN means no recorded evidence exists — never a guess."
          icon={Settings2}
          accent="slate"
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
      )}

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

      <div className={embedded ? "space-y-6" : "mt-6 space-y-6"}>
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
              <SectionCard
                key={category}
                variant="standard"
                accent="slate"
                icon={Icon}
                title={meta.label}
                description={meta.blurb}
                actions={
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">
                    {count} entr{count === 1 ? "y" : "ies"}
                  </span>
                }
              >
                {entries.length === 0 ? (
                  <p className="text-xs text-slate-500">None present.</p>
                ) : (
                  entries.map((entry, idx) => (
                    <EntryRow key={`${category}-${entry.name}`} entry={entry} isFirst={idx === 0} />
                  ))
                )}
              </SectionCard>
            );
          })
        )}
      </div>
    </div>
  );
}
