import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cc = vi.hoisted(() => ({
  listEvaluationPrograms: vi.fn(),
  createEvaluationProgram: vi.fn(),
  setEvaluationProgramStatus: vi.fn(),
  approveEvaluationProgram: vi.fn(),
}));
vi.mock("../../service/commandCenterService", () => cc);
vi.mock("../../service/commercialService", () => ({
  listCommercialPlans: vi.fn(() => Promise.resolve({ plans: [] })),
}));

import EvaluationProgramsPage from "./EvaluationProgramsPage";

// A tiny in-memory server for one program.
let program;

beforeEach(() => {
  vi.clearAllMocks();
  program = {
    id: 3, plan_id: 1, plan_code: "essentials", granted_plan_code: "professional", is_active: false,
    duration_days: 37, payment_requirement: "card_required_upfront", conversion_policy: "auto_charge_on_expiry",
    expiry_action: "downgrade", approved_by: null, caps: [],
  };
  cc.listEvaluationPrograms.mockImplementation(() => Promise.resolve([{ ...program }]));
  cc.approveEvaluationProgram.mockImplementation(() => {
    program.approved_by = 1;
    return Promise.resolve({ ...program });
  });
  cc.setEvaluationProgramStatus.mockImplementation((id, isActive) => {
    program.is_active = isActive;
    return Promise.resolve({ ...program });
  });
});

const rowFor = () => screen.getByText("essentials").closest("tr");

describe("EvaluationProgramsPage approval and activation", () => {
  it("approves an unapproved program, then activates it", async () => {
    render(<EvaluationProgramsPage embedded />);
    await screen.findByText("essentials");
    expect(within(rowFor()).getByText(/not approved/i)).toBeInTheDocument();
    expect(within(rowFor()).queryByRole("button", { name: /^activate$/i })).not.toBeInTheDocument();

    fireEvent.click(within(rowFor()).getByRole("button", { name: /^approve$/i }));
    await waitFor(() => expect(cc.approveEvaluationProgram).toHaveBeenCalledWith(3));
    expect(await screen.findByText(/approved — it can now be activated/i)).toBeInTheDocument();
    expect(within(rowFor()).getByText("user #1")).toBeInTheDocument();

    fireEvent.click(within(rowFor()).getByRole("button", { name: /^activate$/i }));
    await waitFor(() => expect(cc.setEvaluationProgramStatus).toHaveBeenCalledWith(3, true));
    expect(await within(rowFor()).findByRole("button", { name: /^deactivate$/i })).toBeInTheDocument();
    expect(within(rowFor()).getByText("Active")).toBeInTheDocument();
  });

  it("shows a failed action without hiding the programs table", async () => {
    cc.approveEvaluationProgram.mockRejectedValueOnce(new Error("missing capability"));
    render(<EvaluationProgramsPage embedded />);
    await screen.findByText("essentials");

    fireEvent.click(within(rowFor()).getByRole("button", { name: /^approve$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/missing capability/i);
    expect(screen.getByText("essentials")).toBeInTheDocument();
  });
});
