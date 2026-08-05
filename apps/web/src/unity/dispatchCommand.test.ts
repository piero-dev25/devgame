// Proves `dispatchUnityCommand` actually validates the HTTP response it
// gets back, rather than trusting a compile-time cast (#101 — same shape as
// #99/#100's fetchSetupProbe.ts/postPipelineInstall.ts fix). This is the
// Play/Stop path: an unvalidated response here feeds engine command results
// straight into the toolbar's state.
//
// The malformed case is load-bearing: before the real
// `Schema.decodeUnknownEffect` decode was wired in, this exact test failed
// (the promise RESOLVED with `{ malformed: true }` reinterpreted as a
// `UnityCommandResult`). The well-formed-response case is the CONTROL that
// makes the malformed assertion non-vacuous — both cases stub `fetch`
// through the identical mechanism, so a broken stub would fail both, not
// just the negative one (per team-lead's note on the #99/#100 review).
// Asserting `Schema.isSchemaError` specifically (rather than a bare
// `rejects.toBeTruthy()`) closes the rest of that gap on its own.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { dispatchUnityCommand } from "./dispatchCommand";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatchUnityCommand", () => {
  it("rejects with a SchemaError when the server response does not match UnityCommandResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ malformed: true })));

    let caught: unknown;
    try {
      await dispatchUnityCommand({
        httpBaseUrl: "http://127.0.0.1:3000",
        httpAuthorization: null,
        workspaceRoot: "/tmp/project",
        action: "play",
      });
      throw new Error("expected dispatchUnityCommand to reject");
    } catch (error) {
      caught = error;
    }
    expect(Schema.isSchemaError(caught)).toBe(true);
  });

  it("resolves with the decoded result for a well-formed response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ _tag: "notReady" })));

    const result = await dispatchUnityCommand({
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
      workspaceRoot: "/tmp/project",
      action: "play",
    });

    expect(result).toEqual({ _tag: "notReady" });
  });
});
