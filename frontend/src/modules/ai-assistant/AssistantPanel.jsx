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
  Square,
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
  ArrowRight,
  ArrowLeft,
  Maximize2,
  Minimize2,
  MoreVertical,
  Minus,
  Rocket,
  CreditCard,
  BarChart3,
  RotateCcw,
  Database,
  Users,
  HelpCircle,
  Headset,
} from "lucide-react";
import ZoikoMark from "../../components/ZoikoMark";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createSession,
  listSessions,
  getSession,
  sendMessageStreamed,
  cancelStream,
  generatePreview,
  confirmAction,
  executeAction,
  cancelAction,
} from "./api";
import { hasAuthenticatedSession, sendPublicMessage } from "./publicAssistant";
import { useTypewriter, splitStablePrefix } from "./useTypewriter";
import PreviewCard from "./PreviewCard";
import ConfirmDialog from "./ConfirmDialog";
import { FAQ_CATEGORIES, HUMAN_SUPPORT, WELCOME_MESSAGE, DEFAULT_PROMPTS, CONTEXTUAL_PROMPTS, TOPIC_KEYWORDS } from "./suggestedPrompts";

// ── Theme definitions ────────────────────────────────────────────────────────

const THEME_KEY = "billingAssistantTheme";

const THEMES = {
  light: {
    // Approved palette — ZB-PUBCHAT-WF-001 §3.2:
    // navy #082644 · action #0868F7 · cyan #04ADD1 · canvas #F6F9FC ·
    // surface #FFFFFF · border #D6E4F2 · secondary #53677F · online #008E5A
    "--ab-bg": "#ffffff",
    "--ab-surface": "#f6f9fc",
    "--ab-surface-raised": "#eef4fb",
    "--ab-border": "#d6e4f2",
    "--ab-border-subtle": "#e6eef7",
    "--ab-text": "#082644",
    "--ab-text-secondary": "#53677f",
    "--ab-text-muted": "#7c8da3",
    "--ab-text-dim": "#b4c2d4",
    "--ab-accent": "#0868f7",
    "--ab-accent-hover": "#0a5bd6",
    "--ab-accent-10": "rgba(8,104,247,0.10)",
    "--ab-accent-15": "rgba(8,104,247,0.15)",
    "--ab-accent-20": "rgba(8,104,247,0.20)",
    "--ab-accent-30": "rgba(8,104,247,0.30)",
    "--ab-accent-text": "#0868f7",
    "--ab-icon-btn-bg": "rgba(8,104,247,0.08)",
    "--ab-icon-btn-text": "#082644",
    "--ab-icon-btn-hover-bg": "rgba(8,104,247,0.15)",
    "--ab-icon-btn-hover-text": "#0868f7",
    "--ab-user-bubble": "#0868f7",
    "--ab-assistant-bubble": "#f6f9fc",
    "--ab-assistant-bubble-text": "#082644",
    "--ab-system-bubble": "#fef3f2",
    "--ab-system-bubble-text": "#b42318",
    "--ab-system-bubble-border": "#fecdca",
    "--ab-input-bg": "#ffffff",
    "--ab-input-border": "#d6e4f2",
    "--ab-input-text": "#082644",
    "--ab-input-placeholder": "#7c8da3",
    "--ab-online": "#008e5a",
    "--ab-focus-ring": "rgba(8,104,247,0.35)",
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
    "--ab-accent": "#4d9bff",
    "--ab-accent-hover": "#7ab6ff",
    "--ab-accent-10": "rgba(77,155,255,0.12)",
    "--ab-accent-15": "rgba(77,155,255,0.18)",
    "--ab-accent-20": "rgba(77,155,255,0.24)",
    "--ab-accent-30": "rgba(77,155,255,0.34)",
    "--ab-accent-text": "#6cb2ff",
    "--ab-icon-btn-bg": "rgba(77,155,255,0.14)",
    "--ab-icon-btn-text": "#b7cbea",
    "--ab-icon-btn-hover-bg": "rgba(77,155,255,0.22)",
    "--ab-icon-btn-hover-text": "#6cb2ff",
    "--ab-user-bubble": "#2563eb",
    "--ab-assistant-bubble": "#1e293b",
    "--ab-assistant-bubble-text": "#e2e8f0",
    "--ab-system-bubble": "rgba(154,52,18,0.15)",
    "--ab-system-bubble-text": "#fdba74",
    "--ab-system-bubble-border": "rgba(251,146,60,0.25)",
    "--ab-input-bg": "#1e293b",
    "--ab-input-border": "#334155",
    "--ab-input-text": "#f1f5f9",
    "--ab-input-placeholder": "#64748b",
    "--ab-online": "#2fbf87",
    "--ab-focus-ring": "rgba(77,155,255,0.4)",
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

// Category icon names are carried as string keys in suggestedPrompts so the
// content stays serializable; resolve them to Lucide line icons here.
const TOPIC_ICONS = {
  rocket: Rocket,
  "file-text": FileText,
  "credit-card": CreditCard,
  "bar-chart-3": BarChart3,
  "rotate-ccw": RotateCcw,
  database: Database,
  users: Users,
  "help-circle": HelpCircle,
  headset: Headset,
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

// ── Message identity / merge ─────────────────────────────────────────────────
// Optimistic messages must carry a UNIQUE, STABLE client UID so they keep a
// stable React identity across optimistic creation → streaming → reconciliation.
// A timestamp-only UID (`temp-${Date.now()}`) can collide when two sends land in
// the same millisecond and shares nothing stable to reconcile against.
function newClientUid(prefix) {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Content identity used to match a local (possibly optimistic) message to its
// server-persisted twin, which carries a DIFFERENT server-assigned message_uid.
// sender_type + message_text uniquely identifies a logical message well enough
// to (a) de-dupe a persisted twin and (b) never drop a local message the server
// has not persisted yet. Timestamps are NEVER part of this key — ordering and
// identity are sequence/content based, never display-clock based.
function messageContentKey(m) {
  return `${m?.sender_type || ""}|${m?.message_text || ""}`;
}

// Safely reconcile a server snapshot into local state WITHOUT losing newer local
// messages (BUG 2).  Ordering principle: the server snapshot is the authoritative,
// correctly-ordered base (the backend now tie-breaks equal created_at by row id);
// any local message the server has NOT persisted yet is re-appended in its
// original relative order so an in-flight/optimistic turn is never dropped.  A
// local message whose content is already present in the snapshot is suppressed —
// its persisted twin (with the server's message_uid) already renders, so this
// never duplicates either.  Only ever returns a superset-preserving array.
function mergeServerMessages(local, server) {
  const serverMsgs = Array.isArray(server) ? server : [];
  const serverKeys = new Set(serverMsgs.map(messageContentKey));
  const extras = (Array.isArray(local) ? local : []).filter(
    (m) => !serverKeys.has(messageContentKey(m))
  );
  if (extras.length === 0) return serverMsgs;
  return [...serverMsgs, ...extras];
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
  // Header options menu (spec §5: options menu + minimize + close). Holds the
  // admin-only affordances the approved header does not surface directly
  // (New conversation, Recent conversations, Back to Main Menu, theme toggle,
  // expand/collapse) so admin capability is preserved without the extra
  // header icons the approved design forbids.
  const [menuOpen, setMenuOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
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
  const menuRef = useRef(null);
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
  // Anchored main menu: index in `messages` BEFORE which the main menu is
  // displayed as a frontend-only conversation UI item (never sent to the
  // backend, no message ID, no timestamp).  The menu is rendered inline at
  // this fixed boundary, so it stays put while new user/assistant messages are
  // appended below it.  `null` = no menu shown.
  const [mainMenuAt, setMainMenuAt] = useState(0);
  // Stop-generation (ChatGPT/Claude UX): handleStop must reach into the
  // fire-and-forget streaming closure to (a) abort the in-flight SSE fetch,
  // (b) freeze further token appends, and (c) mark the partial bubble
  // complete — so the AbortController and the closure's mutable state live
  // in refs instead of being trapped inside handleSend.
  const streamCtlRef = useRef(null);
  const streamStateRef = useRef({ respUid: null, targetUid: null, pendingTokens: [], flushTimer: null, done: false });

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
          // Guard against a LATE resolve clobbering a newer view: this pre-fetch
          // is only safe to apply while the user is still on the untouched
          // initial state (no active session yet). If by now they have started a
          // new conversation or switched sessions, discard the stale snapshot —
          // otherwise it would silently overwrite the in-flight messages.
          if (activeSession) return;
          console.warn("[assistant-cx] session restored:", firstSession.conversation_uid, `(${session.messages?.length || 0} messages)`);
          setActiveSession(session);
          setMessages(session.messages || []);
          setAnimatingUid(null);
          setAnimDoneUid(null);
          // A restored session with saved messages shows no main menu (the
          // conversation is already underway); a brand-new empty session
          // shows the anchored main menu at its initial position.
          setMainMenuAt((session.messages?.length || 0) > 0 ? null : 0);
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
    try {
      const session = await getSession(uid);
      const sameSession = activeSession?.conversation_uid === session.conversation_uid;
      setActiveSession(session);
      // Restoring the SAME conversation merges the server snapshot with any
      // newer local (optimistic/streaming) messages so an in-flight turn is
      // never silently dropped (BUG 2). Switching to a DIFFERENT conversation
      // is an intentional navigation — the snapshot replaces local state.
      setMessages((prev) =>
        sameSession ? mergeServerMessages(prev, session.messages || []) : session.messages || []
      );
      setAnimatingUid(null);
      setAnimDoneUid(null);
      // Switching conversations gets that session's normal menu state. A
      // same-session refresh/reconcile preserves the current anchor so Back to
      // Main Menu does not disappear just because history was refreshed.
      if (!sameSession) setMainMenuAt((session.messages?.length || 0) > 0 ? null : 0);
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
    } else if (err?.forbidden) {
      // 403 is an authorization/entitlement decision, NOT an expired session —
      // saying "your session has expired" here sent admins chasing a login
      // problem that did not exist.
      errorText = "You don't have access to the billing assistant. Ask your organization admin to check your plan and permissions.";
      errorStatus = "Not permitted";
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
      message_uid: newClientUid("error"),
      sender_type: "system",
      message_text: errorText,
      created_at: new Date().toISOString(),
    }]);
    setStatusAnnouncement(errorStatus);
  };

  // Public-assistant fallback (ZB-AI-PUB-001). When there is no usable admin
  // session, GENERAL product questions are still answered — through the same
  // UNAUTHENTICATED public service the marketing-site widget uses. It is
  // guidance-only: account-specific questions come back with `requires_auth`
  // and are surfaced as a sign-in prompt, and the public service never exposes
  // tenant data (enforced server-side). No Authorization header is sent, and
  // nothing here weakens backend authorization.
  const submitViaPublic = async (text) => {
    setLoading(true);
    setStatusAnnouncement("Assistant is thinking...");
    const respUid = newClientUid("pub");
    setMessages((prev) => [...prev, {
      message_uid: respUid,
      sender_type: "assistant",
      message_text: "",
      mode: "M0_EXPLAIN",
      risk_class: "R0",
      structured_payload: {},
      created_at: new Date().toISOString(),
    }]);
    try {
      const resp = await sendPublicMessage(text);
      const requiresAuth = Boolean(resp?.requires_auth);
      setMessages((prev) => prev.map((m) => (
        m.message_uid === respUid
          ? {
              ...m,
              message_text: resp?.answer || "",
              mode: resp?.mode || "M0_EXPLAIN",
              risk_class: resp?.risk_class || "R0",
              structured_payload: {
                evidence: resp?.evidence || [],
                next_actions: [],
                suggested_prompts: [],
                // Account-specific question: give the visitor the one useful
                // next step. The public answer never contains account data.
                actions: requiresAuth ? [{ action: "sign_in", label: "Sign in" }] : [],
              },
            }
          : m
      )));
      if (requiresAuth) {
        // Short canned answer + an actionable CTA: show both immediately rather
        // than deferring the Sign-in button behind a typewriter reveal.
        setAnimatingUid(null);
        setAnimDoneUid(respUid);
      } else {
        setAnimatingUid(respUid);
        setAnimDoneUid(null);
      }
      setStatusAnnouncement(requiresAuth ? "Sign-in required for account-specific details" : "Answer received");
    } catch (err) {
      // Drop the empty placeholder, then report through the standard path so
      // copy, logging and the live-region announcement stay in one place.
      setMessages((prev) => prev.filter((m) => m.message_uid !== respUid));
      notifySendFailure(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async (overrideText) => {
    // When triggered from a suggestion chip the exact text is passed straight
    // into the SAME submission path used by the Send button / Enter key.  This
    // avoids the racy setInput(p); setTimeout(handleSend) pattern, where the
    // handler read `input` from async state and could bail early on the first
    // click (requiring a second click to actually send).  The Send button
    // passes its click event as the first arg, so only a non-empty string is
    // ever treated as a text override.
    const text =
      typeof overrideText === "string" && overrideText.trim() !== ""
        ? overrideText.trim()
        : input.trim();
    if (!text || loading) return;
    // A new question continues BELOW any anchored main menu — the menu keeps
    // its position and the new user/assistant messages are appended after it.
    // Nothing to clear here: the menu anchor (`mainMenuAt`, read at render
    // time) is unaffected by message growth, so the menu never moves, hides,
    // or reappears below the answer.
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
      // No admin session at all -> answer through the public assistant so a
      // general product question never dead-ends on a sign-in wall. Account-
      // specific questions come back as a sign-in prompt from the public
      // service, which never exposes tenant data.
      if (!hasAuthenticatedSession()) {
        setMessages((prev) => [...prev, {
          message_uid: newClientUid("temp"),
          sender_type: "user",
          message_text: text,
          created_at: new Date().toISOString(),
        }]);
        await submitViaPublic(text);
        return;
      }
      if (!targetUid) {
        const userMsg = { message_uid: newClientUid("temp"), sender_type: "user", message_text: text, created_at: new Date().toISOString() };
        setMessages([userMsg]);
        try {
          // Title is derived server-side from the first user message; pass the
          // placeholder so the backend's derivation logic kicks in.
          const session = await createSession("New Conversation", text);
          setActiveSession(session);
          setSessions((prev) => [session, ...prev]);
          const initResp = session.messages?.[0];
          const assistantMsg = {
            message_uid: initResp?.message_uid || newClientUid("resp"),
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
          if (err?.authInvalid && !err?.forbidden) {
            // Admin token present but unusable and refresh failed: fall back to
            // the public assistant instead of a false "session expired"
            // dead-end. The user's bubble is already on screen.
            await submitViaPublic(text);
          } else {
            notifySendFailure(err);
          }
        }
        return;
      }
      const userMsg = { message_uid: newClientUid("temp"), sender_type: "user", message_text: text, created_at: new Date().toISOString() };
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
      const respUid = newClientUid("resp");
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

      // Wire the AbortController and mutable streaming state into refs so the
      // Stop button can abort the fetch / freeze the stream from OUTSIDE this
      // closure (the stream itself is fire-and-forget — SSE callbacks settle
      // later, see comment above the try block).  `didStartStream` /
      // `streamSettled` are declared OUTSIDE the try and owned by its
      // catch/finally, so we only assign them, never redeclare.
      streamCtlRef.current = new AbortController();
      const streamState = { respUid, targetUid, pendingTokens: [], flushTimer: null, done: false };
      streamStateRef.current = streamState;
      const flushTokens = () => {
        if (streamState.flushTimer) { clearTimeout(streamState.flushTimer); streamState.flushTimer = null; }
        if (!streamState.pendingTokens.length) return;
        const chunk = streamState.pendingTokens.join("");
        streamState.pendingTokens = [];
        setMessages((prev) => prev.map((m) =>
          m.message_uid === respUid ? { ...m, message_text: (m.message_text || "") + chunk } : m
        ));
        scrollChatToBottom();
      };
      const settle = () => {
        streamSettled = true;
        if (streamState.done) return;
        streamState.done = true;
        if (streamState.flushTimer) { clearTimeout(streamState.flushTimer); streamState.flushTimer = null; }
        streamCtlRef.current = null;
        setLoading(false);
      };

      didStartStream = true;
      sendMessageStreamed(targetUid, text, undefined, {
        signal: streamCtlRef.current.signal,
        onToken: (delta) => {
          if (streamState.done) return;
          streamState.pendingTokens.push(delta);
          if (!streamState.flushTimer) streamState.flushTimer = setTimeout(flushTokens, 40);
        },
        onDone: (payload) => {
          if (streamState.done) return;
          const response = payload.response || {};
          const streamed = payload.streamed === true;
          // Sweep any token stragglers into the bubble, then overwrite with
          // the authoritative answer so partial text can never drift from it.
          // NOTE: do NOT mark streamState.done here — settle() owns the
          // terminal transition (setting done AND clearing `loading`), so the
          // loading lifecycle must reach its end.  Marking done first makes
          // settle() early-return and leaves `loading` stuck true after a
          // successful response, keeping the "Checking records..." indicator
          // and the disabled composer on screen forever.
          if (streamState.flushTimer) { clearTimeout(streamState.flushTimer); streamState.flushTimer = null; }
          streamState.pendingTokens = [];
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
          if (streamState.done) return;
          console.error("[CHATBOT-DIAG] stream FAILED:", err?.name, err?.message);
          setStreamingUid(null);
          if (err?.authInvalid && !err?.forbidden) {
            // The admin session is unusable and the silent refresh failed.
            // Answer the question through the public assistant instead of
            // telling a signed-in admin their "session has expired". The
            // optimistic empty bubble is removed and replaced in place.
            streamState.done = true;
            streamSettled = true;
            if (streamState.flushTimer) { clearTimeout(streamState.flushTimer); streamState.flushTimer = null; }
            streamCtlRef.current = null;
            setMessages((prev) => prev.filter((m) => !(m.message_uid === streamState.respUid && !m.message_text)));
            void submitViaPublic(text);
            return;
          }
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

  const handleStop = () => {
    // Stop-generation (ChatGPT/Claude UX): replaces the send button while a
    // response is streaming.  Only reachable then — `streamStateRef` is reset
    // on every send and cleared when the stream settles, and the button is
    // hidden once `streamingUid` is null.
    const state = streamStateRef.current;
    if (!state?.respUid || state.done) return;
    // (c) Sweep any buffered tokens into the bubble and mark it complete
    // FIRST, synchronously — so no queued onToken/onDone repaint that was
    // already in flight can re-open it after we tear the stream down.  The
    // partial answer stays visible and renders like a normal finished message
    // (no caret, no spinner).
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
    if (state.pendingTokens.length) {
      const chunk = state.pendingTokens.join("");
      state.pendingTokens = [];
      setMessages((prev) => prev.map((m) =>
        m.message_uid === state.respUid ? { ...m, message_text: (m.message_text || "") + chunk } : m
      ));
    }
    state.done = true;
    setStreamingUid(null);
    setAnimDoneUid(state.respUid);
    setLoading(false);
    setStatusAnnouncement("Response generation stopped");
    // (a) Abort the in-flight fetch.  sendMessageStreamed swallows AbortError
    // without firing onDone/onError, so the stream officially ends here.
    const ctl = streamCtlRef.current;
    if (ctl) { ctl.abort(); streamCtlRef.current = null; }
    // Tell the backend to stop generating too (best-effort): its pipeline runs
    // on a daemon thread and would otherwise keep burning LLM tokens for a
    // client that already closed the connection.
    if (state.targetUid) cancelStream(state.targetUid);
    requestAnimationFrame(scrollChatToBottom);
    inputRef.current?.focus();
  };

  const handleBackToMenu = () => {
    // Back-to-Main-Menu: keeps the ENTIRE conversation visible on screen and
    // appends the existing welcome/main menu as the NEXT section BELOW it.
    // Unlike New Conversation, the backend session and message history are
    // left untouched (no createSession, no delete, no refetch) and the
    // on-screen messages are NOT cleared.  In-flight streaming is torn down
    // with the same safety guarantees as the Stop button so completed (and
    // partial) messages stay and no loading/"Checking records..." state can
    // survive the switch.
    const state = streamStateRef.current;
    if (state?.respUid && !state.done) {
      // Sweep any buffered tokens into the bubble and mark it complete FIRST,
      // synchronously — so no queued onToken/onDone repaint that was already
      // in flight can re-open it after we tear the stream down.
      if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
      if (state.pendingTokens.length) {
        const chunk = state.pendingTokens.join("");
        state.pendingTokens = [];
        setMessages((prev) => prev.map((m) =>
          m.message_uid === state.respUid ? { ...m, message_text: (m.message_text || "") + chunk } : m
        ));
      }
      state.done = true;
      setStreamingUid(null);
      setAnimDoneUid(state.respUid);
      const ctl = streamCtlRef.current;
      if (ctl) { ctl.abort(); streamCtlRef.current = null; }
      if (state.targetUid) cancelStream(state.targetUid);
    }
    streamStateRef.current = { respUid: null, targetUid: null, pendingTokens: [], flushTimer: null, done: false };
    setAnimatingUid(null);
    setLoading(false);
    // Anchor the menu at the current end of the conversation.  New messages
    // are appended AFTER this index, so the menu stays in place; multiple
    // Back-to-Main-Menu clicks simply scroll to the latest anchor if one
    // already exists at the very end.
    const anchor = messages.length;
    setMainMenuAt(anchor);
    setStatusAnnouncement("Main menu shown below your conversation");
    stickRef.current = true;
    requestAnimationFrame(() => {
      const el = chatViewportRef.current;
      if (!el) return;
      // Scroll so the anchored menu is visible at its position.
      const items = el.querySelectorAll("[data-main-menu]");
      const last = items[items.length - 1];
      if (last?.scrollIntoView) {
        try { last.scrollIntoView({ behavior: "smooth", block: "start" }); return; } catch { /* fall through */ }
      }
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
    inputRef.current?.focus();
  };

  const handleMenuSelect = (cat) => {
    // Shared by the initial welcome state and the bottom menu appended by
    // Back-to-Main-Menu.  Escalation routes out of the panel; every other
    // category submits its question through the normal send flow (single
    // request, single user message) and hides the transient bottom menu.
    if (cat.action === "escalate") {
      navigate("/billing/workspace/help");
      onClose();
      return;
    }
    handleSend(cat.question);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleAction = useCallback(async (actionObj) => {
    const { action, action_uid } = actionObj;
    if (action === "sign_in") {
      // Emitted by the public-assistant fallback when a question needs account
      // data. Routing to sign-in is the only correct next step.
      navigate("/login");
      onClose();
      return;
    }
    if (action === "preview_draft") {
      try {
        setLoading(true);
        const preview = await generatePreview(action_uid);
        setPreviewData(preview);
        setActiveAction(actionObj);
      } catch (err) {
        setMessages((prev) => [...prev, {
          message_uid: newClientUid("err"),
          sender_type: "system",
          message_text: `Preview failed: ${err.message}`,
          created_at: new Date().toISOString(),
        }]);
      } finally {
        setLoading(false);
      }
    } else if (action === "confirm_draft") {
      // P0 guard: the confirmation dialog is ALWAYS bound to a freshly
      // generated preview for THIS action_uid.  A stale previewData from an
      // earlier draft must never be reused and shown as if it belonged to
      // the action being confirmed — confirmation binds to preview id/hash.
      try {
        setLoading(true);
        const preview = await generatePreview(action_uid);
        setPreviewData(preview);
        setActiveAction(actionObj);
        setShowConfirmDialog(true);
      } catch (err) {
        setMessages((prev) => [...prev, {
          message_uid: newClientUid("err"),
          sender_type: "system",
          message_text: `Preview failed: ${err.message}`,
          created_at: new Date().toISOString(),
        }]);
      } finally {
        setLoading(false);
      }
    } else if (action === "cancel_draft") {
      try {
        setLoading(true);
        await cancelAction(action_uid);
        setPreviewData(null);
        setActiveAction(null);
        setMessages((prev) => [...prev, {
          message_uid: newClientUid("sys"),
          sender_type: "system",
          message_text: "Draft has been cancelled and discarded.",
          created_at: new Date().toISOString(),
        }]);
      } catch (err) {
        setMessages((prev) => [...prev, {
          message_uid: newClientUid("err"),
          sender_type: "system",
          message_text: `Cancel failed: ${err.message}`,
          created_at: new Date().toISOString(),
        }]);
      } finally {
        setLoading(false);
      }
    }
  }, [navigate, onClose]);

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
      const execUid = newClientUid("exec");
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
        message_uid: newClientUid("err"),
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
        message_uid: newClientUid("err"),
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
      // New Conversation always resets to the anchored main menu at its
      // initial boundary (position 0) — the menu stays above whatever the
      // user types next and while the answer streams/completes.
      setMainMenuAt(0);
      setSessions((prev) => [session, ...prev]);
      setStatusAnnouncement("New conversation started");
      inputRef.current?.focus();
    } catch (err) {
      console.error("Failed to create session:", err);
      setMessages((prev) => [...prev, {
        message_uid: newClientUid("error"),
        sender_type: "system",
        message_text:
          import.meta.env.MODE === "development" && err?.detail
            ? `Couldn't start a new conversation right now. (${err.status ?? "network"} ${err.detail})`
            : "Couldn't start a new conversation right now. Please try again.",
        created_at: new Date().toISOString(),
      }]);
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

  // Options menu (spec §5): Escape closes, clicking outside closes.
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const handleEscape = (e) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menuOpen]);

  // Privacy and AI assistance — local disclosure (spec §4/§10). No external
  // page exists; Escape closes the disclosure.
  useEffect(() => {
    if (!privacyOpen) return;
    const handleEscape = (e) => {
      if (e.key === "Escape") setPrivacyOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [privacyOpen]);

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
        {/* Header — spec §5: compact header (76–84 px) with the assistant
            identity + status on the left and ONLY the approved controls on the
            right (options menu, minimize, close). Admin-only affordances (New
            conversation, Recent conversations, Back to Main Menu, theme toggle,
            expand/collapse) live inside the options menu so the approved header
            stays uncluttered while admin capability is preserved. */}
        <header
          className="ab-header flex items-center justify-between gap-2 px-4"
          style={{ borderBottom: `1px solid var(--ab-border)`, minHeight: 76 }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Zoiko Billing identity: the compact Z symbol (ZoikoMark →
                zoiko-icon.png) sits beside the full Zoiko Billing wordmark, with
                the assistant name/status beneath — matching the approved
                reference. */}
            <ZoikoMark size={40} rounded="rounded-lg" />
            <div className="flex flex-col items-start gap-0.5 min-w-0">
              <img src="/zoiko-billing-logo.png" alt="Zoiko Billing" className="ab-wordmark" draggable={false} />
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold leading-tight" style={{ color: "var(--ab-text)" }}>
                  Billing Assistant
                </h2>
                <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--ab-text-secondary)" }}>
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--ab-online)" }} aria-hidden="true" />
                  Online
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {/* Options menu (spec §5: overflow menu with the secondary actions;
                native button semantics, Escape/outside-click to close) */}
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((p) => !p)}
                className={`ab-icon-btn h-9 w-9 rounded-full flex items-center justify-center transition-colors ${menuOpen ? "ab-icon-btn--active" : ""}`}
                aria-label="Assistant options"
                aria-haspopup="true"
                aria-expanded={menuOpen}
                title="More options"
              >
                <MoreVertical size={18} strokeWidth={2} />
              </button>

              {menuOpen && (
                <div
                  className="ab-dropdown absolute right-0 top-full mt-2 w-64 rounded-xl shadow-lg z-[60] py-1"
                  aria-label="Assistant options"
                >
                  {/* New conversation */}
                  <button
                    type="button"
                    onClick={() => { setMenuOpen(false); handleNewConversation(); }}
                    disabled={initializing}
                    className="ab-menu-item w-full text-left px-3 py-2.5 text-sm flex items-center gap-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Plus size={16} strokeWidth={2} style={{ color: "var(--ab-accent-text)" }} />
                    <span style={{ color: "var(--ab-text)" }}>New conversation</span>
                  </button>

                  {/* Recent conversations — nested listbox inside the menu */}
                  <div className="relative" ref={recentRef}>
                    <button
                      type="button"
                      onClick={() => { if (!recentOpen) loadSessions(); setRecentOpen((p) => !p); }}
                      className={`ab-menu-item w-full text-left px-3 py-2.5 text-sm flex items-center gap-2.5 transition-colors ${recentOpen ? "ab-menu-item--active" : ""}`}
                      aria-haspopup="listbox"
                      aria-expanded={recentOpen}
                    >
                      <History size={16} strokeWidth={2} style={{ color: "var(--ab-accent-text)" }} />
                      <span style={{ color: "var(--ab-text)" }}>Recent conversations</span>
                    </button>

                    {recentOpen && (
                      <div className="ab-dropdown mx-2 mb-1 max-h-64 overflow-y-auto rounded-lg" role="listbox" aria-label="Recent conversations">
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
                                onClick={() => { selectSession(s.conversation_uid); setRecentOpen(false); setMenuOpen(false); }}
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

                  {/* Back to Main Menu — appends the menu BELOW the existing
                      conversation without clearing messages or the backend. */}
                  {messages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => { setMenuOpen(false); handleBackToMenu(); }}
                      className="ab-menu-item w-full text-left px-3 py-2.5 text-sm flex items-center gap-2.5 transition-colors"
                    >
                      <ArrowLeft size={16} strokeWidth={2} style={{ color: "var(--ab-accent-text)" }} />
                      <span style={{ color: "var(--ab-text)" }}>Back to Main Menu</span>
                    </button>
                  )}

                  {/* Theme toggle (admin-only; not in the approved header) */}
                  <button
                    type="button"
                    onClick={() => { setMenuOpen(false); toggle(); }}
                    className="ab-menu-item w-full text-left px-3 py-2.5 text-sm flex items-center gap-2.5 transition-colors"
                    aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
                  >
                    {isDark ? <Sun size={16} strokeWidth={2} style={{ color: "var(--ab-accent-text)" }} /> : <Moon size={16} strokeWidth={2} style={{ color: "var(--ab-accent-text)" }} />}
                    <span style={{ color: "var(--ab-text)" }}>{isDark ? "Light mode" : "Dark mode"}</span>
                  </button>

                  {/* Expand / collapse workspace (admin-only) */}
                  <button
                    type="button"
                    onClick={() => { setMenuOpen(false); setIsExpanded((p) => !p); }}
                    className="ab-menu-item w-full text-left px-3 py-2.5 text-sm flex items-center gap-2.5 transition-colors"
                    aria-label={isExpanded ? "Collapse assistant panel" : "Expand assistant panel"}
                    aria-pressed={isExpanded}
                  >
                    {isExpanded ? <Minimize2 size={16} strokeWidth={2} style={{ color: "var(--ab-accent-text)" }} /> : <Maximize2 size={16} strokeWidth={2} style={{ color: "var(--ab-accent-text)" }} />}
                    <span style={{ color: "var(--ab-text)" }}>{isExpanded ? "Collapse panel" : "Expand panel"}</span>
                  </button>

                  {/* Privacy and AI assistance (local disclosure) */}
                  <button
                    type="button"
                    onClick={() => { setMenuOpen(false); setPrivacyOpen(true); }}
                    className="ab-menu-item w-full text-left px-3 py-2.5 text-sm flex items-center gap-2.5 transition-colors"
                  >
                    <Shield size={16} strokeWidth={2} style={{ color: "var(--ab-accent-text)" }} />
                    <span style={{ color: "var(--ab-text)" }}>Privacy and AI assistance</span>
                  </button>
                </div>
              )}
            </div>

            {/* Minimize — hides the panel without destroying the in-session state
                (spec §5 C-05). The launcher restores it. */}
            <button
              type="button"
              onClick={onClose}
              className="ab-icon-btn h-9 w-9 rounded-full flex items-center justify-center transition-colors"
              aria-label="Minimize assistant panel"
              title="Minimize"
            >
              <Minus size={18} strokeWidth={2} />
            </button>

            {/* Close (spec §5 C-06) */}
            <button
              type="button"
              onClick={onClose}
              className="ab-icon-btn h-9 w-9 rounded-full flex items-center justify-center transition-colors"
              aria-label="Close assistant panel"
              title="Close"
            >
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        </header>

        {/* Messages viewport — the only scrollable region. `min-h-0` lets this
            flex child shrink so the pinned header/composer are never pushed
            out of the panel when the conversation is long. */}
        <div ref={chatViewportRef} className="ab-viewport flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-4" role="log" aria-label="Conversation messages">
          {messages.map((msg, idx) => {
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
                {/* Anchored main menu: rendered INLINE at its fixed boundary
                    (just BEFORE message index `mainMenuAt`).  Frontend-only UI
                    item — no backend message, no ID, no timestamp.  It stays
                    put here while the message below/after streams; new user +
                    assistant messages continue BELOW the menu; nothing moves it
                    to the bottom or re-creates it after an answer. */}
                {mainMenuAt === idx && (
                  <div className="mt-2" data-main-menu>
                    <AssistantMenuSection onSelectCategory={handleMenuSelect} />
                  </div>
                )}
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

          {/* When the anchor is exactly at the very end there is no following
              message to host the menu, so render it as the last section.  This
              is also the path the initial New Conversation menu uses (anchor 0
              with an empty message list) — the SAME anchored architecture as
              Back to Main Menu, never a separate empty-state branch.  The menu
              is intentionally NOT gated on `!loading`, so it stays visible
              above while the user's first question is still streaming. */}
          {mainMenuAt === messages.length && (
            <div className="mt-2" data-main-menu>
              <AssistantMenuSection onSelectCategory={handleMenuSelect} />
            </div>
          )}

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
            Suppress when action buttons are present on the last assistant message.
            Also suppressed while an anchored menu sits at the very end (that menu
            is the interactive surface; the chip bar would be redundant). */}
        {messages.length > 0 && !loading && mainMenuAt !== messages.length && !messages[messages.length - 1]?.structured_payload?.actions?.length && !messages[messages.length - 1]?.structured_payload?.draft_card && !messages[messages.length - 1]?.structured_payload?.preview_card && (
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
            onSelect={(p) => handleSend(p)}
          />
        )}

        {showConfirmDialog && previewData && (
          <ConfirmDialog
            preview={previewData}
            onConfirm={handlePreviewConfirm}
            onCancel={handlePreviewCancel}
          />
        )}

        {privacyOpen && <PrivacyDisclosure onClose={() => setPrivacyOpen(false)} />}

        {/* Composer — pinned to the bottom of the panel (`shrink-0`) so it can
            never be compressed or clipped by the scrolling region above it.
            The bottom padding also clears the mobile safe area (home indicator). */}
        <footer
          className="ab-footer shrink-0 px-4 py-3"
          style={{ borderTop: `1px solid var(--ab-border)`, paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about billing..."
              maxLength={2000}
              rows={1}
              className="ab-input flex-1 resize-none rounded-xl px-3 py-[9px] text-sm leading-5 transition-colors focus:outline-none focus:ring-2"
              style={{ "--tw-ring-color": "var(--ab-focus-ring)" }}
              aria-label="Type your billing question"
              disabled={loading || initializing}
            />
            {streamingUid ? (
              <button
                type="button"
                onClick={handleStop}
                className="ab-send-btn h-10 w-10 inline-flex items-center justify-center rounded-xl text-white transition-colors"
                aria-label="Stop generating"
                title="Stop generating"
              >
                <Square size={16} className="fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim() || loading}
                className="ab-send-btn h-10 w-10 inline-flex items-center justify-center rounded-xl text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Send message"
              >
                <Send size={16} />
              </button>
            )}
          </div>
          {/* Trust footer (spec §4/§10): exact disclosure copy + local
              "Privacy and AI assistance" disclosure. */}
          <p className="mt-2 text-[11px] leading-snug text-center" style={{ color: "var(--ab-text-muted)" }}>
            AI-assisted guidance about Zoiko Billing. Verify financial information in your billing records.{" "}
            <button
              type="button"
              onClick={() => setPrivacyOpen(true)}
              className="underline underline-offset-2 transition-colors"
              style={{ color: "var(--ab-accent-text)" }}
            >
              Privacy and AI assistance
            </button>
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

// ── Welcome / main menu ──────────────────────────────────────────────────────
// Single source of truth for the main menu, rendered in TWO places without
// duplicating the menu system:
//   1. the initial empty conversation (messages.length === 0), and
//   2. below an existing conversation after "Back to Main Menu".
// It reuses WELCOME_MESSAGE + FAQ_CATEGORIES so both states present the same
// branded greeting and 2-per-row category grid.
function AssistantMenuSection({ onSelectCategory }) {
  return (
    <>
      <div className="flex items-start gap-2.5">
        <ZoikoMark size={32} rounded="rounded-lg" />
        <div className="ab-bubble-assistant rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed max-w-[85%]">
          <div className="whitespace-pre-wrap">{WELCOME_MESSAGE}</div>
        </div>
      </div>

      {/* Approved topic grid (spec §6): 8 icon tiles, 2-up once the inner
          grid clears 376 px, 1-up below (full-screen sheet). */}
      <div className="grid grid-cols-1 min-[408px]:grid-cols-2 gap-3 mt-1">
        {FAQ_CATEGORIES.map((cat) => {
          const Icon = TOPIC_ICONS[cat.icon] || HelpCircle;
          return (
            <button
              key={cat.num}
              type="button"
              onClick={() => onSelectCategory(cat)}
              className="ab-cat-btn group flex items-center gap-3 text-left transition-colors"
            >
              <span
                className="ab-cat-icon inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px]"
                style={{ background: cat.tint, color: cat.accent }}
                aria-hidden="true"
              >
                <Icon size={20} strokeWidth={2} />
              </span>
              <span className="flex flex-col gap-0.5 flex-1 min-w-0">
                <span className="text-[15px] font-medium leading-tight line-clamp-2" style={{ color: "var(--ab-text)" }}>
                  {cat.label}
                </span>
                <span className="text-[12px] leading-tight line-clamp-2" style={{ color: "var(--ab-text-secondary)" }}>
                  {cat.description}
                </span>
              </span>
              <ArrowRight
                size={16}
                className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ color: "var(--ab-accent-text)" }}
              />
            </button>
          );
        })}
      </div>

      {/* "Speak to a human" — full-width action AFTER the grid, never a tile
          (spec §8). */}
      <button
        type="button"
        onClick={() => onSelectCategory(HUMAN_SUPPORT)}
        className="ab-human-btn w-full flex items-center gap-3 text-left transition-colors"
      >
        <span className="ab-human-icon inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px]" aria-hidden="true">
          <Headset size={20} strokeWidth={2} />
        </span>
        <span className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-sm font-semibold leading-tight" style={{ color: "var(--ab-text)" }}>
            {HUMAN_SUPPORT.label}
          </span>
          <span className="text-[12.5px] leading-tight" style={{ color: "var(--ab-text-secondary)" }}>
            {HUMAN_SUPPORT.description}
          </span>
        </span>
        <ArrowRight size={16} className="flex-shrink-0" style={{ color: "var(--ab-accent-text)" }} />
      </button>
    </>
  );
}

// ── Privacy and AI assistance disclosure (spec §4/§10) ────────────────────────
// The approved design links "Privacy and AI assistance"; no such route exists in
// the app, so we surface an in-panel disclosure rather than invent a URL. Keeps
// the assistant honest about AI limitations without leaving the panel.
function PrivacyDisclosure({ onClose }) {
  return (
    <div
      className="absolute inset-0 z-[70] flex items-end justify-center p-4"
      style={{ background: "rgba(8,38,68,0.45)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Privacy and AI assistance"
        className="w-full max-w-md rounded-2xl shadow-2xl p-5 text-sm"
        style={{ background: "var(--ab-bg)", border: "1px solid var(--ab-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-[15px] font-semibold" style={{ color: "var(--ab-text)" }}>
            Privacy and AI assistance
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="ab-icon-btn h-8 w-8 rounded-full flex items-center justify-center transition-colors"
            aria-label="Close privacy and AI assistance"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        <p className="leading-relaxed mb-2" style={{ color: "var(--ab-text-secondary)" }}>
          This assistant is AI-assisted. It provides guidance about Zoiko Billing
          features and workflows, and can help you navigate the product.
        </p>
        <p className="leading-relaxed mb-2" style={{ color: "var(--ab-text-secondary)" }}>
          Your conversation may be processed to generate responses and to improve
          the assistant. Always verify financial information in your billing
          records, and do not share payment credentials or other sensitive
          secrets in chat.
        </p>
        <p className="leading-relaxed" style={{ color: "var(--ab-text-secondary)" }}>
          For account-specific or sensitive matters, use “Speak to a human”.
        </p>
      </div>
    </div>
  );
}

// Small, subtle timestamp shown under every user/assistant message.  Uses the
// browser's local time in the fixed "h:mm AM/PM" format; the value comes from
// the message's `created_at` (persisted server time when available, otherwise
// the optimistic local time already on the message) so it is stable — it never
// re-computes while a streaming response is in flight.
function MessageTimeStamp({ message }) {
  const d = formatChatTimestamp(message.created_at);
  if (!d) return null;
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const isUser = message.sender_type === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mt-1`}>
      <span className="text-[10px] leading-none" style={{ color: "var(--ab-text-muted)" }} title={d.toLocaleString()}>
        {time}
      </span>
    </div>
  );
}

// ── Markdown body renderer (assistant / system messages) ─────────────────────
// The engine answers in markdown (**bold**, "- item" lists, sections separated
// by blank lines). react-markdown parses it into React elements — it never
// touches innerHTML and raw HTML in the content is escaped by default (no
// rehype-raw), so AI/user-generated content is XSS-safe by construction.

// Currency symbols that mark a bolded run as a financial figure.
const CURRENCY_SYMBOLS = ["$", "€", "£", "¥", "₹", "₩", "₺", "₽", "₴", "₱", "₫", "฿", "₦"];

// "Financial emphasis": a **bolded** amount (e.g. **$1,234.56**) is the one
// piece of a billing answer the eye should land on first. Renders it in the
// brand accent colour (in addition to the existing bold) so figures read as
// distinct from ordinary prose — ChatGPT-style visual hierarchy. Pure
// presentation; content and layout are unchanged.
function isFinancialEmphasis(children) {
  const text = (Array.isArray(children) ? children.join("") : String(children ?? "")).trim();
  if (!text) return false;
  return CURRENCY_SYMBOLS.some((sym) => text.startsWith(sym));
}

const MD_COMPONENTS = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-2 space-y-1.5 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-2 space-y-1.5 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => (
    <strong className={isFinancialEmphasis(children) ? "ab-financial" : "font-semibold"}>
      {children}
    </strong>
  ),
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
  h1: ({ children }) => <h3 className="text-base font-semibold leading-snug my-2.5 first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="text-sm font-semibold leading-snug my-2.5 first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="text-sm font-semibold leading-snug my-2.5 first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="text-sm font-semibold leading-snug my-2.5 first:mt-0">{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote
      className="border-l-2 pl-3 my-2 italic opacity-80"
      style={{ borderColor: "var(--ab-border)" }}
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-t" style={{ borderColor: "var(--ab-border)" }} />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table
        className="w-full text-left text-xs border-collapse min-w-[420px]"
        style={{ borderColor: "var(--ab-border)" }}
      >
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead
      className="font-semibold"
      style={{ background: "var(--ab-surface-raised)", color: "var(--ab-text)" }}
    >
      {children}
    </thead>
  ),
  th: ({ children }) => (
    <th className="px-2.5 py-1.5 font-semibold border-b align-text-top whitespace-nowrap" style={{ borderColor: "var(--ab-border)" }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2.5 py-1.5 align-top" style={{ borderColor: "var(--ab-border)" }}>
      {children}
    </td>
  ),
};

function MarkdownContent({ text }) {
  return (
    <div className="text-sm leading-relaxed" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{text || ""}</ReactMarkdown>
    </div>
  );
}

/**
 * Stable progressive renderer shared by BOTH the SSE-streaming path and the
 * client-side typewriter path.
 *
 * The raw (possibly incomplete) markdown is split at a stable boundary via
 * `splitStablePrefix`: prose renders live through ReactMarkdown, while an
 * in-progress fenced code block is held back as a plain "tail" that grows as
 * content arrives.  ReactMarkdown therefore never receives a half-open ```,
 * so there is no flicker or layout jump — a code block types out progressively
 * in the tail, then locks into a clean `<pre>` in one stable render the
 * instant its closing fence appears.
 */
function StableStreamBody({ text, showCaret }) {
  const { prefix, tail, inCode } = splitStablePrefix(text || "");
  return (
    <div className="text-sm leading-relaxed" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      {prefix ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{prefix}</ReactMarkdown> : null}
      {tail ? (
        <span className={`ab-tail whitespace-pre-wrap block${inCode ? " ab-tail--code" : ""}`}>
          {tail}
        </span>
      ) : null}
      {showCaret && <span className="ab-typing-caret ml-0.5" aria-hidden="true" />}
    </div>
  );
}

/**
 * Live body for an SSE-streaming assistant bubble: renders whatever text has
 * arrived so far plus a trailing blinking caret.  Unlike MarkdownTypewriter
 * it never re-animates — each `token` event simply re-renders the accumulated
 * text through the stable renderer, so streaming stays progressive without
 * ever starting a separate typewriter animation per chunk.
 */
function StreamingText({ text }) {
  return <StableStreamBody text={text} showCaret />;
}

/**
 * Progressive-typing body for a single assistant bubble (ChatGPT-style).
 * ── The reveal NEVER swaps component trees: `useTypewriter` advances a
 * prefix of the raw text and this component re-renders it through the stable
 * renderer, so the completed state is byte-identical to MarkdownContent and
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
  const rafRef = useRef(null);

  useEffect(() => {
    if (done && !firedRef.current) {
      firedRef.current = true;
      onDoneRef.current?.();
    }
  }, [done]);

  // Keep the viewport pinned to the live cursor as each chunk is revealed,
  // in lock-step with the typing animation.  The callback is ref-backed so
  // this fires on every chunk without re-binding the effect; it is a no-op
  // while the user is scrolled up reading history (stick-aware).  Coalesced
  // through requestAnimationFrame to avoid scroll jitter from rapid ticks.
  useEffect(() => {
    if (!displayed) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => onChunkScrollRef.current?.());
  }, [displayed]);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const hasText = text && text.length > 0;

  return (
    <div className="text-sm leading-relaxed" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
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
      {hasText && (
        <StableStreamBody text={displayed} showCaret={isTyping && displayed && hasText} />
      )}
    </div>
  );
}

export function MessageBubble({ message, animate = false, streaming = false, deferStructured = false, onChunkScroll, onDone }) {
  const isUser = message.sender_type === "user";
  const isSystem = message.sender_type === "system";
  const mode = message.mode ? MODE_CONFIG[message.mode] : null;
  const evidence = message.structured_payload?.evidence || [];

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

      <div className={`max-w-[85%] min-w-0 ${isUser ? "order-1" : ""}`}>
        {mode && isSystem && (
          <div className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full mb-1 ${mode.bg} ${mode.color} ${mode.border} border`}>
            <mode.icon size={10} />
            {mode.label}
          </div>
        )}

        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? "ab-bubble-user text-white rounded-br-sm"
              : isSystem
              ? "ab-bubble-system rounded-bl-sm"
              : "ab-bubble-assistant rounded-bl-sm"
          }`}
          style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
        >
          {isUser ? (
            <div className="whitespace-pre-wrap leading-relaxed">{message.message_text}</div>
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

        {!isSystem && <MessageTimeStamp message={message} />}
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {merged.map((prompt, i) => (
          <button
            key={i}
            onClick={() => onSelect(prompt)}
            className="ab-chip text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
