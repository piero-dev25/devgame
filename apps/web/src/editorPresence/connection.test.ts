import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  openEditorPresenceConnection,
  type EditorPresenceConnectionState,
  type EditorPresenceSocketFactory,
  type EditorPresenceSocketLike,
} from "./connection";

interface PresenceFrameTestEditor {
  readonly editorId: string;
  readonly sessionId: string;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly label: string;
  }>;
}

/** Builds a valid `presence` frame JSON string (the same shape
 * `parseEditorPresenceFrame` expects) instead of hand-rolling ad hoc JSON
 * per test. */
function buildPresenceFrameForTest(editors: ReadonlyArray<PresenceFrameTestEditor>): string {
  return JSON.stringify({
    v: 1,
    type: "presence",
    editors: editors.map((editor) => ({
      editor: { id: editor.editorId, name: editor.editorId, version: "0.0.0" },
      session: { id: editor.sessionId },
      workspace: { root: "/repo" },
      connected: true,
      lastSeenAt: "2026-08-01T00:00:00.000Z",
      selection: {
        seq: 1,
        at: "2026-08-01T00:00:00.000Z",
        items: editor.items.map((item) => ({
          id: item.id,
          kind: item.kind,
          label: item.label,
          path: null,
          detail: null,
        })),
      },
    })),
  });
}

class FakeSocket implements EditorPresenceSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
  }
}

function makeSocketFactory(): { factory: EditorPresenceSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: EditorPresenceSocketFactory = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

function queryParams(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

const BASE_CONFIG = {
  httpBaseUrl: "https://environment.example/",
  socketUrl: "wss://environment.example/ws?wsTicket=primary-socket-ticket",
};

describe("openEditorPresenceConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("the unauthenticated (no-ticket) connection path: mints no ticket and opens with no wsTicket param", async () => {
    const { factory, sockets } = makeSocketFactory();
    const states: EditorPresenceConnectionState[] = [];

    const connection = openEditorPresenceConnection({
      ...BASE_CONFIG,
      httpAuthorization: null,
      createSocket: factory,
      onStateChange: (state) => states.push(state),
      // No `mintTicket` override — exercises the real default, which must
      // short-circuit to `null` for a null `httpAuthorization` without
      // touching the app's Effect runtime.
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const params = queryParams(sockets[0]!.url);
    expect(params.get("role")).toBe("subscriber");
    expect(params.has("wsTicket")).toBe(false);
    // And never reuses the primary socket's own embedded ticket.
    expect(sockets[0]!.url).not.toContain("primary-socket-ticket");

    connection.dispose();
  });

  it("mints a fresh ticket for an authenticated connection and attaches it as wsTicket", async () => {
    const { factory, sockets } = makeSocketFactory();
    const mintTicket = vi.fn(async () => "ticket-abc");

    const connection = openEditorPresenceConnection({
      ...BASE_CONFIG,
      httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
      createSocket: factory,
      mintTicket,
      onStateChange: () => {},
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(mintTicket).toHaveBeenCalledWith(BASE_CONFIG.httpBaseUrl, {
      _tag: "Bearer",
      token: "bearer-token",
    });
    expect(queryParams(sockets[0]!.url).get("wsTicket")).toBe("ticket-abc");

    connection.dispose();
  });

  it("mints a fresh ticket on every reconnect rather than reusing the first one", async () => {
    const { factory, sockets } = makeSocketFactory();
    let ticketCount = 0;
    const mintTicket = vi.fn(async () => `ticket-${++ticketCount}`);

    const connection = openEditorPresenceConnection({
      ...BASE_CONFIG,
      httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
      createSocket: factory,
      mintTicket,
      onStateChange: () => {},
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(queryParams(sockets[0]!.url).get("wsTicket")).toBe("ticket-1");

    sockets[0]!.onclose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(queryParams(sockets[1]!.url).get("wsTicket")).toBe("ticket-2");
    expect(mintTicket).toHaveBeenCalledTimes(2);

    connection.dispose();
  });

  it("a presence frame replaces state wholesale rather than merging with the previous one", async () => {
    const { factory, sockets } = makeSocketFactory();
    const states: EditorPresenceConnectionState[] = [];

    const connection = openEditorPresenceConnection({
      ...BASE_CONFIG,
      httpAuthorization: null,
      createSocket: factory,
      onStateChange: (state) => states.push(state),
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onopen?.();

    const frameA = buildPresenceFrameForTest([
      {
        editorId: "unity",
        sessionId: "session-1",
        items: [{ id: "a", kind: "gameObject", label: "A" }],
      },
    ]);
    sockets[0]!.onmessage?.({ data: frameA });
    const afterFirstFrame = states[states.length - 1]!;
    expect(afterFirstFrame.editors).toHaveLength(1);
    expect(afterFirstFrame.editors[0]!.session.id).toBe("session-1");

    const frameB = buildPresenceFrameForTest([
      { editorId: "godot", sessionId: "session-2", items: [{ id: "b", kind: "node", label: "B" }] },
    ]);
    sockets[0]!.onmessage?.({ data: frameB });
    const afterSecondFrame = states[states.length - 1]!;
    // Only session-2 is present — session-1 was not merged forward.
    expect(afterSecondFrame.editors).toHaveLength(1);
    expect(afterSecondFrame.editors[0]!.session.id).toBe("session-2");

    connection.dispose();
  });

  it("an unknown item kind is delivered without throwing", async () => {
    const { factory, sockets } = makeSocketFactory();
    const states: EditorPresenceConnectionState[] = [];

    const connection = openEditorPresenceConnection({
      ...BASE_CONFIG,
      httpAuthorization: null,
      createSocket: factory,
      onStateChange: (state) => states.push(state),
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onopen?.();

    const frame = buildPresenceFrameForTest([
      {
        editorId: "future-engine",
        sessionId: "session-1",
        items: [{ id: "x", kind: "a-brand-new-object-kind-nobody-has-seen", label: "Mystery" }],
      },
    ]);
    expect(() => sockets[0]!.onmessage?.({ data: frame })).not.toThrow();

    const latest = states[states.length - 1]!;
    expect(latest.editors[0]!.selection?.items[0]!.kind).toBe(
      "a-brand-new-object-kind-nobody-has-seen",
    );

    connection.dispose();
  });

  it("a transport-level close (no session established) shows a fixed 'cannot reach' message and keeps retrying", async () => {
    const { factory, sockets } = makeSocketFactory();
    const states: EditorPresenceConnectionState[] = [];

    const connection = openEditorPresenceConnection({
      ...BASE_CONFIG,
      httpAuthorization: null,
      createSocket: factory,
      onStateChange: (state) => states.push(state),
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    // A rejected handshake and a dead port both surface this way to a
    // browser client — no application close code, no meaningful reason.
    sockets[0]!.onclose?.({ code: 1006, reason: "" });
    expect(states[states.length - 1]!.disconnectReason).toBe(
      `cannot reach Workbench at ${BASE_CONFIG.httpBaseUrl}`,
    );

    // Not a credential problem, so it keeps backing off and retrying.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.onopen?.();
    expect(states[states.length - 1]!.disconnectReason).toBeNull();

    connection.dispose();
  });

  it("a ticket-mint failure is treated the same as no session established: 'cannot reach' plus retry", async () => {
    const { factory, sockets } = makeSocketFactory();
    const states: EditorPresenceConnectionState[] = [];
    let shouldFail = true;
    const mintTicket = vi.fn(async () => {
      if (shouldFail) throw new Error("network error minting ticket");
      return "ticket-after-recovery";
    });

    const connection = openEditorPresenceConnection({
      ...BASE_CONFIG,
      httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
      createSocket: factory,
      mintTicket,
      onStateChange: (state) => states.push(state),
    });

    await vi.waitFor(() => expect(mintTicket).toHaveBeenCalledTimes(1));
    expect(sockets).toHaveLength(0);
    await vi.waitFor(() =>
      expect(states[states.length - 1]!.disconnectReason).toBe(
        `cannot reach Workbench at ${BASE_CONFIG.httpBaseUrl}`,
      ),
    );

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(queryParams(sockets[0]!.url).get("wsTicket")).toBe("ticket-after-recovery");

    connection.dispose();
  });

  it("an application-level close (code >= 4000) shows the server's reason verbatim and does not reconnect", async () => {
    const { factory, sockets } = makeSocketFactory();
    const states: EditorPresenceConnectionState[] = [];

    const connection = openEditorPresenceConnection({
      ...BASE_CONFIG,
      httpAuthorization: null,
      createSocket: factory,
      onStateChange: (state) => states.push(state),
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0]!.onclose?.({ code: 4003, reason: "Session revoked" });
    expect(states[states.length - 1]!).toEqual({
      phase: "disconnected",
      editors: [],
      disconnectReason: "Session revoked",
    });

    // A credential problem cannot be fixed by retrying — no reconnect,
    // ever, no matter how long we wait.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sockets).toHaveLength(1);

    connection.dispose();
  });

  it("dispose tears the socket down and suppresses any further callbacks", async () => {
    const { factory, sockets } = makeSocketFactory();
    const onStateChange = vi.fn();

    const connection = openEditorPresenceConnection({
      ...BASE_CONFIG,
      httpAuthorization: null,
      createSocket: factory,
      onStateChange,
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const callCountAtDispose = onStateChange.mock.calls.length;

    connection.dispose();
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets[0]!.onmessage).toBeNull();

    // A stray event arriving right after dispose (a real socket can still
    // fire callbacks synchronously during teardown) must not reach the
    // caller.
    sockets[0]!.onopen?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStateChange.mock.calls.length).toBe(callCountAtDispose);
  });
});
