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
  sendMessageStreamed,
  generatePreview,
  confirmAction,
  executeAction,
  cancelAction,
} from "./api";
import { useTypewriter } from "./useTypewriter";
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
  const prevTopicRef = useRef(null);

  useEffect(() => {
    if (topic && topic !== prevTopicRef.current) {
      prevTopicRef.current = topic;
      setFollowUps(pickFollowUps(topic, 3));
    } else if (!topic) {
      prevTopicRef.current = null;
      setFollowUps([]);
    }
  }, [topic]);

  return { topic, followUps };
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * BUG 2 fix: Scan conversation messages for executed action UIDs.
 * The M4 execution response includes evidence with type="action_executed"
 * and action_uid.  We collect these so any draft card with a matching
 * action_uid renders as a read-only receipt (no active buttons).
 */
function scanExecutedActionUids(messages) {
  const uids = new Set();
  for (const msg of messages || []) {
    const evidence = msg.structured_payload?.evidence || [];
    for (const ev of evidence) {
      if (ev.type === "action_executed" && ev.action_uid) {
        uids.add(ev.action_uid);
      }
    }
  }
  return uids;
}

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
  const [previewData, setPreviewData] = useState(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [activeAction, setActiveAction] = useState(null);
  // BUG 2 fix: Track which action UIDs have been executed so stale
  // draft cards render as read-only receipts instead of active buttons.
  const [executedActionUids, setExecutedActionUids] = useState(() => new Set());
  // UX spec §4.1 surface ladder: docked panel defaults to 440 px (within the
  // 420–480 range); the header expand control switches to the expanded
  // workspace width (680 px, within 560–720). Below `sm` the panel is a
  // full-screen sheet (spec: ≤767 px full-screen assistant).
  const [isExpanded, setIsExpanded] = useState(false);
  const chatViewportRef = useRef(null);
  const inputRef = useRef(null);
  const recentRef = useRef(null);
  const sessionsLoadingRef = useRef(false);
  // Auto-follow (ChatGPT-style): while TRUE the chat keeps the LATEST content
  // pinned at the bottom (message sends + every typewriter chunk + the final
  // reveal).  A single passive scroll listener flips it OFF when the user
  // deliberately scrolls up to read older messages, and back ON only when
  // they return to the bottom or send a new message — we never yank someone
  // back down mid-read.  Refs only: no state → zero re-renders from scrolling.
  const stickRef = useRef(true);
  const scrollChatToBottom = useCallback((behavior = "auto") => {
    const el = chatViewportRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);
  // Typewriter (FE): the assistant message currently animating, and whether
  // its progressive reveal has completed.  Only NEW responses animate —
  // restored history renders instantly.  When a newer message arrives the
  // previous `animatingUid` is superseded, which snaps the old animation to
  // its complete text (never two overlapped animations, never dropped chars).
  const [animatingUid, setAnimatingUid] = useState(null);
  const [animDoneUid, setAnimDoneUid] = useState(null);
  // SSE streaming (FE): uid of the assistant message whose text is still
  // arriving from the streaming endpoint.  While set it renders raw (never
  // re-types) and defers structured blocks; cleared when the stream's
  // terminal `done` event reconciles the authoritative reply.
  const [streamingUid, setStreamingUid] = useState(null);

  useEffect(() => {
    if (isOpen) {
      console.warn("[assistant-cx] panel opened: loading session history");
      loadSessions();
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Only the chat container's own scroll moves: the viewport is scrollable
  // in isolation, so the browser page is never scrolled by the panel.
  useEffect(() => {
    const el = chatViewportRef.current;
    if (!el) return;
    const trackStick = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
      if (atBottom && !stickRef.current) stickRef.current = true;
      else if (!atBottom && stickRef.current) stickRef.current = false;
    };
    el.addEventListener("scroll", trackStick, { passive: true });
    return () => el.removeEventListener("scroll", trackStick);
  }, [isOpen]);

  // Follow the newest content whenever the message list changes
  // (send, history restore, reply delivered).  Per-chunk typing ticks are
  // handled inside MarkdownTypewriter via the same stick-aware scroll.
  useEffect(() => {
    scrollChatToBottom();
  }, [messages, scrollChatToBottom]);

  // BUG 2 fix: Whenever messages change (load, append), scan for
  // executed action UIDs and update the tracking set.
  useEffect(() => {
    const found = scanExecutedActionUids(messages);
    if (found.size > 0) {
      setExecutedActionUids((prev) => {
        const merged = new Set(prev);
        for (const uid of found) merged.add(uid);
        return merged;
      });
    }
  }, [messages]);

  const loadSessions = async () => {
    if (sessionsLoadingRef.current) return;
    sessionsLoadingRef.current = true;
    try {
      const data = await listSessions();
      setSessions(data);
      if (data.length > 0 && !activeSession) {
        // Pre-fetch first session data in parallel with setting sessions
        const firstSession = data[0];
        getSession(firstSession.conversation_uid).then((session) => {
          console.warn("[assistant-cx] session restored:", firstSession.conversation_uid, `(${session.messages?.length || 0} messages)`);
          setActiveSession(session);
          setMessages(session.messages || []);
          setAnimatingUid(null);
          setAnimDoneUid(null);
          setStatusAnnouncement(`Loaded conversation: ${session.title || "Untitled"}`);
        }).catch((err) => {
          console.warn("[assistant-cx] session restore FAILED:", firstSession.conversation_uid, err?.name, err?.message);
          console.error("Failed to load session:", err);
        });
      }
    } catch (err) {
      console.warn("[assistant-cx] listSessions FAILED:", err?.name, err?.message);
      console.error("Failed to load sessions:", err);
    } finally {
      sessionsLoadingRef.current = false;
    }
  };

  const selectSession = async (uid) => {
    if (activeSession?.conversation_uid === uid) return;
    try {
      const session = await getSession(uid);
      setActiveSession(session);
      setMessages(session.messages || []);
      setAnimatingUid(null);
      setAnimDoneUid(null);
      setStatusAnnouncement(`Loaded conversation: ${session.title || "Untitled"}`);
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  };

  const notifySendFailure = (err) => {
    console.error("[CHATBOT-DIAG] send failure:", err?.name, err?.message, {
      status: err?.status,
      sessionExpired: err?.sessionExpired,
      retryAfter: err?.retryAfter,
      cause: err?.cause,
    });
    let errorText;
    let errorStatus;
    if (err?.sessionExpired) {
      errorText = "Your session has expired. Please sign in again to continue.";
      errorStatus = "Session expired";
    } else if (err?.status === 429) {
      const wait = err?.retryAfter || 10;
      errorText = `You're sending messages a bit quickly — please wait ${wait}s and try again.`;
      errorStatus = "Rate limited";
    } else {
      // Friendly copy for everyone…
      const friendly = "Couldn't reach the assistant just now. Your message is on the screen above — tap send to retry.";
      // …but in development the real reason is never hidden (status + server
      // detail go straight into the bubble so the Network tab and the console
      // agree). Production always shows the friendly message only.
      if (import.meta.env.MODE === "development") {
        const statusLabel = err?.status != null ? `HTTP ${err.status}` : "network error";
        errorText = `${friendly}\n(${statusLabel}: ${err?.message || "unknown"})`;
      } else {
        errorText = friendly;
      }
      errorStatus = err?.status != null ? `HTTP ${err.status}` : "Connection issue";
    }
    setMessages((prev) => [...prev, {
      message_uid: `error-${Date.now()}`,
      sender_type: "system",
      message_text: errorText,
      created_at: new Date().toISOString(),
    }]);
    setStatusAnnouncement(errorStatus);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    // A new message always resumes auto-follow and jumps to the latest
    // content — even if the user had scrolled up to read older messages.
    stickRef.current = true;
    scrollChatToBottom();
    let targetUid = activeSession?.conversation_uid;
    setInput("");
    setLoading(true);
    setStatusAnnouncement("Assistant is thinking...");
    // Streaming fires-and-forgets (SSE callbacks settle later), so the shared
    // catch/finally below must not tear down loading/side effects before the
    // stream has reached its terminal event. Once a stream is started only
    // its settle() (onDone/onError) clears `loading`.
    let didStartStream = false;
    let streamSettled = false;
    try {
      if (!targetUid) {
        const userMsg = { message_uid: `temp-${Date.now()}`, sender_type: "user", message_text: text, created_at: new Date().toISOString() };
        setMessages([userMsg]);
        try {
          // Title is derived server-side from the first user message; pass the
          // placeholder so the backend's derivation logic kicks in.
          const session = await createSession("New Conversation", text);
          setActiveSession(session);
          setSessions((prev) => [session, ...prev]);
          const initResp = session.messages?.[0];
          const assistantMsg = {
            message_uid: initResp?.message_uid || `resp-${Date.now()}`,
            sender_type: "assistant",
            message_text: initResp?.answer || "",
            mode: initResp?.mode || "M0_EXPLAIN",
            risk_class: initResp?.risk_class || "R0",
            structured_payload: { evidence: initResp?.evidence || [], next_actions: initResp?.next_actions || [], qualification: initResp?.qualification, suggested_prompts: initResp?.suggested_prompts || [], actions: initResp?.actions || [], draft_card: initResp?.draft_card, preview_card: initResp?.preview_card, confirm_label: initResp?.confirm_label },
            created_at: new Date().toISOString(),
          };
          setMessages([userMsg, assistantMsg]);
          setAnimatingUid(assistantMsg.message_uid);
          setAnimDoneUid(null);
          const modeConfig = MODE_CONFIG[assistantMsg.mode] || MODE_CONFIG.M0_EXPLAIN;
          setStatusAnnouncement(`${modeConfig.label} response received`);
        } catch (err) {
          console.warn("[assistant-cx] createSession FAILED:", err?.name, err?.message);
          notifySendFailure(err);
        }
        return;
      }
      const userMsg = { message_uid: `temp-${Date.now()}`, sender_type: "user", message_text: text, created_at: new Date().toISOString() };
      setMessages((prev) => [...prev, userMsg]);
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

      // Optimistic streaming bubble: text fills in as SSE `token` events
      // arrive; the authoritative reply reconciles on the `done` event.
      const respUid = `resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setMessages((prev) => [...prev, {
        message_uid: respUid,
        sender_type: "assistant",
        message_text: "",
        mode: "M0_EXPLAIN",
        risk_class: "R0",
        structured_payload: {},
        created_at: new Date().toISOString(),
      }]);
      setStreamingUid(respUid);
      setAnimatingUid(null);
      setAnimDoneUid(null);

      let done = false;
      let pendingTokens = [];
      let flushTimer = null;
      const flushTokens = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (!pendingTokens.length) return;
        const chunk = pendingTokens.join("");
        pendingTokens = [];
        setMessages((prev) => prev.map((m) =>
          m.message_uid === respUid ? { ...m, message_text: (m.message_text || "") + chunk } : m
        ));
        scrollChatToBottom();
      };
      const settle = () => {
        streamSettled = true;
        if (done) return;
        done = true;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        setLoading(false);
      };

      didStartStream = true;
      sendMessageStreamed(targetUid, text, undefined, {
        onToken: (delta) => {
          if (done) return;
          pendingTokens.push(delta);
          if (!flushTimer) flushTimer = setTimeout(flushTokens, 40);
        },
        onDone: (payload) => {
          if (done) return;
          const response = payload.response || {};
          const streamed = payload.streamed === true;
          // Sweep any token stragglers into the bubble, then overwrite with
          // the authoritative answer so partial text can never drift from it.
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          pendingTokens = [];
          setMessages((prev) => prev.map((m) =>
            m.message_uid === respUid
              ? {
                  ...m,
                  message_text: response.answer || m.message_text,
                  mode: response.mode || m.mode,
                  risk_class: response.risk_class || m.risk_class,
                  structured_payload: {
                    evidence: response.evidence || [],
                    next_actions: response.next_actions || [],
                    qualification: response.qualification,
                    suggested_prompts: response.suggested_prompts || [],
                    actions: response.actions || [],
                    draft_card: response.draft_card,
                    preview_card: response.preview_card,
                    confirm_label: response.confirm_label,
                  },
                }
              : m
          ));
          setStreamingUid(null);
          if (streamed) {
            // Words already appeared live — settle at the bottom of the reply
            // without re-typing it.
            setAnimDoneUid(respUid);
            requestAnimationFrame(scrollChatToBottom);
          } else {
            // Whole answer arrived at once (rules/canned/cached) — type it out.
            setAnimatingUid(respUid);
            setAnimDoneUid(null);
            requestAnimationFrame(scrollChatToBottom);
          }
          const modeConfig = MODE_CONFIG[response.mode || "M0_EXPLAIN"] || MODE_CONFIG.M0_EXPLAIN;
          setStatusAnnouncement(`${modeConfig.label} response received`);
          settle();
        },
        onError: (err) => {
          console.error("[CHATBOT-DIAG] stream FAILED:", err?.name, err?.message);
          setStreamingUid(null);
          settle();
          notifySendFailure(err);
        },
      });
    } catch (err) {
      if (!streamSettled) {
        console.error("[CHATBOT-DIAG] handleSend FAILED (pre-stream):", err?.name, err?.message, err?.stack);
        notifySendFailure(err);
      }
    } finally {
      // The streaming path is fire-and-forget: settle() (onDone/onError) owns
      // setLoading(false), so the synchronous finally must not clear it early.
      if (!didStartStream) setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleAction = useCallback(async (actionObj) => {
    const { action, action_uid } = actionObj;
    if (action === "preview_draft") {
      try {
        setLoading(true);
        const preview = await generatePreview(action_uid);
        setPreviewData(preview);
        setActiveAction(actionObj);
      } catch (err) {
        setMessages((prev) => [...prev, {
          message_uid: `err-${Date.now()}`,
          sender_type: "system",
          message_text: `Preview failed: ${err.message}`,
          created_at: new Date().toISOString(),
        }]);
      } finally {
        setLoading(false);
      }
    } else if (action === "confirm_draft") {
      if (previewData) {
        setShowConfirmDialog(true);
        setActiveAction(actionObj);
      } else {
        try {
          setLoading(true);
          const preview = await generatePreview(action_uid);
          setPreviewData(preview);
          setActiveAction(actionObj);
          setShowConfirmDialog(true);
        } catch (err) {
          setMessages((prev) => [...prev, {
            message_uid: `err-${Date.now()}`,
            sender_type: "system",
            message_text: `Preview failed: ${err.message}`,
            created_at: new Date().toISOString(),
          }]);
        } finally {
          setLoading(false);
        }
      }
    } else if (action === "cancel_draft") {
      try {
        setLoading(true);
        await cancelAction(action_uid);
        setPreviewData(null);
        setActiveAction(null);
        setMessages((prev) => [...prev, {
          message_uid: `sys-${Date.now()}`,
          sender_type: "system",
          message_text: "Draft has been cancelled and discarded.",
          created_at: new Date().toISOString(),
        }]);
      } catch (err) {
        setMessages((prev) => [...prev, {
          message_uid: `err-${Date.now()}`,
          sender_type: "system",
          message_text: `Cancel failed: ${err.message}`,
          created_at: new Date().toISOString(),
        }]);
      } finally {
        setLoading(false);
      }
    }
  }, [previewData]);

  const handlePreviewConfirm = useCallback(async (preview) => {
    const uid = preview.action_uid || activeAction?.action_uid;
    try {
      setLoading(true);
      setShowConfirmDialog(false);
      const idempotencyKey = crypto.randomUUID();
      await confirmAction(uid, preview.preview_uid, preview.preview_hash);
      await executeAction(uid, idempotencyKey);
      // BUG 2 fix: Mark this action as executed so the draft card
      // renders as a read-only receipt and cannot be tapped again.
      if (uid) {
        setExecutedActionUids((prev) => {
          const next = new Set(prev);
          next.add(uid);
          return next;
        });
      }
      setPreviewData(null);
      setActiveAction(null);
      const execUid = `exec-${Date.now()}`;
      setMessages((prev) => [...prev, {
        message_uid: execUid,
        sender_type: "assistant",
        message_text: "**Action executed successfully.** The mutation is now live.",
        mode: "M4_EXECUTE",
        risk_class: "R2",
        structured_payload: {
          evidence: [{
            source: "Zoiko Billing Action Engine",
            type: "action_executed",
            action_uid: uid,
          }],
          next_actions: [],
          qualification: "Action has been executed. The mutation is now live.",
          suggested_prompts: ["Create a new draft"],
          actions: [],
        },
        created_at: new Date().toISOString(),
      }]);
      setAnimatingUid(execUid);
      setAnimDoneUid(null);
    } catch (err) {
      setMessages((prev) => [...prev, {
        message_uid: `err-${Date.now()}`,
        sender_type: "system",
        message_text: `Execution failed: ${err.message}`,
        created_at: new Date().toISOString(),
      }]);
    } finally {
      setLoading(false);
    }
  }, [activeAction]);

  const handlePreviewCancel = useCallback(() => {
    setShowConfirmDialog(false);
    setPreviewData(null);
    setActiveAction(null);
  }, []);

  // BUG 1 fix: Tapping the confirm button on PreviewCard must open the
  // ConfirmDialog for an explicit second confirmation step — it must
  // NOT execute directly.  The ConfirmDialog's onConfirm is the sole
  // gate to execution (handlePreviewConfirm).
  const handleShowConfirmDialog = useCallback(() => {
    setShowConfirmDialog(true);
  }, []);

  const handlePreviewRefresh = useCallback(async () => {
    if (!activeAction?.action_uid) return;
    try {
      setLoading(true);
      const preview = await generatePreview(activeAction.action_uid);
      setPreviewData(preview);
    } catch (err) {
      setMessages((prev) => [...prev, {
        message_uid: `err-${Date.now()}`,
        sender_type: "system",
        message_text: `Preview refresh failed: ${err.message}`,
        created_at: new Date().toISOString(),
      }]);
    } finally {
      setLoading(false);
    }
  }, [activeAction]);

  const handleNewConversation = async () => {
    setInitializing(true);
    setRecentOpen(false);
    try {
      const session = await createSession("New Conversation");
      setActiveSession(session);
      setMessages(session.messages || []);
      setAnimatingUid(null);
      setAnimDoneUid(null);
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
        className={`ab-panel h-full shrink-0 flex flex-col border-l border-[var(--ab-border)] transition-[width] duration-200 ease-out lg:shadow-2xl lg:pt-[65px] ${
          isExpanded ? "w-[680px]" : "w-[440px]"
        } max-lg:fixed max-lg:inset-0 max-lg:w-full max-lg:z-50 max-lg:border-0 max-lg:shadow-2xl`}
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
        <div ref={chatViewportRef} className="ab-viewport flex-1 overflow-y-auto px-4 py-4 space-y-4" role="log" aria-label="Conversation messages">
          {messages.length === 0 && !loading && (
            <>
              {/* Welcome message bubble */}
              <div className="flex items-start gap-2">
                <ZoikoMark size={28} rounded="rounded-lg" />
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

          {messages.map((msg) => {
            const animating =
              msg.sender_type === "assistant" && msg.message_uid === animatingUid;
            const isStreaming =
              msg.sender_type === "assistant" && msg.message_uid === streamingUid;
            // Structured blocks (draft/action cards, evidence, captions,
            // qualification) wait until the reveal completes — while the
            // typewriter runs OR the SSE stream is live — then appear,
            // no flicker, matching a streaming UX.
            const deferStructured =
              (animating || isStreaming) &&
              animDoneUid !== msg.message_uid &&
              !!msg.message_text;
            return (
              <div key={msg.message_uid}>
                <MessageBubble
                  message={msg}
                  showDisclaimer={
                    msg.sender_type === "assistant" &&
                    msg.message_uid ===
                      messages.find((m) => m.sender_type === "assistant")?.message_uid
                  }
                  animate={animating}
                  streaming={isStreaming}
                  deferStructured={deferStructured}
                  onChunkScroll={scrollChatToBottom}
                  onDone={() => {
                    if (msg.message_uid === animatingUid) {
                      setAnimDoneUid(msg.message_uid);
                      // Deferred structured blocks (evidence, cards) reveal
                      // in the same commit as `animDoneUid` — settle the
                      // scroll AFTER the DOM has grown so the post-reveal
                      // viewport rests exactly at the bottom.
                      requestAnimationFrame(scrollChatToBottom);
                    }
                  }}
                />
                {/* §8.1 — M2 Editable Structured Draft Card */}
                {msg.structured_payload?.draft_card && msg.sender_type === "assistant" && !deferStructured && (
                  <div className="pl-9 mt-2">
                    <DraftCard
                      draftCard={msg.structured_payload.draft_card}
                      actions={msg.structured_payload.actions}
                      onAction={handleAction}
                      loading={loading}
                      isExecuted={executedActionUids.has(msg.structured_payload.draft_card.action_uid)}
                    />
                  </div>
                )}
                {/* BUG 2 fix: Only show ActionButtons if the action has NOT been executed */}
                {msg.structured_payload?.actions?.length > 0 && msg.sender_type === "assistant" && !msg.structured_payload?.draft_card && !msg.structured_payload?.preview_card && !executedActionUids.has(msg.structured_payload.actions?.[0]?.action_uid) && !deferStructured && (
                  <div className="pl-9">
                    <ActionButtons
                      actions={msg.structured_payload.actions}
                      onAction={handleAction}
                      loading={loading}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {previewData && (
            <div className="pl-9 mt-2">
              <PreviewCard
                preview={previewData}
                onConfirm={handleShowConfirmDialog}
                onCancel={handlePreviewCancel}
                onRefresh={handlePreviewRefresh}
              />
            </div>
          )}

          {loading && !streamingUid && (
            <div className="flex items-start gap-2">
              <ZoikoMark size={28} rounded="rounded-lg" />
              <div className="ab-bubble-assistant rounded-2xl rounded-tl-sm px-4 py-3">
                <div className="flex items-center gap-2">
                  <Loader2 size={14} className="text-brand animate-spin" />
                  <span className="text-xs" style={{ color: "var(--ab-text-secondary)" }}>Checking records...</span>
                </div>
              </div>
            </div>
          )}

          <div aria-hidden="true" />
        </div>

        {/* Suggested prompts — contextual follow-ups or server-side suggestions.
            Suppress when action buttons are present on the last assistant message. */}
        {messages.length > 0 && !loading && !messages[messages.length - 1]?.structured_payload?.actions?.length && !messages[messages.length - 1]?.structured_payload?.draft_card && !messages[messages.length - 1]?.structured_payload?.preview_card && (
          <SuggestedPrompts
            prompts={
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

        {showConfirmDialog && previewData && (
          <ConfirmDialog
            preview={previewData}
            onConfirm={handlePreviewConfirm}
            onCancel={handlePreviewCancel}
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

/**
 * Live body for an SSE-streaming assistant bubble: renders whatever text has
 * arrived so far plus a trailing blinking caret.  Unlike MarkdownTypewriter
 * it never re-animates — each `token` event simply renders the accumulated
 * Markdown (transient half-markup, e.g. a partially-open `**`, settles once
 * the authoritative text lands).
 */
function StreamingText({ text }) {
  return (
    <div className="text-sm leading-relaxed">
      {text ? <ReactMarkdown components={MD_COMPONENTS}>{text}</ReactMarkdown> : null}
      <span className="ab-typing-caret ml-0.5" aria-hidden="true" />
    </div>
  );
}

/**
 * Progressive-typing body for a single assistant bubble (ChatGPT-style).
 * ── The reveal NEVER swaps component trees: `useTypewriter` advances a
 * prefix of the token stream and this component re-renders ReactMarkdown on
 * top of it, so the completed state is byte-identical to MarkdownContent and
 * there is no flicker or layout jump at the end.
 * ── "Typing…" is shown only while waiting for the first content chunk.
 * ── A small blinking caret trails partial text; both disappear on complete.
 */
function MarkdownTypewriter({ text, onChunkScroll, onDone }) {
  const { displayed, isTyping, done } = useTypewriter(text);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onChunkScrollRef = useRef(onChunkScroll);
  onChunkScrollRef.current = onChunkScroll;
  const firedRef = useRef(false);

  useEffect(() => {
    if (done && !firedRef.current) {
      firedRef.current = true;
      onDoneRef.current?.();
    }
  }, [done]);

  // Keep the viewport pinned to the live cursor as each chunk is revealed,
  // in lock-step with the typing animation.  The callback is ref-backed so
  // this fires on every chunk without re-binding the effect; it is a no-op
  // while the user is scrolled up reading history (stick-aware) and uses
  // instant positioning to avoid any smooth-scroll lag behind the words.
  useEffect(() => {
    if (displayed) onChunkScrollRef.current?.();
  }, [displayed]);

  const hasText = text && text.length > 0;

  return (
    <div className="text-sm leading-relaxed">
      {isTyping && !displayed && hasText && (
        <span
          className="inline-flex items-center gap-1 uppercase tracking-wider text-[10px]"
          style={{ color: "var(--ab-text-muted)" }}
          role="status"
        >
          <span className="ab-typing-dot ab-typing-dot--1" />
          <span className="ab-typing-dot ab-typing-dot--2" />
          <span className="ab-typing-dot ab-typing-dot--3" />
          <span className="sr-only">Assistant is typing</span>
        </span>
      )}
      {isTyping && !displayed && hasText && (
        <span className="inline-block h-4" aria-hidden="true" />
      )}
      {displayed && (
        <ReactMarkdown components={MD_COMPONENTS}>{displayed}</ReactMarkdown>
      )}
      {isTyping && displayed && hasText && (
        <span className="ab-typing-caret ml-0.5" aria-hidden="true" />
      )}
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

function MessageBubble({ message, showDisclaimer = false, animate = false, streaming = false, deferStructured = false, onChunkScroll, onDone }) {
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
          <ZoikoMark size={28} rounded="rounded-lg" />
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
          ) : streaming ? (
            <StreamingText text={message.message_text} />
          ) : animate ? (
            <MarkdownTypewriter text={message.message_text} onChunkScroll={onChunkScroll} onDone={onDone} />
          ) : (
            <MarkdownContent text={message.message_text} />
          )}
        </div>

        {!isUser && !deferStructured && (
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

        {evidence.length > 0 && !isUser && !deferStructured && (
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
        {showDisclaimer && qualifications && !isUser && !deferStructured && (
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

function ActionButtons({ actions, onAction, loading }) {
  if (!actions || actions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {actions.map((a, i) => (
        <button
          key={`${a.action}-${i}`}
          onClick={() => onAction(a)}
          disabled={loading}
          className="ab-action-btn disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/**
 * §8.1 — DraftCard: Editable structured draft card for M2 Prepare.
 * Shows the extracted parameters in a structured format so the user
 * can review what was captured before generating the authoritative preview.
 *
 * BUG 2 fix: When `isExecuted` is true, renders a read-only completed
 * receipt with no tappable buttons — preventing duplicate execution
 * of an already-completed action.
 */
function DraftCard({ draftCard, actions, onAction, loading, isExecuted }) {
  if (!draftCard) return null;

  const { action_label, customer_name, line_items, currency, subtotal, tax_rate, tax_amount, total, expires_at } = draftCard;

  function fmtCurrency(val, cur) {
    if (!val) return "—";
    try {
      return `${cur || ""} ${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } catch {
      return `${cur || ""} ${val}`;
    }
  }

  // BUG 2: Read-only receipt when action has been executed
  if (isExecuted) {
    return (
      <div
        role="article"
        aria-label={`Completed: ${action_label || "financial action"}`}
        className="rounded-xl border-2 overflow-hidden"
        style={{ borderColor: "#16a34a", background: "rgba(22,163,74,0.05)" }}
      >
        <div className="px-4 py-3 border-b flex items-center gap-2"
          style={{ background: "rgba(22,163,74,0.10)", borderColor: "rgba(22,163,74,0.2)" }}>
          <CheckCircle2 size={16} style={{ color: "#166534" }} />
          <span className="text-sm font-semibold" style={{ color: "#166534" }}>
            {action_label || "Financial action"} — Completed
          </span>
        </div>
        <div className="p-4 space-y-2">
          {customer_name && (
            <div className="flex items-center gap-2 text-sm">
              <User size={14} style={{ color: "var(--ab-text-muted)" }} />
              <span style={{ color: "var(--ab-text-secondary)" }}>Customer:</span>
              <span className="font-medium" style={{ color: "var(--ab-text)" }}>{customer_name}</span>
            </div>
          )}
          {total && (
            <div className="text-sm" style={{ color: "var(--ab-text-secondary)" }}>
              Total: <span className="font-bold" style={{ color: "var(--ab-text)" }}>{fmtCurrency(total, currency)}</span>
            </div>
          )}
          <p className="text-xs" style={{ color: "#166534" }}>
            This action has been executed. The mutation is live. No further action is possible on this draft.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      role="article"
      aria-label={`Draft: ${action_label || "financial action"}`}
      className="rounded-xl border-2 overflow-hidden"
      style={{ borderColor: "#d97706", background: "rgba(251,191,36,0.05)" }}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center justify-between"
        style={{ background: "rgba(251,191,36,0.10)", borderColor: "rgba(217,119,6,0.2)" }}>
        <div className="flex items-center gap-2">
          <FileText size={16} style={{ color: "#92400e" }} />
          <span className="text-sm font-semibold" style={{ color: "#92400e" }}>
            Draft: {action_label || "Financial action"}
          </span>
        </div>
        {expires_at && (
          <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "#92400e" }}>
            <Clock size={10} />
            <span>Expires {new Date(expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        {/* Customer */}
        {customer_name && (
          <div className="flex items-center gap-2 text-sm">
            <User size={14} style={{ color: "var(--ab-text-muted)" }} />
            <span style={{ color: "var(--ab-text-secondary)" }}>Customer:</span>
            <span className="font-medium" style={{ color: "var(--ab-text)" }}>{customer_name}</span>
          </div>
        )}

        {/* Line items */}
        {line_items && line_items.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: "var(--ab-text-muted)" }}>
              Line Items
            </h4>
            {line_items.map((item, i) => (
              <div key={i}
                className="flex items-center justify-between text-sm rounded-lg px-3 py-2 border"
                style={{ background: "var(--ab-bg)", borderColor: "var(--ab-border-subtle)" }}>
                <div className="flex-1">
                  <span style={{ color: "var(--ab-text)" }}>{item.description}</span>
                  <span className="ml-2" style={{ color: "var(--ab-text-muted)" }}>
                    {item.quantity} × {fmtCurrency(item.unit_price, currency)}
                  </span>
                </div>
                <span className="font-medium ml-4" style={{ color: "var(--ab-text)" }}>
                  {fmtCurrency(item.total, currency)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Totals */}
        {total && (
          <div className="rounded-lg border p-3 space-y-1.5"
            style={{ background: "var(--ab-bg)", borderColor: "var(--ab-border)" }}>
            <div className="flex justify-between text-sm" style={{ color: "var(--ab-text-secondary)" }}>
              <span>Subtotal</span>
              <span>{fmtCurrency(subtotal, currency)}</span>
            </div>
            {tax_amount && tax_amount !== "0" && (
              <div className="flex justify-between text-sm" style={{ color: "var(--ab-text-secondary)" }}>
                <span>Tax ({tax_rate}%)</span>
                <span>{fmtCurrency(tax_amount, currency)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold pt-1.5 border-t"
              style={{ color: "var(--ab-text)", borderColor: "var(--ab-border)" }}>
              <span>Total</span>
              <span style={{ color: "var(--ab-accent-text)" }}>
                {fmtCurrency(total, currency)}
              </span>
            </div>
          </div>
        )}

        <p className="text-xs" style={{ color: "var(--ab-text-muted)" }}>
          This is a draft — no changes have been saved yet. Review the preview before confirming.
        </p>
      </div>

      {/* Actions */}
      {actions && actions.length > 0 && (
        <div className="px-4 py-3 border-t flex flex-wrap gap-2"
          style={{ background: "var(--ab-bg)", borderColor: "var(--ab-border)" }}>
          {actions.map((a, i) => (
            <button
              key={`${a.action}-${i}`}
              onClick={() => onAction(a)}
              disabled={loading}
              className="ab-action-btn disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestedPrompts({ prompts, contextualPrompts, onSelect }) {
  // Server-side topic-specific follow-ups take full priority.
  // Contextual (client-side topic detection) chips are only used as
  // fallback when the server provides no prompts (e.g. out-of-scope
  // refusal, initial greeting).
  const hasServerChips = (prompts || []).length > 0;
  const source = hasServerChips ? prompts : (contextualPrompts || []);

  const merged = [];
  const seen = new Set();

  for (const p of source) {
    if (merged.length >= 3) break;
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
