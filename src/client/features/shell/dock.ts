/**
 * The editor's dockable panels: four areas — the column next to the player,
 * the workspace, the strip under it and the side column — each holding an
 * ordered set of tabs with one active. Any tab can live in any area; an
 * area with no tabs collapses. Pure — the store owns the layout, the dock
 * components render it.
 */
export const DOCK_PANELS = [
  'player',
  'transcript',
  'media',
  'library',
  'effects',
  'timeline',
  'cuts',
  'inspector',
] as const;
export type DockPanelId = (typeof DOCK_PANELS)[number];

export const DOCK_AREAS = ['left', 'workspace', 'bottom', 'side'] as const;
export type DockAreaId = (typeof DOCK_AREAS)[number];

export interface DockArea {
  readonly tabs: readonly DockPanelId[];
  readonly active: DockPanelId | null;
}

export type DockLayout = Readonly<Record<DockAreaId, DockArea>>;

const DEFAULT_AREA: Readonly<Record<DockPanelId, DockAreaId>> = {
  player: 'left',
  transcript: 'workspace',
  media: 'workspace',
  library: 'workspace',
  effects: 'workspace',
  timeline: 'bottom',
  cuts: 'side',
  inspector: 'side',
};

export const DEFAULT_DOCK_LAYOUT: DockLayout = {
  left: { tabs: ['player'], active: 'player' },
  workspace: { tabs: ['transcript', 'media', 'library', 'effects'], active: 'transcript' },
  bottom: { tabs: ['timeline'], active: 'timeline' },
  side: { tabs: ['inspector', 'cuts'], active: 'inspector' },
};

/** Named arrangements the Exibir menu offers; the default is the first. */
export const DOCK_PRESETS = ['default', 'compact', 'vertical', 'landscape'] as const;
export type DockPresetId = (typeof DOCK_PRESETS)[number];

export const DOCK_PRESET_LAYOUT: Readonly<Record<DockPresetId, DockLayout>> = {
  default: DEFAULT_DOCK_LAYOUT,
  compact: {
    left: { tabs: ['player'], active: 'player' },
    workspace: {
      tabs: ['inspector', 'cuts', 'effects', 'transcript', 'media', 'library'],
      active: 'inspector',
    },
    bottom: { tabs: ['timeline'], active: 'timeline' },
    side: { tabs: [], active: null },
  },
  /** The video tall on the left, words and timeline in the middle, everything else on the right. */
  vertical: {
    left: { tabs: ['player'], active: 'player' },
    workspace: { tabs: ['transcript', 'media', 'library'], active: 'transcript' },
    bottom: { tabs: ['timeline'], active: 'timeline' },
    side: { tabs: ['inspector', 'effects', 'cuts'], active: 'inspector' },
  },
  /** The video in the centre like a landscape suite: sources on the left, tools on the right. */
  landscape: {
    left: { tabs: ['library', 'transcript', 'media'], active: 'transcript' },
    workspace: { tabs: ['player'], active: 'player' },
    bottom: { tabs: ['timeline'], active: 'timeline' },
    side: { tabs: ['inspector', 'cuts', 'effects'], active: 'inspector' },
  },
};

/** Same tabs in the same areas and order — the active tabs do not count. */
export function sameArrangement(a: DockLayout, b: DockLayout): boolean {
  return DOCK_AREAS.every(
    (area) =>
      a[area].tabs.length === b[area].tabs.length &&
      a[area].tabs.every((tab, index) => tab === b[area].tabs[index]),
  );
}

/** The preset the layout currently matches, if any. */
export function matchingPreset(layout: DockLayout): DockPresetId | null {
  return DOCK_PRESETS.find((preset) => sameArrangement(layout, DOCK_PRESET_LAYOUT[preset])) ?? null;
}

export function areaOf(layout: DockLayout, panel: DockPanelId): DockAreaId {
  return DOCK_AREAS.find((area) => layout[area].tabs.includes(panel)) ?? DEFAULT_AREA[panel];
}

/** Visible right now: the active tab of the area it lives in. */
export function isPanelActive(layout: DockLayout, panel: DockPanelId): boolean {
  return layout[areaOf(layout, panel)].active === panel;
}

export function activatePanel(layout: DockLayout, panel: DockPanelId): DockLayout {
  const area = areaOf(layout, panel);
  if (layout[area].active === panel) return layout;
  return { ...layout, [area]: { ...layout[area], active: panel } };
}

/** The tab that takes over when `panel` leaves: its right neighbour, else its left, else none. */
function successorOf(tabs: readonly DockPanelId[], panel: DockPanelId): DockPanelId | null {
  const index = tabs.indexOf(panel);
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}

/**
 * Moves `panel` into `to` at `index` (clamped) and makes it the active tab
 * there. Within the same area this is a reorder. The area it leaves keeps
 * showing a neighbour so nothing goes blank behind the user's back.
 */
export function moveTab(
  layout: DockLayout,
  panel: DockPanelId,
  to: DockAreaId,
  index: number,
): DockLayout {
  const from = areaOf(layout, panel);
  const source = layout[from];
  const withoutPanel = source.tabs.filter((tab) => tab !== panel);
  const target = from === to ? withoutPanel : layout[to].tabs;
  const at = Math.max(0, Math.min(index, target.length));
  const inserted = [...target.slice(0, at), panel, ...target.slice(at)];
  if (from === to) {
    return { ...layout, [to]: { tabs: inserted, active: panel } };
  }
  const sourceActive = source.active === panel ? successorOf(source.tabs, panel) : source.active;
  return {
    ...layout,
    [from]: { tabs: withoutPanel, active: sourceActive },
    [to]: { tabs: inserted, active: panel },
  };
}

/** Sends `panel` to the end of `to` — the keyboard-only way to dock. */
export function moveTabToArea(layout: DockLayout, panel: DockPanelId, to: DockAreaId): DockLayout {
  return moveTab(layout, panel, to, layout[to].tabs.length);
}

function isPanelId(value: unknown): value is DockPanelId {
  return typeof value === 'string' && (DOCK_PANELS as readonly string[]).includes(value);
}

/**
 * Reads a persisted layout leniently: unknown tabs are dropped, duplicates
 * keep their first position, panels missing from every area return to their
 * default area, and an active tab that is not in its area is replaced.
 */
export function parseDockLayout(raw: string | null): DockLayout {
  if (raw === null) return DEFAULT_DOCK_LAYOUT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_DOCK_LAYOUT;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_DOCK_LAYOUT;
  const record = parsed as Partial<Record<DockAreaId, { tabs?: unknown; active?: unknown }>>;
  const seen = new Set<DockPanelId>();
  const tabs = {} as Record<DockAreaId, DockPanelId[]>;
  for (const area of DOCK_AREAS) {
    const stored = record[area]?.tabs;
    const kept: DockPanelId[] = [];
    for (const tab of Array.isArray(stored) ? stored : []) {
      if (!isPanelId(tab) || seen.has(tab)) continue;
      seen.add(tab);
      kept.push(tab);
    }
    tabs[area] = kept;
  }
  for (const panel of DOCK_PANELS) {
    if (!seen.has(panel)) tabs[DEFAULT_AREA[panel]].push(panel);
  }
  const layout = {} as Record<DockAreaId, DockArea>;
  for (const area of DOCK_AREAS) {
    const active = record[area]?.active;
    layout[area] = {
      tabs: tabs[area],
      active: isPanelId(active) && tabs[area].includes(active) ? active : (tabs[area][0] ?? null),
    };
  }
  return layout;
}

export function serializeDockLayout(layout: DockLayout): string {
  return JSON.stringify(layout);
}
