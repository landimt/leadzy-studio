import type { DesktopBridge, LauncherState, RecentProject } from './desktop.js';

/** `?launcher=preview` in a plain browser: the Home with sample data, no Electron. */
export const LAUNCHER_PREVIEW_VALUE = 'preview';

export function isLauncherPreview(search: string): boolean {
  return new URLSearchParams(search).get('launcher') === LAUNCHER_PREVIEW_VALUE;
}

function thumbnail(from: string, to: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="270" height="480" viewBox="0 0 270 480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="270" height="480" fill="url(#g)"/><text x="135" y="256" text-anchor="middle" font-family="Inter, sans-serif" font-size="28" font-weight="600" fill="rgba(255,255,255,0.9)">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function daysAgo(days: number, hour: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, 12, 0, 0);
  return date.toISOString();
}

function project(
  name: string,
  parentDir: string,
  overrides: Partial<RecentProject> = {},
): RecentProject {
  return {
    path: `${parentDir}/${name}`,
    name,
    parentDir,
    openedAt: daysAgo(0, 10),
    durationS: 57.3,
    aspectRatio: '9:16',
    hasPreview: true,
    hasFinal: false,
    thumbnailDataUrl: thumbnail('#8e1b4e', '#e5388c', name),
    ...overrides,
  };
}

/** Realistic enough to judge layout: mixed states, long names, missing thumbnails. */
export function sampleLauncherState(): LauncherState {
  return {
    appVersion: '0.9.0-preview',
    recentProjects: [
      project('AP04', '~/Movies/Ads_202608', { hasFinal: true }),
      project('AP03 — depoimento da Carla sobre o atendimento', '~/Movies/Ads_202608', {
        openedAt: daysAgo(1, 18),
        durationS: 83.1,
        thumbnailDataUrl: thumbnail('#2a241f', '#7c5cff', 'AP03'),
      }),
      project('Tutorial extensão', '~/Movies/Tutoriais', {
        openedAt: daysAgo(3, 9),
        durationS: 312.4,
        aspectRatio: '16:9',
        hasPreview: false,
        thumbnailDataUrl: thumbnail('#17130f', '#f5764e', 'Tutorial'),
      }),
      project('Teste sem mídia', '~/Desktop', {
        openedAt: daysAgo(12, 15),
        durationS: null,
        aspectRatio: null,
        hasPreview: false,
        thumbnailDataUrl: null,
      }),
    ],
    integration: {
      bridgePath: '/usr/local/bin/leadzy',
      bridgeOnPath: true,
      ffmpeg: true,
      ffprobe: true,
      agents: {
        claude: { binaryPath: '/usr/local/bin/claude', skillInstalled: true },
        codex: { binaryPath: null, skillInstalled: false },
      },
    },
  };
}

/**
 * Stands in for the Electron bridge so the Home renders in a browser tab.
 * The folder pickers answer with the most recent sample project, so every
 * flow that starts from one (open, prepare with the agent) can be walked
 * through; revealing files is a no-op; opening a project goes to the
 * editor of the project this Studio already serves.
 */
export function previewDesktopBridge(state: LauncherState = sampleLauncherState()): DesktopBridge {
  const noSubscription = (): (() => void) => () => undefined;
  return {
    getLauncherState: () => Promise.resolve(state),
    chooseProject: () => Promise.resolve(state.recentProjects[0]?.path ?? null),
    createProject: () => Promise.resolve(state.recentProjects[0]?.path ?? null),
    openProject: () => {
      window.location.assign('/');
      return Promise.resolve({ accepted: true });
    },
    installIntegration: () =>
      Promise.resolve({
        installedSkills: ['claude', 'codex'],
        bridgePath: state.integration.bridgePath ?? '/usr/local/bin/leadzy',
        integration: {
          ...state.integration,
          agents: {
            claude: { binaryPath: '/usr/local/bin/claude', skillInstalled: true },
            codex: { binaryPath: '/usr/local/bin/codex', skillInstalled: true },
          },
        },
      }),
    copyText: (value) => navigator.clipboard.writeText(value),
    chooseDirectory: () => Promise.resolve(null),
    revealExternalPath: () => Promise.resolve(),
    revealUserData: () => Promise.resolve(),
    showHome: () => Promise.resolve(),
    onOpenProjectRequest: noSubscription,
    onShowHomeRequest: noSubscription,
    onFlushSaveRequest: noSubscription,
  };
}
