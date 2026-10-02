import { isLoopbackHost } from "./preview.ts";

/**
 * Only return to the DevGame desktop app or a loopback web client, never an
 * arbitrary OAuth-supplied URL. DevGame has no fixed hosted origin (it is
 * deployment configuration), and upstream's hosted origin is not ours to trust.
 */
export function providerAuthReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop = ["devgame:", "devgame-dev:"].includes(url.protocol) && url.host === "app";
    const web = ["http:", "https:"].includes(url.protocol) && isLoopbackHost(url.hostname);
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
