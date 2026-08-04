// Contract shape for the browser -> server leg of a Unity Play/Stop/Pause
// command. Unity does NOT go through Editor Presence at all (see
// docs/workbench/spec-unity-play-stop.md's status note and unity/README.md)
// — it goes through Unity's own official `com.unity.pipeline` package /
// `unity` CLI, wrapped server-side by
// apps/server/src/unity/UnityPipelineClient.ts. This file is the deliberate
// analog of editorPresence.ts's EditorPresenceDispatchCommandInput/Result —
// same overall SHAPE (a POST'd input schema, a route path constant exported
// alongside it, a result schema the client renders states off of) so a
// caller has two similar-looking things to call rather than two
// differently-shaped ones, per the coordination between these two lanes —
// but the CONTENTS differ where they have to.
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Closed union, unlike EditorPresenceDispatchCommandInput's open `action`
 * string — that one has to stay open because it flows straight through to
 * a third-party-extensible WIRE protocol (`command.action`,
 * spec-editor-presence-commands.md). This one does not: it is entirely our
 * own client/server contract with a fixed, known operation set (no
 * `"step"` — Unity's Pipeline CLI has no frame-step command, confirmed
 * live against `unity command --json`'s own listing), so a closed union
 * buys real type safety on both ends for no cost.
 */
export const UnityCommandAction = Schema.Literals(["play", "stop", "pause", "status"]);
export type UnityCommandAction = typeof UnityCommandAction.Type;

/**
 * `workspaceRoot` is the Unity project's filesystem root — the same value
 * Editor Presence's own `workspace.root` names (see EditorPresenceEntry),
 * so a client that already resolves "which project" for the presence path
 * can reuse the identical value here without a second resolution.
 */
export const UnityCommandInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  action: UnityCommandAction,
});
export type UnityCommandInput = typeof UnityCommandInput.Type;

export const UnityPlayMode = Schema.Literals(["stopped", "playing", "paused"]);
export type UnityPlayMode = typeof UnityPlayMode.Type;

export const UnityEditorStatus = Schema.Struct({
  status: Schema.String,
  compiling: Schema.Boolean,
  domainReloadInProgress: Schema.Boolean,
  playMode: UnityPlayMode,
  unityVersion: Schema.String,
});
export type UnityEditorStatus = typeof UnityEditorStatus.Type;

/**
 * Mirrors `UnityPipelineClient.ts`'s own `UnityPipelineResult<A>` exactly —
 * restated here (not imported) since apps/server internals don't flow into
 * packages/contracts, same reasoning EditorPresenceDispatchCommandResult's
 * own doc comment gives for not importing `EditorPresenceCommandOutcome`.
 *
 * NON-NEGOTIABLE, per the owner's explicit ruling on this contract:
 * `notReady` ("Unity isn't open for this project", or mid domain-reload)
 * and `cliUnavailable` ("the `unity` CLI isn't installed") MUST reach the
 * client as their OWN distinct states, never collapsed into `error`. A
 * client that only sees `{ok:false, error:string}` (the presence route's
 * shape) cannot render "no Editor is open" and "this genuinely broke" as
 * the different things they are — the whole point of modelling this
 * server-side was to let the Play button say something true instead of
 * spinning or timing out.
 */
export const UnityCommandResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("ok"), value: UnityEditorStatus }),
  Schema.Struct({ _tag: Schema.Literal("notReady") }),
  Schema.Struct({ _tag: Schema.Literal("cliUnavailable") }),
  Schema.Struct({ _tag: Schema.Literal("error"), message: Schema.String }),
]);
export type UnityCommandResult = typeof UnityCommandResult.Type;

/** The route this input is posted to — kept alongside the schema so the one
 * client call site and the one server route definition both import a
 * single literal rather than two independently-typed string constants that
 * could drift, same convention as EDITOR_PRESENCE_DISPATCH_COMMAND_PATH. */
export const UNITY_COMMAND_PATH = "/unity/command";
