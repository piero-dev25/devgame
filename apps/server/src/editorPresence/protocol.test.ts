import { describe, expect, it } from "@effect/vitest";

import { describeHelloValidationFailure, parseEditorPresenceInboundFrame } from "./protocol.ts";

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

  // The seven field faults named in the live critic pass.
  const malformedCases: ReadonlyArray<readonly [string, unknown]> = [
    ["missing editor.version", { ...VALID_HELLO, editor: { id: "unity", name: "Unity Editor" } }],
    ["empty workspace.root", { ...VALID_HELLO, workspace: { root: "" } }],
    ["non-string session.id", { ...VALID_HELLO, session: { id: 12345 } }],
    ["missing editor entirely", { ...VALID_HELLO, editor: undefined }],
    ["missing session entirely", { ...VALID_HELLO, session: undefined }],
    ["missing workspace entirely", { ...VALID_HELLO, workspace: undefined }],
    ["blank editor.id", { ...VALID_HELLO, editor: { ...VALID_HELLO.editor, id: "   " } }],
  ];

  for (const [name, malformed] of malformedCases) {
    it(`flags: ${name}`, () => {
      const reason = describeHelloValidationFailure(JSON.stringify(malformed));
      expect(reason).not.toBeNull();
      expect(typeof reason).toBe("string");
    });
  }
});
