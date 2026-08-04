import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import {
  type AcpToolCallState,
  extractModelConfigId,
  extractToolCallImageDeltas,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateIsReplay,
  syntheticLoadSessionResponseFromInitialize,
} from "./AcpRuntimeModel.ts";

describe("AcpRuntimeModel", () => {
  it("parses session mode state from typed ACP session setup responses", () => {
    const modeState = parseSessionModeState({
      sessionId: "session-1",
      modes: {
        currentModeId: " code ",
        availableModes: [
          { id: " ask ", name: " Ask ", description: " Request approval " },
          { id: " code ", name: " Code " },
        ],
      },
      configOptions: [],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modeState).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask", description: "Request approval" },
        { id: "code", name: "Code" },
      ],
    });
  });

  it("extracts the model config id from typed ACP config options", () => {
    const modelConfigId = extractModelConfigId({
      sessionId: "session-1",
      configOptions: [
        {
          id: "approval",
          name: "Approval Mode",
          category: "permission",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Auto" }],
        },
      ],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modelConfigId).toBe("model");
  });

  it("detects Grok session replay updates from _meta.isReplay", () => {
    expect(
      sessionUpdateIsReplay({
        _meta: { isReplay: true },
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
    expect(
      sessionUpdateIsReplay({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(false);
  });

  it("builds a synthetic load response from initialize model state", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.models?.currentModelId).toBe("grok-build");
    expect(response._meta).toMatchObject({ t3SessionLoadReady: "replay_idle" });
  });

  it("accepts initialize model descriptions with null", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [{ modelId: "grok-build", name: "Grok Build", description: null }],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.models?.availableModels[0]?.description).toBeNull();
  });

  it("ignores malformed initialize model state in synthetic load responses", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [null],
        },
        modeState: {
          currentModeId: "code",
          availableModes: [{ id: "code", name: 12 }],
        },
      },
    } as EffectAcpSchema.InitializeResponse);

    expect(response.models).toBeUndefined();
    expect(response.modes).toBeUndefined();
    expect(response._meta).toMatchObject({ t3SessionLoadReady: "replay_idle" });
  });

  it("builds a synthetic load response with initialize mode state", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: "code",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "code", name: "Code" },
          ],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.modes?.currentModeId).toBe("code");
    expect(response.modes?.availableModes).toHaveLength(2);
  });

  it("projects typed ACP tool call updates into runtime events", () => {
    const created = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {
          executable: "bun",
          args: ["run", "typecheck"],
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Running checks",
            },
          },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(created.events).toEqual([
      {
        _tag: "ToolCallUpdated",
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          title: "Ran command",
          status: "pending",
          command: "bun run typecheck",
          detail: "bun run typecheck",
          // Task #67 tool_call_update path: the typed sibling of
          // `data.content` below — same input, but preserved as
          // `ToolCallContent[]` rather than an untyped diagnostic blob, so
          // extractToolCallImageDeltas can read it without re-validating
          // unknown data.
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Running checks",
              },
            },
          ],
          data: {
            toolCallId: "tool-1",
            kind: "execute",
            command: "bun run typecheck",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
      },
    ]);

    const updated = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0]?._tag).toBe("ToolCallUpdated");
    const createdEvent = created.events[0];
    const updatedEvent = updated.events[0];
    if (createdEvent?._tag === "ToolCallUpdated" && updatedEvent?._tag === "ToolCallUpdated") {
      expect(mergeToolCallState(createdEvent.toolCall, updatedEvent.toolCall)).toMatchObject({
        toolCallId: "tool-1",
        status: "completed",
        title: "Ran command",
        detail: "bun run typecheck",
        command: "bun run typecheck",
        // The completing update carries no `content` of its own — proves
        // content survives the merge from the earlier "tool_call" event
        // rather than being dropped once the tool call finishes.
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Running checks",
            },
          },
        ],
      });
    }
  });

  // Task #67 tool_call_update path: a tool call result (e.g. the devgame
  // MCP server's `preview_snapshot` screenshot tool, apps/server/src/mcp/
  // McpHttpServer.ts) can carry an image the same way an assistant's own
  // inline content can — ACP's ToolCallContent has an image variant nested
  // under type "content", structurally identical to ContentBlock's. This is
  // the pure decision function AcpSessionRuntime.ts calls: which images (if
  // any) a merged tool-call state transition should emit, gated to the
  // terminal "completed" status and guarded against a repeat for the same
  // toolCallId.
  describe("extractToolCallImageDeltas", () => {
    const imageToolCall = (overrides: Partial<AcpToolCallState> = {}): AcpToolCallState => ({
      toolCallId: "tool-screenshot-1",
      status: "completed",
      data: {},
      content: [
        {
          type: "content",
          content: {
            type: "image",
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
          },
        },
      ],
      ...overrides,
    });

    it("extracts an image from a completed tool call's content", () => {
      const images = extractToolCallImageDeltas({
        merged: imageToolCall(),
        alreadyEmittedToolCallIds: new Set(),
      });

      expect(images).toEqual([{ data: "iVBORw0KGgo=", mimeType: "image/png" }]);
    });

    it("emits nothing for a tool call that has not reached a terminal status", () => {
      const images = extractToolCallImageDeltas({
        merged: imageToolCall({ status: "inProgress" }),
        alreadyEmittedToolCallIds: new Set(),
      });

      expect(images).toEqual([]);
    });

    it("emits nothing for a tool call with no image content", () => {
      const images = extractToolCallImageDeltas({
        merged: imageToolCall({
          content: [{ type: "content", content: { type: "text", text: "exit code 0" } }],
        }),
        alreadyEmittedToolCallIds: new Set(),
      });

      expect(images).toEqual([]);
    });

    it("drops an image entry with empty data", () => {
      const images = extractToolCallImageDeltas({
        merged: imageToolCall({
          content: [
            { type: "content", content: { type: "image", data: "", mimeType: "image/png" } },
          ],
        }),
        alreadyEmittedToolCallIds: new Set(),
      });

      expect(images).toEqual([]);
    });

    // This is the dedup guard team-lead asked to be mutation-proven: the
    // same tool call reaching "completed" a second time (a provider sending
    // a duplicate terminal notification) must not re-emit — otherwise the
    // same screenshot would be persisted and attached twice. Assert the
    // count, not just presence, per the same lesson task #74 already
    // established: a weaker assertion here would pass even with the guard
    // deleted.
    it("does not re-emit for a toolCallId already recorded as emitted", () => {
      const images = extractToolCallImageDeltas({
        merged: imageToolCall(),
        alreadyEmittedToolCallIds: new Set(["tool-screenshot-1"]),
      });

      expect(images).toHaveLength(0);
    });
  });

  it("trims padded current mode updates before emitting a mode change", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: " code ",
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(result.modeId).toBe("code");
    expect(result.events).toEqual([
      {
        _tag: "ModeChanged",
        modeId: "code",
      },
    ]);
  });

  it("projects typed ACP plan and content updates", () => {
    const planResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: " Inspect state ", priority: "high", status: "completed" },
          { content: "", priority: "medium", status: "in_progress" },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(planResult.events).toEqual([
      {
        _tag: "PlanUpdated",
        payload: {
          plan: [
            { step: "Inspect state", status: "completed" },
            { step: "Step 2", status: "inProgress" },
          ],
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: " Inspect state ", priority: "high", status: "completed" },
              { content: "", priority: "medium", status: "in_progress" },
            ],
          },
        },
      },
    ]);

    const contentResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "hello from acp",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(contentResult.events).toEqual([
      {
        _tag: "ContentDelta",
        text: "hello from acp",
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "hello from acp",
            },
          },
        },
      },
    ]);
  });

  // Task #67: the producer half of "agents cannot put an image in a
  // thread" — ACP's `ContentBlock` union has an "image" variant
  // (`{type:"image", data, mimeType}`), and this parser was the exact
  // place nobody read it: the "agent_message_chunk" case only ever
  // checked `content.type === "text"`, silently dropping anything else.
  it("parses an image content block from agent_message_chunk into an ImageDelta event", () => {
    const rawPayload = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification;

    const imageResult = parseSessionUpdateEvent(rawPayload);

    expect(imageResult.events).toEqual([
      {
        _tag: "ImageDelta",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
        rawPayload,
      },
    ]);
  });

  it("drops an image content block with empty data rather than emitting a useless attachment", () => {
    const imageResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "image",
          data: "",
          mimeType: "image/png",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(imageResult.events).toEqual([]);
  });

  it("keeps permission request parsing compatible with loose extension payloads", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
      ],
      toolCall: {
        toolCallId: "tool-1",
        title: "`cat package.json`",
        kind: "execute",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Not in allowlist",
            },
          },
        ],
      },
    });

    expect(request).toMatchObject({
      kind: "execute",
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending",
        command: "cat package.json",
      },
    });
  });
});
