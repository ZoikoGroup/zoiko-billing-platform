import { afterEach, describe, expect, it, vi } from "vitest";

// ZB-SA-CMD-003 §17 — Domain B containment at the shared export choke
// point: while a privileged session suppression reason is set, every shared
// download helper must refuse to produce a file.

import {
  assertExportsAllowed,
  downloadCSV,
  downloadJSON,
  getExportSuppression,
  setExportSuppressed,
} from "./export-helpers";

afterEach(() => {
  setExportSuppressed(null);
});

describe("export suppression gate", () => {
  it("allows exports when no privileged session is active", () => {
    setExportSuppressed(null);
    expect(() => assertExportsAllowed()).not.toThrow();
    expect(getExportSuppression()).toBeNull();
  });

  it("blocks assertExportsAllowed with the active suppression reason", () => {
    setExportSuppressed("a privileged TENANT CONTEXT session is active");
    expect(() => assertExportsAllowed()).toThrowError(/privileged TENANT CONTEXT/);
  });

  it("downloadJSON refuses to write a file while suppressed", () => {
    setExportSuppressed("Domain B containment");
    expect(() => downloadJSON({ a: 1 }, "leak.json")).toThrowError(/Exports disabled/);
  });

  it("downloadCSV refuses to write a file while suppressed", () => {
    setExportSuppressed("Domain B containment");
    expect(() => downloadCSV([["x"]], ["col"], "leak.csv")).toThrowError(/Exports disabled/);
  });

  it("restores exports once the grant clears", () => {
    setExportSuppressed("active");
    expect(() => assertExportsAllowed()).toThrow();
    setExportSuppressed(null);
    expect(() => assertExportsAllowed()).not.toThrow();
  });
});

describe("downloadCSV file delivery", () => {
  it("clicks an attached link and keeps the object URL alive past the click", async () => {
    vi.useFakeTimers();
    const created = [];
    const revoked = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => { created.push(blob); return "blob:test"; };
    URL.revokeObjectURL = (url) => revoked.push(url);
    let clickedWhileAttached = null;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      clickedWhileAttached = document.body.contains(this);
      expect(this.download).toBe("audit.csv");
    });
    try {
      downloadCSV([["a", 'say "hi"']], ["Col1", "Col2"], "audit.csv");
      // Revoking in the same tick could cancel the browser's download.
      expect(clickedWhileAttached).toBe(true);
      expect(revoked).toEqual([]);
      vi.runAllTimers();
      expect(revoked).toEqual(["blob:test"]);
      vi.useRealTimers(); // FileReader needs real timers

      const text = await new Promise((resolve) => {
        const reader = new FileReader();
        // Decode raw bytes: readAsText would silently strip the BOM under test.
        reader.onload = () => resolve(new TextDecoder("utf-8", { ignoreBOM: true }).decode(reader.result));
        reader.readAsArrayBuffer(created[0]);
      });
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text.slice(1)).toBe('Col1,Col2\r\n"a","say ""hi"""');
      expect(document.querySelector("a[download]")).toBeNull();
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      vi.useRealTimers();
    }
  });
});
