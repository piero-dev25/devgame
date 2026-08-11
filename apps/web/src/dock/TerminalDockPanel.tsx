/**
 * Terminal as a first-class dock panel — spec-surfaces-as-dock-panels.md,
 * Part B, third slice (task #53). Same template Diff and Files established:
 * move the surface, then delete its kind from `rightPanelStore.ts`'s union
 * so the compiler enumerates every straggler.
 *
 * Harder than Files for a reason team-lead flagged before this was written:
 * `ThreadTerminalDrawer` (mode="panel", UNTOUCHED — same "delete our code,
 * never theirs" rule Diff/Files followed) wraps a REAL server-side PTY
 * session (`TerminalManager` on the server), not inert file content. The
 * risk is a dock panel that mounts/unmounts differently than the old
 * right-panel tab orphaning or double-attaching a session.
 *
 * That risk is smaller than it looks, because `terminalEnvironment.open`
 * (server-side `TerminalManager.open`) is ALREADY "open or attach", keyed
 * by `threadId`+`terminalId` — proven by the fact the OLD right-panel
 * terminal surface (`PersistentThreadTerminalPanel`, ChatView.tsx, now
 * deleted) was ALREADY torn down and remounted on every tab switch (a plain
 * ternary on `activeRightPanelSurface?.kind`, not a kept-mounted-hidden
 * tree) and reattached correctly every time. What actually matters is
 * CLIENT-SIDE id bookkeeping surviving the panel's own close/reopen — see
 * `terminalDockStore.ts`'s own doc comment for exactly what's preserved
 * (every open group/terminalId) vs. what's destructive (closing an
 * individual terminal GROUP tab in this panel's own strip, or a pane inside
 * one) and why that split matches precedent rather than inventing new
 * behaviour.
 *
 * Structurally this is Files' shape, not Diff's: an internal tab strip
 * (`TerminalGroupTabStrip`, mirroring `FilesDockPanel.tsx`'s `FilesTabStrip`)
 * switches between terminal GROUPS (what used to be separate
 * `RightPanelSurface` "terminal" tabs), and `ThreadTerminalDrawer` itself
 * renders only the ACTIVE group's panes/splits — exactly what
 * `PersistentThreadTerminalPanel` already fed it, just self-contained here
 * instead of threaded down from ChatView.
 *
 * DRAFT THREADS: like Files' `FilePreviewPanel`/Terminal's own OLD
 * `PersistentThreadTerminalPanel`, a terminal is available on BOTH the
 * draft and server routes (a project's shell doesn't require a real thread
 * to exist yet) — unlike Files, there is no `routeKind === "draft"` gate
 * here; `resolveTerminalDockPanelView` resolves `serverThread ??
 * draftThread` uniformly, matching what the deleted `PersistentThread-
 * TerminalPanel` already did.
 *
 * `onAddTerminalContext` reaches the chat composer via
 * `useComposerHandleContext()` directly — NOT a ChatView-threaded ref/
 * callback (there is no ChatView in a dock panel's ancestry; `ChatDock` ->
 * `ChatPanel` -> `ChatView` is a SIBLING subtree, not a parent). This is
 * not a new mechanism invented for Terminal: `FileBrowserPanel.tsx` (inside
 * `FilesDockPanel`) already reaches the composer the identical way for its
 * own "add to chat" action, proving the context Provider
 * (`CommandPalette.tsx`) covers dock panels, not just ChatView's own tree.
 * Same null-check-and-toast fallback as that precedent, not reinvented.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useAtomValue } from "@effect/atom-react";
import { Plus, TerminalSquare, X } from "lucide-react";
import { useCallback, useContext, useMemo } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useComposerHandleContext } from "~/composerHandleContext";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import type { TerminalContextSelection } from "~/lib/terminalContext";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useProject, useThread } from "~/state/entities";
import { terminalEnvironment } from "~/state/terminal";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  selectThreadTerminalDockState,
  useTerminalDockStore,
  type TerminalDockGroup,
} from "~/terminalDockStore";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";
import { MAX_TERMINALS_PER_GROUP } from "~/types";

import { ThreadRouteContext } from "./ChatPanel";
import type { PanelProps } from "./lib/types";
import ThreadTerminalDrawer from "../components/ThreadTerminalDrawer";

/**
 * The deliberately minimal tab strip — same scope as `FilesTabStrip`: open/
 * close/switch between groups, no reordering/context-menu affordances
 * (`RightPanelTabs`' own machinery, not reimplemented here).
 */
function TerminalGroupTabStrip(props: {
  groups: readonly TerminalDockGroup[];
  activeGroupId: string | null;
  terminalLabelsById: ReadonlyMap<string, string>;
  onSelectGroup: (groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onNewTerminal: () => void;
}) {
  return (
    <div className="flex min-h-0 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 px-1 py-1">
      {props.groups.map((group) => {
        const active = group.id === props.activeGroupId;
        const label =
          props.terminalLabelsById.get(group.activeTerminalId) ??
          resolveTerminalSessionLabel(group.activeTerminalId, null);
        return (
          <div
            key={group.id}
            className={cn(
              "group flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => props.onSelectGroup(group.id)}
              className="flex min-w-0 max-w-40 items-center gap-1.5 truncate"
              title={label}
            >
              <TerminalSquare className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
            <button
              type="button"
              onClick={() => props.onCloseGroup(group.id)}
              aria-label={`Close ${label}`}
              className="relative flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-accent group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={props.onNewTerminal}
        aria-label="New terminal"
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

function TerminalDockEmptyState(props: { onNewTerminal: () => void }) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
      <TerminalSquare className="size-6 text-muted-foreground/70" />
      <p className="text-xs text-muted-foreground">Start a shell in this workspace.</p>
      <button
        type="button"
        onClick={props.onNewTerminal}
        className="rounded-md border border-border/80 bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent/60"
      >
        New Terminal
      </button>
    </div>
  );
}

export default function TerminalDockPanel(_props: PanelProps) {
  const routeContext = useContext(ThreadRouteContext);
  const threadRef = routeContext
    ? { environmentId: routeContext.environmentId, threadId: routeContext.threadId }
    : null;
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const activeThread = serverThread ?? draftThread;
  const projectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : null;
  const project = useProject(projectRef);
  const composerRef = useComposerHandleContext();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");

  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef?.environmentId ?? null,
    threadId: threadRef?.threadId ?? null,
  });

  const dockState = useTerminalDockStore((state) =>
    selectThreadTerminalDockState(state.byThreadKey, threadRef),
  );

  const allocatableTerminalIds = useMemo(
    () => [
      ...new Set([
        ...knownTerminalSessions.map((session) => session.target.terminalId),
        ...dockState.groups.flatMap((group) => group.terminalIds),
      ]),
    ],
    [dockState.groups, knownTerminalSessions],
  );

  const terminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const group of dockState.groups) {
      for (const terminalId of group.terminalIds) {
        const summary =
          knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
            .summary ?? null;
        labels.set(terminalId, resolveTerminalSessionLabel(terminalId, summary));
      }
    }
    return labels;
  }, [dockState.groups, knownTerminalSessions]);

  const worktreePath = activeThread?.worktreePath ?? null;
  const cwd = useMemo(
    () =>
      project ? projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath }) : null,
    [project, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath })
        : {},
    [project, worktreePath],
  );

  const terminalLaunchLocationsById = useMemo(() => {
    const locations = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    if (!project || !cwd) return locations;
    for (const group of dockState.groups) {
      for (const terminalId of group.terminalIds) {
        const summary =
          knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
            .summary ?? null;
        const terminalWorktreePath = summary?.worktreePath ?? worktreePath;
        const terminalCwd =
          summary?.cwd ??
          projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath: terminalWorktreePath,
          });
        locations.set(terminalId, {
          cwd: terminalCwd,
          worktreePath: terminalWorktreePath,
          runtimeEnv: projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath: terminalWorktreePath,
          }),
        });
      }
    }
    return locations;
  }, [cwd, dockState.groups, knownTerminalSessions, project, worktreePath]);

  const launchTerminal = useCallback(
    (terminalId: string) => {
      if (!threadRef || !cwd) return;
      void openTerminal({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          terminalId,
          cwd,
          ...(worktreePath != null ? { worktreePath } : {}),
          env: runtimeEnv,
        },
      });
    },
    [cwd, openTerminal, runtimeEnv, threadRef, worktreePath],
  );

  const onNewTerminal = useCallback(() => {
    if (!threadRef || !cwd) return;
    const terminalId = nextTerminalId(allocatableTerminalIds);
    useTerminalDockStore.getState().openTerminal(threadRef, terminalId);
    launchTerminal(terminalId);
  }, [allocatableTerminalIds, cwd, launchTerminal, threadRef]);

  const activeGroup =
    dockState.groups.find((group) => group.id === dockState.activeGroupId) ?? null;

  const onSplitTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (
        !threadRef ||
        !cwd ||
        !activeGroup ||
        activeGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
      ) {
        return;
      }
      const terminalId = nextTerminalId(allocatableTerminalIds);
      useTerminalDockStore
        .getState()
        .splitTerminal(threadRef, activeGroup.id, terminalId, direction);
      launchTerminal(terminalId);
    },
    [activeGroup, allocatableTerminalIds, cwd, launchTerminal, threadRef],
  );
  const onSplitTerminalVertical = useCallback(() => onSplitTerminal("vertical"), [onSplitTerminal]);

  const onActiveTerminalChange = useCallback(
    (terminalId: string) => {
      if (!threadRef || !activeGroup) return;
      useTerminalDockStore.getState().activateTerminal(threadRef, activeGroup.id, terminalId);
    },
    [activeGroup, threadRef],
  );

  const onCloseTerminal = useCallback(
    (terminalId: string) => {
      if (!threadRef || !activeGroup) return;
      void closeTerminalMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
      });
      // Same cross-store suppression call the deleted right-panel
      // `closePanelTerminal` made: keeps this id from transiently
      // flashing into the DRAWER before the server reports it gone.
      useTerminalUiStateStore.getState().closeTerminal(threadRef, terminalId);
      useTerminalDockStore.getState().closeTerminal(threadRef, activeGroup.id, terminalId);
    },
    [activeGroup, closeTerminalMutation, threadRef],
  );

  const onSelectGroup = useCallback(
    (groupId: string) => {
      if (!threadRef) return;
      useTerminalDockStore.getState().activateGroup(threadRef, groupId);
    },
    [threadRef],
  );

  const onCloseGroup = useCallback(
    (groupId: string) => {
      if (!threadRef) return;
      const group = dockState.groups.find((entry) => entry.id === groupId);
      if (!group) return;
      for (const terminalId of group.terminalIds) {
        void closeTerminalMutation({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
        });
        useTerminalUiStateStore.getState().closeTerminal(threadRef, terminalId);
      }
      useTerminalDockStore.getState().closeGroup(threadRef, groupId);
    },
    [closeTerminalMutation, dockState.groups, threadRef],
  );

  const onAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      const composer = composerRef?.current;
      if (!composer) {
        toastManager.add({
          type: "error",
          title: "Unable to add to chat",
          description: "Open a chat for this project and try again.",
        });
        return;
      }
      composer.addTerminalContext(selection);
    },
    [composerRef],
  );

  if (!project || !cwd || !threadRef) {
    return <div className="flex h-full min-w-0 flex-1" />;
  }

  if (!activeGroup) {
    return <TerminalDockEmptyState onNewTerminal={onNewTerminal} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TerminalGroupTabStrip
        groups={dockState.groups}
        activeGroupId={dockState.activeGroupId}
        terminalLabelsById={terminalLabelsById}
        onSelectGroup={onSelectGroup}
        onCloseGroup={onCloseGroup}
        onNewTerminal={onNewTerminal}
      />
      <div className="min-h-0 flex-1">
        <ThreadTerminalDrawer
          mode="panel"
          threadRef={threadRef}
          threadId={threadRef.threadId}
          cwd={cwd}
          worktreePath={worktreePath}
          runtimeEnv={runtimeEnv}
          height={0}
          terminalIds={[...activeGroup.terminalIds]}
          activeTerminalId={activeGroup.activeTerminalId}
          terminalGroups={[
            {
              id: activeGroup.id,
              terminalIds: [...activeGroup.terminalIds],
              ...(activeGroup.splitDirection === "vertical"
                ? { splitDirection: "vertical" as const }
                : {}),
            },
          ]}
          activeTerminalGroupId={activeGroup.id}
          focusRequestId={0}
          onSplitTerminal={onSplitTerminal}
          onSplitTerminalVertical={onSplitTerminalVertical}
          onNewTerminal={onNewTerminal}
          onActiveTerminalChange={onActiveTerminalChange}
          onCloseTerminal={onCloseTerminal}
          onHeightChange={() => undefined}
          onAddTerminalContext={onAddTerminalContext}
          terminalLabelsById={terminalLabelsById}
          terminalLaunchLocationsById={terminalLaunchLocationsById}
          keybindings={keybindings}
        />
      </div>
    </div>
  );
}
