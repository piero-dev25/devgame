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
    if (pipelineAlreadyInstalled && selectionAlreadyInstalled) {
      if (result.pairingOutcome._tag === "skipped") {
        return {
          type: "error",
          title: "Unity integrations installed, but pairing needs attention",
          description: `${pipeline} and ${selection} are already in this project. ${pairingReport}`,
        };
      }
      return {
        type: "success",
        title: "Unity integrations already installed",
        description: `${pipeline} and ${selection} are already in this project. ${pairingReport}`,
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
          description: `${packageReport} ${pairingReport}`,
        }
      : {
          type: "success",
          title: "Unity integrations installed",
          description: `${packageReport} ${pairingReport}`,
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
