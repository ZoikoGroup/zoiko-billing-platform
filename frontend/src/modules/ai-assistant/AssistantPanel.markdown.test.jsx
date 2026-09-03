import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { MessageBubble } from "./AssistantPanel";

// Targeted tests for the Markdown / typography layer of the assistant bubble
// (the response-text presentation task). They render a single assistant bubble
// (MessageBubble, non-streaming by default → MarkdownContent) and assert on the
// ReactMarkdown output — paragraph, bold, italic, headings, lists, links, code
// blocks, tables, financial emphasis, error rendering, and streaming/cursor.

beforeEach(() => {
  cleanup();
});

function makeAssistantMessage(markdown, overrides = {}) {
  return {
    conversation_id: 1,
    message_uid: "md-1",
    sender_type: "assistant",
    message_text: markdown,
    mode: "M1_INSPECT",
    risk_class: "R0",
    structured_payload: { evidence: [], suggested_prompts: [], next_actions: [] },
    ...overrides,
  };
}

// `streaming`/`animate` are MessageBubble component props, distinct from the
// message fields. Pass them as `props`.
function renderBubble(markdown, overrides = {}, props = {}) {
  return render(<MessageBubble message={makeAssistantMessage(markdown, overrides)} {...props} />);
}

// ── Paragraphs ───────────────────────────────────────────────────────────────

describe("Markdown paragraphs", () => {
  it("renders plain prose as a <p>", () => {
    renderBubble("Just some plain text explaining the result.");
    const p = document.querySelector("p");
    expect(p).toBeTruthy();
    expect(p.textContent).toContain("plain text");
  });

  it("splits paragraphs separated by a blank line into distinct <p> blocks", () => {
    renderBubble("First paragraph.\n\nSecond paragraph.");
    const ps = document.querySelectorAll("p");
    expect(ps.length).toBe(2);
    expect(ps[0].textContent).toContain("First");
    expect(ps[1].textContent).toContain("Second");
  });
});

// ── Bold & italic ────────────────────────────────────────────────────────────

describe("Markdown bold & italic", () => {
  it("renders **bold** as a <strong>", () => {
    renderBubble("This is **very important** news.");
    const strong = document.querySelector("strong");
    expect(strong).toBeTruthy();
    expect(strong.textContent).toBe("very important");
    expect(strong.className).toContain("font-semibold");
  });

  it("renders *italic* as an <em>", () => {
    renderBubble("The balance is *current as of today*.");
    const em = document.querySelector("em");
    expect(em).toBeTruthy();
    expect(em.textContent).toBe("current as of today");
    expect(em.className).toContain("italic");
  });

  it("supports bold and italic combined inline", () => {
    renderBubble("Payment **received** and *confirmed*.");
    expect(document.querySelector("strong").textContent).toBe("received");
    expect(document.querySelector("em").textContent).toBe("confirmed");
  });
});

// ── Headings ─────────────────────────────────────────────────────────────────

describe("Markdown headings", () => {
  it("renders a ## heading as a heading element containing its text", () => {
    renderBubble("## Outstanding Invoices");
    const heading = document.querySelector("h3, h4");
    expect(heading).toBeTruthy();
    expect(heading.textContent).toBe("Outstanding Invoices");
  });
});

// ── Lists ────────────────────────────────────────────────────────────────────

describe("Markdown lists", () => {
  it("renders '-' items as an unordered list with list items", () => {
    renderBubble("- Invoice INV-1001\n- Invoice INV-1002");
    const ul = document.querySelector("ul");
    expect(ul).toBeTruthy();
    expect(ul.className).toContain("list-disc");
    const items = ul.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("INV-1001");
    expect(items[1].textContent).toContain("INV-1002");
  });

  it("renders '1.' items as an ordered list", () => {
    renderBubble("1. First step\n2. Second step");
    const ol = document.querySelector("ol");
    expect(ol).toBeTruthy();
    expect(ol.className).toContain("list-decimal");
    expect(ol.querySelectorAll("li").length).toBe(2);
  });
});

// ── Links ────────────────────────────────────────────────────────────────────

describe("Markdown links", () => {
  it("renders [text](url) as an external link with the accent styling", () => {
    renderBubble("See the [billing guide](https://example.com/docs).");
    const a = document.querySelector("a");
    expect(a).toBeTruthy();
    expect(a.textContent).toBe("billing guide");
    expect(a.getAttribute("href")).toBe("https://example.com/docs");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.className).toContain("underline");
  });
});

// ── Code blocks ──────────────────────────────────────────────────────────────

describe("Markdown code", () => {
  it("renders inline `code` in a mono <code> element", () => {
    renderBubble("Use the `idempotency_key` field.");
    const code = document.querySelector("code");
    expect(code).toBeTruthy();
    expect(code.textContent).toBe("idempotency_key");
    expect(code.className).toContain("font-mono");
  });

  it("renders a fenced code block inside a <pre>", () => {
    renderBubble("```\nSELECT * FROM invoices;\n```");
    const pre = document.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre.className).toContain("rounded-lg");
    const code = pre.querySelector("code");
    expect(code).toBeTruthy();
    expect(code.textContent).toContain("SELECT * FROM invoices");
  });
});

// ── Tables ───────────────────────────────────────────────────────────────────

describe("Markdown tables", () => {
  const TABLE = [
    "| Invoice | Amount |",
    "| ------- | ------ |",
    "| INV-1001 | $500.00 |",
    "| INV-1002 | $1,234.56 |",
  ].join("\n");

  it("renders a table with <th> header cells and <td> body cells", () => {
    renderBubble(TABLE);
    const table = document.querySelector("table");
    expect(table).toBeTruthy();
    const headers = table.querySelectorAll("th");
    expect(headers.length).toBeGreaterThanOrEqual(2);
    expect(headers[0].textContent).toContain("Invoice");
    const cells = table.querySelectorAll("td");
    expect(cells.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the table in an overflow-x-auto wrapper so it never breaks the bubble", () => {
    renderBubble(TABLE);
    const wrapper = document.querySelector(".overflow-x-auto table");
    expect(wrapper).toBeTruthy();
  });
});

// ── Financial emphasis ───────────────────────────────────────────────────────

describe("Financial emphasis", () => {
  it("renders a bolded dollar amount with the financial accent class", () => {
    renderBubble("Your balance is **$1,234.56**.");
    const strong = document.querySelector("strong");
    expect(strong).toBeTruthy();
    expect(strong.textContent).toBe("$1,234.56");
    expect(strong.className).toContain("ab-financial");
  });

  it("keeps ordinary bolded words (no currency) as standard bold", () => {
    renderBubble("This is **important** but not a figure.");
    const strong = document.querySelector("strong");
    expect(strong).toBeTruthy();
    expect(strong.textContent).toBe("important");
    expect(strong.className).toContain("font-semibold");
    expect(strong.className).not.toContain("ab-financial");
  });

  it("treats other currency symbols (€) as financial emphasis too", () => {
    renderBubble("Total: **€89.90**");
    const strong = document.querySelector("strong");
    expect(strong.className).toContain("ab-financial");
  });

  it("applies financial emphasis when the amount is inline within a sentence", () => {
    renderBubble("Please pay **$42** before Friday.");
    const strong = document.querySelector("strong");
    expect(strong.textContent).toBe("$42");
    expect(strong.className).toContain("ab-financial");
  });
});

// ── Error rendering ──────────────────────────────────────────────────────────

describe("Error / control responses render cleanly", () => {
  it("parses markdown so raw ** and backtick syntax never leaks to the user", () => {
    const md = "**Ready** — use the `tool` now, or *escape*.";
    renderBubble(md);
    const bubbleText = document.body.textContent;
    expect(bubbleText).not.toContain("**Ready**");
    expect(bubbleText).not.toContain("`tool`");
    expect(bubbleText).toContain("Ready");
    expect(bubbleText).toContain("tool");
  });

  it("renders an escalation (error) message with its text visible and no raw markdown", () => {
    renderBubble("I couldn't retrieve the records **right now**, so I won't guess.", {
      mode: "M5_ESCALATE",
      risk_class: "R0",
    });
    const text = document.body.textContent;
    expect(text).toContain("couldn't retrieve");
    expect(text).not.toContain("**");
  });
});

// ── Streaming / cursor ───────────────────────────────────────────────────────

describe("Streaming assistant rendering", () => {
  it("renders accumulated streaming text without leaking a half-open code fence", () => {
    // A stream that has reached the code-block opener but not the closer.
    // `streaming` selects the StableStreamBody path. splitStablePrefix holds
    // the open fence in the PLAIN tail (so ReactMarkdown never sees a half-open
    // ``` and there is no flickering/malformed <pre>); the code content is
    // visibly streaming in the tail until its closing fence locks it into a
    // clean <pre>.
    renderBubble("Here is the query:\n\n```sql\nSELECT * FROM invoices;", {}, { streaming: true });
    // The unclosed block is NOT handed to ReactMarkdown → no <pre>/<code> element.
    expect(document.querySelector("pre")).toBeNull();
    // The future code content is already visible (progressive reveal), held in
    // the plain tail that mimics the pre style rather than a half-rendered block.
    expect(document.body.textContent).toContain("SELECT * FROM invoices");
    // Prose before the fence still renders as a normal ReactMarkdown paragraph.
    expect(document.querySelector("p")).toBeTruthy();
  });

  it("shows a typing caret while streaming and hides it once complete", () => {
    const { container } = renderBubble("Partial answer in flight", {}, { streaming: true });
    expect(container.querySelector(".ab-typing-caret")).toBeTruthy();

    cleanup();
    const done = render(
      <MessageBubble
        message={makeAssistantMessage("Completed answer", { mode: "M1_INSPECT" })}
      />
    );
    expect(done.container.querySelector(".ab-typing-caret")).toBeNull();
  });
});
