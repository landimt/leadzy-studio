import { describe, expect, it } from 'vitest';
import { isLauncherPreview, previewDesktopBridge, sampleLauncherState } from './desktopPreview.js';

describe('launcher preview', () => {
  it('is only the explicit preview flag — a bare ?launcher still needs the desktop', () => {
    expect(isLauncherPreview('?launcher=preview')).toBe(true);
    expect(isLauncherPreview('?launcher')).toBe(false);
    expect(isLauncherPreview('')).toBe(false);
  });

  it('samples every state the Home has to lay out', () => {
    const projects = sampleLauncherState().recentProjects;
    expect(projects.some((project) => project.thumbnailDataUrl === null)).toBe(true);
    expect(projects.some((project) => project.durationS === null)).toBe(true);
    expect(projects.some((project) => project.hasFinal)).toBe(true);
    expect(projects.some((project) => project.name.length > 30)).toBe(true);
  });

  it('lets the folder pickers pick the sample project and answers the rest as a cancellation', async () => {
    const bridge = previewDesktopBridge();
    await expect(bridge.chooseProject()).resolves.toBe('~/Movies/Ads_202608/AP04');
    await expect(bridge.chooseDirectory({ title: 'x' })).resolves.toBeNull();
    expect((await bridge.getLauncherState()).recentProjects).toHaveLength(4);
  });
});
