// The reactive "is Unity set up" query atom (#106 fix) — the correct
// replacement for both ChatView.tsx's and ConnectionsSettings.tsx's
// hand-rolled `useEffect` + `readPreparedConnection` mount effects, which
// read the environment's prepared-connection state as a SYNCHRONOUS
// snapshot (`readPreparedConnection`, `state/session.ts:24-28`) rather than
// subscribing to it. If that snapshot was taken before the environment's
// async connection-prep/auth handshake finished, both effects bailed out
// (`if (!prepared) return;`) having set NEITHER a result NOR an error, and
// nothing in their dependency arrays ever changed again to retry — a
// permanent give-up rendered as an eternal "Checking…" spinner (#106).
//
// This atom fixes the defect at its root: `get.some(...)` is a REACTIVE
// wait on `preparedConnectionValueAtom` (an `Option`-valued atom that starts
// at `None` and resolves to `Some` once the handshake completes — see
// `packages/client-runtime/src/state/session.ts`), not a one-shot read. If
// the connection is already ready, this resolves immediately; if not, this
// keeps waiting and the fetch fires the MOMENT the connection becomes
// ready — no remount, no dependency-array trick required. Bounded by
// `UNITY_SETUP_CONNECTION_WAIT_TIMEOUT_MS` so a genuine stall (handshake
// failure, dropped connection) still surfaces a stated reason instead of
// spinning forever, closing the "silent bail" half of the same defect.
//
// Consumed via `useEnvironmentQuery` (`state/query.ts`) — already the
// established wrapper for an `AsyncResult`-returning atom in this codebase
// (`ChatView.tsx`'s own `activeEnvironmentShell`/`gitStatusQuery` use the
// identical pattern) — which gives retry (`refresh`), a loading flag, and a
// formatted error message for free, so neither call site needs to hand-roll
// that plumbing again.
import type { EnvironmentId, UnitySetupProbeResult } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { environmentSession } from "../state/session";
import { fetchUnitySetupProbeCached } from "./setupProbeCache";

/** Matches `fetchSetupProbe.ts`'s own 20s bound on the HTTP call itself —
 * this timeout covers a DIFFERENT wait this atom adds in FRONT of that call
 * (waiting for the environment's connection to finish preparing), so the
 * two are independent budgets, not one nested inside the other. */
export const UNITY_SETUP_CONNECTION_WAIT_TIMEOUT_MS = 15_000;

export class UnitySetupConnectionWaitTimeoutError extends Schema.TaggedErrorClass<UnitySetupConnectionWaitTimeoutError>()(
  "UnitySetupConnectionWaitTimeoutError",
  {},
) {
  // F8 (merge-gate review, low): this used to restate "Unity's status" on
  // its own ("...ready — Unity's status can't be checked yet."), but this
  // message is NEVER shown bare — `unityDisabledReason` (EngineToolbar.logic.ts)
  // is its only consumer, and it already prefixes every error with
  // "Couldn't check Unity's status — ". The old wording composed into a
  // double-dash run-on repeating that same phrase twice. This message
  // describes only what IT adds (the connection wait, not Unity itself),
  // letting the prefix supply the "Unity's status" framing exactly once.
  override get message(): string {
    return "Still waiting for this app's connection to be ready.";
  }
}

/** Wraps a rejected `fetchProbe` call — a tagged error, not the bare global
 * `Error` (this codebase's own Effect lint rule flags an untagged `Error` in
 * the failure channel: `effect(globalErrorInEffectFailure)`), matching
 * `desktopNetworkAccess.ts`'s identical "wrap a rejected bridge/HTTP call"
 * shape. */
export class UnitySetupProbeFetchError extends Schema.TaggedErrorClass<UnitySetupProbeFetchError>()(
  "UnitySetupProbeFetchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return this.cause instanceof Error && this.cause.message.trim().length > 0
      ? this.cause.message
      : "Failed to check Unity's status.";
  }
}

/**
 * Factory, not a bare atom family, so `unitySetupProbeAtom.test.ts` can
 * mount a FAKE `preparedConnectionAtom`/`fetchProbe` pair instead of the
 * real environment supervisor and a live HTTP call — same DI shape
 * `desktopNetworkAccess.ts`'s `createDesktopNetworkAccessStateAtom` already
 * uses for the identical "atom wraps a live bridge call" problem, and the
 * same reason that file is directly testable via a plain `AtomRegistry`
 * with no DOM/component-mount involved.
 */
export function createUnitySetupProbeAtom(input: {
  readonly preparedConnectionAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<PreparedConnection>>;
  readonly fetchProbe: (input: {
    readonly environmentId: EnvironmentId;
    readonly httpBaseUrl: string;
    readonly httpAuthorization: PreparedConnection["httpAuthorization"];
  }) => Promise<UnitySetupProbeResult>;
  readonly connectionWaitTimeoutMs?: number;
}) {
  const timeoutMs = input.connectionWaitTimeoutMs ?? UNITY_SETUP_CONNECTION_WAIT_TIMEOUT_MS;

  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Effect.gen(function* () {
        // REACTIVE wait — `get.some` subscribes to the source atom and
        // resolves the moment it becomes `Some`, unlike
        // `readPreparedConnection`'s one-shot `appAtomRegistry.get(...)`
        // snapshot (the exact mechanism #106 traced this defect to).
        const prepared = yield* Effect.timeoutOrElse(
          get.some(input.preparedConnectionAtom(environmentId)),
          {
            duration: Duration.millis(timeoutMs),
            orElse: () => Effect.fail(new UnitySetupConnectionWaitTimeoutError()),
          },
        );
        return yield* Effect.tryPromise({
          try: () =>
            input.fetchProbe({
              environmentId,
              httpBaseUrl: prepared.httpBaseUrl,
              httpAuthorization: prepared.httpAuthorization,
            }),
          catch: (cause) => new UnitySetupProbeFetchError({ cause }),
        });
      }),
    ).pipe(Atom.withLabel(`unity:setup-probe:${environmentId}`)),
  );
}

/**
 * The live instance every real caller uses — `environmentSession` is this
 * app's one real `EnvironmentSupervisor`-backed atom family
 * (`state/session.ts`), `fetchUnitySetupProbeCached` is the existing
 * TTL-cached, in-flight-deduped HTTP call (#102) — both unchanged by this
 * fix, just consumed reactively instead of snapshotted.
 */
export const unitySetupProbeAtom = createUnitySetupProbeAtom({
  preparedConnectionAtom: environmentSession.preparedConnectionValueAtom,
  fetchProbe: fetchUnitySetupProbeCached,
});
