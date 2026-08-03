import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

// Channel routing needs three domains this deployment must own; the same
// variables drive the release workflow's aliasing step. They are configuration
// with no fallback: with any of them missing the host-matched router rules are
// omitted entirely, so a deployment can never proxy onto domains belonging to
// the project this was forked from.
const ROUTER_HOST = hostFromEnv(process.env.T3CODE_WEB_ROUTER_URL);
const LATEST_HOST = hostFromEnv(process.env.T3CODE_WEB_LATEST_DOMAIN);
const NIGHTLY_HOST = hostFromEnv(process.env.T3CODE_WEB_NIGHTLY_DOMAIN);
const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";

/** Accepts either a bare domain or a full origin and yields the bare host. */
function hostFromEnv(value: string | undefined): string | null {
  const trimmed = value
    ?.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return trimmed ? trimmed : null;
}

const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  routes: [
    {
      src: "/__t3code/channel",
      has: [matchers.query("channel", "nightly")],
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__t3code/channel",
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
    ...(ROUTER_HOST && NIGHTLY_HOST
      ? [
          {
            src: "/(.*)",
            has: [
              matchers.host(ROUTER_HOST),
              matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly"),
            ],
            dest: `https://${NIGHTLY_HOST}/$1`,
          },
        ]
      : []),
    ...(ROUTER_HOST && LATEST_HOST
      ? [
          {
            src: "/(.*)",
            has: [matchers.host(ROUTER_HOST)],
            dest: `https://${LATEST_HOST}/$1`,
          },
        ]
      : []),
  ],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
