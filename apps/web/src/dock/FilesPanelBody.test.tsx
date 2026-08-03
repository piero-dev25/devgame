import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { FilesPanelFileView, FilesPanelView } from "./FilesPanel.logic";
import { FilesPanelBody } from "./FilesPanelBody";

// The banned words. This is the whole design decision from spec-files-panel.md:
// the real data (`{path, insertions, deletions}`) has no porcelain status
// code, so a delete and a delete-only edit are byte-identical — the panel
// must never claim to know which one happened. See FilesPanel.logic.ts's
// module doc.
const FABRICATED_STATUS_WORDS = ["Added", "Modified", "Deleted"];

function filesView(files: FilesPanelFileView[]): FilesPanelView {
  return {
    kind: "files",
    refName: "main",
    files,
    totalInsertions: files.reduce((sum, f) => sum + f.insertions, 0),
    totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
}

describe("FilesPanelBody — per-file stat rendering (acceptance check 2)", () => {
  it("renders a real +N/-M stat for a file with a non-zero diff", () => {
    const markup = renderToStaticMarkup(
      <FilesPanelBody view={filesView([{ path: "physics.js", insertions: 1, deletions: 0 }])} />,
    );
    expect(markup).toContain("physics.js");
    expect(markup).toContain("+1");
    expect(markup).toContain("-0");
    expect(markup).not.toContain("no diff stat");
  });

  it('renders the honest no-diff-stat label — never a per-row "+0/-0" — for the untracked/status-only zero/zero shape', () => {
    // This is exactly the shape apps/server/src/vcs/GitVcsDriverCore.ts folds
    // in for an untracked file: git diff HEAD --numstat never sees it, so
    // the status --porcelain fallback adds it as {insertions: 0, deletions: 0}.
    const markup = renderToStaticMarkup(
      <FilesPanelBody
        view={filesView([{ path: "scratch-note.txt", insertions: 0, deletions: 0 }])}
      />,
    );
    expect(markup).toContain("scratch-note.txt");
    expect(markup).toContain("no diff stat");
    // Scoped to the per-row stat markup specifically, not a bare "+0"/"-0"
    // substring — the header's own AGGREGATE total ("1 file · +0 / -0") is
    // legitimately accurate plain text when the only file present is
    // zero-stat, and a naive substring check would false-positive on it.
    // `text-success">+0` and `text-destructive">-0` can only come from
    // FileRow's stat-bearing branch, which this file must never take.
    expect(markup).not.toContain('text-success">+0');
    expect(markup).not.toContain('text-destructive">-0');
  });

  it("renders a real, non-fabricated stat for a delete-shaped file (insertions:0, deletions>0) — not the no-diff-stat label", () => {
    // throwaway.txt from the live check: a committed 3-line file, deleted.
    // git diff HEAD --numstat reports it as 0 insertions / 3 deletions —
    // a REAL stat, distinct from the untracked zero/zero fallback above,
    // even though the panel cannot say "deleted" (see the next describe
    // block) because the same shape also describes an edit that only
    // removes 3 lines.
    const markup = renderToStaticMarkup(
      <FilesPanelBody view={filesView([{ path: "throwaway.txt", insertions: 0, deletions: 3 }])} />,
    );
    expect(markup).toContain("throwaway.txt");
    expect(markup).toContain("+0");
    expect(markup).toContain("-3");
    expect(markup).not.toContain("no diff stat");
  });
});

describe("FilesPanelBody — never fabricates a status verb (acceptance check 2's core guarantee)", () => {
  // Every FilesPanelView kind, including shapes specifically chosen to tempt
  // a "helpful" label: an add-only file, a delete-only file (byte-identical
  // to a delete-only EDIT, per FilesPanel.logic.ts), a zero/zero untracked
  // file, and a multi-file mix of all three at once.
  const scenarios: { name: string; view: FilesPanelView }[] = [
    { name: "waiting-for-project", view: { kind: "waiting-for-project" } },
    { name: "error", view: { kind: "error", message: "fatal: not a git repository" } },
    { name: "loading", view: { kind: "loading" } },
    { name: "not-a-repo", view: { kind: "not-a-repo", cwd: "/tmp/not-a-repo" } },
    { name: "clean", view: { kind: "clean", refName: "main" } },
    {
      name: "files — add-only stat",
      view: filesView([{ path: "new.ts", insertions: 5, deletions: 0 }]),
    },
    {
      name: "files — delete-only stat (the byte-identical-to-a-delete case)",
      view: filesView([{ path: "throwaway.txt", insertions: 0, deletions: 3 }]),
    },
    {
      name: "files — untracked zero/zero fallback",
      view: filesView([{ path: "scratch-note.txt", insertions: 0, deletions: 0 }]),
    },
    {
      name: "files — mixed add/delete/untracked in one list",
      view: filesView([
        { path: "physics.js", insertions: 1, deletions: 0 },
        { path: "throwaway.txt", insertions: 0, deletions: 3 },
        { path: "scratch-note.txt", insertions: 0, deletions: 0 },
      ]),
    },
  ];

  for (const { name, view } of scenarios) {
    it(`never emits "Added", "Modified", or "Deleted" — ${name}`, () => {
      const markup = renderToStaticMarkup(<FilesPanelBody view={view} />);
      for (const word of FABRICATED_STATUS_WORDS) {
        expect(markup).not.toContain(word);
      }
    });
  }
});

describe("FilesPanelBody — error state renders the actual reason (acceptance check 4)", () => {
  it("puts the real error message in the markup, not a generic string", () => {
    const markup = renderToStaticMarkup(
      <FilesPanelBody
        view={{ kind: "error", message: "fatal: unable to read repository state" }}
      />,
    );
    expect(markup).toContain("fatal: unable to read repository state");
    expect(markup).toContain('data-files-panel-state="error"');
  });

  it("puts the not-a-repo directory in the markup", () => {
    const markup = renderToStaticMarkup(
      <FilesPanelBody view={{ kind: "not-a-repo", cwd: "/Users/piero/tmp/not-a-repo" }} />,
    );
    expect(markup).toContain("/Users/piero/tmp/not-a-repo");
    expect(markup).toContain("Not a git repository");
    expect(markup).toContain('data-files-panel-state="not-a-repo"');
  });
});

describe("FilesPanelBody — empty (clean) is distinguishable from error (acceptance check 4)", () => {
  it("clean and error render different state markers and different text — never the same shape", () => {
    const cleanMarkup = renderToStaticMarkup(
      <FilesPanelBody view={{ kind: "clean", refName: "main" }} />,
    );
    const errorMarkup = renderToStaticMarkup(
      <FilesPanelBody view={{ kind: "error", message: "network unreachable" }} />,
    );

    expect(cleanMarkup).toContain('data-files-panel-state="clean"');
    expect(cleanMarkup).toContain("No changes");
    expect(cleanMarkup).not.toContain('data-files-panel-state="error"');
    expect(cleanMarkup).not.toContain("network unreachable");

    expect(errorMarkup).toContain('data-files-panel-state="error"');
    expect(errorMarkup).toContain("network unreachable");
    expect(errorMarkup).not.toContain('data-files-panel-state="clean"');
    expect(errorMarkup).not.toContain("No changes");
  });

  it("clean and not-a-repo also render different state markers — an empty file list must never stand in for a real repo check", () => {
    const cleanMarkup = renderToStaticMarkup(
      <FilesPanelBody view={{ kind: "clean", refName: "main" }} />,
    );
    const notARepoMarkup = renderToStaticMarkup(
      <FilesPanelBody view={{ kind: "not-a-repo", cwd: "/tmp/x" }} />,
    );

    expect(cleanMarkup).toContain('data-files-panel-state="clean"');
    expect(notARepoMarkup).toContain('data-files-panel-state="not-a-repo"');
    expect(cleanMarkup).not.toContain("Not a git repository");
    expect(notARepoMarkup).not.toContain("No changes");
  });
});
