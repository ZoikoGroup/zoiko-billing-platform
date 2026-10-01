import { describe, expect, it, vi } from "vitest";
import { convertToBaseCurrency, sumInBaseCurrency } from "./currency-conversion";

describe("currency conversion", () => {
  it("does not treat an unset reporting currency as a same-currency conversion", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(convertToBaseCurrency(100, "USD", "")).toEqual({
        convertedAmount: 0,
        rateUsed: 0,
        isReliable: false,
      });
      expect(sumInBaseCurrency([{ amount: 100, currency: "USD" }], "")).toMatchObject({
        total: 0,
        excludedCount: 1,
        unconvertedAmount: 100,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
