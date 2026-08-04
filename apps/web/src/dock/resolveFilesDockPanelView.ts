/**
 * The identity/readiness decision behind `FilesDockPanel.tsx` — extracted
 * into its own file, not just its own function, for a reason beyond the
 * usual "testable without jsdom" (see `lib/openPanel.ts`'s own precedent for
 * that half of it): `FilesDockPanel.tsx` imports `ThreadRouteContext` (the
 * VALUE, needed for `useContext`) from `./ChatPanel`, and `ChatPanel.tsx`
 * itself imports `ChatView` (a value import, not type-only) — pulling that
 * whole module graph in eagerly breaks under plain Node/vitest (no DOM),
 * because somewhere in ChatView's own tree a `@pierre/diffs` Web Worker gets
 * imported at module scope (`self is not defined`). This file only needs
 * `ThreadRouteContextValue` as a TYPE (erased at build time, no runtime
 * import), so importing it here — and having `FilesDockPanel.test.ts` import
 * ONLY this file, never `FilesDockPanel.tsx` itself — never touches that
 * graph at all.
 *
 * See `FilesDockPanel.tsx`'s own doc comment for why draft threads are the
 * one place a wrapper that assumed "same as Diff" would break: Diff's
 * `useParams` + `resolveThreadRouteRef` mechanism collapses "draft route"
 * into the same `null` case as "no route at all," so it never even sees
 * thread/project data for a draft. `ThreadRouteContext` gives an explicit
 * `routeKind: "draft" | "server"` instead — checked FIRST, before anything
 * else, so a draft never falls through to treating stale/absent
 * thread-project data as if it were a real thread's.
 */
import type { EnvironmentProject, EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadRouteContextValue } from "./ChatPanel";

export type FilesDockPanelView =
  | { readonly kind: "draft-empty" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
      readonly projectName: string;
      readonly threadRef: ScopedThreadRef;
      readonly composerDraftTarget: ScopedThreadRef;
    };

export function resolveFilesDockPanelView(input: {
  readonly routeContext: ThreadRouteContextValue;
  readonly activeThread: EnvironmentThread | null;
  readonly activeProject: EnvironmentProject | null;
}): FilesDockPanelView {
  if (input.routeContext.routeKind === "draft") {
    return { kind: "draft-empty" };
  }
  const threadRef: ScopedThreadRef = {
    environmentId: input.routeContext.environmentId,
    threadId: input.routeContext.threadId,
  };
  const cwd = input.activeThread?.worktreePath ?? input.activeProject?.workspaceRoot;
  if (!input.activeProject || !cwd) {
    return { kind: "loading" };
  }
  return {
    kind: "ready",
    environmentId: input.routeContext.environmentId,
    cwd,
    projectName: input.activeProject.title,
    threadRef,
    composerDraftTarget: threadRef,
  };
}
