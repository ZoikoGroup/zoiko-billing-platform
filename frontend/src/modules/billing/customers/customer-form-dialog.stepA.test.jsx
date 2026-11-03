// Phase 3 Step A: customer form dialog — unsaved-changes guard and pattern.
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CustomerFormDialog from "./customer-form-dialog";

const EMPTY = {
  company_name: "", display_name: "", email: "", phone: "", website: "",
  customer_type: null, currency: "USD", payment_terms: "net_30", credit_limit: "", credit_days: 30,
  billing_address: "", shipping_address: "", billing_country: "", shipping_country: "",
  shipping_same_as_billing: false, notes: "",
};

function Harness({ mode = "create", initial = EMPTY, confirm, onCancel = vi.fn(), onSubmit = vi.fn() }) {
  const [values, setValues] = useState(initial);
  return (
    <CustomerFormDialog
      mode={mode}
      values={values}
      setValues={setValues}
      onSubmit={onSubmit}
      onCancel={onCancel}
      confirm={confirm}
      loading={false}
      error={null}
      limitError={null}
      onDismissLimit={() => {}}
      singular="Customer"
      plural="Customers"
      defaultCustomerType="business"
      requireBillingAddress={false}
      requireTaxId={false}
      paymentTermsCreditDays={{ net_30: 30 }}
      onBillingCountryChange={() => {}}
    />
  );
}

const companyInput = () => document.getElementById("customer-new-company_name");

describe("CustomerFormDialog unsaved-changes guard", () => {
  it("closes immediately when nothing changed", () => {
    const confirm = vi.fn();
    const onCancel = vi.fn();
    render(<Harness confirm={confirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding edits, and keeps the form when the user says no", async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onCancel = vi.fn();
    render(<Harness confirm={confirm} onCancel={onCancel} />);
    fireEvent.change(companyInput(), { target: { value: "Acme" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("treats a field edited back to its loaded value as unchanged", () => {
    const confirm = vi.fn();
    const onCancel = vi.fn();
    render(<Harness mode="edit" initial={{ ...EMPTY, id: 7, company_name: "Globex" }} confirm={confirm} onCancel={onCancel} />);
    const input = document.getElementById("customer-edit-company_name");
    fireEvent.change(input, { target: { value: "Globex Ltd" } });
    fireEvent.change(input, { target: { value: "Globex" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("CustomerFormDialog pattern", () => {
  it("shows one Required note and the create/edit titles and actions", () => {
    const { unmount } = render(<Harness confirm={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "New Customer" })).toBeInTheDocument();
    expect(screen.getAllByText(/Required/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Create Customer" })).toBeDisabled(); // no company name yet
    unmount();
    render(<Harness mode="edit" initial={{ ...EMPTY, id: 7, company_name: "Globex" }} confirm={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Edit Customer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
    expect(screen.getByLabelText("Tax ID")).toBeInTheDocument();
  });
});
