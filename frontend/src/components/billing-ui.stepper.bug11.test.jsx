import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// BUG-11.4 / 11.13: the 7-step Create Invoice Stepper rendered non-wrapping
// labels in a non-scrolling flex row; below ~1,410px the shell's
// overflow-x-hidden clipped the right-hand steps. jsdom has no layout, so the
// fix is asserted through its classes plus the active-step scroll behaviour.

import { Stepper } from "./billing-ui";

const STEPS = ["Customer", "Invoice Details", "Line Items", "Taxes & Discounts", "Review", "PDF Preview", "Actions"]
  .map((label, i) => ({ key: i + 1, label }));

afterEach(() => cleanup());

describe("BUG-11 Stepper overflow", () => {
  it("is a horizontally scrollable row whose steps never shrink away", () => {
    render(<Stepper steps={STEPS} current={0} />);
    const list = screen.getByRole("list", { name: "Wizard progress" });
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).toContain("min-w-0");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(7);
    items.forEach((li) => expect(li.querySelector("button").className).toContain("shrink-0"));
    // Every step label stays in the DOM (reachable by scrolling).
    STEPS.forEach((s) => expect(screen.getByText(s.label)).toBeInTheDocument());
  });

  it("scrolls the list (not the page) to keep the active step visible", () => {
    const { rerender } = render(<Stepper steps={STEPS} current={0} />);
    const list = screen.getByRole("list", { name: "Wizard progress" });
    Object.defineProperty(list, "scrollWidth", { configurable: true, value: 1400 });
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 800 });
    list.getBoundingClientRect = () => ({ left: 0, right: 800, top: 0, bottom: 40, width: 800, height: 40 });
    const items = screen.getAllByRole("listitem");
    items[6].getBoundingClientRect = () => ({ left: 1250, right: 1400, top: 0, bottom: 40, width: 150, height: 40 });
    const pageScroll = vi.fn();
    items[6].scrollIntoView = pageScroll;
    list.scrollLeft = 0;
    rerender(<Stepper steps={STEPS} current={6} />);
    expect(list.scrollLeft).toBe(600);
    expect(pageScroll).not.toHaveBeenCalled();
    expect(items[6].querySelector("button")).toHaveAttribute("aria-current", "step");
  });

  it("does nothing when the row fits", () => {
    const { rerender } = render(<Stepper steps={STEPS} current={0} />);
    const list = screen.getByRole("list", { name: "Wizard progress" });
    list.scrollLeft = 0;
    rerender(<Stepper steps={STEPS} current={3} />);
    expect(list.scrollLeft).toBe(0);
  });

  it("keeps the API: only visited steps are clickable", () => {
    const onSelect = vi.fn();
    render(<Stepper steps={STEPS} current={2} onSelect={onSelect} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeEnabled();
    expect(buttons[2]).toBeDisabled();
    expect(buttons[6]).toBeDisabled();
    fireEvent.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith(0);
  });
});
