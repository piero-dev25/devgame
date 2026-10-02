// Launch and stop a run profile on the selected environment:
// `POST /api/project-runtime/{start,stop}` (apps/server/src/projectRuntime/RunRoute.ts)
// through `postForkEnvironmentRoute`, so no origin is hardcoded and remote
// environments work the same as the local one.
//
// The result is the server's receipt: the run as the server recorded it, or
// why it refused. Nothing here guesses a state the server did not report.
import {
  PROJECT_RUNTIME_START_PATH,
  PROJECT_RUNTIME_STOP_PATH,
  type ProjectId,
  RunStartResult,
  type RunState,
  RunStopResult,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ConnectionBlockedError,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { postForkEnvironmentRoute } from "../lib/forkEnvironmentRoute";
import { runtime } from "../lib/runtime";

/** Stop waits out the server's SIGTERM grace before SIGKILL, so leave room for it. */
const RUNTIME_COMMAND_TIMEOUT_MS = 30_000;

export type RuntimeCommandOutcome =
  | {
      readonly _tag: "accepted";
      readonly run: RunState;
      readonly alreadyRunning: boolean;
      /** Epoch ms the receipt arrived, on the clock the status snapshots use. */
      readonly receivedAt: number;
    }
  /** The server refused with a reason: unknown profile, missing executable, run not ours. */
  | { readonly _tag: "refused"; readonly message: string }
  /** This connection lacks the scope (`terminal:operate`); the route answers a text 403. */
  | { readonly _tag: "notPermitted" }
  /** No answer: the request could not be sent or timed out. */
  | { readonly _tag: "unreachable"; readonly message: string }
  /**
   * The environment answered, but not with a result: an auth error, another
   * error status, or a body that does not match the contract.
   */
  | { readonly _tag: "failed"; readonly message: string };

const NOT_PERMITTED: RuntimeCommandOutcome = { _tag: "notPermitted" };

const isConnectionBlockedError = Schema.is(ConnectionBlockedError);
const UNREADABLE_RESPONSE = "It answered with a response this app could not read.";

/** Sorts a failed request into "no answer" versus "answered with an error". */
function classifyFailure(
  error: RemoteEnvironmentRequestError | Schema.SchemaError,
): RuntimeCommandOutcome {
  switch (error._tag) {
    case "RemoteEnvironmentAuthTimeoutError":
      return { _tag: "unreachable", message: error.message };
    case "RemoteEnvironmentAuthFetchError":
      // A rejected access token surfaces here wrapped; that is an auth answer, not a network failure.
      return isConnectionBlockedError(error.cause)
        ? { _tag: "failed", message: error.cause.detail }
        : { _tag: "unreachable", message: error.message };
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return error.status === 403
        ? NOT_PERMITTED
        : { _tag: "failed", message: `It answered with status ${error.status}.` };
    case "RemoteEnvironmentAuthInvalidJsonError":
    case "SchemaError":
      return { _tag: "failed", message: UNREADABLE_RESPONSE };
    default:
      // Every typed environment error (auth, scope, bad request, internal) is a server answer.
      return { _tag: "failed", message: error.message };
  }
}

const decodeRunStartResult = Schema.decodeUnknownEffect(RunStartResult);
const decodeRunStopResult = Schema.decodeUnknownEffect(RunStopResult);

function postCommand(input: {
  readonly prepared: PreparedConnection;
  readonly path: string;
  readonly body: unknown;
  readonly decode: typeof decodeRunStartResult | typeof decodeRunStopResult;
}): Promise<RuntimeCommandOutcome> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const body = yield* postForkEnvironmentRoute({
        prepared: input.prepared,
        path: input.path,
        body: input.body,
        timeoutMs: RUNTIME_COMMAND_TIMEOUT_MS,
      });
      // Start and stop results share this shape; only start says `alreadyRunning`.
      const result:
        | { readonly _tag: "error"; readonly message: string }
        | { readonly run: RunState; readonly alreadyRunning?: boolean } = yield* input.decode(body);
      const receivedAt = yield* Clock.currentTimeMillis;
      const outcome: RuntimeCommandOutcome =
        "_tag" in result
          ? { _tag: "refused", message: result.message }
          : {
              _tag: "accepted",
              run: result.run,
              alreadyRunning: result.alreadyRunning ?? false,
              receivedAt,
            };
      return outcome;
    }).pipe(
      // Every typed failure becomes an outcome the panel can word truthfully. The
      // shared helper fails a fork route's plain-text 403 as an undeclared status.
      Effect.catch((error) => Effect.succeed(classifyFailure(error))),
      Effect.provide(FetchHttpClient.layer),
    ),
  );
}

export function postRuntimeStart(input: {
  readonly prepared: PreparedConnection;
  readonly projectId: ProjectId;
  readonly profileId: string;
  readonly threadId: ThreadId | null;
}): Promise<RuntimeCommandOutcome> {
  return postCommand({
    prepared: input.prepared,
    path: PROJECT_RUNTIME_START_PATH,
    body: {
      projectId: input.projectId,
      profileId: input.profileId,
      ...(input.threadId === null ? {} : { threadId: input.threadId }),
    },
    decode: decodeRunStartResult,
  });
}

export function postRuntimeStop(input: {
  readonly prepared: PreparedConnection;
  readonly projectId: ProjectId;
  readonly runId: string;
}): Promise<RuntimeCommandOutcome> {
  return postCommand({
    prepared: input.prepared,
    path: PROJECT_RUNTIME_STOP_PATH,
    body: { projectId: input.projectId, runId: input.runId },
    decode: decodeRunStopResult,
  });
}

/**
 * What the panel says after a launch or stop request, or null when the
 * receipt itself (now shown as the run's state) says enough.
 */
export function describeRuntimeCommand(
  kind: "start" | "stop",
  /** `unexpected`: the request threw outside its typed failures (a bug). */
  outcome: RuntimeCommandOutcome | { readonly _tag: "unexpected"; readonly message: string },
): string | null {
  const verb = kind === "start" ? "launch" : "stop";
  switch (outcome._tag) {
    case "accepted":
      return outcome.alreadyRunning
        ? "That profile was already running, so nothing new was launched."
        : null;
    case "refused":
      return `Could not ${verb}: ${outcome.message}`;
    case "notPermitted":
      return `Not permitted: this connection may not ${verb} runs on this environment (it needs terminal access).`;
    case "unreachable":
      return `Could not reach the environment to ${verb} the run: ${outcome.message}`;
    case "failed":
      return `The environment answered but did not ${verb} the run: ${outcome.message}`;
    case "unexpected":
      return `Could not ${verb} the run: ${outcome.message}`;
  }
}
