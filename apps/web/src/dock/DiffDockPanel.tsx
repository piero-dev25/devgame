/**
 * Diff as a first-class dock panel — spec-surfaces-as-dock-panels.md, Part
 * B, first slice. Diff went first of the four surfaces (files, diff,
 * terminal, browser) because it is the one that already resolves its own
 * thread identity from the route instead of taking it, plus a dozen-plus
 * callbacks, from `ChatView`'s internal scope — roughly 80% of the way to
 * being a dock panel already.
 *
 * `DiffPanel` itself is UNTOUCHED — the spec's rule ("we delete our code,
 * never theirs") applies here exactly as it did to deleting our own Files
 * panel in Part A. This is a thin wrapper supplying the two props a dock
 * panel has no `ChatView` to hand it.
 *
 * IDENTITY: deliberately keeps `DiffPanel`'s OWN `useParams` (see
 * `DiffPanel.tsx`'s `routeThreadRef`), NOT `ChatPanel.tsx`'s
 * `ThreadRouteContext` mechanism. `DiffPanel` already resolves standalone
 * with zero `ChatView` plumbing, and both mechanisms land on the same
 * `ScopedThreadRef` for a real thread route (`threadRoutes.ts`'s
 * `resolveThreadRouteRef`, reading the exact same route params either way)
 * — refactoring a working, self-sufficient component onto a DIFFERENT
 * identity mechanism purely for stylistic consistency would touch working
 * code for no behaviour change, which the spec's own rule already argues
 * against.
 *
 * `composerDraftTarget`: always `routeThreadRef` here, once resolved — there
 * is no draft-thread case for a diff panel. Matches `ChatView.tsx`'s own
 * `addDiffSurface`/`onOpenTurnDiff` gates, both of which bail out on
 * `!isServerThread` before ever opening a diff.
 *
 * `initialGitScope`: `DiffPanel`'s own prop is a `useState` INITIALIZER,
 * read once on mount and never re-synced from a later prop change.
 * `ChatView`'s inline usage compensates with a `key={...}` that force-
 * remounts `DiffPanel` once its git-status query resolves (see
 * `ChatView.tsx`'s `diffPanelGitStatusResolutionKey`). That remount trick is
 * deliberately NOT reproduced here — an OWNER RULING, not an oversight: a
 * dock panel mounts once and persists (it does not remount per thread
 * switch, unlike `ChatView`'s old inline surface), so this wrapper computes
 * `initialGitScope` from its OWN copy of the exact query `DiffPanel` runs
 * internally (`vcsEnvironment.status`, the same `activeCwd` formula as
 * `DiffPanel.tsx`'s own — NOT `ChatView.tsx`'s slightly different
 * `gitStatusCwd`, which also folds in `projectScriptCwd`; matching
 * `DiffPanel`'s own formula is what "derive it from DiffPanel's own
 * gitStatusQuery" means) and passes whatever it has at first render. If
 * that query is still pending the very first time this panel mounts, the
 * selected scope stays at the "branch" default until the user picks
 * "Working tree" from `DiffPanel`'s own scope dropdown by hand. Accepted
 * simplification: the dock panel mounting once per app session (rather than
 * once per surface-open) makes the pending-query window rare in practice,
 * and the query itself is shared/cached with `DiffPanel`'s own identical
 * call (same query key), so this costs nothing extra over what `DiffPanel`
 * already fetches — just an earlier read of the same cache entry.
 */
import { useParams } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useProject, useThread } from "~/state/entities";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { vcsEnvironment } from "~/state/vcs";

import type { PanelProps } from "./lib/types";

const DiffPanel = lazy(() => import("~/components/DiffPanel"));

export default function DiffDockPanel(_props: PanelProps) {
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThread = useThread(routeThreadRef);
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? { environmentId: activeThread.environmentId, projectId: activeProjectId }
      : null,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const initialGitScope: "branch" | "unstaged" =
    gitStatusQuery.data?.hasWorkingTreeChanges === true ? "unstaged" : "branch";

  if (!routeThreadRef) {
    return (
      <div className="flex h-full min-w-0 flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Select a thread to inspect turn diffs.
      </div>
    );
  }

  return (
    <Suspense fallback={null}>
      <DiffPanel
        mode="embedded"
        composerDraftTarget={routeThreadRef}
        initialGitScope={initialGitScope}
      />
    </Suspense>
  );
}
