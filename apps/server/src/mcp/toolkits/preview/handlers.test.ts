import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationUnavailableError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { invoke, normalizePreviewOpenInput } from "./handlers.ts";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};

// Minimal test double for the broker service. `respond`/`connect`/`focusHost`
// are unused by `invoke` and are asserted unreachable via `Effect.die`.
const unreachable = (label: string) => () => Effect.die(`${label} should not be called`);

// task #116 — the two behaviors that prove `invoke`'s McpCapabilityUnavailableError
// → PreviewAutomationUnavailableError translation is correct and total for the
// preview call site: (a) a denied capability still surfaces the ORIGINAL vendor
// error every preview tool's `failure: PreviewAutomationError` declares, and
// (b) the granted-case behavior — scope reaches the broker unchanged — is pinned.
describe("PreviewToolkit.invoke", () => {
  it.effect(
    "translates a denied preview capability into the vendor PreviewAutomationUnavailableError",
    () => {
      const deniedScope: McpInvocationContext.McpInvocationScope = {
        ...scope,
        capabilities: new Set(),
      };
      const fakeBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"] = {
        connect: unreachable("connect"),
        focusHost: unreachable("focusHost"),
        respond: unreachable("respond"),
        invoke: unreachable("invoke"),
      };

      return Effect.gen(function* () {
        const error = yield* invoke<PreviewAutomationStatus>("status", {}).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, deniedScope),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, fakeBroker),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
        expect(error).toMatchObject({
          capability: "preview",
          environmentId: deniedScope.environmentId,
          threadId: deniedScope.threadId,
          providerSessionId: deniedScope.providerSessionId,
          providerInstanceId: deniedScope.providerInstanceId,
        });
        expect(error.message).toBe("MCP credential does not grant the preview capability.");
      });
    },
  );

  it.effect(
    "passes the scope through to the broker and returns its result unchanged when preview is granted",
    () => {
      let capturedRequest: PreviewAutomationBroker.PreviewAutomationInvokeInput | undefined;
      const fakeBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"] = {
        connect: unreachable("connect"),
        focusHost: unreachable("focusHost"),
        respond: unreachable("respond"),
        invoke: <A>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) => {
          capturedRequest = request;
          return Effect.succeed({ ok: true } as A);
        },
      };
      const tabId = PreviewTabId.make("tab-1");

      return Effect.gen(function* () {
        const result = yield* invoke<{ ok: true }>("status", { some: "input" }, 5000, tabId).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, fakeBroker),
        );

        expect(result).toEqual({ ok: true });
        expect(capturedRequest?.scope).toBe(scope);
        expect(capturedRequest?.operation).toBe("status");
        expect(capturedRequest?.input).toEqual({ some: "input" });
        expect(capturedRequest?.timeoutMs).toBe(5000);
        expect(capturedRequest?.tabId).toBe(tabId);
      });
    },
  );
});

describe("normalizePreviewOpenInput", () => {
  it("opens the inline preview and reuses the current tab by default", () => {
    expect(normalizePreviewOpenInput({})).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});
