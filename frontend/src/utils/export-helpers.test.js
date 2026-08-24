import { afterEach, describe, expect, it } from "vitest";

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
