import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toContain("MCP credential does not grant the preview capability");
    expect(error.message).toContain("use a headless browser from the shell");
  });
});

it.effect("reports other missing capabilities with the neutral error", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("pull-requests").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({ capability: "pull-requests", threadId: invocation.threadId });

    const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    expect(scope).toBe(invocation);
  });
});

// DevGame "generation" capability (task #116, mapped onto upstream's neutral
// error): denied yields the contracts McpCapabilityUnavailableError that the
// generation toolkit translates; granted passes the scope through.
it.effect("gates the DevGame 'generation' capability with the neutral error", () => {
  const denied: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["preview", "pull-requests"]),
    issuedAt: 1,
  };
  const granted: McpInvocationContext.McpInvocationScope = {
    ...denied,
    capabilities: new Set(["generation"]),
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("generation").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, denied),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({
      capability: "generation",
      environmentId: denied.environmentId,
      threadId: denied.threadId,
      providerSessionId: denied.providerSessionId,
      providerInstanceId: denied.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the generation capability.");

    const scope = yield* McpInvocationContext.requireMcpCapability("generation").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, granted),
    );
    expect(scope).toBe(granted);
  });
});
