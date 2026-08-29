/**
 * modules/ai-assistant/useTypewriter.js
 * -------------------------------------
 * Reusable progressive-typing hook for assistant responses (ChatGPT-style).
 *
 * Pure UI concern: a single response bubble reveals its content
 * word-by-word, buffering at safe word/whitespace boundaries so Markdown
 * (code fences, links, bold, lists) is never cut mid-token.  Pacing adapts
 * to response length — short answers animate quickly, long answers run at a
 * smooth steady clip.
 *
 * Guarantees:
 *  - single animation per instance (index advances monotonically),
 *  - zero dropped characters (reveals a prefix of the token stream),
 *  - `active: false` snaps to the complete text (used when a newer message
 *    supersedes the one being typed — never two animations at once),
 *  - all DOM writes happen through the returned `displayed` string so the
 *    consumer keeps full control of rendering.
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
 * whole words.
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
  minDelay: 20,
  maxDelay: 160,
  targetMs: 4500,
  longTextTargetMs: 9500,
};

const LONG_TEXT_CHARS = 600;
const SHORT_TEXT_CHARS = 140;

export function wordsPerChunkFor(textLength) {
  if (textLength < SHORT_TEXT_CHARS) return 1;
  if (textLength < LONG_TEXT_CHARS) return 2;
  return 6;
}

/**
 * @param {string} fullText complete assistant response (Markdown source)
 * @param {{active?: boolean, minDelay?: number, maxDelay?: number, targetMs?: number}} [options]
 * @returns {{displayed: string, isTyping: boolean, done: boolean, progress: number, onDone: (cb) => void}}
 */
export function useTypewriter(fullText, options = {}) {
  const {
    active = TYPEWRITER_OPTIONS.active,
    minDelay = TYPEWRITER_OPTIONS.minDelay,
    maxDelay = TYPEWRITER_OPTIONS.maxDelay,
    targetMs = TYPEWRITER_OPTIONS.targetMs,
    longTextTargetMs = TYPEWRITER_OPTIONS.longTextTargetMs,
  } = options;

  const text = fullText || "";
  const tokens = useMemo(() => tokenizeText(text), [text]);
  const perChunkRaw = useMemo(() => wordsPerChunkFor(text.length), [text.length]);
  const chunks = useMemo(
    () => chunkTokens(tokens, perChunkRaw),
    [tokens, perChunkRaw]
  );
  const [index, setIndex] = useState(0);
  const timersRef = useRef([]);
  const doneListenersRef = useRef([]);

  useEffect(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setIndex(0);

    if (!active || chunks.length === 0) return;

    const long = text.length >= LONG_TEXT_CHARS;
    const budget = long ? longTextTargetMs : targetMs;
    const per = Math.max(minDelay, Math.min(maxDelay, Math.round(budget / chunks.length)));

    let i = 0;
    const step = () => {
      i += 1;
      setIndex(i);
      if (i >= chunks.length) {
        for (const cb of doneListenersRef.current) {
          try { cb(); } catch {}
        }
        return;
      }
      // Pause a touch longer around fenced code / inline-code boundaries so
      // blocks assemble cleanly instead of flickering open.
      const justRevealed = chunks[i - 1] || "";
      const aroundFence =
        /[`]/.test(justRevealed) || /^```/.test(chunks[i]) ? 1.9 : 1;
      const jitter = 0.75 + Math.random() * 0.5;
      timersRef.current.push(
        setTimeout(step, Math.round(per * aroundFence * jitter))
      );
    };

    timersRef.current.push(setTimeout(step, 260));
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, [chunks, active, minDelay, maxDelay, targetMs, longTextTargetMs, text.length]);

  const done = !text || !active || index >= chunks.length;

  return {
    displayed: active ? chunks.slice(0, index).join("") : text,
    isTyping: active && !done,
    done,
    progress: chunks.length ? Math.min(1, index / chunks.length) : 1,
    /** Register a callback fired once (and only once) the reveal completes. */
    onDone(cb) {
      doneListenersRef.current.push(cb);
    },
  };
}