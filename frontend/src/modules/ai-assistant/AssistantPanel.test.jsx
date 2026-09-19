import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The suggestion chips / category buttons must behave as ONE-CLICK quick
// questions: a single click submits the exact text through the SAME send path
// used by the Send button and the Enter key, producing EXACTLY one API/SSE
// request and exactly one user message — never a composer-populate-then-wait,
// never a second click, never a duplicate request.

const mockSendStreamed = vi.fn();
const mockCreateSession = vi.fn();
const mockListSessions = vi.fn();
const mockGetSession = vi.fn();
const mockGeneratePreview = vi.fn();
const mockConfirmAction = vi.fn();
const mockExecuteAction = vi.fn();
const mockCancelAction = vi.fn();
const mockCancelStream = vi.fn();

vi.mock("./api", () => ({
  createSession: (...args) => mockCreateSession(...args),
  listSessions: (...args) => mockListSessions(...args),
  getSession: (...args) => mockGetSession(...args),
  sendMessageStreamed: (...args) => mockSendStreamed(...args),
  generatePreview: (...args) => mockGeneratePreview(...args),
  confirmAction: (...args) => mockConfirmAction(...args),
  executeAction: (...args) => mockExecuteAction(...args),
  cancelAction: (...args) => mockCancelAction(...args),
  cancelStream: (...args) => mockCancelStream(...args),
}));

vi.mock("../../service/sessionStorage", () => ({
  getAccessToken: () => "test-token",
}));

// jsdom does not implement Element.scrollTo; the panel calls it on mount via
// scrollChatToBottom. Polyfill so rendering the full panel is valid.
if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollTo =
    HTMLElement.prototype.scrollTo ||
    function scrollToPolyfill() {};
}

import AssistantPanel from "./AssistantPanel";

const SUGGESTIONS = ["Dashboard summary", "Show outstanding balances"];

function makeAssistantSession(messages) {
  return {
    conversation_uid: "conv-1",
    title: "Test Conv",
    messages,
  };
}

function renderPanel(session) {
  return render(
    <MemoryRouter>
      <AssistantPanel isOpen onClose={() => {}} />
    </MemoryRouter>,
    { legacyRoot: false }
  );
}

async function loadPanelWithSuggestions() {
  const session = makeAssistantSession([
    {
      message_uid: "assistant-1",
      sender_type: "assistant",
      message_text: "Here is what I found.",
      mode: "M1_INSPECT",
      risk_class: "R1",
      structured_payload: {
        suggested_prompts: SUGGESTIONS,
        next_actions: [],
        evidence: [],
      },
    },
  ]);
  mockListSessions.mockResolvedValue([session]);
  mockGetSession.mockResolvedValue(session);
  mockSendStreamed.mockImplementation((uid, msg, page, opts) => {
    // Emulate the terminal SSE event so loading settles like a real stream.
    opts.onDone?.({
      response: { answer: `Answer to: ${msg}`, mode: "M1_INSPECT", risk_class: "R1", suggested_prompts: [] },
      streamed: false,
    });
  });
  renderPanel(session);
  await screen.findByText(/here is what i found/i);
  const chip = await screen.findByRole("button", { name: "Dashboard summary" });
  return { chip, otherChip: screen.getByRole("button", { name: "Show outstanding balances" }) };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Suggestion chips — one-click quick questions", () => {
  it("clicking 'Dashboard summary' submits immediately (no second click)", async () => {
    const { chip } = await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();

    fireEvent.click(chip);

    // The very first click must have produced exactly one submission —
    // before any additional interaction.
    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
  });

  it("clicking 'Show outstanding balances' submits immediately", async () => {
    await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Show outstanding balances" }));

    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
  });

  it("passes the exact suggestion text as the submitted message", async () => {
    const { chip } = await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();

    fireEvent.click(chip);

    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
    const [, message] = mockSendStreamed.mock.calls[0];
    expect(message).toBe("Dashboard summary");
  });

  it("adds exactly one user message to the conversation", async () => {
    const { chip } = await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();

    fireEvent.click(chip);

    await waitFor(() => {
      const bubbles = screen.getAllByText("Dashboard summary");
      expect(bubbles.length).toBe(1);
    });
  });

  it("does not merely populate the composer (input stays cleared after submit)", async () => {
    const { chip } = await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();

    fireEvent.click(chip);

    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
    // After an immediate submit the composer must be cleared, not left holding
    // the suggestion text waiting for a second click.
    expect(screen.getByLabelText(/type your billing question/i).value).toBe("");
  });

  it("does not submit twice because of asynchronous state updates", async () => {
    const { chip } = await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();

    fireEvent.click(chip);

    await waitFor(() => expect(mockSendStreamed).toHaveBeenCalledTimes(1));
    // Give any stray async effects time to run — still exactly one submission.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
  });

  it("suggestion click does not trigger the normal composer submit path", async () => {
    const { chip } = await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();

    fireEvent.click(chip);

    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
    // The optimistic bubble for the submitted suggestion is the only user
    // bubble; the compiled requests target the suggestion text, never an
    // empty message from the composer.
    expect(mockSendStreamed.mock.calls[0][1]?.trim().length).toBeGreaterThan(0);
  });
});

describe("Normal manual input still works", () => {
  it("typing + Send button submits exactly once", async () => {
    await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();

    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: "revenue this month" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
    expect(mockSendStreamed.mock.calls[0][1]).toBe("revenue this month");
  });

  it("typing + Enter key submits exactly once", async () => {
    await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();

    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: "revenue this month" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
    expect(mockSendStreamed.mock.calls[0][1]).toBe("revenue this month");
  });
});

describe("Duplicate-submission guard", () => {
  it("subclicks while already submitting do not create duplicate requests", async () => {
    await loadPanelWithSuggestions();

    // Hold the stream open after the first click so `loading` stays true and
    // the suggestion row is suppressed while the assistant is generating.
    let resolveDone;
    const gate = new Promise((r) => { resolveDone = r; });
    mockSendStreamed.mockClear();
    mockSendStreamed.mockImplementation((uid, msg, page, opts) => {
      gate.then(() => opts.onDone?.({ response: { answer: "ok", mode: "M1_INSPECT", suggested_prompts: [] }, streamed: false }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Dashboard summary" }));
    expect(mockSendStreamed).toHaveBeenCalledTimes(1);

    // While the stream is in flight the suggestion row is suppressed (it only
    // renders when `!loading`), so a second click cannot reach the API.
    expect(screen.queryByRole("button", { name: "Dashboard summary" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show outstanding balances" })).toBeNull();

    // Release the pending stream for a clean teardown; still exactly one request.
    await act(async () => { resolveDone(); });
    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
  });
});

describe("Fresh-conversation category buttons", () => {
  it("clicking a non-escalate category submits its question exactly once", async () => {
    mockListSessions.mockResolvedValue([]);
    renderPanel(null);
    mockCreateSession.mockResolvedValue({
      conversation_uid: "conv-new",
      messages: [{ message_uid: "a", sender_type: "assistant", message_text: "ok" }],
    });

    const btn = await screen.findByRole("button", { name: /getting started/i });
    fireEvent.click(btn);

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession.mock.calls[0][1]).toBe("How do I get started with Zoiko Billing?");
  });
});

describe("Loading lifecycle clears after final response", () => {
  async function sendAndHold(text, defer) {
    await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();
    let complete;
    const finished = new Promise((r) => { complete = r; });
    mockSendStreamed.mockImplementation((uid, msg, page, opts) => {
      defer(opts);
      complete(opts);
    });
    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByLabelText(/type your billing question/i)).toBeDisabled());
    return finished;
  }

  it("knowledge answer: 'Checking records...' is gone and input is re-enabled after the final done event", async () => {
    let resolveDone;
    await sendAndHold("How do I create an invoice?", (opts) => {
      resolveDone = () =>
        opts.onDone?.({
          response: { answer: "How to create an invoice: Go to Invoices…", mode: "M0_EXPLAIN", risk_class: "R0", evidence: [{ source: "Zoiko Billing Knowledge Base" }] },
          streamed: false,
        });
    });
    await act(async () => { resolveDone(); });

    await waitFor(() => {
      expect(screen.queryByText(/checking records/i)).toBeNull();
      expect(screen.getByLabelText(/type your billing question/i)).not.toBeDisabled();
    });
    // The knowledge answer is visible and no temporary loading bubble survives it.
    await screen.findByText(/How to create an invoice/i, {}, { timeout: 5000 });
  });

  it("financial answer: loading also clears after the final done event", async () => {
    let resolveDone;
    await sendAndHold("What is my current revenue?", (opts) => {
      resolveDone = () =>
        opts.onDone?.({
          response: { answer: "Your current revenue is…", mode: "M1_INSPECT", risk_class: "R1", evidence: [] },
          streamed: false,
        });
    });
    await act(async () => { resolveDone(); });

    await waitFor(() => {
      expect(screen.queryByText(/checking records/i)).toBeNull();
      expect(screen.getByLabelText(/type your billing question/i)).not.toBeDisabled();
    });
  });

  it("error path also clears the loading state", async () => {
    let resolveError;
    await sendAndHold("whatever", (opts) => {
      resolveError = () => opts.onError?.(new Error("boom"));
    });
    await act(async () => { resolveError(); });

    await waitFor(() => {
      expect(screen.queryByText(/checking records/i)).toBeNull();
      expect(screen.getByLabelText(/type your billing question/i)).not.toBeDisabled();
    });
  });

  it("Stop button clears the loading state immediately", async () => {
    let resolveTokens;
    const gate = new Promise((r) => { resolveTokens = r; });
    await sendAndHold("revenue this month", (opts) => {
      opts.onToken?.({ delta: "partial " });
      resolveTokens(opts);
    });
    await gate;

    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    await waitFor(() => {
      expect(screen.queryByText(/checking records/i)).toBeNull();
      expect(screen.getByLabelText(/type your billing question/i)).not.toBeDisabled();
    });
  });

  it("first message in a fresh conversation clears loading once the session resolves", async () => {
    mockListSessions.mockResolvedValue([]);
    renderPanel(null);
    let resolveSession;
    const gate = new Promise((r) => { resolveSession = r; });
    mockCreateSession.mockClear();
    mockCreateSession.mockImplementation(() => gate.then(() => ({
      conversation_uid: "conv-new",
      messages: [{ message_uid: "a", sender_type: "assistant", message_text: "How to create an invoice" }],
    })));

    const btn = await screen.findByRole("button", { name: /getting started/i });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByText(/checking records/i)).toBeTruthy());

    await act(async () => { resolveSession(); });
    await waitFor(() => {
      expect(screen.queryByText(/checking records/i)).toBeNull();
      expect(screen.getByLabelText(/type your billing question/i)).not.toBeDisabled();
    });
  });
});

describe("Back to Main Menu", () => {
  async function loadConversation() {
    const session = makeAssistantSession([
      {
        message_uid: "assistant-1",
        sender_type: "assistant",
        message_text: "Here is what I found.",
        mode: "M1_INSPECT",
        risk_class: "R1",
        structured_payload: { suggested_prompts: [], next_actions: [], evidence: [] },
        created_at: new Date().toISOString(),
      },
    ]);
    mockListSessions.mockResolvedValue([session]);
    mockGetSession.mockResolvedValue(session);
    renderPanel(session);
    await screen.findByText(/here is what i found/i);
  }

  // The chatbot exposes a single Back to Main Menu control in the header. The
  // former orange in-conversation duplicate must not render.
  function menuButtons() {
    return screen.getAllByRole("button", { name: /back to main menu/i });
  }
  const headerMenuButton = () => menuButtons()[0];

  it("appears exactly once only when a conversation is on screen", async () => {
    await loadConversation();
    expect(menuButtons().length).toBe(1);
    expect(screen.queryByText("Back to Main Menu")).toBeNull();

    // On the empty welcome state there are no messages, so no Back to Menu
    // controls are shown.
    cleanup();
    mockListSessions.mockResolvedValue([]);
    renderPanel(null);
    await screen.findByText(/hi, i'm your billing assistant/i);
    expect(screen.queryAllByRole("button", { name: /back to main menu/i }).length).toBe(0);
  });

  it("keeps all conversation messages visible and shows the main menu below them", async () => {
    await loadConversation();
    mockSendStreamed.mockClear();
    mockCreateSession.mockClear();
    mockListSessions.mockClear();

    fireEvent.click(headerMenuButton());

    // Existing conversation stays on screen — Back to Main Menu does NOT call
    // setMessages([]), it only appends the menu below the messages.
    expect(screen.getByText(/here is what i found/i)).toBeTruthy();

    // The existing welcome/main menu appears BELOW the conversation.
    await waitFor(() => expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1));
    expect(screen.getByRole("button", { name: /getting started/i })).toBeTruthy();

    // Menu appended vs. messages replaced: one intended control stays.
    expect(menuButtons().length).toBe(1);
  });

  it("does not make any backend request", async () => {
    await loadConversation();
    mockSendStreamed.mockClear();
    mockCreateSession.mockClear();
    mockListSessions.mockClear();
    mockGetSession.mockClear();

    fireEvent.click(headerMenuButton());
    await waitFor(() => expect(screen.getByText(/hi, i'm your billing assistant/i)).toBeTruthy());
    expect(mockSendStreamed).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockListSessions).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("is idempotent when clicked repeatedly", async () => {
    await loadConversation();

    // Trigger from the header button.
    fireEvent.click(headerMenuButton());
    await screen.findByText(/hi, i'm your billing assistant/i);
    expect(screen.getByText(/here is what i found/i)).toBeTruthy();
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);

    // Re-triggering is idempotent: same menu, same messages,
    // still exactly one menu section.
    fireEvent.click(headerMenuButton());
    await waitFor(() => expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1));
    expect(screen.getByText(/here is what i found/i)).toBeTruthy();
  });

  it("safely cancels an in-flight stream and keeps completed messages", async () => {
    await loadConversation();
    mockSendStreamed.mockClear();
    mockSendStreamed.mockImplementation(() => {});

    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: "revenue this month" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy());

    fireEvent.click(headerMenuButton());

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
      expect(screen.queryByText(/checking records/i)).toBeNull();
      expect(screen.getByLabelText(/type your billing question/i)).not.toBeDisabled();
      expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
    });
    // Completed messages survive; the in-flight one keeps its partial text.
    expect(screen.getByText(/here is what i found/i)).toBeTruthy();
    expect(screen.getByText(/revenue this month/i)).toBeTruthy();
    expect(mockCancelStream).toHaveBeenCalledWith("conv-1");
  });

  it("continues the conversation from the bottom menu with a single request", async () => {
    await loadConversation();
    mockSendStreamed.mockClear();
    mockSendStreamed.mockImplementation((uid, msg, page, opts) => {
      opts.onDone?.({
        response: { answer: `Answer to: ${msg}`, mode: "M1_INSPECT", risk_class: "R1", evidence: [] },
        streamed: true,
      });
    });

    fireEvent.click(headerMenuButton());
    const gettingStarted = await screen.findByRole("button", { name: /getting started/i });
    fireEvent.click(gettingStarted);

    // Old conversation preserved, exactly one new user message below it.
    expect(screen.getByText(/here is what i found/i)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByText("How do I get started with Zoiko Billing?").length).toBe(1)
    );
    // Exactly one request with the exact suggestion text.
    expect(mockSendStreamed).toHaveBeenCalledTimes(1);
    expect(mockSendStreamed.mock.calls[0][1]).toBe("How do I get started with Zoiko Billing?");
    // New assistant response appears below, and the persisted main menu returns
    // below it — still exactly one menu section (never duplicated on top).
    await waitFor(() => {
      expect(screen.getByText(/answer to: how do i get started/i)).toBeTruthy();
      expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
      expect(screen.getByRole("button", { name: /getting started/i })).toBeTruthy();
    });
  });

  it("keeps the main menu anchored in place across a new question, even while streaming", async () => {
    await loadConversation();

    // Return to the main menu first.
    fireEvent.click(headerMenuButton());
    await screen.findByText(/hi, i'm your billing assistant/i);
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);

    // Ask a new question while holding the stream open.
    mockSendStreamed.mockClear();
    let optsRef;
    mockSendStreamed.mockImplementation((uid, msg, page, opts) => { optsRef = opts; });
    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: "What is my current revenue?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    // While streaming: the MENU REMAINS visible (anchored above the new
    // question), the new user message appears BELOW it, and exactly one
    // request exists.  The menu is never hidden during streaming.
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy());
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
    expect(screen.getByRole("button", { name: /getting started/i })).toBeTruthy();
    expect(screen.getByText("What is my current revenue?")).toBeTruthy();
    expect(mockSendStreamed).toHaveBeenCalledTimes(1);

    // The anchored menu must sit ABOVE the new user message (order preserved).
    const welcomeTexts = screen.getAllByText(/hi, i'm your billing assistant/i);
    expect(welcomeTexts.length).toBe(1);
    const menuPos = welcomeTexts[0].compareDocumentPosition(
      screen.getByText("What is my current revenue?")
    );
    expect(menuPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Complete the stream.
    await act(async () => {
      optsRef.onDone?.({
        response: { answer: "Total revenue is ₹220,006.56.", mode: "M1_INSPECT", risk_class: "R1", evidence: [] },
        streamed: true,
      });
    });

    // Response settles, loading clears.  The response appears BELOW the user
    // question, and there is still exactly ONE menu (never duplicated, never
    // moved to the bottom).
    await waitFor(() => {
      expect(screen.getByText(/total revenue is/i)).toBeTruthy();
      expect(screen.getByLabelText(/type your billing question/i)).not.toBeDisabled();
      expect(screen.queryByText(/checking records/i)).toBeNull();
    });
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
    expect(screen.getByRole("button", { name: /getting started/i })).toBeTruthy();
    expect(screen.getByText(/here is what i found/i)).toBeTruthy();
    expect(screen.getAllByText("What is my current revenue?").length).toBe(1);
    expect(mockSendStreamed).toHaveBeenCalledTimes(1);

    // NO duplicate menu appears below the answer, and the single menu is NOT
    // repositioned after it — the answer stays the last conversation item.
    const menuEl = screen.getAllByText(/hi, i'm your billing assistant/i)[0];
    const answerEl = screen.getByText(/total revenue is/i);
    expect(menuEl.compareDocumentPosition(answerEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not duplicate the main menu when Back to Main Menu is clicked repeatedly at the same spot", async () => {
    await loadConversation();

    fireEvent.click(headerMenuButton());
    await screen.findByText(/hi, i'm your billing assistant/i);
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);

    // Clicking again with no new messages anchors at the same end and must not
    // add a second menu section.
    fireEvent.click(headerMenuButton());
    fireEvent.click(headerMenuButton());
    await waitFor(() => expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1));
    expect(screen.getByText(/here is what i found/i)).toBeTruthy();
  });

  it("returns the main menu after a response error so the chat stays usable", async () => {
    await loadConversation();

    // Return to the main menu, then ask a question that errors out.
    fireEvent.click(headerMenuButton());
    await screen.findByText(/hi, i'm your billing assistant/i);
    mockSendStreamed.mockClear();
    let optsRef;
    mockSendStreamed.mockImplementation((uid, msg, page, opts) => { optsRef = opts; });
    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: "break it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await act(async () => {
      optsRef.onError?.(new Error("boom"));
    });

    // Chat stays usable: loading cleared, composer enabled, error visible —
    // and the main menu returns below it (single menu, no duplicates).
    await waitFor(() => {
      expect(screen.getByLabelText(/type your billing question/i)).not.toBeDisabled();
      expect(screen.queryByText(/checking records/i)).toBeNull();
      expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
      expect(screen.getByText(/here is what i found/i)).toBeTruthy();
      expect(screen.getByText(/break it/i)).toBeTruthy();
    });
  });

  it("restores the main menu when generation is stopped mid-stream", async () => {
    await loadConversation();
    fireEvent.click(headerMenuButton());
    await screen.findByText(/hi, i'm your billing assistant/i);

    mockSendStreamed.mockClear();
    mockSendStreamed.mockImplementation(() => {});
    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: "stop me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy());

    // Stop generation from the composer Stop button.
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
      expect(screen.queryByText(/checking records/i)).toBeNull();
      expect(screen.getByLabelText(/type your billing question/i)).not.toBeDisabled();
    });
    // No broken menu state: the menu returns below the stopped response.
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
    expect(screen.getByText(/here is what i found/i)).toBeTruthy();
    expect(screen.getByText(/stop me/i)).toBeTruthy();
  });

  it("does not behave like New Conversation", async () => {
    await loadConversation();
    mockCreateSession.mockClear();
    mockCreateSession.mockResolvedValue({
      conversation_uid: "conv-new",
      title: "New Conversation",
      messages: [],
    });

    // Back to Main Menu preserves the conversation (no new session).
    fireEvent.click(headerMenuButton());
    await screen.findByText(/hi, i'm your billing assistant/i);
    expect(screen.getByText(/here is what i found/i)).toBeTruthy();
    expect(mockCreateSession).not.toHaveBeenCalled();

    // New Conversation in the header still resets to a blank conversation.
    fireEvent.click(screen.getByRole("button", { name: /new conversation/i }));
    await waitFor(() => expect(screen.queryByText(/here is what i found/i)).toBeNull());
    // A fresh blank conversation shows exactly one welcome menu (top state).
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
    // No Back to Main Menu controls with no messages.
    expect(screen.queryAllByRole("button", { name: /back to main menu/i }).length).toBe(0);
  });
});

describe("Message timestamps", () => {
  const TIME_RE = /^\d{1,2}:\d{2}\s[AP]M$/i;
  function timeSpans() {
    return screen.queryAllByText((_c, el) => {
      if (!el || el.children.length) return false;
      return TIME_RE.test((el.textContent || "").trim());
    });
  }

  async function sendAndComplete(text, optsCallback) {
    await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();
    mockSendStreamed.mockImplementation((uid, msg, page, opts) => optsCallback(opts));
    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    return optsCallback;
  }

  it("renders one h:mm AM/PM timestamp under the user and assistant bubbles after a completed response", async () => {
    let optsRef;
    await sendAndComplete("What is my current revenue?", (opts) => {
      optsRef = opts;
    });
    await act(async () => {
      optsRef.onDone?.({
        response: { answer: "Your revenue is ₹220,006.56.", mode: "M1_INSPECT", risk_class: "R1", evidence: [] },
        streamed: true,
      });
    });

    const spans = timeSpans();
    expect(spans.length).toBe(2);
    for (const s of spans) expect(TIME_RE.test(s.textContent.trim())).toBe(true);

    // User bubble has its own timestamp, assistant bubble its own.
    const userCol = within(screen.getByText("What is my current revenue?").closest(".order-1"));
    expect(userCol.queryAllByText((_c, el) => !!el && !el.children.length && TIME_RE.test((el.textContent || "").trim())).length).toBe(1);
  });

  it("shows a valid timestamp on the optimistic user message while streaming", async () => {
    await sendAndComplete("How do I create an invoice?", () => {});
    await waitFor(() => {
      const spans = timeSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);
      for (const s of spans) expect(TIME_RE.test(s.textContent.trim())).toBe(true);
    });
    const userCol = within(screen.getByText("How do I create an invoice?").closest(".order-1"));
    expect(userCol.queryAllByText((_c, el) => !!el && !el.children.length && TIME_RE.test((el.textContent || "").trim())).length).toBe(1);
  });

  it("uses the persisted created_at for restored conversation history", async () => {
    const persisted = "2025-01-02T10:35:00Z";
    const expected = new Date(persisted).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const session = makeAssistantSession([
      { message_uid: "m1", sender_type: "user", message_text: "old question", created_at: persisted },
      { message_uid: "m2", sender_type: "assistant", message_text: "old answer", created_at: persisted },
    ]);
    mockListSessions.mockResolvedValue([session]);
    mockGetSession.mockResolvedValue(session);
    renderPanel(session);
    await screen.findByText(/old answer/i);

    const spans = timeSpans();
    expect(spans.length).toBe(2);
    for (const s of spans) expect(s.textContent.trim()).toBe(expected);
  });

  it("never shows a timestamp for the empty welcome/menu state", async () => {
    mockListSessions.mockResolvedValue([]);
    renderPanel(null);
    await screen.findByText(/hi, i'm your billing assistant/i);
    expect(timeSpans().length).toBe(0);
  });

  it("Back to Main Menu preserves message timestamps and adds none for the menu", async () => {
    const session = makeAssistantSession([
      {
        message_uid: "assistant-1",
        sender_type: "assistant",
        message_text: "Here is what I found.",
        mode: "M1_INSPECT",
        risk_class: "R1",
        structured_payload: { suggested_prompts: [], next_actions: [], evidence: [] },
        created_at: new Date().toISOString(),
      },
    ]);
    mockListSessions.mockResolvedValue([session]);
    mockGetSession.mockResolvedValue(session);
    renderPanel(session);
    await screen.findByText(/here is what i found/i);

    const before = timeSpans();
    expect(before.length).toBe(1);

    fireEvent.click(screen.getAllByRole("button", { name: /back to main menu/i })[0]);
    await screen.findByText(/hi, i'm your billing assistant/i);

    // Same single timestamp, same value — the menu adds no fake timestamps.
    const after = timeSpans();
    expect(after.length).toBe(1);
    expect(after[0].textContent.trim()).toBe(before[0].textContent.trim());
  });
});

describe("Initial New Conversation main menu (anchored)", () => {
  // Helper: renders a fresh, empty conversation through the SAME New
  // Conversation flow used by the header button (createSession -> empty
  // messages -> anchored main menu at position 0).  Selects the "Getting
  // started" suggestion, which in the fresh state routes through createSession
  // (the backend returns the first assistant reply in session.messages[0]).
  async function startNewConversation() {
    mockListSessions.mockResolvedValue([]);
    mockCreateSession.mockResolvedValue({
      conversation_uid: "conv-new",
      title: "New Conversation",
      messages: [],
    });
    renderPanel(null);
    await screen.findByText(/hi, i'm your billing assistant/i);
    return screen.getAllByText(/hi, i'm your billing assistant/i);
  }

  async function askGettingStarted() {
    await startNewConversation();
    mockCreateSession.mockClear();
    mockCreateSession.mockResolvedValue({
      conversation_uid: "conv-new",
      title: "New Conversation",
      messages: [{
        message_uid: "resp-1",
        answer: "Hello! Here is how to get started.",
        mode: "M1_INSPECT",
        risk_class: "R1",
        evidence: [],
        suggested_prompts: [],
        next_actions: [],
      }],
    });
    fireEvent.click(screen.getByRole("button", { name: /getting started/i }));
    return mockCreateSession;
  }

  it("shows exactly one main menu in a new conversation", async () => {
    const menus = await startNewConversation();
    expect(menus.length).toBe(1);
    expect(screen.getByRole("button", { name: /getting started/i })).toBeTruthy();
  });

  it("New Conversation keeps exactly one menu and clears prior messages", async () => {
    const session = makeAssistantSession([
      {
        message_uid: "assistant-1",
        sender_type: "assistant",
        message_text: "Here is what I found.",
        mode: "M1_INSPECT",
        risk_class: "R1",
        structured_payload: { suggested_prompts: [], next_actions: [], evidence: [] },
        created_at: new Date().toISOString(),
      },
    ]);
    mockListSessions.mockResolvedValue([session]);
    mockGetSession.mockResolvedValue(session);
    renderPanel(session);
    await screen.findByText(/here is what i found/i);

    mockCreateSession.mockResolvedValue({
      conversation_uid: "conv-new",
      title: "New Conversation",
      messages: [],
    });
    mockCreateSession.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /new conversation/i }));
    await waitFor(() => expect(screen.queryByText(/here is what i found/i)).toBeNull());

    // Fresh blank conversation shows exactly one anchored menu, top state.
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
    expect(screen.getByRole("button", { name: /getting started/i })).toBeTruthy();
  });

  it("menu stays above the user question and the completed answer (compareDocumentPosition order)", async () => {
    await askGettingStarted();

    // Single request with the exact suggestion text (fresh state -> createSession).
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession.mock.calls[0][1]).toBe("How do I get started with Zoiko Billing?");

    // The user question + assistant answer become the conversation messages;
    // the anchored menu stays at position 0, ABOVE both of them.
    await screen.findByText(/here is how to get started/i);

    expect(screen.getAllByText("How do I get started with Zoiko Billing?").length).toBe(1);
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
    const singleMenu = screen.getAllByText(/hi, i'm your billing assistant/i)[0];
    const questionEl = screen.getByText("How do I get started with Zoiko Billing?");
    const answerEl = screen.getByText(/here is how to get started/i);
    expect(singleMenu.compareDocumentPosition(questionEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(singleMenu.compareDocumentPosition(answerEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(questionEl.compareDocumentPosition(answerEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("menu remains visible above the fresh question with exactly one request", async () => {
    await askGettingStarted();
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
    const menuEl = screen.getAllByText(/hi, i'm your billing assistant/i)[0];
    expect(menuEl.compareDocumentPosition(
      screen.getByText("How do I get started with Zoiko Billing?")
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ── BUG 1 / BUG 2 regression: message ordering, disappearing messages, and
//    safe session reconciliation.  Ordering/identity are SEQUENCE based — never
//    derived from the displayed timestamp or from a stale wholesale replace.
describe("Message ordering & reconciliation (BUG 1 / BUG 2)", () => {
  // Assert that `beforeText` appears strictly ABOVE `afterText` in the DOM.
  function expectOrdered(beforeText, afterText) {
    const beforeEl = screen.getByText(beforeText);
    const afterEl = screen.getByText(afterText);
    expect(
      beforeEl.compareDocumentPosition(afterEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  }

  // Complete the streaming handshake used by `loadPanelWithSuggestions`.
  async function sendAndAnswer(question, answer) {
    await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();
    let optsRef;
    mockSendStreamed.mockImplementation((uid, msg, page, opts) => {
      optsRef = opts;
    });
    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: question } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await act(async () => {
      optsRef.onDone?.({
        response: { answer, mode: "M1_INSPECT", risk_class: "R1", evidence: [], suggested_prompts: [] },
        streamed: true,
      });
    });
    await screen.findByText(answer);
    return { question, answer };
  }

  // Open the Recent conversations dropdown and click the option whose visible
  // label matches `label` (options are named by session title).
  async function selectSessionViaDropdown(label) {
    fireEvent.click(screen.getByRole("button", { name: /recent conversations/i }));
    const option = await screen.findByRole("option", { name: new RegExp(label) });
    fireEvent.click(option);
  }

  it("TEST 1 — normal order: user question appears strictly before its answer", async () => {
    await sendAndAnswer("How to add a customer?", "Here is how to add a customer.");
    expectOrdered("How to add a customer?", "Here is how to add a customer.");
  });

  it("TEST 2 — identical displayed timestamp: user message still precedes its answer", async () => {
    // A restored pair with the SAME persisted created_at (both round to the
    // identical "h:mm AM/PM" display) must still render in question→answer
    // order.  Ordering must be sequence/content based, never display-clock based.
    const shared = "2026-09-02T17:48:00Z";
    const session = makeAssistantSession([
      { message_uid: "s-u1", sender_type: "user", message_text: "How to add the customer?", created_at: shared },
      { message_uid: "s-a1", sender_type: "assistant", message_text: "The assistant answer.", created_at: shared },
    ]);
    mockListSessions.mockResolvedValue([session]);
    mockGetSession.mockResolvedValue(session);
    renderPanel(session);
    await screen.findByText(/the assistant answer/i);
    expectOrdered("How to add the customer?", "The assistant answer.");
  });

  it("TEST 3 — optimistic user + streaming assistant survive a stale session snapshot", async () => {
    await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();
    let optsRef;
    mockSendStreamed.mockImplementation((uid, msg, page, opts) => { optsRef = opts; });

    fireEvent.click(screen.getByRole("button", { name: "Dashboard summary" }));
    // Optimistic user bubble for the suggestion is now on screen.
    await screen.findByText("Dashboard summary");
    await act(async () => {
      optsRef.onToken?.("Partial dashboard summary");
      await new Promise((r) => setTimeout(r, 60));
    });
    await screen.findByText(/Partial dashboard summary/);

    // A stale snapshot that does NOT yet contain the optimistic turn must not
    // evict it. Open the dropdown and re-select THIS session -> merge.
    await selectSessionViaDropdown("Test Conv");
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
    // Even with the stream left open, BOTH local messages survive.
    expect(screen.getByText("Dashboard summary")).toBeTruthy();
    expect(screen.getByText(/Partial dashboard summary/)).toBeTruthy();
    expectOrdered("Dashboard summary", /Partial dashboard summary/);
    // Clean teardown so loading/streaming state settles.
    await act(async () => {
      optsRef.onDone?.({ response: { answer: "ok", mode: "M1_INSPECT", suggested_prompts: [] }, streamed: true });
    });
  });

  it("TEST 4 — server snapshot merge de-duplicates a persisted twin (no drop, no dup)", async () => {
    await sendAndAnswer("Revenue this month", "Your revenue is 220,006.56.");
    const persisted = makeAssistantSession([
      {
        message_uid: "assistant-1",
        sender_type: "assistant",
        message_text: "Here is what I found.",
        mode: "M1_INSPECT",
        risk_class: "R1",
        structured_payload: { suggested_prompts: [], next_actions: [], evidence: [] },
      },
      { message_uid: "persisted-user", sender_type: "user", message_text: "Revenue this month", created_at: new Date().toISOString() },
      { message_uid: "persisted-assistant", sender_type: "assistant", message_text: "Your revenue is 220,006.56.", created_at: new Date().toISOString() },
    ]);
    mockGetSession.mockResolvedValue(persisted);

    await selectSessionViaDropdown("Test Conv");
    await screen.findByText(/your revenue is 220/i);
    expect(screen.getAllByText("Revenue this month").length).toBe(1);
    expect(screen.getAllByText("Your revenue is 220,006.56.").length).toBe(1);
    expectOrdered("Revenue this month", "Your revenue is 220,006.56.");
  });

  it("TEST 5 — rapid streaming updates never drop a message or swap order", async () => {
    await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();
    let optsRef;
    mockSendStreamed.mockImplementation((uid, msg, page, opts) => { optsRef = opts; });

    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: "question one" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("question one");
    // Two rapid token flushes after optimistic messages append nothing extra.
    await act(async () => {
      optsRef.onToken?.("part");
    });
    await act(async () => {
      optsRef.onToken?.("two");
    });
    await act(async () => {
      optsRef.onDone?.({ response: { answer: "answer one", mode: "M1_INSPECT", suggested_prompts: [] }, streamed: true });
    });
    await screen.findByText("answer one");
    expect(screen.getAllByText("question one").length).toBe(1);
    expect(screen.getAllByText(/^answer one$/).length).toBe(1);
    expectOrdered("question one", "answer one");
  });

  it("TEST 6 — stop generation keeps the partial answer and the question", async () => {
    await loadPanelWithSuggestions();
    mockSendStreamed.mockClear();
    let optsRef;
    mockSendStreamed.mockImplementation((uid, msg, page, opts) => {
      optsRef = opts;
      opts.onToken?.("Partial response so far");
    });
    const textarea = screen.getByLabelText(/type your billing question/i);
    fireEvent.change(textarea, { target: { value: "question two" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("question two");

    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull());
    // Partial answer + the triggering question both remain, in order.
    expect(screen.getByText("question two")).toBeTruthy();
    expectOrdered("question two", /Partial response so far/);
  });

  it("TEST 7 — Back to Main Menu keeps messages and anchors the menu below them", async () => {
    const session = makeAssistantSession([
      { message_uid: "m1", sender_type: "user", message_text: "question three", created_at: new Date().toISOString() },
      { message_uid: "m2", sender_type: "assistant", message_text: "answer three", created_at: new Date().toISOString() },
    ]);
    mockListSessions.mockResolvedValue([session]);
    mockGetSession.mockResolvedValue(session);
    renderPanel(session);
    await screen.findByText(/answer three/i);

    fireEvent.click(screen.getAllByRole("button", { name: /back to main menu/i })[0]);
    await screen.findByText(/hi, i'm your billing assistant/i);
    // Messages remain on screen, in order, and the new question stays below.
    expect(screen.getByText("question three")).toBeTruthy();
    expect(screen.getByText(/answer three/)).toBeTruthy();
    expectOrdered("question three", "answer three");

    // Same-session history refresh/reconcile must not remove or move the
    // frontend-only menu anchor.
    await selectSessionViaDropdown("Test Conv");
    expect(screen.getAllByText(/hi, i'm your billing assistant/i).length).toBe(1);
    expectOrdered("question three", "answer three");
  });

  it("TEST 8 — conversation restore keeps all persisted messages and stable order", async () => {
    const session = makeAssistantSession([
      { message_uid: "p1", sender_type: "user", message_text: "first question", created_at: new Date().toISOString() },
      { message_uid: "p2", sender_type: "assistant", message_text: "first answer", created_at: new Date().toISOString() },
      { message_uid: "p3", sender_type: "user", message_text: "second question", created_at: new Date().toISOString() },
      { message_uid: "p4", sender_type: "assistant", message_text: "second answer", created_at: new Date().toISOString() },
    ]);
    mockListSessions.mockResolvedValue([session]);
    mockGetSession.mockResolvedValue(session);
    renderPanel(session);
    await screen.findByText(/first answer/i);
    await screen.findByText(/second answer/i);
    expect(screen.getByText("first question")).toBeTruthy();
    expect(screen.getByText("second question")).toBeTruthy();
    expectOrdered("first question", "first answer");
    expectOrdered("first answer", "second question");
    expectOrdered("second question", "second answer");
    expect(screen.getAllByText(/^first answer$/).length).toBe(1);
    expect(screen.getAllByText(/^second answer$/).length).toBe(1);
  });
});
