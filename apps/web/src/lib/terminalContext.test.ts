import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendTerminalContextsToPrompt,
  buildTerminalContextPreviewTitle,
  buildTerminalContextBlock,
  countInlineTerminalContextPlaceholders,
  deriveDisplayedUserMessageState,
  ensureInlineTerminalContextPlaceholders,
  extractTrailingTerminalContexts,
  filterTerminalContextsWithText,
  formatInlineTerminalContextLabel,
  formatTerminalContextLabel,
  hasTerminalContextText,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  isTerminalContextExpired,
  materializeInlineTerminalContextPrompt,
  removeInlineTerminalContextPlaceholder,
  stripInlineTerminalContextPlaceholders,
  TERMINAL_CONTEXT_MAX_CHARS_PER_SELECTION,
  TERMINAL_CONTEXT_MAX_TOTAL_CHARS,
  type TerminalContextDraft,
} from "./terminalContext";

function makeContext(overrides?: Partial<TerminalContextDraft>): TerminalContextDraft {
  return {
    id: "context-1",
    threadId: ThreadId.make("thread-1"),
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 12,
    lineEnd: 13,
    text: "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("terminalContext", () => {
  it("formats terminal labels with line ranges", () => {
    expect(formatTerminalContextLabel(makeContext())).toBe("Terminal 1 lines 12-13");
    expect(
      formatTerminalContextLabel(
        makeContext({
          lineStart: 9,
          lineEnd: 9,
        }),
      ),
    ).toBe("Terminal 1 line 9");
  });

  it("builds a numbered terminal context block", () => {
    expect(buildTerminalContextBlock([makeContext()])).toBe(
      [
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("appends terminal context blocks after prompt text", () => {
    expect(appendTerminalContextsToPrompt("Investigate this", [makeContext()])).toBe(
      [
        "Investigate this",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("replaces inline placeholders with inline terminal labels before appending context blocks", () => {
    expect(
      appendTerminalContextsToPrompt(
        `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
        [makeContext()],
      ),
    ).toBe(
      [
        "Investigate @terminal-1:12-13 carefully",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("extracts terminal context blocks from message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(extractTrailingTerminalContexts(prompt)).toEqual({
      promptText: "Investigate this",
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
    });
  });

  it("derives displayed user message state from terminal context prompts", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(deriveDisplayedUserMessageState(prompt)).toEqual({
      visibleText: "Investigate this",
      copyText: prompt,
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
      elementContexts: [],
    });
  });

  it("preserves prompt text when no trailing terminal context block exists", () => {
    expect(extractTrailingTerminalContexts("No attached context")).toEqual({
      promptText: "No attached context",
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    });
  });

  it("returns null preview title when every context is invalid", () => {
    expect(
      buildTerminalContextPreviewTitle([
        makeContext({
          terminalId: "   ",
        }),
        makeContext({
          id: "context-2",
          text: "\n\n",
        }),
      ]),
    ).toBeNull();
  });

  it("tracks inline terminal context placeholders in prompt text", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(countInlineTerminalContextPlaceholders(`a${placeholder}b${placeholder}`)).toBe(2);
    expect(ensureInlineTerminalContextPlaceholders("Investigate this", 2)).toBe(
      `${placeholder}${placeholder}Investigate this`,
    );
    expect(insertInlineTerminalContextPlaceholder("abc", 1)).toEqual({
      prompt: `a ${placeholder} bc`,
      cursor: 4,
      contextIndex: 0,
    });
    expect(removeInlineTerminalContextPlaceholder(`a${placeholder}b${placeholder}c`, 1)).toEqual({
      prompt: `a${placeholder}bc`,
      cursor: 3,
    });
    expect(stripInlineTerminalContextPlaceholders(`a${placeholder}b`)).toBe("ab");
  });

  it("inserts a placeholder after a file mention when given the expanded prompt cursor", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(insertInlineTerminalContextPlaceholder("Inspect @package.json ", 22)).toEqual({
      prompt: `Inspect @package.json ${placeholder} `,
      cursor: 24,
      contextIndex: 0,
    });
  });

  it("adds a trailing space and consumes an existing trailing space at the insertion point", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(insertInlineTerminalContextPlaceholder("yo whats", 3)).toEqual({
      prompt: `yo ${placeholder} whats`,
      cursor: 5,
      contextIndex: 0,
    });
  });

  it("marks contexts without snapshot text as expired and filters them from sendable contexts", () => {
    const liveContext = makeContext();
    const expiredContext = makeContext({
      id: "context-2",
      text: "",
    });

    expect(hasTerminalContextText(liveContext)).toBe(true);
    expect(isTerminalContextExpired(liveContext)).toBe(false);
    expect(hasTerminalContextText(expiredContext)).toBe(false);
    expect(isTerminalContextExpired(expiredContext)).toBe(true);
    expect(filterTerminalContextsWithText([expiredContext, liveContext])).toEqual([liveContext]);
  });

  it("formats and materializes inline terminal labels from placeholder positions", () => {
    expect(formatInlineTerminalContextLabel(makeContext())).toBe("@terminal-1:12-13");
    expect(
      materializeInlineTerminalContextPrompt(
        `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
        [makeContext()],
      ),
    ).toBe("Investigate @terminal-1:12-13 carefully");
  });
});

describe("the terminal block is bounded, and says so (#72)", () => {
  // Scoped to the pure builder on purpose: per #74 `apps/web` has no jsdom, so
  // nothing here asserts anything about how the block RENDERS. The bug lives
  // in the string that goes on the wire, which is what these exercise.

  function hugeSelection(lines: number, lineWidth = 80): TerminalContextDraft {
    return makeContext({
      lineStart: 1,
      lineEnd: lines,
      text: Array.from({ length: lines }, (_, i) => `${"x".repeat(lineWidth)}#${i}`).join("\n"),
    });
  }

  it("bounds one oversized selection that would otherwise blow the send limit", () => {
    // 5,000 x ~80 chars ≈ 400 KB raw, and the old builder ADDED a "  N | "
    // prefix per line on top of that — over three times the 120,000-char
    // provider cap from one ordinary drag-select.
    const block = buildTerminalContextBlock([hugeSelection(5_000)]);

    // Asserted against the PROVIDER's limit, deliberately not against this
    // module's own constant: a bound stated in terms of the thing it bounds
    // passes trivially when that constant is raised, which is exactly how a
    // cap regression would slip through.
    expect(block.length).toBeLessThan(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(block.length).toBeLessThan(30_000);
    expect(block).toContain("<terminal_context>");
    expect(block).toContain("</terminal_context>");
  });

  it("says how many lines it dropped rather than truncating silently", () => {
    const block = buildTerminalContextBlock([hugeSelection(5_000)]);

    expect(block).toMatch(/\(\d+ earlier lines omitted — selection too large to attach in full\)/);
  });

  it("keeps the tail, where a failure actually is", () => {
    const block = buildTerminalContextBlock([hugeSelection(5_000)]);

    expect(block).toContain("#4999");
    expect(block).not.toContain("#0\n");
  });

  it("leaves a selection that fits completely untouched, with no notice", () => {
    const block = buildTerminalContextBlock([makeContext()]);

    expect(block).toContain("git status");
    expect(block).toContain("On branch main");
    expect(block).not.toContain("omitted");
    expect(block).not.toContain("not shown");
  });

  it("bounds the whole block when many selections are attached, not just each one", () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => hugeSelection(2_000) as TerminalContextDraft,
    ).map((c, i) => ({ ...c, id: `context-${i}`, terminalLabel: `Terminal ${i}` }));

    const block = buildTerminalContextBlock(many);

    expect(block.length).toBeLessThan(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(block.length).toBeLessThan(30_000);
    expect(block).toMatch(
      /\(\+\d+ more terminal selections not shown — attachment limit reached\)/,
    );
  });

  it("still attaches the first selection even when it alone fills the budget", () => {
    // Attaching nothing would be a silent drop of the thing the user picked.
    const block = buildTerminalContextBlock([hugeSelection(5_000), hugeSelection(5_000)]);

    expect(block).toContain("Terminal 1");
    expect(block.split("\n").some((l) => l.includes(" | "))).toBe(true);
  });

  it("keeps one line rather than none when a single line exceeds the budget", () => {
    // Minified output or a base64 blob: one line can beat the whole cap.
    const oneHugeLine = makeContext({
      lineStart: 1,
      lineEnd: 1,
      text: "y".repeat(TERMINAL_CONTEXT_MAX_CHARS_PER_SELECTION * 3),
    });

    const block = buildTerminalContextBlock([oneHugeLine]);

    expect(block).toContain("yyy");
    expect(block).toContain("…");
    expect(block.length).toBeLessThan(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(block.length).toBeLessThan(30_000);
  });

  it("the truncation notice survives the transcript round-trip", () => {
    // An unindented notice is silently discarded by parseTerminalContextEntries,
    // so the user would see a shortened body with no sign it was shortened.
    const prompt = appendTerminalContextsToPrompt("what went wrong", [hugeSelection(5_000)]);
    const extracted = extractTrailingTerminalContexts(prompt);

    expect(extracted.contexts).toHaveLength(1);
    expect(extracted.contexts[0]!.body).toContain("earlier lines omitted");
  });
});
