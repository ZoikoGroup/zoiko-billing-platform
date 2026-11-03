import React from "react";
import { Building2 } from "lucide-react";
import { useCommandCenter } from "../context/CommandCenterContext";

/**
 * Thin strip under the top bar on every /super-admin/* route (BillingShell).
 *
 * The attention banner it used to carry (P0–P3 counts, SLA breaches, job
 * freshness, "Open queue →") was removed at the user's request — those
 * signals remain on the Triage & Attention page and the notifications bell.
 *
 * What remains is the privileged-access scope notice (ZB-SA-CMD-003 §6:
 * "you are acting in the context of tenant X" must be visible everywhere,
 * not on one page). It renders only while a support-access grant is active.
 */
// expires_at arrives as a naive UTC datetime (no "Z"); read it as UTC so the
// tooltip isn't shifted by the viewer's UTC offset.
function expiryLabel(value) {
  if (!value) return "its expiry";
  const text = String(value);
  const date = new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? "its expiry" : date.toLocaleTimeString();
}

export default function TriageStrip() {
  const { activeGrant } = useCommandCenter();
  if (!activeGrant) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-indigo-200 bg-indigo-50 px-4 py-1.5 text-xs font-semibold text-indigo-800 sm:px-6"
      title={`Privileged access to organization #${activeGrant.organization_id} is ACTIVE until ${expiryLabel(activeGrant.expires_at)}`}
    >
      <Building2 size={13} className="shrink-0" />
      <span className="min-w-0 truncate">Support access active — scope: organization #{activeGrant.organization_id}</span>
    </div>
  );
}
