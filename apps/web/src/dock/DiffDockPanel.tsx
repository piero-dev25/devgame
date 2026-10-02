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
 * `workspaceMutationId`: upstream's `DiffPanel` now takes the id of the
 * latest agent workspace mutation so it refreshes the working-tree diff once
 * per mutation. Upstream's inline right panel computes it inside `ChatView`;
 * this dock panel derives the same value from its own route thread
 * (`threadWorkspaceMutationId.ts`, same formula).
 *
 * Scope: upstream dropped `DiffPanel`'s `initialGitScope` prop. The selected
 * scope now lives per thread in `diffPanelStore` (default "unstaged", the
 * working tree), and `ChatView`'s own actions select it there. This wrapper's
 * old copy of the status query, which only existed to seed that removed
 * initializer, went with it.
 */
import { useParams } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { useThread } from "~/state/entities";
import { resolveThreadRouteRef } from "~/threadRoutes";

import type { PanelProps } from "./lib/types";
import { useThreadWorkspaceMutationId } from "./threadWorkspaceMutationId";

const DiffPanel = lazy(() => import("~/components/DiffPanel"));

export default function DiffDockPanel(_props: PanelProps) {
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThread = useThread(routeThreadRef);
  const workspaceMutationId = useThreadWorkspaceMutationId(activeThread);

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
        workspaceMutationId={workspaceMutationId}
      />
    </Suspense>
  );
}
