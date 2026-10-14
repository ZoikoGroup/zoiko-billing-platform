/**
 * modules/ai-assistant/suggestedPrompts.js
 * ----------------------------------------
 * Centralised prompt + category definitions for the AI Assistant panel.
 * All content lives here so it can be updated as KB content changes.
 *
 * Sourcing:
 *   - FAQ_CATEGORIES → 1:1 mapping to KB §17.1 FAQ families table
 *   - Default chips  → P0 FAQ families only (KB doc §15 priority column)
 *   - Contextual     → follow-ups within the same P0 family, no escalation
 *
 * Escalation-safe: no chips for missing/duplicate/returned funds,
 * jurisdiction/tax interpretation, or security concerns (KB §17.1 escalation col).
 *
 * All category questions are intent-triggers (prefill + send) — they never
 * skip to an action/execution state (UX doc §5.2).
 */

// ── Approved topic menu (empty-state icon grid) ──────────────────────────────
// The eight client-approved topics, in the exact order and with the exact
// starter questions from ZB-PUBCHAT-WF-001 §6. Question text is M0/M1 only —
// no M2/M3/M4 action intents. "Speak to a human" is NOT a grid tile; it is
// rendered as a separate full-width action (see HUMAN_SUPPORT below).
//
// Each tile carries a Lucide-style line-icon name (`icon`) with its category
// `accent` (stroke color) and `tint` (pastel container background) from the
// reference palette. The `num` field is retained only as a stable identifier;
// it is NEVER rendered as the tile visual.

export const FAQ_CATEGORIES = [
  { num: 1, label: "Getting started",           description: "Set up your account, connect payments",       question: "How do I get started with Zoiko Billing?",                 action: "chat", icon: "rocket",       accent: "#0868F7", tint: "#E8F1FE" },
  { num: 2, label: "Invoices",                  description: "Create, send, track and manage invoices",     question: "How do I create and send an invoice?",                     action: "chat", icon: "file-text",    accent: "#10B981", tint: "#E6F7F0" },
  { num: 3, label: "Payments",                  description: "Accept, track and reconcile payments",        question: "How do payments work in Zoiko Billing?",                   action: "chat", icon: "credit-card",  accent: "#7C3AED", tint: "#F1EBFE" },
  { num: 4, label: "Reconciliation",            description: "Match payments, resolve differences",         question: "How does payment reconciliation work?",                    action: "chat", icon: "bar-chart-3",  accent: "#F97316", tint: "#FEF0E7" },
  { num: 5, label: "Credits & refunds",         description: "Issue credits, refunds and adjustments",      question: "How can I issue a credit or refund?",                      action: "chat", icon: "rotate-ccw",   accent: "#E11D48", tint: "#FDE9EE" },
  { num: 6, label: "Entities & currencies",     description: "Manage entities, taxes and currencies",       question: "Can Zoiko Billing support multiple entities or currencies?", action: "chat", icon: "database",    accent: "#0D9488", tint: "#E3F6F3" },
  { num: 7, label: "Permissions",               description: "Users, roles and access control",             question: "How do user roles and permissions work?",                  action: "chat", icon: "users",        accent: "#7C3AED", tint: "#F1EBFE" },
  { num: 8, label: "What this assistant can do", description: "Capabilities, limits and data privacy",      question: "What can you help me with?",                              action: "chat", icon: "help-circle",  accent: "#D97706", tint: "#FEF3E1" },
];

// ── Full-width human-support action (spec §8) ────────────────────────────────
// Rendered as its own full-width action AFTER the topic grid, not as a tile.

export const HUMAN_SUPPORT = {
  label: "Speak to a human",
  description: "Get help from our support team",
  icon: "headset",
  question: null,
  action: "escalate",
};

// ── Welcome message (first render, before any user input) ────────────────────
// Spec §6 greeting. The public build adds "Sign in for account-specific
// information."; this authenticated assistant omits that clause because the
// operator is already signed in.

export const WELCOME_MESSAGE =
  "Hi, I'm your Zoiko Billing Assistant \uD83D\uDC4B\n\nAsk me about invoices, payments, customers, or billing workflows. I can explain features and guide you to the right place.";

// ── Default chips (shown on empty state, rotated) ────────────────────────────
// Pulled from P0 FAQ families per KB §15.
// "What can this assistant do?" is mandatory per KB §17.1 "AI assistant" family.

export const DEFAULT_PROMPTS = [
  "What's my current balance?",
  "Show my outstanding invoices",
  "What's the difference between a credit and a refund?",
  "What can this assistant do?",
];

// ── Contextual follow-ups (shown after assistant replies) ────────────────────
// Keyed by detected topic. Each topic maps to a FAQ family and provides
// follow-up questions that stay within the same informational scope.
// No M2/M3/M4 action intents — only M0 (explain) and M1 (inspect/read).

export const CONTEXTUAL_PROMPTS = {
  invoices: {
    label: "Invoices",
    followUps: [
      "What does Draft mean for invoice status?",
      "How do I correct a sent invoice?",
      "What does Overdue mean for invoice status?",
      "What do the different invoice statuses mean?",
    ],
  },
  payments: {
    label: "Payments",
    followUps: [
      "What's my outstanding balance?",
      "What are unapplied funds?",
      "What does a failed payment status mean?",
      "How do I record a payment?",
    ],
  },
  refunds: {
    label: "Credits & refunds",
    followUps: [
      "What's the difference between a credit and a refund?",
      "When would I use a credit note?",
      "What approval is needed for refunds?",
      "How do refunds differ from credit notes?",
    ],
  },
  balances: {
    label: "Balances & aging",
    followUps: [
      "What's my current balance?",
      "Show my outstanding invoices",
      "How is the aging report calculated?",
      "What is a collection dispute?",
    ],
  },
  account: {
    label: "Account & customers",
    followUps: [
      "How do I create a new customer?",
      "What are the available user roles?",
      "How do customer contacts work?",
      "What are the different user roles?",
    ],
  },
};

// ── Keyword → topic mapping ──────────────────────────────────────────────────
// Keywords are matched case-insensitively against the last few messages
// to detect what the user is asking about.

export const TOPIC_KEYWORDS = {
  invoices: [
    "invoice", "invoices", "draft", "cancelled", "correct",
    "sent", "delivery", "overdue", "line item",
    "partially_paid", "refunded", "written_off",
  ],
  payments: [
    "payment", "payments", "record", "allocation", "allocated",
    "unapplied", "failed payment", "paid",
  ],
  refunds: [
    "refund", "refunds", "credit", "credit note", "returned",
    "adjustment", "credit note",
  ],
  balances: [
    "balance", "outstanding", "aging", "aging report",
    "collections", "dispute", "amount due",
  ],
  account: [
    "customer", "customers", "contact", "role", "roles",
    "permission", "permissions", "user", "account", "entity",
    "currency", "multi-currency", "multi-entity",
  ],
};
