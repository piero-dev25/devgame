import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Task #116 (the V2 program's ratified prerequisite — see
 * docs/v2/notes/t3-architecture-seams.md §6.3 and
 * docs/v2/GENERATION_ARCHITECTURE.md's "McpCapability trap"). Widened from
 * the single `"preview"` member this type shipped with. `"generation"` is
 * not granted to anything yet — see `McpSessionRegistry.ts:issue`'s own
 * comment on `capabilities: new Set(["preview"])`, which stays
 * preview-only pending an explicit owner ruling.
 */
export type McpCapability = "preview" | "generation";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/**
 * Fork-owned (task #116) — deliberately NOT in `packages/contracts`.
 * `PreviewAutomationUnavailableError` (vendor,
 * `packages/contracts/src/previewAutomation.ts`) hardcodes
 * `capability: Schema.Literal("preview")` because it predates any second
 * `McpCapability`, and it is a member of `PreviewAutomationError` — the
 * declared `failure` of every preview MCP tool
 * (`toolkits/preview/tools.ts`). Widening THAT literal would edit a vendor
 * contract in the blast radius of the entire preview toolkit for a concern
 * (capability gating) that has nothing to do with preview automation
 * specifically.
 *
 * `requireMcpCapability` now throws THIS error for every capability,
 * "preview" included. The one existing call site
 * (`toolkits/preview/handlers.ts`'s `invoke`) translates it back into the
 * original `PreviewAutomationUnavailableError` shape before it can reach a
 * preview tool's own declared failure channel — see that file's own
 * comment for why that translation is total (not partial) for the
 * "preview" case. A future generation toolkit is expected to do the
 * equivalent translation into its own vendor-facing error type, never to
 * widen this error's own shape to fit a second consumer.
 */
export class McpCapabilityUnavailableError extends Schema.TaggedErrorClass<McpCapabilityUnavailableError>()(
  "McpCapabilityUnavailableError",
  {
    capability: Schema.Literals(["preview", "generation"]),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    providerSessionId: TrimmedNonEmptyString,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new McpCapabilityUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
