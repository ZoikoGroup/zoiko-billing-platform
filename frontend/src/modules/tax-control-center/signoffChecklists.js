// The tax lead's draft-pack sign-off checklist (backend/docs/TAX_PHASE3B.md,
// "Draft-pack sign-off checklist"), shown next to the pack it applies to.
// Read-only: completion is evidenced through the source register, the
// published rate, the market availability gates, the attached golden-test
// report and the two-person approval itself — not by ticking boxes here.
// Keep in step with TAX_PHASE3B.md.

export const SIGNOFF_CHECKLISTS = {
  "GB-VAT-DOMESTIC-SERVICES": [
    "Source S11 approved: the HMRC page captured as evidence (server-hashed) and reviewed. S11 links to https://www.gov.uk/vat-rates rather than stating the rate; confirm S11 is enough, or register that page as a new source and add it in a new pack version.",
    "Rate published: GB-VAT STANDARD / GENERAL through the rates pipeline, valid_from taken from the legal instrument.",
    "Coverage confirmed: seller established in the UK; buyer billed in the UK; standard-rated services only; GBP only; everything else NOT_DETERMINED.",
    "Treatment confirmed: domestic B2B and B2C charged identically; an unresolved buyer treated as a consumer.",
    "Rounding confirmed: PER_LINE + HALF_UP against HMRC rounding guidance (otherwise a new pack version declares the approved mode).",
    "Market availability: GB · VAT · B2B_SERVICES and B2C_SERVICES as NATIVE_RULEPACK_APPROVED, all mandatory gates PASSED.",
    "Golden tests reviewed: T05 (£100 net → £20 VAT → £120 gross, rate and source version preserved), B2B/B2C, outside coverage, T14; the CI run attached as the golden-test report (commit, passed, failed = 0, run URL).",
    "Two-person flow: a TAX_REVIEWER registers and submits; the tax lead (TAX_PUBLISHER) approves and publishes with MFA step-up.",
  ],
  "AU-GST-DOMESTIC-SERVICES": [
    "Source S16 approved: its cited URL refuses automated retrieval (HTTP 403, an API endpoint), so capture the corresponding public ATO page manually and review it.",
    "Rate published: AU-GST STANDARD / GENERAL, valid_from from the legal instrument.",
    "Coverage confirmed: Australian seller entity; buyer billed in Australia; taxable supplies of services; AUD only; everything else NOT_DETERMINED. GST-free and input-taxed supplies are out of scope (NOT_DETERMINED, not 0%).",
    "Rounding confirmed: PER_DOCUMENT + HALF_UP (whole invoice) against ATO rounding rules.",
    "Market availability: AU · GST · B2B_SERVICES and B2C_SERVICES as NATIVE_RULEPACK_APPROVED, gates PASSED.",
    "Golden tests reviewed: the AU 10% per-document case and outside coverage; the CI run attached.",
    "Two-person flow, as for the GB pack.",
  ],
};
