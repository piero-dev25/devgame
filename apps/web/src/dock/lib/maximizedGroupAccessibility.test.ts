import { describe, expect, it } from "vite-plus/test";

import { applyMaximizedGroupAccessibility } from "./maximizedGroupAccessibility";

/**
 * Stands in for a real `HTMLElement` — this repo has no jsdom (see
 * `openPanel.ts`'s own doc comment), so what's provable here is that the
 * RIGHT calls are made with the RIGHT arguments, the same spy-based
 * assertion `openPanel.test.ts`'s `fakePanel` already uses for
 * `IDockviewPanel.api.setActive`/`.close`.
 */
function fakeElement() {
  const attributes = new Map<string, string>();
  return {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    attributes,
  };
}

function fakeGroup(id: string) {
  return { id, element: fakeElement() };
}

describe("applyMaximizedGroupAccessibility — a group is maximized", () => {
  it("hides every OTHER group from assistive tech, leaves the maximized one alone", () => {
    const sidebar = fakeGroup("group-sidebar");
    const chat = fakeGroup("group-chat");
    const diff = fakeGroup("group-diff");

    applyMaximizedGroupAccessibility([sidebar, chat, diff], "group-chat");

    expect(sidebar.element.attributes.get("aria-hidden")).toBe("true");
    expect(sidebar.element.attributes.has("inert")).toBe(true);
    expect(diff.element.attributes.get("aria-hidden")).toBe("true");
    expect(diff.element.attributes.has("inert")).toBe(true);
    // The maximized group itself must stay fully reachable — this is the
    // one case a naive "hide everything" implementation gets wrong.
    expect(chat.element.attributes.has("aria-hidden")).toBe(false);
    expect(chat.element.attributes.has("inert")).toBe(false);
  });
});

describe("applyMaximizedGroupAccessibility — nothing is maximized", () => {
  it("clears aria-hidden/inert from every group", () => {
    const sidebar = fakeGroup("group-sidebar");
    const chat = fakeGroup("group-chat");
    sidebar.element.setAttribute("aria-hidden", "true");
    sidebar.element.setAttribute("inert", "");

    applyMaximizedGroupAccessibility([sidebar, chat], null);

    expect(sidebar.element.attributes.has("aria-hidden")).toBe(false);
    expect(sidebar.element.attributes.has("inert")).toBe(false);
    expect(chat.element.attributes.has("aria-hidden")).toBe(false);
    expect(chat.element.attributes.has("inert")).toBe(false);
  });
});

describe("applyMaximizedGroupAccessibility — the maximized group changes (e.g. maximize a different tab)", () => {
  it("un-hides the previously-maximized group and hides the newly-maximized one's siblings", () => {
    const chat = fakeGroup("group-chat");
    const diff = fakeGroup("group-diff");

    applyMaximizedGroupAccessibility([chat, diff], "group-chat");
    expect(diff.element.attributes.has("aria-hidden")).toBe(true);

    applyMaximizedGroupAccessibility([chat, diff], "group-diff");
    expect(chat.element.attributes.has("aria-hidden")).toBe(true);
    expect(diff.element.attributes.has("aria-hidden")).toBe(false);
  });
});
