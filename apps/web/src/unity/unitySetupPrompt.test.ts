import { describe, expect, it } from "vite-plus/test";

import { buildUnitySetupIntegrationPrompt } from "./unitySetupPrompt";

describe("buildUnitySetupIntegrationPrompt", () => {
  it("is a short nudge, not a playbook — no diagnostic content inlined", () => {
    const prompt = buildUnitySetupIntegrationPrompt();

    expect(prompt).toBe("Diagnose and fix the Unity integration setup for this project.");
    // "Short" is the actual requirement (per the build task: "a nudge, not a
    // playbook") — this is what would catch someone inlining the skill's
    // own diagnostic steps here instead of leaving that to the agent's
    // skill/MCP-tool lookup.
    expect(prompt.length).toBeLessThan(120);
  });
});
