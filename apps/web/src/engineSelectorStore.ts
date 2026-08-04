import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EngineType, ScopedProjectRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * The Play/Stop toolbar's engine override, scoped PER PROJECT — deliberately
 * not per chat tab. A project has one engine; every thread against it should
 * see the same selector state, the same way every thread against it shares
 * one workspace root. (Compare `ProviderModelPicker.tsx`'s model selection,
 * which genuinely IS per composer/per-tab — that state model does not apply
 * here, only its trigger-button appearance was worth copying.)
 *
 * Absent from `overrideByProjectKey` means "no override" — the toolbar falls
 * back to the project's server-detected `engineType` (see
 * `selectProjectEngineType` below), never to a guessed engine. A project
 * with no detected engine and no override shows no toolbar at all; that is
 * a correct empty state, not a bug to paper over with a default.
 */
interface EngineSelectorStoreState {
  overrideByProjectKey: Record<string, EngineType>;
  selectEngine: (ref: ScopedProjectRef, engine: EngineType) => void;
  /**
   * Drops the override, returning to the detected default. Also the right
   * call when a project is removed from the workspace — an override for a
   * project that no longer exists is dead weight, not a state worth
   * preserving, so there is deliberately no separate `removeProject`
   * mirroring `diffPanelStore.ts`'s `removeThread`: unlike a thread's diff
   * selection (meaningfully different data), "no override" and "project
   * gone" are the exact same transition here.
   */
  clearOverride: (ref: ScopedProjectRef) => void;
}

export const useEngineSelectorStore = create<EngineSelectorStoreState>()(
  persist(
    (set) => ({
      overrideByProjectKey: {},
      selectEngine: (ref, engine) =>
        set((state) => ({
          overrideByProjectKey: {
            ...state.overrideByProjectKey,
            [scopedProjectKey(ref)]: engine,
          },
        })),
      clearOverride: (ref) =>
        set((state) => {
          const key = scopedProjectKey(ref);
          if (!(key in state.overrideByProjectKey)) return state;
          const { [key]: _removed, ...overrideByProjectKey } = state.overrideByProjectKey;
          return { overrideByProjectKey };
        }),
    }),
    {
      name: "t3code:engine-selector-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ overrideByProjectKey: state.overrideByProjectKey }),
    },
  ),
);

/**
 * Resolves the engine a project's toolbar should target: the user's
 * explicit override when one exists, otherwise the project's own
 * server-detected `engineType`, otherwise `null` (no engine known — the
 * toolbar's correct response is to render nothing, not to guess).
 */
export function selectProjectEngineType(
  overrideByProjectKey: Record<string, EngineType>,
  ref: ScopedProjectRef | null | undefined,
  detectedEngineType: EngineType | null,
): EngineType | null {
  if (!ref) return detectedEngineType;
  return overrideByProjectKey[scopedProjectKey(ref)] ?? detectedEngineType;
}
