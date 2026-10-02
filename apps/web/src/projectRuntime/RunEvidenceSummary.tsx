/**
 * One run's recorded evidence: outcome, freshness, provenance, log checks and
 * artifacts. Shared by the Run panel (a profile's latest run) and the
 * Workspace panel (runs linked to a card). A thin renderer over
 * `runEvidenceView.ts`.
 */
import { Check, FileImage, FileText, X } from "lucide-react";

import { cn } from "~/lib/utils";

import type { RunEvidenceSummaryView } from "./runEvidenceView";

const FRESHNESS_TONE: Readonly<Record<RunEvidenceSummaryView["freshness"], string>> = {
  fresh: "border-success/40 text-success",
  stale: "border-warning/50 text-warning",
  unknown: "border-border/60 text-muted-foreground",
};

export function RunEvidenceSummary(props: {
  evidence: RunEvidenceSummaryView;
  /** Opens a project-relative artifact in the Files panel; null when nothing can open. */
  onOpen: ((relativePath: string) => void) | null;
  /** Shown above the outcome, e.g. that this evidence is from an earlier run; or null. */
  note: string | null;
}) {
  const { evidence } = props;
  return (
    <div className="flex flex-col gap-1 rounded border border-border/50 px-2 py-1.5 text-2xs">
      {props.note ? <p className="text-muted-foreground">{props.note}</p> : null}
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "inline-flex size-1.5 shrink-0 rounded-full",
            evidence.passed ? "bg-success" : "bg-destructive",
          )}
        />
        <span className="font-medium text-foreground">
          Evidence · {evidence.passed ? "Passed" : "Failed"}
        </span>
        <span
          className={cn(
            "rounded-full border px-1.5 text-3xs uppercase tracking-wide",
            FRESHNESS_TONE[evidence.freshness],
          )}
        >
          {evidence.freshnessLabel}
        </span>
        <span className="ml-auto shrink-0 text-3xs text-muted-foreground">
          {new Date(evidence.endedAt).toLocaleString()}
        </span>
      </div>
      {evidence.freshnessReasons.map((reason) => (
        <p key={reason} className="text-warning">
          {reason}
        </p>
      ))}
      {evidence.failures.map((failure) => (
        <p key={failure} className="text-destructive">
          {failure}
        </p>
      ))}
      <p className="break-all text-muted-foreground">{evidence.sourceLabel}</p>
      <p className="break-all text-muted-foreground">{evidence.buildLabel}</p>
      {evidence.stepPath ? (
        <p className="break-all text-muted-foreground">For step {evidence.stepPath}</p>
      ) : null}
      {evidence.checks.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {evidence.checks.map((check) => (
            <li key={check.key} className="flex min-w-0 items-start gap-1">
              {check.ok ? (
                <Check className="mt-0.5 size-3 shrink-0 text-success" />
              ) : (
                <X className="mt-0.5 size-3 shrink-0 text-destructive" />
              )}
              <span className="shrink-0">{check.label}</span>
              {/* A failed check shows the line the program printed, e.g. the wrong age. */}
              <span className="min-w-0 break-all font-mono text-3xs text-muted-foreground">
                {check.ok || check.line === null ? check.pattern : check.line}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {evidence.artifacts.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {evidence.artifacts.map((artifact) => {
            const openPath = artifact.openPath;
            const Icon = artifact.kind === "image" ? FileImage : FileText;
            return (
              <li key={artifact.key} className="flex min-w-0 flex-col">
                <div className="flex min-w-0 items-center gap-1">
                  <Icon
                    className={cn(
                      "size-3 shrink-0",
                      artifact.ok ? "text-muted-foreground" : "text-destructive",
                    )}
                  />
                  {openPath !== null && props.onOpen !== null ? (
                    <button
                      type="button"
                      onClick={() => props.onOpen?.(openPath)}
                      className="min-w-0 truncate text-left text-foreground underline-offset-2 hover:underline"
                    >
                      {artifact.name}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate">{artifact.name}</span>
                  )}
                  <span
                    className={cn(
                      "ml-auto shrink-0 text-3xs",
                      artifact.ok ? "text-muted-foreground" : "text-destructive",
                    )}
                  >
                    {artifact.detail}
                  </span>
                </div>
                <p className="break-all pl-4 font-mono text-3xs text-muted-foreground/80">
                  {artifact.path}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
