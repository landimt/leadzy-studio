import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    on: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => undefined)),
    getPath: vi.fn(() => ''),
    setAppUserModelId: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: electron.app,
  autoUpdater: {},
  BrowserWindow: vi.fn(),
  clipboard: {},
  dialog: {},
  ipcMain: {},
  Menu: {},
  nativeImage: {},
}));

vi.mock('update-electron-app', () => ({
  updateElectronApp: vi.fn(),
  UpdateSourceType: { ElectronPublicUpdateService: 'public' },
}));
vi.mock('electron-squirrel-startup', () => ({ default: false }));

const {
  fileLogger,
  isAllowedWindowUrl,
  isTrustedRendererEvent,
  desktopBridgeScript,
  refreshDesktopBridge,
  projectThumbnailSize,
} = await import('./main.mjs');

// A file: URL is only valid for the platform it was built on: Windows
// rejects a driveless path outright, so derive the fixtures from a real
// installation path instead of hard-coding the macOS one.
const installDir =
  process.platform === 'win32'
    ? 'C:\\Program Files\\Leadzy Studio\\client'
    : '/Applications/Leadzy Studio/client';
const launcherFile = (name) => pathToFileURL(join(installDir, name)).href;
const launcher = `${launcherFile('index.html')}?launcher=1`;
const servers = ['http://127.0.0.1:52740'];

describe('project thumbnail proportions', () => {
  it.each([
    [1080, 1920, { width: 152, height: 270 }],
    [1920, 1080, { width: 480, height: 270 }],
    [1080, 1080, { width: 270, height: 270 }],
    [2560, 1080, { width: 480, height: 203 }],
  ])('fits %s × %s without stretching to landscape', (width, height, expected) => {
    expect(projectThumbnailSize(width, height)).toEqual(expected);
  });

  it('rejects unknown or invalid dimensions', () => {
    for (const size of [0, -1, NaN, Infinity, undefined]) {
      expect(projectThumbnailSize(size, 1080)).toBeNull();
      expect(projectThumbnailSize(1080, size)).toBeNull();
    }
  });
});

describe('desktop CLI bridge', () => {
  const options = (version) => ({
    platform: 'win32',
    rootPath: `C:\\Users\\Ana\\Leadzy\\app-${version}\\resources\\resources`,
    executablePath: `C:\\Users\\Ana\\Leadzy\\app-${version}\\Leadzy Studio.exe`,
    cliPath: `C:\\Users\\Ana\\Leadzy\\app-${version}\\resources\\app.asar\\dist\\node\\cli\\main.js`,
  });

  it('points both platform bridges at their packaged browser', () => {
    expect(desktopBridgeScript(options('0.1.0'))).toContain(
      'HYPERFRAMES_BROWSER_PATH=C:\\Users\\Ana\\Leadzy\\app-0.1.0\\resources\\resources\\browser\\chrome-headless-shell.exe',
    );
    expect(
      desktopBridgeScript({
        platform: 'darwin',
        rootPath: '/Applications/Leadzy Studio.app/Contents/Resources/resources',
        executablePath: '/Applications/Leadzy Studio.app/Contents/MacOS/Leadzy Studio',
        cliPath: '/app.asar/dist/node/cli/main.js',
      }),
    ).toContain(
      "export HYPERFRAMES_BROWSER_PATH='/Applications/Leadzy Studio.app/Contents/Resources/resources/browser/chrome-headless-shell'",
    );
  });

  it('refreshes an opted-in bridge from v1 to v2 and preserves other commands', async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const temp = await mkdtemp(join(tmpdir(), 'leadzy-bridge-'));
    const bridgePath = join(temp, 'studio.cmd');
    try {
      expect(await refreshDesktopBridge({ ...options('0.2.0'), bridgePath })).toBe(false);
      await writeFile(bridgePath, desktopBridgeScript(options('0.1.0')));
      expect(await refreshDesktopBridge({ ...options('0.2.0'), bridgePath })).toBe(true);
      const updated = await readFile(bridgePath, 'utf8');
      expect(updated).toContain('app-0.2.0');
      expect(updated).not.toContain('app-0.1.0');
      const legacy =
        "#!/bin/sh\nexport LEADZY_STUDIO_ROOT='/Applications/Leadzy Studio.app/Contents/Resources/resources'\nexport ELECTRON_RUN_AS_NODE=1\nexec '/Applications/Leadzy Studio.app/Contents/MacOS/Leadzy Studio' '/Applications/Leadzy Studio.app/Contents/Resources/app.asar/dist/node/cli/main.js' \"$@\"\n";
      await writeFile(bridgePath, legacy);
      expect(
        await refreshDesktopBridge({ ...options('0.2.0'), platform: 'darwin', bridgePath }),
      ).toBe(true);
      expect(await readFile(bridgePath, 'utf8')).toContain('HYPERFRAMES_BROWSER_PATH');
      await writeFile(bridgePath, '@echo off\necho user command\n');
      expect(await refreshDesktopBridge({ ...options('0.3.0'), bridgePath })).toBe(false);
      expect(await readFile(bridgePath, 'utf8')).toBe('@echo off\necho user command\n');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe('isAllowedWindowUrl', () => {
  it('allows only the exact local launcher file', () => {
    expect(isAllowedWindowUrl(launcher, launcher, servers)).toBe(true);
    expect(isAllowedWindowUrl(`${launcherFile('other.html')}?launcher=1`, launcher, servers)).toBe(
      false,
    );
    expect(
      isAllowedWindowUrl(`${launcherFile('index.html')}?launcher=1&remote=1`, launcher, servers),
    ).toBe(false);
  });

  it('allows paths on a local server that was actually started', () => {
    expect(isAllowedWindowUrl('http://127.0.0.1:52740/edit?take=1', launcher, servers)).toBe(true);
  });

  it.each([
    'https://leadzy.com.br',
    'http://attacker.example:52740',
    'http://localhost:52740',
    'http://127.0.0.1:52741',
    'javascript:alert(1)',
  ])('rejects remote, aliased, or unstarted destinations: %s', (target) => {
    expect(isAllowedWindowUrl(target, launcher, servers)).toBe(false);
  });
});

describe('isTrustedRendererEvent', () => {
  const mainFrame = { url: 'http://127.0.0.1:52740/' };
  const webContents = { id: 7, mainFrame };

  it('requires the expected webContents, its main frame, and an allowed URL', () => {
    expect(
      isTrustedRendererEvent(
        { sender: { id: 7 }, senderFrame: mainFrame },
        webContents,
        launcher,
        servers,
      ),
    ).toBe(true);
  });

  it('rejects an IPC message from a child frame', () => {
    expect(
      isTrustedRendererEvent(
        { sender: { id: 7 }, senderFrame: { url: mainFrame.url } },
        webContents,
        launcher,
        servers,
      ),
    ).toBe(false);
  });

  it('rejects an IPC message after the main frame reaches a remote URL', () => {
    const remoteFrame = { url: 'https://attacker.example' };
    expect(
      isTrustedRendererEvent(
        { sender: { id: 7 }, senderFrame: remoteFrame },
        { id: 7, mainFrame: remoteFrame },
        launcher,
        servers,
      ),
    ).toBe(false);
  });

  it('rejects an IPC message from another webContents', () => {
    expect(
      isTrustedRendererEvent(
        { sender: { id: 8 }, senderFrame: mainFrame },
        webContents,
        launcher,
        servers,
      ),
    ).toBe(false);
  });
});

describe('dist/node runtime paths', () => {
  /**
   * The launcher reaches the Node build only through string paths —
   * dynamic imports plus the `studio` bridge script. A source file that moves
   * during a refactor keeps compiling and passing unit tests while the packaged
   * app fails at launch, so the paths are pinned to their sources here.
   */
  it('every dist/node path in main.mjs has a TypeScript source', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const electronDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(electronDir, 'main.mjs'), 'utf8');

    const importPaths = [...source.matchAll(/dist\/node\/([\w/.-]+)\.js/g)].map((m) => m[1]);
    const joinedPaths = [...source.matchAll(/'dist',\s*'node'((?:,\s*'[\w.-]+')+)/g)].map((m) =>
      m[1]
        .split(',')
        .map((part) => part.trim().replace(/^'|'$/g, ''))
        .filter(Boolean)
        .join('/')
        .replace(/\.js$/, ''),
    );
    const paths = [...new Set([...importPaths, ...joinedPaths])].sort();

    expect(paths).toEqual([
      'cli/agentIntegration',
      'cli/commands/open',
      'cli/env',
      'cli/main',
      'db/index',
      'server/index',
      'server/services/ffmpeg',
      'server/services/userConfig',
    ]);
    for (const relative of paths) {
      expect(existsSync(join(electronDir, '..', 'src', `${relative}.ts`)), relative).toBe(true);
    }
  });
});

describe('fileLogger', () => {
  it('appends timestamped lines with the level, the context and the error to the app log', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const logsDir = mkdtempSync(join(tmpdir(), 'leadzy-logs-'));
    electron.app.getPath.mockReturnValue(logsDir);
    try {
      const logger = fileLogger('server.log');

      logger.error('unhandled error on POST /api/settings', new Error('EACCES: config.json.tmp'));

      await vi.waitFor(() => {
        const content = readFileSync(join(logsDir, 'server.log'), 'utf8');
        expect(content).toMatch(
          /^\d{4}-\d{2}-\d{2}T[^ ]+ error unhandled error on POST \/api\/settings/,
        );
        expect(content).toContain('EACCES: config.json.tmp');
      });
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});
