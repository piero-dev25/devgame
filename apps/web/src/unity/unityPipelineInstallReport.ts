import type { UnityPipelineInstallResult } from "@t3tools/contracts";

/**
 * What to tell the user after `postUnityPipelineInstall` resolves — the
 * header CTA's whole "report, not a question" model (owner ruling: the
 * click is the consent, don't ask again; but the OLD consent dialog's
 * explanation of what actually changes — `Packages/manifest.json` now,
 * `Packages/packages-lock.json` and possibly `Assets/` once Unity resolves
 * it — doesn't just disappear, it moves to AFTER the click instead of
 * before it).
 *
 * Deliberately its own pure function, not inlined into `ChatView.tsx`'s
 * click handler: `ChatView.tsx` itself can't be mounted/tested in this repo
 * (drags in a Web Worker import at module scope — see
 * `resolveFilesDockPanelView.ts`'s doc comment for the same constraint on a
 * different file), so this is the one piece of the CTA's behaviour that CAN
 * get a real, direct test.
 *
 * The three failure branches' copy is deliberately identical to
 * `ConnectionsSettings.tsx`'s existing `UnityPipelineInstallButton` (same
 * three `UnityPipelineInstallResult` tags, same English) — a user should see
 * the same explanation for the same failure regardless of which surface
 * they clicked from. Not code-shared with that file (out of scope for this
 * change; flagged as a real dedup opportunity, not done here) — kept as
 * parallel, deliberately-matching copy instead.
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
    if (result.value.alreadyInstalled) {
      return {
        type: "success",
        title: "Pipeline package already installed",
        description: `com.unity.pipeline@${result.value.version} is already in this project — nothing to add.`,
      };
    }
    return {
      type: "success",
      title: "Pipeline package installed",
      description: `Added com.unity.pipeline@${result.value.version} to Packages/manifest.json. Unity updates Packages/packages-lock.json — and possibly other files under Assets/ — the next time it resolves this project.`,
    };
  }
  return {
    type: "error",
    title: "Could not install Pipeline package",
    description:
      result._tag === "error"
        ? result.message
        : result._tag === "cliUnavailable"
          ? "The Unity CLI isn't available."
          : "Unity isn't ready.",
  };
}
