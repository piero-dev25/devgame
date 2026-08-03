// Ported verbatim from gamedev-workbench's
// app/web/src/lib/layout/tabComponents.ts.
/**
 * The two tab-renderer ids `DockviewLayout` registers (see its
 * `createTabComponent`/`defaultTabComponent` wiring). Shared here so a
 * preset can tag its own panels `NO_CLOSE` without duplicating the string
 * literal and risking drift from what `DockviewLayout` actually checks for.
 */
export const TAB_COMPONENT_WITH_CLOSE = "wb-tab-with-close";
export const TAB_COMPONENT_NO_CLOSE = "wb-tab-no-close";
