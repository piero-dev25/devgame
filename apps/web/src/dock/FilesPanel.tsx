// New for spec-files-panel.md — not a port. The first dock panel reading
// this fork's REAL data instead of a fixture.
//
// Explicitly NOT built on gamedev-workbench's `components/panels/FileTree.tsx`:
// that component takes `FileTreeNode[]` with a synthesized `M/A/D/R/?` status
// per file — a shape this fork's real data does not provide. See
// FilesPanel.logic.ts for what the real shape (`VcsStatusResult`, packages/
// contracts/src/git.ts) actually supports and what that means for what this
// panel can honestly claim.
//
// This is now just the hook-driven half. The presentational half
// (`FilesPanelBody`, `FileRow`, `StatusCard`) moved to FilesPanelBody.tsx
// (fix round after 5ed29658c, matching `ChangedFilesCard`/`ChangedFilesTree`'s
// container/presentational shape) — NOT just for the "what to show" vs "how
// to draw it" split, but because importing anything from a module that
// imports `./ChatPanel` pulls in ChatPanel.tsx's transitive graph, which
// reaches DiffWorkerPoolProvider.tsx's `?worker` import and throws
// `ReferenceError: self is not defined` outside a real browser — hit for
// real while writing FilesPanel.test.tsx before this split existed. The "what
// to show" decision itself lives in FilesPanel.logic.ts.
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useContext, useMemo } from "react";

import { useProject, useThread } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

import { ThreadRouteContext } from "./ChatPanel";
import { decideFilesPanelView } from "./FilesPanel.logic";
import { FilesPanelBody } from "./FilesPanelBody";

export function FilesPanel() {
  const routeValue = useContext(ThreadRouteContext);
  if (!routeValue) {
    throw new Error("FilesPanel rendered outside a ThreadRouteContext.Provider — see ChatDock.tsx");
  }
  const { environmentId, threadId } = routeValue;

  // Same cwd-resolution rule as GitActionsControl.tsx/ThreadRowLeadingStatus
  // (`~/components/ThreadStatusIndicators.tsx`) use for the exact same
  // subscription — worktree path first, project root otherwise — followed
  // rather than invented, so a worktree thread's Files panel shows ITS
  // worktree's status, not the parent project's.
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const thread = useThread(threadRef);
  const projectRef = useMemo(
    () => (thread ? scopeProjectRef(environmentId, thread.projectId) : null),
    [environmentId, thread],
  );
  const project = useProject(projectRef);
  const gitCwd = thread?.worktreePath ?? project?.workspaceRoot ?? null;

  // `vcsEnvironment.status` (packages/client-runtime/src/state/vcs.ts) is a
  // STREAMING subscription atom family (`subscribeVcsStatus` under the
  // hood), not a one-shot request — this is what makes "no manual refresh"
  // true: every consumer of this same atom (GitActionsControl.tsx,
  // ThreadRowLeadingStatus) already gets live updates this way, so this
  // panel does too by construction, not by anything panel-specific. (Fix
  // round finding, from live E2E on 5ed29658c: "live" here means "live
  // relative to T3's own triggers" — an agent checkpoint, a manual refresh
  // RPC, or a pull. A raw external file edit with no subsequent in-app
  // action does not propagate on its own; see the step's report.)
  const statusQuery = useEnvironmentQuery(
    gitCwd !== null ? vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } }) : null,
  );

  const view = decideFilesPanelView({
    gitCwd,
    error: statusQuery.error,
    data: statusQuery.data,
  });

  return <FilesPanelBody view={view} />;
}
