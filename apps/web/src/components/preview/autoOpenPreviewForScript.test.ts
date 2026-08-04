import type {
  DiscoveredLocalServer,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ProjectScript,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetPreviewStateForTests } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { resolveAutoOpenPreviewUrl, triggerAutoOpenPreview } from "./autoOpenPreviewForScript";

const THREAD_ID = "thread-1" as ThreadId;
const TERMINAL_ID = "terminal-1";
const threadRef: ScopedThreadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: THREAD_ID,
};

type ScriptShape = Pick<ProjectScript, "autoOpenPreview" | "previewUrl">;

const scriptWith = (overrides: Partial<ScriptShape>): ScriptShape => ({
  autoOpenPreview: true,
  previewUrl: "http://localhost:5173",
  ...overrides,
});

const listeningServer = (
  overrides: Partial<DiscoveredLocalServer> = {},
): DiscoveredLocalServer => ({
  host: "localhost",
  port: 5173,
  url: "http://localhost:5173",
  processName: "node",
  pid: 4321,
  terminal: { threadId: THREAD_ID, terminalId: TERMINAL_ID },
  ...overrides,
});

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: THREAD_ID,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-18T19:00:00.000Z",
});

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("resolveAutoOpenPreviewUrl — autoOpenPreview: false", () => {
  it("returns null even when previewUrl is set and the terminal is already listening", () => {
    const url = resolveAutoOpenPreviewUrl({
      script: scriptWith({ autoOpenPreview: false }),
      discoveredServers: [listeningServer()],
      threadId: THREAD_ID,
      terminalId: TERMINAL_ID,
    });
    expect(url).toBeNull();
  });
});

describe("resolveAutoOpenPreviewUrl — autoOpenPreview: true, no previewUrl", () => {
  it("returns null — ignored without previewUrl, per ProjectScript's own doc comment, regardless of what the scanner sees", () => {
    const url = resolveAutoOpenPreviewUrl({
      script: scriptWith({ previewUrl: undefined }),
      discoveredServers: [listeningServer()],
      threadId: THREAD_ID,
      terminalId: TERMINAL_ID,
    });
    expect(url).toBeNull();
  });
});

describe("resolveAutoOpenPreviewUrl — autoOpenPreview: true, previewUrl set, terminal not listening yet", () => {
  it("returns null — the dev server has not come up yet, so this keeps waiting rather than opening a dead URL", () => {
    const url = resolveAutoOpenPreviewUrl({
      script: scriptWith({}),
      discoveredServers: [],
      threadId: THREAD_ID,
      terminalId: TERMINAL_ID,
    });
    expect(url).toBeNull();
  });

  it("returns null when a DIFFERENT terminal is listening — correlation is by exact thread+terminal, not 'something is listening somewhere'", () => {
    const url = resolveAutoOpenPreviewUrl({
      script: scriptWith({}),
      discoveredServers: [
        listeningServer({ terminal: { threadId: THREAD_ID, terminalId: "terminal-other" } }),
        listeningServer({
          terminal: { threadId: "thread-other" as ThreadId, terminalId: TERMINAL_ID },
        }),
      ],
      threadId: THREAD_ID,
      terminalId: TERMINAL_ID,
    });
    expect(url).toBeNull();
  });
});

describe("resolveAutoOpenPreviewUrl — autoOpenPreview: true, previewUrl set, terminal now listening", () => {
  it("returns the CONFIGURED previewUrl, not the scanner's own reported url", () => {
    const url = resolveAutoOpenPreviewUrl({
      script: scriptWith({ previewUrl: "http://localhost:5173" }),
      // The scanner sees the dev server on a bumped port (5173 was taken) —
      // the configured previewUrl still wins, per "prefer the explicit URL".
      discoveredServers: [listeningServer({ port: 5174, url: "http://localhost:5174" })],
      threadId: THREAD_ID,
      terminalId: TERMINAL_ID,
    });
    expect(url).toBe("http://localhost:5173");
  });

  it("survives the dev server not being ready yet: null on the first (empty) scan, then resolves once a later scan shows the terminal listening", () => {
    const script = scriptWith({});
    const notYetListening = resolveAutoOpenPreviewUrl({
      script,
      discoveredServers: [],
      threadId: THREAD_ID,
      terminalId: TERMINAL_ID,
    });
    expect(notYetListening).toBeNull();

    const nowListening = resolveAutoOpenPreviewUrl({
      script,
      discoveredServers: [listeningServer()],
      threadId: THREAD_ID,
      terminalId: TERMINAL_ID,
    });
    expect(nowListening).toBe(script.previewUrl);
  });
});

// The composed effect ChatView.tsx's watch effect actually calls — these
// assert the REAL useRightPanelStore state changed (mirroring
// addBrowserSurface.test.ts's own bar), not that some function was invoked.
// This is the specific proof against the failure mode task P1-E exists to
// fix: a field that looked wired and did nothing.
describe("triggerAutoOpenPreview — autoOpenPreview: false", () => {
  it("does not open a preview surface, and does not call openPreview at all", async () => {
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    const opened = await triggerAutoOpenPreview({
      script: scriptWith({ autoOpenPreview: false }),
      discoveredServers: [listeningServer()],
      threadRef,
      terminalId: TERMINAL_ID,
      openPreview: ({ input }) => openPreview(input),
    });

    expect(opened).toBe(false);
    expect(openPreview).not.toHaveBeenCalled();
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
  });
});

describe("triggerAutoOpenPreview — autoOpenPreview: true, terminal listening", () => {
  it("actually opens the preview surface in useRightPanelStore, pointed at previewUrl", async () => {
    const tab = snapshot("tab-auto");
    const openPreview = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(tab));

    const opened = await triggerAutoOpenPreview({
      script: scriptWith({ previewUrl: "http://localhost:5173" }),
      discoveredServers: [listeningServer()],
      threadRef,
      terminalId: TERMINAL_ID,
      openPreview: ({ input }) => openPreview(input),
    });

    expect(opened).toBe(true);
    expect(openPreview).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      url: "http://localhost:5173",
    });
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      ).surfaces.map((surface) => surface.id),
    ).toEqual(["browser:tab-auto"]);
  });
});

describe("triggerAutoOpenPreview — autoOpenPreview: true, terminal NOT listening yet", () => {
  it("survives the dev server not being ready: does not open anything, does not throw, does not call openPreview", async () => {
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    const opened = await triggerAutoOpenPreview({
      script: scriptWith({}),
      discoveredServers: [], // nothing discovered yet — first scan, before the dev server is up
      threadRef,
      terminalId: TERMINAL_ID,
      openPreview: ({ input }) => openPreview(input),
    });

    expect(opened).toBe(false);
    expect(openPreview).not.toHaveBeenCalled();
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
  });
});
