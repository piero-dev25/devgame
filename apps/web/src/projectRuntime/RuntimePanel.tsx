/**
 * The Run dock panel: the project's run profiles (`devgame.runtime.json`),
 * Launch and Stop on the thread's own environment, each run's state as the
 * server reports it, and a log tail. A thin renderer over
 * `resolveRuntimePanelView`, which holds every decision.
 *
 * Launch starts the profile's native executable on the environment's machine;
 * its window (e.g. Kaigen) stays a separate native window. This is not the
 * Unity editor's Play/Stop toolbar in the chat header.
 *
 * Web and desktop only: mobile has no dock.
 */
import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { AlertTriangle, Play, RefreshCw, Square } from "lucide-react";
import { type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react";

import { resolveEngineChipState } from "~/components/ChatView.logic";
import { ThreadRouteContext, type ThreadRouteContextValue } from "~/dock/ChatPanel";
import type { PanelProps } from "~/dock/lib/types";
import { useRouteProjectRef } from "~/dock/useRouteProjectRef";
import { cn } from "~/lib/utils";
import { useProject } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { usePreparedConnection } from "~/state/session";

import {
  describeRuntimeCommand,
  postRuntimeStart,
  postRuntimeStop,
  type RuntimeCommandOutcome,
} from "./postRuntimeCommand";
import {
  isRuntimeLogPinned,
  resolveRuntimePanelView,
  type RuntimePendingCommand,
  type RuntimeProfileRow,
  type RuntimeReceipt,
} from "./resolveRuntimePanelView";
import { runtimeStatusAtom } from "./runtimeStatusAtom";

const TONE_DOT: Readonly<Record<NonNullable<RuntimeProfileRow["run"]>["tone"], string>> = {
  active: "bg-warning",
  ok: "bg-success",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/50",
};

function Centered(props: { children: ReactNode }) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center text-xs text-muted-foreground/70">
      {props.children}
    </div>
  );
}

function ProfileRow(props: {
  row: RuntimeProfileRow;
  selected: boolean;
  onSelect: () => void;
  onLaunch: () => void;
  onStop: () => void;
}) {
  const { row } = props;
  const button =
    "inline-flex shrink-0 items-center gap-1 rounded border border-border/60 px-2 py-0.5 text-2xs hover:bg-muted/60 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";
  return (
    <li
      className={cn(
        "flex flex-col gap-1 border-b border-border/40 px-3 py-2",
        props.selected && "bg-muted/40",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={props.onSelect}
          className="min-w-0 flex-1 truncate text-left text-xs font-medium text-foreground"
        >
          {row.name}
        </button>
        {row.run?.status === "starting" || row.run?.status === "running" ? (
          <button type="button" disabled={!row.canStop} onClick={props.onStop} className={button}>
            <Square className="size-3" />
            {row.pendingLabel ?? "Stop run"}
          </button>
        ) : (
          <button
            type="button"
            disabled={!row.canLaunch}
            onClick={props.onLaunch}
            className={button}
          >
            <Play className="size-3" />
            {row.pendingLabel ?? "Launch"}
          </button>
        )}
      </div>
      {row.run ? (
        <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span className={cn("inline-flex size-1.5 rounded-full", TONE_DOT[row.run.tone])} />
          <span className="min-w-0 truncate">{row.run.label}</span>
        </p>
      ) : null}
      {row.unavailableReason ? (
        <p className="flex items-start gap-1.5 text-2xs text-warning">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {row.unavailableReason}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The selected run's log. It opens at the newest lines and follows new output
 * on each poll, unless the reader has scrolled up to read older lines.
 */
function RuntimeLog(props: { lines: ReadonlyArray<string> }) {
  const ref = useRef<HTMLPreElement>(null);
  // Starts pinned so a log longer than the view opens at its end.
  const pinned = useRef(true);
  const text = props.lines.length > 0 ? props.lines.join("\n") : "No output yet.";
  // After every render (each poll re-renders): while pinned, stay at the end.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  });
  return (
    <pre
      ref={ref}
      onScroll={(event) => {
        pinned.current = isRuntimeLogPinned(event.currentTarget);
      }}
      className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-3xs text-foreground/80"
    >
      {text}
    </pre>
  );
}

function RuntimeBody(props: { route: ThreadRouteContextValue; projectRef: ScopedProjectRef }) {
  const { route, projectRef } = props;
  const project = useProject(projectRef);
  const prepared = usePreparedConnection(projectRef.environmentId);
  const query = useEnvironmentQuery(runtimeStatusAtom(projectRef));
  const [receipt, setReceipt] = useState<RuntimeReceipt | null>(null);
  const [pending, setPending] = useState<RuntimePendingCommand | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  const current = Option.getOrNull(prepared);
  const view = resolveRuntimePanelView({
    engine: resolveEngineChipState(project ?? null),
    connectionReady: current !== null,
    query: {
      data:
        query.data === null
          ? null
          : {
              status: query.data.status,
              requestedAt: query.data.requestedAt,
              onCurrentConnection: query.data.prepared === current,
            },
      error: query.error,
    },
    receipt,
    pending,
    selectedProfileId,
  });

  const send = async (
    command: RuntimePendingCommand,
    post: (connection: NonNullable<typeof current>) => Promise<RuntimeCommandOutcome>,
  ) => {
    if (current === null) return;
    setPending(command);
    setNotice(null);
    try {
      const outcome = await post(current);
      if (outcome._tag === "accepted") {
        setReceipt({ run: outcome.run, receivedAt: outcome.receivedAt });
      }
      setNotice(describeRuntimeCommand(command.kind, outcome));
    } catch (error) {
      // Typed failures already resolve as outcomes; only a defect lands here.
      const message = error instanceof Error ? error.message : String(error);
      setNotice(describeRuntimeCommand(command.kind, { _tag: "unexpected", message }));
    } finally {
      setPending(null);
      // Read the server's state again whatever happened.
      query.refresh();
    }
  };

  const header = project ? (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{project.title}</p>
      <button
        type="button"
        onClick={query.refresh}
        aria-label="Refresh run status"
        className="inline-flex shrink-0 items-center rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <RefreshCw className="size-3" />
      </button>
    </div>
  ) : null;
  if (view.kind === "loading") {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {header}
        <Centered>Reading run profiles…</Centered>
      </div>
    );
  }

  const selected = view.rows.find((row) => row.profileId === view.selectedProfileId) ?? null;
  const banner = view.banner;
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {header}
      {banner || notice || view.profilesError ? (
        <div className="flex shrink-0 flex-col gap-1 border-b border-border/60 bg-warning/5 px-3 py-2 text-2xs text-muted-foreground">
          {banner ? <p className="text-foreground">{banner.text}</p> : null}
          {!view.live && view.asOf !== null && view.rows.length > 0 ? (
            <p>
              Last known as of {new Date(view.asOf).toLocaleTimeString()}. It may have changed;
              Launch and Stop are off until the server answers.
            </p>
          ) : null}
          {notice ? <p>{notice}</p> : null}
          {view.profilesError ? (
            <p>devgame.runtime.json could not be read: {view.profilesError}</p>
          ) : null}
        </div>
      ) : null}
      {view.guidance ? <Centered>{view.guidance}</Centered> : null}
      {view.rows.length > 0 ? (
        <ul className={cn("shrink-0", !view.live && "opacity-60")}>
          {view.rows.map((row) => (
            <ProfileRow
              key={row.profileId}
              row={row}
              selected={row.profileId === view.selectedProfileId}
              onSelect={() => setSelectedProfileId(row.profileId)}
              onLaunch={() =>
                void send({ kind: "start", profileId: row.profileId }, (connection) =>
                  postRuntimeStart({
                    prepared: connection,
                    projectId: projectRef.projectId,
                    profileId: row.profileId,
                    threadId: route.routeKind === "server" ? route.threadId : null,
                  }),
                )
              }
              onStop={() => {
                const runId = row.run?.runId;
                if (runId === undefined) return;
                void send({ kind: "stop", runId }, (connection) =>
                  postRuntimeStop({
                    prepared: connection,
                    projectId: projectRef.projectId,
                    runId,
                  }),
                );
              }}
            />
          ))}
        </ul>
      ) : null}
      {selected?.run ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="shrink-0 px-3 pt-2 text-3xs uppercase tracking-wide text-muted-foreground">
            Log · {selected.name}
            {selected.run.logTruncated ? " (latest lines)" : ""}
          </p>
          {/* Keyed so another profile's log, or a new run, opens at its newest lines. */}
          <RuntimeLog
            key={`${selected.profileId}:${selected.run.runId}`}
            lines={selected.run.logLines}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function RuntimePanel(_props: PanelProps) {
  const route = useContext(ThreadRouteContext);
  const projectRef = useRouteProjectRef(route);
  if (route === null) {
    return <Centered>Select a thread to see this project's run profiles.</Centered>;
  }
  if (projectRef === null) return <Centered>Reading run profiles…</Centered>;
  // Keyed so receipts and selection never carry over to another project.
  return <RuntimeBody key={scopedProjectKey(projectRef)} route={route} projectRef={projectRef} />;
}
