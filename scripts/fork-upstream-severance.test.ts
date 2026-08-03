// @effect-diagnostics nodeBuiltinImport:off - Reads repository sources directly to assert what ships.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * A fork must not carry the upstream project's live identity as a reachable
 * default. These files each held one: an analytics key, an EAS project and
 * Apple team, a passkey domain, a releases URL, hosted-app domains and store
 * listings. Every one is configuration now, so none of the literals below may
 * reappear in these files — not as a default, not as a fallback.
 *
 * Test files are deliberately not covered: sample URLs in assertions ship
 * nowhere. This guards what a build actually emits.
 */
const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const UPSTREAM_LITERALS = [
  "phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m",
  "d763fcb8-d37c-41ea-a773-b54a0ab4a454",
  "ARK85ZXQ4Z",
  "6787819824",
  "pingdotgg",
  "t3.codes",
  "com.t3tools.t3code",
] as const;

/**
 * The bundle/application identifier used to be exempted from app.config.ts
 * here, with a comment noting it was "a separate owner decision" pending an
 * App Store registration call — an App Store record, once registered under a
 * given identifier, cannot be renamed. That decision was made on 2026-08-03:
 * product **DevGame**, bundle **com.devgame.app**. The exemption is removed
 * as of this change — upstream's bundle id is a live platform identity
 * exactly like the analytics key or the EAS project, so it is asserted
 * absent here on the same terms as every other upstream literal: no
 * exemptions, in any of the files below.
 */
const OWN_BUNDLE_IDENTIFIER = "com.devgame.app";

const SEVERED_FILES = [
  "apps/server/src/telemetry/AnalyticsService.ts",
  "apps/server/src/cloud/publicConfig.ts",
  "apps/mobile/eas.json",
  "apps/mobile/app.config.ts",
  "apps/web/src/components/desktopUpdate.logic.ts",
  "apps/web/vercel.ts",
  "packages/shared/src/connectAuth.ts",
  "apps/marketing/src/lib/site.ts",
  "apps/marketing/src/lib/releases.ts",
  "apps/marketing/src/layouts/Layout.astro",
  "apps/marketing/src/pages/index.astro",
  "apps/marketing/src/pages/download.astro",
  "scripts/build-desktop-artifact.ts",
  "scripts/mobile-showcase.ts",
  "apps/desktop/src/app/DesktopEnvironment.ts",
  "apps/desktop/scripts/electron-launcher.mjs",
] as const;

/**
 * Files that define our own bundle/application identifier as a literal.
 * These are the A1/A4 sources in docs/workbench/release-readiness.md §4.8 —
 * if any of them stops naming com.devgame.app (blanked, reverted, or
 * silently repointed at something else), that is exactly as much a fork-
 * identity defect as upstream's id reappearing, so it is asserted present,
 * not just asserted-absent-for-upstream.
 */
const FILES_REQUIRING_OWN_BUNDLE_IDENTIFIER = [
  "apps/mobile/app.config.ts",
  "scripts/build-desktop-artifact.ts",
  "scripts/mobile-showcase.ts",
  "apps/desktop/src/app/DesktopEnvironment.ts",
  "apps/desktop/scripts/electron-launcher.mjs",
] as const;

function readRepoFile(relativePath: string): string {
  return NodeFS.readFileSync(NodePath.join(REPO_ROOT, relativePath), "utf8");
}

describe("fork severance from upstream infrastructure", () => {
  it.each(SEVERED_FILES)("%s carries no upstream identity", (relativePath) => {
    const source = readRepoFile(relativePath);

    for (const literal of UPSTREAM_LITERALS) {
      expect(source, `${relativePath} contains ${literal}`).not.toContain(literal);
    }
  });

  it.each(FILES_REQUIRING_OWN_BUNDLE_IDENTIFIER)(
    "%s carries our own bundle identifier",
    (relativePath) => {
      const source = readRepoFile(relativePath);

      expect(source, `${relativePath} is missing ${OWN_BUNDLE_IDENTIFIER}`).toContain(
        OWN_BUNDLE_IDENTIFIER,
      );
    },
  );

  /**
   * URL schemes are registered with the OPERATING SYSTEM, so they are as much
   * a public identity as the bundle id: they appear in deep links, in the
   * macOS/Linux handler registry, and in the OAuth callback origin that Clerk
   * allowlists.
   *
   * Asserted separately from UPSTREAM_LITERALS because the bare token `t3code`
   * cannot go in that list. Twenty-two localStorage keys still carry a
   * `t3code:` prefix and are deliberately left alone — they are invisible to
   * users, renaming them would wipe saved layouts and drafts, and each rename
   * is permanent merge-conflict surface against upstream for no user-facing
   * gain. So this check is scoped to the two files that declare OS-level
   * schemes.
   *
   * The gap it closes is real: the schemes survived every earlier rename pass
   * precisely because the existing guard only looked for the hyphenated
   * `t3-code`, and `t3code-dev` walked straight through it.
   */
  const SCHEME_DECLARING_FILES = [
    "apps/mobile/app.config.ts",
    "scripts/build-desktop-artifact.ts",
    // Added after the first pass shipped with this file still declaring
    // `["t3code-dev"] : ["t3code"]`. It writes CFBundleURLSchemes for the DEV
    // runtime, so the packaged build was renamed while the app developers run
    // every day was not -- and the only way that surfaced was reading the
    // running app's Info.plist. Two files declaring the same OS-level identity
    // is exactly the shape a single-file check misses.
    "apps/desktop/scripts/electron-launcher.mjs",
  ];

  it.each(SCHEME_DECLARING_FILES)("%s registers our own URL scheme, not upstream's", (path) => {
    const source = readRepoFile(path);

    for (const upstreamScheme of ['"t3code"', '"t3code-dev"', '"t3code-preview"']) {
      expect(source, `${path} still registers ${upstreamScheme}`).not.toContain(upstreamScheme);
    }
    // Asserted PRESENT too: a file that simply lost its scheme block would pass
    // a pure absence check while shipping an app that handles no deep links.
    expect(source, `${path} declares no devgame scheme`).toContain("devgame");
  });

  it("leaves no upstream domain as a shell default in the release workflow", () => {
    const workflow = readRepoFile(".github/workflows/release.yml");
    const shellDefaults = workflow.match(/\$\{[A-Z0-9_]+:-[^}]*\}/g) ?? [];

    for (const shellDefault of shellDefaults) {
      expect(shellDefault).not.toContain("t3.codes");
    }
  });
});
