import { access, cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { installationRoot } from '../core/installation.js';
import {
  findExecutable,
  executablePathDirectories,
  type ExecutableLookupOptions,
} from '../application/executable.js';

const AGENT_IDS = ['claude', 'codex'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentIntegrationStatus {
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

type ReadinessOptions = ExecutableLookupOptions;

interface SkillInstallOptions {
  readonly homeDir?: string;
  readonly sourceDir?: string;
  readonly targets?: readonly AgentId[];
}

export async function integrationReadiness(
  options: ReadinessOptions = {},
): Promise<IntegrationStatus> {
  const home = options.homeDir ?? homedir();
  const [bridgePath, ffmpegPath, ffprobePath, claudePath, codexPath] = await Promise.all([
    findExecutable('studio', options),
    findExecutable('ffmpeg', options),
    findExecutable('ffprobe', options),
    findExecutable('claude', options),
    findExecutable('codex', options),
  ]);
  const installedSkills = await Promise.all(
    AGENT_IDS.map((agent) =>
      access(join(home, `.${agent}`, 'skills', 'leadzy-studio', 'SKILL.md')).then(
        () => true,
        () => false,
      ),
    ),
  );
  const normalizeDirectory = (directory: string): string => {
    const absolute = resolve(directory);
    return (options.platform ?? process.platform) === 'win32' ? absolute.toLowerCase() : absolute;
  };
  return {
    bridgePath,
    bridgeOnPath:
      bridgePath !== null &&
      executablePathDirectories(options).some(
        (directory) => normalizeDirectory(directory) === normalizeDirectory(dirname(bridgePath)),
      ),
    ffmpeg: ffmpegPath !== null,
    ffprobe: ffprobePath !== null,
    agents: {
      claude: { binaryPath: claudePath, skillInstalled: installedSkills[0] ?? false },
      codex: { binaryPath: codexPath, skillInstalled: installedSkills[1] ?? false },
    },
  };
}

function bundledSkillSource(): string {
  const root = installationRoot(import.meta.url, 2);
  return process.env.LEADZY_STUDIO_ROOT
    ? join(root, 'skills', 'leadzy-studio')
    : join(root, '.claude', 'skills', 'leadzy-studio');
}

export async function installAgentSkills(
  options: SkillInstallOptions = {},
): Promise<readonly AgentId[]> {
  const home = options.homeDir ?? homedir();
  const source = options.sourceDir ?? bundledSkillSource();
  await access(join(source, 'SKILL.md'));
  const targets = options.targets ?? AGENT_IDS;
  const installed: AgentId[] = [];
  for (const agent of targets) {
    const destination = join(home, `.${agent}`, 'skills', 'leadzy-studio');
    await mkdir(join(home, `.${agent}`, 'skills'), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
    installed.push(agent);
  }
  return installed;
}
