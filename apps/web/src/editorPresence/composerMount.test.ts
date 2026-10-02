import { describe, expect, it } from "vite-plus/test";

import { shouldMountEditorPresenceChips } from "./composerMount";

const idle = {
  composerCollapsedMobile: false,
  approvalPending: false,
  pendingUserInputCount: 0,
};

describe("shouldMountEditorPresenceChips", () => {
  it("unmounts the row once detection settles the project as not a game", () => {
    expect(shouldMountEditorPresenceChips({ ...idle, engineChipState: "none" })).toBe(false);
  });

  it("keeps the row mounted while the engine is still unknown, so the socket never churns", () => {
    expect(shouldMountEditorPresenceChips({ ...idle, engineChipState: "unknown" })).toBe(true);
  });

  it("mounts the row for a detected engine", () => {
    expect(shouldMountEditorPresenceChips({ ...idle, engineChipState: "unity" })).toBe(true);
  });

  it("hides the row in the composer states that hide every pre-input row", () => {
    expect(
      shouldMountEditorPresenceChips({
        ...idle,
        composerCollapsedMobile: true,
        engineChipState: "unity",
      }),
    ).toBe(false);
    expect(
      shouldMountEditorPresenceChips({ ...idle, approvalPending: true, engineChipState: "unity" }),
    ).toBe(false);
    expect(
      shouldMountEditorPresenceChips({
        ...idle,
        pendingUserInputCount: 1,
        engineChipState: "unity",
      }),
    ).toBe(false);
  });
});
