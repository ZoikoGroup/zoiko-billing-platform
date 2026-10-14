process.env.TZ = "Asia/Kolkata";

import { describe, it, expect } from "vitest";
import { formatDisplayDate } from "./billing-helpers";

// BUG-12.3 companion: the date-only fix must not change what IST users see.

describe("formatDisplayDate — IST output is unchanged", () => {
  it("runs in a timezone east of UTC", () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBeLessThan(0);
  });

  it.each(["2026-01-01", "2026-03-31", "2024-02-29", "2026-12-31"])("%s matches the previous output", (input) => {
    expect(formatDisplayDate(input)).toBe(new Date(input).toLocaleDateString());
  });
});
