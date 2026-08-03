import { githubReleasesUrl, githubRepositoryUrl } from "./site";

const CACHE_KEY = "t3code-latest-release";

/** Null when no repository is configured — the download page then links nowhere. */
export const RELEASES_URL = githubReleasesUrl();

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

/**
 * Derived from the configured repository so the site never queries the API of a
 * repository it does not belong to. Null when unconfigured.
 */
function latestReleaseApiUrl(): string | null {
  const repositoryUrl = githubRepositoryUrl();
  if (repositoryUrl === null) return null;

  try {
    const url = new URL(repositoryUrl);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    return path ? `https://api.github.com/repos/${path}/releases/latest` : null;
  } catch {
    return null;
  }
}

export async function fetchLatestRelease(): Promise<Release | null> {
  const apiUrl = latestReleaseApiUrl();
  if (apiUrl === null) return null;

  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const data = await fetch(apiUrl).then((r) => r.json());

  if (data?.assets) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }

  return data;
}
