// Thin React wrapper around the framework-free connection state machine in
// connection.ts. All reconnect/ticket/parsing logic lives there so it can
// be driven directly in tests without a DOM socket; this hook only owns the
// React lifecycle (open on mount/connection change, dispose on cleanup).
//
// Global scope (owner decision — presence is a property of the connected
// editor, not of a conversation): the caller passes `environmentId`
// straight through. ChatComposer already has it as a prop, so this
// composes directly with no route or thread dependency of its own.
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { usePreparedConnection } from "../state/session";
import {
  EDITOR_PRESENCE_EMPTY_STATE,
  openEditorPresenceConnection,
  type EditorPresenceConnectionState,
} from "./connection";

export type EditorPresenceState = EditorPresenceConnectionState;

export function useEditorPresence(environmentId: EnvironmentId | null): EditorPresenceState {
  const prepared = usePreparedConnection(environmentId);
  const [state, setState] = useState<EditorPresenceState>(EDITOR_PRESENCE_EMPTY_STATE);

  useEffect(() => {
    if (Option.isNone(prepared)) {
      setState(EDITOR_PRESENCE_EMPTY_STATE);
      return;
    }
    const connection = prepared.value;
    setState(EDITOR_PRESENCE_EMPTY_STATE);

    const opened = openEditorPresenceConnection({
      httpBaseUrl: connection.httpBaseUrl,
      socketUrl: connection.socketUrl,
      httpAuthorization: connection.httpAuthorization,
      onStateChange: setState,
    });
    return () => opened.dispose();
  }, [prepared]);

  return state;
}
