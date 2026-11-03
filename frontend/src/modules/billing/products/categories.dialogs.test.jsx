import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Categories create/edit dialog rebuilt on the shared Modal.

const m = vi.hoisted(() => ({ listCategories: vi.fn(), productList: vi.fn(), createCategory: vi.fn(), updateCategory: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  productApi: {
    listCategories: (...a) => m.listCategories(...a),
    list: (...a) => m.productList(...a),
    createCategory: (...a) => m.createCategory(...a),
    updateCategory: (...a) => m.updateCategory(...a),
    deleteCategory: vi.fn(),
  },
}));
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};

import CategoriesPage from "./categories";

const TREE = [{ id: 1, name: "Hardware", status: "active", children: [], children_count: 0 }];

beforeEach(() => {
  vi.clearAllMocks();
  m.listCategories.mockResolvedValue(TREE);
  m.productList.mockResolvedValue({ items: [] });
  m.createCategory.mockResolvedValue({ id: 2 });
  m.updateCategory.mockResolvedValue({ id: 1 });
});
afterEach(() => cleanup());

async function renderPage() {
  render(<MemoryRouter><CategoriesPage /></MemoryRouter>);
  await screen.findByRole("tree", { name: "Product categories" });
}

async function openCreate() {
  fireEvent.click(screen.getAllByRole("button", { name: "Add New Category" })[0]);
  return screen.findByRole("dialog", { name: "Add New Category" });
}

describe("Categories dialogs", () => {
  it("Add New Category: gated on name, calls createCategory with a slug code, then closes", async () => {
    await renderPage();
    const dialog = await openCreate();
    const create = within(dialog).getByRole("button", { name: "Create Category" });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText("e.g. Networking"), { target: { value: "Cables & Wires" } });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await waitFor(() => expect(m.createCategory).toHaveBeenCalledTimes(1));
    expect(m.createCategory).toHaveBeenCalledWith(expect.objectContaining({ name: "Cables & Wires", code: "cables-wires", parent_id: null, is_active: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Edit Category: Save Changes calls updateCategory with the selected id, then closes", async () => {
    await renderPage();
    fireEvent.click(screen.getAllByRole("treeitem").find((el) => el.getAttribute("title") === "Hardware"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit category" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Category" });
    fireEvent.change(within(dialog).getByPlaceholderText("e.g. Networking"), { target: { value: "Hardware 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(m.updateCategory).toHaveBeenCalledWith(1, expect.objectContaining({ name: "Hardware 2" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel closes the dialog without calling the API", async () => {
    await renderPage();
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(m.createCategory).not.toHaveBeenCalled();
  });
});
