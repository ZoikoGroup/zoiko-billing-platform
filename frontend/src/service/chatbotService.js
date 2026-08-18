import { api } from "./api";

export function sendChatbotMessage({ message, conversationId } = {}) {
  return api.post("/api/chatbot/message", {
    message,
    conversation_id: conversationId || null,
  });
}
