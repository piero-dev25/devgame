/**
 * Pure in-memory fan-out for Space Events, keyed by project. Nothing on
 * disk, no knowledge of the orchestration engine or the projection tables —
 * this is bookkeeping only: which sends are currently subscribed to which
 * project. See `EditorPresenceRegistry` for the same shape applied to
 * presence chips.
 *
 * Per-project keying (rather than one global subscriber set filtered per
 * broadcast) exists so a broadcast for project A can check `hasSubscribers`
 * for project A alone and skip the read-model query entirely when nobody is
 * listening — see SpaceEventsRoute.ts's domain-event listener.
 */
import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export type SpaceEventsSubscriberSend = (frame: string) => Effect.Effect<void>;

interface RegistryState {
  readonly subscribersByProject: ReadonlyMap<ProjectId, ReadonlySet<SpaceEventsSubscriberSend>>;
}

export class SpaceEventsRegistry extends Context.Service<
  SpaceEventsRegistry,
  {
    readonly addSubscriber: (
      projectId: ProjectId,
      send: SpaceEventsSubscriberSend,
    ) => Effect.Effect<void>;
    readonly removeSubscriber: (
      projectId: ProjectId,
      send: SpaceEventsSubscriberSend,
    ) => Effect.Effect<void>;
    /** True when at least one connection is currently subscribed to this
     * project. Lets the domain-event listener skip the scoped read-model
     * query entirely for a project nobody is watching. */
    readonly hasSubscribers: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly broadcast: (projectId: ProjectId, frame: string) => Effect.Effect<void>;
  }
>()("t3/spaceEvents/SpaceEventsRegistry") {}

export const make = Effect.gen(function* SpaceEventsRegistryMake() {
  const stateRef = yield* Ref.make<RegistryState>({
    subscribersByProject: new Map(),
  });

  const addSubscriber: SpaceEventsRegistry["Service"]["addSubscriber"] = (projectId, send) =>
    Ref.update(stateRef, (current) => {
      const existing = current.subscribersByProject.get(projectId) ?? new Set();
      const nextForProject = new Set(existing);
      nextForProject.add(send);
      const subscribersByProject = new Map(current.subscribersByProject);
      subscribersByProject.set(projectId, nextForProject);
      return { subscribersByProject };
    });

  const removeSubscriber: SpaceEventsRegistry["Service"]["removeSubscriber"] = (projectId, send) =>
    Ref.update(stateRef, (current) => {
      const existing = current.subscribersByProject.get(projectId);
      if (!existing || !existing.has(send)) return current;
      const nextForProject = new Set(existing);
      nextForProject.delete(send);
      const subscribersByProject = new Map(current.subscribersByProject);
      if (nextForProject.size === 0) {
        subscribersByProject.delete(projectId);
      } else {
        subscribersByProject.set(projectId, nextForProject);
      }
      return { subscribersByProject };
    });

  const hasSubscribers: SpaceEventsRegistry["Service"]["hasSubscribers"] = (projectId) =>
    Ref.get(stateRef).pipe(
      Effect.map((current) => (current.subscribersByProject.get(projectId)?.size ?? 0) > 0),
    );

  const broadcast: SpaceEventsRegistry["Service"]["broadcast"] = (projectId, frame) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(stateRef);
      const subscribers = current.subscribersByProject.get(projectId);
      if (!subscribers) return;
      yield* Effect.forEach(subscribers, (send) => send(frame), { discard: true });
    });

  return SpaceEventsRegistry.of({
    addSubscriber,
    removeSubscriber,
    hasSubscribers,
    broadcast,
  });
});

export const layer = Layer.effect(SpaceEventsRegistry, make);
