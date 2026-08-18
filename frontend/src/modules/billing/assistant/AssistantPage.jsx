import { useState, useEffect, useRef, useCallback } from "react";
import {
  Bot,
  FileText,
  LockKeyhole,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  Plus,
  MessageSquare,
  ChevronLeft,
  Clock,
  AlertTriangle,
  Eye,
  Pencil,
  CheckCircle2,
  ExternalLink,
  Loader2,
  X,
  MoreHorizontal,
} from "lucide-react";

import {
  createChatSession,
  listChatSessions,
  getChatSession,
  closeChatSession,
  sendChatMessage,
} from "../../../service/chatbotService";

const INITIAL_PROMPTS = [
  "What can you do?",
  "Dashboard summary",
  "Show overdue invoices",
  "Explain partial payments",
  "Look up customer Acme",
  "Invoice payment allocation policy",
];

const WELCOME_MESSAGE = {
  id: "welcome",
  sender_type: "assistant",
  message_text:
    "Welcome to the Zoiko Billing AI Assistant. I am a governed billing operations helper that can answer questions, look up records, explain financial state, and guide you through billing workflows.\n\nEvery answer I provide is grounded in authoritative Zoiko Billing records. I never guess financial state.",
  mode: "M0_EXPLAIN",
  risk_class: "R0",
  structured_payload: null,
  qualification: "No financial action will be executed from this chat. All responses are read-only and evidence-backed.",
  next_actions: ["Try a suggested prompt below or ask a specific billing question."],
};

const SUGGESTION_CHIPS = {
  help: ["What can you do?", "Explain partial payments", "Invoice correction policy", "Refund process"],
  dashboard: ["Show overdue invoices", "List recent payments", "Customer aging summary"],
  invoice: ["Show overdue invoices", "Look up invoice by number", "Explain invoice balances"],
  payment: ["Find payment by transaction ID", "Show unapplied payments", "Explain allocations"],
  customer: ["Show top customers", "Customer payment history", "Outstanding balances"],
  subscription: ["Show active subscriptions", "Renewal dates", "Plan details"],
  contract: ["Active contracts", "Contract terms", "Amendments"],
  product: ["Product catalog", "Pricing details", "Product categories"],
};

function modeIcon(mode) {
  if (mode === "M0_EXPLAIN") return <FileText className="h-3.5 w-3.5" />;
  if (mode === "M1_INSPECT") return <Eye className="h-3.5 w-3.5" />;
  if (mode === "M2_PREPARE") return <Pencil className="h-3.5 w-3.5" />;
  if (mode === "M3_PREVIEW") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (mode === "M5_ESCALATE") return <AlertTriangle className="h-3.5 w-3.5" />;
  return <Bot className="h-3.5 w-3.5" />;
}

function modeLabel(mode) {
  const labels = {
    M0_EXPLAIN: "Explain",
    M1_INSPECT: "Inspect",
    M2_PREPARE: "Prepare",
    M3_PREVIEW: "Preview",
    M5_ESCALATE: "Escalate",
  };
  return labels[mode] || mode;
}

function modeColor(mode) {
  if (mode === "M1_INSPECT") return "bg-blue-50 text-blue-700 border-blue-200";
  if (mode === "M5_ESCALATE") return "bg-amber-50 text-amber-800 border-amber-200";
  if (mode === "M2_PREPARE") return "bg-violet-50 text-violet-700 border-violet-200";
  if (mode === "M3_PREVIEW") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  return "bg-emerald-50 text-emerald-700 border-emerald-200";
}

function riskColor(risk) {
  if (risk === "R1") return "bg-blue-100 text-blue-800";
  if (risk === "R2") return "bg-violet-100 text-violet-800";
  if (risk === "R3") return "bg-orange-100 text-orange-800";
  if (risk === "R4") return "bg-red-100 text-red-800";
  if (risk === "RX") return "bg-red-200 text-red-900";
  return "bg-slate-100 text-slate-600";
}

function EvidenceCard({ evidence }) {
  const fields = Object.entries(evidence.fields || {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
            Evidence
          </p>
          <p className="mt-1 truncate text-sm font-bold text-slate-900">
            {evidence.reference || evidence.resource_type}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600">
          {evidence.source}
        </span>
      </div>
      <p className="text-[13px] leading-5 text-slate-600">{evidence.summary}</p>
      {fields.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {fields.slice(0, 10).map(([key, value]) => (
            <div key={key} className="rounded-xl bg-slate-50 px-3 py-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
                {key.replaceAll("_", " ")}
              </p>
              <p className="mt-0.5 break-words text-[13px] font-semibold text-slate-800">
                {String(value)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function parseMarkdown(text) {
  if (!text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*|\n)/g);
  return parts.map((part, i) => {
    if (part === "\n") return <br key={i} />;
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-bold text-slate-900">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function AssistantMessage({ message, onSuggestionClick, isLatest }) {
  const [expanded, setExpanded] = useState(true);
  const evidence = message.evidence || [];
  const nextActions = message.next_actions || [];
  const suggestions = message.suggested_prompts || [];

  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-[#1F0B63] text-white shadow-lg shadow-violet-950/20">
        <Bot className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          {/* Badges */}
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${modeColor(
                message.mode
              )}`}
            >
              {modeIcon(message.mode)}
              {modeLabel(message.mode)}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${riskColor(
                message.risk_class
              )}`}
            >
              {message.risk_class}
            </span>
          </div>

          {/* Answer */}
          <div className="text-[14px] leading-6 text-slate-800">
            {parseMarkdown(message.message_text)}
          </div>

          {/* Qualification */}
          {message.qualification && (
            <div className="mt-3 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3">
              <p className="text-[13px] font-medium text-amber-900">
                {message.qualification}
              </p>
            </div>
          )}

          {/* Evidence Cards */}
          {evidence.length > 0 && (
            <div className="mt-4 space-y-2">
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400 hover:text-slate-600"
              >
                <span
                  className={`transition-transform ${expanded ? "rotate-90" : ""}`}
                >
                  ▶
                </span>
                Evidence ({evidence.length})
              </button>
              {expanded && (
                <div className="space-y-2">
                  {evidence.map((item, idx) => (
                    <EvidenceCard
                      key={`${item.resource_type}-${item.resource_id || idx}`}
                      evidence={item}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Next Actions */}
          {nextActions.length > 0 && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
                Safe Next Actions
              </p>
              <div className="space-y-1.5">
                {nextActions.map((action, idx) => (
                  <p key={idx} className="text-[13px] font-medium text-slate-700">
                    {action}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Suggested Follow-ups */}
          {isLatest && suggestions.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {suggestions.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => onSuggestionClick(prompt)}
                  className="rounded-full border border-[#7B3AEB]/20 bg-[#7B3AEB]/5 px-3 py-1.5 text-[12px] font-bold text-[#4C2CC5] transition hover:bg-[#7B3AEB]/10"
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UserMessage({ message }) {
  return (
    <div className="flex justify-end gap-3">
      <div className="max-w-3xl rounded-[24px] bg-gradient-to-r from-[#4C2CC5] via-[#7B3AEB] to-[#6033D3] px-5 py-4 text-white shadow-lg shadow-violet-950/20">
        <p className="text-[14px] leading-6">{message.message_text}</p>
      </div>
      <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-white text-[#4C2CC5] shadow-sm ring-1 ring-slate-200">
        <UserRound className="h-4 w-4" />
      </div>
    </div>
  );
}

function SessionItem({ session, isActive, onClick }) {
  const timeAgo = session.updated_at
    ? new Date(session.updated_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-2xl px-4 py-3 text-left transition ${
        isActive
          ? "border border-[#7B3AEB]/20 bg-[#7B3AEB]/10"
          : "border border-transparent hover:bg-slate-100"
      }`}
    >
      <p className="truncate text-[13px] font-bold text-slate-900">
        {session.title || "Untitled Conversation"}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[11px] text-slate-400">{timeAgo}</span>
        <span className="text-[11px] text-slate-400">
          {session.message_count || 0} msgs
        </span>
      </div>
    </button>
  );
}

export default function AssistantPage() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionUid, setActiveSessionUid] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [error, setError] = useState(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Load sessions on mount
  useEffect(() => {
    loadSessions();
  }, []);

  async function loadSessions() {
    setLoadingSessions(true);
    try {
      const data = await listChatSessions({ limit: 50 });
      setSessions(data);
    } catch {
      // Sessions may not load if backend is starting
    } finally {
      setLoadingSessions(false);
    }
  }

  async function createNewSession(initialMessage = null) {
    setLoading(true);
    setError(null);
    try {
      const session = await createChatSession({
        title: initialMessage
          ? initialMessage.slice(0, 60) + (initialMessage.length > 60 ? "..." : "")
          : null,
        initialMessage,
      });
      setSessions((prev) => [
        {
          conversation_uid: session.conversation_uid,
          title: session.title,
          status: session.status,
          message_count: session.messages?.length || 0,
          created_at: session.created_at,
          updated_at: session.updated_at,
        },
        ...prev,
      ]);
      setActiveSessionUid(session.conversation_uid);
      setMessages(session.messages || []);
    } catch (err) {
      setError(err.message || "Failed to create conversation.");
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  async function loadSession(uid) {
    setActiveSessionUid(uid);
    setMessages([]);
    setError(null);
    try {
      const data = await getChatSession(uid);
      setMessages(data.messages || []);
    } catch (err) {
      setError(err.message || "Failed to load conversation.");
    }
  }

  async function submitMessage(value = input) {
    const text = value.trim();
    if (!text || loading) return;

    setInput("");
    setError(null);

    if (!activeSessionUid) {
      await createNewSession(text);
      return;
    }

    setLoading(true);

    // Optimistic user message
    const userMsg = {
      id: `user-${Date.now()}`,
      sender_type: "user",
      message_text: text,
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const response = await sendChatMessage(activeSessionUid, text);
      const assistantMsg = {
        id: response.message_uid || `assistant-${Date.now()}`,
        sender_type: "assistant",
        message_text: response.answer,
        mode: response.mode,
        risk_class: response.risk_class,
        evidence: response.evidence,
        qualification: response.qualification,
        next_actions: response.next_actions,
        suggested_prompts: response.suggested_prompts,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      // Refresh session list to update message count
      loadSessions();
    } catch (err) {
      setError(err.message || "The assistant is unavailable.");
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  async function handleCloseSession() {
    if (!activeSessionUid) return;
    try {
      await closeChatSession(activeSessionUid);
      setSessions((prev) =>
        prev.map((s) =>
          s.conversation_uid === activeSessionUid
            ? { ...s, status: "resolved" }
            : s
        )
      );
      setActiveSessionUid(null);
      setMessages([]);
    } catch (err) {
      setError(err.message || "Failed to close conversation.");
    }
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitMessage();
    }
  }

  return (
    <div className="min-h-[calc(100vh-65px)] bg-[#F8F7F4]">
      <div className="mx-auto flex h-[calc(100vh-65px)] max-w-[1600px]">
        {/* Session Sidebar */}
        {showSidebar && (
          <aside className="w-80 shrink-0 border-r border-slate-200 bg-white/80 backdrop-blur">
            <div className="flex h-full flex-col">
              {/* Header */}
              <div className="border-b border-slate-200 p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#1F0B63] text-white shadow-lg shadow-violet-950/20">
                      <Sparkles className="h-5 w-5" />
                    </div>
                    <div>
                      <h1 className="text-lg font-black tracking-tight text-slate-950">
                        AI Assistant
                      </h1>
                      <p className="text-[11px] font-bold text-slate-400">
                        Zoiko Billing
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* New Conversation Button */}
              <div className="p-4">
                <button
                  type="button"
                  onClick={() => {
                    setActiveSessionUid(null);
                    setMessages([]);
                    inputRef.current?.focus();
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#7B3AEB]/30 bg-[#7B3AEB]/5 px-4 py-3 text-sm font-bold text-[#4C2CC5] transition hover:border-[#7B3AEB]/50 hover:bg-[#7B3AEB]/10"
                >
                  <Plus className="h-4 w-4" />
                  New Conversation
                </button>
              </div>

              {/* Session List */}
              <div className="flex-1 overflow-y-auto px-3 pb-4">
                {loadingSessions ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                  </div>
                ) : sessions.length === 0 ? (
                  <div className="py-8 text-center">
                    <MessageSquare className="mx-auto h-8 w-8 text-slate-300" />
                    <p className="mt-2 text-[13px] font-bold text-slate-400">
                      No conversations yet
                    </p>
                    <p className="mt-1 text-[12px] text-slate-400">
                      Start a new conversation below
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {sessions.map((session) => (
                      <SessionItem
                        key={session.conversation_uid}
                        session={session}
                        isActive={session.conversation_uid === activeSessionUid}
                        onClick={() => loadSession(session.conversation_uid)}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Trust Line */}
              <div className="border-t border-slate-200 p-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-[11px] font-bold text-emerald-700">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Permission scoped
                  </div>
                  <div className="flex items-center gap-2 text-[11px] font-bold text-violet-700">
                    <FileText className="h-3.5 w-3.5" />
                    Evidence backed
                  </div>
                  <div className="flex items-center gap-2 text-[11px] font-bold text-amber-700">
                    <LockKeyhole className="h-3.5 w-3.5" />
                    Read-only mode
                  </div>
                </div>
              </div>
            </div>
          </aside>
        )}

        {/* Main Conversation Area */}
        <section className="flex min-w-0 flex-1 flex-col">
          {/* Top Bar */}
          <div className="flex items-center justify-between border-b border-slate-200 bg-white/70 px-6 py-3 backdrop-blur">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowSidebar(!showSidebar)}
                className="rounded-xl p-2 text-slate-500 hover:bg-slate-100"
              >
                {showSidebar ? (
                  <ChevronLeft className="h-4 w-4" />
                ) : (
                  <MoreHorizontal className="h-4 w-4" />
                )}
              </button>
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                  Conversation
                </p>
                <h2 className="text-sm font-black text-slate-950">
                  {activeSessionUid
                    ? sessions.find((s) => s.conversation_uid === activeSessionUid)
                        ?.title || "Conversation"
                    : "New Conversation"}
                </h2>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-bold text-slate-600">
                Action status: read-only
              </span>
              {activeSessionUid && (
                <button
                  type="button"
                  onClick={handleCloseSession}
                  className="rounded-xl px-3 py-1.5 text-[12px] font-bold text-slate-500 hover:bg-slate-100"
                >
                  End session
                </button>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            {messages.length === 0 && !loading ? (
              /* Empty State */
              <div className="flex h-full flex-col items-center justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-[#1F0B63] text-white shadow-xl shadow-violet-950/20">
                  <Sparkles className="h-7 w-7" />
                </div>
                <h2 className="mt-6 text-2xl font-black text-slate-950">
                  Zoiko Billing AI Assistant
                </h2>
                <p className="mt-3 max-w-md text-center text-[14px] leading-6 text-slate-500">
                  Ask about invoices, payments, customers, subscriptions, balances,
                  or billing workflows. Every answer is grounded in authoritative
                  Zoiko Billing records.
                </p>

                <div className="mt-8 grid max-w-lg grid-cols-2 gap-3">
                  {INITIAL_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => submitMessage(prompt)}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-[13px] font-bold text-slate-700 shadow-sm transition hover:border-[#7B3AEB]/40 hover:text-[#4C2CC5] hover:shadow-md"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {messages.map((msg, idx) =>
                  msg.sender_type === "user" ? (
                    <UserMessage key={msg.id || msg.message_uid || idx} message={msg} />
                  ) : (
                    <AssistantMessage
                      key={msg.id || msg.message_uid || idx}
                      message={msg}
                      onSuggestionClick={submitMessage}
                      isLatest={idx === messages.length - 1}
                    />
                  )
                )}
                {loading && (
                  <div className="flex gap-3">
                    <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-[#1F0B63] text-white">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="flex items-center gap-2 rounded-[24px] border border-slate-200 bg-white px-5 py-4 text-sm font-semibold text-slate-600 shadow-sm">
                      <Loader2 className="h-4 w-4 animate-spin text-[#7B3AEB]" />
                      Checking authorized Zoiko Billing evidence...
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="mx-6 mb-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
              <div className="flex items-center justify-between">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="text-red-400 hover:text-red-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitMessage();
            }}
            className="border-t border-slate-200 bg-white/70 p-4 backdrop-blur sm:p-5"
          >
            <div className="flex gap-3 rounded-[24px] border border-slate-200 bg-white p-2 shadow-sm focus-within:border-[#7B3AEB]/50 focus-within:shadow-md">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  activeSessionUid
                    ? "Ask about invoices, payments, customers, balances..."
                    : "Start a new conversation..."
                }
                rows={1}
                className="min-h-[44px] min-w-0 flex-1 resize-none rounded-[18px] border-0 bg-transparent px-4 py-3 text-[14px] font-medium text-slate-900 outline-none placeholder:text-slate-400"
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[18px] bg-[#FC7800] text-white shadow-lg shadow-orange-500/20 transition hover:bg-[#e86d00] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
