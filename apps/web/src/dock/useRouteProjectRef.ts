import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { environmentThreadShells } from "~/state/threads";

/** The route identity `ChatDock` receives and `ThreadRouteContext` carries. */
export type RouteProjectSource =
  | {
      readonly routeKind: "server";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | { readonly routeKind: "draft"; readonly draftId: DraftId }
  | null;

const NO_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("route-project-ref:no-thread-shell"),
);

// Module scope so the mapped atom is stable across renders.
const selectShellProjectId = (shell: EnvironmentThreadShell | null): ProjectId | null =>
  shell?.projectId ?? null;

/**
 * The project a dock route belongs to, for a server thread (its shell) or a
 * draft (its draft session). Subscribes to primitives only, so a thread's
 * streaming updates do not re-render the caller (`ChatDock` sits above the
 * whole dock).
 */
export function useRouteProjectRef(source: RouteProjectSource): ScopedProjectRef | null {
  const serverThreadRef: ScopedThreadRef | null =
    source?.routeKind === "server"
      ? { environmentId: source.environmentId, threadId: source.threadId }
      : null;
  // `threadShellAtom` is a family keyed by the ref's string key, so a fresh
  // ref object each render still maps to the same atom.
  const serverProjectId = useAtomValue(
    serverThreadRef === null
      ? NO_THREAD_SHELL_ATOM
      : environmentThreadShells.threadShellAtom(serverThreadRef),
    selectShellProjectId,
  );
  const draftId = source?.routeKind === "draft" ? source.draftId : null;
  const draftEnvironmentId = useComposerDraftStore((store) =>
    draftId === null ? null : (store.getDraftSession(draftId)?.environmentId ?? null),
  );
  const draftProjectId = useComposerDraftStore((store) =>
    draftId === null ? null : (store.getDraftSession(draftId)?.projectId ?? null),
  );

  const environmentId =
    serverThreadRef !== null ? serverThreadRef.environmentId : draftEnvironmentId;
  const projectId = serverThreadRef !== null ? serverProjectId : draftProjectId;
  return useMemo(
    () => (environmentId !== null && projectId !== null ? { environmentId, projectId } : null),
    [environmentId, projectId],
  );
}
