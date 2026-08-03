// Presentational chip row — no socket, no store, no hooks beyond what React
// itself provides. Kept separate from EditorPresenceChips.tsx (the
// container that wires this up to the live socket + pin store) so it can be
// exercised with plain, hand-built props — this repo's web tests render
// components via `renderToStaticMarkup`, not a mounted DOM, so a component
// that needs a live WebSocket or an Effect atom in scope to render at all
// isn't practically testable that way.
//
// Own icon per the frozen spec ("own chip component with its own icon") —
// `Box` rather than `MousePointerClick` (used by the unrelated
// `<element_context>` rail this deliberately does not reuse).
//
// Click-to-pin: a pinned chip keeps riding along with the next message even
// after the live editor selection moves past it, until clicked again to
// unpin. Pinned and live chips coexist in the same row and are visually
// distinguished (tinted + a pin glyph vs. plain outline).
//
// Persistent connection indicator: required in step 1, not deferred
// (docs/workbench/spec-editor-presence.md) — a Unity domain reload kills
// the socket on every play-mode entry and every recompile, so reconnecting
// is the dominant runtime state there, not an edge case. Shown even with
// zero chips so a mid-session drop is visible rather than the composer
// just going quiet; hidden while connected and healthy so it never becomes
// a permanent widget.
import { Box, Pin } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../components/composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { EditorPresenceConnectionPhase } from "./connection";
import type { EditorPresenceRenderChip } from "./store";

function buildTooltipContent(item: EditorPresenceRenderChip): string {
  const lines: string[] = [item.label, `${item.editorName} · ${item.kind}`];
  if (item.path) lines.push(item.path);
  if (item.detail) lines.push(item.detail);
  lines.push(item.pinned ? "Pinned — click to unpin" : "Click to pin");
  return lines.join("\n");
}

interface EditorPresenceChipProps {
  readonly item: EditorPresenceRenderChip;
  readonly onToggle: (item: EditorPresenceRenderChip) => void;
}

function EditorPresenceChip({ item, onToggle }: EditorPresenceChipProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-pressed={item.pinned}
            aria-label={item.pinned ? `${item.label} (pinned)` : item.label}
            onClick={() => onToggle(item)}
            className={cn(
              COMPOSER_INLINE_CHIP_CLASS_NAME,
              "cursor-pointer pr-1.5",
              item.pinned &&
                "border-blue-500/40 bg-blue-500/10 text-blue-700 hover:bg-blue-500/15 dark:text-blue-300",
            )}
          />
        }
      >
        <Box className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
        <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{item.label}</span>
        {item.pinned ? (
          <Pin aria-hidden className="size-3 shrink-0 opacity-85" data-testid="pin-indicator" />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {buildTooltipContent(item)}
      </TooltipPopup>
    </Tooltip>
  );
}

export interface EditorPresenceChipRowProps {
  readonly chips: ReadonlyArray<EditorPresenceRenderChip>;
  readonly phase: EditorPresenceConnectionPhase;
  /** Verbatim reason from the socket's most recent close (owner
   * requirement — never a generic "disconnected"). `null` before any close
   * has happened, e.g. still on the first connect attempt. */
  readonly disconnectReason: string | null;
  readonly onTogglePin: (item: EditorPresenceRenderChip) => void;
  readonly className?: string | undefined;
}

/**
 * What the persistent connection indicator says, or `null` to show
 * nothing — the "quiet when connected and healthy" rule. `connecting`
 * always gets a label (even with a stale reason from a prior attempt still
 * around) because it's the more current, more useful thing to say; a
 * `disconnected` phase with no reason yet (the very first render, before
 * any attempt has resolved) has nothing worth saying either.
 */
function connectionStatusLabel(
  phase: EditorPresenceConnectionPhase,
  disconnectReason: string | null,
): string | null {
  if (phase === "connected") return null;
  if (phase === "connecting") return "connecting…";
  return disconnectReason;
}

/** Self-gating: renders nothing when there is nothing to show (no chips,
 * live or pinned, and the connection is healthy), so the single call site
 * in ChatComposer.tsx needs no surrounding visibility condition. */
export function EditorPresenceChipRow({
  chips,
  phase,
  disconnectReason,
  onTogglePin,
  className,
}: EditorPresenceChipRowProps) {
  const statusLabel = connectionStatusLabel(phase, disconnectReason);
  if (chips.length === 0 && statusLabel === null) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {chips.map((item) => (
        <EditorPresenceChip key={item.key} item={item} onToggle={onTogglePin} />
      ))}
      {statusLabel !== null ? (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/70 italic"
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              phase === "connecting" ? "animate-pulse bg-amber-500" : "bg-red-500/70",
            )}
          />
          Editor presence: {statusLabel}
        </span>
      ) : null}
    </div>
  );
}
