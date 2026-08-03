import { describe, expect, it } from "vite-plus/test";

import { resolveMobileAppConfig, resolveUpdateUrl } from "./app.config.ts";

/**
 * This fork must not inherit the upstream project's Expo org, EAS project,
 * Apple team or passkey domain. Every one of those is configuration with no
 * default, so an unconfigured build ships without them.
 */
describe("mobile app config severance", () => {
  it("disables OTA updates when no EAS project or update URL is configured", () => {
    const config = resolveMobileAppConfig({});

    expect(resolveUpdateUrl({})).toBeUndefined();
    expect(config.updates?.enabled).toBe(false);
    expect(config.updates?.url).toBeUndefined();
  });

  it("omits the EAS project id and owner when unconfigured", () => {
    const config = resolveMobileAppConfig({});

    expect(config.owner).toBeUndefined();
    expect(config.extra?.eas).toBeUndefined();
  });

  it("omits the Apple team id when unconfigured", () => {
    expect(resolveMobileAppConfig({}).ios?.appleTeamId).toBeUndefined();
  });

  it("ships no associated domains when no passkey relying party is configured", () => {
    for (const APP_VARIANT of ["development", "preview", "production"]) {
      const config = resolveMobileAppConfig({ APP_VARIANT });
      expect(config.ios?.associatedDomains, APP_VARIANT).toBeUndefined();
    }
  });

  it("treats blank configuration as unconfigured", () => {
    const config = resolveMobileAppConfig({
      T3CODE_EAS_OWNER: "  ",
      T3CODE_EAS_PROJECT_ID: "",
      T3CODE_APPLE_TEAM_ID: " ",
      T3CODE_PASSKEY_RELYING_PARTY: "\t",
    });

    expect(config.owner).toBeUndefined();
    expect(config.extra?.eas).toBeUndefined();
    expect(config.ios?.appleTeamId).toBeUndefined();
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.updates?.enabled).toBe(false);
  });

  it("uses only configured identity values, never a built-in one", () => {
    const config = resolveMobileAppConfig({
      T3CODE_EAS_OWNER: "example-org",
      T3CODE_EAS_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_PASSKEY_RELYING_PARTY: "clerk.example.test",
    });

    expect(config.owner).toBe("example-org");
    expect(config.extra?.eas).toEqual({ projectId: "11111111-2222-3333-4444-555555555555" });
    expect(config.updates).toEqual({
      enabled: true,
      url: "https://u.expo.dev/11111111-2222-3333-4444-555555555555",
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 0,
    });
    expect(config.ios?.appleTeamId).toBe("ABC1234567");
    expect(config.ios?.associatedDomains).toEqual([
      "applinks:clerk.example.test",
      "webcredentials:clerk.example.test",
    ]);
  });

  it("prefers an explicit update URL over the EAS-derived one", () => {
    expect(
      resolveUpdateUrl({
        T3CODE_EAS_UPDATE_URL: "https://updates.example.test",
        T3CODE_EAS_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
      }),
    ).toBe("https://updates.example.test");
  });

  it("contains no upstream identity anywhere in the resolved config", () => {
    const serialized = JSON.stringify(resolveMobileAppConfig({}));

    for (const upstreamValue of [
      "pingdotgg",
      "d763fcb8-d37c-41ea-a773-b54a0ab4a454",
      "u.expo.dev",
      "ARK85ZXQ4Z",
      "t3.codes",
      "com.t3tools",
      "T3 Code",
      "t3-code",
    ]) {
      expect(serialized, upstreamValue).not.toContain(upstreamValue);
    }
  });
});

describe("mobile app config DevGame identity", () => {
  it("uses the DevGame bundle identifier and product name for every variant", () => {
    const cases = [
      { appVariant: "development", appName: "DevGame Dev", bundleId: "com.devgame.app.dev" },
      { appVariant: "preview", appName: "DevGame Preview", bundleId: "com.devgame.app.preview" },
      { appVariant: "production", appName: "DevGame", bundleId: "com.devgame.app" },
    ] as const;

    for (const { appVariant, appName, bundleId } of cases) {
      const config = resolveMobileAppConfig({ APP_VARIANT: appVariant });
      expect(config.name, appVariant).toBe(appName);
      expect(config.ios?.bundleIdentifier, appVariant).toBe(bundleId);
      expect(config.android?.package, appVariant).toBe(bundleId);
    }
  });

  it("uses the devgame slug", () => {
    expect(resolveMobileAppConfig({}).slug).toBe("devgame");
  });

  it("derives the widget and share-extension identifiers from the DevGame bundle id", () => {
    const config = resolveMobileAppConfig({});
    const plugins = config.plugins ?? [];
    const findPlugin = (name: string) =>
      plugins.find(
        (plugin): plugin is [string, Record<string, unknown>] =>
          Array.isArray(plugin) && plugin[0] === name,
      );

    const widgetsPlugin = findPlugin("expo-widgets");
    expect(widgetsPlugin?.[1]).toMatchObject({
      bundleIdentifier: "com.devgame.app.widgets",
      groupIdentifier: "group.com.devgame.app",
    });
    expect(
      (widgetsPlugin?.[1].widgets as Array<{ description: string }> | undefined)?.[0]?.description,
    ).toBe("Shows the current state of active DevGame agents.");

    const sharingPlugin = findPlugin("expo-sharing");
    expect(sharingPlugin?.[1].ios).toMatchObject({
      extensionBundleIdentifier: "com.devgame.app.sharing",
      appGroupId: "group.com.devgame.app",
    });
  });

  it("names DevGame, not the upstream product, in OS-facing permission prompts", () => {
    const config = resolveMobileAppConfig({});

    expect(config.ios?.infoPlist?.NSLocalNetworkUsageDescription).toBe(
      "Allow DevGame to connect to DevGame servers on your local network or tailnet.",
    );

    const cameraPlugin = (config.plugins ?? []).find(
      (plugin): plugin is [string, Record<string, unknown>] =>
        Array.isArray(plugin) && plugin[0] === "expo-camera",
    );
    expect(cameraPlugin?.[1].cameraPermission).toBe(
      "Allow DevGame to access your camera so you can scan pairing QR codes.",
    );
  });

  it("names the DevGame bundle id in the personal-team bundle id validation error", () => {
    expect(() =>
      resolveMobileAppConfig({
        T3CODE_IOS_PERSONAL_TEAM: "1",
        T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "",
      }),
    ).toThrow(/com\.example\.devgame/);
  });
});
