/**
 * The Workspace panel's two collections for a project a Mr. Mak import wrote
 * into: "Original Mr. Mak" (everything the import placed, opened read-only;
 * an item changed here since stays listed, marked Adapted) and "DevGame
 * Adaptation" (what was adapted from it or made here). Each card, workflow
 * (`processes/`), context file (`context/`) and skill carries the origin it
 * is labelled with.
 *
 * Origins come from the server's per-file status, which it reads from the
 * project's import receipt, so they are the same after a project switch or a
 * restart. Nothing here opens a file: every item carries a project-relative
 * path for the Files panel, which previews HTML only in its sandboxed frame.
 */
import type { MrMakImportFileOrigin, MrMakImportStatusSuccess } from "@t3tools/contracts";

import type { WorkspaceCardView } from "./resolveWorkspacePanelView";

/** `mrmak`: imported and unchanged. `adapted`: imported, then changed or removed here. */
export type WorkspaceItemOrigin = "mrmak" | "adapted" | "devgame";
export type WorkspaceCollectionId = "original" | "adaptation";

export interface WorkspaceFileItem {
  readonly path: string;
  /** The file name, or the path below `processes/` or `context/`. */
  readonly name: string;
  readonly origin: WorkspaceItemOrigin;
  /** False once removed here; such an item is listed but cannot be opened. */
  readonly removed: boolean;
}

export interface WorkspaceSkillItem {
  readonly name: string;
  readonly origin: WorkspaceItemOrigin;
  /** The skill's SKILL.md to open in the Files panel, or null when there is none. */
  readonly openPath: string | null;
}

export interface WorkspaceCollection {
  readonly cards: ReadonlyArray<{
    readonly card: WorkspaceCardView;
    readonly origin: WorkspaceItemOrigin;
  }>;
  readonly workflows: ReadonlyArray<WorkspaceFileItem>;
  readonly context: ReadonlyArray<WorkspaceFileItem>;
  readonly skills: ReadonlyArray<WorkspaceSkillItem>;
}

export interface WorkspaceCollections {
  readonly provenance: {
    readonly repositoryPath: string;
    readonly revision: string;
    readonly branch: string | null;
    readonly importedAt: string;
  };
  readonly original: WorkspaceCollection;
  readonly adaptation: WorkspaceCollection;
}

const SKILL_ROOTS = [".agents/skills/", ".claude/skills/"] as const;

/** A plain relative path inside the project: the only kind the Files panel is handed. */
const isProjectRelative = (path: string) =>
  path !== "" &&
  !path.startsWith("/") &&
  !/^[A-Za-z]:/.test(path) &&
  !path.includes("\\") &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

/** Several files' origins as one: unchanged only if every one is; none at all is DevGame's. */
function combine(origins: ReadonlyArray<MrMakImportFileOrigin | undefined>): WorkspaceItemOrigin {
  if (origins.every((origin) => origin === undefined || origin === "devgame")) return "devgame";
  return origins.every((origin) => origin === "original") ? "mrmak" : "adapted";
}

const itemOrigin = (origin: MrMakImportFileOrigin): WorkspaceItemOrigin =>
  origin === "original" ? "mrmak" : origin === "devgame" ? "devgame" : "adapted";

function emptyCollection(): {
  cards: Array<WorkspaceCollection["cards"][number]>;
  workflows: Array<WorkspaceFileItem>;
  context: Array<WorkspaceFileItem>;
  skills: Array<WorkspaceSkillItem>;
} {
  return { cards: [], workflows: [], context: [], skills: [] };
}

/**
 * Splits the panel's cards and the project's imported files into the two
 * collections, or null when the project holds no import (the panel then shows
 * its cards as before). Card order is the panel's own; a card keeps its id and
 * its steps in registry order.
 */
export function resolveWorkspaceCollections(input: {
  readonly cards: ReadonlyArray<WorkspaceCardView>;
  readonly status: MrMakImportStatusSuccess | null;
}): WorkspaceCollections | null {
  const imported = input.status?.import ?? null;
  if (imported === null) return null;
  const files = imported.files.filter((file) => isProjectRelative(file.path));
  const origins = new Map(files.map((file) => [file.path, file.origin]));
  const original = emptyCollection();
  const adaptation = emptyCollection();
  // Original keeps every imported item, adapted ones included (marked so);
  // Adaptation holds what changed here and what was made here.
  const into = (origin: WorkspaceItemOrigin) =>
    origin === "mrmak" ? [original] : origin === "adapted" ? [original, adaptation] : [adaptation];

  for (const card of input.cards) {
    const stepPaths = card.steps.flatMap((step) =>
      step.relativePath === null ? [] : [step.relativePath],
    );
    // A card with no steps is judged by the files in its folder.
    const folder = `workspace/${card.entity.folder}/`;
    const paths =
      stepPaths.length > 0
        ? stepPaths
        : files.filter((file) => file.path.startsWith(folder)).map((file) => file.path);
    const origin = combine(paths.map((path) => origins.get(path)));
    for (const collection of into(origin)) collection.cards.push({ card, origin });
  }

  for (const file of files) {
    const list = file.path.startsWith("processes/")
      ? "workflows"
      : file.path.startsWith("context/")
        ? "context"
        : null;
    if (list === null) continue;
    const origin = itemOrigin(file.origin);
    for (const collection of into(origin)) {
      collection[list].push({
        path: file.path,
        name: file.path.slice(file.path.indexOf("/") + 1),
        origin,
        removed: file.origin === "removed",
      });
    }
  }

  // Skills by folder name across both trees; the `.agents` copy is the one to open.
  const skills = new Map<
    string,
    { origins: Array<MrMakImportFileOrigin>; skillFiles: Array<string> }
  >();
  for (const file of files) {
    const root = SKILL_ROOTS.find((candidate) => file.path.startsWith(candidate));
    if (root === undefined) continue;
    const [name, ...rest] = file.path.slice(root.length).split("/");
    if (name === undefined || rest.length === 0) continue;
    const skill = skills.get(name) ?? { origins: [], skillFiles: [] };
    skill.origins.push(file.origin);
    if (rest.join("/") === "SKILL.md" && file.origin !== "removed")
      skill.skillFiles.push(file.path);
    skills.set(name, skill);
  }
  for (const [name, skill] of [...skills].toSorted(([a], [b]) => a.localeCompare(b))) {
    const origin = combine(skill.origins);
    for (const collection of into(origin)) {
      collection.skills.push({ name, origin, openPath: skill.skillFiles.toSorted()[0] ?? null });
    }
  }

  return {
    provenance: {
      repositoryPath: imported.receipt.source.repositoryPath,
      revision: imported.receipt.source.revision,
      branch: imported.receipt.source.branch,
      importedAt: imported.receipt.completedAt,
    },
    original,
    adaptation,
  };
}
