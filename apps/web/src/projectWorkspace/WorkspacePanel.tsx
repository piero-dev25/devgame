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
 * "Import from Mr. Mak…" opens `ImportDialog` for this project. Once a
 * project holds an import, a switch shows its "Original Mr. Mak" and
 * "DevGame Adaptation" collections (`workspaceCollections.ts`), each card,
 * workflow, context file and skill labelled with its origin.
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
  Import,
  LayoutGrid,
  Loader2,
  MessageSquarePlus,
  Pin,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useContext, useState } from "react";

import { openFileInDock } from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
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
import { ImportDialog } from "~/projectImport/ImportDialog";
import { importStatusAtom } from "~/projectImport/importStatusAtom";

import { buildWorkspacePacket } from "./contextPacket";
import {
  resolveWorkspaceCollections,
  type WorkspaceCollectionId,
  type WorkspaceCollections,
  type WorkspaceFileItem,
  type WorkspaceItemOrigin,
} from "./workspaceCollections";
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

const ORIGIN_BADGES: Readonly<
  Record<WorkspaceItemOrigin, { label: string; variant: "info" | "warning" | "secondary" }>
> = {
  mrmak: { label: "Mr. Mak", variant: "info" },
  adapted: { label: "Adapted", variant: "warning" },
  devgame: { label: "DevGame", variant: "secondary" },
};

function OriginBadge(props: { origin: WorkspaceItemOrigin }) {
  const badge = ORIGIN_BADGES[props.origin];
  return (
    <Badge size="sm" variant={badge.variant}>
      {badge.label}
    </Badge>
  );
}

function WorkspaceCard(props: {
  card: WorkspaceCardView;
  onOpen: ((relativePath: string) => void) | null;
  openBlockedReason: string | null;
  useInChat: UseInChat | null;
  /** The newest run evidence linked to this card, or null. */
  evidence: RunEvidenceSummaryView | null;
  /** Set for a project that holds an import. */
  origin?: WorkspaceItemOrigin | undefined;
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
          {props.origin ? <OriginBadge origin={props.origin} /> : null}
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

/** One openable file or skill, labelled with where it comes from. */
function OpenRow(props: {
  label: string;
  origin: WorkspaceItemOrigin;
  path: string | null;
  removed?: boolean;
  onOpen: ((relativePath: string) => void) | null;
}) {
  const openable = props.path !== null && !props.removed && props.onOpen !== null;
  return (
    <button
      type="button"
      disabled={!openable}
      onClick={() => {
        if (props.path !== null) props.onOpen?.(props.path);
      }}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-2xs",
        openable ? "text-foreground hover:bg-muted/60" : "cursor-default text-muted-foreground/70",
      )}
    >
      <FileText className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{props.label}</span>
      {props.removed ? (
        <span className="shrink-0 text-3xs text-muted-foreground">removed here</span>
      ) : null}
      <span className="ml-auto shrink-0">
        <OriginBadge origin={props.origin} />
      </span>
    </button>
  );
}

function FileSection(props: {
  title: string;
  items: ReadonlyArray<WorkspaceFileItem>;
  onOpen: ((relativePath: string) => void) | null;
}) {
  if (props.items.length === 0) return null;
  return (
    <section className="flex flex-col gap-0.5 border-t border-border/40 px-3 py-2">
      <h3 className="text-2xs font-medium text-muted-foreground">{props.title}</h3>
      {props.items.map((item) => (
        <OpenRow
          key={item.path}
          label={item.name}
          origin={item.origin}
          path={item.path}
          removed={item.removed}
          onOpen={props.onOpen}
        />
      ))}
    </section>
  );
}

/** "Original Mr. Mak" (read-only, with its source and revision) or "DevGame Adaptation". */
function CollectionSwitch(props: {
  collections: WorkspaceCollections;
  selected: WorkspaceCollectionId;
  onSelect: (id: WorkspaceCollectionId) => void;
}) {
  const { provenance } = props.collections;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-3 py-2">
      <ToggleGroup
        aria-label="Workspace collection"
        className="w-full *:flex-1"
        value={[props.selected]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "original" || value === "adaptation") props.onSelect(value);
        }}
      >
        <Toggle value="original">Original Mr. Mak</Toggle>
        <Toggle value="adaptation">DevGame Adaptation</Toggle>
      </ToggleGroup>
      {props.selected === "original" ? (
        <p className="break-all text-3xs text-muted-foreground">
          Read-only. Imported from {provenance.repositoryPath} at {provenance.revision.slice(0, 12)}
          {provenance.branch ? ` (${provenance.branch})` : ""}, unchanged since.
        </p>
      ) : (
        <p className="text-3xs text-muted-foreground">
          What this project adapted from Mr. Mak or made itself.
        </p>
      )}
    </div>
  );
}

function WorkspaceBody(props: {
  view: WorkspacePanelView;
  onRetry: () => void;
  useInChat: UseInChat | null;
  evidenceFor: (entityId: string) => RunEvidenceSummaryView | null;
  /** Null for a project that holds no import. */
  collections: WorkspaceCollections | null;
  collectionId: WorkspaceCollectionId;
  onCollectionChange: (id: WorkspaceCollectionId) => void;
  /** Why the import state could not be read, when it could not. */
  importNotice: string | null;
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
      // Every file, imported HTML included, opens in the Files panel's sandboxed preview.
      const onOpen =
        threadRef === null
          ? null
          : (relativePath: string) => openFileInDock(threadRef, relativePath);
      const collections = props.collections;
      const collection = collections ? collections[props.collectionId] : null;
      const cards: ReadonlyArray<{
        readonly card: WorkspaceCardView;
        readonly origin: WorkspaceItemOrigin | undefined;
      }> = collection?.cards ?? view.cards.map((card) => ({ card, origin: undefined }));
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
          {props.importNotice ? (
            <p className="shrink-0 border-b border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
              {props.importNotice}
            </p>
          ) : null}
          {collections ? (
            <CollectionSwitch
              collections={collections}
              selected={props.collectionId}
              onSelect={props.onCollectionChange}
            />
          ) : null}
          {cards.length === 0 && collection === null ? (
            <CenteredMessage>The workspace registry lists no cards yet.</CenteredMessage>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ul>
                {cards.map(({ card, origin }) => (
                  <WorkspaceCard
                    key={card.key}
                    card={card}
                    onOpen={onOpen}
                    openBlockedReason={view.openBlockedReason}
                    useInChat={props.useInChat}
                    evidence={props.evidenceFor(card.entity.id)}
                    origin={origin}
                  />
                ))}
              </ul>
              {collection ? (
                <>
                  <FileSection title="Workflows" items={collection.workflows} onOpen={onOpen} />
                  <FileSection title="Context" items={collection.context} onOpen={onOpen} />
                  {collection.skills.length > 0 ? (
                    <section className="flex flex-col gap-0.5 border-t border-border/40 px-3 py-2">
                      <h3 className="text-2xs font-medium text-muted-foreground">Skills</h3>
                      {collection.skills.map((skill) => (
                        <OpenRow
                          key={skill.name}
                          label={skill.name}
                          origin={skill.origin}
                          path={skill.openPath}
                          onOpen={onOpen}
                        />
                      ))}
                    </section>
                  ) : null}
                </>
              ) : null}
            </div>
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
  // The project's import, from its receipt: it is there again after a switch or reopen.
  const importQuery = useEnvironmentQuery(
    projectRef === null ? null : importStatusAtom(projectRef),
  );
  const [collectionId, setCollectionId] = useState<WorkspaceCollectionId>("original");
  const [importOpen, setImportOpen] = useState(false);
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

  // Error first: after a failure `data` still holds the previous success.
  const collections =
    view.kind === "ready" && importQuery.error === null
      ? resolveWorkspaceCollections({ cards: view.cards, status: importQuery.data })
      : null;
  const refresh = () => {
    query.refresh();
    importQuery.refresh();
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {project && projectRef ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{project.title}</p>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-3xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <Import className="size-3" />
            Import from Mr. Mak…
          </button>
          <button
            type="button"
            onClick={refresh}
            aria-label="Refresh workspace"
            className="inline-flex shrink-0 items-center rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <RefreshCw className="size-3" />
          </button>
          {importOpen ? (
            <ImportDialog
              open
              onOpenChange={setImportOpen}
              destination={{ ref: projectRef, path: project.workspaceRoot }}
              onImported={refresh}
            />
          ) : null}
        </div>
      ) : null}
      <WorkspaceBody
        view={view}
        onRetry={refresh}
        useInChat={useInChat}
        evidenceFor={evidenceFor}
        collections={collections}
        collectionId={collectionId}
        onCollectionChange={setCollectionId}
        importNotice={
          importQuery.error === null
            ? null
            : `Could not read this project's Mr. Mak import: ${importQuery.error}`
        }
      />
    </div>
  );
}
