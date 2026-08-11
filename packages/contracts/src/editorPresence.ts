// Contract shape for the browser -> server leg of an Editor Presence
// command dispatch (task #52's toolbar). The server -> engine leg (the
// actual `command`/`commandResult` WEBSOCKET frames) is documented in
// docs/workbench/spec-editor-presence-commands.md and implemented in
// apps/server/src/editorPresence/protocol.ts / EditorPresenceRoute.ts —
// this file covers ONLY the HTTP request a browser sends to trigger one,
// which (until this task) had no contract at all: `dispatchEditorCommand`
// existed server-side with nothing client-reachable calling it.
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * `sessionId` identifies which connected publisher (engine) to address —
 * see `EditorPresenceEntry.session.id` in apps/web's
 * `editorPresence/protocol.ts`, obtained from a live `presence` frame.
 * `action`/`params` mirror the server -> engine command frame's own
 * `action`/`params` fields exactly (open string, per
 * spec-editor-presence-commands.md — new actions must not require a
 * contract change here).
 */
export const EditorPresenceDispatchCommandInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  action: TrimmedNonEmptyString,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type EditorPresenceDispatchCommandInput = typeof EditorPresenceDispatchCommandInput.Type;

/**
 * Mirrors `dispatchEditorCommand`'s own `EditorPresenceCommandOutcome`
 * server-side — restated here (not imported) since apps/server internals
 * don't flow into packages/contracts. `ok: true` means the command reached
 * a plugin that understood it, NEVER that the engine is now playing — see
 * spec-unity-play-stop.md's "acceptance is an edge, play state is a level"
 * ruling. `error` is a short, machine-readable reason (`"insufficient_scope"`,
 * `"editor_not_connected"`, `"unsupported_action"`, ...), never a sentence.
 */
export const EditorPresenceDispatchCommandResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type EditorPresenceDispatchCommandResult = typeof EditorPresenceDispatchCommandResult.Type;

/** The route this input is posted to — kept alongside the schema so the one
 * client call site and the one server route definition can both import a
 * single literal rather than two independently-typed string constants that
 * could drift. */
export const EDITOR_PRESENCE_DISPATCH_COMMAND_PATH = "/editor-presence/command";
