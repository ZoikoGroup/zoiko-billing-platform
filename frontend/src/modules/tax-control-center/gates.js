// The seven market launch gates (handoff §13.2) and the rules the backend
// applies when a market availability version is validated
// (policy_service.MarketAvailabilityService.errors / mandatory_gates).
// Shown to the user as they edit; the backend remains the authority.

export const GATES = [
  { key: "LEGAL_AUTHORITY_AND_USAGE_RIGHTS", no: "01", label: "Legal authority and usage rights" },
  { key: "SOURCE_PROVENANCE_AND_FRESHNESS", no: "02", label: "Source provenance and freshness" },
  { key: "RESOLUTION_AND_DETERMINATION_TESTS", no: "03", label: "Resolution and determination tested" },
  { key: "GOLDEN_TESTS_SIGNED_OFF", no: "04", label: "Golden tests signed off" },
  { key: "PROVIDER_CONTRACTS_AND_RECOVERY", no: "05", label: "Provider contract, SLA, failure and recovery" },
  { key: "UI_AND_AUDIT_EVIDENCE", no: "06", label: "UI explains states; audit evidence exportable" },
  { key: "AVAILABILITY_REGISTRY_UPDATED", no: "07", label: "Availability registry updated and visible" },
];

export const GATE_STATUSES = ["NOT_STARTED", "PASSED", "FAILED", "NOT_APPLICABLE"];
export const MODES = ["REFERENCE_ONLY", "TENANT_CONFIG_APPROVED", "NATIVE_RULEPACK_APPROVED", "PROVIDER_APPROVED",
                      "UNSUPPORTED", "SUSPENDED"];
export const CALCULATING_MODES = ["TENANT_CONFIG_APPROVED", "NATIVE_RULEPACK_APPROVED", "PROVIDER_APPROVED"];
export const TRANSACTION_CLASSES = ["B2B_SERVICES", "B2C_SERVICES", "B2B_DIGITAL", "B2C_DIGITAL", "B2B_GOODS", "B2C_GOODS"];

const MANDATORY = ["LEGAL_AUTHORITY_AND_USAGE_RIGHTS", "SOURCE_PROVENANCE_AND_FRESHNESS", "GOLDEN_TESTS_SIGNED_OFF"];

/** Gates that must be PASSED for this mode (G1: gate 05 for provider markets). */
export function mandatoryGates(mode) {
  if (!CALCULATING_MODES.includes(mode)) return [];
  return mode === "PROVIDER_APPROVED" ? [...MANDATORY, "PROVIDER_CONTRACTS_AND_RECOVERY"] : MANDATORY;
}

export function emptyGates() {
  return Object.fromEntries(GATES.map((g) => [g.key, { status: "NOT_STARTED", evidence_ref: "", notes: "" }]));
}

/**
 * Per gate, what the backend will say about it for this mode:
 * { [gateKey]: [problem, ...] }. Empty arrays mean the gate is fine.
 */
export function gateProblems(mode, gates) {
  const required = mandatoryGates(mode);
  const calculating = CALCULATING_MODES.includes(mode);
  const out = {};
  for (const g of GATES) {
    const entry = gates?.[g.key] || {};
    const problems = [];
    const status = entry.status || "NOT_STARTED";
    if (status === "PASSED" && !String(entry.evidence_ref || "").trim()) problems.push("Passed needs an evidence reference.");
    if (status === "NOT_APPLICABLE" && !String(entry.notes || "").trim()) problems.push("Not applicable needs a note saying why.");
    if (required.includes(g.key) && status !== "PASSED") {
      problems.push(g.key === "PROVIDER_CONTRACTS_AND_RECOVERY"
        ? "A provider market requires this gate PASSED; it can't be marked not applicable."
        : `A ${mode} market requires this gate PASSED.`);
    } else if (calculating && !required.includes(g.key) && !["PASSED", "NOT_APPLICABLE"].includes(status)) {
      problems.push("A calculating market requires this gate PASSED or not applicable.");
    }
    out[g.key] = problems;
  }
  return out;
}
