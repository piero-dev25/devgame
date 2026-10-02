import type { EngineType } from "@t3tools/contracts";

import { CHROME_PANEL_IDS } from "~/dockActiveSelectionStore";

import { CHAT_PANEL_ID, WORKSPACE_PANEL_ID } from "../chatDockHandle";

/**
 * Which panel a thread lands on when it has no remembered dock selection.
 * Game projects (a detected engine) land on Workspace; everything else, and
 * a project whose engine is not known yet, lands on Chat. Chat stays open
 * either way: this only picks which tab comes forward.
 *
 * The engine state is `resolveEngineChipState`'s three-state answer
 * (`components/ChatView.logic.ts`), never a collapsed `engineType ?? null`.
 */
export function resolveDockLandingPanelId(engineState: "unknown" | "none" | EngineType): string {
  return engineState === "unknown" || engineState === "none" ? CHAT_PANEL_ID : WORKSPACE_PANEL_ID;
}

/**
 * Whether to bring the landing panel forward after the thread was already
 * shown. `DockviewLayout` applies `activateOnChangeId` only when the
 * activation key changes, and a game project's engine is usually still
 * "unknown" at that moment, so the first open lands on Chat. This decides
 * whether to correct that once the engine resolves.
 *
 * Only when all hold:
 * - the landing panel is not Chat and is open (a closed Workspace stays
 *   closed; landing never re-adds it),
 * - the thread has no remembered selection that is still open (the same
 *   precedence `restoreActivePanelForKey` gives; chrome panels never count),
 * - Chat is still the active panel (the user has not moved on).
 */
export function shouldApplyLateLanding(input: {
  readonly landingPanelId: string;
  readonly rememberedPanelId: string | null;
  readonly activePanelId: string | null;
  readonly isPanelOpen: (id: string) => boolean;
}): boolean {
  if (input.landingPanelId === CHAT_PANEL_ID) return false;
  if (!input.isPanelOpen(input.landingPanelId)) return false;
  const remembered = input.rememberedPanelId;
  if (remembered !== null && !CHROME_PANEL_IDS.has(remembered) && input.isPanelOpen(remembered)) {
    return false;
  }
  return input.activePanelId === CHAT_PANEL_ID;
}
