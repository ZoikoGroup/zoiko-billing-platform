import { describe, it, expect } from "vitest";
import { formatDisplayDate, formatDisplayDateTime, formatRelativeTime, formatDisplayNumber, formatPercent } from "./billing-helpers";

// Phase 4: one date format app-wide ("Oct 1, 2026") and shared helpers for
// date-times, relative times, numbers and percentages.

describe("shared format helpers", () => {
  it("formatDisplayDate shows the short month name", () => {
    expect(formatDisplayDate("2026-10-01")).toBe("Oct 1, 2026");
    expect(formatDisplayDate(null)).toBe("—");
    expect(formatDisplayDate("not a date")).toBe("—");
  });

  it("formatDisplayDateTime adds the time", () => {
    expect(formatDisplayDateTime(new Date(2026, 9, 1, 15, 45))).toBe("Oct 1, 2026, 3:45 PM");
    expect(formatDisplayDateTime("")).toBe("—");
  });

  it("formatRelativeTime counts back from now, then falls back to the date", () => {
    const now = new Date(2026, 9, 10, 12, 0).getTime();
    const ago = (ms) => new Date(now - ms);
    expect(formatRelativeTime(ago(30 * 1000), now)).toBe("just now");
    expect(formatRelativeTime(ago(5 * 60 * 1000), now)).toBe("5 min ago");
    expect(formatRelativeTime(ago(3 * 3600 * 1000), now)).toBe("3 hr ago");
    expect(formatRelativeTime(ago(24 * 3600 * 1000), now)).toBe("1 day ago");
    expect(formatRelativeTime(ago(2 * 24 * 3600 * 1000), now)).toBe("2 days ago");
    expect(formatRelativeTime(ago(10 * 24 * 3600 * 1000), now)).toBe("Sep 30, 2026");
    expect(formatRelativeTime(new Date(now + 60000), now)).toBe("Oct 10, 2026");
    expect(formatRelativeTime(undefined, now)).toBe("—");
  });

  it("formatDisplayNumber and formatPercent", () => {
    expect(formatDisplayNumber(12345)).toBe("12,345");
    expect(formatDisplayNumber("12345.678", 2)).toBe("12,345.68");
    expect(formatDisplayNumber("abc")).toBe("—");
    expect(formatPercent(12.5)).toBe("12.5%");
    expect(formatPercent("7", 0)).toBe("7%");
    expect(formatPercent(null)).toBe("—");
  });
});
