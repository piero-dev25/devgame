/**
 * Which third-party browser-panel destination (Figma, Notion) is active,
 * and each one's own navigation state — see
 * docs/workbench/three-feature-decisions.md #4, and
 * `apps/web/src/dock/` for how this store's siblings (`fileExplorerStore.ts`,
 * `diffPanelStore.ts`) split "the dock owns visibility, the store owns
 * content" for their own panels.
 *
 * DELIBERATELY GLOBAL, NOT `byThreadKey` (owner ruling, relayed 2026-08-04)
 * — this is the one place this store's shape genuinely differs from its
 * dock-panel siblings, and it's worth stating why rather than leaving the
 * next reader to "fix" it into a thread-keyed map to match them. Diff,
 * Files and Terminal are per-thread because they're ABOUT the thread — this
 * conversation's diff, this conversation's open files. A Figma design file
 * or Notion page is not about any one conversation; a user keeps it open
 * WHILE working across several threads, the same way a browser tab stays
 * open across tab switches elsewhere in the app. Per-thread would mean
 * re-navigating the design file every time the user switches chats — a
 * worse version of the environment-scoped-login problem already caught in
 * `BrowserSession.ts`. So there is exactly one Figma tab and one Notion tab
 * in the whole app, not one per thread.
 *
 * NOT PERSISTED ACROSS RESTARTS (deliberate v1 scope, not an oversight):
 * `BrowserSession.ts`'s partition already persists the thing that actually
 * matters — the user's login — independent of this store. Losing "which
 * page you were on" on restart is a normal, expected browser-tab behaviour
 * (a fresh tab, not a fresh login); this store can grow persistence later
 * without changing its shape.
 */
import { create } from "zustand";

export type ThirdPartySourceKind = "figma" | "notion";

export interface ThirdPartySourceTabState {
  readonly url: string;
  readonly title: string | null;
}

const DEFAULT_TAB_URL: Readonly<Record<ThirdPartySourceKind, string>> = {
  figma: "https://www.figma.com/files",
  notion: "https://www.notion.so/",
};

interface ThirdPartySourceBrowserStoreState {
  readonly activeSource: ThirdPartySourceKind | null;
  readonly tabs: Readonly<Record<ThirdPartySourceKind, ThirdPartySourceTabState | null>>;
  /** Activates `source`, seeding its tab at that product's default URL the
   * FIRST time it's opened. Re-opening an already-seeded source leaves its
   * tab state untouched — this is "switch to that tab," not "reset it." */
  readonly open: (source: ThirdPartySourceKind) => void;
  /** Deactivates whichever source is active. Both tabs' state survives —
   * closing the panel is not the same as closing a tab. */
  readonly close: () => void;
  readonly setTabState: (source: ThirdPartySourceKind, state: ThirdPartySourceTabState) => void;
}

export const useThirdPartySourceBrowserStore = create<ThirdPartySourceBrowserStoreState>()(
  (set) => ({
    activeSource: null,
    tabs: { figma: null, notion: null },
    open: (source) =>
      set((state) => ({
        activeSource: source,
        tabs:
          state.tabs[source] === null
            ? { ...state.tabs, [source]: { url: DEFAULT_TAB_URL[source], title: null } }
            : state.tabs,
      })),
    close: () => set({ activeSource: null }),
    setTabState: (source, tabState) =>
      set((state) => ({ tabs: { ...state.tabs, [source]: tabState } })),
  }),
);
