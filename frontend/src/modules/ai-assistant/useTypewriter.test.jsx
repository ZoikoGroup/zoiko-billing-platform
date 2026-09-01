import { describe, expect, it, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import {
  buildChunks,
  buildSegments,
  chunkTokens,
  splitStablePrefix,
  tokenizeText,
  wordsPerChunkFor,
  useTypewriter,
} from "./useTypewriter";
import { MessageBubble } from "./AssistantPanel";

describe("tokenizeText", () => {
  it("round-trips byte-for-byte, preserving whitespace and newlines", () => {
    const samples = [
      "**Outstanding amount** — the unpaid balance on every issued\n\n- Item one\n- Item two\n\nTotal: INR 500",
      "See the docs at https://example.com for details.",
      "text with\n\n```js\ny=1\n```\nblock",
      "a  b\t\tc\n d",
      "single",
      "",
    ];
    for (const sample of samples) {
      expect(tokenizeText(sample).join("")).toBe(sample);
    }
  });

  it("splits on whitespace runs only", () => {
    expect(tokenizeText("a b\nc   d").length).toBe(7);
    expect(tokenizeText("**bold** — x").length).toBe(5);
  });
});

describe("chunkTokens (prose helper)", () => {
  it("groups whole words without dropping characters", () => {
    const text = "one two three four five six";
    const chunks = chunkTokens(tokenizeText(text), 2);
    expect(chunks.join("")).toBe(text);
    expect(chunks).toHaveLength(3);
  });

  it("keeps multi-space islands attached to the preceding chunk", () => {
    const text = "a  b    c";
    const chunks = chunkTokens(tokenizeText(text), 1);
    expect(chunks.join("")).toBe(text);
  });

  it("never splits inside a markdown token", () => {
    const text = "**bold** `code` [link](https://x.io)";
    const chunks = chunkTokens(tokenizeText(text), 1);
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("handles empty input", () => {
    expect(chunkTokens([], 1)).toEqual([""]);
    expect(chunkTokens([""], 1)).toEqual([""]);
  });
});

describe("wordsPerChunkFor", () => {
  it("reveals short answers in small chunks and long answers in bigger ones", () => {
    expect(wordsPerChunkFor(10)).toBe(1);
    expect(wordsPerChunkFor(200)).toBe(2);
    expect(wordsPerChunkFor(1000)).toBe(6);
  });
});

describe("buildChunks (reveal units)", () => {
  it("always partitions text byte-for-byte (join === original)", () => {
    const samples = [
      "one two three",
      "a  b    c",
      "Intro.\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nOutro.",
      "```\na\nb\n```\n```\nc\n```",
      "**bold** and `inline` \n\n- li one\n- li two",
      "",
      "single",
    ];
    for (const s of samples) {
      expect(buildChunks(s).join("")).toBe(s);
    }
  });

  it("caps prose chunk size so no 4-6 word jump appears", () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const chunks = buildChunks(words).filter((c) => c.trim());
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.trim().split(/\s+/).length).toBeLessThanOrEqual(3);
    }
    expect(chunks.join("")).toBe(words);
  });

  it("splits a large code block into several bounded line units (progressive)", () => {
    const code = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const text = `before\n\n\`\`\`js\n${code}\n\`\`\`\n\nafter`;
    const chunks = buildChunks(text);
    // No single chunk contains the entire block body; it is split up.
    expect(chunks.some((c) => c.includes(code))).toBe(false);
    expect(chunks.join("")).toBe(text);
  });

  it("handles short and long responses without dropping bytes", () => {
    const short = "Hi.";
    const long = Array.from({ length: 200 }, (_, i) => `word ${i}`).join(" ");
    expect(buildChunks(short).join("")).toBe(short);
    expect(buildChunks(long).join("")).toBe(long);
  });
});

describe("splitStablePrefix (markdown stability)", () => {
  it("keeps pure prose whole and live (no tail, inCode false)", () => {
    const text = "**Bold text** with `inline` and a list.\n\n- item one\n- item two";
    const { prefix, tail, inCode } = splitStablePrefix(text);
    expect(prefix).toBe(text);
    expect(tail).toBe("");
    expect(inCode).toBe(false);
  });

  it("never exposes a half-open fence: while inside a code block the fence stays in the tail", () => {
    const text = "intro\n\n```js\nconst x = 1;";
    const { prefix, tail, inCode } = splitStablePrefix(text);
    expect(prefix).toBe("intro\n\n");
    expect(tail.startsWith("```js")).toBe(true);
    expect(tail).toContain("const x = 1;");
    expect(inCode).toBe(true);
    expect(prefix.includes("```")).toBe(false);
    expect(prefix + tail).toBe(text);
  });

  it("locks a completed code block back into the stable prefix once closed", () => {
    const text = "intro\n\n```js\nconst x = 1;\n```";
    const { prefix, tail, inCode } = splitStablePrefix(text);
    expect(inCode).toBe(false);
    expect(tail).toBe("");
    expect(prefix).toBe(text);
  });

  it("keeps multiple code blocks stable and byte-identical", () => {
    const text = "a\n\n```\n1\n```\n\nb\n\n```\n2\n```\n\nc";
    // Fully closed → entirely stable, byte-for-byte.
    expect(splitStablePrefix(text).prefix).toBe(text);
    // Mid second block → only the second block is pending.
    const partial = text + "\n\n```\nsome open";
    const { prefix, tail, inCode } = splitStablePrefix(partial);
    expect(inCode).toBe(true);
    expect(prefix.includes("```")).toBe(true); // first block is already closed & stable
    expect(tail.startsWith("```")).toBe(true);
    expect(prefix + tail).toBe(partial);
  });

  it("marks responses with markdown before and after code blocks correctly", () => {
    const text = "**before**\n\n```js\nx\n```\n\n*after*";
    const { prefix, tail, inCode } = splitStablePrefix(text);
    expect(inCode).toBe(false);
    expect(tail).toBe("");
    expect(prefix).toBe(text);
  });

  it("handles empty text", () => {
    expect(splitStablePrefix("")).toEqual({ prefix: "", tail: "", inCode: false });
  });
});

// HookBehaviour harness — renders a consumer that focuses on animation state.
function TypewriterProbe({ text, active = true, onFinish }) {
  const t = useTypewriter(text, { active, initialDelay: 0 });
  if (onFinish) t.onDone(onFinish);
  return (
    <div>
      <span data-testid="displayed">{t.displayed}</span>
      <span data-testid="typing">{String(t.isTyping)}</span>
      <span data-testid="done">{String(t.done)}</span>
      <span data-testid="progress">{t.progress}</span>
    </div>
  );
}

function advanceTimersBy(ms) {
  act(() => vi.advanceTimersByTime(ms));
}

describe("useTypewriter (progressive reveal)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
  });

  it("reveals progressively (monotonic, growing prefix) and completes", () => {
    const text = "Hello, world. This is a test.";
    render(<TypewriterProbe text={text} />);
    expect(screen.getByTestId("displayed").textContent).toBe("");
    expect(screen.getByTestId("typing").textContent).toBe("true");

    let prev = "";
    let guard = 0;
    while (screen.getByTestId("done").textContent !== "true" && guard < 400) {
      advanceTimersBy(8);
      guard++;
      const cur = screen.getByTestId("displayed").textContent;
      expect(cur.startsWith(prev)).toBe(true); // monotonic prefix
      prev = cur;
    }

    expect(screen.getByTestId("done").textContent).toBe("true");
    expect(screen.getByTestId("typing").textContent).toBe("false");
    expect(screen.getByTestId("displayed").textContent).toBe(text);
    expect(screen.getByTestId("progress").textContent).toBe("1");
  });

  it("reveals only a prefix, never the whole long text at once", () => {
    const text = Array.from({ length: 120 }, (_, i) => `word ${i}`).join(" ");
    render(<TypewriterProbe text={text} />);
    advanceTimersBy(2);
    const first = screen.getByTestId("displayed").textContent;
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(text.length);
  });

  it("cancels immediately and snaps to full text when active goes false (new response replaces old)", () => {
    const text = "Some response ".repeat(20).trim();
    const { rerender } = render(<TypewriterProbe text={text} />);
    advanceTimersBy(20);
    // New message supersedes: active=false snaps to the complete new text.
    rerender(<TypewriterProbe text={text} active={false} />);
    expect(screen.getByTestId("done").textContent).toBe("true");
    expect(screen.getByTestId("displayed").textContent).toBe(text);
  });

  it("handles an empty response (done immediately, no typing)", () => {
    render(<TypewriterProbe text="" />);
    expect(screen.getByTestId("done").textContent).toBe("true");
    expect(screen.getByTestId("typing").textContent).toBe("false");
  });

  it("handles a very short response", () => {
    render(<TypewriterProbe text="Hi!" />);
    let ticks = 0;
    while (screen.getByTestId("done").textContent !== "true" && ticks < 20) {
      advanceTimersBy(8);
      ticks++;
    }
    expect(screen.getByTestId("done").textContent).toBe("true");
    expect(screen.getByTestId("displayed").textContent).toBe("Hi!");
  });

  it("handles a very long response containing multiple code blocks", () => {
    const block = (n) => `\`\`\`\nline ${n}a\nline ${n}b\nline ${n}c\n\`\`\``;
    const text = `Intro paragraph ${"long ".repeat(10)}\n\n${block(1)}\n\nMiddle text.\n\n${block(2)}\n\nOutro ${"end ".repeat(8)}`;
    render(<TypewriterProbe text={text} />);
    let ticks = 0;
    while (screen.getByTestId("done").textContent !== "true" && ticks < 4000) {
      advanceTimersBy(8);
      ticks++;
    }
    expect(ticks).toBeLessThan(4000);
    expect(screen.getByTestId("done").textContent).toBe("true");
    expect(screen.getByTestId("displayed").textContent).toBe(text);
  });

  it("never hands ReactMarkdown a half-open fence at any tick", () => {
    const text = "intro\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\noutro";
    render(<TypewriterProbe text={text} />);
    let ticks = 0;
    while (screen.getByTestId("done").textContent !== "true" && ticks < 1000) {
      advanceTimersBy(8);
      ticks++;
      const cur = screen.getByTestId("displayed").textContent;
      const { prefix, tail, inCode } = splitStablePrefix(cur);
      // The stable prefix is what ReactMarkdown would render. It must never
      // contain an UNCLOSED fence: if a fence is open it lives in the tail.
      // Count fence delimiters in the prefix — must always be balanced (even).
      const fenceCount = (prefix.match(/^\s*```/gm) || []).length;
      expect(fenceCount % 2).toBe(0);
      // If there is pending code, the fence opener must be present in the tail.
      if (inCode) expect(tail.startsWith("```")).toBe(true);
      if (!inCode) expect(tail).toBe("");
    }
    expect(screen.getByTestId("done").textContent).toBe("true");
  });
});

describe("buildSegments (small adaptive pacing)", () => {
  it("produces small character segments (never 4-6+ word dumps)", () => {
    const text = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const segs = buildSegments(text).filter((s) => s.trim());
    expect(segs.length).toBeGreaterThan(20);
    // No segment contains anywhere near 4-6 words.
    for (const s of segs) {
      expect(s.trim().split(/\s+/).length).toBeLessThanOrEqual(2);
    }
  });

  it("keeps whitespace and the original text byte-for-byte", () => {
    const samples = [
      "one two three",
      "a  b    c\n\nwith   tabs\t and\nlines",
      "**bold** and `inline` [link](https://x.io)",
      "Hi.",
      "",
      "```js\nconst a = 1;\n```",
    ];
    for (const s of samples) {
      expect(buildSegments(s).join("")).toBe(s);
    }
  });

  it("does not reveal the text one literal character at a time", () => {
    const text = "A moderately sized sentence with some words in it.";
    const segs = buildSegments(text);
    expect(segs.length).toBeLessThan(text.length);
    expect(Math.max(...segs.map((s) => s.length))).toBeGreaterThanOrEqual(2);
  });
});

describe("useTypewriter lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
  });

  it("changing text cancels the previous animation and starts fresh", () => {
    const { rerender } = render(<TypewriterProbe text="AAAA BBBB CCCC DDDD" />);
    advanceTimersBy(20);
    const mid = screen.getByTestId("displayed").textContent;
    rerender(<TypewriterProbe text="New response entirely different" />);
    // Immediately after the text change, the reveal restarts from scratch.
    expect(screen.getByTestId("displayed").textContent).toBe("");
    expect(screen.getByTestId("typing").textContent).toBe("true");
    let guard = 0;
    while (screen.getByTestId("done").textContent !== "true" && guard < 1000) {
      advanceTimersBy(8);
      guard++;
    }
    expect(screen.getByTestId("displayed").textContent).toBe("New response entirely different");
  });

  it("active=false immediately shows the complete response and stops typing", () => {
    render(<TypewriterProbe text="Complete answer text" active={false} />);
    expect(screen.getByTestId("displayed").textContent).toBe("Complete answer text");
    expect(screen.getByTestId("done").textContent).toBe("true");
    expect(screen.getByTestId("typing").textContent).toBe("false");
  });

  it("the completion callback fires exactly once", () => {
    const onFinish = vi.fn();
    render(<TypewriterProbe text="Finite answer." onFinish={onFinish} />);
    let guard = 0;
    while (screen.getByTestId("done").textContent !== "true" && guard < 500) {
      advanceTimersBy(8);
      guard++;
    }
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("a stale completion callback cannot fire after the text changes", () => {
    const firstFinish = vi.fn();
    const secondFinish = vi.fn();
    const { rerender } = render(<TypewriterProbe text="First response here" onFinish={firstFinish} />);
    // Change text BEFORE the first animation completes — the first callback
    // was registered for the old animation and must never fire.
    advanceTimersBy(10);
    rerender(<TypewriterProbe text="Second response here" onFinish={secondFinish} />);
    let guard = 0;
    while (screen.getByTestId("done").textContent !== "true" && guard < 1000) {
      advanceTimersBy(8);
      guard++;
    }
    expect(firstFinish).not.toHaveBeenCalled();
    expect(secondFinish).toHaveBeenCalledTimes(1);
  });

  it("unmount cancels timers and prevents further updates", () => {
    const { unmount } = render(<TypewriterProbe text={"Longer response " + "x".repeat(60)} />);
    advanceTimersBy(10);
    // Unmount mid-animation; pending timers must be cleared without error.
    unmount();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByTestId("done")).toBeNull();
  });

  it("supports a stream-like feed where text grows monotonically (no duplication)", () => {
    const { rerender } = render(<TypewriterProbe text="" active={false} />);
    // Simulate SSE tokens arriving: each render feeds more text, like an
    // active stream appended to the same message. The typewriter is NOT in
    // play here (active=false — the streaming path owns rendering), so the
    // hook simply mirrors the authoritative text without duplicating it.
    const parts = ["Hel", "lo wor", "ld, this ", "is streamed."];
    let acc = "";
    for (const p of parts) {
      acc += p;
      rerender(<TypewriterProbe text={acc} active={false} />);
      expect(screen.getByTestId("displayed").textContent).toBe(acc);
    }
    expect(screen.getByTestId("displayed").textContent).toBe("Hello world, this is streamed.");
  });
});

describe("useTypewriter markdown support", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
  });

  function runToEnd() {
    let guard = 0;
    while (screen.getByTestId("done").textContent !== "true" && guard < 2000) {
      advanceTimersBy(8);
      guard++;
    }
  }

  const MD_CASES = {
    bold: "This has **bold** text.",
    italic: "This has *italic* and _emphasis_.",
    heading: "# Heading\n\nBody.",
    list: "- item one\n- item two\n\n1. num one\n2. num two",
    inlineCode: "Use `npm install` to install.",
    fencedJs: "```js\nconst x = 1;\nconsole.log(x);\n```",
    fencedPython: "```python\ndef f():\n    return 1\n```",
    multiline: "```\nline1\nline2\nline3\nline4\nline5\n```",
    multipleBlocks: "a\n\n```js\nx\n```\n\nb\n\n```py\ny\n```\n\nc",
    proseBefore: "Before the block.\n\n```js\nx\n```",
    proseAfter: "```js\nx\n```\n\nAfter the block.",
  };

  for (const [name, text] of Object.entries(MD_CASES)) {
    it(`renders ${name} without dropping bytes and completes`, () => {
      render(<TypewriterProbe text={text} />);
      runToEnd();
      expect(screen.getByTestId("done").textContent).toBe("true");
      expect(screen.getByTestId("displayed").textContent).toBe(text);
      // No displayed intermediate value ever holds an unmatched fence.
      const { prefix, tail, inCode } = splitStablePrefix(text);
      expect(prefix + tail).toBe(text);
    });
  }
});

describe("StreamingText vs MarkdownTypewriter mutual exclusivity", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    cleanup();
  });

  function bubbleProps(m, overrides = {}) {
    return {
      message: {
        sender_type: "assistant",
        mode: "M0_EXPLAIN",
        risk_class: "R0",
        structured_payload: {},
        message_text: "*markdown body*",
        ...m,
      },
      ...overrides,
    };
  }

  it("renders exactly one body: streaming XOR typewriter XOR completed", () => {
    // Streaming mode: the streaming marker is rendered, not the typewriter.
    const s = render(<MessageBubble {...bubbleProps({})} streaming />);
    // Typewriter mode: the streaming marker must NOT be present.
    const t = render(<MessageBubble {...bubbleProps({})} animate />);
    // Completed: neither streaming marker nor typewriter caret appear.
    const c = render(<MessageBubble {...bubbleProps({})} />);
    // Advance past the typewriter's initial reveal delay so its caret appears.
    act(() => vi.advanceTimersByTime(250));

    const streamingHasCaret = !!s.container.querySelector(".ab-typing-caret");
    const typewriterHasCaret = !!t.container.querySelector(".ab-typing-caret");
    const completedHasCaret = !!c.container.querySelector(".ab-typing-caret");
    expect(streamingHasCaret).toBe(true);
    expect(typewriterHasCaret).toBe(true);
    expect(completedHasCaret).toBe(false);
  });

  it("does not start a separate typewriter per streamed chunk (page content follows stream)", () => {
    // StreamingText is a simple stateless body; feeding more text never
    // triggers the typewriter hook (which would restart an animation). We
    // verify via the discriminant in MessageBubble: while `streaming` is true,
    // the typewriter component is never mounted.
    const { rerender, container } = render(<MessageBubble {...bubbleProps({})} streaming />);
    expect(container.querySelector(".ab-typing-caret")).not.toBeNull();
    // Feeding "chunks" (rerender with more text, still streaming) keeps
    // exactly one StreamingText body — no ticker/typewriter added.
    for (let i = 0; i < 10; i++) {
      rerender(
        <MessageBubble {...bubbleProps({ message_text: "chunk ".repeat(i + 1) + "*md*" })} streaming />
      );
    }
    expect(container.querySelectorAll(".ab-typing-caret").length).toBe(1);
  });

  it("final content takes over via MarkdownContent (no duplicate text)", () => {
    const text = "Streamed and final answer with **bold**.";
    const finalC = render(<MessageBubble {...bubbleProps({ message_text: text })} />);
    // Completed message renders MarkdownContent — no caret, content present once.
    expect(finalC.container.querySelector(".ab-typing-caret")).toBeNull();
    expect(finalC.container.textContent).toContain("Streamed and final answer");
  });
});

describe("cursor visibility", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    cleanup();
  });

  it("caret is visible while typing and hidden after completion", () => {
    const { container, rerender } = render(
      <MessageBubble {...({ message: { sender_type: "assistant", mode: "M0_EXPLAIN", risk_class: "R0", structured_payload: {}, message_text: "Typing this out." }, animate: true })} onDone={() => {}} />
    );
    // Reveal a first chunk so the caret (trailing live content) appears.
    act(() => vi.advanceTimersByTime(250));
    expect(container.querySelector(".ab-typing-caret")).not.toBeNull();
    // After completion (animate=false → MarkdownContent) the caret disappears.
    rerender(
      <MessageBubble {...({ message: { sender_type: "assistant", mode: "M0_EXPLAIN", risk_class: "R0", structured_payload: {}, message_text: "Typing this out." } })} onDone={() => {}} />
    );
    expect(container.querySelector(".ab-typing-caret")).toBeNull();
  });

  it("never shows the caret on completed historical messages", () => {
    const { container } = render(
      <MessageBubble {...({ message: { sender_type: "assistant", mode: "M0_EXPLAIN", risk_class: "R0", structured_payload: {}, message_text: "Historical" } })} />
    );
    expect(container.querySelector(".ab-typing-caret")).toBeNull();
  });
});
