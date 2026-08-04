import type { GroupviewPanelState, SerializedDockview, SerializedGridObject } from "dockview";

import type { PanelRegistry } from "./panelRegistry";

/**
 * The `data` shape of a LEAF grid node — dockview-core's real name for this
 * is `GroupPanelViewState`, but it isn't part of the public `dockview`
 * package's exported surface (unlike its sibling `GroupviewPanelState`, the
 * PANELS-MAP entry type, imported above, which is exported). Redeclared
 * locally with just the fields this file actually reads/writes — `id`,
 * `views`, `activeView` — every other field on the real type
 * (`CoreGroupOptions`: `locked`, `hideHeader`, `constraints`, …) is already
 * optional there, so a plain object with just these three fully satisfies
 * it structurally at every assignment site below.
 */
interface LeafGroupData {
  id: string;
  views: string[];
  activeView?: string;
}

type DockviewGridNode = SerializedGridObject<LeafGroupData>;

/**
 * Fix round after 7606dff45. The bug this closes: `ChatDock.tsx` handled
 * "a saved layout predates a newly-registered panel" by bumping
 * `CHAT_DOCK_WORKSPACE_ID` — which doesn't migrate anything, it points
 * `storage.load` at a brand-new, empty key, so the workspace's saved
 * arrangement is silently replaced by the default preset. Twice (v1→v2,
 * v2→v3). The owner's own dragged arrangement was sitting in the orphaned
 * v2 key, thrown away the moment the Files panel shipped.
 *
 * This function is the actual fix: given a loaded (possibly stale) layout
 * and the CURRENT panel registry, insert any panel that's newly registered
 * since the layout was last saved into the EXISTING arrangement, at the
 * position the current default preset would put it — while leaving every
 * panel the loaded layout already had untouched, in place, at its saved
 * size.
 *
 * What counts as "newly registered" vs. "the user closed it on purpose" —
 * this is the one subtlety that makes a naive "add whatever's registered
 * but missing" wrong: both look IDENTICAL in a plain diff (the panel is
 * absent from both `grid` and `panels` either way). The only way to tell
 * them apart is to have recorded, at save time, which panel ids the catalog
 * knew about THEN — `LayoutFile.knownPanelIds` (added alongside this file;
 * see types.ts). A panel present in today's registry but ABSENT from that
 * recorded baseline is newly registered and gets migrated in. A panel that
 * WAS in the baseline but is missing from the grid was deliberately closed,
 * and migration correctly leaves it closed.
 *
 * `knownPanelIds` is optional because every layout saved before this field
 * existed doesn't have it — including the real orphaned `chat-dock-v2` key
 * this bug report is about. For those, there is no recorded baseline to
 * consult, so the fallback is "treat every panel id currently absent from
 * the loaded grid as newly registered." That's the correct call for the
 * real case (nothing in `chat-dock-v2` was ever closed on purpose; the
 * panels missing from it — `files` — are missing because the catalog didn't
 * have them yet), and it only overshoots (re-adding something the user
 * closed before this feature existed) for a layout saved in that same
 * narrow window, which self-heals the next time that workspace saves: every
 * save from here on stamps a real `knownPanelIds`, so this fallback only
 * ever fires once per pre-existing file.
 *
 * A THIRD category, distinct from both of the above (task #91): an ON-DEMAND
 * panel — registered in the catalog, but deliberately absent from
 * `buildChatDockPreset()`'s own default tree, opened only via "Add tab".
 * (The panel that motivated this fix, `third-party-source`, was later
 * deleted outright — owner ruling, 2026-08-04 — but the fix is general and
 * applies to any future on-demand panel, not specific to that one.) It is
 * ALWAYS absent from
 * `presentIds`/`baseline` on a fresh or default-shaped layout — nothing ever
 * put it there — which is not the same fact as "newly registered and needs
 * grafting in": the default preset never placed it anywhere either, so there
 * is nothing to graft, and reporting it "unplaceable" describes a decision
 * this dock never tried to make. Told apart by membership in `defaultTree
 * .panels`: only a panel the CURRENT default preset actually contains
 * qualifies for either an add or an unplaceable report; an on-demand panel
 * is silently excluded from consideration, and opening it stays entirely the
 * "Add tab" affordance's job, unrelated to migration.
 *
 * Placement only knows one shape: the CURRENT default preset's `grid.root`
 * is a flat branch of single-view leaves (true for every preset this dock
 * has ever had — see `buildChatDockPreset` in ChatDock.tsx). For a missing
 * panel, its position in THAT flat branch (first child vs. anywhere else)
 * is replicated at the corresponding edge of the LOADED tree's own root
 * branch (also wrapping a bare `leaf` root into a branch if needed, for a
 * layout collapsed down to one panel). A default tree shaped any other way
 * (nested branches, a leaf with more than one view holding the missing
 * panel) has no unambiguous "edge" to place a graft at, so it's reported as
 * unplaceable rather than guessed at — the same "show less rather than
 * guess" rule spec-files-panel.md established for FilesPanel applies here:
 * an honest "couldn't place this" notice beats a silently-wrong position.
 */
export interface MigrateLoadedLayoutInput {
  loaded: SerializedDockview;
  knownPanelIds: readonly string[] | undefined;
  panelRegistry: PanelRegistry;
  /** The current default preset tree — the single source of truth for
   * where a migrated-in panel belongs and what its `panels` entry looks
   * like, so this never reinvents placement/shape rules that could drift
   * from `buildChatDockPreset()`'s own. */
  defaultTree: SerializedDockview;
}

export interface MigrateLoadedLayoutResult {
  tree: SerializedDockview;
  /** Panel ids newly registered since save, successfully grafted in. */
  addedPanelIds: string[];
  /** Panel ids newly registered since save that COULDN'T be placed — the
   * default tree isn't shaped simply enough to know where. Empty for every
   * preset this dock has ever shipped; kept typed and returned (not
   * swallowed) so the caller can notice the user instead of silently
   * dropping them. */
  unplaceablePanelIds: string[];
}

export function migrateLoadedLayout(input: MigrateLoadedLayoutInput): MigrateLoadedLayoutResult {
  const { loaded, knownPanelIds, panelRegistry, defaultTree } = input;

  const presentIds = new Set(Object.keys(loaded.panels ?? {}));
  const baseline = new Set(knownPanelIds ?? Object.keys(loaded.panels ?? {}));
  // #91: an ON-DEMAND panel (registered in the catalog but deliberately left
  // out of `buildChatDockPreset()`, opened only via "Add tab") is absent
  // from `presentIds` AND `baseline` on
  // every fresh/default-shaped layout, which used to make it indistinguishable
  // from a genuinely newly-registered panel the migration should be grafting
  // in. It isn't one: there is nothing to graft, because the default preset
  // never placed it anywhere either. Requiring membership in `defaultTree
  // .panels` — the single source of truth for what the default preset
  // actually contains — excludes it from `newlyRegisteredIds` entirely, so no
  // placement is attempted and no "couldn't be updated to include" notice
  // fires for it. A panel the CURRENT default preset DOES contain, but that a
  // stale saved layout doesn't have and never closed on purpose, still
  // qualifies exactly as before.
  const defaultPresetIds = new Set(Object.keys(defaultTree.panels ?? {}));
  const newlyRegisteredIds = panelRegistry
    .ids()
    .filter((id) => defaultPresetIds.has(id) && !presentIds.has(id) && !baseline.has(id));

  if (newlyRegisteredIds.length === 0) {
    return { tree: loaded, addedPanelIds: [], unplaceablePanelIds: [] };
  }

  let tree = loaded;
  const addedPanelIds: string[] = [];
  const unplaceablePanelIds: string[] = [];

  for (const id of newlyRegisteredIds) {
    const placement = locatePanelInFlatBranch(defaultTree, id);
    const grafted = placement && graftLeafIntoRoot(tree, placement);
    if (grafted) {
      tree = grafted;
      addedPanelIds.push(id);
    } else {
      unplaceablePanelIds.push(id);
    }
  }

  return { tree, addedPanelIds, unplaceablePanelIds };
}

interface FlatBranchPlacement {
  panelId: string;
  groupId: string;
  size: number;
  edge: "start" | "end";
  panelState: GroupviewPanelState;
}

/** Only understands one shape: `defaultTree.grid.root` is a branch whose
 * every child is a single-view leaf (this dock's actual shape, always). Any
 * other shape returns null — reported as unplaceable by the caller, never
 * guessed at. */
function locatePanelInFlatBranch(
  defaultTree: SerializedDockview,
  panelId: string,
): FlatBranchPlacement | null {
  const root = defaultTree.grid.root;
  if (root.type !== "branch" || !Array.isArray(root.data)) return null;
  const children = root.data;
  if (!children.every((child) => child.type === "leaf")) return null;

  const index = children.findIndex((child) => {
    const data = child.data as LeafGroupData;
    return data.views.length === 1 && data.views[0] === panelId;
  });
  if (index === -1) return null;

  const leaf = children[index] as DockviewGridNode;
  const panelState = defaultTree.panels[panelId];
  if (!panelState) return null;

  return {
    panelId,
    groupId: (leaf.data as LeafGroupData).id,
    size: leaf.size ?? 320,
    // Only "first child" is distinguishable as an unambiguous edge without
    // guessing; every other index (including "last", which happens to be
    // this dock's real Files case) is treated as "end" — appending after
    // whatever's already there is always structurally safe and never
    // interleaves into the middle of the user's own arrangement.
    edge: index === 0 ? "start" : "end",
    panelState,
  };
}

function graftLeafIntoRoot(
  tree: SerializedDockview,
  placement: FlatBranchPlacement,
): SerializedDockview | null {
  const root = tree.grid.root;

  const newLeaf: DockviewGridNode = {
    type: "leaf",
    size: placement.size,
    data: { id: placement.groupId, views: [placement.panelId], activeView: placement.panelId },
  };

  let newRoot: DockviewGridNode;
  if (root.type === "branch" && Array.isArray(root.data)) {
    newRoot = {
      ...root,
      data: placement.edge === "start" ? [newLeaf, ...root.data] : [...root.data, newLeaf],
    };
  } else if (root.type === "leaf") {
    // A layout collapsed down to a single remaining panel — wrap it in a
    // fresh branch so the migrated panel has somewhere to graft onto,
    // rather than treating "root is a leaf" as unplaceable.
    newRoot = {
      type: "branch",
      size: root.size ?? tree.grid.width,
      data: placement.edge === "start" ? [newLeaf, root] : [root, newLeaf],
    };
  } else {
    return null;
  }

  return {
    ...tree,
    grid: { ...tree.grid, root: newRoot },
    panels: { ...tree.panels, [placement.panelId]: placement.panelState },
  };
}
