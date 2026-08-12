import { api } from "./api";

export const getOrganizationDetails = () => api.get("/api/organizations/me/detail");
export const updateOrganizationDetails = (data) =>
  api.put("/api/organizations/me", {
    organization_name: data.name,
    display_name: data.display_name,
    industry: data.industry,
    address: data.address,
    currency: data.currency,
    timezone: data.timezone,
  });
export const getOrganizationDashboardStats = () => api.get("/api/organizations/me/dashboard-stats");
