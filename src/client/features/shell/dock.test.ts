import { describe, expect, it } from 'vitest';
import {
  activatePanel,
  areaOf,
  DEFAULT_DOCK_LAYOUT,
  DOCK_PRESET_LAYOUT,
  type DockLayout,
  DOCK_PANELS,
  isPanelActive,
  matchingPreset,
  moveTab,
  moveTabToArea,
  parseDockLayout,
  serializeDockLayout,
} from './dock.js';

describe('activatePanel', () => {
  it('activates a tab inside its own area and leaves the other areas alone', () => {
    const next = activatePanel(DEFAULT_DOCK_LAYOUT, 'cuts');

    expect(next.side).toEqual({ tabs: ['inspector', 'cuts'], active: 'cuts' });
    expect(next.workspace).toBe(DEFAULT_DOCK_LAYOUT.workspace);
    expect(next.left).toBe(DEFAULT_DOCK_LAYOUT.left);
    expect(isPanelActive(next, 'cuts')).toBe(true);
    expect(isPanelActive(next, 'inspector')).toBe(false);
  });

  it('returns the same layout when the tab is already active', () => {
    expect(activatePanel(DEFAULT_DOCK_LAYOUT, 'transcript')).toBe(DEFAULT_DOCK_LAYOUT);
  });
});

describe('moveTab', () => {
  it('moves a tab across areas, activates it there and shows a neighbour where it left', () => {
    const next = moveTab(DEFAULT_DOCK_LAYOUT, 'transcript', 'side', 1);

    expect(next.workspace).toEqual({ tabs: ['media', 'library', 'effects'], active: 'media' });
    expect(next.side).toEqual({ tabs: ['inspector', 'transcript', 'cuts'], active: 'transcript' });
    expect(areaOf(next, 'transcript')).toBe('side');
  });

  it('falls back to the left neighbour when the moved tab was the last one', () => {
    const next = moveTab(activatePanel(DEFAULT_DOCK_LAYOUT, 'effects'), 'effects', 'side', 0);

    expect(next.workspace.active).toBe('library');
    expect(next.side.tabs).toEqual(['effects', 'inspector', 'cuts']);
  });

  it('keeps the source active tab when a different tab leaves', () => {
    expect(moveTab(DEFAULT_DOCK_LAYOUT, 'effects', 'side', 0).workspace.active).toBe('transcript');
  });

  it('empties an area with no active tab when its only tab moves out — the player and the timeline included', () => {
    const next = moveTab(
      moveTab(DEFAULT_DOCK_LAYOUT, 'player', 'workspace', 0),
      'timeline',
      'side',
      99,
    );

    expect(next.left).toEqual({ tabs: [], active: null });
    expect(next.bottom).toEqual({ tabs: [], active: null });
    expect(next.workspace.tabs[0]).toBe('player');
    expect(next.side).toEqual({ tabs: ['inspector', 'cuts', 'timeline'], active: 'timeline' });
  });

  it('reorders inside the same area and clamps the index', () => {
    expect(moveTab(DEFAULT_DOCK_LAYOUT, 'effects', 'workspace', 0).workspace).toEqual({
      tabs: ['effects', 'transcript', 'media', 'library'],
      active: 'effects',
    });
    expect(moveTab(DEFAULT_DOCK_LAYOUT, 'transcript', 'workspace', -5).workspace.tabs[0]).toBe(
      'transcript',
    );
    expect(moveTab(DEFAULT_DOCK_LAYOUT, 'transcript', 'workspace', 99).workspace.tabs.at(-1)).toBe(
      'transcript',
    );
  });

  it('moveTabToArea appends to the chosen area', () => {
    const next = moveTabToArea(DEFAULT_DOCK_LAYOUT, 'cuts', 'bottom');

    expect(next.bottom).toEqual({ tabs: ['timeline', 'cuts'], active: 'cuts' });
    expect(next.side).toEqual({ tabs: ['inspector'], active: 'inspector' });
  });
});

describe('parseDockLayout', () => {
  it('round-trips a serialized layout', () => {
    const moved = moveTab(DEFAULT_DOCK_LAYOUT, 'cuts', 'workspace', 0);

    expect(parseDockLayout(serializeDockLayout(moved))).toEqual(moved);
  });

  it.each([
    ['nothing stored', null],
    ['broken JSON', '{"workspace":'],
    ['a non-object', '"tabs"'],
  ])('falls back to the default layout on %s', (_label, raw) => {
    expect(parseDockLayout(raw)).toEqual(DEFAULT_DOCK_LAYOUT);
  });

  it('drops unknown tabs, keeps the first copy of a duplicate, and returns missing panels to their default area', () => {
    const raw = JSON.stringify({
      workspace: { tabs: ['media', 'ghost', 'media'], active: 'media' },
      side: { tabs: ['media', 'cuts'], active: 'cuts' },
    });

    expect(parseDockLayout(raw)).toEqual({
      left: { tabs: ['player'], active: 'player' },
      workspace: { tabs: ['media', 'transcript', 'library', 'effects'], active: 'media' },
      bottom: { tabs: ['timeline'], active: 'timeline' },
      side: { tabs: ['cuts', 'inspector'], active: 'cuts' },
    });
  });

  it('replaces an active tab that is not in its area with the first tab, and accepts an empty area', () => {
    const raw = JSON.stringify({
      left: { tabs: [], active: 'player' },
      workspace: {
        tabs: ['player', 'transcript', 'media', 'library', 'effects', 'cuts', 'inspector'],
        active: 'cuts',
      },
      bottom: { tabs: ['timeline'], active: 'timeline' },
      side: { tabs: [], active: 'inspector' },
    });

    const layout: DockLayout = parseDockLayout(raw);

    expect(layout.workspace.active).toBe('cuts');
    expect(layout.left).toEqual({ tabs: [], active: null });
    expect(layout.side).toEqual({ tabs: [], active: null });
  });
});

describe('dock presets', () => {
  it('every preset places every panel exactly once', () => {
    for (const layout of Object.values(DOCK_PRESET_LAYOUT)) {
      const placed = [layout.left, layout.workspace, layout.bottom, layout.side].flatMap(
        (area) => area.tabs,
      );
      expect([...placed].sort()).toEqual([...DOCK_PANELS].sort());
    }
  });

  it('recognises the preset a layout matches, ignoring which tab is active', () => {
    expect(matchingPreset(DEFAULT_DOCK_LAYOUT)).toBe('default');
    expect(matchingPreset(activatePanel(DOCK_PRESET_LAYOUT.landscape, 'cuts'))).toBe('landscape');
    expect(matchingPreset(moveTab(DEFAULT_DOCK_LAYOUT, 'cuts', 'bottom', 0))).toBeNull();
  });
});

describe('compact workspace', () => {
  it('keeps all tools reachable beside the preview and survives persistence', () => {
    const compact = activatePanel(DOCK_PRESET_LAYOUT.compact, 'effects');
    const restored = parseDockLayout(serializeDockLayout(compact));
    expect(restored.left.tabs).toEqual(['player']);
    expect(restored.bottom.tabs).toEqual(['timeline']);
    expect(restored.side.tabs).toEqual([]);
    expect(restored.workspace.active).toBe('effects');
    expect(matchingPreset(restored)).toBe('compact');
    for (const panel of [
      'inspector',
      'cuts',
      'effects',
      'transcript',
      'media',
      'library',
    ] as const) {
      expect(isPanelActive(activatePanel(restored, panel), panel)).toBe(true);
    }
  });
});
