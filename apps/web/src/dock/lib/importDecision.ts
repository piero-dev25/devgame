import type { ParseLayoutResult } from "./serialization";
import type { LayoutFile } from "./types";

/**
 * Fix-round finding #3 (step-1 review): `DockviewLayout.tsx`'s
 * `handleImportFile` captured `apiRef.current` SYNCHRONOUSLY, then used it
 * inside `file.text().then(...)` — an async continuation with no unmount
 * guard. If the component unmounted (route/workspace switch) while the file
 * read was in flight, that continuation would call `api.fromJSON(...)`
 * against a `DockviewApi` `loadInitialLayout`'s own effect had already
 * disposed. `loadInitialLayout` already threads a `cancelled` flag through
 * exactly this kind of gap; this closes the same gap for the import path.
 *
 * The "should we touch the api at all" DECISION is extracted here as a pure
 * function so the guard itself is directly testable (matching this repo's
 * own testing convention — plain objects, no DOM, no mounted DockviewApi;
 * see lib/singletonGuard.test.ts and lib/storage.test.ts for the same
 * shape). What ISN'T pure — whether dockview itself accepts the parsed
 * layout — stays an effectful try/catch in `DockviewLayout.tsx`, because
 * that's testing `DockviewApi.fromJSON`'s own behaviour, not this fork's.
 */
export type ImportedLayoutAction =
  | { action: "ignore-unmounted" }
  | { action: "invalid"; message: string }
  | { action: "apply"; file: LayoutFile };

export function decideImportedLayoutAction(input: {
  isMounted: boolean;
  parseResult: ParseLayoutResult;
}): ImportedLayoutAction {
  if (!input.isMounted) return { action: "ignore-unmounted" };
  if (!input.parseResult.ok) return { action: "invalid", message: input.parseResult.message };
  return { action: "apply", file: input.parseResult.file };
}
