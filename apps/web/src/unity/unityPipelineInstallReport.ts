import type { UnityPipelineInstallResult } from "@t3tools/contracts";

/**
 * What to tell the user after the one-click install resolves. Kept as a pure
 * function because the chat view itself cannot be mounted in this test
 * environment. Successful copy names both packages and distinguishes a full
 * no-op from an install or replacement without exposing any source path.
 */
export interface UnityPipelineInstallReport {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description: string;
}

export function describeUnityPipelineInstallOutcome(
  result: UnityPipelineInstallResult,
): UnityPipelineInstallReport {
  if (result._tag === "ok") {
    const pipeline = `${result.value.packageId}@${result.value.version}`;
    const selection = `${result.selectionPackage.packageId}@${result.selectionPackage.version}`;
    const pipelineAlreadyInstalled = result.value.alreadyInstalled;
    const selectionAlreadyInstalled = result.selectionPackage.operation === "alreadyInstalled";
    const pairingReport =
      result.pairingOutcome._tag === "minted"
        ? "A fresh pairing credential was handed off; pairing will finish automatically in Unity."
        : result.pairingOutcome._tag === "alreadyPaired"
          ? "Unity selection is already paired."
          : result.pairingOutcome.reason;
    // The rename's legacy-cleanup migration (com.ironmind.editor-presence ->
    // com.devgame.editor-presence) sweeps a stranded pre-rename directory on
    // EVERY install call, not just fresh ones — see
    // `UnityEmbeddedSelectionPackage.ts`'s own doc comment. This surface was
    // left silent when that landed; silent on the common case (nothing
    // legacy found, or a legacy dir was found but couldn't be removed — the
    // latter must NOT claim success it didn't have) and only speaks up when
    // something was actually swept.
    const legacyRemoved =
      result.selectionPackage.legacyCleanup !== undefined &&
      (result.selectionPackage.legacyCleanup.packagesDirectory === "removed" ||
        result.selectionPackage.legacyCleanup.libraryDirectory === "removed");
    const legacyRemovedLine = legacyRemoved
      ? " Removed the old com.ironmind.editor-presence package."
      : "";
    // Task #130's package_resolve nudge: silent ONLY for `"invoked"` — a
    // live Editor really did just load the package, so there's nothing left
    // to tell the user. `"failed"` and `"skipped_no_editor"` are BOTH
    // genuinely incomplete outcomes and each need their own honest line.
    //
    // CHANGED 2026-08-11 (merge-gate W2): `"skipped_no_editor"` used to be
    // silent too, under the same "embedded-package copy already succeeded,
    // this nudge is best-effort" reasoning that's still correct for
    // `"failed"` — but for `"skipped_no_editor"` that reasoning missed the
    // actual S13 scenario: clicking Setup while Unity is closed (exactly
    // what a user might do BEFORE following S13's own "open Unity" copy,
    // not after) is the COMMON case here, not a rare failure, and staying
    // silent let the toast read as an unqualified "Unity integrations
    // already installed" while the pipeline package was, in fact, still
    // just staged in the manifest — never actually resolved. Worded
    // differently from the `"failed"` line on purpose: this is not a
    // failure to explain away, just an honest "not finished yet."
    const packageResolveFailedLine =
      result.packageResolve === "failed"
        ? " If the change hasn't appeared in Unity, click into the Editor to trigger it — it will also load automatically the next time you open the project."
        : "";
    const packageResolveSkippedLine =
      result.packageResolve === "skipped_no_editor"
        ? " Unity isn't open for this project right now — the package is staged; open the project in Unity to finish loading it."
        : "";
    const trailer = `${legacyRemovedLine}${packageResolveFailedLine}${packageResolveSkippedLine}`;
    if (pipelineAlreadyInstalled && selectionAlreadyInstalled) {
      if (result.pairingOutcome._tag === "skipped") {
        return {
          type: "error",
          title: "Unity integrations installed, but pairing needs attention",
          description: `${pipeline} and ${selection} are already in this project. ${pairingReport}${trailer}`,
        };
      }
      return {
        type: "success",
        title: "Unity integrations already installed",
        description: `${pipeline} and ${selection} are already in this project. ${pairingReport}${trailer}`,
      };
    }
    const pipelineReport = pipelineAlreadyInstalled
      ? `${pipeline} was already installed.`
      : `Added ${pipeline} to Packages/manifest.json.`;
    const selectionReport =
      result.selectionPackage.operation === "replaced"
        ? `Replaced the embedded ${selection} package under Packages/.`
        : result.selectionPackage.operation === "alreadyInstalled"
          ? `${selection} was already embedded under Packages/.`
          : `Embedded ${selection} under Packages/.`;
    const packageReport = `${pipelineReport} ${selectionReport}`;
    return result.pairingOutcome._tag === "skipped"
      ? {
          type: "error",
          title: "Unity integrations installed, but pairing needs attention",
          description: `${packageReport} ${pairingReport}${trailer}`,
        }
      : {
          type: "success",
          title: "Unity integrations installed",
          description: `${packageReport} ${pairingReport}${trailer}`,
        };
  }
  return {
    type: "error",
    title: "Could not install Unity integrations",
    description:
      result._tag === "error"
        ? result.message
        : result._tag === "cliUnavailable"
          ? "The Unity CLI isn't available."
          : "Unity isn't ready.",
  };
}
