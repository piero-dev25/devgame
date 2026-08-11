// Merge-gate follow-up on W1 (closed as `UnityCliMissingRemedy` in
// EngineToolbar.tsx): the copy button's aria-label promises "Copy Unity CLI
// install command," but the wiring copied `props.message` — the ENTIRE
// ~300-char S1 sentence (backticks, docs URL, "then restart DevGame" and
// all), not the bare shell command. A user pasting that into a terminal
// would have to hand-edit it before it runs, which defeats the whole point
// of a copy button here.
//
// `renderToStaticMarkup` (this file's siblings' usual technique) can't prove
// this: React event handlers are plain JS closures that never serialize
// into the static HTML string, so there is nothing in rendered markup to
// assert against. `ServerUpdateAction.test.tsx` already establishes this
// repo's answer to that exact problem for a copy button: mock
// `useCopyToClipboard` (so calling the component directly, outside a real
// React render tree, never trips React's "hooks need an active render"
// check) and call the component as a plain function, then invoke the
// button element's own `onClick` directly and assert what the mock was
// called with. Mirrored here.
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: testState.copyToClipboard, isCopied: false }),
}));

import { UnityCliMissingRemedy } from "./EngineToolbar";

type CopyButtonElement = ReactElement<{
  readonly "aria-label"?: string;
  readonly onClick?: () => void;
}>;

// `UnityCliMissingRemedy` returns a `<div>` with three children (the Unity
// icon, the visible message text, the copy button) — JSX compiles multiple
// children into an array on `.props.children`. Located by its own
// aria-label rather than positionally, so this survives an unrelated
// reordering of the row's contents.
function findCopyButton(element: ReactElement): CopyButtonElement {
  const children = (element.props as { readonly children: ReadonlyArray<ReactElement> }).children;
  const button = children.find(
    (child) =>
      (child.props as { readonly ["aria-label"]?: string })["aria-label"] ===
      "Copy Unity CLI install command",
  );
  if (button === undefined) {
    throw new Error("UnityCliMissingRemedy: copy button not found among its own children");
  }
  return button as CopyButtonElement;
}

// A realistic S1 sentence — deliberately NOT equal to the bare command, so
// a test that accidentally asserted "copies props.message" (the bug) would
// still fail here even if the two strings happened to overlap.
const S1_MESSAGE =
  "Unity's command-line tool isn't installed on this machine. DevGame needs it to talk to the Editor. Install it with `brew install --cask unity-cli` on macOS, or see Unity's CLI docs at https://docs.unity.com/en-us/unity-cli on other platforms — then restart DevGame.";

describe("UnityCliMissingRemedy — the copy button copies the BARE command, not the full S1 sentence", () => {
  it("calls copyToClipboard with exactly 'brew install --cask unity-cli'", () => {
    testState.copyToClipboard.mockReset();

    const element = UnityCliMissingRemedy({ message: S1_MESSAGE });
    findCopyButton(element).props.onClick?.();

    expect(testState.copyToClipboard).toHaveBeenCalledTimes(1);
    expect(testState.copyToClipboard).toHaveBeenCalledWith(
      "brew install --cask unity-cli",
      undefined,
    );
  });

  it("never copies the full displayed message — a user pasting the result must not have to hand-edit it", () => {
    testState.copyToClipboard.mockReset();

    const element = UnityCliMissingRemedy({ message: S1_MESSAGE });
    findCopyButton(element).props.onClick?.();

    expect(testState.copyToClipboard).not.toHaveBeenCalledWith(S1_MESSAGE, undefined);
  });
});
