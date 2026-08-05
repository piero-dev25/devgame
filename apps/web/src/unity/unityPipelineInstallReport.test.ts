import { describe, expect, it } from "vite-plus/test";

import { describeUnityPipelineInstallOutcome } from "./unityPipelineInstallReport";

describe("describeUnityPipelineInstallOutcome — ok, freshly installed", () => {
  it("reports success and names BOTH files the old consent dialog used to explain up front", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.ironmind.editor-presence",
        version: "0.3.0",
        operation: "installed",
      },
      pairingOutcome: { _tag: "minted" },
    });

    expect(report.type).toBe("success");
    expect(report.title).toContain("Unity integrations");
    expect(report.description).toContain("manifest.json");
    expect(report.description).toContain("com.unity.pipeline@1.2.3");
    expect(report.description).toContain("com.ironmind.editor-presence@0.3.0");
    expect(report.description).toContain("Packages/");
    expect(report.description).toContain("pairing will finish automatically");
  });
});

describe("describeUnityPipelineInstallOutcome — ok, already installed", () => {
  it("reports success but does NOT claim anything changed", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: true },
      selectionPackage: {
        packageId: "com.ironmind.editor-presence",
        version: "0.3.0",
        operation: "alreadyInstalled",
      },
      pairingOutcome: { _tag: "alreadyPaired" },
    });

    expect(report.type).toBe("success");
    expect(report.title).toContain("already installed");
    // The "here's what changes" explanation only makes sense when something
    // DID change — asserting it's absent here is what would catch a
    // careless implementation that always shows the same description
    // regardless of `alreadyInstalled`.
    expect(report.description).not.toContain("manifest.json");
    expect(report.description).toContain("com.unity.pipeline@1.2.3");
    expect(report.description).toContain("com.ironmind.editor-presence@0.3.0");
    expect(report.description).toContain("already paired");
  });

  it("reports an honest partial failure when package install succeeds but pairing handoff is skipped", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: true },
      selectionPackage: {
        packageId: "com.ironmind.editor-presence",
        version: "0.3.0",
        operation: "alreadyInstalled",
      },
      pairingOutcome: {
        _tag: "skipped",
        reason: "Could not write Unity pairing handoff.",
      },
    });

    expect(report.type).toBe("error");
    expect(report.title).toBe("Unity integrations installed, but pairing needs attention");
    expect(report.description).toContain("Could not write Unity pairing handoff.");
  });
});

describe("describeUnityPipelineInstallOutcome — failure branches", () => {
  it("uses the server's own message verbatim for a generic error", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "error",
      message: "unity binary exited with code 1",
    });

    expect(report.type).toBe("error");
    expect(report.description).toBe("unity binary exited with code 1");
  });

  it("names the CLI specifically for cliUnavailable — same copy ConnectionsSettings.tsx already uses", () => {
    const report = describeUnityPipelineInstallOutcome({ _tag: "cliUnavailable" });

    expect(report.description).toBe("The Unity CLI isn't available.");
  });

  it("says Unity isn't ready for notReady — same copy ConnectionsSettings.tsx already uses", () => {
    const report = describeUnityPipelineInstallOutcome({ _tag: "notReady" });

    expect(report.description).toBe("Unity isn't ready.");
  });
});
