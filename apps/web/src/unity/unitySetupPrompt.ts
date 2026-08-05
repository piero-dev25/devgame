/**
 * The text the `Setup Unity Integrations` CTA seeds as a new chat turn
 * (`.agents/skills/unity-setup/SKILL.md`'s own doc: "The user asking for
 * this (or clicking a 'Setup Unity Integrations' action whose whole label
 * is the task) is the consent — don't ask again").
 *
 * Deliberately a NUDGE, not a playbook — the diagnostic knowledge (which of
 * S1-S13 a project is in, what fixes each one) lives in that skill file, not
 * here. #114 (a separate MCP tool for this) was superseded by an owner
 * ruling: button-only, no MCP tool, no install step — the skill-matching
 * mechanism this text relies on already exists (the agent's own skill
 * system, matching a turn's text against each skill's `description:`
 * frontmatter). This text's only job is to say enough that `unity-setup`'s
 * trigger phrase ("asks to set up or fix the Unity integration") matches —
 * it does not, and must not, restate that skill's diagnostic content.
 */
export function buildUnitySetupIntegrationPrompt(): string {
  return "Diagnose and fix the Unity integration setup for this project.";
}
