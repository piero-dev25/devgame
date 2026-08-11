import type { ProjectScript } from "@t3tools/contracts";

/**
 * Finds the project script the engine toolbar's three.js Play button should
 * run — the same gate `ChatView.tsx`'s `runProjectScript` already applies
 * internally when deciding whether to watch for the dev server and open the
 * preview (see its own comment: "Task P1-E ... ignored without a configured
 * previewUrl, matching ProjectScript.autoOpenPreview's own doc comment").
 * Restated here as its own pure function because the toolbar needs to know
 * WHETHER a script qualifies (to enable/disable the button) before any
 * script has actually been run — `runProjectScript` only makes that
 * decision after the fact, on whatever script it was handed.
 *
 * First match wins — `ProjectScript.autoOpenPreview`'s doc comment treats
 * this as a per-script opt-in, not a project-wide setting, so a project
 * with more than one such script has no principled "most correct" pick;
 * first-in-list is at least deterministic.
 */
export function resolveThreeJsPlayScript(
  scripts: ReadonlyArray<ProjectScript> | undefined,
): ProjectScript | null {
  if (!scripts) return null;
  for (const script of scripts) {
    if (script.autoOpenPreview === true && script.previewUrl) return script;
  }
  return null;
}
