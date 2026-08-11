import { describe, expect, it } from "vite-plus/test";

import { describeUnityPipelineInstallOutcome } from "./unityPipelineInstallReport";

describe("describeUnityPipelineInstallOutcome — ok, freshly installed", () => {
  it("reports success and names BOTH files the old consent dialog used to explain up front", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.3.0",
        operation: "installed",
      },
      pairingOutcome: { _tag: "minted" },
    });

    expect(report.type).toBe("success");
    expect(report.title).toContain("Unity integrations");
    expect(report.description).toContain("manifest.json");
    expect(report.description).toContain("com.unity.pipeline@1.2.3");
    expect(report.description).toContain("com.devgame.editor-presence@0.3.0");
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
        packageId: "com.devgame.editor-presence",
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
    expect(report.description).toContain("com.devgame.editor-presence@0.3.0");
    expect(report.description).toContain("already paired");
  });

  it("reports an honest partial failure when package install succeeds but pairing handoff is skipped", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: true },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
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

describe("describeUnityPipelineInstallOutcome — package_resolve (task #130), silent on success", () => {
  it("adds a remedy line when package_resolve failed — the one non-silent case", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.3.0",
        operation: "installed",
      },
      pairingOutcome: { _tag: "minted" },
      packageResolve: "failed",
    });

    expect(report.type).toBe("success");
    expect(report.description).toContain("Unity");
    expect(report.description.toLowerCase()).toContain("click into");
  });

  it("says nothing extra when package_resolve was invoked successfully", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.3.0",
        operation: "installed",
      },
      pairingOutcome: { _tag: "minted" },
      packageResolve: "invoked",
    });

    expect(report.description.toLowerCase()).not.toContain("click into");
  });

  it("says nothing extra (no failure-remedy line) when package_resolve is absent (pre-#130 fixture) — genuinely silent, unlike skipped_no_editor below", () => {
    const absent = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.3.0",
        operation: "installed",
      },
      pairingOutcome: { _tag: "minted" },
    });

    expect(absent.description.toLowerCase()).not.toContain("click into");
    expect(absent.description.toLowerCase()).not.toContain("open the project in unity");
  });

  // CHANGED 2026-08-11 (merge-gate W2): this used to assert skipped_no_editor
  // says "nothing extra," same as invoked — that was the actual bug. Clicking
  // Setup with Unity closed (exactly what S13's own copy tells a user to do
  // AFTER opening Unity, but nothing stops them clicking with it still
  // closed) yields packageResolve: "skipped_no_editor", and this report used
  // to stay completely silent about it, so the toast read as an unqualified
  // success ("Unity integrations already installed") while the pipeline
  // package was, in fact, still just staged in the manifest, not actually
  // resolved. Silent is still correct for "invoked" (a live Editor really
  // did just load it) — "skipped_no_editor" is a genuinely different,
  // still-incomplete outcome and needs its own honest line.
  it("adds an honest 'package staged, open Unity to finish loading it' line when package_resolve was skipped (no live editor)", () => {
    const skipped = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.3.0",
        operation: "installed",
      },
      pairingOutcome: { _tag: "minted" },
      packageResolve: "skipped_no_editor",
    });

    // Never the FAILED-outcome remedy line (that implies a live Editor
    // attempt genuinely failed, which is not what happened here).
    expect(skipped.description.toLowerCase()).not.toContain("click into");
    expect(skipped.description.toLowerCase()).toContain("open the project in unity");
  });

  // The exact reproduction from the merge-gate finding: BOTH packages report
  // "alreadyInstalled" (a re-click of S13's own escape hatch is idempotent —
  // the manifest/embedded-copy writes were already done by the first click),
  // so this hits the toast's "already installed" branch specifically, not
  // the general "installed" one — the branch team-lead's own report named.
  it("the 'already installed' branch is NOT silent about skipped_no_editor either — this is the S13 re-click scenario verbatim", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: true },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.4.0",
        operation: "alreadyInstalled",
      },
      pairingOutcome: { _tag: "alreadyPaired" },
      packageResolve: "skipped_no_editor",
    });

    expect(report.title).toContain("already installed");
    expect(report.description.toLowerCase()).toContain("open the project in unity");
  });
});

describe("describeUnityPipelineInstallOutcome — legacy cleanup (the rename's migration), silent when nothing was removed", () => {
  it("names the removed legacy package when the Packages/ directory was actually swept", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.4.0",
        operation: "installed",
        legacyCleanup: { packagesDirectory: "removed", libraryDirectory: "absent" },
      },
      pairingOutcome: { _tag: "minted" },
    });

    expect(report.description).toContain("Removed the old com.ironmind.editor-presence package");
  });

  it("names the removed legacy package when only the stranded Library/ pairing directory was swept", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.4.0",
        operation: "installed",
        legacyCleanup: { packagesDirectory: "absent", libraryDirectory: "removed" },
      },
      pairingOutcome: { _tag: "minted" },
    });

    expect(report.description).toContain("Removed the old com.ironmind.editor-presence package");
  });

  it("stays silent when there was nothing legacy to remove", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.4.0",
        operation: "installed",
        legacyCleanup: { packagesDirectory: "absent", libraryDirectory: "absent" },
      },
      pairingOutcome: { _tag: "minted" },
    });

    expect(report.description).not.toContain("com.ironmind.editor-presence");
  });

  it("stays silent (not a false claim) when a legacy directory was found but could NOT be removed", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.4.0",
        operation: "installed",
        legacyCleanup: { packagesDirectory: "failed", libraryDirectory: "absent" },
      },
      pairingOutcome: { _tag: "minted" },
    });

    expect(report.description).not.toContain("com.ironmind.editor-presence");
  });

  it("stays silent when legacyCleanup is absent entirely (pre-rename fixture)", () => {
    const report = describeUnityPipelineInstallOutcome({
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.devgame.editor-presence",
        version: "0.3.0",
        operation: "installed",
      },
      pairingOutcome: { _tag: "minted" },
    });

    expect(report.description).not.toContain("com.ironmind.editor-presence");
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
