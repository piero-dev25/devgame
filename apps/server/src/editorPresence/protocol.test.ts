import { describe, expect, it } from "@effect/vitest";

import {
  buildCommandFrame,
  DEFAULT_EDITOR_PRESENCE_CAPABILITIES,
  describeHelloValidationFailure,
  parseEditorPresenceInboundFrame,
} from "./protocol.ts";

const VALID_HELLO = {
  v: 1,
  type: "hello",
  editor: { id: "unity", name: "Unity Editor", version: "6000.3.14f1" },
  session: { id: "session-1" },
  workspace: { root: "/Users/piero/Projects/Deepmind" },
};

function selectionFrame(seq: unknown): string {
  return JSON.stringify({
    v: 1,
    type: "selection",
    seq,
    at: "2026-08-03T00:00:00.000Z",
    items: [],
  });
}

describe("seq validation (bug #4: the seq guard could wedge a publisher forever)", () => {
  it("accepts 0, small integers, and the largest safe integer", () => {
    for (const seq of [0, 1, 2, 100, Number.MAX_SAFE_INTEGER]) {
      const frame = parseEditorPresenceInboundFrame(selectionFrame(seq));
      expect(frame, `seq=${seq} should parse`).not.toBeNull();
      expect(frame?.type === "selection" && frame.selection.seq).toBe(seq);
    }
  });

  it("rejects an astronomical value that would permanently wedge the monotonic guard", () => {
    // Measured live: seq=1e308 was previously accepted (Number.isFinite(1e308)
    // is true), after which every legitimate seq=1,2,100 was silently
    // dropped forever by the registry's `seq <= last seen` guard.
    const frame = parseEditorPresenceInboundFrame(selectionFrame(1e308));
    expect(frame).toBeNull();
  });

  it("rejects non-integer, negative, NaN, and Infinity", () => {
    for (const seq of [2.5, -1, -0.5, NaN, Infinity, -Infinity]) {
      const frame = parseEditorPresenceInboundFrame(selectionFrame(seq));
      expect(frame, `seq=${seq} should be rejected`).toBeNull();
    }
  });

  it("rejects a non-number seq", () => {
    for (const seq of ["1", null, undefined, {}, []]) {
      const frame = parseEditorPresenceInboundFrame(selectionFrame(seq));
      expect(frame, `seq=${JSON.stringify(seq)} should be rejected`).toBeNull();
    }
  });
});

describe("describeHelloValidationFailure (bug #3: a malformed hello must be loud, not silent)", () => {
  it("returns null for a fully valid hello — nothing to describe", () => {
    expect(describeHelloValidationFailure(JSON.stringify(VALID_HELLO))).toBeNull();
  });

  it("returns null for anything that is not a v:1 type:'hello' frame — unchanged silent-drop path", () => {
    expect(describeHelloValidationFailure("not json")).toBeNull();
    expect(describeHelloValidationFailure(JSON.stringify({ v: 1, type: "ping" }))).toBeNull();
    expect(
      describeHelloValidationFailure(
        JSON.stringify({ v: 1, type: "selection", seq: 1, at: "t", items: [] }),
      ),
    ).toBeNull();
    expect(describeHelloValidationFailure(JSON.stringify({ v: 2, type: "hello" }))).toBeNull();
  });

  // The seven field faults named in the live critic pass, plus the two new
  // `capabilities` faults task #47 adds.
  const malformedCases: ReadonlyArray<readonly [string, unknown]> = [
    ["missing editor.version", { ...VALID_HELLO, editor: { id: "unity", name: "Unity Editor" } }],
    ["empty workspace.root", { ...VALID_HELLO, workspace: { root: "" } }],
    ["non-string session.id", { ...VALID_HELLO, session: { id: 12345 } }],
    ["missing editor entirely", { ...VALID_HELLO, editor: undefined }],
    ["missing session entirely", { ...VALID_HELLO, session: undefined }],
    ["missing workspace entirely", { ...VALID_HELLO, workspace: undefined }],
    ["blank editor.id", { ...VALID_HELLO, editor: { ...VALID_HELLO.editor, id: "   " } }],
    ["capabilities is not an array", { ...VALID_HELLO, capabilities: "play,stop" }],
    ["capabilities contains a non-string entry", { ...VALID_HELLO, capabilities: ["play", 42] }],
  ];

  for (const [name, malformed] of malformedCases) {
    it(`flags: ${name}`, () => {
      const reason = describeHelloValidationFailure(JSON.stringify(malformed));
      expect(reason).not.toBeNull();
      expect(typeof reason).toBe("string");
    });
  }
});

describe("hello.capabilities (task #47: the toolbar must not offer what an engine can't do)", () => {
  it("defaults to no capabilities when the key is absent — an older plugin keeps working, but claims nothing it can't do", () => {
    // VALID_HELLO itself has no `capabilities` key — JSON.stringify omits
    // any key whose value is `undefined`, so this is the "key genuinely
    // absent" case, not "key present but undefined" (which isn't
    // representable in JSON at all).
    expect(Object.hasOwn(VALID_HELLO, "capabilities")).toBe(false);
    const frame = parseEditorPresenceInboundFrame(JSON.stringify(VALID_HELLO));
    expect(frame?.type === "hello" && frame.capabilities).toEqual(
      DEFAULT_EDITOR_PRESENCE_CAPABILITIES,
    );
  });

  it("parses a declared capability list exactly as sent", () => {
    const frame = parseEditorPresenceInboundFrame(
      JSON.stringify({ ...VALID_HELLO, capabilities: ["play", "stop", "step", "pause"] }),
    );
    expect(frame?.type === "hello" && frame.capabilities).toEqual([
      "play",
      "stop",
      "step",
      "pause",
    ]);
  });

  it("rejects the whole hello (not a silent default) when capabilities is malformed", () => {
    // Loud, not silent — same treatment as every other hello field. A
    // publisher that thinks it correctly declared ["play","stop","step"]
    // deserves to find out its shape was wrong, not have it silently
    // downgraded to the empty default.
    expect(
      parseEditorPresenceInboundFrame(
        JSON.stringify({ ...VALID_HELLO, capabilities: "play,stop" }),
      ),
    ).toBeNull();
    expect(
      parseEditorPresenceInboundFrame(
        JSON.stringify({ ...VALID_HELLO, capabilities: ["play", ""] }),
      ),
    ).toBeNull();
  });
});

describe("commandResult parsing (server -> engine command's reply)", () => {
  it("parses a successful reply", () => {
    const frame = parseEditorPresenceInboundFrame(
      JSON.stringify({ v: 1, type: "commandResult", id: "cmd-1", ok: true }),
    );
    expect(frame).toEqual({ type: "commandResult", id: "cmd-1", ok: true });
  });

  it("parses a failed reply with its machine-readable error", () => {
    const frame = parseEditorPresenceInboundFrame(
      JSON.stringify({
        v: 1,
        type: "commandResult",
        id: "cmd-1",
        ok: false,
        error: "unsupported_action",
      }),
    );
    expect(frame).toEqual({
      type: "commandResult",
      id: "cmd-1",
      ok: false,
      error: "unsupported_action",
    });
  });

  it("drops (not loudly rejects) a commandResult missing its id", () => {
    expect(
      parseEditorPresenceInboundFrame(JSON.stringify({ v: 1, type: "commandResult", ok: true })),
    ).toBeNull();
  });

  it("drops a failed reply with no error string — spec requires a machine-readable reason", () => {
    expect(
      parseEditorPresenceInboundFrame(
        JSON.stringify({ v: 1, type: "commandResult", id: "cmd-1", ok: false }),
      ),
    ).toBeNull();
  });

  it("drops a commandResult whose ok field is neither true nor false", () => {
    expect(
      parseEditorPresenceInboundFrame(
        JSON.stringify({ v: 1, type: "commandResult", id: "cmd-1", ok: "yes" }),
      ),
    ).toBeNull();
  });
});

describe("buildCommandFrame (server -> engine, FLAT per the module doc's wire-shape note)", () => {
  it("builds a flat frame with no params key when params is omitted", () => {
    const raw = buildCommandFrame("cmd-1", "2026-08-03T00:00:00.000Z", "play");
    expect(JSON.parse(raw)).toEqual({
      v: 1,
      type: "command",
      id: "cmd-1",
      at: "2026-08-03T00:00:00.000Z",
      action: "play",
    });
    expect(Object.hasOwn(JSON.parse(raw), "params")).toBe(false);
  });

  it("includes params verbatim when provided", () => {
    const raw = buildCommandFrame("cmd-2", "2026-08-03T00:00:00.000Z", "step", { frames: 1 });
    expect(JSON.parse(raw)).toEqual({
      v: 1,
      type: "command",
      id: "cmd-2",
      at: "2026-08-03T00:00:00.000Z",
      action: "step",
      params: { frames: 1 },
    });
  });

  it("action is an open string — an engine-specific action round-trips unchanged", () => {
    // Consistent with editor.id / items[].kind: the SERVER does not
    // validate or constrain action names — see dispatchEditorCommand /
    // sendCommand, which never inspect `action` beyond forwarding it.
    const raw = buildCommandFrame("cmd-3", "t", "unity.frameStepBackward");
    expect(JSON.parse(raw).action).toBe("unity.frameStepBackward");
  });
});

describe("playState parsing (task #49: play state is a level, not correlated to any command)", () => {
  it("parses each of the three closed-union values", () => {
    for (const playState of ["stopped", "playing", "paused"]) {
      const frame = parseEditorPresenceInboundFrame(
        JSON.stringify({ v: 1, type: "playState", playState }),
      );
      expect(frame, playState).toEqual({ type: "playState", playState });
    }
  });

  it("drops (not loudly rejects) a missing playState — same treatment as selection/ping/commandResult", () => {
    expect(parseEditorPresenceInboundFrame(JSON.stringify({ v: 1, type: "playState" }))).toBeNull();
  });

  it("drops an unrecognised playState value — closed union, not open like action/kind", () => {
    for (const playState of ["running", "Playing", "PAUSED", "", 1, null, true]) {
      expect(
        parseEditorPresenceInboundFrame(JSON.stringify({ v: 1, type: "playState", playState })),
        JSON.stringify(playState),
      ).toBeNull();
    }
  });
});
