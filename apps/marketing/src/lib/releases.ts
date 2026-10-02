import { githubReleasesUrl, githubRepositoryUrl } from "./site";

/** Null when no repository is configured — the download page then links nowhere. */
export const RELEASES_URL = githubReleasesUrl();
export const NIGHTLY_RELEASES_URL =
  RELEASES_URL === null ? null : `${RELEASES_URL}?q=nightly&expanded=true`;

export type ReleaseChannel = "stable" | "nightly";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

export interface ReleaseApiUrls {
  readonly latest: string;
  // The `latest` endpoint skips prereleases, so nightly needs the list. GitHub
  // returns it newest first and nightlies land several times a day, so the first
  // nightly tag in a small page is the current build.
  readonly list: string;
}

/**
 * Derived from the configured repository so the site never queries the API of a
 * repository it does not belong to. Null when unconfigured.
 */
export function releaseApiUrls(repositoryUrl: string | null): ReleaseApiUrls | null {
  if (repositoryUrl === null) return null;

  try {
    const url = new URL(repositoryUrl);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!path) return null;
    const base = `https://api.github.com/repos/${path}/releases`;
    return { latest: `${base}/latest`, list: `${base}?per_page=10` };
  } catch {
    return null;
  }
}

function cacheKey(channel: ReleaseChannel) {
  return `t3code-${channel}-release`;
}

async function fetchStable(apiUrls: ReleaseApiUrls): Promise<Release> {
  return fetch(apiUrls.latest).then((r) => r.json());
}

async function fetchNightly(apiUrls: ReleaseApiUrls): Promise<Release> {
  const list: Release[] = await fetch(apiUrls.list).then((r) => r.json());
  const nightly = Array.isArray(list)
    ? list.find((release) => release.tag_name?.includes("-nightly."))
    : undefined;
  if (!nightly) throw new Error("No nightly release in the latest page");
  return nightly;
}

export async function fetchLatestRelease(
  channel: ReleaseChannel = "stable",
): Promise<Release | null> {
  const apiUrls = releaseApiUrls(githubRepositoryUrl());
  if (apiUrls === null) return null;

  const key = cacheKey(channel);
  const cached = sessionStorage.getItem(key);
  if (cached) return JSON.parse(cached);

  const data = channel === "nightly" ? await fetchNightly(apiUrls) : await fetchStable(apiUrls);

  if (data?.assets) {
    sessionStorage.setItem(key, JSON.stringify(data));
  }

  return data;
}
