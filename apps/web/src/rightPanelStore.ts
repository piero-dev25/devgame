/**
 * Thread-scoped right-panel surface state.
 *
 * This is intentionally a shallow workspace model: it owns an ordered set of
 * surface descriptors and the active surface, while each feature continues to
 * own its durable resource state.
 *
 * In DevGame the dock is the single layout owner. Diff, Files ("files"/
 * "file"), Terminal and Browser ("preview") are first-class dock panels
 * (spec-surfaces-as-dock-panels.md, Part B), with in-panel selection owned by
 * `fileExplorerStore.ts`, `terminalDockStore.ts` and `previewStateStore.ts`.
 * None of those kinds exist here. Plan is gone for upstream's own reason:
 * plans render inline in the transcript (upstream #5558).
 *
 * What remains are the surfaces the dock has no panel for: Agents, plus
 * upstream's Device, Pull request and Pull requests surfaces, which stay
 * right-panel surfaces so upstream's PR and device features keep working.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

// "diff", "files", "file", "terminal" and "preview" are deliberately NOT
// members: each moved to a dock panel (see dock/ChatDock.tsx's
// registrations). Removing a kind from this union, rather than leaving it
// unused, is what lets the compiler find every stale call site that would
// otherwise open a surface nothing renders. "plan" is not a member either
// (upstream #5558). The persisted-data side of every retired kind is handled
// in migratePersistedRightPanelState.
const RIGHT_PANEL_KINDS = ["device", "pull-request", "pull-requests", "agents"] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

export interface DeviceTabTarget {
  hostId: string;
  deviceId: string;
  platform: "ios" | "android";
  name: string;
}

export type RightPanelSurface =
  | { id: "device" | `device:${string}`; kind: "device"; target?: DeviceTabTarget; title?: string }
  | {
      /**
       * A change request opened beside a thread or in the pull-request list's shared panel.
       * The reference lives in the id so several pull requests can remain open as peer tabs.
       */
      id: `pull-request:${string}`;
      kind: "pull-request";
      /**
       * Which server the change request was read from. The list spans every connected one, so
       * two of them can hold the same project id; a panel beside a thread leaves this out and
       * takes the environment from its own ref.
       */
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
    }
  /** The thread's linked pull requests, one singleton tab beside any number of `pull-request` tabs. */
  | { id: "pull-requests"; kind: "pull-requests" }
  | { id: "agents"; kind: "agents" };

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v2";
// v12 (DevGame): retired diff/files/file/terminal/preview (dock panels) and
// plan. Upstream independently reached v13: v10 keys pull-request surfaces by
// reference, v11 stops persisting the pull-request list's shared panel, v12
// adds the device surface. v14 is above both so that every save from either
// line runs the merged migration below: a DevGame v12 save must not skip it,
// and an upstream v13 save still holds dock-owned kinds this build cannot
// render.
const RIGHT_PANEL_STORAGE_VERSION = 14;

/** A fixed workspace-level ref: each PR surface carries its own real environment. */
export const PULL_REQUESTS_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("pull-requests-panel"),
  ThreadId.make("pull-requests-panel"),
);

/**
 * The pull-request list's shared panel is session
 * state: reopening the app should show the list, not last session's tabs and detail fetches.
 */
const isPullRequestsPanelKey = (threadKey: string) => threadKey.endsWith(":pull-requests-panel");

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
  dismissedDeviceSurfaceIds?: string[];
}

type ProactiveSurface = Extract<RightPanelSurface, { kind: "pull-request" | "pull-requests" }>;

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  /** Session-only count of user panel choices per thread. Automatic updates do not advance it. */
  userActionRevisionByThreadKey: Record<string, number>;
  getUserActionRevision: (ref: ScopedThreadRef) => number;
  /**
   * Open a surface on behalf of the app, not the user. Refused when the user
   * made a panel choice after `expectedUserActionRevision` was read.
   *
   * Upstream also opens a completed-turn diff proactively; in DevGame Diff is
   * a dock panel, so only pull-request surfaces come through here.
   */
  openProactive: (
    ref: ScopedThreadRef,
    surface: ProactiveSurface,
    expectedUserActionRevision: number,
  ) => boolean;
  open: (ref: ScopedThreadRef, kind: Exclude<RightPanelKind, "pull-request">) => void;
  openDevice: (ref: ScopedThreadRef, target: DeviceTabTarget, automatic?: boolean) => void;
  renameDevice: (ref: ScopedThreadRef, surfaceId: string, title: string) => void;
  openPullRequest: (
    ref: ScopedThreadRef,
    target: {
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
    },
  ) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggle: (ref: ScopedThreadRef, kind: Exclude<RightPanelKind, "pull-request">) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const singletonSurface = (kind: Exclude<RightPanelKind, "pull-request">): RightPanelSurface => {
  switch (kind) {
    case "pull-requests":
      return { id: "pull-requests", kind };
    case "agents":
      return { id: "agents", kind };
    case "device":
      return { id: "device", kind };
  }
};

export type PullRequestSurface = Extract<RightPanelSurface, { kind: "pull-request" }>;

export function pullRequestSurfaceId(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
}): PullRequestSurface["id"] {
  // The environment leads the id where there is one, so the same change request read from two
  // servers is two tabs rather than one tab that changes its mind about which server it is on.
  const scope =
    target.environmentId === undefined ? "" : `${encodeURIComponent(target.environmentId)}:`;
  const host = target.host === undefined ? "" : `${encodeURIComponent(target.host.toLowerCase())}:`;
  return `pull-request:${scope}${encodeURIComponent(target.projectId)}:${host}${encodeURIComponent(target.repository)}:${target.number}`;
}

export function pullRequestSurface(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
  url?: string;
}): PullRequestSurface {
  return {
    id: pullRequestSurfaceId(target),
    kind: "pull-request",
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    projectId: target.projectId,
    ...(typeof target.host === "string" ? { host: target.host.toLowerCase() } : {}),
    repository: target.repository,
    number: target.number,
    ...(typeof target.url === "string" ? { url: target.url } : {}),
  };
}

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const updateThread = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = updater(current);
  if (
    !next.isOpen &&
    next.activeSurfaceId === null &&
    next.surfaces.length === 0 &&
    !next.dismissedDeviceSurfaceIds?.length
  ) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

// Every store action is a user choice unless it goes through `automaticUpdate`.
// Only `openProactive` and automatic device opens are automatic, so a new
// action counts as a user choice by default.
const automaticUpdate = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => ({
  byThreadKey: updateThread(state.byThreadKey, threadKey, updater),
});

const userAction = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => ({
  byThreadKey: updateThread(state.byThreadKey, threadKey, (current) => {
    const next = updater(current);
    const removed = current.surfaces.filter(
      (surface) =>
        surface.kind === "device" &&
        surface.target &&
        !next.surfaces.some((entry) => entry.id === surface.id),
    );
    if (removed.length === 0) return next;
    return {
      ...next,
      dismissedDeviceSurfaceIds: [
        ...new Set([
          ...(next.dismissedDeviceSurfaceIds ?? []),
          ...removed.map((surface) => surface.id),
        ]),
      ],
    };
  }),
  userActionRevisionByThreadKey: {
    ...state.userActionRevisionByThreadKey,
    [threadKey]: (state.userActionRevisionByThreadKey[threadKey] ?? 0) + 1,
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function migrateDeviceTarget(value: unknown): DeviceTabTarget | null {
  if (!isRecord(value)) return null;
  const { hostId, deviceId, platform, name } = value;
  if (
    typeof hostId !== "string" ||
    typeof deviceId !== "string" ||
    (platform !== "ios" && platform !== "android") ||
    typeof name !== "string"
  ) {
    return null;
  }
  return { hostId, deviceId, platform, name };
}

/**
 * Allowlist, not denylist: a persisted entry survives only when it is a
 * well-formed member of the CURRENT union. Retired kinds (diff, files, file,
 * terminal, preview, plan) fall out here, and so do a null entry (a corrupted
 * save used to throw on `.kind`, which rejected the whole rehydrate and reset
 * every thread's panel state) and any kind this build does not know.
 */
function migratePersistedSurface(surface: unknown): RightPanelSurface[] {
  if (!isRecord(surface)) return [];
  switch (surface.kind) {
    case "agents":
      return surface.id === "agents" ? [{ id: "agents", kind: "agents" }] : [];
    case "pull-requests":
      return surface.id === "pull-requests" ? [{ id: "pull-requests", kind: "pull-requests" }] : [];
    case "pull-request": {
      const { environmentId, projectId, host, repository, number, url } = surface;
      if (
        typeof projectId !== "string" ||
        typeof repository !== "string" ||
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 1
      ) {
        return [];
      }
      // Anything else stored under these names is not an environment, host or url.
      return [
        pullRequestSurface({
          projectId,
          repository,
          number,
          ...(typeof environmentId === "string" ? { environmentId } : {}),
          ...(typeof host === "string" ? { host } : {}),
          ...(typeof url === "string" ? { url } : {}),
        }),
      ];
    }
    case "device": {
      const title = typeof surface.title === "string" ? { title: surface.title } : {};
      if (surface.id === "device") return [{ id: "device", kind: "device", ...title }];
      const target = migrateDeviceTarget(surface.target);
      if (typeof surface.id !== "string" || !surface.id.startsWith("device:") || !target) {
        return [];
      }
      return [{ id: surface.id as `device:${string}`, kind: "device", target, ...title }];
    }
    default:
      return [];
  }
}

export function migratePersistedRightPanelState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadRightPanelState>;
} {
  const persistedByThreadKey = isRecord(persistedState) ? persistedState.byThreadKey : undefined;
  if (!isRecord(persistedByThreadKey)) {
    return { byThreadKey: {} };
  }
  const byThreadKey = Object.fromEntries(
    Object.entries(persistedByThreadKey)
      .filter(([threadKey]) => !isPullRequestsPanelKey(threadKey))
      .flatMap(([threadKey, threadState]): Array<[string, ThreadRightPanelState]> => {
        const validThreadState = isRecord(threadState) ? threadState : null;
        const surfaces = Array.isArray(validThreadState?.surfaces)
          ? validThreadState.surfaces.flatMap(migratePersistedSurface)
          : [];
        const rawActiveSurfaceId = validThreadState?.activeSurfaceId;
        const persistedActiveSurfaceId =
          typeof rawActiveSurfaceId === "string" &&
          surfaces.some((surface) => surface.id === rawActiveSurfaceId)
            ? rawActiveSurfaceId
            : rawActiveSurfaceId === "pull-request"
              ? (surfaces.find((surface) => surface.kind === "pull-request")?.id ?? null)
              : null;
        // A migration that dropped every surface must not reopen an empty
        // panel: a thread whose only surface was "diff" (or "plan") would
        // otherwise keep the `isOpen: true` it was saved with even though
        // `surfaces` is now empty. Zero surviving surfaces means never open.
        const isOpen =
          surfaces.length > 0 &&
          (typeof validThreadState?.isOpen === "boolean"
            ? validThreadState.isOpen
            : persistedActiveSurfaceId !== null);
        // An open panel needs an active surface: if migration dropped the
        // persisted one (e.g. diff was active), fall back to the first
        // survivor instead of rendering an open empty panel.
        const activeSurfaceId =
          persistedActiveSurfaceId ?? (isOpen ? (surfaces[0]?.id ?? null) : null);
        const dismissedDeviceSurfaceIds = Array.isArray(validThreadState?.dismissedDeviceSurfaceIds)
          ? validThreadState.dismissedDeviceSurfaceIds.filter(
              (id): id is string => typeof id === "string",
            )
          : [];
        // Prune records migration emptied: an absent record and a
        // zero-surface record mean the same thing to every reader, and
        // keeping one per legacy thread would leak a dead localStorage row
        // per thread forever. A record that still remembers dismissed
        // devices is not empty: it keeps an automatic device open from
        // reopening a tab the user closed.
        if (surfaces.length === 0 && dismissedDeviceSurfaceIds.length === 0) {
          return [];
        }
        return [
          [
            threadKey,
            {
              isOpen,
              surfaces,
              activeSurfaceId,
              ...(Array.isArray(validThreadState?.dismissedDeviceSurfaceIds)
                ? { dismissedDeviceSurfaceIds }
                : {}),
            },
          ],
        ];
      }),
  );
  return { byThreadKey };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      userActionRevisionByThreadKey: {},
      getUserActionRevision: (ref) =>
        get().userActionRevisionByThreadKey[scopedThreadKey(ref)] ?? 0,
      openProactive: (ref, surface, expectedUserActionRevision) => {
        let opened = false;
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (
            (state.userActionRevisionByThreadKey[threadKey] ?? 0) !== expectedUserActionRevision
          ) {
            return state;
          }
          opened = true;
          return automaticUpdate(state, threadKey, (current) => upsertSurface(current, surface));
        });
        return opened;
      },
      open: (ref, kind) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            upsertSurface(current, singletonSurface(kind)),
          ),
        ),
      openDevice: (ref, target, automatic = false) =>
        set((state) =>
          (automatic ? automaticUpdate : userAction)(state, scopedThreadKey(ref), (current) => {
            const id =
              `device:${encodeURIComponent(target.hostId)}:${encodeURIComponent(target.deviceId)}` as const;
            if (automatic && current.dismissedDeviceSurfaceIds?.includes(id)) return current;
            const surface: RightPanelSurface = { id, kind: "device", target };
            const existing = current.surfaces.find((entry) => entry.id === id);
            const surfaces = existing
              ? current.surfaces.filter((entry) => entry.id !== "device")
              : current.surfaces.map((entry) => (entry.id === "device" ? surface : entry));
            return upsertSurface(
              {
                ...current,
                surfaces,
                dismissedDeviceSurfaceIds: (current.dismissedDeviceSurfaceIds ?? []).filter(
                  (entry) => entry !== id,
                ),
              },
              existing ?? surface,
            );
          }),
        ),
      renameDevice: (ref, surfaceId, title) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId && surface.kind === "device"
                ? { ...surface, title: title.trim() || surface.target?.name || "Device" }
                : surface,
            ),
          })),
        ),
      openPullRequest: (ref, target) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = pullRequestSurface(target);
            const next = upsertSurface(current, surface);
            return target.url
              ? {
                  ...next,
                  surfaces: next.surfaces.map((entry) =>
                    entry.id === surface.id ? surface : entry,
                  ),
                }
              : next;
          }),
        ),
      activateSurface: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        ),
      closeSurface: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            if (current.activeSurfaceId !== surfaceId) {
              return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };
            }
            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
            return {
              ...current,
              isOpen: surfaces.length > 0 && current.isOpen,
              surfaces,
              activeSurfaceId: fallback?.id ?? null,
            };
          }),
        ),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length === 1) return current;
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            };
          }),
        ),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        ),
      closeAllSurfaces: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
          ),
        ),
      show: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        ),
      close: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        ),
      toggleVisibility: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        ),
      toggle: (ref, kind) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (current.isOpen && active?.kind === kind) {
              return { ...current, isOpen: false };
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        ),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (
            !(threadKey in state.byThreadKey) &&
            !(threadKey in state.userActionRevisionByThreadKey)
          ) {
            return state;
          }
          const { [threadKey]: _removed, ...rest } = state.byThreadKey;
          const { [threadKey]: _revision, ...userActionRevisionByThreadKey } =
            state.userActionRevisionByThreadKey;
          return { byThreadKey: rest, userActionRevisionByThreadKey };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: Object.fromEntries(
          Object.entries(state.byThreadKey).filter(
            ([threadKey]) => !isPullRequestsPanelKey(threadKey),
          ),
        ),
      }),
      migrate: migratePersistedRightPanelState,
    },
  ),
);

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return selectSelectedRightPanelSurface(byThreadKey, ref);
}

/** The selected surface even while the panel is hidden, so a layout control can restore it. */
export function selectSelectedRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}
