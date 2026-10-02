// Upstream dropped its static snapshot test for this page (10421bcdc9). The
// fork keeps this small guard because the page is user-facing branding:
// every release channel must say DevGame, never the upstream product name.
import { expect, it } from "@effect/vitest";

import { renderLoopbackAuthorizationCompleteHtml } from "./cliAuthHtml.ts";

it.each([
  ["dev", "DevGame (Dev)"],
  ["nightly", "DevGame (Nightly)"],
  ["latest", "DevGame"],
] as const)("brands the %s loopback completion page as DevGame", (stage, brand) => {
  const html = renderLoopbackAuthorizationCompleteHtml(stage);

  expect(html).toContain(`<p class="brand">${brand}</p>`);
  expect(html).toContain(`class="stage stage-${stage}"`);
  expect(html).not.toContain("T3 Code");
});
