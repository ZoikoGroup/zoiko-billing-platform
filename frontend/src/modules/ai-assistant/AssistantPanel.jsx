/**
 * modules/ai-assistant/AssistantPanel.jsx
 * ---------------------------------------
 * Main AI Assistant panel embedded in the Zoiko Billing shell.
 * Self-contained theme (light/dark) via CSS variables — independent
 * of the host app's theme. WCAG 2.2 AA compliant.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Send,
  X,
  User,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Shield,
  FileText,
  Loader2,
  Sparkles,
  Plus,
  History,
  Sun,
  Moon,
  LifeBuoy,
  ArrowRight,
  Info,
  Maximize2,
  Minimize2,
} from "lucide-react";
import ZoikoMark from "../../components/ZoikoMark";
import ReactMarkdown from "react-markdown";
import {
  createSession,
  listSessions,
  getSession,
  sendMessage,
} from "./api";
import PreviewCard from "./PreviewCard";
import ConfirmDialog from "./ConfirmDialog";
import { FAQ_CATEGORIES, WELCOME_MESSAGE, DEFAULT_PROMPTS, CONTEXTUAL_PROMPTS, TOPIC_KEYWORDS } from "./suggestedPrompts";

// ── Theme definitions ────────────────────────────────────────────────────────

const THEME_KEY = "billingAssistantTheme";

const THEMES = {
  light: {
    "--ab-bg": "#ffffff",
    "--ab-surface": "#f8fafc",
    "--ab-surface-raised": "#f1f5f9",
    "--ab-border": "#e2e8f0",
    "--ab-border-subtle": "#f1f5f9",
    "--ab-text": "#0f172a",
    "--ab-text-secondary": "#475569",
    "--ab-text-muted": "#94a3b8",
    "--ab-text-dim": "#cbd5e1",
    "--ab-accent": "#F5841F",
    "--ab-accent-hover": "#e0750f",
    "--ab-accent-10": "rgba(245,132,31,0.10)",
    "--ab-accent-15": "rgba(245,132,31,0.15)",
    "--ab-accent-text": "#F5841F",
    "--ab-icon-btn-bg": "rgba(123,58,237,0.10)",
    "--ab-icon-btn-text": "#4C2CC5",
    "--ab-icon-btn-hover-bg": "rgba(245,132,31,0.15)",
    "--ab-icon-btn-hover-text": "#F5841F",
    "--ab-user-bubble": "#F5841F",
    "--ab-assistant-bubble": "#f1f5f9",
    "--ab-assistant-bubble-text": "#0f172a",
    "--ab-system-bubble": "#fff7ed",
    "--ab-system-bubble-text": "#9a3412",
    "--ab-system-bubble-border": "#fed7aa",
    "--ab-input-bg": "#ffffff",
    "--ab-input-border": "#e2e8f0",
    "--ab-input-text": "#0f172a",
    "--ab-input-placeholder": "#94a3b8",
    "--ab-focus-ring": "rgba(245,132,31,0.3)",
  },
  dark: {
    "--ab-bg": "#0F1729",
    "--ab-surface": "#162032",
    "--ab-surface-raised": "#1e293b",
    "--ab-border": "#1e293b",
    "--ab-border-subtle": "#1e293b",
    "--ab-text": "#f1f5f9",
    "--ab-text-secondary": "#94a3b8",
    "--ab-text-muted": "#64748b",
    "--ab-text-dim": "#475569",
    "--ab-accent": "#F5841F",
    "--ab-accent-hover": "#ff9a4d",
    "--ab-accent-10": "rgba(245,132,31,0.12)",
    "--ab-accent-15": "rgba(245,132,31,0.18)",
    "--ab-accent-text": "#F5841F",
    "--ab-icon-btn-bg": "rgba(123,58,237,0.22)",
    "--ab-icon-btn-text": "#C4A5FF",
    "--ab-icon-btn-hover-bg": "rgba(245,132,31,0.20)",
    "--ab-icon-btn-hover-text": "#F5841F",
    "--ab-user-bubble": "#F5841F",
    "--ab-assistant-bubble": "#1e293b",
    "--ab-assistant-bubble-text": "#e2e8f0",
    "--ab-system-bubble": "rgba(154,52,18,0.15)",
    "--ab-system-bubble-text": "#fdba74",
    "--ab-system-bubble-border": "rgba(251,146,60,0.25)",
    "--ab-input-bg": "#1e293b",
    "--ab-input-border": "#334155",
    "--ab-input-text": "#f1f5f9",
    "--ab-input-placeholder": "#64748b",
    "--ab-focus-ring": "rgba(245,132,31,0.35)",
  },
};

function useAssistantTheme() {
  const [isDark, setIsDark] = useState(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored !== null) return stored === "dark";
    } catch {}
    return false;
  });

  const toggle = () => setIsDark((p) => !p);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
    } catch {}
  }, [isDark]);

  return { isDark, toggle, themeVars: THEMES[isDark ? "dark" : "light"] };
}

// ── Contextual prompts hook ──────────────────────────────────────────────────

function detectTopic(messages) {
  const recent = messages.slice(-4);
  const text = recent
    .map((m) => m.message_text || "")
    .join(" ")
    .toLowerCase();

  let bestTopic = null;
  let bestScore = 0;

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic;
    }
  }

  return bestScore >= 1 ? bestTopic : null;
}

function pickFollowUps(topic, count = 3) {
  if (!topic || !CONTEXTUAL_PROMPTS[topic]) return [];
  const pool = [...CONTEXTUAL_PROMPTS[topic].followUps];
  const picked = [];
  const max = Math.min(count, pool.length);
  for (let i = 0; i < max; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function useContextualPrompts(messages) {
  const topic = detectTopic(messages);
  const [followUps, setFollowUps] = useState([]);

  useEffect(() => {
    if (topic) {
      setFollowUps(pickFollowUps(topic, 3));
    } else {
      setFollowUps([]);
    }
  }, [topic, messages.length]);

  return { topic, followUps };
}

// ── Constants ────────────────────────────────────────────────────────────────

const MODE_CONFIG = {
  M0_EXPLAIN: { label: "Explain", icon: Sparkles, color: "text-blue-600", bg: "bg-blue-50", border: "border-blue-200", description: "Product knowledge — no tenant data" },
  M1_INSPECT: { label: "Inspect", icon: FileText, color: "text-emerald-600", bg: "bg-emerald-50", border: "border-emerald-200", description: "Read-only billing data" },
  M2_PREPARE: { label: "Prepare", icon: Clock, color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-200", description: "Draft action — not executed" },
  M3_PREVIEW: { label: "Preview", icon: CheckCircle2, color: "text-purple-600", bg: "bg-purple-50", border: "border-purple-200", description: "Deterministic preview — confirm to proceed" },
  M4_EXECUTE: { label: "Execute", icon: Shield, color: "text-red-600", bg: "bg-red-50", border: "border-red-200", description: "Authorized mutation" },
  M5_ESCALATE: { label: "Escalate", icon: AlertTriangle, color: "text-orange-600", bg: "bg-orange-50", border: "border-orange-200", description: "Requires human attention" },
};

const RISK_COLORS = {
  R0: "bg-[var(--ab-surface-raised)] text-[var(--ab-text-secondary)]",
  R1: "bg-emerald-100 text-emerald-700",
  R2: "bg-amber-100 text-amber-700",
  R3: "bg-orange-100 text-orange-700",
  R4: "bg-red-100 text-red-700",
  RX: "bg-red-200 text-red-800",
};

// ── Conversation titling (mirrors backend derive_conversation_title) ─────────
const PLACEHOLDER_TITLES = new Set(["new conversation", "untitled", ""]);

function deriveTitle(text, maxLen = 48) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "New Conversation";
  if (t.length > maxLen) {
    let cut = t.slice(0, maxLen);
    if (cut.includes(" ")) cut = cut.slice(0, cut.lastIndexOf(" "));
    cut = cut.replace(/[\s,;:.!?—-]+$/, "");
    return cut.charAt(0).toUpperCase() + cut.slice(1) + "…";
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── Main component ───────────────────────────────────────────────────────────

export default function AssistantPanel({ isOpen, onClose }) {
  const { isDark, toggle, themeVars } = useAssistantTheme();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const { topic, followUps: contextualFollowUps } = useContextualPrompts(messages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState("");
  const [recentOpen, setRecentOpen] = useState(false);
  // UX spec §4.1 surface ladder: docked panel defaults to 440 px (within the
  // 420–480 range); the header expand control switches to the expanded
  // workspace width (680 px, within 560–720). Below `sm` the panel is a
  // full-screen sheet (spec: ≤767 px full-screen assistant).
  const [isExpanded, setIsExpanded] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const recentRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      loadSessions();
      inputRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadSessions = async () => {
    try {
      const data = await listSessions();
      setSessions(data);
      if (data.length > 0 && !activeSession) {
        await selectSession(data[0].conversation_uid);
      }
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  };

  const selectSession = async (uid) => {
    try {
      const session = await getSession(uid);
      setActiveSession(session);
      setMessages(session.messages || []);
      setStatusAnnouncement(`Loaded conversation: ${session.title || "Untitled"}`);
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    let targetUid = activeSession?.conversation_uid;
    setInput("");
    setLoading(true);
    setStatusAnnouncement("Assistant is thinking...");
    try {
      if (!targetUid) {
        // Title is derived server-side from the first user message; pass the
        // placeholder so the backend's derivation logic kicks in.
        const session = await createSession("New Conversation", text);
        setActiveSession(session);
        setSessions((prev) => [session, ...prev]);
        const initResp = session.messages?.[0];
        const userMsg = { message_uid: `temp-${Date.now()}`, sender_type: "user", message_text: text, created_at: new Date().toISOString() };
        const assistantMsg = {
          message_uid: initResp?.message_uid || `resp-${Date.now()}`,
          sender_type: "assistant",
          message_text: initResp?.answer || "",
          mode: initResp?.mode || "M0_EXPLAIN",
          risk_class: initResp?.risk_class || "R0",
          structured_payload: { evidence: initResp?.evidence || [], next_actions: initResp?.next_actions || [], qualification: initResp?.qualification, suggested_prompts: initResp?.suggested_prompts || [] },
          created_at: new Date().toISOString(),
        };
        setMessages([userMsg, assistantMsg]);
        const modeConfig = MODE_CONFIG[assistantMsg.mode] || MODE_CONFIG.M0_EXPLAIN;
        setStatusAnnouncement(`${modeConfig.label} response received`);
        return;
      }
      const userMsg = { message_uid: `temp-${Date.now()}`, sender_type: "user", message_text: text, created_at: new Date().toISOString() };
      setMessages((prev) => [...prev, userMsg]);
      const response = await sendMessage(targetUid, text);
      // Mirror the backend's first-message titling locally so the history
      // dropdown reflects the new title without a refetch.
      setSessions((prev) => prev.map((sess) => (
        sess.conversation_uid === targetUid &&
        PLACEHOLDER_TITLES.has((sess.title || "").trim().toLowerCase())
          ? { ...sess, title: deriveTitle(text) }
          : sess
      )));
      setActiveSession((prev) => (
        prev?.conversation_uid === targetUid &&
        PLACEHOLDER_TITLES.has((prev.title || "").trim().toLowerCase())
          ? { ...prev, title: deriveTitle(text) }
          : prev
      ));
      const assistantMsg = {
        message_uid: response.message_uid,
        sender_type: "assistant",
        message_text: response.answer,
        mode: response.mode,
        risk_class: response.risk_class,
        structured_payload: { evidence: response.evidence, next_actions: response.next_actions, qualification: response.qualification, suggested_prompts: response.suggested_prompts },
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      const modeConfig = MODE_CONFIG[response.mode] || MODE_CONFIG.M0_EXPLAIN;
      setStatusAnnouncement(`${modeConfig.label} response received`);
    } catch (err) {
      console.error("[CHATBOT-DIAG] handleSend FAILED:", err);
      console.error("[CHATBOT-DIAG] Error name:", err?.name, "message:", err?.message, "stack:", err?.stack);
      setMessages((prev) => [...prev, { message_uid: `error-${Date.now()}`, sender_type: "system", message_text: "Failed to send message. Please try again.", created_at: new Date().toISOString() }]);
      setStatusAnnouncement("Error sending message");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleNewConversation = async () => {
    setInitializing(true);
    setRecentOpen(false);
    try {
      const session = await createSession("New Conversation");
      setActiveSession(session);
      setMessages(session.messages || []);
      setSessions((prev) => [session, ...prev]);
      setStatusAnnouncement("New conversation started");
      inputRef.current?.focus();
    } catch (err) {
      console.error("Failed to create session:", err);
    } finally {
      setInitializing(false);
    }
  };

  useEffect(() => {
    if (!recentOpen) return;
    const handleClickOutside = (e) => {
      if (recentRef.current && !recentRef.current.contains(e.target)) setRecentOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [recentOpen]);

  if (!isOpen) return null;

  const s = (light, dark) => (isDark ? dark : light);

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {statusAnnouncement}
      </div>

      <div className="fixed inset-0 bg-black/20 z-40 lg:hidden" onClick={onClose} aria-hidden="true" />

      <div
        role="complementary"
        aria-label="AI Billing Assistant"
        className={`ab-panel fixed right-0 top-0 h-full w-full shadow-2xl z-50 flex flex-col transition-[width] duration-200 ease-out ${
          isExpanded ? "sm:w-[680px]" : "sm:w-[440px]"
        }`}
        style={themeVars}
        data-expanded={isExpanded || undefined}
      >
        {/* Header — spec §5.2: assistant name, connection/status indicator,
            close/expand controls */}
        <header className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid var(--ab-border)` }}>
          <div className="flex items-center gap-2">
            <ZoikoMark size={32} />
            <div>
              <h2 className="text-sm font-semibold" style={{ color: "var(--ab-text)" }}>Billing Assistant</h2>
              <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--ab-text-secondary)" }}>
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                Online · Zoiko Billing AI
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* New Conversation */}
            <button
              onClick={handleNewConversation}
              disabled={initializing}
              className="ab-icon-btn h-8 w-8 rounded-full flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="New conversation"
              title="New conversation"
            >
              <Plus size={16} strokeWidth={2} />
            </button>

            {/* Recent Conversations */}
            <div className="relative" ref={recentRef}>
              <button
                onClick={() => { if (!recentOpen) loadSessions(); setRecentOpen((p) => !p); }}
                className={`ab-icon-btn h-8 w-8 rounded-full flex items-center justify-center transition-colors ${recentOpen ? "ab-icon-btn--active" : ""}`}
                aria-label="Recent conversations"
                aria-expanded={recentOpen}
                aria-haspopup="listbox"
                title="Recent conversations"
              >
                <History size={16} strokeWidth={2} />
              </button>

              {recentOpen && (
                <div className="ab-dropdown absolute right-0 top-full mt-2 w-80 max-h-72 overflow-y-auto rounded-xl shadow-lg z-[60]" role="listbox" aria-label="Recent conversations">
                  {sessions.length === 0 ? (
                    <div className="px-4 py-6 text-center">
                      <p className="text-xs" style={{ color: "var(--ab-text-muted)" }}>No conversations yet</p>
                    </div>
                  ) : (
                    sessions.map((s) => {
                      const isActive = s.conversation_uid === activeSession?.conversation_uid;
                      const ts = s.created_at ? new Date(s.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
                      return (
                        <button
                          key={s.conversation_uid}
                          role="option"
                          aria-selected={isActive}
                          onClick={() => { selectSession(s.conversation_uid); setRecentOpen(false); }}
                          className={`ab-dropdown-item w-full text-left px-4 py-3 transition-colors ${isActive ? "ab-dropdown-item--active" : ""}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className={`text-sm truncate ${isActive ? "font-medium" : ""}`} style={{ color: isActive ? "var(--ab-accent-text)" : "var(--ab-text)" }}>
                              {s.title || "Untitled"}
                            </p>
                            <span className="text-[10px] whitespace-nowrap mt-0.5" style={{ color: "var(--ab-text-muted)" }}>{ts}</span>
                          </div>
                          <p className="text-[11px] mt-0.5" style={{ color: "var(--ab-text-muted)" }}>
                            {s.message_count || 0} messages · {s.status}
                          </p>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            {/* Theme toggle */}
            <button
              onClick={toggle}
              className="ab-icon-btn h-8 w-8 rounded-full flex items-center justify-center transition-colors"
              aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
              title={isDark ? "Light mode" : "Dark mode"}
            >
              {isDark ? <Sun size={16} strokeWidth={2} /> : <Moon size={16} strokeWidth={2} />}
            </button>

            {/* Expand / collapse workspace (spec §5.2 header controls) */}
            <button
              onClick={() => setIsExpanded((p) => !p)}
              className="ab-icon-btn h-8 w-8 rounded-full flex items-center justify-center transition-colors"
              aria-label={isExpanded ? "Collapse assistant panel" : "Expand assistant panel"}
              aria-pressed={isExpanded}
              title={isExpanded ? "Collapse panel" : "Expand panel"}
            >
              {isExpanded ? <Minimize2 size={16} strokeWidth={2} /> : <Maximize2 size={16} strokeWidth={2} />}
            </button>

            {/* Close */}
            <button
              onClick={onClose}
              className="ab-icon-btn h-8 w-8 rounded-full flex items-center justify-center transition-colors"
              aria-label="Close assistant panel"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </header>

        {/* Messages viewport */}
        <div className="ab-viewport flex-1 overflow-y-auto px-4 py-4 space-y-4" role="log" aria-label="Conversation messages">
          {messages.length === 0 && !loading && (
            <>
              {/* Welcome message bubble */}
              <div className="flex items-start gap-2">
                <ZoikoMark size={28} rounded="rounded-full" />
                <div className="ab-bubble-assistant rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed max-w-[85%]">
                  <div className="whitespace-pre-wrap">{WELCOME_MESSAGE}</div>
                </div>
              </div>

              {/* Category menu — 2 per row */}
              <div className="grid grid-cols-2 gap-2 mt-2">
                {FAQ_CATEGORIES.map((cat) => {
                  const isEscalate = cat.action === "escalate";
                  return (
                    <button
                      key={cat.num}
                      onClick={() => {
                        if (isEscalate) {
                          navigate("/billing/workspace/help");
                          onClose();
                          return;
                        }
                        setInput(cat.question);
                        setTimeout(() => {
                          handleSend();
                        }, 100);
                      }}
                      className={`ab-cat-btn group flex items-center gap-2.5 text-left transition-colors ${
                        isEscalate ? "ab-cat-btn--escalate" : ""
                      }`}
                    >
                      <span className="ab-cat-num inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[11px] font-bold">
                        {isEscalate ? <LifeBuoy size={12} strokeWidth={2.5} /> : cat.num}
                      </span>
                      <span className="text-[13px] font-medium leading-tight flex-1" style={{ color: "var(--ab-text)" }}>
                        {cat.label}
                      </span>
                      <ArrowRight
                        size={12}
                        className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ color: "var(--ab-accent-text)" }}
                      />
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {messages.map((msg) => (
            <MessageBubble
              key={msg.message_uid}
              message={msg}
              showDisclaimer={
                msg.sender_type === "assistant" &&
                msg.message_uid ===
                  messages.find((m) => m.sender_type === "assistant")?.message_uid
              }
            />
          ))}

          {loading && (
            <div className="flex items-start gap-2">
              <ZoikoMark size={28} rounded="rounded-full" />
              <div className="ab-bubble-assistant rounded-2xl rounded-tl-sm px-4 py-3">
                <div className="flex items-center gap-2">
                  <Loader2 size={14} className="text-brand animate-spin" />
                  <span className="text-xs" style={{ color: "var(--ab-text-secondary)" }}>Checking records...</span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Suggested prompts — contextual follow-ups or server-side suggestions.
            next_actions from the answer payload surface here as chips instead
            of inline arrow lists in the bubble (deduped/capped by
            SuggestedPrompts). */}
        {messages.length > 0 && !loading && (
          <SuggestedPrompts
            prompts={
              // Prefer server-provided follow-ups if available
              messages[messages.length - 1]?.sender_type === "assistant"
                ? [
                    ...(messages[messages.length - 1]?.structured_payload?.suggested_prompts || []),
                    ...(messages[messages.length - 1]?.structured_payload?.next_actions || [])
                      .filter((a) => !/^try:/i.test(String(a).trim())),
                  ]
                : []
            }
            contextualPrompts={contextualFollowUps}
            onSelect={(p) => { setInput(p); setTimeout(() => handleSend(), 100); }}
          />
        )}

        {/* Composer */}
        <footer className="ab-footer px-4 py-3" style={{ borderTop: `1px solid var(--ab-border)` }}>
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about billing..."
              rows={1}
              className="ab-input flex-1 resize-none rounded-xl px-3 py-2.5 text-sm transition-colors focus:outline-none focus:ring-2"
              style={{ "--tw-ring-color": "var(--ab-focus-ring)" }}
              aria-label="Type your billing question"
              disabled={loading || initializing}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading}
              className="p-2.5 rounded-xl bg-brand text-white hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label="Send message"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="mt-2 text-[10px] text-center" style={{ color: "var(--ab-text-muted)" }}>
            AI-assisted. Verify financial data in billing records.
          </p>
        </footer>
      </div>
    </>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function formatChatTimestamp(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function CaptionTimestamp({ iso, label }) {
  const d = formatChatTimestamp(iso);
  if (!d) return null;
  const short = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const full = d.toLocaleString();
  return (
    <span className="ab-caption" title={full}>
      {label && <>{label}: </>}
      {short}
    </span>
  );
}

// ── Markdown body renderer (assistant / system messages) ─────────────────────
// The engine answers in markdown (**bold**, "- item" lists, sections separated
// by blank lines). react-markdown parses it into React elements — it never
// touches innerHTML and raw HTML in the content is escaped by default (no
// rehype-raw), so AI/user-generated content is XSS-safe by construction.
const MD_COMPONENTS = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-2 space-y-1 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-2 space-y-1 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
      style={{ color: "var(--ab-accent)" }}
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code
      className="px-1 py-0.5 rounded text-[0.85em] font-mono"
      style={{ background: "var(--ab-surface-raised)" }}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre
      className="overflow-x-auto rounded-lg p-3 my-2 text-xs font-mono"
      style={{ background: "var(--ab-surface-raised)" }}
    >
      {children}
    </pre>
  ),
  h1: ({ children }) => <h3 className="text-base font-semibold my-2 first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="text-sm font-semibold my-2 first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="text-sm font-semibold my-2 first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="text-sm font-semibold my-2 first:mt-0">{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote
      className="border-l-2 pl-3 my-2 italic opacity-80"
      style={{ borderColor: "var(--ab-border)" }}
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-t" style={{ borderColor: "var(--ab-border)" }} />,
};

function MarkdownContent({ text }) {
  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown components={MD_COMPONENTS}>{text || ""}</ReactMarkdown>
    </div>
  );
}

function SourceFooter({ evidence, disclaimer }) {
  const [open, setOpen] = useState(false);
  const primary = evidence[0] || {};
  const label = primary.source || primary.type || "Source";
  const extra = evidence.length > 1 ? ` +${evidence.length - 1}` : "";

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Show sources"
        className="ab-citation text-[10px] inline-flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity"
      >
        <Info size={10} className="flex-shrink-0" />
        <span>{label}{extra}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {evidence.map((ev, i) => (
            <div key={i} className="ab-citation text-[10px] flex items-start gap-1">
              <FileText size={10} className="mt-0.5 flex-shrink-0" />
              <span>{ev.source || ev.type}{ev.reference && ` — ${ev.reference}`}</span>
            </div>
          ))}
          {disclaimer && (
            <p className="ab-citation text-[10px] italic">{disclaimer}</p>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, showDisclaimer = false }) {
  const isUser = message.sender_type === "user";
  const isSystem = message.sender_type === "system";
  const mode = message.mode ? MODE_CONFIG[message.mode] : null;
  const riskClass = message.risk_class || "R0";
  const evidence = message.structured_payload?.evidence || [];
  const qualifications = message.structured_payload?.qualification;

  const primaryEvidence = evidence[0] || {};
  const evType = primaryEvidence.type;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} gap-2`}>
      {!isUser && (
        isSystem ? (
          <div className="h-7 w-7 rounded-full flex items-center justify-center flex-shrink-0 bg-orange-500">
            <AlertTriangle size={14} className="text-white" />
          </div>
        ) : (
          <ZoikoMark size={28} rounded="rounded-full" />
        )
      )}

      <div className={`max-w-[85%] ${isUser ? "order-1" : ""}`}>
        {mode && (
          <div className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full mb-1 ${mode.bg} ${mode.color} ${mode.border} border`}>
            <mode.icon size={10} />
            {mode.label}
            <span className={`ml-1 px-1 rounded text-[9px] ${RISK_COLORS[riskClass]}`}>{riskClass}</span>
          </div>
        )}

        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? "bg-brand text-white rounded-br-sm"
              : isSystem
              ? "ab-bubble-system rounded-bl-sm"
              : "ab-bubble-assistant rounded-bl-sm"
          }`}
        >
          {isUser ? (
            <div className="whitespace-pre-wrap">{message.message_text}</div>
          ) : (
            <MarkdownContent text={message.message_text} />
          )}
        </div>

        {!isUser && (
          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 leading-none">
            {(evType === "action_draft" || evType === "action_preview") && (
              <>
                <CaptionTimestamp iso={primaryEvidence.created_at} label="Generated" />
                <CaptionTimestamp iso={primaryEvidence.expires_at} label="Expires" />
              </>
            )}
            {evType === "action_executed" && (
              <CaptionTimestamp iso={primaryEvidence.executed_at} label="Executed" />
            )}
            {(evType === "dashboard_summary" || evType === "balance_summary" || evType === "overdue_summary" || evType === "reconciliation_summary") && (
              <CaptionTimestamp iso={primaryEvidence.as_of} label="As of" />
            )}
          </div>
        )}

        {evidence.length > 0 && !isUser && (
          <SourceFooter
            evidence={evidence}
            disclaimer={qualifications}
            defaultOpen={false}
          />
        )}

        {/* Provenance notice: shown in full only on the first assistant
            answer of a conversation; afterwards it stays available inside
            the collapsed source footer (and always in the response payload,
            per FRS traceability / Guardrail §13 Output Policy). */}
        {showDisclaimer && qualifications && !isUser && (
          <p className="ab-citation text-[10px] mt-1 italic">{qualifications}</p>
        )}
      </div>

      {isUser && (
        <div className="h-7 w-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "var(--ab-surface-raised)" }}>
          <User size={14} style={{ color: "var(--ab-text-secondary)" }} />
        </div>
      )}
    </div>
  );
}

function SuggestedPrompts({ prompts, contextualPrompts, onSelect }) {
  // Merge: server-side prompts first, contextual follow-ups as fallback
  const merged = [];
  const seen = new Set();

  for (const p of [...(prompts || []), ...(contextualPrompts || [])]) {
    if (merged.length >= 4) break;
    const key = p.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(p);
    }
  }

  if (merged.length === 0) return null;

  return (
    <div className="px-4 py-2" style={{ borderTop: `1px solid var(--ab-border-subtle)` }}>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {merged.map((prompt, i) => (
          <button
            key={i}
            onClick={() => onSelect(prompt)}
            className="ab-chip flex-shrink-0 text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
