import { api } from "./api";

const BASE = "/api/chatbot";

export function createChatSession({ title, initialMessage } = {}) {
  return api.post(`${BASE}/sessions`, {
    title: title || null,
    initial_message: initialMessage || null,
  });
}

export function listChatSessions({ limit = 20, offset = 0 } = {}) {
  return api.get(`${BASE}/sessions`, { params: { limit, offset } });
}

export function getChatSession(conversationUid) {
  return api.get(`${BASE}/sessions/${conversationUid}`);
}

export function closeChatSession(conversationUid) {
  return api.delete(`${BASE}/sessions/${conversationUid}`);
}

export function sendChatMessage(conversationUid, message) {
  return api.post(`${BASE}/sessions/${conversationUid}/messages`, { message });
}

export function getChatCapabilities() {
  return api.get(`${BASE}/capabilities`);
}
