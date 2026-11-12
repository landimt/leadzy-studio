import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { integrationReadiness } from '../agentIntegration.js';
import { installationRoot } from '../../core/installation.js';
import {
  checkFfmpeg,
  hardwareDecoder,
  softwareDecodeForced,
} from '../../server/services/ffmpeg.js';

type DoctorStatus = 'ok' | 'warning' | 'error';

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly label: string;
  readonly message: string;
}

const execFileAsync = promisify(execFile);
const BRIDGE_TIMEOUT_MS = 15_000;
const WINDOWS_SHIM = /[.](cmd|bat)$/i;

/** The installed Studio version, read from the package manifest next to the CLI. */
export function studioVersion(): string {
  try {
    const manifest = readFileSync(
      join(installationRoot(import.meta.url, 3), 'package.json'),
      'utf8',
    );
    const parsed = JSON.parse(manifest) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export type BridgeProbe =
  { readonly ok: true; readonly version: string } | { readonly ok: false; readonly detail: string };

/**
 * A bridge script found on PATH is only proof that a file exists; the
 * Electron bridge once passed its own entry script as a positional argument
 * and every command failed. Run `--version` and compare.
 */
export async function probeBridge(
  bridgePath: string,
  expectedVersion: string,
  run: (path: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }> = (
    path,
    args,
  ) =>
    // A Windows bridge is a .cmd shim and Node refuses to spawn one directly;
    // quote the path, because it normally sits under the user's home folder.
    WINDOWS_SHIM.test(path)
      ? execFileAsync(`"${path}"`, [...args], {
          timeout: BRIDGE_TIMEOUT_MS,
          shell: true,
          windowsHide: true,
        })
      : execFileAsync(path, [...args], { timeout: BRIDGE_TIMEOUT_MS }),
): Promise<BridgeProbe> {
  try {
    const { stdout } = await run(bridgePath, ['--version']);
    const version = stdout.trim();
    if (version === expectedVersion) return { ok: true, version };
    return {
      ok: false,
      detail:
        version.length > 0
          ? `answers "${version}" to --version, this Studio is ${expectedVersion}`
          : 'prints nothing for --version',
    };
  } catch (cause) {
    const failure = typeof cause === 'object' && cause !== null ? cause : {};
    if ('killed' in failure && failure.killed === true) {
      return {
        ok: false,
        detail: `did not answer --version within ${String(BRIDGE_TIMEOUT_MS / 1000)}s`,
      };
    }
    const stderr = 'stderr' in failure ? String(failure.stderr).trim() : '';
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, detail: (stderr || message).split('\n')[0] ?? 'failed' };
  }
}

/** The `Studio CLI` line: missing is a warning, present-but-broken is an error the agent must not work through. */
export function bridgeCheck(bridgePath: string | null, probe: BridgeProbe | null): DoctorCheck {
  const label = 'Studio CLI';
  if (bridgePath === null || probe === null) {
    return {
      id: 'bridge',
      status: 'warning',
      label,
      message: 'global command missing; run make bridge or use the app installer',
    };
  }
  if (probe.ok) {
    return { id: 'bridge', status: 'ok', label, message: `${bridgePath} (${probe.version})` };
  }
  return {
    id: 'bridge',
    status: 'error',
    label,
    message: `${bridgePath} is broken — ${probe.detail}; reinstall it from the Home screen or run pnpm link --global in the clone`,
  };
}

export async function diagnoseInstallation(): Promise<readonly DoctorCheck[]> {
  const root = installationRoot(import.meta.url, 3);
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  const media = await checkFfmpeg();
  const decoder = media.ok ? hardwareDecoder(media.value) : undefined;
  const integration = await integrationReadiness();
  const bridge =
    integration.bridgePath === null
      ? null
      : await probeBridge(integration.bridgePath, studioVersion());
  const codex = integration.agents.codex.binaryPath !== null;
  const claude = integration.agents.claude.binaryPath !== null;
  const detectedAgents = [codex ? 'Codex' : null, claude ? 'Claude Code' : null].filter(Boolean);
  const readySkills = [
    codex && integration.agents.codex.skillInstalled ? 'Codex' : null,
    claude && integration.agents.claude.skillInstalled ? 'Claude Code' : null,
  ].filter(Boolean);
  const checks: DoctorCheck[] = [
    {
      id: 'node',
      status: nodeMajor === 22 ? 'ok' : 'error',
      label: 'Node.js',
      message:
        nodeMajor === 22
          ? `${process.versions.node} (${process.platform}/${process.arch})`
          : `${process.versions.node}; use Node 22.x for the native modules`,
    },
    {
      id: 'media',
      status: media.ok ? 'ok' : 'error',
      label: 'FFmpeg + FFprobe',
      message: media.ok ? `${media.value.version}; libass available` : media.error.message,
    },
    {
      id: 'hwdecode',
      status: 'ok',
      label: 'Hardware decode',
      message: !media.ok
        ? 'unknown until ffmpeg is found'
        : softwareDecodeForced()
          ? 'off — LEADZY_STUDIO_SOFTWARE_DECODE is set; renders decode on the CPU'
          : decoder !== undefined
            ? `${decoder} — sources decode on the GPU`
            : 'not available in this ffmpeg — renders decode on the CPU',
    },
    {
      id: 'client',
      status: existsSync(join(root, 'dist', 'client', 'index.html')) ? 'ok' : 'warning',
      label: 'Interface',
      message: existsSync(join(root, 'dist', 'client', 'index.html'))
        ? 'production build available'
        : 'not built yet; run make build',
    },
    {
      id: 'templates',
      status: existsSync(join(root, 'templates', 'creative-agent-guide.md')) ? 'ok' : 'error',
      label: 'Templates',
      message: existsSync(join(root, 'templates', 'creative-agent-guide.md'))
        ? 'Studio resources available'
        : 'installation templates missing',
    },
    bridgeCheck(integration.bridgePath, bridge),
    {
      id: 'agents',
      status: codex || claude ? 'ok' : 'warning',
      label: 'Agents',
      message:
        detectedAgents.join(' + ') ||
        'optional: install Codex or Claude Code for agent-driven editing',
    },
    {
      id: 'agent-skill',
      status:
        detectedAgents.length === 0
          ? 'warning'
          : readySkills.length === detectedAgents.length
            ? 'ok'
            : 'warning',
      label: 'Agent skills',
      message:
        readySkills.length > 0
          ? `${readySkills.join(' + ')} with the Leadzy Studio skill`
          : 'run studio install-skill or install it from the Home screen',
    },
  ];
  return checks;
}
