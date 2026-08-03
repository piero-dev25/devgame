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

/** Bundle identifiers are a separate owner decision; only network identity is in scope here. */
const BUNDLE_IDENTIFIER_LITERAL = "com.t3tools.t3code";

const SEVERED_FILES = [
  "apps/server/src/telemetry/AnalyticsService.ts",
  "apps/server/src/cloud/publicConfig.ts",
  "apps/mobile/eas.json",
  "apps/web/src/components/desktopUpdate.logic.ts",
  "apps/web/vercel.ts",
  "packages/shared/src/connectAuth.ts",
  "apps/marketing/src/lib/site.ts",
  "apps/marketing/src/lib/releases.ts",
  "apps/marketing/src/layouts/Layout.astro",
  "apps/marketing/src/pages/index.astro",
  "apps/marketing/src/pages/download.astro",
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

  it("keeps every upstream literal out of app.config.ts except the bundle identifiers", () => {
    // app.config.ts still names the bundle/package identifiers, which are an
    // owner decision (an App Store record, once registered, cannot be renamed).
    // Nothing else upstream may survive there.
    const source = readRepoFile("apps/mobile/app.config.ts");

    for (const literal of UPSTREAM_LITERALS) {
      if (literal === BUNDLE_IDENTIFIER_LITERAL) continue;
      expect(source, `app.config.ts contains ${literal}`).not.toContain(literal);
    }
  });

  it("leaves no upstream domain as a shell default in the release workflow", () => {
    const workflow = readRepoFile(".github/workflows/release.yml");
    const shellDefaults = workflow.match(/\$\{[A-Z0-9_]+:-[^}]*\}/g) ?? [];

    for (const shellDefault of shellDefaults) {
      expect(shellDefault).not.toContain("t3.codes");
    }
  });
});
