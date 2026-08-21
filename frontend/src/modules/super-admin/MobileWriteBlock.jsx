import React from "react";
import { MonitorSmartphone } from "lucide-react";

/**
 * ZB-SA-CMD-003 §17 — the notice rendered IN PLACE of privileged write
 * actions on viewports below 768px. The action is not merely disabled: it is
 * replaced with an explanation, so a small-screen operator understands the
 * control exists and why it is unavailable here (accidental engagement on a
 * cramped touchscreen is exactly the failure mode the spec calls out).
 */
export default function MobileWriteBlock({ action = "this action" }) {
  return (
    <div
      role="note"
      aria-label="Action requires a desktop viewport"
      className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <MonitorSmartphone size={18} className="mt-0.5 shrink-0" />
      <p>
        <span className="font-semibold">{action.charAt(0).toUpperCase() + action.slice(1)} requires a desktop viewport.</span>{" "}
        For safety, breaker engagement and other privileged write actions are blocked on screens narrower than 768px.
        You can still review state here — switch to a desktop to make changes.
      </p>
    </div>
  );
}
