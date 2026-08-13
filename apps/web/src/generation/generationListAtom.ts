// The reactive "this project's generation jobs + assets" query atom —
// Increment 2b.1's read-only Generation dock panel
// (docs/v2/specs/increment-2b1-generation-panel.md). Structurally mirrors
// `../unity/unitySetupProbeAtom.ts`'s `createUnitySetupProbeAtom`: a
// factory (not a bare atom family) taking `preparedConnectionAtom`/
// `fetchList` as DI seams so `generationListAtom.test.ts` can mount a FAKE
// pair instead of the real environment supervisor and a live HTTP call, and
// the same `get.some(...)` REACTIVE wait on `preparedConnectionValueAtom`
// (never a one-shot snapshot — the #106 defect class that pattern exists to
// avoid).
//
// Per the spec's own instruction ("No new client-runtime state/ factory
// needed if the atom fetches the route directly like the probe does"): this
// calls `fetchGenerationList` directly, with NO TTL-cache wrapper the way
// `../unity/setupProbeCache.ts` sits in front of the Unity probe — a
// wrapper built for a fundamentally different access pattern (several
// uncoordinated mount-effects racing on an ON-DEMAND panel open) that would
// only fight this atom's OWN poll cadence below rather than help it.
import type {
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  GenerationListSuccess,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { environmentSession } from "../state/session";
import { fetchGenerationList } from "./fetchGenerationList";

/** Matches `fetchGenerationList.ts`'s own 20s bound on the HTTP call itself
 * — this timeout covers a DIFFERENT wait this atom adds in FRONT of that
 * call (waiting for the environment's connection to finish preparing), so
 * the two are independent budgets, not one nested inside the other. Same
 * reasoning `unitySetupProbeAtom.ts`'s own identical constant gives. */
export const GENERATION_LIST_CONNECTION_WAIT_TIMEOUT_MS = 15_000;

/** Spec item 3: "poll/refresh on an interval". Matches
 * `GenerationService.ts`'s own server-side default poll cadence
 * (`DEFAULT_POLL_INTERVAL_MS`) — no reason for the panel to refresh faster
 * than a job's own progress can possibly have changed since the last read. */
export const GENERATION_LIST_POLL_INTERVAL_MS = 5_000;

export class GenerationListConnectionWaitTimeoutError extends Schema.TaggedErrorClass<GenerationListConnectionWaitTimeoutError>()(
  "GenerationListConnectionWaitTimeoutError",
  {},
) {
  override get message(): string {
    return "Still waiting for this app's connection to be ready.";
  }
}

/** Wraps a rejected `fetchGenerationList` call — a tagged error, not the
 * bare global `Error` (this codebase's own Effect lint rule flags an
 * untagged `Error` in the failure channel), matching
 * `unitySetupProbeAtom.ts`'s identical `UnitySetupProbeFetchError`. */
export class GenerationListFetchError extends Schema.TaggedErrorClass<GenerationListFetchError>()(
  "GenerationListFetchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return this.cause instanceof Error && this.cause.message.trim().length > 0
      ? this.cause.message
      : "Failed to load the generation list.";
  }
}

/**
 * A shared, module-scope ticking signal — the SAME "one browser-global
 * signal, many derived atoms subscribe to it" shape `Atom.windowFocusSignal`
 * itself uses (`effect/unstable/reactivity/Atom.ts`), just driven by a
 * timer instead of `visibilitychange`. One `setInterval` for the whole
 * module, not one per open project/panel instance — every project-scoped
 * atom below shares this one clock via `Atom.makeRefreshOnSignal`.
 */
const generationListPollSignal: Atom.Atom<number> = Atom.readable((get) => {
  let tick = 0;
  const handle = setInterval(() => get.setSelf(++tick), GENERATION_LIST_POLL_INTERVAL_MS);
  get.addFinalizer(() => clearInterval(handle));
  return tick;
});

/**
 * Factory, not a bare atom family — same DI shape `createUnitySetupProbeAtom`
 * uses for the identical "atom wraps a live bridge call" problem.
 */
export function createGenerationListAtom(input: {
  readonly preparedConnectionAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<PreparedConnection>>;
  readonly fetchList: (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly httpBaseUrl: string;
    readonly httpAuthorization: PreparedConnection["httpAuthorization"];
  }) => Promise<GenerationListSuccess>;
  readonly connectionWaitTimeoutMs?: number;
}) {
  const timeoutMs = input.connectionWaitTimeoutMs ?? GENERATION_LIST_CONNECTION_WAIT_TIMEOUT_MS;

  const environmentFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((projectId: ProjectId) => {
      const projectRef: ScopedProjectRef = { environmentId, projectId };
      const base = Atom.make((get) =>
        Effect.gen(function* () {
          const prepared = yield* Effect.timeoutOrElse(
            get.some(input.preparedConnectionAtom(environmentId)),
            {
              duration: Duration.millis(timeoutMs),
              orElse: () => Effect.fail(new GenerationListConnectionWaitTimeoutError()),
            },
          );
          return yield* Effect.tryPromise({
            try: () =>
              input.fetchList({
                environmentId,
                projectId,
                httpBaseUrl: prepared.httpBaseUrl,
                httpAuthorization: prepared.httpAuthorization,
              }),
            catch: (cause) => new GenerationListFetchError({ cause }),
          });
        }),
      ).pipe(Atom.withLabel(`generation:list:${scopedProjectKey(projectRef)}`));

      // Spec item 3: "poll/refresh on an interval - on focus" — both
      // signals compose via the library's own `makeRefreshOnSignal`
      // combinator (the same one `Atom.refreshOnWindowFocus` is itself
      // built from), applied here to the module-scope poll signal above.
      //
      // Guarded on `typeof window`: `Atom.windowFocusSignal` (which
      // `Atom.refreshOnWindowFocus` wraps) is BROWSER-ONLY by the
      // library's own doc comment — it touches `window`/`document`
      // unconditionally, even just being READ during `registry.mount`, not
      // only on an actual focus event. `apps/web` ships zero jsdom/
      // testing-library infrastructure (confirmed:
      // `unitySetupProbeAtom.test.ts`'s own doc comment), so
      // `generationListAtom.test.ts`'s plain-Node unit tests exercise this
      // factory directly and would otherwise crash with "window is not
      // defined" on every `registry.mount(...)` — proven empirically: this
      // guard was added after that exact failure, not written speculatively.
      // The interval-poll half (`generationListPollSignal`, `setInterval`-
      // based) has no such dependency and always applies. KNOWN GAP: no
      // test in this repo exercises the window-focus-refresh wiring itself
      // (it would need jsdom); the interval-poll half IS covered indirectly
      // by this file's own reactivity tests exercising the underlying atom.
      const withPoll = Atom.makeRefreshOnSignal(generationListPollSignal)(base);
      return typeof window === "undefined" ? withPoll : Atom.refreshOnWindowFocus(withPoll);
    }),
  );

  return (projectRef: ScopedProjectRef) =>
    environmentFamily(projectRef.environmentId)(projectRef.projectId);
}

/**
 * The live instance every real caller uses — `environmentSession` is this
 * app's one real `EnvironmentSupervisor`-backed atom family
 * (`state/session.ts`), `fetchGenerationList` is the real HTTP call.
 */
export const generationListAtom = createGenerationListAtom({
  preparedConnectionAtom: environmentSession.preparedConnectionValueAtom,
  fetchList: fetchGenerationList,
});
