// Container: wires the live socket (useEditorPresence) and the pin store
// (store.ts) together into the props EditorPresenceChipRow renders. This is
// the piece ChatComposer.tsx mounts.
import type { EnvironmentId } from "@t3tools/contracts";

import { EditorPresenceChipRow } from "./EditorPresenceChipRow";
import {
  deriveLiveEditorPresenceChips,
  mergeEditorPresenceChips,
  useEditorPresencePinStore,
} from "./store";
import { useEditorPresence } from "./useEditorPresence";

export interface EditorPresenceChipsProps {
  readonly environmentId: EnvironmentId;
  readonly className?: string | undefined;
}

export function EditorPresenceChips({ environmentId, className }: EditorPresenceChipsProps) {
  const { editors, phase, disconnectReason } = useEditorPresence(environmentId);
  const pinned = useEditorPresencePinStore((store) => store.pinned);
  const togglePin = useEditorPresencePinStore((store) => store.togglePin);

  const liveChips = deriveLiveEditorPresenceChips(editors);
  const chips = mergeEditorPresenceChips(liveChips, pinned);
  // A reason is only worth showing while we're not actively connected —
  // once reconnected it's stale by definition.
  const shownReason = phase === "connected" ? null : disconnectReason;

  return (
    <EditorPresenceChipRow
      chips={chips}
      disconnectReason={shownReason}
      onTogglePin={togglePin}
      className={className}
    />
  );
}
