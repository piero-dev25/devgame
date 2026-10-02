import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchLatestRelease, releaseApiUrls } from "./releases";

/**
 * The release feed (stable and nightly) must only ever come from the
 * configured repository — never a hard-coded upstream one.
 */
describe("release feed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("derives the stable and nightly API endpoints from the configured repository", () => {
    expect(releaseApiUrls("https://github.example.test/acme/app/")).toEqual({
      latest: "https://api.github.com/repos/acme/app/releases/latest",
      list: "https://api.github.com/repos/acme/app/releases?per_page=10",
    });
  });

  it("has no endpoint without a usable repository", () => {
    expect(releaseApiUrls(null)).toBeNull();
    expect(releaseApiUrls("https://github.example.test/")).toBeNull();
    expect(releaseApiUrls("not a url")).toBeNull();
  });

  it.each(["stable", "nightly"] as const)(
    "never fetches a %s release when no repository is configured",
    async (channel) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(fetchLatestRelease(channel)).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("picks the newest nightly from the configured repository's release list", async () => {
    vi.stubEnv("PUBLIC_GITHUB_REPOSITORY_URL", "https://github.example.test/acme/app");
    const stored = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    const nightly = {
      tag_name: "v1.2.0-nightly.3",
      html_url: "https://github.example.test/acme/app/releases/tag/v1.2.0-nightly.3",
      published_at: "2026-10-01T00:00:00Z",
      assets: [],
    };
    const fetchMock = vi.fn(async () => ({
      json: async () => [{ ...nightly, tag_name: "v1.1.0" }, nightly],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLatestRelease("nightly")).resolves.toEqual(nightly);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/releases?per_page=10",
    );
  });
});
