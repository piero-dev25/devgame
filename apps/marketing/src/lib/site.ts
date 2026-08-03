/**
 * Outward-facing links and figures for the marketing site.
 *
 * None of these carry a default. A store link, a repository link or a traction
 * figure that is not ours is worse than no link and no figure at all, so an
 * unset value resolves to `null` and its consumer renders nothing.
 */

/** Empty and unset are the same thing: no value configured. */
function optionalSetting(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function githubRepositoryUrl(): string | null {
  return optionalSetting(import.meta.env.PUBLIC_GITHUB_REPOSITORY_URL);
}

export function githubReleasesUrl(): string | null {
  const repositoryUrl = githubRepositoryUrl();
  return repositoryUrl === null ? null : `${repositoryUrl.replace(/\/+$/, "")}/releases`;
}

export function iosAppStoreUrl(): string | null {
  return optionalSetting(import.meta.env.PUBLIC_IOS_APP_STORE_URL);
}

export function androidPlayStoreUrl(): string | null {
  return optionalSetting(import.meta.env.PUBLIC_ANDROID_PLAY_STORE_URL);
}

export interface MarketingStats {
  readonly githubStars: string | null;
  readonly users: string | null;
}

export function marketingStats(): MarketingStats {
  return {
    githubStars: optionalSetting(import.meta.env.PUBLIC_MARKETING_GITHUB_STARS),
    users: optionalSetting(import.meta.env.PUBLIC_MARKETING_USERS),
  };
}
