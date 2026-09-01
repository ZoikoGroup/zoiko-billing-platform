/**
 * modules/ai-assistant/useTypewriter.js
 * -------------------------------------
 * Reusable progressive-typing hook for assistant responses (ChatGPT-style).
 *
 * Two complementary pieces make the reveal feel like modern AI generation
 * rather than a human typing every character:
 *
 *  1. Adaptive reveal pacing (`buildSegments` + `useTypewriter`) — the raw
 *     answer is broken into SMALL, character-sized segments (a few visible
 *     chars at a time, extended to a nearby whitespace when that keeps a word
 *     whole).  Never a 4–6 word dump, never a literal one-character crawl.
 *     The delay for each step is derived from the size of the segment just
 *     revealed (chars-per-second), clamped to a short 15–90ms window, with a
 *     slightly longer pause only at sentence-ending punctuation and meaningful
 *     newlines.  Short answers stay snappy; long answers stream at a steady,
 *     slightly higher clip instead of racing.
 *
 *  2. Stable rendering (`splitStablePrefix`) — when the partial text is
 *     rendered it is split at a markdown-stable boundary: prose stays live
 *     and whole, while a fenced code block is held back as a "pending tail"
 *     until its closing fence is available.  ReactMarkdown therefore never
 *     receives a half-open ``` so there is no flicker or layout jump, yet the
 *     code content still appears progressively via the tail instead of as one
 *     giant `<pre>` in a single render.
 *
 * Lifecycle guarantees:
 *  - one animation at a time (a single chained timer; the previous timer and
 *    any stale completion callbacks are cleared as soon as the text changes),
 *  - when `active: false` the full text is exposed immediately and no timer is
 *    left running, and the component unmount clears all timers/callbacks,
 *  - `displayed` always reveals a prefix of the raw text byte-for-byte,
 *  - the public return shape is stable: { displayed, isTyping, done, progress,
 *    onDone }.
 */

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Split text into word tokens, preserving the exact whitespace between them
 * (including newlines and multiple spaces) so rejoining reproduces the
 * original string byte-for-byte.
 */
export function tokenizeText(text) {
  const parts = [];
  const re = /(\s+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(m[1]);
    last = m.index + m[1].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * Group tokens into reveal chunks of ~`wordsPerChunk` words.  Whitespace-only
 * islands ride along with the previous chunk so boundaries always land on
 * whole words.  Kept for backward compatibility / unit tests; the hook uses
 * the finer-grained `buildSegments` for its reveal pacing.
 */
export function chunkTokens(tokens, wordsPerChunk = 2) {
  const chunks = [];
  let buffer = [];
  let wordCount = 0;
  for (const tok of tokens) {
    buffer.push(tok);
    if (tok.trim()) wordCount += 1;
    if (wordCount >= wordsPerChunk) {
      chunks.push(buffer.join(""));
      buffer = [];
      wordCount = 0;
    }
  }
  if (buffer.length) chunks.push(buffer.join(""));
  return chunks.length ? chunks : [""];
}

export const TYPEWRITER_OPTIONS = {
  active: true,
  cps: 46,
  longTextCps: 52,
  minDelay: 15,
  maxDelay: 90,
  initialDelay: 160,
  targetChars: 4,
  maxLookahead: 4,
};

const LONG_TEXT_CHARS = 600;
const SHORT_TEXT_CHARS = 140;
const FENCE_RE = /^\s*```/;

export function wordsPerChunkFor(textLength) {
  if (textLength < SHORT_TEXT_CHARS) return 1;
  if (textLength < LONG_TEXT_CHARS) return 2;
  return 6;
}

/**
 * Build SMALL, character-sized reveal segments so the animation reads as
 * smooth, natural generation — never a 4–6 word jump and never a literal
 * one-character crawl.
 *
 * Each segment is ~`targetChars` visible characters, extended to the nearest
 * whitespace when one is close (within `maxLookahead`) so words are usually
 * kept whole.  Whitespace and the original text are preserved byte-for-byte
 * (segments.join("") === text).
 */
export function buildSegments(text, targetChars = 4, maxLookahead = 4) {
  const str = text || "";
  const segments = [];
  let i = 0;
  const n = str.length;
  if (n === 0) return [""];
  while (i < n) {
    let size = Math.max(1, targetChars);
    const hardEnd = Math.min(i + size, n);
    if (hardEnd < n) {
      // Prefer to end at a whitespace within the next few chars.
      const searchEnd = Math.min(hardEnd + maxLookahead, n);
      for (let k = hardEnd; k < searchEnd; k++) {
        if (/\s/.test(str[k])) {
          size = Math.min(k - i + 1, n - i);
          break;
        }
      }
    }
    size = Math.min(size, n - i);
    segments.push(str.slice(i, i + size));
    i += size;
  }
  return segments.length ? segments : [""];
}

/**
 * Grouping helper (kept for backward compatibility / tests).  Segments text
 * into prose / fence / code regions and expands them into reveal units.  The
 * hook's live pacing uses `buildSegments` directly; this remains a valid,
 * byte-preserving partition for tests that call it.
 */
export function buildChunks(text, overrides = {}) {
  const textStr = text || "";
  const maxProseWords = overrides.maxProseWords ?? 3;
  const maxCodeLines = overrides.maxCodeLines ?? 4;
  const lines = textStr.split("\n");

  const regions = [];
  let inFence = false;
  let proseBuf = "";
  const flushProseBuf = () => {
    if (proseBuf) {
      regions.push({ type: "prose", text: proseBuf });
      proseBuf = "";
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasNext = i < lines.length - 1;
    if (FENCE_RE.test(line)) {
      flushProseBuf();
      regions.push({ type: "fence", text: line + (hasNext ? "\n" : "") });
      inFence = !inFence;
    } else if (inFence) {
      flushProseBuf();
      let group = line;
      let j = i;
      while (j + 1 < lines.length && !FENCE_RE.test(lines[j + 1]) && group.split("\n").length < maxCodeLines) {
        group += "\n" + lines[j + 1];
        j++;
      }
      regions.push({ type: "code", text: group + (j < lines.length - 1 ? "\n" : "") });
      i = j;
    } else {
      proseBuf += line + (hasNext ? "\n" : "");
    }
  }
  flushProseBuf();

  const chunks = [];
  for (const r of regions) {
    if (r.type === "prose") {
      const sub = chunkTokens(tokenizeText(r.text), maxProseWords);
      for (const c of sub) if (c !== "") chunks.push(c);
    } else {
      chunks.push(r.text);
    }
  }
  return chunks.length ? chunks : [""];
}

/**
 * Split a (possibly partial) markdown string at a stable boundary so it can
 * be rendered without a half-open fenced block.
 *
 * Returns { prefix, tail, inCode } where `prefix + tail === text` byte-for-byte:
 *  - `prefix` is always markdown-stable (no unclosed fence) → safe for
 *    ReactMarkdown.
 *  - `tail` is the still-forming region.  When we are currently inside an
 *    open code fence, `tail` holds the whole in-progress block and `inCode`
 *    is true, so the consumer can render it as progressively appearing code.
 *    Otherwise `tail` is empty (prose stays entirely in `prefix`).
 */
export function splitStablePrefix(text) {
  if (!text) return { prefix: "", tail: "", inCode: false };
  const lines = text.split("\n");
  let inFence = false;
  let lastOpenLineStart = -1;
  let lineStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      if (!inFence) {
        inFence = true;
        lastOpenLineStart = lineStart;
      } else {
        inFence = false;
        lastOpenLineStart = -1;
      }
    }
    lineStart += line.length + 1;
  }
  if (inFence && lastOpenLineStart >= 0) {
    return {
      prefix: text.slice(0, lastOpenLineStart),
      tail: text.slice(lastOpenLineStart),
      inCode: true,
    };
  }
  return { prefix: text, tail: "", inCode: false };
}

const SENTENCE_END = /[.!?…][)"']?$/;

// Pacing: base = segment size / cps, clamped to the 15–90ms window.  A longer
// pause is added ONLY at sentence-ending punctuation and meaningful newlines
// (as requested) — no random/jitter pauses that would feel mechanical.
function stepDelay(segment, cps, minDelay, maxDelay) {
  const chars = segment.length || 1;
  let base = Math.round((chars / cps) * 1000);
  let pause = 1;
  const trimmed = segment.trimEnd();
  if (SENTENCE_END.test(trimmed)) pause = 1.4;
  else if (segment.endsWith("\n") && segment.trim().length > 0) pause = 1.15;
  return Math.max(minDelay, Math.min(maxDelay, Math.round(base * pause)));
}

/**
 * @param {string} fullText complete assistant response (Markdown source)
 * @param {{active?: boolean, cps?: number, longTextCps?: number, minDelay?: number, maxDelay?: number, initialDelay?: number, targetChars?: number, maxLookahead?: number}} [options]
 * @returns {{displayed: string, isTyping: boolean, done: boolean, progress: number, onDone: (cb: () => void) => void}}
 */
export function useTypewriter(fullText, options = {}) {
  const {
    active = TYPEWRITER_OPTIONS.active,
    cps = TYPEWRITER_OPTIONS.cps,
    longTextCps = TYPEWRITER_OPTIONS.longTextCps,
    minDelay = TYPEWRITER_OPTIONS.minDelay,
    maxDelay = TYPEWRITER_OPTIONS.maxDelay,
    initialDelay = TYPEWRITER_OPTIONS.initialDelay,
    targetChars = TYPEWRITER_OPTIONS.targetChars,
    maxLookahead = TYPEWRITER_OPTIONS.maxLookahead,
  } = options;

  const text = fullText || "";
  const long = text.length >= LONG_TEXT_CHARS;
  const cpsActive = long ? longTextCps : cps;

  const segments = useMemo(
    () => buildSegments(text, targetChars, maxLookahead),
    [text, targetChars, maxLookahead]
  );

  const [displayed, setDisplayed] = useState("");
  const [count, setCount] = useState(0);
  const timerRef = useRef(null); // single chained timer, never one per char
  const doneListenersRef = useRef([]);
  const accRef = useRef("");

  useEffect(() => {
    // Teardown any prior animation + its listeners before starting fresh, so
    // a stale response can never fire completion callbacks for the new one.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    doneListenersRef.current = [];
    accRef.current = "";
    setCount(0);

    if (!active || !text) {
      setDisplayed(active ? "" : text);
      return;
    }

    setDisplayed("");

    const n = segments.length;
    let i = 0;
    const step = () => {
      const chunk = segments[i];
      accRef.current += chunk;
      setDisplayed(accRef.current);
      const next = i + 1;
      setCount(next);
      if (next >= n) {
        // Fire-and-clear so onDone runs exactly once per animation.
        const listeners = doneListenersRef.current;
        doneListenersRef.current = [];
        for (const cb of listeners) {
          try { cb(); } catch {}
        }
        return;
      }
      i = next;
      const delay = stepDelay(chunk, cpsActive, minDelay, maxDelay);
      timerRef.current = setTimeout(step, delay);
    };

    timerRef.current = setTimeout(step, initialDelay);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Clear callbacks when the animation ends / component unmounts so no
      // stale listener can fire later.
      doneListenersRef.current = [];
    };
  }, [segments, active, cpsActive, minDelay, maxDelay, initialDelay, text]);

  const done = !text || !active || count >= segments.length;

  return {
    displayed: active ? displayed : text,
    isTyping: active && !done,
    done,
    progress: done || !segments.length ? 1 : Math.min(1, count / segments.length),
    /** Register a callback fired once when this reveal completes. */
    onDone(cb) {
      const arr = doneListenersRef.current;
      if (typeof cb === "function" && !arr.includes(cb)) arr.push(cb);
    },
  };
}
