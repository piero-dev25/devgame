import type {
  DiscoveredLocalServer,
  ProjectScript,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { openUrlInPreview } from "~/browser/openFileInPreview";

/**
 * Decides whether a just-started project script should auto-open the
 * preview panel, and at what URL — task P1-E ("wire the dead
 * autoOpenPreview field"). For a web project (three.js, Vite, etc.) there is
 * no editor to command the way Godot/Unity/Unreal have one; "Play" is
 * entirely "run the dev script, then show the preview pointed at it".
 *
 * `previewUrl` is REQUIRED, not discovered — matches the field's own doc
 * comment (`orchestration.ts`'s `ProjectScript.autoOpenPreview`: "Ignored
 * without `previewUrl`"). A script with `autoOpenPreview: true` and no
 * `previewUrl` is reachable only through a hand-edited devgame.json (the
 * ProjectScriptsControl.tsx form couples the two), and per that existing
 * doc comment it does nothing — this function returns `null` for it, same
 * as `autoOpenPreview: false`.
 *
 * What the port scanner (`PortDiscovery`, apps/server/src/preview/
 * PortScanner.ts, reached client-side via `useTerminalDiscoveredPorts`) DOES
 * gate is READINESS, not the URL: a dev server is never listening the
 * instant its command is written to the terminal, so this returns `null`
 * (keep waiting) until a server is discovered attributed — by PID, via the
 * scanner's own terminal-process registration — to the EXACT terminal this
 * script just ran in. Once that terminal has any listener, `previewUrl` is
 * what gets opened (not the scanner's own reported `url`, which can differ
 * slightly, e.g. a bumped port if the configured one was taken) — this is
 * the "prefer the explicit URL; the scanner is only for knowing when"
 * split. Never parses terminal stdout for a URL, which is what most tools
 * do and why "auto-open the dev server" breaks constantly elsewhere.
 */
export function resolveAutoOpenPreviewUrl(input: {
  readonly script: Pick<ProjectScript, "autoOpenPreview" | "previewUrl">;
  readonly discoveredServers: ReadonlyArray<DiscoveredLocalServer>;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}): string | null {
  if (!input.script.autoOpenPreview || !input.script.previewUrl) return null;
  const terminalHasAListener = input.discoveredServers.some(
    (server) =>
      server.terminal?.threadId === input.threadId &&
      server.terminal.terminalId === input.terminalId,
  );
  return terminalHasAListener ? input.script.previewUrl : null;
}

/**
 * The full effect, composed from `resolveAutoOpenPreviewUrl` above plus
 * `openUrlInPreview` (browser/openFileInPreview.ts — the same open+
 * openBrowser composition `addBrowserSurface.ts`/`openDiscoveredPort.ts`
 * use). Deliberately the ONE place that composition happens: the caller
 * (ChatView.tsx's watch effect) calls this on every new discovered-servers
 * snapshot rather than re-implementing "resolve, then maybe open" itself —
 * a test asserting this function's real effect on `useRightPanelStore`
 * therefore also proves the actual wiring ChatView uses, not a
 * reimplementation of it that could quietly drift out of sync.
 *
 * Returns whether it opened (so the caller knows to stop watching) rather
 * than throwing/silently swallowing a still-waiting result.
 */
export async function triggerAutoOpenPreview<E>(input: {
  readonly script: Pick<ProjectScript, "autoOpenPreview" | "previewUrl">;
  readonly discoveredServers: ReadonlyArray<DiscoveredLocalServer>;
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<boolean> {
  const url = resolveAutoOpenPreviewUrl({
    script: input.script,
    discoveredServers: input.discoveredServers,
    threadId: input.threadRef.threadId,
    terminalId: input.terminalId,
  });
  if (url === null) return false;
  await openUrlInPreview({ threadRef: input.threadRef, url, openPreview: input.openPreview });
  return true;
}
