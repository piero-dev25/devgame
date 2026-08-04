/**
 * The ONE normalization rule every workspace-root comparison in this repo
 * shares. Originally lived only in `apps/web/src/editorPresence/
 * resolveProjectEditor.ts` (that file's own comment: "a second, subtly-
 * different normalizer would let the Play/Stop toolbar and the chip
 * attachment disagree about whether an editor belongs to a project —
 * precisely the class of bug #71 already was"). Extracted here so a
 * SERVER-side caller (`UnitySetupProbe.ts`, matching `unity pipeline
 * list --json`'s `projectPath` against this project's own root) can share
 * the identical rule instead of writing a third comparison site — the
 * exact thing that comment warns against, just from the other side of the
 * client/server boundary.
 */
export function normalizeWorkspaceRoot(root: string): string {
  return root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
}
