import type { ExpoConfig } from "expo/config";

import { BRAND_ASSET_PATHS } from "../../scripts/lib/brand-assets.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";

type MobileEnv = Readonly<Record<string, string | undefined>>;

const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;

/** Empty and unset are the same thing: no value configured. */
function optionalSetting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const DEVELOPMENT_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  androidAdaptiveForeground: fromRepoRoot(BRAND_ASSET_PATHS.developmentUniversalIconPng),
  androidAdaptiveBackgroundColor: "#00639B",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#00639B",
} as const;

const PREVIEW_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  androidAdaptiveForeground: fromRepoRoot(BRAND_ASSET_PATHS.nightlyLinuxIconPng),
  androidAdaptiveBackgroundColor: "#111533",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#7565C7",
} as const;

const RELEASE_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  androidAdaptiveForeground: "./assets/android-icon-mark.png",
  androidAdaptiveBackgroundColor: "#000000",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#FFFFFF",
} as const;

const VARIANT_CONFIG = {
  development: {
    appName: "DevGame Dev",
    scheme: "devgame-dev",
    iosBundleIdentifier: "com.devgame.app.dev",
    androidPackage: "com.devgame.app.dev",
    assets: DEVELOPMENT_ASSETS,
  },
  preview: {
    appName: "DevGame Preview",
    scheme: "devgame-preview",
    iosBundleIdentifier: "com.devgame.app.preview",
    androidPackage: "com.devgame.app.preview",
    assets: PREVIEW_ASSETS,
  },
  production: {
    appName: "DevGame",
    scheme: "devgame",
    iosBundleIdentifier: "com.devgame.app",
    androidPackage: "com.devgame.app",
    assets: RELEASE_ASSETS,
  },
} as const;

type RuntimeVersionPolicy = "appVersion" | "fingerprint" | "nativeVersion" | "sdkVersion";

function resolveRuntimeVersionPolicy(value: string | undefined): RuntimeVersionPolicy {
  const policy = optionalSetting(value);
  switch (policy) {
    case undefined:
      return "fingerprint";
    case "appVersion":
    case "fingerprint":
    case "nativeVersion":
    case "sdkVersion":
      return policy;
    default:
      throw new Error(`MOBILE_VERSION_POLICY must be a valid Expo runtime version policy.`);
  }
}

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

/**
 * OTA delivery is inert unless this fork points it somewhere. An explicit
 * update URL wins; otherwise it is derived from the configured EAS project.
 * With neither, `expo-updates` is switched off rather than left listening on
 * whichever project was last baked into the file.
 */
export function resolveUpdateUrl(env: MobileEnv): string | undefined {
  const explicitUrl = optionalSetting(env.T3CODE_EAS_UPDATE_URL);
  if (explicitUrl) {
    return explicitUrl;
  }
  const projectId = optionalSetting(env.T3CODE_EAS_PROJECT_ID);
  return projectId ? `https://u.expo.dev/${projectId}` : undefined;
}

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

export function resolveMobileAppConfig(env: MobileEnv): ExpoConfig {
  const APP_VARIANT = resolveAppVariant(env.APP_VARIANT);
  const isIosPersonalTeamBuild = env.T3CODE_IOS_PERSONAL_TEAM === "1";
  const personalTeamBundleIdentifier = optionalSetting(env.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID);

  if (
    isIosPersonalTeamBuild &&
    (!personalTeamBundleIdentifier ||
      !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
  ) {
    throw new Error(
      "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.devgame when T3CODE_IOS_PERSONAL_TEAM=1.",
    );
  }

  const variant = VARIANT_CONFIG[APP_VARIANT];
  const iosBundleIdentifier = isIosPersonalTeamBuild
    ? personalTeamBundleIdentifier!
    : variant.iosBundleIdentifier;

  // Every identity below is configuration with no fallback. A fork that has
  // not registered its own Expo project, Apple team or passkey domain must
  // build without them rather than inherit someone else's.
  const easOwner = optionalSetting(env.T3CODE_EAS_OWNER);
  const easProjectId = optionalSetting(env.T3CODE_EAS_PROJECT_ID);
  const appleTeamId = optionalSetting(env.T3CODE_APPLE_TEAM_ID);
  const relyingParty = optionalSetting(env.T3CODE_PASSKEY_RELYING_PARTY);
  const updateUrl = resolveUpdateUrl(env);
  const isShowcaseCaptureBuild = env.T3_SHOWCASE_CAPTURE_BUILD === "1";

  const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
    "expo-widgets",
    {
      bundleIdentifier: `${iosBundleIdentifier}.widgets`,
      groupIdentifier: `group.${iosBundleIdentifier}`,
      enablePushNotifications: true,
      // Agent activity can update many times an hour; without the
      // frequent-updates entitlement iOS throttles the update budget sooner.
      frequentUpdates: true,
      widgets: [
        {
          name: "AgentActivity",
          displayName: "Agent Activity",
          description: "Shows the current state of active DevGame agents.",
          supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"],
        },
      ],
    },
  ];

  const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
    "expo-sharing",
    {
      ios: {
        // Personal Teams cannot sign App Groups or extension targets. Keep the
        // reduced-capability local build usable while release builds expose the
        // real system share target.
        enabled: !isIosPersonalTeamBuild,
        extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
        appGroupId: `group.${iosBundleIdentifier}`,
        activationRule: {
          supportsText: true,
          supportsWebUrlWithMaxCount: 1,
          supportsImageWithMaxCount: 8,
        },
      },
      android: {
        enabled: true,
        singleShareMimeTypes: ["text/plain", "image/*"],
        multipleShareMimeTypes: ["image/*"],
      },
    },
  ];

  // These aliases match the fonts' PostScript names on iOS. Register the same
  // names on Android so React Native and the native composer use one set of
  // family names without waiting for runtime font loading.

  return {
    name: variant.appName,
    slug: "devgame",
    platforms: ["ios", "android"],
    scheme: variant.scheme,
    version: "1.0.1",
    runtimeVersion: {
      // Fingerprint (not appVersion) so an OTA only reaches binaries whose native
      // project — native deps, config plugins, AND patches/ — matches the update.
      // With appVersion, every 0.1.0 build shares a runtime version, so a JS update
      // could land on a binary missing the native changes it needs and crash.
      policy: resolveRuntimeVersionPolicy(env.MOBILE_VERSION_POLICY),
    },
    orientation: "portrait",
    icon: variant.assets.appIcon,
    userInterfaceStyle: "automatic",
    updates: updateUrl
      ? {
          enabled: true,
          url: updateUrl,
          checkAutomatically: "ON_LOAD",
          fallbackToCacheTimeout: 0,
        }
      : { enabled: false, fallbackToCacheTimeout: 0 },
    ios: {
      icon: variant.assets.iosIcon,
      supportsTablet: true,
      // Multitasking-capable iPad apps cannot rotate programmatically, so the
      // showcase capture build requires full screen (see infoPlist below).
      requireFullScreen: isShowcaseCaptureBuild,
      bundleIdentifier: iosBundleIdentifier,
      // Pins code signing so non-interactive `expo run:ios` does not fall back to
      // a personal team (which cannot sign app groups, Sign in with Apple, or
      // push notification entitlements). Unset means "let Xcode decide" — never
      // another organisation's team.
      ...(appleTeamId ? { appleTeamId } : {}),
      // The passkey entitlement names a domain we must control. Without one
      // configured, ship no associated domains rather than someone else's.
      ...(relyingParty
        ? {
            associatedDomains: [`applinks:${relyingParty}`, `webcredentials:${relyingParty}`],
          }
        : {}),
      infoPlist: {
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
        },
        NSLocalNetworkUsageDescription:
          "Allow DevGame to connect to DevGame servers on your local network or tailnet.",
        ITSAppUsesNonExemptEncryption: false,
        // The App Store screenshot harness rotates the iPad interface from
        // inside the app (CI denies osascript the Accessibility access that
        // Simulator menu scripting needs), and iPadOS ignores programmatic
        // orientation requests for multitasking-capable apps — so the capture
        // build opts out of multitasking and declares landscape support.
        ...(isShowcaseCaptureBuild
          ? {
              "UISupportedInterfaceOrientations~ipad": [
                "UIInterfaceOrientationPortrait",
                "UIInterfaceOrientationPortraitUpsideDown",
                "UIInterfaceOrientationLandscapeLeft",
                "UIInterfaceOrientationLandscapeRight",
              ],
            }
          : {}),
      },
    },
    android: {
      icon: variant.assets.appIcon,
      package: variant.androidPackage,
      adaptiveIcon: {
        backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
        foregroundImage: variant.assets.androidAdaptiveForeground,
        monochromeImage: variant.assets.androidMonochromeIcon,
      },
      // Opts into OnBackInvokedCallback-based back dispatch (Android 13+).
      // JS back handling survives it via react-native's Android 16 shim plus
      // withAndroidPredictiveBackCompat on Android 13-15.
      predictiveBackGestureEnabled: true,
    },
    web: {
      favicon: variant.assets.appIcon,
    },
    plugins: [
      "expo-asset",
      [
        "expo-font",
        {
          ios: {
            fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold],
          },
          android: {
            fonts: [
              {
                fontFamily: "DMSans-Regular",
                fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
              },
              {
                fontFamily: "DMSans-Medium",
                fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
              },
              {
                fontFamily: "DMSans-Bold",
                fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
              },
            ],
          },
        },
      ],
      "expo-secure-store",
      "expo-sqlite",
      ...(isIosPersonalTeamBuild
        ? [sharingPlugin]
        : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),
      [
        "expo-notifications",
        {
          icon: variant.assets.androidNotificationIcon,
          color: variant.assets.androidNotificationColor,
          mode: APP_VARIANT === "development" ? "development" : "production",
        },
      ],
      // appleSignIn must be gated here: withoutIosPersonalTeamCapabilities.cjs runs before
      // plugins earlier in this array, so it cannot strip the entitlement Clerk would add.
      ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],
      "expo-web-browser",
      [
        "expo-quick-actions",
        {
          // Adaptive launcher-shortcut icon; referenced by resource name from
          // the shortcut items set in src/features/shortcuts.
          androidIcons: {
            shortcut_icon: {
              foregroundImage: variant.assets.androidAdaptiveForeground,
              backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
            },
          },
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission: "Allow DevGame to access your camera so you can scan pairing QR codes.",
          microphonePermission: false,
          barcodeScannerEnabled: true,
          recordAudioAndroid: false,
        },
      ],
      ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
      [
        "expo-splash-screen",
        {
          image: variant.assets.splashIcon,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          imageWidth: 220,
          dark: {
            image: variant.assets.splashIcon,
            backgroundColor: "#0a0a0a",
          },
        },
      ],
      [
        "expo-build-properties",
        {
          ios: {
            deploymentTarget: "18.0",
            // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
            extraPods: [
              { name: "GoogleUtilities", modular_headers: true },
              { name: "RecaptchaInterop", modular_headers: true },
            ],
          },
        },
      ],
      "./plugins/withIosCocoaPodsUuidCache.cjs",
      // Must be listed BEFORE expo-widgets: same-type mods run last-registered-
      // first, so registering earlier makes this plugin's mods run AFTER
      // expo-widgets' — its dangerous mod wipes ios/ExpoWidgetsTarget/ (which
      // would delete the asset catalog) and its xcodeproj mod creates the widget
      // target (which must exist before the compile phase can be attached).
      ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),
      "./plugins/withIosSceneLifecycle.cjs",
      "./plugins/withAndroidCleartextTraffic.cjs",
      "./plugins/withAndroidGradleHeap.cjs",
      "./plugins/withAndroidModernPopupMenu.cjs",
      "./plugins/withAndroidModernAlertDialog.cjs",
      "./plugins/withAndroidPredictiveBackCompat.cjs",
      ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
    ],
    extra: {
      appVariant: APP_VARIANT,
      iosPersonalTeamBuild: isIosPersonalTeamBuild,
      relay: {
        url: env.T3CODE_RELAY_URL ?? null,
      },
      clerk: {
        publishableKey: env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
        jwtTemplate: env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
      },
      // Native Google sign-in credentials. @clerk/expo reads these from `extra`
      // under their exact env-var names (not nested), and its config plugin reads
      // the iOS URL scheme at prebuild to register it in Info.plist.
      // Unset values must be omitted (not null): the public manifest serializes
      // null to {}, which is truthy and would defeat Clerk's fallback checks.
      EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: env.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
      EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
      EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: env.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
      EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
      observability: {
        tracesUrl: env.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
        tracesDataset: env.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
        tracesToken: env.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
      },
      // Omitted when unconfigured: `eas build` then fails with its own "no
      // project" error instead of quietly targeting another organisation's.
      ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
    },
    ...(easOwner ? { owner: easOwner } : {}),
  };
}

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

export default resolveMobileAppConfig(repoEnv);
