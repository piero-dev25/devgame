import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectTerminalDockPanelTerminalIds,
  selectThreadTerminalDockState,
  useTerminalDockStore,
} from "./terminalDockStore";

const refA = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-A"));
const refB = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-B"));

beforeEach(() => {
  useTerminalDockStore.setState({ byThreadKey: {} });
});

describe("terminalDockStore — defaults", () => {
  it("defaults an unopened thread to no groups", () => {
    expect(
      selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA),
    ).toEqual({ groups: [], activeGroupId: null });
  });

  it("is isolated per thread", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    expect(
      selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refB),
    ).toEqual({ groups: [], activeGroupId: null });
  });
});

describe("terminalDockStore — openTerminal", () => {
  it("opens each terminal as its own separate group, most recent active", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().openTerminal(refA, "term-2");

    const state = selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA);
    expect(state.groups).toEqual([
      { id: "terminal:term-1", terminalIds: ["term-1"], activeTerminalId: "term-1" },
      { id: "terminal:term-2", terminalIds: ["term-2"], activeTerminalId: "term-2" },
    ]);
    expect(state.activeGroupId).toBe("terminal:term-2");
  });

  it("re-opening an id already claimed by a group activates that group instead of duplicating it", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().openTerminal(refA, "term-2");
    useTerminalDockStore.getState().openTerminal(refA, "term-1");

    const state = selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA);
    expect(state.groups).toHaveLength(2);
    expect(state.activeGroupId).toBe("terminal:term-1");
  });
});

describe("terminalDockStore — split", () => {
  it("splits a pane into the target group, activating the new pane and its group", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().openTerminal(refA, "term-2");
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-3");

    const state = selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA);
    expect(state.groups).toEqual([
      { id: "terminal:term-1", terminalIds: ["term-1", "term-3"], activeTerminalId: "term-3" },
      { id: "terminal:term-2", terminalIds: ["term-2"], activeTerminalId: "term-2" },
    ]);
    expect(state.activeGroupId).toBe("terminal:term-1");
  });

  it("tracks vertical split direction, and a later horizontal split clears it", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-2", "vertical");
    expect(
      selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA).groups[0],
    ).toEqual({
      id: "terminal:term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
      splitDirection: "vertical",
    });

    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-3");
    expect(
      selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA).groups[0],
    ).toEqual({
      id: "terminal:term-1",
      terminalIds: ["term-1", "term-2", "term-3"],
      activeTerminalId: "term-3",
    });
  });

  it("refuses to split past MAX_TERMINALS_PER_GROUP (4)", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-3");
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-4");
    // MUTATION-PROOF: temporarily removing the length guard in
    // terminalDockStore.ts's splitTerminal would let this 5th split
    // through — proven red against the reintroduced bug during
    // development; restored here as the green assertion.
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-5");

    const group = selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA)
      .groups[0];
    expect(group?.terminalIds).toEqual(["term-1", "term-2", "term-3", "term-4"]);
  });
});

describe("terminalDockStore — activate", () => {
  it("activateTerminal sets the active pane AND makes its group active", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");
    useTerminalDockStore.getState().openTerminal(refA, "term-3");

    useTerminalDockStore.getState().activateTerminal(refA, "terminal:term-1", "term-1");

    const state = selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA);
    expect(state.activeGroupId).toBe("terminal:term-1");
    expect(state.groups.find((group) => group.id === "terminal:term-1")?.activeTerminalId).toBe(
      "term-1",
    );
  });

  it("activateGroup switches the strip without touching any pane's active state", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");
    useTerminalDockStore.getState().openTerminal(refA, "term-3");

    useTerminalDockStore.getState().activateGroup(refA, "terminal:term-1");

    const state = selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA);
    expect(state.activeGroupId).toBe("terminal:term-1");
    expect(state.groups.find((group) => group.id === "terminal:term-1")?.activeTerminalId).toBe(
      "term-2",
    );
  });
});

describe("terminalDockStore — close", () => {
  it("closeTerminal removes one pane and reassigns the group's active pane", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");
    useTerminalDockStore.getState().closeTerminal(refA, "terminal:term-1", "term-2");

    const state = selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA);
    expect(state.groups).toEqual([
      { id: "terminal:term-1", terminalIds: ["term-1"], activeTerminalId: "term-1" },
    ]);
  });

  it("closing the final pane in a group removes the group and falls back to a neighbor", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().openTerminal(refA, "term-2");
    useTerminalDockStore.getState().closeTerminal(refA, "terminal:term-2", "term-2");

    const state = selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA);
    expect(state.groups).toEqual([
      { id: "terminal:term-1", terminalIds: ["term-1"], activeTerminalId: "term-1" },
    ]);
    // MUTATION-PROOF: temporarily hardcoding the fallback to `null` instead
    // of the neighbor lookup turned this assertion red — restored as green.
    expect(state.activeGroupId).toBe("terminal:term-1");
  });

  it("closing the only group empties the thread's entry entirely", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");

    expect(useTerminalDockStore.getState().byThreadKey).toEqual({});
  });

  it("closeGroup removes the whole group regardless of how many panes it holds", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");
    useTerminalDockStore.getState().openTerminal(refA, "term-3");

    useTerminalDockStore.getState().closeGroup(refA, "terminal:term-1");

    const state = selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, refA);
    expect(state.groups).toEqual([
      { id: "terminal:term-3", terminalIds: ["term-3"], activeTerminalId: "term-3" },
    ]);
    expect(state.activeGroupId).toBe("terminal:term-3");
  });
});

describe("terminalDockStore — removeThread / selection helpers", () => {
  it("removeThread clears the thread's entry", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().removeThread(refA);
    expect(useTerminalDockStore.getState().byThreadKey).toEqual({});
  });

  it("selectTerminalDockPanelTerminalIds flattens every group's terminal ids", () => {
    useTerminalDockStore.getState().openTerminal(refA, "term-1");
    useTerminalDockStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");
    useTerminalDockStore.getState().openTerminal(refA, "term-3");

    expect(
      selectTerminalDockPanelTerminalIds(useTerminalDockStore.getState().byThreadKey, refA),
    ).toEqual(new Set(["term-1", "term-2", "term-3"]));
  });

  it("selectTerminalDockPanelTerminalIds is empty for a null ref", () => {
    expect(
      selectTerminalDockPanelTerminalIds(useTerminalDockStore.getState().byThreadKey, null),
    ).toEqual(new Set());
  });
});
