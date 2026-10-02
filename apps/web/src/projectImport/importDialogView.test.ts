import {
  ProjectId,
  type MrMakImportApplySuccess,
  type MrMakImportPlanSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { importPairKey, resolveImportDialogView, type ImportDialogState } from "./importDialogView";

const MRMAK = ProjectId.make("project-mrmak");
const OTHER_SOURCE = ProjectId.make("project-other");
const COMPARISON = ProjectId.make("project-comparison");

const summary = (overrides: Partial<MrMakImportPlanSummary> = {}): MrMakImportPlanSummary => ({
  planId: "plan-1",
  source: {
    path: "/projects/mr-mak",
    revision: "6248c9ec0123456789",
    branch: "main",
    dirtyPaths: ["src/app.ts"],
  },
  destination: { path: "/projects/comparison", kind: "empty" },
  roots: ["workspace", "docs", ".agents/skills"],
  totals: {
    files: 12,
    bytes: 3 * 1024 * 1024,
    new: 9,
    existsIdentical: 1,
    existsDifferent: 2,
    exclusions: 4,
    issues: 0,
  },
  conflicts: [
    { path: "docs/readme.md", reason: "A different file is already at the destination." },
    { path: "workspace/workspace.json", reason: "A different file is already at the destination." },
  ],
  skills: [
    { name: "alpha", files: 3, conflict: true },
    { name: "beta", files: 2, conflict: false },
  ],
  skillFiles: { fullTreeFiles: 5, distributionFiles: 4 },
  exclusions: [
    { path: ".git", rule: "vcs", reason: "Version control." },
    { path: "node_modules", rule: "dependencies", reason: "Installed dependencies." },
    { path: ".env", rule: "secret", reason: "Credentials." },
    { path: "workspace/.cache", rule: "cache", reason: "Cache." },
  ],
  requirements: [{ source: ".mcp.json", kind: "mcp-server", name: "fal", keys: ["FAL_KEY"] }],
  issues: [],
  excludedStores: [{ name: "Chat history", reason: "Stays in Mr. Mak." }],
  ...overrides,
});

const reviewed = (
  plan: MrMakImportPlanSummary,
  overrides: Partial<ImportDialogState> = {},
): ImportDialogState => ({
  sourceProjectId: MRMAK,
  destinationProjectId: COMPARISON,
  dryRun: {
    status: "done",
    pairKey: importPairKey(MRMAK, COMPARISON),
    outcome: { _tag: "ok", value: plan },
  },
  choices: {},
  skillChoices: {},
  confirmExistingProject: false,
  apply: null,
  ...overrides,
});

const allChosen = {
  choices: { "docs/readme.md": "take-source", "workspace/workspace.json": "keep-destination" },
  skillChoices: { alpha: "import-renamed" },
} as const;

describe("resolveImportDialogView", () => {
  it("needs a source other than the destination before a dry run", () => {
    const base = reviewed(summary(), { dryRun: null });
    expect(resolveImportDialogView({ ...base, sourceProjectId: null }).dryRunBlockedReason).toBe(
      "Choose the Mr. Mak project to import from.",
    );
    expect(
      resolveImportDialogView({ ...base, sourceProjectId: COMPARISON }).dryRunBlockedReason,
    ).toMatch(/never writes into its source/);
    const view = resolveImportDialogView(base);
    expect([view.dryRunBlockedReason, view.applyBlockedReason]).toEqual([
      null,
      "Run the dry run first and review what it would import.",
    ]);
  });

  it("summarizes counts, exclusions by rule and requirements, with skill conflicts listed apart", () => {
    const view = resolveImportDialogView(reviewed(summary()));
    expect(view.plan?.counts).toEqual([
      { label: "Files", value: "12" },
      { label: "Size", value: "3.0 MB" },
      { label: "New", value: "9" },
      { label: "Already identical", value: "1" },
      { label: "Conflicts", value: "3" },
      { label: "Skills", value: "2" },
      { label: "Excluded", value: "4" },
      { label: "Issues", value: "0" },
    ]);
    // Exclusions are listed and never become copy or conflict rows.
    expect(view.plan?.exclusions.map((group) => [group.label, group.examples])).toEqual([
      ["Version control", [".git"]],
      ["Dependencies", ["node_modules"]],
      ["Secrets and credentials", [".env"]],
      ["Caches", ["workspace/.cache"]],
    ]);
    expect(view.plan?.conflicts.map((conflict) => conflict.path)).toEqual([
      "docs/readme.md",
      "workspace/workspace.json",
    ]);
    expect(view.plan?.skillConflicts).toEqual([
      { name: "alpha", files: 3, choice: null, renamedTo: "alpha-mrmak" },
    ]);
    expect(view.plan?.requirements).toEqual(["fal (mcp-server, from .mcp.json): FAL_KEY"]);
    expect(view.plan?.source).toEqual({
      path: "/projects/mr-mak",
      revision: "6248c9ec0123",
      branch: "main",
      dirtyCount: 1,
    });
  });

  it("blocks Apply until every file and skill conflict has a choice, then sends exactly those", () => {
    const partly = resolveImportDialogView(
      reviewed(summary(), { choices: { "docs/readme.md": "take-source" } }),
    );
    expect([partly.applyBlockedReason, partly.applyRequest]).toEqual([
      "Choose what to do with 2 conflicts first.",
      null,
    ]);

    const ready = resolveImportDialogView(
      reviewed(summary(), {
        ...allChosen,
        // A choice left over from an earlier plan is not sent.
        choices: { ...allChosen.choices, "docs/old.md": "take-source" },
      }),
    );
    expect(ready.applyBlockedReason).toBeNull();
    expect(ready.applyRequest).toEqual({
      sourceProjectId: MRMAK,
      destinationProjectId: COMPARISON,
      planId: "plan-1",
      choices: allChosen.choices,
      skillChoices: [{ skill: "alpha", action: "import-renamed" }],
      confirmExistingProject: false,
    });
  });

  it("asks for confirmation before importing into an existing project", () => {
    const existing = summary({ destination: { path: "/projects/game", kind: "existing" } });
    const unconfirmed = resolveImportDialogView(reviewed(existing, allChosen));
    expect(unconfirmed.plan?.destination.warning).toMatch(/already has its own files/);
    expect(unconfirmed.applyRequest).toBeNull();
    const confirmed = resolveImportDialogView(
      reviewed(existing, { ...allChosen, confirmExistingProject: true }),
    );
    expect(confirmed.applyRequest?.confirmExistingProject).toBe(true);
  });

  it("drops a dry run once the source changes or a new one is running", () => {
    const switched = resolveImportDialogView(
      reviewed(summary(), { ...allChosen, sourceProjectId: OTHER_SOURCE }),
    );
    expect([switched.plan, switched.applyRequest]).toEqual([null, null]);

    const rerunning = resolveImportDialogView(
      reviewed(summary(), {
        ...allChosen,
        dryRun: { status: "running", pairKey: importPairKey(MRMAK, COMPARISON) },
      }),
    );
    expect([rerunning.plan, rerunning.applyBlockedReason]).toEqual([null, "Running the dry run…"]);
  });

  it("says when there is nothing to import", () => {
    const empty = summary({
      totals: { ...summary().totals, files: 0, new: 0, existsIdentical: 0, existsDifferent: 0 },
      conflicts: [],
      skills: [],
    });
    const view = resolveImportDialogView(reviewed(empty));
    expect([view.plan?.nothingToImport, view.applyBlockedReason]).toEqual([
      true,
      "Nothing to import: the plan lists no files.",
    ]);
  });

  it("shows the receipt once, then never offers Apply again for that plan", () => {
    const applied: MrMakImportApplySuccess = {
      status: "imported",
      receiptPath: ".devgame/import/receipt.json",
      commit: { status: "committed", detail: null },
      receipt: {
        importId: "import-1",
        previousImportId: null,
        source: {
          repositoryPath: "/projects/mr-mak",
          revision: "6248c9ec0123456789",
          branch: "main",
        },
        completedAt: "2026-10-03T10:00:00.000Z",
        outcomes: {
          written: 9,
          identical: 1,
          updated: 0,
          replaced: 1,
          "kept-local": 0,
          conflict: 1,
        },
        conflicts: [
          {
            path: "workspace/workspace.json",
            reason: "A different file is already at the destination.",
          },
        ],
        changes: { added: 0, modified: 0, removed: 0 },
        exclusions: 4,
        transforms: [],
        skills: {
          skills: [
            {
              original: "alpha",
              active: "alpha-mrmak",
              action: "renamed",
              files: 3,
              distributionFiles: 3,
              requirements: [],
            },
          ],
          verified: true,
        },
      },
    };
    const view = resolveImportDialogView(
      reviewed(summary(), {
        ...allChosen,
        apply: { status: "done", planId: "plan-1", outcome: { _tag: "ok", value: applied } },
      }),
    );
    expect(view.receipt).toMatchObject({
      headline: "Imported 6248c9ec0123 from /projects/mr-mak.",
      importId: "import-1",
      rows: [
        { label: "Copied", value: 9 },
        { label: "Already identical", value: 1 },
        { label: "Replaced with the source's copy", value: 1 },
        { label: "Left as they were (conflicts)", value: 1 },
      ],
      commit: "Committed as the comparison baseline.",
      skills: ["alpha imported as alpha-mrmak"],
    });
    expect([view.applyBlockedReason, view.applyRequest]).toEqual([
      "Imported. Run the dry run again to import later changes.",
      null,
    ]);

    const refused = resolveImportDialogView(
      reviewed(summary(), {
        ...allChosen,
        apply: {
          status: "done",
          planId: "plan-1",
          outcome: {
            _tag: "refused",
            message: "The source or destination changed since the dry run.",
          },
        },
      }),
    );
    expect([refused.receipt, refused.applyError]).toEqual([
      null,
      "The source or destination changed since the dry run.",
    ]);
    const notPermitted = resolveImportDialogView(
      reviewed(summary(), {
        ...allChosen,
        apply: { status: "done", planId: "plan-1", outcome: { _tag: "notPermitted" } },
      }),
    );
    expect(notPermitted.applyError).toMatch(/may not write project files/);
  });
});
