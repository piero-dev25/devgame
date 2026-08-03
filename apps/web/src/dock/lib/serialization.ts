// Ported verbatim (extension stripped) from gamedev-workbench's
// app/web/src/lib/layout/serialization.ts.
import type { SerializedDockview } from "dockview";

import { LAYOUT_SCHEMA_VERSION, type LayoutFile } from "./types";

export interface BuildLayoutFileParams {
  preset: string;
  dockviewJson: SerializedDockview;
  /** Injectable clock for tests; defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Builds the on-disk layout shape from a live `DockviewApi.toJSON()` result.
 * `dockviewJson` is stored verbatim and opaque; `floating` is a read-only
 * mirror of its `floatingGroups` for a human-legible persisted file — restore
 * never reads `floating` back, so it can't drift from the opaque blob and
 * become a second source of truth.
 */
export function buildLayoutFile({ preset, dockviewJson, now }: BuildLayoutFileParams): LayoutFile {
  const savedAt = (now ?? (() => new Date().toISOString()))();
  return {
    version: LAYOUT_SCHEMA_VERSION,
    preset,
    dockview: dockviewJson,
    floating: dockviewJson.floatingGroups ?? [],
    savedAt,
  };
}

export type ParseLayoutFailureReason = "invalid-json" | "invalid-shape" | "version-mismatch";

export type ParseLayoutResult =
  | { ok: true; file: LayoutFile }
  | { ok: false; reason: ParseLayoutFailureReason; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates a persisted-layout payload. Never throws — every
 * failure mode (unparseable JSON, wrong shape, a schema version this build
 * doesn't understand) is reported as a typed `{ok: false}` result so the
 * caller can fall back to the default preset ("never crash on a bad
 * layout").
 */
export function parseLayoutFile(raw: string): ParseLayoutResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json", message: "layout file is not valid JSON" };
  }
  return parseLayoutValue(parsed);
}

/**
 * The same validation as `parseLayoutFile`, over an already-parsed value
 * instead of a raw string — for a storage backend that hands back
 * already-`JSON.parse`d data (e.g. read off a fetched object rather than a
 * raw string), so it isn't forced to round-trip through `JSON.stringify`
 * just to re-parse it. Both callers share this one rule set rather than
 * keeping two copies of "what counts as a valid layout" in sync by hand.
 */
export function parseLayoutValue(parsed: unknown): ParseLayoutResult {
  if (!isRecord(parsed)) {
    return { ok: false, reason: "invalid-shape", message: "layout must be a JSON object" };
  }

  const { version, preset, dockview, floating, savedAt } = parsed;

  if (
    typeof preset !== "string" ||
    !isRecord(dockview) ||
    !Array.isArray(floating) ||
    typeof savedAt !== "string"
  ) {
    return {
      ok: false,
      reason: "invalid-shape",
      message: "layout is missing one of: preset, dockview, floating, savedAt",
    };
  }

  if (typeof version !== "number") {
    return { ok: false, reason: "invalid-shape", message: "layout is missing a numeric version" };
  }

  if (version !== LAYOUT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "version-mismatch",
      message: `layout is version ${version}, this build understands version ${LAYOUT_SCHEMA_VERSION}`,
    };
  }

  return {
    ok: true,
    file: {
      version,
      preset,
      dockview: dockview as unknown as SerializedDockview,
      floating: floating as LayoutFile["floating"],
      savedAt,
    },
  };
}

/**
 * Scans a dockview grid's flat panel map for panel ids whose
 * `contentComponent` isn't in the running catalog — a panel type the layout
 * references that no longer exists ("dropped with a notice", same quarantine
 * discipline as an unknown workspace panel type). Pure detection only;
 * rendering the quarantine card is the caller's job.
 */
export function findUnknownPanelIds(
  dockview: SerializedDockview,
  knownComponentIds: ReadonlySet<string>,
): string[] {
  const panels = dockview.panels ?? {};
  return Object.values(panels)
    .filter((panel) => !panel.contentComponent || !knownComponentIds.has(panel.contentComponent))
    .map((panel) => panel.id);
}
