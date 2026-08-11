// Container: wires the live socket (useEditorPresence) and the pin store
// (store.ts) together into the props EditorPresenceChipRow renders. This is
// the piece ChatComposer.tsx mounts, so it also publishes the RENDERED chip
// list to the shared read-model ChatView.tsx's send path reads from (see
// store.ts's `publishCurrentEditorPresenceChips` doc for why that isn't a
// hook).
//
// Superseded claim: this used to describe itself as "the composer's ONE
// always-live instance (per the 'chips appear before you type'
// requirement)" — already false before the no-engine-ui rework
// (ChatComposer.tsx:2899-2902 unmounts it for a mobile-collapsed composer,
// an active approval, or a pending user input), and now false on a fourth
// condition too: a "none" (non-game) project. See
// docs/specs/no-engine-ui-for-non-game-projects.md.
import type { EngineType, EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { EditorPresenceChipRow } from "./EditorPresenceChipRow";
import {
  deriveLiveEditorPresenceChips,
  publishCurrentEditorPresenceChips,
  publishCurrentEditorPresenceEditors,
  resolveEditorPresenceChipsView,
  useEditorPresencePinStore,
} from "./store";
import { useEditorPresence } from "./useEditorPresence";

export interface EditorPresenceChipsProps {
  readonly environmentId: EnvironmentId;
  /** The active thread's project workspace root — `null` for a draft with
   * no project resolved yet. Threaded straight into
   * `resolveEditorPresenceChipsView`'s project scoping; see that function's
   * own doc comment. */
  readonly workspaceRoot: string | null;
  /** The three-state engine signal (`resolveEngineChipState`,
   * `ChatView.logic.ts`) — `"none"` hides the row entirely. Normally this
   * container is never even mounted for a "none" project (ChatComposer's
   * own mount gate), so this is a second, cheaper gate rather than the
   * only one — see `resolveEditorPresenceChipsView`'s doc comment. */
  readonly engineChipState: "unknown" | "none" | EngineType;
  readonly className?: string | undefined;
}

export function EditorPresenceChips({
  environmentId,
  workspaceRoot,
  engineChipState,
  className,
}: EditorPresenceChipsProps) {
  const { editors, phase, disconnectReason } = useEditorPresence(environmentId);
  const pinned = useEditorPresencePinStore((store) => store.pinned);
  const togglePin = useEditorPresencePinStore((store) => store.togglePin);

  const liveChips = deriveLiveEditorPresenceChips(editors);
  const view = resolveEditorPresenceChipsView({
    liveChips,
    pinned,
    workspaceRoot,
    engineChipState,
  });
  const chips = view.kind === "chips" ? view.chips : [];

  // Both snapshots in ONE effect so they can never describe different
  // presence frames: the `<engine>` headline reports editor-level state the
  // chips deliberately do not carry, but it must describe the same instant
  // the attached selection came from. Publish follows render BY
  // CONSTRUCTION — `chips` here is the exact list `EditorPresenceChipRow`
  // below renders, never a separately-filtered value, so "what you see is
  // what you send" holds without the two ever being able to drift.
  useEffect(() => {
    publishCurrentEditorPresenceChips(chips);
    publishCurrentEditorPresenceEditors(editors);
    return () => {
      publishCurrentEditorPresenceChips([]);
      publishCurrentEditorPresenceEditors([]);
    };
  }, [chips, editors]);

  return (
    <EditorPresenceChipRow
      chips={chips}
      phase={phase}
      disconnectReason={disconnectReason}
      onTogglePin={togglePin}
      className={className}
    />
  );
}
