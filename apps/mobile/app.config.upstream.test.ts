import { describe, expect, it } from "vite-plus/test";

import { resolveMobileAppConfig } from "./app.config.ts";

const CONFIGURED_UPDATES = { T3CODE_EAS_PROJECT_ID: "11111111-2222-3333-4444-555555555555" };

const findPlugin = (config: ReturnType<typeof resolveMobileAppConfig>, name: string) =>
  (config.plugins ?? []).find(
    (plugin): plugin is [string, Record<string, unknown>] =>
      Array.isArray(plugin) && plugin[0] === name,
  );

/**
 * Upstream behavior ported into DevGame's env-driven `resolveMobileAppConfig`
 * (2026-10 upstream sync): every upstream addition reads the passed env, never
 * a module-level repo env, and carries DevGame identity.
 */
describe("mobile app config upstream behavior", () => {
  it("defaults development to the appVersion runtime policy and other variants to fingerprint", () => {
    const policy = (APP_VARIANT: string) =>
      (resolveMobileAppConfig({ APP_VARIANT }).runtimeVersion as { policy: string }).policy;

    expect(policy("development")).toBe("appVersion");
    expect(policy("preview")).toBe("fingerprint");
    expect(policy("production")).toBe("fingerprint");
    expect(
      (
        resolveMobileAppConfig({ APP_VARIANT: "development", MOBILE_VERSION_POLICY: "fingerprint" })
          .runtimeVersion as { policy: string }
      ).policy,
    ).toBe("fingerprint");
  });

  it("lets T3CODE_MOBILE_UPDATES_ENABLED=0 switch off a configured update channel", () => {
    expect(resolveMobileAppConfig(CONFIGURED_UPDATES).updates?.enabled).toBe(true);
    const disabled = resolveMobileAppConfig({
      ...CONFIGURED_UPDATES,
      T3CODE_MOBILE_UPDATES_ENABLED: "0",
    });
    expect(disabled.updates?.enabled).toBe(false);
    expect(disabled.updates?.url).toBeUndefined();
  });

  it("scopes the keychain access group to the resolved DevGame bundle id", () => {
    expect(resolveMobileAppConfig({}).ios?.entitlements?.["keychain-access-groups"]).toEqual([
      "$(AppIdentifierPrefix)com.devgame.app",
    ]);
    expect(
      resolveMobileAppConfig({
        T3CODE_IOS_PERSONAL_TEAM: "1",
        T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.devgame",
      }).ios?.entitlements?.["keychain-access-groups"],
    ).toEqual(["$(AppIdentifierPrefix)com.example.devgame"]);
  });

  it("uses a Google services file only when one is configured", () => {
    expect(resolveMobileAppConfig({}).android?.googleServicesFile).toBeUndefined();
    expect(
      resolveMobileAppConfig({ T3CODE_ANDROID_GOOGLE_SERVICES_FILE: "./google-services.json" })
        .android?.googleServicesFile,
    ).toBe("./google-services.json");
  });

  it("ships the subscription usage widget and voice input with DevGame wording", () => {
    const config = resolveMobileAppConfig({});
    const widgets = findPlugin(config, "expo-widgets")?.[1];
    expect(widgets?.enableAndroid).toBe(true);
    expect(
      (widgets?.widgets as Array<{ name: string; description: string }> | undefined)?.find(
        (widget) => widget.name === "SubscriptionUsage",
      )?.description,
    ).toBe("Subscription quotas from your connected DevGame environments.");
    expect(findPlugin(config, "expo-audio")?.[1].microphonePermission).toBe(
      "Allow DevGame to use your microphone for voice input.",
    );
    expect(config.ios?.infoPlist?.NSPhotoLibraryAddUsageDescription).toBe(
      "Allow DevGame to save images to your photo library.",
    );
  });
});
