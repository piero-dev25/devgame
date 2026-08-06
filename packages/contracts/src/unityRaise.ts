import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

/**
 * The caller supplies only the server-issued project id. The server resolves
 * the canonical workspace root before checking liveness or launching Unity;
 * no filesystem path crosses this route's trust boundary.
 */
export const UnityRaiseInput = Schema.Struct({ projectId: ProjectId });
export type UnityRaiseInput = typeof UnityRaiseInput.Type;

export const UnityRaiseResult = Schema.Union([
  Schema.TaggedStruct("raised", {}),
  Schema.TaggedStruct("coldStartStarted", {}),
  Schema.TaggedStruct("error", { message: Schema.String }),
]);
export type UnityRaiseResult = typeof UnityRaiseResult.Type;

export const UNITY_RAISE_PATH = "/unity/raise";
