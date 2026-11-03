import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Modal } from "./billing-ui";

// Stacked Modals (e.g. Tax Groups -> Members): only the top-most one reacts to
// Esc, and the body stays scroll-locked until the last one closes.

afterEach(() => cleanup());

const esc = () => fireEvent.keyDown(document, { key: "Escape" });

function Stack({ inner, onOuter, onInner }) {
  return (
    <>
      <Modal open title="Outer" onClose={onOuter}>outer body</Modal>
      {inner && <Modal open title="Inner" onClose={onInner}>inner body</Modal>}
    </>
  );
}

describe("Modal stack", () => {
  it("Esc closes only the top-most modal; body unlocks after the last closes", () => {
    const onOuter = vi.fn();
    const onInner = vi.fn();
    const { rerender, unmount } = render(<Stack inner onOuter={onOuter} onInner={onInner} />);
    expect(screen.getByRole("dialog", { name: "Inner" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");

    esc();
    expect(onInner).toHaveBeenCalledTimes(1);
    expect(onOuter).not.toHaveBeenCalled();

    rerender(<Stack inner={false} onOuter={onOuter} onInner={onInner} />);
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(document.body.style.overflow).toBe("hidden");

    esc();
    expect(onOuter).toHaveBeenCalledTimes(1);
    expect(onInner).toHaveBeenCalledTimes(1);

    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("a single Modal still closes on Esc", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Modal open title="Solo" onClose={onClose}>body</Modal>);
    expect(screen.getByRole("dialog", { name: "Solo" })).toBeInTheDocument();
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
