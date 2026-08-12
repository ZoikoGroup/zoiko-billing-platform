import { api } from "./api";

export const listUsers = ({ search = "", skip = 0, limit = 50 } = {}) =>
  api.get("/api/auth/admin/users", { params: { search, skip, limit } });

export const inviteUser = (data) => api.post("/api/auth/admin/users", data);

export const updateUser = (id, data) => api.put(`/api/auth/admin/users/${id}`, data);

export const deactivateUser = (id) => api.delete(`/api/auth/admin/users/${id}`);

export const resendInvite = (id) => api.post(`/api/auth/admin/users/${id}/resend-invite`);
