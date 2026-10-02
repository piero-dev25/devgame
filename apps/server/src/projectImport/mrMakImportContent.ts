// @effect-diagnostics nodeBuiltinImport:off
/**
 * Pure helpers MrMakImport applies to committed blob content: hashing the
 * `cat-file --batch` stream, finding and resolving links, and reducing tool
 * configuration to sanitized requirement templates (names and keys, never
 * values).
 *
 * @module mrMakImportContent
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type { MrMakImportLink, MrMakImportRequirement } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Schema from "effect/Schema";

const posix = NodePath.posix;

const decodeMcpConfig = Schema.decodeUnknownOption(
  fromLenientJson(
    Schema.Struct({
      mcpServers: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Struct({ env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
        ),
      ),
    }),
  ),
);

/**
 * Parses `git cat-file --batch` output chunk by chunk into a sha256 per object,
 * plus its UTF-8 text for the oids in `keep`. Other blobs are never buffered.
 */
export const makeBatchParser = (keep: ReadonlySet<string>) => {
  const blobs = new Map<string, { sha256: string; text: string | null }>();
  let header: Array<Uint8Array> = [];
  let oid = "";
  let remaining = -1;
  let skipNewline = false;
  let hash = NodeCrypto.createHash("sha256");
  let parts: Array<Uint8Array> | null = null;
  const finish = () => {
    blobs.set(oid, {
      sha256: hash.digest("hex"),
      text: parts === null ? null : Buffer.concat(parts).toString("utf8"),
    });
    remaining = -1;
    skipNewline = true;
  };
  const push = (chunk: Uint8Array) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (skipNewline) {
        offset++;
        skipNewline = false;
      } else if (remaining < 0) {
        const newline = chunk.indexOf(10, offset);
        header.push(chunk.subarray(offset, newline === -1 ? chunk.length : newline));
        if (newline === -1) return;
        const line = Buffer.concat(header).toString("utf8");
        header = [];
        offset = newline + 1;
        const match = /^([0-9a-f]+) \S+ (\d+)$/.exec(line);
        if (!match) continue; // "<oid> missing": the caller sees it absent from `blobs`
        oid = match[1] ?? "";
        remaining = Number(match[2]);
        hash = NodeCrypto.createHash("sha256");
        parts = keep.has(oid) ? [] : null;
        if (remaining === 0) finish();
      } else {
        const piece = chunk.subarray(offset, offset + Math.min(remaining, chunk.length - offset));
        hash.update(piece);
        parts?.push(Uint8Array.from(piece));
        remaining -= piece.length;
        offset += piece.length;
        if (remaining === 0) finish();
      }
    }
  };
  return { blobs, push };
};

/** HTML/SVG src, href and poster attributes, CSS url() and markdown links, in file order. */
export const extractHrefs = (path: string, text: string): Array<string> => {
  const hrefs: Array<string> = [];
  const collect = (pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      const href = match[1]?.trim() ?? "";
      // Same-page anchors and bare queries point at nothing to import.
      if (href.length > 0 && !/^[#?]/.test(href)) hrefs.push(href);
    }
  };
  collect(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/g);
  if (/\.(html?|svg)$/i.test(path)) collect(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/g);
  if (/\.(md|markdown)$/i.test(path)) collect(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g);
  return [...new Set(hrefs)];
};

/**
 * Resolve a link from a repository-relative file against the committed tree.
 * `withinDirectory` narrows what counts as an escape (registry steps must stay
 * inside `workspace/`).
 */
export const resolveLink = (
  from: string,
  href: string,
  context: { readonly included: ReadonlySet<string>; readonly head: ReadonlySet<string> },
  withinDirectory = "",
): MrMakImportLink => {
  const unresolved = (status: MrMakImportLink["status"]) => ({ href, resolved: null, status });
  if (/^[a-z]:[\\/]/i.test(href) || href.includes("\\") || /\$\{|\{\{|<%/.test(href)) {
    return unresolved("malformed");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return unresolved("external");
  let target = href.replace(/[?#].*$/, "");
  try {
    target = decodeURIComponent(target);
  } catch {
    return unresolved("malformed");
  }
  const resolved = posix.normalize(posix.join(posix.dirname(from), target)).replace(/\/$/, "");
  const outside = (base: string) =>
    base === ""
      ? resolved === ".." || resolved.startsWith("../")
      : resolved !== base && !resolved.startsWith(`${base}/`);
  if (outside(withinDirectory) || outside("")) return unresolved("escape");
  const isDirectoryOf = (set: ReadonlySet<string>) =>
    [...set].some((path) => path.startsWith(`${resolved}/`));
  if (context.included.has(resolved) || isDirectoryOf(context.included)) {
    return { href, resolved, status: "resolved" };
  }
  if (context.head.has(resolved) || isDirectoryOf(context.head)) {
    return { href, resolved, status: "not-selected" };
  }
  return { href, resolved, status: "missing" };
};

/** `.mcp.json`, `.codex/config.toml`, `.env.example` or `SKILL.md`, reduced to names and keys. */
export const requirementsFrom = (path: string, text: string): Array<MrMakImportRequirement> => {
  const names = (pattern: RegExp) => [...text.matchAll(pattern)].flatMap((m) => m[1] ?? []);
  if (path.endsWith(".mcp.json")) {
    const config = decodeMcpConfig(text);
    // Env var names only; commands, args and values stay behind.
    const servers = config._tag === "Some" ? (config.value.mcpServers ?? {}) : {};
    const rows = Object.entries(servers).map(([name, server]) => ({
      source: path,
      kind: "mcp-server" as const,
      name,
      keys: Object.keys(server.env ?? {}),
    }));
    return rows.length > 0 ? rows : [{ source: path, kind: "mcp-config", name: path, keys: [] }];
  }
  if (path.endsWith(".toml")) {
    const servers = names(/^\s*\[mcp_servers\.([^\]]+)\]/gm);
    return servers.length > 0
      ? servers.map((name) => ({ source: path, kind: "mcp-server", name, keys: [] }))
      : [{ source: path, kind: "mcp-config", name: path, keys: names(/^\s*([\w.-]+)\s*=/gm) }];
  }
  if (path.endsWith(".env.example")) {
    return names(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm).map((name) => ({
      source: path,
      kind: "env-var",
      name,
      keys: [],
    }));
  }
  // SKILL.md: frontmatter key names only, never their values.
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const keys = [...frontmatter.matchAll(/^([\w-]+):/gm)].flatMap((match) => match[1] ?? []);
  return [{ source: path, kind: "skill", name: path.split("/")[2] ?? path, keys }];
};
