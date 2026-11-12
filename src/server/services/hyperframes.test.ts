import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkHyperframes, hyperframesChildEnv, hyperframesInvocation } from './hyperframes.js';

describe('HyperFrames process boundary', () => {
  it('does not forward application, release or npm credentials', () => {
    const env = hyperframesChildEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/user',
      ELEVENLABS_API_KEY: 'scribe-secret',
      GITHUB_TOKEN: 'release-secret',
      npm_config_token: 'registry-secret',
    });

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/user', NO_UPDATE_NOTIFIER: '1' });
    expect(JSON.stringify(env)).not.toContain('secret');
  });

  it('forwards the browser override, which carries no credential', () => {
    const browser = 'C:\Program Files\Google\Chrome\Application\chrome.exe';
    expect(hyperframesChildEnv({ HYPERFRAMES_BROWSER_PATH: browser })).toEqual({
      HYPERFRAMES_BROWSER_PATH: browser,
      NO_UPDATE_NOTIFIER: '1',
    });
  });

  it('uses a configured executable without passing that setting to the child', () => {
    expect(
      hyperframesInvocation(
        ['--version'],
        { HYPERFRAMES_BIN: ' /opt/hyperframes/bin/hyperframes ' },
        { nodeExecutable: '/node', bundledCli: '/app/hyperframes.mjs', electron: false },
      ),
    ).toEqual({
      executable: '/opt/hyperframes/bin/hyperframes',
      args: ['--version'],
      env: { NO_UPDATE_NOTIFIER: '1' },
      bundled: false,
    });
  });

  it('keeps Windows process basics and the bundled browser without credentials', () => {
    expect(
      hyperframesChildEnv({
        SystemRoot: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\Ana',
        LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        HYPERFRAMES_BROWSER_PATH: 'C:\\Studio\\browser\\chrome-headless-shell.exe',
        GITHUB_TOKEN: 'secret',
      }),
    ).toEqual({
      NO_UPDATE_NOTIFIER: '1',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\Ana',
      LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      HYPERFRAMES_BROWSER_PATH: 'C:\\Studio\\browser\\chrome-headless-shell.exe',
    });
  });

  it('runs the bundled CLI through the current Node runtime', () => {
    expect(
      hyperframesInvocation(
        ['render', '.'],
        { PATH: '/usr/bin' },
        { nodeExecutable: '/node', bundledCli: '/app/hyperframes.mjs', electron: false },
      ),
    ).toEqual({
      executable: '/node',
      args: ['/app/hyperframes.mjs', 'render', '.'],
      env: { PATH: '/usr/bin', NO_UPDATE_NOTIFIER: '1' },
      bundled: true,
    });
  });

  it('turns the packaged Electron executable into Node only for the bundled CLI', () => {
    expect(
      hyperframesInvocation(
        ['--version'],
        {},
        { nodeExecutable: '/Leadzy Studio', bundledCli: '/app/hyperframes.mjs', electron: true },
      ).env,
    ).toEqual({ NO_UPDATE_NOTIFIER: '1', ELECTRON_RUN_AS_NODE: '1' });
  });

  it('ships a runnable pinned CLI instead of relying on a global command', async () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: { hyperframes: string } };
    await expect(checkHyperframes()).resolves.toEqual({
      ok: true,
      message: manifest.dependencies.hyperframes,
    });
  });
});
