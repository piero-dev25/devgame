// Proves `dispatchEditorPresenceCommand` actually validates the HTTP
// response it gets back, rather than trusting a compile-time cast (#101 —
// same shape as #99/#100's fix, see unity/dispatchCommand.test.ts for the
// identical structure on Unity's own dispatch path). Godot's Play/Stop runs
// through this file.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { dispatchEditorPresenceCommand } from "./dispatchCommand";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatchEditorPresenceCommand", () => {
  it("rejects with a SchemaError when the server response does not match EditorPresenceDispatchCommandResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ malformed: true })));

    let caught: unknown;
    try {
      await dispatchEditorPresenceCommand({
        httpBaseUrl: "http://127.0.0.1:3000",
        httpAuthorization: null,
        sessionId: "session-1",
        action: "play",
      });
      throw new Error("expected dispatchEditorPresenceCommand to reject");
    } catch (error) {
      caught = error;
    }
    expect(Schema.isSchemaError(caught)).toBe(true);
  });

  it("resolves with the decoded result for a well-formed response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));

    const result = await dispatchEditorPresenceCommand({
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
      sessionId: "session-1",
      action: "play",
    });

    expect(result).toEqual({ ok: true });
  });
});
