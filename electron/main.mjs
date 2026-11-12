import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
} from 'electron';
import { access, appendFile, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  posix,
  resolve,
  win32,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';
import squirrelStartup from 'electron-squirrel-startup';
import {
  awaitFlush,
  flushTimeoutDialogOptions,
  formatLogArguments,
  updateDialogOptions,
  updateOffer,
} from './updateNotice.mjs';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.LEADZY_STUDIO_ROOT = app.isPackaged
  ? join(process.resourcesPath, 'resources')
  : APP_ROOT;
process.env.LEADZY_STUDIO_DESKTOP = '1';
if (app.isPackaged) {
  process.env.HYPERFRAMES_BROWSER_PATH = join(
    process.env.LEADZY_STUDIO_ROOT,
    'browser',
    process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell',
  );
}
if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.LeadzyStudio.Leadzy Studio');

let window = null;
let server = null;
let pendingServer = null;
let quitting = false;
let openingProject = false;
const allowedLauncherProjects = new Set();

const statePath = () => join(app.getPath('userData'), 'desktop-state.json');

async function pathExists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function lastProject() {
  try {
    const raw = JSON.parse(await readFile(statePath(), 'utf8'));
    return typeof raw.lastProject === 'string' && (await pathExists(raw.lastProject))
      ? raw.lastProject
      : null;
  } catch {
    return null;
  }
}

async function rememberProject(projectDir) {
  await writeFile(statePath(), `${JSON.stringify({ lastProject: projectDir }, null, 2)}\n`);
}

function createWindow() {
  const next = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: '#17120f',
    title: 'Leadzy Studio',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(APP_ROOT, 'electron', 'preload.cjs'),
    },
  });
  next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const preventUntrustedNavigation = (event, url) => {
    if (!isAllowedRendererUrl(url)) event.preventDefault();
  };
  next.webContents.on('will-navigate', preventUntrustedNavigation);
  next.webContents.on('will-redirect', preventUntrustedNavigation);
  next.once('ready-to-show', () => next.show());
  next.on('closed', () => {
    if (window === next) window = null;
  });
  return next;
}

async function runtime() {
  const [
    { preferLocalToolchain },
    { openProject },
    { startServer },
    { StudioDb },
    { integrationReadiness, installAgentSkills },
    { UserConfig },
  ] = await Promise.all([
    import('../dist/node/cli/env.js'),
    import('../dist/node/cli/commands/open.js'),
    import('../dist/node/server/index.js'),
    import('../dist/node/db/index.js'),
    import('../dist/node/cli/agentIntegration.js'),
    import('../dist/node/server/services/userConfig.js'),
  ]);
  preferLocalToolchain();
  return {
    openProject,
    startServer,
    StudioDb,
    integrationReadiness,
    installAgentSkills,
    UserConfig,
  };
}

function launcherClientPath() {
  return join(process.env.LEADZY_STUDIO_ROOT, 'dist', 'client', 'index.html');
}

function launcherUrl() {
  const url = pathToFileURL(launcherClientPath());
  url.searchParams.set('launcher', '1');
  return url;
}

function localServerOrigin(address) {
  try {
    const url = new URL(address);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.port === '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isAllowedWindowUrl(target, expectedLauncherUrl, serverAddresses) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }

  if (url.protocol === 'file:') {
    try {
      const launcher = new URL(expectedLauncherUrl);
      return (
        launcher.protocol === 'file:' &&
        resolve(fileURLToPath(url)) === resolve(fileURLToPath(launcher)) &&
        url.host === launcher.host &&
        url.search === launcher.search &&
        url.hash === launcher.hash
      );
    } catch {
      return false;
    }
  }

  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return false;
  }
  return serverAddresses.some((address) => localServerOrigin(address) === url.origin);
}

export function isTrustedRendererEvent(
  event,
  trustedWebContents,
  expectedLauncherUrl,
  serverAddresses,
) {
  const senderFrame = event?.senderFrame;
  return (
    event?.sender?.id === trustedWebContents.id &&
    senderFrame !== undefined &&
    senderFrame !== null &&
    senderFrame === trustedWebContents.mainFrame &&
    typeof senderFrame.url === 'string' &&
    isAllowedWindowUrl(senderFrame.url, expectedLauncherUrl, serverAddresses)
  );
}

function activeServerAddresses() {
  return [server?.address, pendingServer?.address].filter((address) => typeof address === 'string');
}

function isAllowedRendererUrl(url) {
  return isAllowedWindowUrl(url, launcherUrl().href, activeServerAddresses());
}

async function showHome() {
  if (!window) window = createWindow();
  if (server) {
    await server.close();
    server = null;
  }
  await window.loadURL(launcherUrl().href);
  window.setTitle('Leadzy Studio');
  window.show();
}

async function showProject(projectDir, reserved = false) {
  if (openingProject && !reserved) return false;
  openingProject = true;
  if (!window) window = createWindow();
  window.show();

  const previousServer = server;
  let candidateServer = null;
  try {
    const { openProject, startServer } = await runtime();
    const opened = await openProject(projectDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const serverLog = fileLogger('server.log');
    candidateServer = await startServer(projectDir, {
      // a packaged app's stderr goes to launchd — the cause of a 500 must land somewhere readable
      reportUnhandledError: (context, error) => serverLog.error(context, error),
    });
    if (localServerOrigin(candidateServer.address) === null) {
      throw new Error('o servidor local retornou um endereço não autorizado');
    }
    pendingServer = candidateServer;
    await rememberProject(projectDir);
    await window.loadURL(candidateServer.address);
    server = candidateServer;
    pendingServer = null;
    if (previousServer && previousServer !== candidateServer) await previousServer.close();
    window.setTitle(`Leadzy Studio — ${basename(projectDir)}`);
    return true;
  } catch (error) {
    if (candidateServer && candidateServer !== server) await candidateServer.close();
    server = previousServer;
    await dialog.showMessageBox(window, {
      type: 'error',
      title: 'Não foi possível abrir o projeto',
      message: error instanceof Error ? error.message : String(error),
      detail: 'Escolha uma pasta que contenha os vídeos do criativo.',
    });
    if (!previousServer) await showHome();
    return false;
  } finally {
    if (pendingServer === candidateServer) pendingServer = null;
    openingProject = false;
  }
}

async function chooseProjectPath() {
  const remembered = await lastProject();
  const { UserConfig } = await runtime();
  const preferences = await new UserConfig().preferences();
  const result = await dialog.showOpenDialog(window ?? undefined, {
    title: 'Abrir projeto no Leadzy Studio',
    defaultPath: preferences.defaultProjectDir ?? remembered ?? undefined,
    buttonLabel: 'Abrir projeto',
    properties: ['openDirectory', 'createDirectory'],
  });
  const [projectDir] = result.filePaths;
  if (result.canceled || !projectDir) return null;
  allowedLauncherProjects.add(resolve(projectDir));
  return projectDir;
}

async function chooseProject() {
  const projectDir = await chooseProjectPath();
  if (!projectDir) return;
  await showProject(projectDir);
}

async function uniqueMediaDestination(projectDir, sourcePath) {
  const sourceName = basename(sourcePath);
  let candidate = join(projectDir, sourceName);
  if (resolve(candidate) === resolve(sourcePath)) return null;
  if (!(await pathExists(candidate))) return candidate;
  const { name, ext } = parse(sourceName);
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    candidate = join(projectDir, `${name} (${String(suffix)})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Não foi possível reservar um nome para ${sourceName}.`);
}

async function createProjectFromMedia() {
  const media = await dialog.showOpenDialog(window ?? undefined, {
    title: 'Escolha os vídeos do novo projeto',
    buttonLabel: 'Usar estes vídeos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Vídeos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }],
  });
  if (media.canceled || media.filePaths.length === 0) return null;

  const { UserConfig } = await runtime();
  const preferences = await new UserConfig().preferences();
  const destination = await dialog.showOpenDialog(window ?? undefined, {
    title: 'Escolha onde salvar o projeto',
    buttonLabel: 'Salvar projeto aqui',
    defaultPath: preferences.defaultProjectDir ?? undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  const [projectDir] = destination.filePaths;
  if (destination.canceled || !projectDir) return null;

  for (const sourcePath of media.filePaths) {
    const target = await uniqueMediaDestination(projectDir, sourcePath);
    if (target) await copyFile(sourcePath, target);
  }
  allowedLauncherProjects.add(resolve(projectDir));
  return projectDir;
}

function ratioLabel(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(Math.round(width), Math.round(height));
  return `${String(Math.round(width) / divisor)}:${String(Math.round(height) / divisor)}`;
}

export function projectThumbnailSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const scale = Math.min(480 / width, 270 / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function projectThumbnail(projectDir) {
  const { probeMedia } = await import('../dist/node/server/services/ffmpeg.js');
  for (const relative of ['edit/final.mp4', 'edit/preview.mp4']) {
    const candidate = join(projectDir, relative);
    if (!(await pathExists(candidate))) continue;
    try {
      // Quick Look on macOS can stretch to the requested dimensions. Size
      // from the actual exported file, which may predate the current edit.
      const probe = await probeMedia(candidate);
      if (!probe.ok) continue;
      const size = projectThumbnailSize(probe.value.width, probe.value.height);
      if (!size) continue;
      const thumbnail = await nativeImage.createThumbnailFromPath(candidate, size);
      if (!thumbnail.isEmpty()) return thumbnail.toDataURL();
    } catch {
      // The project remains useful even when Quick Look cannot decode a codec.
    }
  }
  return null;
}

async function recentProject(row) {
  if (!(await pathExists(row.path))) return null;
  let durationS = null;
  let aspectRatio = null;
  try {
    const doc = JSON.parse(await readFile(join(row.path, 'edit', 'edit.json'), 'utf8'));
    durationS = typeof doc.totalDurationS === 'number' ? doc.totalDurationS : null;
    aspectRatio = ratioLabel(doc.output?.width, doc.output?.height);
  } catch {
    // A recent folder can predate edit.json; opening it will scaffold the file.
  }
  const [hasPreview, hasFinal, thumbnailDataUrl] = await Promise.all([
    pathExists(join(row.path, 'edit', 'preview.mp4')),
    pathExists(join(row.path, 'edit', 'final.mp4')),
    projectThumbnail(row.path),
  ]);
  return {
    path: row.path,
    name: basename(row.path),
    parentDir: dirname(row.path),
    openedAt: row.opened_at,
    durationS,
    aspectRatio,
    hasPreview,
    hasFinal,
    thumbnailDataUrl,
  };
}

async function launcherState() {
  const { StudioDb, integrationReadiness } = await runtime();
  const db = new StudioDb();
  let rows;
  try {
    rows = db.listProjects(12);
  } finally {
    db.close();
  }
  const [projects, integration] = await Promise.all([
    Promise.all(rows.map(recentProject)),
    integrationReadiness(),
  ]);
  const recentProjects = projects.filter((project) => project !== null);
  for (const project of recentProjects) allowedLauncherProjects.add(resolve(project.path));
  return { appVersion: app.getVersion(), recentProjects, integration };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const BRIDGE_MARKER = 'Leadzy Studio desktop bridge';

export function desktopBridgeScript({ platform, rootPath, executablePath, cliPath }) {
  const browser = (platform === 'win32' ? win32.join : posix.join)(
    rootPath,
    'browser',
    platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell',
  );
  const cmdQuote = (value) => `"${value.replaceAll('%', '%%')}"`;
  return platform === 'win32'
    ? [
        '@echo off',
        `rem ${BRIDGE_MARKER}`,
        'setlocal DisableDelayedExpansion',
        `set "LEADZY_STUDIO_ROOT=${rootPath.replaceAll('%', '%%')}"`,
        `set "HYPERFRAMES_BROWSER_PATH=${browser.replaceAll('%', '%%')}"`,
        'set "ELECTRON_RUN_AS_NODE=1"',
        `${cmdQuote(executablePath)} ${cmdQuote(cliPath)} %*`,
        'exit /b %errorlevel%',
        '',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        `# ${BRIDGE_MARKER}`,
        `export LEADZY_STUDIO_ROOT=${shellQuote(rootPath)}`,
        `export HYPERFRAMES_BROWSER_PATH=${shellQuote(browser)}`,
        'export ELECTRON_RUN_AS_NODE=1',
        `exec ${shellQuote(executablePath)} ${shellQuote(cliPath)} "$@"`,
        '',
      ].join('\n');
}

function desktopBridgeOptions() {
  return {
    bridgePath: join(
      homedir(),
      '.local',
      'bin',
      process.platform === 'win32' ? 'studio.cmd' : 'studio',
    ),
    platform: process.platform,
    rootPath: process.env.LEADZY_STUDIO_ROOT,
    executablePath: process.execPath,
    cliPath: join(app.getAppPath(), 'dist', 'node', 'cli', 'main.js'),
  };
}

export async function refreshDesktopBridge(options) {
  let current;
  try {
    current = await readFile(options.bridgePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  // Only refresh bridges installed by this app; never create an integration
  // for someone who did not opt in or replace their own studio command.
  const legacyMac =
    options.platform === 'darwin' &&
    /^#!\/bin\/sh\nexport LEADZY_STUDIO_ROOT='[^\n]+'\nexport ELECTRON_RUN_AS_NODE=1\nexec '[^\n]+' '[^\n]+\/dist\/node\/cli\/main\.js' "\$@"\n$/.test(
      current,
    );
  if (!current.includes(BRIDGE_MARKER) && !legacyMac) return false;
  const script = desktopBridgeScript(options);
  if (script !== current) await writeFile(options.bridgePath, script, { mode: 0o755 });
  return true;
}

async function installDesktopIntegration() {
  const { installAgentSkills, integrationReadiness } = await runtime();
  const options = desktopBridgeOptions();
  const { bridgePath } = options;
  await mkdir(dirname(bridgePath), { recursive: true });
  await writeFile(bridgePath, desktopBridgeScript(options), { mode: 0o755 });
  await chmod(bridgePath, 0o755);
  const installedSkills = await installAgentSkills();
  const integration = await integrationReadiness();
  return { installedSkills, bridgePath, integration };
}

function installIpc() {
  const trusted = (event) =>
    window !== null &&
    isTrustedRendererEvent(event, window.webContents, launcherUrl().href, activeServerAddresses());
  ipcMain.handle('launcher:get-state', async (event) => {
    if (!trusted(event)) throw new Error('janela não autorizada');
    return launcherState();
  });
  ipcMain.handle('launcher:choose-project', async (event) => {
    if (!trusted(event)) throw new Error('janela não autorizada');
    return chooseProjectPath();
  });
  ipcMain.handle('launcher:create-project', async (event) => {
    if (!trusted(event)) throw new Error('janela não autorizada');
    return createProjectFromMedia();
  });
  ipcMain.handle('launcher:open-project', (event, projectDir) => {
    if (!trusted(event) || typeof projectDir !== 'string') return { accepted: false };
    const resolved = resolve(projectDir);
    if (!allowedLauncherProjects.has(resolved) || openingProject) return { accepted: false };
    openingProject = true;
    setImmediate(() => void showProject(resolved, true));
    return { accepted: true };
  });
  ipcMain.handle('launcher:install-integration', async (event) => {
    if (!trusted(event)) throw new Error('janela não autorizada');
    return installDesktopIntegration();
  });
  ipcMain.handle('launcher:copy-text', (event, value) => {
    if (!trusted(event) || typeof value !== 'string') throw new Error('texto não autorizado');
    clipboard.writeText(value);
  });
  ipcMain.handle('settings:choose-directory', async (event, options) => {
    if (!trusted(event) || typeof options !== 'object' || options === null) {
      throw new Error('pedido de pasta não autorizado');
    }
    const title =
      typeof options.title === 'string' ? options.title.slice(0, 120) : 'Escolha uma pasta';
    const defaultPath =
      typeof options.defaultPath === 'string' && options.defaultPath.length > 0
        ? options.defaultPath
        : undefined;
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title,
      ...(defaultPath ? { defaultPath } : {}),
      buttonLabel: 'Usar esta pasta',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('settings:reveal-external-path', async (event, path) => {
    if (
      !trusted(event) ||
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      !(await pathExists(path))
    ) {
      throw new Error('arquivo de entrega não encontrado');
    }
    shell.showItemInFolder(path);
  });
  ipcMain.handle('settings:reveal-user-data', async (event, kind) => {
    if (!trusted(event) || (kind !== 'config' && kind !== 'library')) {
      throw new Error('pasta de dados não autorizada');
    }
    const target = join(homedir(), '.leadzy-studio', ...(kind === 'library' ? ['library'] : []));
    await mkdir(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
  ipcMain.handle('launcher:show-home', (event) => {
    if (!trusted(event)) throw new Error('janela não autorizada');
    setImmediate(() => void showHome());
  });
}

function installMenu() {
  const rendererIsLauncher = () => window?.webContents.getURL().includes('launcher=1') === true;
  const requestHome = () => {
    if (!window || rendererIsLauncher()) {
      void showHome();
      return;
    }
    window.webContents.send('launcher:request-home');
  };
  const requestOpenProject = () => {
    if (!window || rendererIsLauncher()) {
      void chooseProject();
      return;
    }
    window.webContents.send('launcher:request-open-project');
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Leadzy Studio',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Projeto',
        submenu: [
          {
            label: 'Início',
            accelerator: 'CmdOrCtrl+Shift+H',
            click: requestHome,
          },
          { type: 'separator' },
          {
            label: 'Abrir projeto…',
            accelerator: 'CmdOrCtrl+O',
            click: requestOpenProject,
          },
          { role: 'close' },
        ],
      },
      {
        label: 'Editar',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'Exibir',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

/** A silent channel is a channel nobody notices is broken: updates and the local server both log to files. */
export function fileLogger(fileName) {
  const logFile = join(app.getPath('logs'), fileName);
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level} ${formatLogArguments(args)}\n`;
    void mkdir(dirname(logFile), { recursive: true })
      .then(() => appendFile(logFile, line))
      .catch(() => undefined);
  };
  return {
    log: (...args) => write('info', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}

/**
 * The editor autosaves on a debounce inside the window, and by the time
 * `before-quit` runs the window is already gone, so quitting is not by itself
 * a flush. Ask the window to persist now, and never block the update on it:
 * an unresponsive renderer must not strand the person on an old version.
 */
async function flushOpenEditor() {
  // No server means the Home screen, which mounts no editor and so never
  // answers. Waiting there would burn the whole timeout on every update for
  // nothing, with no window on screen to explain the pause.
  if (!window || window.isDestroyed() || !server) return 'nothing-open';
  const contents = window.webContents;
  let listener;
  return awaitFlush({
    send: () => contents.send('desktop:flush-save'),
    once: (handler) => {
      listener = (event, result) => {
        if (isTrustedRendererEvent(event, contents, launcherUrl().href, activeServerAddresses())) {
          handler({ ok: result?.ok === true });
        }
      };
      ipcMain.on('desktop:flush-save-done', listener);
    },
    off: () => ipcMain.removeListener('desktop:flush-save-done', listener),
  });
}

/**
 * Updates come from the public releases feed. Squirrel.Mac refuses to update
 * an unsigned bundle, so this only ever works on a Developer ID build.
 *
 * The download is silent; the person is asked only once it is ready, and the
 * swap happens on the next launch. Never mid-edit.
 */
function installUpdates() {
  if (!app.isPackaged) return;
  // Squirrel holds an installation lock during its first launch.
  if (process.argv.includes('--squirrel-firstrun')) return;
  // Portable Windows ZIPs do not have Squirrel's Update.exe.
  if (
    process.platform === 'win32' &&
    !existsSync(join(dirname(process.execPath), '..', 'Update.exe'))
  )
    return;
  const logger = fileLogger('updates.log');
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: 'leadzy/leadzy-studio-releases',
    },
    updateInterval: '2 hours',
    logger,
    onNotifyUser: ({ releaseName }) => {
      const offer = updateOffer(app.getVersion(), releaseName);
      if (!offer.apply) {
        logger.warn(
          `update refused (${offer.reason}): running ${app.getVersion()}, feed sent "${String(releaseName)}"`,
        );
        return;
      }
      void dialog
        .showMessageBox(updateDialogOptions(offer.version))
        .then(async ({ response }) => {
          if (response !== 0) return;
          // Everything below closes the window and can take a few seconds, so
          // say what is happening first. A silent disappearance reads as a
          // crash, and relaunching from the Dock mid-install is the one thing
          // that could actually corrupt the swap.
          // Remembered rather than rebuilt: the title carries the open
          // project's name, and the deferred path below has to give it back.
          const titleBefore = window && !window.isDestroyed() ? window.getTitle() : null;
          if (titleBefore !== null) window.setTitle('Atualizando o Leadzy Studio…');
          const flushed = await flushOpenEditor();
          logger.info('applying update', offer.version, flushed);
          if (flushed === 'timeout' || flushed === 'failed') {
            // The window never confirmed the save, and restarting anyway would
            // destroy the very edit this flush exists to protect. Nothing is
            // gained by insisting: an update already downloaded is applied at
            // the next launch on its own, so staying open costs only time.
            // `window` goes null when the person closes it, which can happen
            // during the wait: having had a title is not proof of still having
            // a window.
            if (titleBefore !== null && window && !window.isDestroyed()) {
              window.setTitle(titleBefore);
            }
            await dialog.showMessageBox(flushTimeoutDialogOptions(offer.version));
            return;
          }
          autoUpdater.quitAndInstall();
        })
        .catch((cause) => {
          logger.error('update prompt failed', cause);
        });
    },
  });
}

if (squirrelStartup) {
  app.quit();
} else
  app.whenReady().then(async () => {
    app.setAboutPanelOptions({
      applicationName: 'Leadzy Studio',
      copyright: `Copyright © ${String(new Date().getFullYear())} Leadzy`,
      credits:
        'Open-source software licensed under AGPL-3.0-only.\n' +
        'Source: https://github.com/landimt/leadzy-studio',
      website: 'https://github.com/landimt/leadzy-studio',
    });
    if (app.isPackaged) {
      await refreshDesktopBridge(desktopBridgeOptions()).catch((error) =>
        fileLogger('server.log').warn('Could not refresh desktop bridge', error),
      );
    }
    installIpc();
    installMenu();
    installUpdates();
    const projectFlag = process.argv.indexOf('--project');
    const commandLineProject =
      process.env.LEADZY_STUDIO_PROJECT ??
      (projectFlag >= 0 ? process.argv[projectFlag + 1] : undefined);
    if (commandLineProject && (await pathExists(commandLineProject))) {
      await showHome();
      await showProject(commandLineProject);
    } else {
      await showHome();
    }
  });

app.on('activate', () => {
  if (!window) void showHome();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (!server || quitting) return;
  event.preventDefault();
  quitting = true;
  // The editor server holds an open SSE stream per window, and Fastify waits
  // for it, so an unclosed stream would keep the app alive forever instead of
  // quitting. Give the graceful close a bounded window, then go anyway.
  //
  // The server closes its SSE sockets explicitly; retain this bound for
  // unrelated shutdown hooks that may still be waiting on external work.
  void Promise.race([server.close(), new Promise((resolve) => setTimeout(resolve, 4000))]).finally(
    () => {
      server = null;
      app.quit();
    },
  );
});
