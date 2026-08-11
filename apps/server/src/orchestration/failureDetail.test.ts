import { describe, expect, it } from "vite-plus/test";

import {
  boundFailureDetail,
  FAILURE_DETAIL_MAX_CHARS,
  sanitizeFailureDetail,
  stripAbsolutePaths,
} from "./failureDetail.ts";

describe("boundFailureDetail", () => {
  it("returns short details untouched", () => {
    const detail = "Provider validation failed: no active session.";
    expect(boundFailureDetail(detail)).toBe(detail);
  });

  it("returns an exactly-at-budget detail untouched", () => {
    const detail = "x".repeat(FAILURE_DETAIL_MAX_CHARS);
    expect(boundFailureDetail(detail)).toBe(detail);
  });

  it("bounds an oversized detail to the budget", () => {
    const detail = "x".repeat(200_000);
    const bounded = boundFailureDetail(detail);
    expect(bounded.length).toBeLessThanOrEqual(FAILURE_DETAIL_MAX_CHARS);
    // The whole point: the result must not scale with the input.
    expect(bounded.length).toBeLessThan(detail.length / 50);
  });

  it("states what it dropped instead of truncating silently", () => {
    const detail = "x".repeat(200_000);
    const bounded = boundFailureDetail(detail);
    expect(bounded).toContain("characters omitted");
    expect(bounded).toContain("200000 characters");
    expect(bounded).toContain("preserved on the user message");
  });

  it("keeps BOTH ends, so the error class and the throwing frame both survive", () => {
    const detail = `HEAD_MARKER${"x".repeat(200_000)}TAIL_MARKER`;
    const bounded = boundFailureDetail(detail);
    expect(bounded.startsWith("HEAD_MARKER")).toBe(true);
    expect(bounded.endsWith("TAIL_MARKER")).toBe(true);
  });
});

describe("stripAbsolutePaths", () => {
  it("rewrites a workspace stack frame to a repo-relative path", () => {
    const detail =
      "at processTurn (/Users/someone/Projects/t3code-fork/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1264:37)";
    const stripped = stripAbsolutePaths(detail);
    expect(stripped).toContain("apps/server/src/orchestration/Layers/ProviderCommandReactor.ts");
    expect(stripped).not.toContain("/Users/someone");
    expect(stripped).not.toContain("Projects/t3code-fork");
    // The line:column that makes the frame useful must survive.
    expect(stripped).toContain(":1264:37");
  });

  it("rewrites node_modules frames the same way", () => {
    const stripped = stripAbsolutePaths("(/home/ci/checkout/node_modules/effect/dist/x.js:1:2)");
    expect(stripped).toContain("node_modules/effect/dist/x.js:1:2");
    expect(stripped).not.toContain("/home/ci");
  });

  it("reduces a home directory outside the workspace to ~", () => {
    const stripped = stripAbsolutePaths("failed reading /Users/someone/.config/thing.json");
    expect(stripped).toBe("failed reading ~/.config/thing.json");
  });

  it("leaves relative paths alone, so file-change details stay readable", () => {
    const detail = "edit src/components/Chat.tsx and ./scripts/run.sh";
    expect(stripAbsolutePaths(detail)).toBe(detail);
  });
});

describe("sanitizeFailureDetail", () => {
  it("bounds and scrubs the real amplification shape (task #76)", () => {
    // The shape probe A captured: the formatter embeds the whole payload,
    // Cause.pretty appends an absolute-path stack frame.
    const payload = "A".repeat(130_000);
    const detail =
      `ProviderValidationError: Provider validation failed in ProviderService.sendTurn: ` +
      `Expected a value with a length of at most 120000, got "${payload}"\n` +
      `    at sendTurn (/Users/someone/Projects/t3code-fork/apps/server/src/provider/Layers/ProviderService.ts:646:21)`;

    const sanitized = sanitizeFailureDetail(detail);

    expect(sanitized.length).toBeLessThanOrEqual(FAILURE_DETAIL_MAX_CHARS);
    // The diagnosis survives.
    expect(sanitized).toContain("Expected a value with a length of at most 120000");
    // The payload does not.
    expect(sanitized).not.toContain("A".repeat(2_000));
    // Neither does the server's filesystem layout.
    expect(sanitized).not.toContain("/Users/someone");
    expect(sanitized).toContain("apps/server/src/provider/Layers/ProviderService.ts:646:21");
  });

  it("stays linear on a pathological slash-heavy payload", () => {
    // This function runs over strings that embed a rejected user payload, so
    // an ambiguous path regex here would be a denial of service on the main
    // event loop rather than a mere slowdown. Guards the segment class in
    // WORKSPACE_PATH_PREFIX against regaining `/`.
    //
    // The explicit timeout IS the assertion for backtracking: a catastrophic
    // regex does not merely run slowly on this input, it does not finish.
    // Wall-clock arithmetic would be both flaky and banned here (time goes
    // through Effect's Clock), so the timeout carries that check instead.
    const pathological = `${"/aaaaaaaaaaaaaaaa".repeat(4_000)}!`;
    expect(sanitizeFailureDetail(pathological).length).toBeLessThanOrEqual(
      FAILURE_DETAIL_MAX_CHARS,
    );
  }, 5_000);

  it("never leaves a half-scrubbed absolute path at the truncation boundary", () => {
    // A path sitting exactly where the head would be cut: paths are stripped
    // before bounding, so no partial "/Users/someo…" can survive.
    const detail = `${"x".repeat(1_390)}/Users/someone/Projects/repo/apps/server/src/a.ts:1:1${"y".repeat(50_000)}`;
    const sanitized = sanitizeFailureDetail(detail);
    expect(sanitized).not.toContain("/Users");
  });
});
