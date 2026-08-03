// Container: wires the live socket (useEditorPresence) and the pin store
// (store.ts) together into the props EditorPresenceChipRow renders. This is
// the piece ChatComposer.tsx mounts — the composer's ONE always-live
// instance (per the "chips appear before you type" requirement), so it
// also publishes the merged chip list to the shared read-model
// ChatView.tsx's send path reads from (see store.ts's
// `publishCurrentEditorPresenceChips` doc for why that isn't a hook).
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { EditorPresenceChipRow } from "./EditorPresenceChipRow";
import {
  deriveLiveEditorPresenceChips,
  mergeEditorPresenceChips,
  publishCurrentEditorPresenceChips,
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

  useEffect(() => {
    publishCurrentEditorPresenceChips(chips);
    return () => publishCurrentEditorPresenceChips([]);
  }, [chips]);

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
