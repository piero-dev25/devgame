import { describe, expect, it } from "vite-plus/test";
import {
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  getDiffLineStat,
  getRenderablePatch,
  isPatchTruncated,
} from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("getRenderablePatch", () => {
  it("compacts partial hunk render offsets for virtualized review diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "index 1111111..2222222 100644",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,4 +48,4 @@",
      " context",
      "-before",
      "+after",
      " context",
      " context",
      "@@ -80,3 +80,4 @@",
      " context",
      "+added",
      " context",
      " context",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "review", {
      compactPartialHunkOffsets: true,
    });
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file?.hunks[0]?.collapsedBefore).toBe(47);
    expect(file?.hunks[0]?.unifiedLineStart).toBe(0);
    expect(file?.hunks[1]?.collapsedBefore).toBeGreaterThan(0);
    expect(file?.hunks[1]?.unifiedLineStart).toBe(file?.hunks[0]?.unifiedLineCount);
    expect(file?.unifiedLineCount).toBe(
      file?.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0),
    );
  });

  it("retains source-file offsets for checkpoint diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,1 +48,1 @@",
      "-before",
      "+after",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "checkpoint");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(parsed.files[0]?.hunks[0]?.unifiedLineStart).toBe(47);
  });
});

describe("isPatchTruncated", () => {
  it("is true for a turn diff whose result reports truncated", () => {
    expect(
      isPatchTruncated({
        isTurnDiff: true,
        turnDiffTruncated: true,
        gitSourceTruncated: undefined,
      }),
    ).toBe(true);
  });

  it("is false for a turn diff whose result reports not truncated", () => {
    expect(
      isPatchTruncated({
        isTurnDiff: true,
        turnDiffTruncated: false,
        gitSourceTruncated: undefined,
      }),
    ).toBe(false);
  });

  it("is false for a turn diff that hasn't loaded yet", () => {
    expect(
      isPatchTruncated({
        isTurnDiff: true,
        turnDiffTruncated: undefined,
        gitSourceTruncated: undefined,
      }),
    ).toBe(false);
  });

  it("reads the git-source flag, not the turn flag, for a working-tree/branch diff", () => {
    expect(
      isPatchTruncated({
        isTurnDiff: false,
        turnDiffTruncated: undefined,
        gitSourceTruncated: true,
      }),
    ).toBe(true);
    expect(
      isPatchTruncated({
        isTurnDiff: false,
        turnDiffTruncated: true,
        gitSourceTruncated: false,
      }),
    ).toBe(false);
  });

  it("regression: disagrees with the old '!selectedTurn && source?.truncated' condition on a truncated turn diff", () => {
    // This is the exact bug (task #66): DiffPanel.tsx used to compute
    // `!selectedTurn && selectedGitSource?.truncated === true` directly,
    // which is FALSE for every turn diff no matter what the server
    // returned, because `!selectedTurn` alone already forces it to false.
    // A turn diff genuinely truncated at CHECKPOINT_DIFF_MAX_OUTPUT_BYTES
    // showed no banner and no way to tell. Reproduce that exact
    // expression here so this test only passes if the new function
    // actually disagrees with it for this case.
    const isTurnDiff = true;
    const turnDiffTruncated = true;
    const gitSourceTruncated: boolean | undefined = undefined;

    const oldBuggyResult = !isTurnDiff && gitSourceTruncated === true;
    const fixedResult = isPatchTruncated({ isTurnDiff, turnDiffTruncated, gitSourceTruncated });

    expect(oldBuggyResult).toBe(false);
    expect(fixedResult).toBe(true);
    expect(fixedResult).not.toBe(oldBuggyResult);
  });
});

describe("buildFileDiffRenderKey", () => {
  it("keeps file identity stable when Pierre hydrates a partial diff", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");
    const parsed = getRenderablePatch(patch, "hydrated-key");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file).toBeDefined();
    if (!file) return;
    const key = buildFileDiffRenderKey(file);
    file.cacheKey = `${file.cacheKey}:hydrated`;

    expect(buildFileDiffRenderKey(file)).toBe(key);
  });
});

describe("getDiffLineStat", () => {
  it("totals additions and deletions across every file and hunk", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1,2 +1,3 @@",
      "-before",
      "+after",
      "+added",
      " context",
      "@@ -10,2 +11,1 @@",
      "-removed",
      " context",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " title",
      "+description",
    ].join("\n");

    const parsed = getRenderablePatch(patch);
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    expect(getDiffLineStat(parsed.files)).toEqual({ additions: 3, deletions: 2 });
  });
});
