import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

// CHANGED (task #116, the V2 program's ratified prerequisite —
// docs/v2/notes/t3-architecture-seams.md §6.3): this used to assert
// `PreviewAutomationUnavailableError` (the vendor error, packages/contracts)
// directly. That was the trap — `McpCapability` widening past its original
// single `"preview"` member is now real (see below), and a vendor error
// whose own field is `Schema.Literal("preview")` can no longer be
// `requireMcpCapability`'s general-purpose failure. `requireMcpCapability`
// now returns the fork-owned `McpCapabilityUnavailableError` for every
// capability, "preview" included; the ONE existing consumer that still
// needs the original vendor shape (`toolkits/preview/handlers.ts`)
// translates it back at its own call site — see that file's own test for
// the unchanged, end-to-end preview-tool behavior this rewrite protects.
it.effect(
  "reports the scoped credential context when the 'preview' capability is unavailable",
  () => {
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

      expect(error).toBeInstanceOf(McpInvocationContext.McpCapabilityUnavailableError);
      expect(error).toMatchObject({
        capability: "preview",
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      });
      expect(error.message).toBe("MCP credential does not grant the preview capability.");
    });
  },
);

// The other half of task #116's own widening: a "generation" check must
// yield the SAME error shape, with `capability: "generation"` — proving the
// new error is genuinely capability-agnostic, not a `"preview"`-only
// rename of the old one.
it.effect(
  "reports the scoped credential context when the 'generation' capability is unavailable",
  () => {
    const invocation: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
      issuedAt: 1,
    };

    return Effect.gen(function* () {
      const error = yield* McpInvocationContext.requireMcpCapability("generation").pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(McpInvocationContext.McpCapabilityUnavailableError);
      expect(error).toMatchObject({
        capability: "generation",
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      });
      expect(error.message).toBe("MCP credential does not grant the generation capability.");
    });
  },
);

// The "old-vacuous direction" guard the fix round explicitly asked for:
// widening `McpCapability`'s TYPE must not, by itself, grant anything. Uses
// the EXACT set `McpSessionRegistry.ts`'s own `issue` currently mints for
// every credential (`new Set(["preview"])`) — today's real production
// default, not a synthetic empty set — so this is the strongest available
// proof that a "generation" check against today's actual grant still fails
// closed.
it.effect(
  "a credential minted with today's real preview-only default grant still fails closed for 'generation'",
  () => {
    const invocation: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
      issuedAt: 1,
    };

    return Effect.gen(function* () {
      const error = yield* McpInvocationContext.requireMcpCapability("generation").pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(McpInvocationContext.McpCapabilityUnavailableError);
      expect(error.capability).toBe("generation");

      // And the positive control alongside it: the SAME credential still
      // grants "preview" — the widening changed nothing about the existing
      // grant, only added a new capability nobody has yet.
      const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      );
      expect(scope).toBe(invocation);
    });
  },
);
