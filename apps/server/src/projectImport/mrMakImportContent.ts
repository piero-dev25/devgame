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

/** The bytes a checkout writes for a blob whose attributes turn LF into CRLF. */
export interface CrlfCheckout {
  readonly sha256: string;
  readonly bytes: number;
  /** The blob holds a LF with no CR before it, so a checkout changes it. */
  readonly loneLf: boolean;
  /** The blob holds a CR or a NUL byte, which stops a `text=auto` conversion. */
  readonly crOrNul: boolean;
}

const makeCrlfHasher = () => {
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  let previous = -1;
  let loneLf = false;
  let crOrNul = false;
  return {
    update: (piece: Uint8Array) => {
      const out: Array<number> = [];
      for (const byte of piece) {
        if (byte === 10 && previous !== 13) {
          out.push(13);
          loneLf = true;
        }
        if (byte === 13 || byte === 0) crOrNul = true;
        out.push(byte);
        previous = byte;
      }
      bytes += out.length;
      hash.update(Uint8Array.from(out));
    },
    digest: (): CrlfCheckout => ({ sha256: hash.digest("hex"), bytes, loneLf, crOrNul }),
  };
};

/**
 * Parses `git cat-file --batch` output chunk by chunk into a sha256 per object,
 * plus its UTF-8 text for the oids in `keep` and the hash of its CRLF checkout
 * for the oids in `crlf`. Other blobs are never buffered.
 */
export const makeBatchParser = (
  keep: ReadonlySet<string>,
  crlf: ReadonlySet<string> = new Set(),
) => {
  const blobs = new Map<
    string,
    { sha256: string; text: string | null; crlf: CrlfCheckout | null }
  >();
  let header: Array<Uint8Array> = [];
  let oid = "";
  let remaining = -1;
  let skipNewline = false;
  let hash = NodeCrypto.createHash("sha256");
  let parts: Array<Uint8Array> | null = null;
  let crlfHasher: ReturnType<typeof makeCrlfHasher> | null = null;
  const finish = () => {
    blobs.set(oid, {
      sha256: hash.digest("hex"),
      text: parts === null ? null : Buffer.concat(parts).toString("utf8"),
      crlf: crlfHasher?.digest() ?? null,
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
        crlfHasher = crlf.has(oid) ? makeCrlfHasher() : null;
        if (remaining === 0) finish();
      } else {
        const piece = chunk.subarray(offset, offset + Math.min(remaining, chunk.length - offset));
        hash.update(piece);
        parts?.push(Uint8Array.from(piece));
        crlfHasher?.update(piece);
        remaining -= piece.length;
        offset += piece.length;
        if (remaining === 0) finish();
      }
    }
  };
  return { blobs, push };
};

const ATTRIBUTE_LINKS =
  /\b(src|href|poster|srcset|imagesrcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/**
 * HTML/SVG src, href, poster and srcset attributes (quoted or not), CSS url()
 * and markdown links (including `<...>` targets with spaces).
 */
export const extractHrefs = (path: string, text: string): Array<string> => {
  const hrefs: Array<string> = [];
  const add = (value: string | undefined) => {
    const href = value?.trim() ?? "";
    // Same-page anchors and bare queries point at nothing to import.
    if (href.length > 0 && !/^[#?]/.test(href)) hrefs.push(href);
  };
  for (const match of text.matchAll(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/g)) add(match[1]);
  if (/\.(html?|svg)$/i.test(path)) {
    for (const [, name = "", ...values] of text.matchAll(ATTRIBUTE_LINKS)) {
      const value = values.find((candidate) => candidate !== undefined) ?? "";
      if (!name.toLowerCase().endsWith("srcset")) add(value);
      // "a.png 1x, b.png 2x": each candidate's URL is its first token.
      else for (const candidate of value.split(",")) add(candidate.trim().split(/\s+/)[0]);
    }
  }
  if (/\.(md|markdown)$/i.test(path)) {
    for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^)\s]+))[^)]*\)/g)) {
      add(match[1] ?? match[2]);
    }
  }
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

const MAX_SYMLINK_HOPS = 40;

/**
 * Follow a committed symlink through the HEAD tree, component by component, the
 * way the filesystem would: every committed symlink met on the way is followed
 * too. Returns the repository-relative target, or null when a link is absolute,
 * the chain loops, or any named step leaves `root` (climbing through the root's
 * own ancestors is fine; they exist at the destination too).
 */
export const resolveSymlink = (
  path: string,
  root: string,
  linkTargets: ReadonlyMap<string, string>,
): string | null => {
  const inRoot = (candidate: string) => candidate === root || candidate.startsWith(`${root}/`);
  const stack = posix
    .dirname(path)
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  const queue: Array<string> = [];
  let next: string | undefined = linkTargets.get(path) ?? "";
  let hops = 0;
  while (next !== undefined || queue.length > 0) {
    if (next !== undefined) {
      if (posix.isAbsolute(next) || ++hops > MAX_SYMLINK_HOPS) return null;
      queue.unshift(...next.split("/"));
      next = undefined;
      continue;
    }
    const segment = queue.shift() ?? "";
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
    const current = stack.join("/");
    if (!inRoot(current) && !root.startsWith(`${current}/`)) return null;
    next = linkTargets.get(current);
    if (next !== undefined) stack.pop();
  }
  const resolved = stack.join("/");
  return inRoot(resolved) ? resolved : null;
};

const TOML_KEY = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*/;

/** A dotted TOML key (`a."b.c".d`) as its parts; stops at the first thing that is not a key. */
const tomlKeyParts = (key: string): Array<string> => {
  const parts: Array<string> = [];
  let rest = key;
  for (let match = TOML_KEY.exec(rest); match; match = TOML_KEY.exec(rest)) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
    rest = rest.slice(match[0].length);
    if (!rest.startsWith(".")) break;
    rest = rest.slice(1);
  }
  return parts;
};

/** Key names of an inline table (`{ A = "x", "B" = 'y' }`); values are skipped, never kept. */
const inlineTableKeys = (value: string): Array<string> => {
  const keys: Array<string> = [];
  let index = value.indexOf("{") + 1;
  let expectKey = true;
  while (index > 0 && index < value.length) {
    const char = value[index] ?? "";
    if (expectKey) {
      const match = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=/.exec(
        value.slice(index),
      );
      if (!match) break;
      keys.push(match[1] ?? match[2] ?? match[3] ?? "");
      index += match[0].length;
      expectKey = false;
    } else if (char === '"' || char === "'") {
      index++;
      while (index < value.length && value[index] !== char) {
        index += char === '"' && value[index] === "\\" ? 2 : 1;
      }
      index++;
    } else if (char === "}") {
      break;
    } else {
      if (char === ",") expectKey = true;
      index++;
    }
  }
  return keys;
};

/**
 * `[mcp_servers.<name>]` tables of a Codex config, each with the names of the
 * env vars it sets (`[mcp_servers.<name>.env]`, `env = {...}`, `env.KEY = ...`)
 * or passes through (`env_vars = [...]`). Values are never kept.
 */
const codexMcpServers = (text: string) => {
  const servers = new Map<string, Set<string>>();
  let keys: Set<string> | null = null;
  let inEnv = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*(\[\[?)([^[\]]+)\]/.exec(line);
    if (header) {
      const [table, name, ...rest] = tomlKeyParts(header[2] ?? "");
      keys = null;
      if (header[1] === "[" && table === "mcp_servers" && name !== undefined) {
        keys = servers.get(name) ?? new Set();
        servers.set(name, keys);
        inEnv = rest.length === 1 && rest[0] === "env";
      }
      continue;
    }
    const assignment = /^\s*([^=#]+?)\s*=(.*)$/.exec(line);
    if (keys === null || !assignment) continue;
    const [first, second, ...more] = tomlKeyParts(assignment[1] ?? "");
    const value = assignment[2] ?? "";
    if (inEnv) {
      if (first !== undefined) keys.add(first);
    } else if (first === "env" && second !== undefined && more.length === 0) {
      keys.add(second);
    } else if (first === "env" && second === undefined) {
      for (const key of inlineTableKeys(value)) keys.add(key);
    } else if (first === "env_vars" && second === undefined) {
      for (const match of value.matchAll(/"([^"]*)"|'([^']*)'/g)) {
        keys.add(match[1] ?? match[2] ?? "");
      }
    }
  }
  return servers;
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
    const servers = codexMcpServers(text);
    return servers.size > 0
      ? [...servers].map(([name, keys]) => ({
          source: path,
          kind: "mcp-server",
          name,
          keys: [...keys],
        }))
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
