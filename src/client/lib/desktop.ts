const DESKTOP_LAUNCHER_QUERY = 'launcher';

type AgentId = 'claude' | 'codex';

interface AgentIntegrationStatus {
  readonly binaryPath: string | null;
  readonly skillInstalled: boolean;
}

export interface IntegrationStatus {
  readonly bridgePath: string | null;
  readonly bridgeOnPath: boolean;
  readonly ffmpeg: boolean;
  readonly ffprobe: boolean;
  readonly agents: Readonly<Record<AgentId, AgentIntegrationStatus>>;
}

export interface RecentProject {
  readonly path: string;
  readonly name: string;
  readonly parentDir: string;
  readonly openedAt: string;
  readonly durationS: number | null;
  readonly aspectRatio: string | null;
  readonly hasPreview: boolean;
  readonly hasFinal: boolean;
  readonly thumbnailDataUrl: string | null;
}

export interface LauncherState {
  readonly appVersion: string;
  readonly recentProjects: readonly RecentProject[];
  readonly integration: IntegrationStatus;
}

interface IntegrationInstallResult {
  readonly installedSkills: readonly AgentId[];
  readonly bridgePath: string;
  readonly integration: IntegrationStatus;
}

export interface DesktopBridge {
  readonly getLauncherState: () => Promise<LauncherState>;
  readonly chooseProject: () => Promise<string | null>;
  readonly createProject: () => Promise<string | null>;
  readonly openProject: (projectDir: string) => Promise<{ readonly accepted: boolean }>;
  readonly installIntegration: () => Promise<IntegrationInstallResult>;
  readonly copyText: (value: string) => Promise<void>;
  readonly chooseDirectory: (options: {
    readonly title: string;
    readonly defaultPath?: string;
  }) => Promise<string | null>;
  readonly revealExternalPath: (path: string) => Promise<void>;
  readonly revealUserData: (kind: 'config' | 'library') => Promise<void>;
  readonly showHome: () => Promise<void>;
  readonly onOpenProjectRequest: (listener: () => void) => () => void;
  readonly onShowHomeRequest: (listener: () => void) => () => void;
  /** Persist now: an update is about to swap the application bundle. */
  readonly onFlushSaveRequest: (listener: () => Promise<unknown>) => () => void;
}

declare global {
  interface Window {
    readonly leadzyDesktop?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | null {
  return typeof window === 'undefined' ? null : (window.leadzyDesktop ?? null);
}

export function isLauncherMode(
  search = typeof window === 'undefined' ? '' : window.location.search,
  bridge = desktopBridge(),
): boolean {
  return bridge !== null && new URLSearchParams(search).has(DESKTOP_LAUNCHER_QUERY);
}

export async function copyTextToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch (cause) {
    const bridge = desktopBridge();
    if (bridge !== null) {
      await bridge.copyText(value);
      return;
    }
    throw cause;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildAgentSetupPrompt(projectDir: string, integration: IntegrationStatus): string {
  const bridge = integration.bridgePath ?? 'studio';
  return [
    "Let's prepare this creative in Leadzy Studio before the first edit.",
    '',
    `Project: ${projectDir}`,
    '',
    '1. Read CLAUDE.md or AGENTS.md and edit/agent/leadzy-studio.md in full.',
    `2. Run \`${shellQuote(bridge)} status ${shellQuote(projectDir)}\` and \`${shellQuote(bridge)} validate ${shellQuote(projectDir)}\` before changing anything.`,
    '3. Ask about the video format, audience, goal, pacing, visual identity, and recurring CTAs.',
    '4. With those answers, set up a reusable starting point for cuts, captions, overlays, audio, and the outro.',
    '5. Preserve the original media. Apply changes only through the Studio contract, validate again, and render a short preview for review.',
    '',
    'At the end, summarize the template you defined and leave simple instructions for the next edits.',
  ].join('\n');
}
