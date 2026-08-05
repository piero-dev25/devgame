import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { UnityEditorPresencePairingFile } from "./unityPipelineInstall.ts";

const decodePairingFile = Schema.decodeUnknownSync(UnityEditorPresencePairingFile);

describe("Unity editor-presence pairing handoff contract", () => {
  it("exports a schema for the exact pairing.json shape", () => {
    expect(
      decodePairingFile({
        serverUrl: "http://127.0.0.1:3773",
        pairingCredential: "PAIRING1234",
      }),
    ).toEqual({
      serverUrl: "http://127.0.0.1:3773",
      pairingCredential: "PAIRING1234",
    });
  });
});
