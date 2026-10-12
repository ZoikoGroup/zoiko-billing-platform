// Must be set before any Date is created: a timezone WEST of UTC is where a
// date-only string parsed as UTC midnight rolls back to the previous day.
process.env.TZ = "America/New_York";

import { describe, it, expect } from "vitest";
import { formatDisplayDate } from "./billing-helpers";

// BUG-12.3 (/billing/usage-billing): the "Created from ... to ..." footer label
// passed the picked YYYY-MM-DD values to formatDisplayDate, which did
// `new Date("2026-01-01")` -> UTC midnight -> Dec 31 in the Americas. The fix
// is in the shared helper, so every date-only value it formats is corrected.

const local = (y, m, d) => new Date(y, m - 1, d).toLocaleDateString();

describe("formatDisplayDate — date-only strings keep their calendar day (UTC-5)", () => {
  it("runs in a timezone west of UTC", () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBeGreaterThan(0);
  });

  it.each([
    ["2026-01-01", 2026, 1, 1],
    ["2026-03-31", 2026, 3, 31],
    ["2024-02-29", 2024, 2, 29],
    ["2026-12-31", 2026, 12, 31],
  ])("%s shows that same day", (input, y, m, d) => {
    expect(formatDisplayDate(input)).toBe(local(y, m, d));
  });

  it("would have shown the previous day with the old UTC parse (guards the regression)", () => {
    expect(new Date("2026-01-01").toLocaleDateString()).toBe(local(2025, 12, 31));
    expect(formatDisplayDate("2026-01-01")).not.toBe(local(2025, 12, 31));
  });

  it("leaves full timestamps as instants", () => {
    const iso = "2026-01-01T03:00:00Z"; // 22:00 on Dec 31 in New York
    expect(formatDisplayDate(iso)).toBe(new Date(iso).toLocaleDateString());
    expect(formatDisplayDate(iso)).toBe(local(2025, 12, 31));
  });

  it("still returns an em dash for empty or invalid input", () => {
    expect(formatDisplayDate(null)).toBe("—");
    expect(formatDisplayDate("")).toBe("—");
    expect(formatDisplayDate("not-a-date")).toBe("—");
  });
});
