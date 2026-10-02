/**
 * The Workspace dock panel: the project's `workspace/workspace.json` cards
 * and their steps. A thin renderer over `resolveWorkspacePanelView`, which
 * holds every decision. Steps open in the existing Files panel
 * (`openFileInDock`), which already previews markdown, media, PDF and
 * sandboxed HTML, so this panel never browses or renders files itself.
 *
 * IDENTITY: `ThreadRouteContext`, like `FilesDockPanel`, so drafts are told
 * apart from "no thread" and still show their project's cards.
 *
 * Web and desktop only: mobile has no dock.
 */
import { AlertTriangle, FileText, LayoutGrid, Loader2, Pin, RefreshCw } from "lucide-react";
import { type ReactNode, useContext } from "react";

import { openFileInDock } from "~/components/ChatMarkdown";
import { ThreadRouteContext } from "~/dock/ChatPanel";
import type { PanelProps } from "~/dock/lib/types";
import { useRouteProjectRef } from "~/dock/useRouteProjectRef";
import { cn } from "~/lib/utils";
import { useProject } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";

import { projectWorkspaceAtom } from "./projectWorkspaceAtom";
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

function WorkspaceCard(props: {
  card: WorkspaceCardView;
  onOpen: ((relativePath: string) => void) | null;
  openBlockedReason: string | null;
}) {
  const { card } = props;
  return (
    <li className="flex flex-col gap-1.5 border-b border-border/40 px-3 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
          {card.pinned ? <Pin className="size-3 shrink-0 text-muted-foreground" /> : null}
          <span className="truncate">{card.title}</span>
        </p>
        {(card.status ?? card.category) ? (
          <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-3xs uppercase tracking-wide text-muted-foreground">
            {card.status ?? card.category}
          </span>
        ) : null}
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
              <li key={step.key}>
                <button
                  type="button"
                  disabled={!step.openable || props.onOpen === null}
                  onClick={() => {
                    if (step.relativePath !== null) props.onOpen?.(step.relativePath);
                  }}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-2xs",
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
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function WorkspaceBody(props: { view: WorkspacePanelView; onRetry: () => void }) {
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
                <WorkspaceCard key={card.key} card={card} onOpen={null} openBlockedReason={null} />
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
          {view.issues.length > 0 || view.openBlockedReason ? (
            <div className="flex shrink-0 flex-col gap-1 border-b border-border/60 bg-warning/5 px-3 py-2 text-2xs text-muted-foreground">
              {view.openBlockedReason ? <p>{view.openBlockedReason}</p> : null}
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
  const project = useProject(projectRef);
  const query = useEnvironmentQuery(projectRef === null ? null : projectWorkspaceAtom(projectRef));
  const view = resolveWorkspacePanelView({
    target:
      route === null || projectRef === null
        ? null
        : route.routeKind === "server"
          ? {
              kind: "server",
              threadRef: { environmentId: route.environmentId, threadId: route.threadId },
            }
          : { kind: "draft" },
    query: { data: query.data, error: query.error },
  });

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
      <WorkspaceBody view={view} onRetry={query.refresh} />
    </div>
  );
}
