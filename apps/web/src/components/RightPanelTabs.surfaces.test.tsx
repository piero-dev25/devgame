import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { RightPanelTabs } from "./RightPanelTabs";

const noop = () => undefined;

function renderTabs(surfaces: readonly RightPanelSurface[], activeSurfaceId: string | null) {
  return renderToStaticMarkup(
    <RightPanelTabs
      mode="inline"
      surfaces={surfaces}
      environmentId={null}
      activeSurfaceId={activeSurfaceId}
      pendingSurfaceIds={new Set()}
      onActivate={noop}
      onCloseSurface={noop}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddAgents={noop}
      onAddDevice={noop}
      browserAvailable
      terminalAvailable
      diffAvailable
      filesAvailable
      pullRequestAvailable={false}
      pullRequestsAvailable
      agentsAvailable
      deviceAvailable
      liveAgentCount={0}
    >
      <div>surface content</div>
    </RightPanelTabs>,
  );
}

describe("RightPanelTabs in the DevGame dock", () => {
  it("renders a tab for each surface the right panel still owns", () => {
    const html = renderTabs(
      [
        { id: "agents", kind: "agents" },
        { id: "pull-requests", kind: "pull-requests" },
        {
          id: "device:nucbox:emulator-5580",
          kind: "device",
          target: {
            hostId: "nucbox",
            deviceId: "emulator-5580",
            platform: "android",
            name: "Pixel",
          },
          title: "Android test",
        },
      ],
      "agents",
    );

    expect(html).toContain('aria-label="Close Agents"');
    expect(html).toContain('aria-label="Close Pull requests"');
    expect(html).toContain('aria-label="Close Android test"');
    expect(html).toContain("surface content");
  });

  it("keeps the dock-panel entry points in the empty-state launcher", () => {
    // Browser, Terminal, Files and Diff are dock panels, but the launcher
    // still offers them: its callbacks open the dock panel.
    const html = renderTabs([], null);

    expect(html).not.toContain("surface content");
    for (const label of ["Browser", "Terminal", "Files", "Diff", "Agents", "Device"]) {
      expect(html).toContain(`>${label}<`);
    }
  });
});
