import type { ResolvedWorkspaceEntity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkspacePacket,
  buildWorkspacePacketRecord,
  describeWorkspacePacket,
  readWorkspacePacketRecord,
  WORKSPACE_PACKET_CONTEXT_KIND,
  WORKSPACE_PACKET_MAX_CHARS,
} from "./contextPacket";

const pitch: ResolvedWorkspaceEntity = {
  id: "pitch",
  title: "Pitch",
  folder: "pitch",
  description: "Write the one-page pitch for the boss rush mode.",
  steps: [
    { name: "Report", path: "report.md", relativePath: "workspace/pitch/report.md", exists: true },
    {
      name: "Deck",
      path: "deck.html",
      relativePath: "workspace/pitch/deck.html",
      exists: false,
      issue: "missing",
    },
    { name: "Escape", path: "../../secret.md", relativePath: null, exists: false, issue: "escape" },
  ],
};

function manySteps(count: number, pathLength: number): ResolvedWorkspaceEntity {
  return {
    ...pitch,
    steps: Array.from({ length: count }, (_, index) => {
      const path = `${String(index).padStart(4, "0")}-${"x".repeat(pathLength)}.md`;
      return { name: `Step ${index}`, path, relativePath: `workspace/pitch/${path}`, exists: true };
    }),
  };
}

describe("buildWorkspacePacket", () => {
  it("carries the card brief and the chosen steps' paths, reporting unusable ones as missing", () => {
    const packet = buildWorkspacePacket({
      projectId: "project-a",
      entity: pitch,
      stepIndexes: [0, 1, 2],
    });

    expect(packet).toMatchObject({
      projectId: "project-a",
      entityId: "pitch",
      title: "Pitch",
      brief: "Write the one-page pitch for the boss rush mode.",
      referencePaths: ["workspace/pitch/report.md"],
      missingRefs: [
        { step: "Deck", path: "workspace/pitch/deck.html", issue: "missing" },
        { step: "Escape", path: null, issue: "escape" },
      ],
      acceptedVersion: null,
      runSummary: null,
      truncatedCount: 0,
    });
  });

  it("includes only the steps the user chose", () => {
    const packet = buildWorkspacePacket({
      projectId: "project-a",
      entity: pitch,
      stepIndexes: [1],
    });

    expect(packet.referencePaths).toEqual([]);
    expect(packet.missingRefs).toEqual([
      { step: "Deck", path: "workspace/pitch/deck.html", issue: "missing" },
    ]);
  });

  it("never forwards the raw path of a step that leaves the workspace", () => {
    const packet = buildWorkspacePacket({
      projectId: "project-a",
      entity: pitch,
      stepIndexes: [2],
    });

    expect(packet.missingRefs).toEqual([{ step: "Escape", path: null, issue: "escape" }]);
    expect(JSON.stringify(packet)).not.toContain("secret.md");
    expect(describeWorkspacePacket(packet).details).toContain("• Escape (outside the workspace)");
  });

  it("warns the agent and the chip when the thread runs in a worktree", () => {
    const root = buildWorkspacePacket({ projectId: "project-a", entity: pitch, stepIndexes: [0] });
    const worktree = buildWorkspacePacket({
      projectId: "project-a",
      entity: pitch,
      stepIndexes: [0],
      threadInWorktree: true,
    });

    expect(root.threadInWorktree).toBe(false);
    expect(root.note).not.toMatch(/worktree/);
    expect(worktree.threadInWorktree).toBe(true);
    expect(worktree.note).toMatch(/checked at the project root/);
    expect(worktree.note).toMatch(/git worktree/);
    expect(describeWorkspacePacket(worktree).warning).toBe(
      "files checked at the project root, not the worktree",
    );
    expect(readWorkspacePacketRecord(buildWorkspacePacketRecord(worktree))).toEqual(worktree);
  });

  it("carries paths only, never file contents", () => {
    const packet = buildWorkspacePacket({
      projectId: "project-a",
      entity: pitch,
      stepIndexes: [0],
    });

    expect(Object.keys(packet).sort()).toEqual([
      "acceptedVersion",
      "brief",
      "entityId",
      "missingRefs",
      "note",
      "projectId",
      "referencePaths",
      "runSummary",
      "threadInWorktree",
      "title",
      "truncatedCount",
      "version",
    ]);
    expect(packet.note).toMatch(/File contents are not included/);
  });

  it("clamps an oversized brief with a visible marker", () => {
    const packet = buildWorkspacePacket({
      projectId: "project-a",
      entity: { ...pitch, description: "b".repeat(50_000) },
      stepIndexes: [],
    });

    expect(packet.brief!.length).toBeLessThanOrEqual(2_000);
    expect(packet.brief!.endsWith("… [truncated]")).toBe(true);
  });

  it("drops paths past the budget and counts them", () => {
    const entity = manySteps(200, 400);
    const packet = buildWorkspacePacket({
      projectId: "project-a",
      entity,
      stepIndexes: entity.steps.map((_, index) => index),
    });

    expect(JSON.stringify(packet).length).toBeLessThanOrEqual(WORKSPACE_PACKET_MAX_CHARS);
    expect(packet.referencePaths.length).toBeGreaterThan(0);
    expect(packet.truncatedCount).toBe(200 - packet.referencePaths.length);
    expect(packet.referencePaths[0]).toBe(entity.steps[0]!.relativePath);
  });

  it("keeps missing references ahead of existing ones when trimming", () => {
    const entity = manySteps(80, 10);
    const missing = { ...entity.steps[79]!, exists: false, issue: "missing" as const };
    const packet = buildWorkspacePacket({
      projectId: "project-a",
      entity: { ...entity, steps: [...entity.steps.slice(0, 79), missing] },
      stepIndexes: Array.from({ length: 80 }, (_, index) => index),
    });

    expect(packet.missingRefs).toEqual([
      { step: missing.name, path: missing.relativePath, issue: "missing" },
    ]);
    expect(packet.referencePaths).toHaveLength(63);
    expect(packet.truncatedCount).toBe(16);
  });

  it("carries the accepted version and run summary when there are any", () => {
    const packet = buildWorkspacePacket({
      projectId: "project-a",
      entity: pitch,
      stepIndexes: [0],
      acceptedVersion: "v3",
      runSummary: { runId: "run-1", profileId: "capture", state: "exited", exitCode: 0 },
    });

    expect(packet.acceptedVersion).toBe("v3");
    expect(packet.runSummary).toEqual({
      runId: "run-1",
      profileId: "capture",
      state: "exited",
      exitCode: 0,
    });
  });
});

describe("workspace packet record", () => {
  const packet = buildWorkspacePacket({
    projectId: "project-a",
    entity: pitch,
    stepIndexes: [0, 1],
  });

  it("is a fork-kind record that reads back to the same packet", () => {
    const record = buildWorkspacePacketRecord(packet);

    expect(record.kind).toBe(WORKSPACE_PACKET_CONTEXT_KIND);
    expect(record.label).toBe("Workspace: Pitch");
    expect(readWorkspacePacketRecord(record)).toEqual(packet);
  });

  it("ignores other kinds and payloads it does not recognize", () => {
    const record = buildWorkspacePacketRecord(packet);

    expect(readWorkspacePacketRecord({ ...record, kind: "editor-selection" })).toBeNull();
    expect(
      readWorkspacePacketRecord({ ...record, payload: { ...packet, referencePaths: "x" } }),
    ).toBeNull();
    expect(readWorkspacePacketRecord({ ...record, payload: null })).toBeNull();
    expect(
      readWorkspacePacketRecord({
        ...record,
        payload: { ...packet, missingRefs: ["../../secret.md"] },
      }),
    ).toBeNull();
    expect(
      readWorkspacePacketRecord({
        ...record,
        payload: { ...packet, missingRefs: [{ step: "Deck", path: null, issue: "gone" }] },
      }),
    ).toBeNull();
  });
});

describe("describeWorkspacePacket", () => {
  it("warns about missing and dropped references", () => {
    const packet = {
      ...buildWorkspacePacket({ projectId: "project-a", entity: pitch, stepIndexes: [0, 1] }),
      truncatedCount: 3,
    };

    const view = describeWorkspacePacket(packet);

    expect(view.warning).toBe("1 missing reference, 3 more not included");
    expect(view.details).toContain("• workspace/pitch/report.md");
    expect(view.details).toContain("• workspace/pitch/deck.html (missing)");
  });

  it("has no warning for a complete packet", () => {
    const packet = buildWorkspacePacket({
      projectId: "project-a",
      entity: pitch,
      stepIndexes: [0],
    });

    expect(describeWorkspacePacket(packet).warning).toBeNull();
  });
});
