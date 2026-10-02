/**
 * The Workspace dock panel: the project's `workspace/workspace.json` cards
 * and their steps. A thin renderer over `resolveWorkspacePanelView`, which
 * holds every decision. Steps open in the existing Files panel
 * (`openFileInDock`), which already previews markdown, media, PDF and
 * sandboxed HTML, so this panel never browses or renders files itself.
 *
 * "Use in chat" (a card, or one step) stages a bounded context packet for
 * this thread's next message (`contextPacket.ts`, `workspacePacketStore.ts`)
 * and opens Chat. Nothing is attached until the user presses it.
 *
 * IDENTITY: `ThreadRouteContext`, like `FilesDockPanel`, so drafts are told
 * apart from "no thread" and still show their project's cards.
 *
 * Web and desktop only: mobile has no dock.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  AlertTriangle,
  FileText,
  LayoutGrid,
  Loader2,
  MessageSquarePlus,
  Pin,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useContext } from "react";

import { openFileInDock } from "~/components/ChatMarkdown";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerDraftStore } from "~/composerDraftStore";
import { CHAT_PANEL_ID, openChatDockPanel } from "~/dock/chatDockHandle";
import { ThreadRouteContext } from "~/dock/ChatPanel";
import type { PanelProps } from "~/dock/lib/types";
import { useRouteProjectRef, useRouteThreadWorktreePath } from "~/dock/useRouteProjectRef";
import { cn } from "~/lib/utils";
import { readThreadShell, useProject } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { RunEvidenceSummary } from "~/projectRuntime/RunEvidenceSummary";
import { cardEvidence, type RunEvidenceSummaryView } from "~/projectRuntime/runEvidenceView";
import { runtimeStatusAtom } from "~/projectRuntime/runtimeStatusAtom";

import { buildWorkspacePacket } from "./contextPacket";
import { projectWorkspaceAtom } from "./projectWorkspaceAtom";
import { stageWorkspacePacket, workspacePacketBlockedReason } from "./workspacePacketStore";
import {
  resolveWorkspacePanelView,
  type WorkspaceCardView,
  type WorkspacePanelView,
} from "./resolveWorkspacePanelView";

function CenteredMessage(props: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center text-xs text-muted-foreground/70">
      {props.icon}
      {props.children}
    </div>
  );
}

/** "Use in chat": attach the card (every step, or one) to this thread's next message. */
interface UseInChat {
  readonly blockedReason: string | null;
  readonly use: (card: WorkspaceCardView, stepIndexes: ReadonlyArray<number>) => void;
}

function UseInChatButton(props: {
  useInChat: UseInChat;
  label: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  // A disabled action's reason is shown once above the cards.
  const blocked = props.useInChat.blockedReason !== null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={blocked}
            aria-label={props.label}
            onClick={props.onClick}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-3xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
          />
        }
      >
        <MessageSquarePlus className="size-3" />
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function WorkspaceCard(props: {
  card: WorkspaceCardView;
  onOpen: ((relativePath: string) => void) | null;
  openBlockedReason: string | null;
  useInChat: UseInChat | null;
  /** The newest run evidence linked to this card, or null. */
  evidence: RunEvidenceSummaryView | null;
}) {
  const { card, useInChat } = props;
  return (
    <li className="flex flex-col gap-1.5 border-b border-border/40 px-3 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
          {card.pinned ? <Pin className="size-3 shrink-0 text-muted-foreground" /> : null}
          <span className="truncate">{card.title}</span>
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {(card.status ?? card.category) ? (
            <span className="rounded-full border border-border/60 px-2 py-0.5 text-3xs uppercase tracking-wide text-muted-foreground">
              {card.status ?? card.category}
            </span>
          ) : null}
          {useInChat ? (
            <UseInChatButton
              useInChat={useInChat}
              label={`Use ${card.title} in chat`}
              onClick={() =>
                useInChat.use(
                  card,
                  card.steps.map((step) => step.index),
                )
              }
            >
              Use in chat
            </UseInChatButton>
          ) : null}
        </div>
      </div>
      {card.description ? (
        <p className="line-clamp-2 text-2xs text-muted-foreground">{card.description}</p>
      ) : null}
      {card.steps.length === 0 ? (
        <p className="text-2xs text-muted-foreground/70">No steps listed.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {card.steps.map((step) => {
            return (
              <li key={step.key} className="flex items-center gap-0.5">
                <button
                  type="button"
                  disabled={!step.openable || props.onOpen === null}
                  onClick={() => {
                    if (step.relativePath !== null) props.onOpen?.(step.relativePath);
                  }}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-2xs",
                    step.openable
                      ? "text-foreground hover:bg-muted/60"
                      : "cursor-default text-muted-foreground/70",
                  )}
                >
                  {step.problem ? (
                    <AlertTriangle className="size-3 shrink-0 text-warning" />
                  ) : (
                    <FileText className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate">{step.name}</span>
                  {step.isDefault ? (
                    <span className="shrink-0 text-3xs text-muted-foreground">default</span>
                  ) : null}
                  {step.problem ? (
                    <span className="ml-auto shrink-0 text-3xs text-warning">{step.problem}</span>
                  ) : null}
                </button>
                {useInChat ? (
                  <UseInChatButton
                    useInChat={useInChat}
                    label={`Use step ${step.name} in chat`}
                    onClick={() => useInChat.use(card, [step.index])}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {props.evidence ? (
        <RunEvidenceSummary evidence={props.evidence} onOpen={props.onOpen} note={null} />
      ) : null}
    </li>
  );
}

function WorkspaceBody(props: {
  view: WorkspacePanelView;
  onRetry: () => void;
  useInChat: UseInChat | null;
  evidenceFor: (entityId: string) => RunEvidenceSummaryView | null;
}) {
  const { view } = props;
  switch (view.kind) {
    case "no-project":
      return <CenteredMessage>Select a thread to see this project's workspace.</CenteredMessage>;
    case "loading":
      return (
        <CenteredMessage>
          <Loader2 className="size-4 animate-spin text-muted-foreground/50" />
        </CenteredMessage>
      );
    case "missing":
      return (
        <CenteredMessage icon={<LayoutGrid className="size-5 text-muted-foreground/40" />}>
          <p>This project has no workspace registry.</p>
          <p>Add workspace/workspace.json to list its cards here.</p>
        </CenteredMessage>
      );
    case "error":
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start gap-2 border-b border-border/60 bg-destructive/5 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive/70" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-foreground">{view.message}</p>
              {view.staleCards ? (
                <p className="text-muted-foreground">
                  Showing the last loaded cards. They may be out of date.
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={props.onRetry}
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            >
              <RefreshCw className="size-3" />
              Try again
            </button>
          </div>
          {view.staleCards ? (
            <ul className="min-h-0 flex-1 overflow-y-auto opacity-60">
              {view.staleCards.map((card) => (
                <WorkspaceCard
                  key={card.key}
                  card={card}
                  onOpen={null}
                  openBlockedReason={null}
                  useInChat={null}
                  evidence={null}
                />
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "ready": {
      const threadRef = view.threadRef;
      const onOpen =
        threadRef === null
          ? null
          : (relativePath: string) => openFileInDock(threadRef, relativePath);
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          {view.issues.length > 0 ||
          view.openBlockedReason ||
          view.openNotice ||
          props.useInChat?.blockedReason ? (
            <div className="flex shrink-0 flex-col gap-1 border-b border-border/60 bg-warning/5 px-3 py-2 text-2xs text-muted-foreground">
              {props.useInChat?.blockedReason ? <p>{props.useInChat.blockedReason}</p> : null}
              {view.openBlockedReason ? <p>{view.openBlockedReason}</p> : null}
              {view.openNotice ? <p>{view.openNotice}</p> : null}
              {view.issues.map((issue) => (
                <p key={issue} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
                  {issue}
                </p>
              ))}
            </div>
          ) : null}
          {view.cards.length === 0 ? (
            <CenteredMessage>The workspace registry lists no cards yet.</CenteredMessage>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {view.cards.map((card) => (
                <WorkspaceCard
                  key={card.key}
                  card={card}
                  onOpen={onOpen}
                  openBlockedReason={view.openBlockedReason}
                  useInChat={props.useInChat}
                  evidence={props.evidenceFor(card.entity.id)}
                />
              ))}
            </ul>
          )}
        </div>
      );
    }
  }
}

export default function WorkspacePanel(_props: PanelProps) {
  const route = useContext(ThreadRouteContext);
  const projectRef = useRouteProjectRef(route);
  const worktreePath = useRouteThreadWorktreePath(route);
  const project = useProject(projectRef);
  const query = useEnvironmentQuery(projectRef === null ? null : projectWorkspaceAtom(projectRef));
  // Run evidence linked to cards by their id; the registry itself is never edited.
  const runtimeQuery = useEnvironmentQuery(
    projectRef === null ? null : runtimeStatusAtom(projectRef),
  );
  const evidenceFor = (entityId: string) =>
    cardEvidence({ data: runtimeQuery.data, error: runtimeQuery.error }, entityId)[0] ?? null;
  const view = resolveWorkspacePanelView({
    target:
      route === null
        ? null
        : projectRef === null
          ? { kind: "pending" }
          : route.routeKind === "server"
            ? {
                kind: "server",
                threadRef: { environmentId: route.environmentId, threadId: route.threadId },
                worktreePath,
                projectRoot: project?.workspaceRoot ?? null,
              }
            : { kind: "draft" },
    query: { data: query.data, error: query.error },
  });
  // Drafts and server threads alike: the packet is staged under the route's
  // thread and sent with its next message.
  const threadRef: ScopedThreadRef | null =
    route === null ? null : { environmentId: route.environmentId, threadId: route.threadId };
  // The cards are read for the route thread's own project (`useRouteProjectRef`
  // is the shell's project on a server route, the draft session's on a draft),
  // so at render time the thread and the workspace share one project and only
  // the "no thread" / "still loading" reasons can disable the action. A thread
  // that changes project between render and click is caught by the fresh read
  // in `use` below, which `stageWorkspacePacket` checks again.
  const threadProjectId = projectRef?.projectId ?? null;
  const workspaceProjectId = threadProjectId;
  const useInChat: UseInChat | null =
    route === null
      ? null
      : {
          blockedReason: workspacePacketBlockedReason({
            threadRef,
            threadProjectId,
            workspaceProjectId,
          }),
          use: (card, stepIndexes) => {
            if (threadRef === null || workspaceProjectId === null) return;
            const packet = buildWorkspacePacket({
              projectId: workspaceProjectId,
              entity: card.entity,
              stepIndexes,
              // Filled from run evidence once the run panel lands (PR7/PR8).
              acceptedVersion: null,
              runSummary: null,
              // Existence was checked at the project root, not the worktree.
              threadInWorktree: view.kind === "ready" && view.threadInWorktree,
            });
            // Re-read the thread's project now: the cards may predate a switch.
            const currentThreadProjectId =
              route.routeKind === "server"
                ? (readThreadShell(threadRef)?.projectId ?? null)
                : (useComposerDraftStore.getState().getDraftSession(route.draftId)?.projectId ??
                  null);
            const refused = stageWorkspacePacket(threadRef, currentThreadProjectId, packet);
            if (refused !== null) {
              toastManager.add({ type: "error", title: "Not added to chat", description: refused });
              return;
            }
            openChatDockPanel(CHAT_PANEL_ID);
          },
        };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {project ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{project.title}</p>
          <button
            type="button"
            onClick={query.refresh}
            aria-label="Refresh workspace"
            className="inline-flex shrink-0 items-center rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <RefreshCw className="size-3" />
          </button>
        </div>
      ) : null}
      <WorkspaceBody
        view={view}
        onRetry={query.refresh}
        useInChat={useInChat}
        evidenceFor={evidenceFor}
      />
    </div>
  );
}
