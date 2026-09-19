import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "../test/a11y";
import { Button, Field, Select, Modal, DataTable, Stepper } from "./billing-ui";
import { ErrorState, SuccessMessage, StatusBadge, Pagination } from "./billing-shared";

// Priority 5 remediation: axe-core was installed but never actually run.
// These cover the shared UI primitives every Billing page is built from —
// catching a violation here protects every page that reuses the component,
// not just one screen at a time.

describe("Shared UI accessibility (axe-core)", () => {
  it("Button — icon + label, default and disabled", async () => {
    const { container } = render(
      <div>
        <Button variant="primary">Save</Button>
        <Button variant="secondary" disabled>Cancel</Button>
      </div>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Field + Select — labelled form control", async () => {
    const { container } = render(
      <Field label="Status" htmlFor="status-select" hint="Filter by current status">
        <Select
          value=""
          onChange={() => {}}
          options={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]}
          id="status-select"
        />
      </Field>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Field — error state uses an alert role, not just color", async () => {
    const { container } = render(
      <Field label="Email" htmlFor="email-input" required error="Enter a valid email address">
        <input id="email-input" type="email" />
      </Field>
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/valid email/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("StatusBadge and ErrorState — status/alert content", async () => {
    const { container } = render(
      <div>
        <StatusBadge status="active" />
        <ErrorState message="Failed to load records" onRetry={() => {}} />
      </div>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("SuccessMessage — dismissible confirmation banner", async () => {
    const { container } = render(<SuccessMessage message="Saved successfully" onDismiss={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Pagination — prev/next + numbered pages", async () => {
    const { container } = render(
      <Pagination page={2} totalPages={5} onPageChange={() => {}}>12 total items</Pagination>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Stepper — wizard progress", async () => {
    const { container } = render(
      <Stepper
        steps={[{ key: 1, label: "Details" }, { key: 2, label: "Review" }, { key: 3, label: "Confirm" }]}
        current={1}
        onSelect={() => {}}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DataTable — sortable, selectable rows with real data", async () => {
    const { container } = render(
      <DataTable
        columns={[
          { key: "name", label: "Name", sortable: true },
          { key: "status", label: "Status" },
        ]}
        data={[
          { id: 1, name: "Acme Corp", status: "Active" },
          { id: 2, name: "Globex", status: "Suspended" },
        ]}
        selectedKeys={[]}
        onSelectionChange={() => {}}
        sortKey="name"
        sortDir="asc"
        onSort={() => {}}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("DataTable — empty state", async () => {
    const { container } = render(
      <DataTable columns={[{ key: "name", label: "Name" }]} data={[]} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Modal — dialog with labelled title and a focusable close button", async () => {
    render(
      <Modal open onClose={() => {}} title="Delete customer" description="This cannot be undone.">
        <p>Are you sure you want to delete this customer?</p>
      </Modal>
    );
    // Modal renders via createPortal(document.body) — the RTL container
    // only holds its own render root, so axe has to scan document.body.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Delete customer");
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
