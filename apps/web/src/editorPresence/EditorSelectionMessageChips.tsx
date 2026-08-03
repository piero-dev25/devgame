// Read-only chip row for a sent message's `<editor_selection>` block,
// rendered in the transcript instead of raw markup. Same visual language as
// the live composer chips (EditorPresenceChipRow.tsx) — `Box` icon, `Pin`
// badge and tint for a pinned entry — so "this rode along pinned" reads the
// same way whether you're about to send it or looking back at it later.
// Deliberately not interactive: nothing here can be clicked, unlike the
// composer's pin toggle — a past message's attachment is a historical fact.
import { Box, Pin } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "~/lib/utils";
import type {
  ExtractedEditorSelection,
  ExtractedEditorSelectionEntry,
} from "./editorSelectionContext";

function buildTooltipContent(entry: ExtractedEditorSelectionEntry): string {
  const lines: string[] = [`${entry.label} (${entry.kind})`];
  if (entry.path) lines.push(entry.path);
  if (entry.detail) lines.push(entry.detail);
  lines.push(entry.pinned ? "Pinned when sent" : "Selected when sent");
  return lines.join("\n");
}

function EditorSelectionMessageChip({ entry }: { readonly entry: ExtractedEditorSelectionEntry }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
              entry.pinned
                ? "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                : "border-border/70 bg-background/70 text-foreground/85",
            )}
          />
        }
      >
        <Box className="size-3 shrink-0" />
        <span className="truncate">{entry.label}</span>
        {entry.pinned ? <Pin aria-hidden className="size-3 shrink-0 opacity-85" /> : null}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {buildTooltipContent(entry)}
      </TooltipPopup>
    </Tooltip>
  );
}

export interface EditorSelectionMessageChipsProps {
  readonly selection: ExtractedEditorSelection;
}

/** Self-gating: renders nothing when the message carried no (recognizable)
 * editor-selection block, so the single call site in MessagesTimeline.tsx
 * needs no surrounding visibility condition. */
export function EditorSelectionMessageChips({ selection }: EditorSelectionMessageChipsProps) {
  if (selection.entries.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {selection.entries.map((entry, index) => (
        <EditorSelectionMessageChip key={`${entry.kind}:${entry.label}:${index}`} entry={entry} />
      ))}
      {selection.truncatedCount > 0 ? (
        <span className="text-[11px] text-muted-foreground/70 italic">
          +{selection.truncatedCount} more not shown
        </span>
      ) : null}
    </div>
  );
}
