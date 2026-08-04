// Mirrors previewWebviewConfigState.ts's shape exactly, for the one
// difference that matters: there is no `EnvironmentId` to key this by.
// `getThirdPartyBrowserConfig` (packages/contracts/src/ipc.ts) is a single,
// app-wide config — see thirdPartySourceBrowserStore.ts's own doc comment
// for why the whole third-party browser surface is global, not per-thread
// or per-environment.
import { useAtomValue } from "@effect/atom-react";
import type { DesktopPreviewBridge, DesktopPreviewWebviewConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";

const THIRD_PARTY_BROWSER_CONFIG_STALE_TIME_MS = 5 * 60_000;
const THIRD_PARTY_BROWSER_CONFIG_IDLE_TTL_MS = 10 * 60_000;

export class ThirdPartyBrowserWebviewBridgeUnavailableError extends Schema.TaggedErrorClass<ThirdPartyBrowserWebviewBridgeUnavailableError>()(
  "ThirdPartyBrowserWebviewBridgeUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop third-party browser webview configuration is unavailable.";
  }
}

export class ThirdPartyBrowserWebviewConfigLoadError extends Schema.TaggedErrorClass<ThirdPartyBrowserWebviewConfigLoadError>()(
  "ThirdPartyBrowserWebviewConfigLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load desktop third-party browser webview configuration.";
  }
}

export const ThirdPartyBrowserWebviewConfigError = Schema.Union([
  ThirdPartyBrowserWebviewBridgeUnavailableError,
  ThirdPartyBrowserWebviewConfigLoadError,
]);
export type ThirdPartyBrowserWebviewConfigError = typeof ThirdPartyBrowserWebviewConfigError.Type;

type ThirdPartyBrowserConfigBridge = Pick<DesktopPreviewBridge, "getThirdPartyBrowserConfig">;

export const loadThirdPartyBrowserWebviewConfig = (
  bridge: ThirdPartyBrowserConfigBridge | null = previewBridge,
): Effect.Effect<DesktopPreviewWebviewConfig, ThirdPartyBrowserWebviewConfigError> => {
  if (bridge === null) {
    return Effect.fail(new ThirdPartyBrowserWebviewBridgeUnavailableError({}));
  }

  return Effect.tryPromise({
    try: () => bridge.getThirdPartyBrowserConfig(),
    catch: (cause) => new ThirdPartyBrowserWebviewConfigLoadError({ cause }),
  });
};

const thirdPartyBrowserWebviewConfigAtom = Atom.make(loadThirdPartyBrowserWebviewConfig()).pipe(
  Atom.swr({
    staleTime: THIRD_PARTY_BROWSER_CONFIG_STALE_TIME_MS,
    revalidateOnMount: true,
  }),
  Atom.setIdleTTL(THIRD_PARTY_BROWSER_CONFIG_IDLE_TTL_MS),
  Atom.withLabel("thirdPartyBrowser:webview-config"),
);

export function useThirdPartyBrowserWebviewConfig(): DesktopPreviewWebviewConfig | null {
  const result = useAtomValue(thirdPartyBrowserWebviewConfigAtom);
  return Option.getOrNull(AsyncResult.value(result));
}
