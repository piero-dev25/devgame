import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  handleSessionUpdate,
  type AcpAssistantSegmentState,
  type AcpSessionRuntimeEvent,
} from "./AcpSessionRuntime.ts";
import type { AcpSessionModeState, AcpToolCallState } from "./AcpRuntimeModel.ts";

// Task #67 tool_call_update path: `extractToolCallImageDeltas` (unit-tested
// and mutation-proven in AcpRuntimeModel.test.ts) is the decision logic;
// this proves the WIRING around it — that handleSessionUpdate actually
// threads `emittedToolCallImageIdsRef` through real session-update calls,
// not just that the pure function is correct in isolation.
function makeHarness() {
  const queue = Effect.runSync(Queue.unbounded<AcpSessionRuntimeEvent>());
  const modeStateRef = Effect.runSync(Ref.make<AcpSessionModeState | undefined>(undefined));
  const toolCallsRef = Effect.runSync(Ref.make(new Map<string, AcpToolCallState>()));
  const emittedToolCallImageIdsRef = Effect.runSync(Ref.make(new Set<string>()));
  const assistantSegmentRef = Effect.runSync(
    Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 }),
  );

  const send = (update: EffectAcpSchema.SessionNotification["update"]) =>
    Effect.runPromise(
      handleSessionUpdate({
        queue,
        modeStateRef,
        toolCallsRef,
        emittedToolCallImageIdsRef,
        assistantSegmentRef,
        assistantItemRuntimeId: "runtime-1",
        params: { sessionId: "session-1", update } satisfies EffectAcpSchema.SessionNotification,
      }),
    );

  const drain = async (): Promise<ReadonlyArray<AcpSessionRuntimeEvent>> => {
    const events: Array<AcpSessionRuntimeEvent> = [];
    while (true) {
      const next = await Effect.runPromise(Queue.poll(queue));
      if (next._tag === "None") break;
      events.push(next.value);
    }
    return events;
  };

  return { send, drain };
}

describe("AcpSessionRuntime handleSessionUpdate — tool_call_update images", () => {
  it("emits exactly one ImageDelta for a tool call that completes once", async () => {
    const harness = makeHarness();

    await harness.send({
      sessionUpdate: "tool_call",
      toolCallId: "tool-screenshot-1",
      title: "Capture",
      kind: "fetch",
      status: "pending",
    });
    await harness.send({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-screenshot-1",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        },
      ],
    });

    const events = await harness.drain();
    const imageDeltas = events.filter((event) => event._tag === "ImageDelta");
    expect(imageDeltas).toHaveLength(1);
    expect(imageDeltas[0]).toMatchObject({ data: "iVBORw0KGgo=", mimeType: "image/png" });
  });

  // The hazard team-lead flagged: a provider that (incorrectly) sends a
  // second terminal notification for the same toolCallId must not double
  // the attachment. toolCallsRef alone doesn't prevent this — completion
  // deletes the entry, so the second "completed" update merges against no
  // `previous` and would look like a fresh, legitimate completion without
  // emittedToolCallImageIdsRef.
  it("does not emit a second ImageDelta when the same tool call completes twice", async () => {
    const harness = makeHarness();
    const completedUpdate = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "tool-screenshot-1",
      status: "completed" as const,
      content: [
        {
          type: "content" as const,
          content: { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" },
        },
      ],
    };

    await harness.send({
      sessionUpdate: "tool_call",
      toolCallId: "tool-screenshot-1",
      title: "Capture",
      kind: "fetch",
      status: "pending",
    });
    await harness.send(completedUpdate);
    await harness.send(completedUpdate);

    const events = await harness.drain();
    const imageDeltas = events.filter((event) => event._tag === "ImageDelta");
    expect(imageDeltas).toHaveLength(1);
  });

  it("emits no ImageDelta while the tool call is still in progress", async () => {
    const harness = makeHarness();

    await harness.send({
      sessionUpdate: "tool_call",
      toolCallId: "tool-screenshot-1",
      title: "Capture",
      kind: "fetch",
      status: "pending",
      content: [
        {
          type: "content",
          content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        },
      ],
    });
    await harness.send({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-screenshot-1",
      status: "in_progress",
    });

    const events = await harness.drain();
    expect(events.filter((event) => event._tag === "ImageDelta")).toHaveLength(0);
  });
});
