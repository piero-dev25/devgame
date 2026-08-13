/**
 * The Generation dock panel — Increment 2b.1
 * (docs/v2/specs/increment-2b1-generation-panel.md), the HUMAN half of
 * charter §69's "the loop is the product: agent AND human views." An agent
 * calls `generate_3d` (MCP); this panel is where a person SEES that same
 * job go running -> succeeded, with a rendered thumbnail and triangle
 * count, without needing to ask the agent "how's it going."
 *
 * IDENTITY: `useParams` + `resolveThreadRouteRef`, the SAME mechanism
 * `DiffDockPanel.tsx` uses (see that file's own doc comment for why this is
 * preferred over `ThreadRouteContext` when a panel has no existing identity
 * mechanism of its own to preserve — this is a brand-new panel, so there is
 * nothing to preserve either way, and `useParams` needs no `ChatPanel.tsx`
 * context plumbing).
 *
 * Read-only, poll-refreshed (`generationListAtom.ts`) — no mutation, no
 * "Import to Unity" button, no GLB viewer; all three are named OUT of scope
 * in the spec (2b.2+). `singleton: true` (`ChatDock.tsx`'s registration):
 * ONE panel, an internal scrollable list, never multiple instances.
 */
import { useParams } from "@tanstack/react-router";
import type { GenerationListEntry, GenerationStatus } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { AlertTriangle, Boxes, Loader2, RefreshCw, Sparkles } from "lucide-react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { usePreparedConnection } from "~/state/session";
import { useThread } from "~/state/entities";
import { resolveThreadRouteRef } from "~/threadRoutes";

import { generationListAtom } from "../generation/generationListAtom";
import type { PanelProps } from "./lib/types";

/** Semantic status tokens already established for provider/connection
 * status pills elsewhere in this app (`components/settings/providerStatus.ts`)
 * — reused rather than inventing a parallel palette. */
const STATUS_STYLES: Readonly<
  Record<
    GenerationStatus,
    { readonly dot: string; readonly label: string; readonly pulse: boolean }
  >
> = {
  created: { dot: "bg-muted-foreground/50", label: "Queued", pulse: false },
  running: { dot: "bg-warning", label: "Running", pulse: true },
  succeeded: { dot: "bg-success", label: "Succeeded", pulse: false },
  failed: { dot: "bg-destructive", label: "Failed", pulse: false },
  cancelled: { dot: "bg-muted-foreground/50", label: "Cancelled", pulse: false },
};

function StatusPill(props: { status: GenerationStatus }) {
  const style = STATUS_STYLES[props.status];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      <span className="relative flex size-1.5">
        {style.pulse ? (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-60",
              style.dot,
            )}
          />
        ) : null}
        <span className={cn("relative inline-flex size-1.5 rounded-full", style.dot)} />
      </span>
      {style.label}
    </span>
  );
}

function ProgressBar(props: { progress: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-foreground/70 transition-[width] duration-500 ease-out"
        style={{ width: `${Math.max(0, Math.min(100, props.progress))}%` }}
      />
    </div>
  );
}

function GenerationRow(props: { entry: GenerationListEntry; previewSrc: string | null }) {
  const { job, asset } = props.entry;
  const isTerminal =
    job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
  return (
    <li className="flex gap-3 border-b border-border/40 px-3 py-3 last:border-b-0">
      <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/40">
        {props.previewSrc ? (
          // Thumbnail only, per this increment's scope — no GLB viewer (2b.2+).
          <img
            src={props.previewSrc}
            alt={`Preview of "${job.prompt}"`}
            className="size-full object-cover"
            loading="lazy"
          />
        ) : job.status === "failed" ? (
          <AlertTriangle className="size-5 text-destructive/70" />
        ) : (
          <Boxes className="size-5 text-muted-foreground/50" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 truncate text-xs font-medium text-foreground" title={job.prompt}>
            {job.prompt}
          </p>
          <StatusPill status={job.status} />
        </div>
        {!isTerminal ? <ProgressBar progress={job.progress} /> : null}
        {job.status === "failed" && job.error ? (
          <p className="truncate text-[11px] text-destructive/80" title={job.error}>
            {job.error}
          </p>
        ) : asset ? (
          <p className="text-[11px] text-muted-foreground">
            {asset.metadata.triangles.toLocaleString()} triangles
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground/70">{STATUS_STYLES[job.status].label}…</p>
        )}
      </div>
    </li>
  );
}

export default function GenerationDockPanel(_props: PanelProps) {
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThread = useThread(routeThreadRef);
  const activeEnvironmentId = activeThread?.environmentId ?? null;
  const activeProjectId = activeThread?.projectId ?? null;
  const preparedConnection = usePreparedConnection(activeEnvironmentId);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;

  const query = useEnvironmentQuery(
    activeEnvironmentId !== null && activeProjectId !== null
      ? generationListAtom({ environmentId: activeEnvironmentId, projectId: activeProjectId })
      : null,
  );

  if (!routeThreadRef || activeProjectId === null || activeEnvironmentId === null) {
    return (
      <div className="flex h-full min-w-0 flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Select a thread to see this project's generation jobs.
      </div>
    );
  }

  if (query.error !== null) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
        <AlertTriangle className="size-5 text-destructive/70" />
        <p className="text-xs text-muted-foreground">{query.error}</p>
        <button
          type="button"
          onClick={query.refresh}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <RefreshCw className="size-3" />
          Try again
        </button>
      </div>
    );
  }

  if (query.data === null) {
    return (
      <div className="flex h-full min-w-0 flex-1 items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground/50" />
      </div>
    );
  }

  if (query.data.entries.length === 0) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
        <Sparkles className="size-5 text-muted-foreground/40" />
        {/* Real empty state, not a failure — the registry is in-memory and
            dies on server restart, so "nothing here yet" is the normal
            starting point, per the spec's own acceptance note. */}
        <p className="text-xs text-muted-foreground/70">
          No generations yet. Ask the agent to generate a 3D asset for this project.
        </p>
      </div>
    );
  }

  return (
    <ul className="h-full min-w-0 flex-1 divide-y divide-border/40 overflow-y-auto">
      {query.data.entries.map((entry) => (
        <GenerationRow
          key={entry.job.id}
          entry={entry}
          previewSrc={
            entry.previewMediaUrl !== null && httpBaseUrl !== null
              ? resolveAssetUrl(httpBaseUrl, entry.previewMediaUrl)
              : null
          }
        />
      ))}
    </ul>
  );
}
