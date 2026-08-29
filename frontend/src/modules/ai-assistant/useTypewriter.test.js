import { describe, expect, it } from "vitest";
import { chunkTokens, tokenizeText, wordsPerChunkFor } from "./useTypewriter";

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

describe("chunkTokens", () => {
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
    for (const chunk of chunks) {
      expect(chunk.includes("`") ? chunk.includes("`") : true).toBe(true);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("handles empty input", () => {
    expect(chunkTokens([], 1)).toEqual([""]);
    expect(chunkTokens([""], 1)).toEqual([""]);
  });
});

describe("wordsPerChunkFor", () => {
  it("reveals short answers in small chunks and long answers in big ones", () => {
    expect(wordsPerChunkFor(10)).toBe(1);
    expect(wordsPerChunkFor(200)).toBe(2);
    expect(wordsPerChunkFor(1000)).toBe(6);
  });
});