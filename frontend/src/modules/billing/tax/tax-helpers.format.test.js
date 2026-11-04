import { describe, expect, it } from "vitest";
import { formatTaxRate } from "./tax-helpers";

describe("formatTaxRate", () => {
  it("keeps legal precision instead of rounding to 2 places", () => {
    expect(formatTaxRate("8.875000")).toBe("8.875");
    expect(formatTaxRate("6.0625")).toBe("6.0625");
  });
  it("shows at least two decimals", () => {
    expect(formatTaxRate("20.000000")).toBe("20.00");
    expect(formatTaxRate(5)).toBe("5.00");
    expect(formatTaxRate("12.5")).toBe("12.50");
  });
  it("falls back for missing values", () => {
    expect(formatTaxRate(null)).toBe("0.00");
    expect(formatTaxRate("abc")).toBe("0.00");
  });
});
