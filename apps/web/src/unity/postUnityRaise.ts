import {
  type ProjectId,
  type UnityRaiseResult,
  UNITY_RAISE_PATH,
  UnityRaiseResult as UnityRaiseResultSchema,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { postForkEnvironmentRoute } from "../lib/forkEnvironmentRoute";
import { runtime } from "../lib/runtime";

const decodeUnityRaiseResult = Schema.decodeUnknownEffect(UnityRaiseResultSchema);

/** Bounds the whole authenticated call. A raise may first run the cold-start
 * check through the `unity` CLI server-side, so this leaves room for that. */
const UNITY_RAISE_TIMEOUT_MS = 2 * 60_000;

function postEffect(input: {
  readonly projectId: ProjectId;
  readonly prepared: PreparedConnection;
}) {
  return Effect.gen(function* () {
    // A `presence:command`-scope refusal is a text 403, which the shared
    // helper fails as an undeclared status before any decode is attempted.
    const body = yield* postForkEnvironmentRoute({
      prepared: input.prepared,
      path: UNITY_RAISE_PATH,
      body: { projectId: input.projectId },
      timeoutMs: UNITY_RAISE_TIMEOUT_MS,
    });
    return yield* decodeUnityRaiseResult(body);
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

export function postUnityRaise(input: {
  readonly projectId: ProjectId;
  readonly prepared: PreparedConnection;
}): Promise<UnityRaiseResult> {
  return runtime.runPromise(postEffect(input));
}

export interface UnityRaiseFailureReport {
  readonly type: "error";
  readonly title: string;
  readonly description: string;
}

/** Successful raise/launch outcomes intentionally produce no toast. */
export function describeUnityRaiseFailure(
  result: UnityRaiseResult,
): UnityRaiseFailureReport | null {
  return result._tag === "error"
    ? {
        type: "error",
        title: "Could not bring Unity to the front",
        description: result.message,
      }
    : null;
}
