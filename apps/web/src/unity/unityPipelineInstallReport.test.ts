import { describe, expect, it } from "vite-plus/test";

import { describeUnityPipelineInstallOutcome } from "./unityPipelineInstallReport";

describe("describeUnityPipelineInstallOutcome — ok, freshly installed", () => {
  it("reports success and names BOTH files the old consent dialog used to explain up front", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
    });

    expect(report.type).toBe("success");
    // The whole point of "report, not a question": the manifest.json write
    // AND the later packages-lock.json/Assets churn the removed dialog used
    // to explain BEFORE the click must both still be named, just after it.
    expect(report.description).toContain("manifest.json");
    expect(report.description).toContain("packages-lock.json");
    expect(report.description).toContain("com.unity.pipeline@1.2.3");
  });
});

describe("describeUnityPipelineInstallOutcome — ok, already installed", () => {
  it("reports success but does NOT claim anything changed", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: true },
    });

    expect(report.type).toBe("success");
    expect(report.title).toContain("already installed");
    // The "here's what changes" explanation only makes sense when something
    // DID change — asserting it's absent here is what would catch a
    // careless implementation that always shows the same description
    // regardless of `alreadyInstalled`.
    expect(report.description).not.toContain("manifest.json");
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
