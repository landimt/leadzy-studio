import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { err, ok, type Result } from '../../core/result.js';

const HYPERFRAMES_RENDER_TIMEOUT_MS = 5 * 60 * 1000;
const BUNDLED_HYPERFRAMES_CLI = fileURLToPath(
  import.meta.resolve('hyperframes/bin/hyperframes.mjs'),
);

const CHILD_ENV_KEYS = [
  'HOME',
  // Points HyperFrames at an installed Chrome when its own headless-shell
  // download is not an option (offline machines, TLS-intercepting antivirus).
  'HYPERFRAMES_BROWSER_PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
] as const;

/** Pass only process basics to a composition renderer, never API/release keys. */
export function hyperframesChildEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = { NO_UPDATE_NOTIFIER: '1' };
  for (const key of CHILD_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface HyperframesRuntime {
  readonly nodeExecutable: string;
  readonly bundledCli: string;
  readonly electron: boolean;
}

export interface HyperframesInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly bundled: boolean;
}

const DEFAULT_RUNTIME: HyperframesRuntime = {
  nodeExecutable: process.execPath,
  bundledCli: BUNDLED_HYPERFRAMES_CLI,
  electron: process.versions.electron !== undefined,
};

/**
 * The checked-in dependency is the default. A configured binary remains an
 * escape hatch for development, but a working installation never depends on a
 * global npm/pnpm link or on whichever Node version launched the Studio.
 */
export function hyperframesInvocation(
  args: readonly string[],
  source: Readonly<Record<string, string | undefined>> = process.env,
  runtime: HyperframesRuntime = DEFAULT_RUNTIME,
): HyperframesInvocation {
  const configured = source.HYPERFRAMES_BIN?.trim();
  if (configured !== undefined && configured !== '') {
    return {
      executable: configured,
      args,
      env: hyperframesChildEnv(source),
      bundled: false,
    };
  }
  return {
    executable: runtime.nodeExecutable,
    args: [runtime.bundledCli, ...args],
    env: {
      ...hyperframesChildEnv(source),
      ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    bundled: true,
  };
}

export interface HyperframesStatus {
  readonly ok: boolean;
  readonly message: string;
}

interface HyperframesRunOutput {
  readonly stdout: string;
  readonly stderr: string;
}

function conciseProcessFailure(cause: unknown): string {
  const stderr = errorStringProperty(cause, 'stderr')?.trim() ?? '';
  if (stderr !== '') return stderr.split('\n').slice(-8).join('\n');
  return (
    errorStringProperty(cause, 'shortMessage') ??
    (cause instanceof Error ? cause.message : String(cause))
  );
}

function errorStringProperty(cause: unknown, property: string): string | undefined {
  if (cause === null || typeof cause !== 'object') return undefined;
  const value = (cause as Readonly<Record<string, unknown>>)[property];
  return typeof value === 'string' ? value : undefined;
}

function unavailableFailure(cause: unknown): boolean {
  const code = errorStringProperty(cause, 'code') ?? '';
  const detail = conciseProcessFailure(cause);
  return code === 'ENOENT' || /MODULE_NOT_FOUND|Cannot find module/i.test(detail);
}

async function runHyperframes(
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number },
): Promise<Result<HyperframesRunOutput>> {
  const invocation = hyperframesInvocation(args);
  const bundledCli = invocation.bundled ? invocation.args[0] : undefined;
  if (bundledCli !== undefined && !existsSync(bundledCli)) {
    return err(
      'hyperframes-failed',
      'O motor de elementos animados não foi incluído nesta instalação. Atualize ou reinstale o Studio.',
    );
  }
  try {
    const result = await execa(invocation.executable, invocation.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      timeout: options.timeoutMs,
      extendEnv: false,
      env: invocation.env,
    });
    return ok({ stdout: result.stdout, stderr: result.stderr });
  } catch (cause) {
    return err(
      'hyperframes-failed',
      unavailableFailure(cause)
        ? 'O motor de elementos animados não está disponível nesta instalação. Atualize ou reinstale o Studio.'
        : `O HyperFrames não conseguiu gerar o elemento: ${conciseProcessFailure(cause)}`,
      cause,
    );
  }
}

/** Fast readiness probe for Settings; rendering still owns the full error if the tool later changes. */
export async function checkHyperframes(): Promise<HyperframesStatus> {
  const result = await runHyperframes(['--version'], { timeoutMs: 5_000 });
  return result.ok
    ? { ok: true, message: result.value.stdout.trim() || 'HyperFrames disponível' }
    : { ok: false, message: result.error.message };
}

/**
 * Runs an already-installed CLI. Rendering never invokes npm/npx and never
 * downloads a different package version in the middle of an edit.
 */
export async function renderHyperframes(
  cwd: string,
  output = 'render.webm',
): Promise<Result<void>> {
  const result = await runHyperframes(['render', '.', '--format', 'webm', '-o', output], {
    cwd,
    timeoutMs: HYPERFRAMES_RENDER_TIMEOUT_MS,
  });
  return result.ok ? ok(undefined) : result;
}
