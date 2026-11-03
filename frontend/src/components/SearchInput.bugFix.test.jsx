import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchInput } from "./billing-ui";

describe("SearchInput — Bug 2 Duplicate Clear Button Fix", () => {
  it("includes webkit cancel button suppression classes on input", () => {
    render(<SearchInput value="" onChange={() => {}} placeholder="Search orgs..." />);
    const input = screen.getByRole("searchbox");
    expect(input.className).toContain("[&::-webkit-search-cancel-button]:hidden");
    expect(input.className).toContain("[&::-webkit-search-decoration]:hidden");
  });

  it("does not render custom clear button when search is empty", () => {
    render(<SearchInput value="" onChange={() => {}} placeholder="Search orgs..." />);
    const clearBtn = screen.queryByRole("button", { name: /clear search/i });
    expect(clearBtn).toBeNull();
  });

  it("renders exactly one clear button when search has text", () => {
    render(<SearchInput value="Acme Corp" onChange={() => {}} placeholder="Search orgs..." />);
    const clearButtons = screen.getAllByRole("button", { name: /clear search/i });
    expect(clearButtons.length).toBe(1);
  });

  it("clears search input immediately and calls onChange with empty string", () => {
    const handleChange = vi.fn();
    render(<SearchInput value="Acme Corp" onChange={handleChange} placeholder="Search orgs..." />);
    const clearBtn = screen.getByRole("button", { name: /clear search/i });

    fireEvent.click(clearBtn);

    const input = screen.getByRole("searchbox");
    expect(input.value).toBe("");
    expect(handleChange).toHaveBeenCalledWith("");
  });
});
