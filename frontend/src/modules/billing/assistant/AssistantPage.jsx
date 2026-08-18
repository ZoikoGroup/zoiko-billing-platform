import { useState } from "react";
import { Bot, FileText, LockKeyhole, Send, ShieldCheck, Sparkles, UserRound } from "lucide-react";

import { sendChatbotMessage } from "../../../service/chatbotService";

const SUGGESTED_PROMPTS = [
  "What can you do?",
  "Show overdue invoices",
  "Explain partial payments",
  "Why is invoice INV-1001 still open?",
];

const INITIAL_MESSAGE = {
  id: "assistant-initial",
  role: "assistant",
  answer: "Ask me about authorized Zoiko Billing customers, invoices, payments, balances, or workflows. This MVP is read-only and evidence-backed.",
  qualification: "No financial action will be executed from chat.",
  evidence: [],
  next_actions: ["Try an invoice number, customer name, payment number, or overdue summary."],
  mode: "M0_EXPLAIN",
  risk_class: "R0",
  action_status: "NO_ACTION_EXECUTED",
};

function statusTone(value) {
  if (value === "M1_INSPECT") return "bg-blue-50 text-blue-700 border-blue-100";
  if (value === "M5_ESCALATE") return "bg-amber-50 text-amber-800 border-amber-100";
  return "bg-emerald-50 text-emerald-700 border-emerald-100";
}

function EvidenceCard({ evidence }) {
  const fields = Object.entries(evidence.fields || {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Evidence</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{evidence.reference || evidence.resource_type}</p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-600">{evidence.source}</span>
      </div>
      <p className="text-sm text-slate-600">{evidence.summary}</p>
      {fields.length > 0 ? (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {fields.slice(0, 8).map(([key, value]) => (
            <div key={key} className="rounded-xl bg-slate-50 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{key.replaceAll("_", " ")}</p>
              <p className="mt-1 break-words text-sm font-semibold text-slate-800">{String(value)}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AssistantMessage({ message }) {
  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-[#1F0B63] text-white shadow-lg shadow-violet-950/20">
        <Bot className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusTone(message.mode)}`}>{message.mode}</span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600">{message.risk_class}</span>
          <span className="rounded-full border border-violet-100 bg-violet-50 px-3 py-1 text-xs font-bold text-violet-700">{message.action_status}</span>
        </div>
        <p className="text-[15px] leading-7 text-slate-800">{message.answer}</p>
        {message.qualification ? <p className="mt-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">{message.qualification}</p> : null}
        {message.evidence?.length > 0 ? (
          <div className="mt-4 space-y-3">
            {message.evidence.map((item, index) => <EvidenceCard key={`${item.resource_type}-${item.resource_id || index}`} evidence={item} />)}
          </div>
        ) : null}
        {message.next_actions?.length > 0 ? (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Safe Next Actions</p>
            <div className="space-y-2">
              {message.next_actions.map((action) => <p key={action} className="text-sm font-medium text-slate-700">{action}</p>)}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserMessage({ message }) {
  return (
    <div className="flex justify-end gap-3">
      <div className="max-w-3xl rounded-[24px] bg-gradient-to-r from-[#4C2CC5] via-[#7B3AEB] to-[#6033D3] px-5 py-4 text-white shadow-lg shadow-violet-950/20">
        <p className="text-[15px] leading-7">{message.text}</p>
      </div>
      <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-white text-[#4C2CC5] shadow-sm ring-1 ring-slate-200">
        <UserRound className="h-4 w-4" />
      </div>
    </div>
  );
}

export default function AssistantPage() {
  const [messages, setMessages] = useState([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function submitMessage(value = input) {
    const text = value.trim();
    if (!text || loading) return;
    setInput("");
    setError(null);
    setLoading(true);
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", text }]);
    try {
      const response = await sendChatbotMessage({ message: text, conversationId });
      setConversationId(response.conversation_id);
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", ...response }]);
    } catch (err) {
      setError(err.message || "The assistant is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-65px)] bg-[#F8F7F4] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="rounded-[30px] border border-white bg-white/80 p-6 shadow-sm backdrop-blur">
          <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#1F0B63] text-white shadow-lg shadow-violet-950/20">
            <Sparkles className="h-5 w-5" />
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-950">Zoiko Billing Assistant</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">Governed billing help for record lookup, state explanation, balances, payments, and safe next steps.</p>

          <div className="mt-6 space-y-3">
            <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
              <div className="flex items-center gap-2 text-sm font-bold text-emerald-800"><ShieldCheck className="h-4 w-4" /> Permission scoped</div>
              <p className="mt-2 text-sm text-emerald-900/80">Answers use your authenticated tenant context and never cross organizations.</p>
            </div>
            <div className="rounded-2xl border border-violet-100 bg-violet-50 p-4">
              <div className="flex items-center gap-2 text-sm font-bold text-violet-800"><FileText className="h-4 w-4" /> Evidence backed</div>
              <p className="mt-2 text-sm text-violet-900/80">Financial facts cite Zoiko Billing records instead of model guesses.</p>
            </div>
            <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
              <div className="flex items-center gap-2 text-sm font-bold text-amber-900"><LockKeyhole className="h-4 w-4" /> Read-only MVP</div>
              <p className="mt-2 text-sm text-amber-950/80">No invoice issuing, payment recording, refunds, credits, write-offs, or external sends happen from this chat.</p>
            </div>
          </div>

          <div className="mt-6">
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Try</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button key={prompt} type="button" onClick={() => submitMessage(prompt)} className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-[#7B3AEB]/40 hover:text-[#4C2CC5]">
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        </aside>

        <section className="flex min-h-[720px] flex-col rounded-[30px] border border-white bg-white/70 shadow-sm backdrop-blur">
          <div className="border-b border-slate-200 px-5 py-4 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Conversation Surface</p>
                <h2 className="mt-1 text-lg font-black text-slate-950">Ask, inspect, verify</h2>
              </div>
              <span className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600">Action status: no direct execution</span>
            </div>
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-6 sm:px-6">
            {messages.map((message) => message.role === "user" ? <UserMessage key={message.id} message={message} /> : <AssistantMessage key={message.id} message={message} />)}
            {loading ? (
              <div className="flex gap-3">
                <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-[#1F0B63] text-white"><Bot className="h-4 w-4" /></div>
                <div className="rounded-[24px] border border-slate-200 bg-white px-5 py-4 text-sm font-semibold text-slate-600 shadow-sm">Checking authorized Zoiko Billing evidence...</div>
              </div>
            ) : null}
          </div>

          {error ? <div className="mx-5 mb-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 sm:mx-6">{error}</div> : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitMessage();
            }}
            className="border-t border-slate-200 p-4 sm:p-5"
          >
            <div className="flex gap-3 rounded-[24px] border border-slate-200 bg-white p-2 shadow-sm focus-within:border-[#7B3AEB]/50">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask about an invoice, customer, payment, balance, or workflow..."
                className="min-w-0 flex-1 rounded-[18px] border-0 bg-transparent px-4 py-3 text-sm font-medium text-slate-900 outline-none placeholder:text-slate-400"
              />
              <button type="submit" disabled={loading || !input.trim()} className="inline-flex items-center gap-2 rounded-[18px] bg-[#FC7800] px-5 py-3 text-sm font-black text-white shadow-lg shadow-orange-500/20 transition hover:bg-[#e86d00] disabled:cursor-not-allowed disabled:opacity-50">
                <Send className="h-4 w-4" /> Send
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
