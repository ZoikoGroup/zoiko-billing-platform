import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { useCommandCenter } = vi.hoisted(() => ({ useCommandCenter: vi.fn() }));
vi.mock("../context/CommandCenterContext", () => ({ useCommandCenter }));

import TriageStrip from "./TriageStrip";

describe("TriageStrip", () => {
  it("no longer shows the attention banner, even with open items and SLA breaches", () => {
    useCommandCenter.mockReturnValue({
      attentionCounts: { p0: 0, p1: 1, p2: 0, p3: 0, total_open: 1, sla_breaches: 1 },
      activeGrant: null,
      worstFreshness: "unknown",
    });
    const { container } = render(<TriageStrip />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/attention/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/open queue/i)).not.toBeInTheDocument();
  });

  it("still shows the privileged-access scope while support access is active", () => {
    useCommandCenter.mockReturnValue({
      attentionCounts: { total_open: 1 },
      activeGrant: { organization_id: 42, expires_at: "2099-01-01T00:00:00Z" },
    });
    render(<TriageStrip />);
    expect(screen.getByRole("status")).toHaveTextContent("scope: organization #42");
  });
});
