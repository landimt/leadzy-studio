import { describe, expect, it } from 'vitest';
import { buildAgentSetupPrompt, isLauncherMode, type IntegrationStatus } from './desktop.js';

const integration: IntegrationStatus = {
  bridgePath: '/Users/editor/.local/bin/studio',
  bridgeOnPath: true,
  ffmpeg: true,
  ffprobe: true,
  agents: {
    claude: { binaryPath: '/opt/homebrew/bin/claude', skillInstalled: true },
    codex: { binaryPath: null, skillInstalled: false },
  },
};

describe('desktop launcher helpers', () => {
  it('only enables launcher mode when both the bridge and query are present', () => {
    const bridge = {} as never;
    expect(isLauncherMode('?launcher=1', bridge)).toBe(true);
    expect(isLauncherMode('', bridge)).toBe(false);
    expect(isLauncherMode('?launcher=1', null)).toBe(false);
  });

  it('builds an agent-first setup prompt around the selected project and bridge', () => {
    const prompt = buildAgentSetupPrompt('/Projects/Criativo CRM', integration);
    expect(prompt).toContain('Project: /Projects/Criativo CRM');
    expect(prompt).toContain("'/Users/editor/.local/bin/studio' status '/Projects/Criativo CRM'");
    expect(prompt).toContain('edit/agent/leadzy-studio.md');
    expect(prompt).toContain('Preserve the original media');
  });

  it('quotes apostrophes in paths used by the copied shell commands', () => {
    const prompt = buildAgentSetupPrompt("/Projects/Cliente d'Água", integration);
    expect(prompt).toContain("'/Projects/Cliente d'\"'\"'Água'");
  });
});
