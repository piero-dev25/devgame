import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedRightPanelState,
  pullRequestSurface,
  pullRequestSurfaceId,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

const linkedPullRequest = pullRequestSurface({
  projectId: "project-a",
  repository: "acme/game",
  number: 42,
});
const pullRequestsList = { id: "pull-requests", kind: "pull-requests" } as const;

describe("rightPanelStore migration", () => {
  // Diff, Files, File, Terminal and Browser are dock panels in DevGame (task
  // #53, #61); plan renders inline in the transcript (upstream #5558). A
  // persisted entry of any of those kinds is stripped, never coerced, and its
  // surviving siblings keep their place.
  it.each([
    ["terminal (legacy singleton)", { id: "terminal", kind: "terminal" }],
    [
      "terminal (split-capable)",
      {
        id: "terminal:term-1",
        kind: "terminal",
        resourceId: "term-1",
        terminalIds: ["term-1"],
        activeTerminalId: "term-1",
      },
    ],
    ["browser tab", { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
    ["browser placeholder", { id: "browser:new", kind: "preview", resourceId: null }],
    ["diff", { id: "diff", kind: "diff" }],
    ["files explorer", { id: "files", kind: "files" }],
    ["file", { id: "file:src/index.ts", kind: "file", relativePath: "src/index.ts" }],
    ["plan", { id: "plan", kind: "plan" }],
  ])("drops a stale %s surface and keeps its siblings", (_label, retired) => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: retired.id,
            surfaces: [{ id: "agents", kind: "agents" }, retired],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: "agents", kind: "agents" }],
        },
      },
    });
  });

  it("prunes a record whose only surface was retired instead of reopening an empty panel", () => {
    // A persisted isOpen: true must not survive its one surface being
    // stripped (#56), and an emptied record is pruned rather than kept as a
    // dead localStorage row per legacy thread.
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "diff",
            surfaces: [{ id: "diff", kind: "diff" }],
          },
          "env-1:thread-B": {
            isOpen: true,
            activeSurfaceId: "file:src/index.ts",
            surfaces: [{ id: "file:src/index.ts", kind: "file", relativePath: "src/index.ts" }],
          },
        },
      }),
    ).toEqual({ byThreadKey: {} });
  });

  it("falls back to the first survivor when the active surface was retired", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-B": {
            isOpen: true,
            activeSurfaceId: "plan",
            surfaces: [
              { id: "plan", kind: "plan" },
              { id: "agents", kind: "agents" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-B": {
          isOpen: true,
          activeSurfaceId: "agents",
          surfaces: [{ id: "agents", kind: "agents" }],
        },
      },
    });
  });

  it("keeps upstream's device and pull-request surfaces from a v13 save while stripping its dock-owned ones", () => {
    const deviceTarget = {
      hostId: "nucbox",
      deviceId: "emulator-5580",
      platform: "android",
      name: "Pixel",
    } as const;
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: linkedPullRequest.id,
            surfaces: [
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "device:nucbox:emulator-5580", kind: "device", target: deviceTarget },
              linkedPullRequest,
              pullRequestsList,
              { id: "files", kind: "files" },
            ],
            dismissedDeviceSurfaceIds: ["device:macmini:ios-1", 7],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: linkedPullRequest.id,
          surfaces: [
            { id: "device:nucbox:emulator-5580", kind: "device", target: deviceTarget },
            linkedPullRequest,
            pullRequestsList,
          ],
          dismissedDeviceSurfaceIds: ["device:macmini:ios-1"],
        },
      },
    });
  });

  it("drops malformed entries instead of rejecting the whole rehydrate", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "agents",
            surfaces: [
              null,
              { id: "device:host:dev", kind: "device", target: { hostId: "host" } },
              { id: "unknown", kind: "something-new" },
              { id: "pull-request:x", kind: "pull-request", projectId: "p", number: 0 },
              { id: "agents", kind: "agents" },
            ],
          },
          "env-1:thread-B": null,
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "agents",
          surfaces: [{ id: "agents", kind: "agents" }],
        },
      },
    });
  });

  it("keeps a record that only remembers dismissed devices", () => {
    // Pruning it would let an automatic device open bring back a tab the
    // user closed.
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: false,
            activeSurfaceId: null,
            surfaces: [{ id: "diff", kind: "diff" }],
            dismissedDeviceSurfaceIds: ["device:nucbox:emulator-5580"],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [],
          dismissedDeviceSurfaceIds: ["device:nucbox:emulator-5580"],
        },
      },
    });
  });

  it("upgrades the legacy singleton pull request surface to a reference-keyed tab", () => {
    const id = pullRequestSurfaceId({
      projectId: "project-a",
      repository: "acme/game",
      number: 4909,
    });
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "pull-request",
            surfaces: [
              {
                id: "pull-request",
                kind: "pull-request",
                projectId: "project-a",
                repository: "acme/game",
                number: 4909,
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: id,
          surfaces: [
            {
              id,
              kind: "pull-request",
              projectId: "project-a",
              repository: "acme/game",
              number: 4909,
            },
          ],
        },
      },
    });
  });

  it("drops the pull-request list's shared panel so a restart opens the page fresh", () => {
    const id = pullRequestSurfaceId({
      projectId: "project-a",
      repository: "acme/game",
      number: 4909,
    });
    const panelState = {
      isOpen: true,
      activeSurfaceId: id,
      surfaces: [
        {
          id,
          kind: "pull-request" as const,
          projectId: "project-a",
          repository: "acme/game",
          number: 4909,
        },
      ],
    };
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:pull-requests-panel": panelState,
          "env-1:thread-A": panelState,
        },
      }),
    ).toEqual({ byThreadKey: { "env-1:thread-A": panelState } });
  });
});

describe("rightPanelStore", () => {
  it("gives each host/device its own tab and preserves renamed tabs", () => {
    const store = useRightPanelStore.getState();
    const android = {
      hostId: "nucbox",
      deviceId: "emulator-5580",
      name: "Pixel",
      platform: "android",
    } as const;
    const ios = { hostId: "macmini", deviceId: "ios-1", name: "iPhone", platform: "ios" } as const;
    store.open(refA, "device");
    store.openDevice(refA, android);
    store.open(refA, "device");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
    store.openDevice(refA, ios);
    let state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "device:nucbox:emulator-5580",
      "device:macmini:ios-1",
    ]);
    store.renameDevice(refA, "device:nucbox:emulator-5580", "Android test");
    store.openDevice(refA, android);
    state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toHaveLength(2);
    expect(state.surfaces[0]).toMatchObject({ title: "Android test", target: android });
    expect(state.activeSurfaceId).toBe("device:nucbox:emulator-5580");
    store.closeSurface(refA, state.activeSurfaceId!);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toEqual([expect.objectContaining({ target: ios })]);
  });

  it("does not collide when two hosts expose the same device id", () => {
    const store = useRightPanelStore.getState();
    const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" } as const;
    store.openDevice(refA, { ...device, hostId: "a:b" });
    store.openDevice(refA, { ...device, hostId: "a" });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB).surfaces,
    ).toHaveLength(0);
  });

  it.each(["one", "all", "others", "right"])(
    "keeps device tabs dismissed across reload after closing %s",
    (mode) => {
      const store = useRightPanelStore.getState();
      const target = {
        hostId: "nucbox",
        deviceId: "emulator-5580",
        name: "Pixel",
        platform: "android",
      } as const;
      store.open(refA, "agents");
      store.openDevice(refA, target);
      if (mode === "one") store.closeSurface(refA, "device:nucbox:emulator-5580");
      if (mode === "all") store.closeAllSurfaces(refA);
      if (mode === "others") store.closeOtherSurfaces(refA, "agents");
      if (mode === "right") store.closeSurfacesToRight(refA, "agents");
      const persisted = JSON.parse(
        JSON.stringify({ byThreadKey: useRightPanelStore.getState().byThreadKey }),
      );
      useRightPanelStore.setState(migratePersistedRightPanelState(persisted));
      store.openDevice(refA, target, true);
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.some(
          (surface) => surface.kind === "device",
        ),
      ).toBe(false);
      store.openDevice(refA, target);
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.some(
          (surface) => surface.kind === "device",
        ),
      ).toBe(true);
    },
  );

  it.each([
    {
      choice: "pull request",
      choose: () =>
        useRightPanelStore.getState().openPullRequest(refA, { ...linkedPullRequest, number: 41 }),
    },
    {
      choice: "device",
      choose: () =>
        useRightPanelStore.getState().openDevice(refA, {
          hostId: "nucbox",
          deviceId: "emulator-5580",
          name: "Pixel",
          platform: "android",
        }),
    },
    {
      choice: "same tab",
      choose: () => useRightPanelStore.getState().activateSurface(refA, "agents"),
    },
    { choice: "hide", choose: () => useRightPanelStore.getState().close(refA) },
    { choice: "toggle", choose: () => useRightPanelStore.getState().toggle(refA, "agents") },
    { choice: "close all", choose: () => useRightPanelStore.getState().closeAllSurfaces(refA) },
  ])("keeps a later $choice choice when automatic requests arrive", ({ choose }) => {
    const store = useRightPanelStore.getState();
    store.open(refA, "agents");
    const revision = store.getUserActionRevision(refA);
    choose();
    const chosen = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);

    expect(store.openProactive(refA, linkedPullRequest, revision)).toBe(false);
    expect(store.openProactive(refA, pullRequestsList, revision)).toBe(false);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toBe(
      chosen,
    );
  });

  it("allows automatic panels for a later turn after a manual choice", () => {
    const store = useRightPanelStore.getState();
    const firstTurnRevision = store.getUserActionRevision(refA);
    store.open(refA, "agents");
    expect(store.openProactive(refA, linkedPullRequest, firstTurnRevision)).toBe(false);

    const nextTurnRevision = store.getUserActionRevision(refA);
    expect(store.openProactive(refA, linkedPullRequest, nextTurnRevision)).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe(
      "pull-request",
    );
  });

  it("keeps manual choices scoped to their thread and environment", () => {
    const otherEnvironment = scopeThreadRef("env-2" as EnvironmentId, refA.threadId);
    const store = useRightPanelStore.getState();
    const revision = store.getUserActionRevision(refA);
    store.open(refB, "agents");
    store.open(otherEnvironment, "agents");

    expect(store.openProactive(refA, pullRequestsList, revision)).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBe("agents");
    expect(
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, otherEnvironment),
    ).toBe("agents");
  });

  it("does not count an automatic device open as a manual choice", () => {
    const store = useRightPanelStore.getState();
    const revision = store.getUserActionRevision(refA);
    store.openDevice(
      refA,
      { hostId: "nucbox", deviceId: "emulator-5580", name: "Pixel", platform: "android" },
      true,
    );

    expect(store.getUserActionRevision(refA)).toBe(revision);
    expect(store.openProactive(refA, linkedPullRequest, revision)).toBe(true);
  });

  it("open sets the active panel for a thread", () => {
    useRightPanelStore.getState().open(refA, "agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBeNull();
  });

  it("opening a different kind keeps both surfaces and activates the new one", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().open(refA, "pull-requests");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe(
      "pull-requests",
    );
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
  });

  it("reopening an inactive singleton activates its existing surface", () => {
    useRightPanelStore.getState().open(refA, "pull-requests");
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().open(refA, "pull-requests");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "pull-requests",
      surfaces: [pullRequestsList, { id: "agents", kind: "agents" }],
    });
  });

  it("keeps agents as a singleton surface", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().open(refA, "agents");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents" }],
    });
  });

  it("close hides the panel without clearing its selected surface", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().close(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(
      selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toEqual({ id: "agents", kind: "agents" });
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents" }],
    });
  });

  it("toggles empty panel visibility without creating a surface", () => {
    useRightPanelStore.getState().toggleVisibility(refA);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    });

    useRightPanelStore.getState().toggleVisibility(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("toggle hides the panel without discarding the active surface", () => {
    useRightPanelStore.getState().toggle(refA, "agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("agents");
    useRightPanelStore.getState().toggle(refA, "agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents" }],
    });
  });

  it("toggle to a different kind switches active", () => {
    useRightPanelStore.getState().toggle(refA, "pull-requests");
    useRightPanelStore.getState().toggle(refA, "agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("agents");
  });

  it("removeThread clears persisted state", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().removeThread(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
  });

  it("close on never-opened thread is a no-op", () => {
    useRightPanelStore.getState().close(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("tracks one surface per pull request", () => {
    const first = { projectId: "project-a", repository: "acme/game", number: 4909 };
    const second = { projectId: "project-a", repository: "acme/game", number: 4910 };
    useRightPanelStore.getState().openPullRequest(refA, first);
    useRightPanelStore.getState().openPullRequest(refA, second);
    const url = "https://gitlab.example.com/acme/game/-/merge_requests/4909";
    useRightPanelStore.getState().openPullRequest(refA, { ...first, url });
    useRightPanelStore.getState().openPullRequest(refA, first);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(first),
      pullRequestSurfaceId(second),
    ]);
    expect(state.activeSurfaceId).toBe(pullRequestSurfaceId(first));
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toMatchObject({ url });
    expect(state.surfaces[1]).not.toHaveProperty("url");
  });

  it("keeps matching repository and number on different hosts as separate tabs", () => {
    const first = { projectId: "project-a", repository: "acme/api", number: 7, host: "github.com" };
    const second = { ...first, host: "github.example.com" };
    useRightPanelStore.getState().openPullRequest(refA, first);
    useRightPanelStore.getState().openPullRequest(refA, second);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toEqual([pullRequestSurface(first), pullRequestSurface(second)]);
    expect(pullRequestSurfaceId({ ...first, host: "GITHUB.COM" })).toBe(
      pullRequestSurfaceId(first),
    );
  });

  it("keeps one pull request read from two servers as two tabs", () => {
    const local = {
      environmentId: "local",
      projectId: "project-a",
      repository: "acme/game",
      number: 4909,
    };
    const remote = { ...local, environmentId: "remote" };

    useRightPanelStore.getState().openPullRequest(refA, local);
    useRightPanelStore.getState().openPullRequest(refA, remote);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(local),
      pullRequestSurfaceId(remote),
    ]);
  });

  it("closing the active surface activates a neighboring surface", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().openPullRequest(refA, linkedPullRequest);
    useRightPanelStore.getState().closeSurface(refA, linkedPullRequest.id);

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "agents",
    );
  });

  it("closing the final surface closes the panel", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().closeSurface(refA, "agents");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing other surfaces keeps the selected surface active", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().openPullRequest(refA, linkedPullRequest);
    useRightPanelStore.getState().open(refA, "pull-requests");

    useRightPanelStore.getState().closeOtherSurfaces(refA, linkedPullRequest.id);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: linkedPullRequest.id,
      surfaces: [linkedPullRequest],
    });
  });

  it("closing surfaces to the right activates the selected surface when active was removed", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().openPullRequest(refA, linkedPullRequest);
    useRightPanelStore.getState().open(refA, "pull-requests");

    useRightPanelStore.getState().closeSurfacesToRight(refA, "agents");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents" }],
    });
  });

  it("closing all surfaces closes the panel", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().openPullRequest(refA, linkedPullRequest);

    useRightPanelStore.getState().closeAllSurfaces(refA);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("selectActiveRightPanelSurface returns null when the panel is closed", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().close(refA);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toBeNull();
  });
});
