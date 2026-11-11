import { useEffect, useId, useState } from "react";

import { Field, Select } from "../../components/billing-ui";
import { RateLookup } from "../tax-control-center/RateLookup";
import { MUTED, PANEL, STRONG, humanize } from "../tax-control-center/shared";
import { fetchAllPages } from "../tax-control-center/taxRegistryService";
import { SectionTitle } from "./common";
import { listActivations, listCoverage, listJurisdictions, listLegalEntities, lookupReferenceRates } from "./governanceService";

/* T9 Reference rates (Phase 5c PR 3; Phase 8 PR 6): the platform's published
 * reference rates, read-only, for any tenant tax role. Every rate is badged
 * "Reference only" with its source. For the chosen jurisdiction two separate
 * facts are shown: what Zoiko supports there, and whether your selected
 * seller entity is activated. Nothing here implies guaranteed compliance: an
 * invoice's tax always comes from its own quote. */

const CALCULATING = {
  NATIVE_RULEPACK_APPROVED: "Zoiko calculates this market (native rule pack)",
  PROVIDER_APPROVED: "Zoiko calculates this market (provider)",
  TENANT_CONFIG_APPROVED: "Calculated from your organization's own approved rate",
};

export function zoikoSupport(coverage, jurisdiction) {
  const modes = new Set(coverage.filter((c) => c.jurisdiction_code === jurisdiction?.code).map((c) => c.mode));
  const calculating = Object.keys(CALCULATING).filter((m) => modes.has(m)).map((m) => CALCULATING[m]);
  if (calculating.length) return calculating.join("; ");
  if ((jurisdiction?.billing_clearance || "").startsWith("Research only")) return "Research only";
  return "Reference only";
}

export function entityStatus(activations, jurisdictionId, onDate) {
  const active = activations.filter((a) => a.jurisdiction_id === jurisdictionId && a.status === "APPROVED"
    && (!a.effective_from || a.effective_from <= onDate) && (!a.effective_to || onDate < a.effective_to));
  if (!active.length) return "Not activated";
  return `Activated (${[...new Set(active.map((a) => humanize(a.mode)))].join(", ")})`;
}

function Facts({ result, jurisdiction, coverage, entityId, entities }) {
  const [activations, setActivations] = useState(null);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    if (!entityId) return;
    setActivations(null);
    setProblem(null);
    fetchAllPages(({ cursor }) => listActivations({ seller_entity_id: Number(entityId), cursor }))
      .then(setActivations)
      .catch((err) => setProblem(err?.status === 403 ? "Your role can't see activations." : "Couldn't load activations."));
  }, [entityId]);
  const entity = entities.find((e) => String(e.id) === String(entityId));
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2" aria-label="Support and activation">
      <div>
        <dt className={`text-xs font-semibold uppercase tracking-wider ${MUTED}`}>Zoiko support</dt>
        <dd className={STRONG}>{coverage ? zoikoSupport(coverage, jurisdiction) : "Loading…"}</dd>
      </div>
      <div>
        <dt className={`text-xs font-semibold uppercase tracking-wider ${MUTED}`}>Your entity{entity ? ` (${entity.legal_name})` : ""}</dt>
        <dd className={STRONG}>
          {!entityId ? "Choose a seller entity" : problem || (activations
            ? entityStatus(activations, result.jurisdiction?.id, result.as_of) : "Loading…")}
        </dd>
      </div>
    </dl>
  );
}

export function ReferenceRatesScreen() {
  const id = useId();
  const [coverage, setCoverage] = useState(null);
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState("");
  const [found, setFound] = useState(null);
  useEffect(() => {
    fetchAllPages(listCoverage).then(setCoverage).catch(() => setCoverage([]));
    fetchAllPages(listLegalEntities).then((rows) => {
      setEntities(rows);
      const preferred = rows.find((e) => e.is_default) || rows[0];
      if (preferred) setEntityId(String(preferred.id));
    }).catch(() => setEntities([]));
  }, []);
  return (
    <section className={PANEL} aria-labelledby="t9-title">
      <SectionTitle id="t9-title" title="Reference rates">
        Rates the platform has published from official sources, for reference only. An invoice's tax always comes from
        its own quote. Where no rate is approved, tax is not determined, never 0%.
      </SectionTitle>
      {entities.length > 0 && (
        <div className="mb-3 w-72">
          <Field label="Seller entity" htmlFor={`${id}-e`}>
            <Select id={`${id}-e`} value={entityId} onChange={setEntityId} placeholder="" aria-label="Seller entity"
                    options={entities.map((e) => ({ value: String(e.id), label: e.legal_name || e.entity_code }))} />
          </Field>
        </div>
      )}
      <RateLookup listJurisdictions={listJurisdictions} lookupRates={lookupReferenceRates} idPrefix="t9" tenantView
                  onResult={(result, jurisdiction) => setFound({ result, jurisdiction })}>
        {found && (
          <Facts result={found.result} jurisdiction={found.jurisdiction} coverage={coverage} entityId={entityId}
                 entities={entities} />
        )}
      </RateLookup>
    </section>
  );
}
