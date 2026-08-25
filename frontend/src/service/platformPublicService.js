import { api } from "./api";

/**
 * Plane 1 (Zoiko-billing-the-org) public, unauthenticated endpoints.
 *
 * Separate from commercialService.js/commandCenterService.js — both those
 * files are documented as Super-Admin-only. These calls carry no auth token
 * (signed link tokens are the authentication), same pattern as
 * publicQuoteApi/publicInvoiceApi in billingService.js for Plane 2.
 */

export const publicPlatformQuoteApi = {
  getView: (token) =>
    api.get(`/billing/commercial-quotes/public/${token}`, { auth: false }),
  accept: (token) =>
    api.post(`/billing/commercial-quotes/public/${token}/accept`, {}, { auth: false }),
  reject: (token, reason) =>
    api.post(`/billing/commercial-quotes/public/${token}/reject`, { reason }, { auth: false }),
};

export const publicPlatformInvoiceApi = {
  getView: (token) =>
    api.get(`/billing/commercial-invoices/public/${token}`, { auth: false }),
};
