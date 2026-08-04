// Identity extraction for third-party browser-panel sources (Figma, Notion) —
// see docs/workbench/three-feature-decisions.md #4. Both products encode
// enough identity in their own URL for "Add to chat" to act on: Figma
// carries a file key and a frame node id, Notion carries a page id. Neither
// needs scraping or an injected script — the browser panel's webview
// already exposes its current URL.
//
// FIGMA EPISTEMIC STATUS (working assumption, not directly observed — see
// team-lead's research writeup): the URL's `node-id` updates as you move
// around a file without an explicit "copy link" action, so it's cheap to
// read at capture time. But it reflects the TOP-LEVEL FRAME you're working
// in, not the individual nested layer you last clicked — corroborated by
// Figma's own forum and the existence of a community plugin ("Node ID on
// click") whose entire purpose is filling that gap. So this is frame-level
// identity, not layer-level selection. Naming it `frameNodeId` (not
// `selectedNodeId` or `nodeId`) is deliberate, so nothing downstream reads
// it as "the specific component the user selected." A screenshot carries
// the visual detail this can't; Figma's own MCP (file key + node id) is the
// path to deeper, layer-level content if that's ever wanted.

export interface FigmaIdentity {
  readonly source: "figma";
  readonly fileKey: string;
  /** Colon form (`123:456`), matching what Figma's REST API/MCP tooling
   * expects — the URL itself encodes colons as hyphens. Identifies the
   * top-level frame the user is working in, NOT their specific layer
   * selection (see the epistemic-status note above). `null` when the URL
   * carries no frame context at all (e.g. the file's root/landing view). */
  readonly frameNodeId: string | null;
  readonly fileName: string | null;
}

export interface NotionIdentity {
  readonly source: "notion";
  /** Canonical hyphenated 8-4-4-4-12 form. */
  readonly pageId: string;
}

export type ThirdPartySourceIdentity = FigmaIdentity | NotionIdentity;

const FIGMA_HOSTS: ReadonlySet<string> = new Set(["figma.com", "www.figma.com"]);
const FIGMA_FILE_PATH_PATTERN = /^\/(?:file|design)\/([^/]+)(?:\/([^/]+))?/;

const NOTION_HOSTS: ReadonlySet<string> = new Set(["notion.so", "www.notion.so"]);
const NOTION_PAGE_ID_PATTERN = /([0-9a-fA-F]{32})$/;

function slugToTitle(slug: string): string {
  return decodeURIComponent(slug).replace(/-/g, " ").trim();
}

export function parseFigmaIdentity(url: string): FigmaIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!FIGMA_HOSTS.has(parsed.hostname)) return null;

  const match = FIGMA_FILE_PATH_PATTERN.exec(parsed.pathname);
  if (!match) return null;
  const fileKey = match[1];
  if (!fileKey) return null;
  const titleSlug = match[2];

  const rawFrameNodeId = parsed.searchParams.get("node-id");
  const frameNodeId = rawFrameNodeId ? rawFrameNodeId.replace(/-/g, ":") : null;

  return {
    source: "figma",
    fileKey,
    frameNodeId,
    fileName: titleSlug ? slugToTitle(titleSlug) : null,
  };
}

export function parseNotionIdentity(url: string): NotionIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!NOTION_HOSTS.has(parsed.hostname)) return null;

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const lastSegment = segments.at(-1);
  if (!lastSegment) return null;

  const match = NOTION_PAGE_ID_PATTERN.exec(lastSegment);
  if (!match) return null;
  const rawId = match[1]!.toLowerCase();

  const pageId = [
    rawId.slice(0, 8),
    rawId.slice(8, 12),
    rawId.slice(12, 16),
    rawId.slice(16, 20),
    rawId.slice(20, 32),
  ].join("-");

  return { source: "notion", pageId };
}

export function parseThirdPartySourceIdentity(url: string): ThirdPartySourceIdentity | null {
  return parseFigmaIdentity(url) ?? parseNotionIdentity(url);
}
