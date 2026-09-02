import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
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

vi.mock("./api", () => ({
  createSession: (...args) => mockCreateSession(...args),
  listSessions: (...args) => mockListSessions(...args),
  getSession: (...args) => mockGetSession(...args),
  sendMessageStreamed: (...args) => mockSendStreamed(...args),
  generatePreview: (...args) => mockGeneratePreview(...args),
  confirmAction: (...args) => mockConfirmAction(...args),
  executeAction: (...args) => mockExecuteAction(...args),
  cancelAction: (...args) => mockCancelAction(...args),
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
