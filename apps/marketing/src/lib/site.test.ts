import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  androidPlayStoreUrl,
  githubReleasesUrl,
  githubRepositoryUrl,
  iosAppStoreUrl,
  marketingStats,
} from "./site";

/**
 * The marketing site must never present another project's store listings,
 * repository or traction as ours. Absent is the honest unconfigured state.
 */
describe("marketing site configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves every outward-facing link to null when unconfigured", () => {
    expect(githubRepositoryUrl()).toBeNull();
    expect(githubReleasesUrl()).toBeNull();
    expect(iosAppStoreUrl()).toBeNull();
    expect(androidPlayStoreUrl()).toBeNull();
  });

  it("reports no traction figures when unconfigured", () => {
    expect(marketingStats()).toEqual({ githubStars: null, users: null });
  });

  it("treats blank configuration as unconfigured", () => {
    vi.stubEnv("PUBLIC_GITHUB_REPOSITORY_URL", "  ");
    vi.stubEnv("PUBLIC_IOS_APP_STORE_URL", "");
    vi.stubEnv("PUBLIC_ANDROID_PLAY_STORE_URL", "\t");
    vi.stubEnv("PUBLIC_MARKETING_GITHUB_STARS", " ");
    vi.stubEnv("PUBLIC_MARKETING_USERS", "");

    expect(githubRepositoryUrl()).toBeNull();
    expect(githubReleasesUrl()).toBeNull();
    expect(iosAppStoreUrl()).toBeNull();
    expect(androidPlayStoreUrl()).toBeNull();
    expect(marketingStats()).toEqual({ githubStars: null, users: null });
  });

  it("uses only configured values", () => {
    vi.stubEnv("PUBLIC_GITHUB_REPOSITORY_URL", "https://github.example.test/acme/app");
    vi.stubEnv("PUBLIC_IOS_APP_STORE_URL", "https://apps.example.test/app/id1");
    vi.stubEnv("PUBLIC_ANDROID_PLAY_STORE_URL", "https://play.example.test/app?id=com.acme.app");
    vi.stubEnv("PUBLIC_MARKETING_GITHUB_STARS", "12+");
    vi.stubEnv("PUBLIC_MARKETING_USERS", "300");

    expect(githubRepositoryUrl()).toBe("https://github.example.test/acme/app");
    expect(githubReleasesUrl()).toBe("https://github.example.test/acme/app/releases");
    expect(iosAppStoreUrl()).toBe("https://apps.example.test/app/id1");
    expect(androidPlayStoreUrl()).toBe("https://play.example.test/app?id=com.acme.app");
    expect(marketingStats()).toEqual({ githubStars: "12+", users: "300" });
  });
});
