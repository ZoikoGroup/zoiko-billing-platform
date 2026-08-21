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

// ── FAQ category menu (empty-state numbered grid) ────────────────────────────
// 9 categories, 1:1 with KB §17.1 FAQ families table.
// action: "chat" = prefill+send a question (M0/M1), "escalate" = route out.
// Question text is M0/M1 only — no M2/M3/M4 action intents.

export const FAQ_CATEGORIES = [
  { num: 1, label: "Getting started",             question: "How do I get started with Zoiko Billing?",           action: "chat" },
  { num: 2, label: "Invoices",                     question: "How do I check an invoice's status?",               action: "chat" },
  { num: 3, label: "Payments",                     question: "How do I record a payment?",                       action: "chat" },
  { num: 4, label: "Reconciliation",               question: "How does payment reconciliation work?",            action: "chat" },
  { num: 5, label: "Credits & refunds",            question: "What's the difference between a credit and a refund?", action: "chat" },
  { num: 6, label: "Entities & currencies",        question: "How do multi-entity and multi-currency work?",     action: "chat" },
  { num: 7, label: "Permissions",                  question: "How do user roles and permissions work?",          action: "chat" },
  { num: 8, label: "What this assistant can do",   question: "What can you help me with?",                       action: "chat" },
  { num: 9, label: "Speak to a human",             question: null,                                              action: "escalate" },
];

// ── Welcome message (first render, before any user input) ────────────────────

export const WELCOME_MESSAGE =
  "Hi, I'm your Billing Assistant \uD83D\uDC4B Ask me about invoices, payments, customers, or billing workflows \u2014 I'll answer here or point you to the right screen.";

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
