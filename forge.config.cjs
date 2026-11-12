const { existsSync, readFileSync } = require('node:fs');
const { readFile, writeFile } = require('node:fs/promises');
const { basename, dirname, join } = require('node:path');
const { execFile } = require('node:child_process');
const plist = require('plist');

const projectRoot = __dirname;
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));

/**
 * Signing settings come from the gitignored `.env`, so producing a
 * distributable is plain `pnpm desktop:make` and no one's certificate name
 * lands in the repository. A build that forgets them silently falls back to an
 * ad-hoc signature, which macOS refuses on any other machine. Real environment
 * variables still win, for CI.
 */
function loadEnvFile() {
  const envPath = join(projectRoot, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    // The escape hatch is never file-settable: parked in .env it would turn a
    // one-off exception into a permanent, invisible property of the machine.
    if (key === 'ALLOW_UNNOTARIZED') continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^(["'])(.*)\1$/, '$2');
  }
}

// Read before the loader runs, so this one cannot be parked in .env: a
// deliberate deviation has to be retyped per build, instead of quietly
// outliving the single test it was meant for.
const allowUnnotarized = process.env.ALLOW_UNNOTARIZED === '1';

loadEnvFile();

const macSignIdentity = process.env.MACOS_SIGN_IDENTITY?.trim();
const macEntitlements = join(projectRoot, 'build', 'entitlements.plist');

function notarizeCredentials() {
  if (process.env.APPLE_KEYCHAIN_PROFILE) {
    return {
      keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE,
      ...(process.env.APPLE_KEYCHAIN ? { keychain: process.env.APPLE_KEYCHAIN } : {}),
    };
  }
  if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID) {
    return {
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
      ...(process.env.APPLE_API_ISSUER ? { appleApiIssuer: process.env.APPLE_API_ISSUER } : {}),
    };
  }
  if (
    process.env.APPLE_ID &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD &&
    process.env.APPLE_TEAM_ID
  ) {
    return {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    };
  }
  return undefined;
}

const macNotarizeCredentials = notarizeCredentials();

// Signing without notarizing produces an artifact that looks shippable and
// that macOS refuses on every machine except this one. That half-configured
// state is what shipped a broken installer once, so it fails here, before the
// build spends minutes packaging, rather than at the customer's Mac.
if (
  process.platform === 'darwin' &&
  macSignIdentity &&
  !macNotarizeCredentials &&
  !allowUnnotarized
) {
  throw new Error(
    'MACOS_SIGN_IDENTITY is set but no notarization credentials are: set APPLE_KEYCHAIN_PROFILE, or the APPLE_API_KEY pair, or the APPLE_ID trio. To build a signed but unnotarized bundle on purpose (local hardened-runtime testing), set ALLOW_UNNOTARIZED=1.',
  );
}

/**
 * pnpm's hoisted node_modules layout is not pruned correctly by Electron
 * Packager's npm-oriented dependency walker. Build the runtime allow-list from
 * the installed package manifests instead, following only production edges.
 */
function collectProductionModules() {
  const rootNodeModules = join(projectRoot, 'node_modules');
  const visited = new Set();

  // Node-style resolution: nearest nested node_modules first, then upward.
  // pnpm's hoisted layout keeps conflicting versions nested (e.g.
  // execa/node_modules/get-stream@9), so resolving a dependency by name at the
  // top level can read the wrong version's manifest and drop its hoisted deps.
  function resolvePackageDir(name, fromDir) {
    let dir = fromDir;
    while (true) {
      const candidate = join(dir, 'node_modules', ...name.split('/'));
      if (existsSync(join(candidate, 'package.json'))) return candidate;
      if (dir === projectRoot) return null;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  // `required` is true only while the whole chain from package.json is hard
  // dependencies — a missing edge below a peer/optional hop must not abort the
  // build over a package that was never meant to ship.
  function walk(packageDir, required) {
    if (visited.has(packageDir)) return;
    visited.add(packageDir);

    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const requiredEdges = Object.keys(manifest.dependencies ?? {});
    const optionalEdges = Object.keys({
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    });

    for (const dependency of [...requiredEdges, ...optionalEdges]) {
      const dependencyDir = resolvePackageDir(dependency, packageDir);
      if (!dependencyDir) {
        if (required && requiredEdges.includes(dependency)) {
          throw new Error(
            `Production dependency not installed: ${dependency} (from ${manifest.name})`,
          );
        }
        continue;
      }
      walk(dependencyDir, required && requiredEdges.includes(dependency));
    }
  }

  for (const name of Object.keys(packageJson.dependencies ?? {})) {
    const dir = resolvePackageDir(name, projectRoot);
    if (!dir) throw new Error(`Production dependency not installed: ${name}`);
    walk(dir, true);
  }

  // Keep a top-level copy only when the walker actually resolved it there.
  // Recording bare names would drag in unwalked top-level twins of packages
  // that resolved nested — copies whose own dependencies were never included.
  const modules = new Set();
  for (const dir of visited) {
    const parent = dirname(dir);
    if (parent === rootNodeModules) {
      modules.add(basename(dir));
    } else if (dirname(parent) === rootNodeModules && basename(parent).startsWith('@')) {
      modules.add(`${basename(parent)}/${basename(dir)}`);
    }
  }
  return modules;
}

const productionModules = collectProductionModules();
const productionScopes = new Set(
  [...productionModules].filter((name) => name.startsWith('@')).map((name) => name.split('/')[0]),
);

// HyperFrames keeps semantic catalog search behind a dynamic import of ONNX.
// The Studio only embeds its deterministic HTML renderer, so shipping every
// ONNX binary for macOS, Linux and Windows would add more than 200 MB without
// being reachable from the app.
const desktopExcludedModules = new Set(['onnxruntime-node']);

function ignoreDesktopPackage(sourcePath) {
  const path = sourcePath.replaceAll('\\', '/');

  if (path === '' || path === '/' || path === '/package.json') return false;

  if (path === '/electron') return false;
  if (path.startsWith('/electron/')) {
    return !['/electron/main.mjs', '/electron/preload.cjs', '/electron/updateNotice.mjs'].includes(
      path,
    );
  }

  if (path === '/dist' || path === '/dist/node' || path.startsWith('/dist/node/')) return false;
  if (path.startsWith('/dist/')) return true;

  if (path === '/node_modules') return false;
  if (path.startsWith('/node_modules/')) {
    const segments = path.split('/').filter(Boolean);
    const first = segments[1];
    if (!first || first.startsWith('.')) return true;
    if (desktopExcludedModules.has(first)) return true;
    if (first.startsWith('@')) {
      if (segments.length === 2) return !productionScopes.has(first);
      return !productionModules.has(`${first}/${segments[2]}`);
    }
    return !productionModules.has(first);
  }

  // Icons and portable resources are consumed separately by Electron Packager
  // through `icon` and `extraResource`; everything else is development input.
  return true;
}

/**
 * The three helper classes @electron/osx-sign special-cases, each with its own
 * Chromium-derived plist. Every other file takes the minimal entitlements.
 *
 * A helper class Electron adds later would land in neither: the library's
 * fallback is the full device set (camera, microphone, bluetooth, USB, print,
 * location), and the minimal set may be too little for whatever it does. That
 * is a decision, not a default, so it stops the build and asks.
 */
function helperKeepsLibraryDefaults(filePath) {
  if (/Helper \((Plugin|GPU|Renderer)\)\.app/.test(filePath)) return true;
  const unknownHelper = /Helper \(([^)]+)\)\.app/.exec(filePath);
  if (unknownHelper) {
    throw new Error(
      `Unrecognized Electron helper "${unknownHelper[1]}": decide its entitlements in forge.config.cjs before shipping. The library default would grant camera, microphone, bluetooth, USB, print and location.`,
    );
  }
  return false;
}

function cleanMacTemplate(buildPath, _electronVersion, platform, _arch, done) {
  if (platform !== 'darwin') return done();

  const infoPath = join(buildPath, 'Electron.app', 'Contents', 'Info.plist');
  readFile(infoPath, 'utf8')
    .then((source) => {
      const info = plist.parse(source);
      // Electron's generic template advertises permissions this editor never
      // requests. Remove them before the bundle is finalized and signed.
      // The matching entitlements are withheld in build/entitlements.plist:
      // granting one without the other is a capability that can never work.
      delete info.NSBluetoothAlwaysUsageDescription;
      delete info.NSBluetoothPeripheralUsageDescription;
      delete info.NSCameraUsageDescription;
      delete info.NSMicrophoneUsageDescription;
      return writeFile(infoPath, plist.build(info));
    })
    .then(() => done(), done);
}

function signMacAdHoc(buildPath, _electronVersion, platform, _arch, done) {
  if (platform !== 'darwin' || macSignIdentity) return done();

  const appPath = join(buildPath, 'Leadzy Studio.app');
  execFile(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    done,
  );
}

module.exports = {
  ...(process.env.LEADZY_DESKTOP_OUT ? { outDir: process.env.LEADZY_DESKTOP_OUT } : {}),
  packagerConfig: {
    asar: {
      // Sharp loads libvips beside its native module, while HyperFrames starts
      // esbuild as a child process. Neither a dylib nor an executable can run
      // from inside app.asar, so keep these two small runtime families beside
      // it. AutoUnpackNatives adds the general **/*.node rule below.
      unpackDir: '{node_modules/@img,node_modules/@esbuild}',
    },
    // The custom allow-list above replaces Electron Packager's npm-oriented
    // pruning, which retains dev dependencies in pnpm's hoisted layout.
    prune: false,
    name: 'Leadzy Studio',
    appBundleId: 'com.leadzy.studio',
    appCategoryType: 'public.app-category.video',
    appCopyright: `Copyright © ${new Date().getFullYear()} Leadzy`,
    executableName: 'Leadzy Studio',
    icon: 'build/icon',
    extraResource: ['build/resources'],
    extendInfo: {
      CFBundleDisplayName: 'Leadzy Studio',
      CFBundleName: 'Leadzy Studio',
    },
    afterExtract: [cleanMacTemplate],
    afterComplete: [signMacAdHoc],
    osxSign: macSignIdentity
      ? {
          identity: macSignIdentity,
          // The three Chromium helpers keep @electron/osx-sign's own defaults,
          // which mirror Chromium's per-process entitlements. Everything else
          // — the app, the bundled ffmpeg/ffprobe, the native modules — takes
          // the minimal set instead of the library default, which would grant
          // camera, microphone, bluetooth, USB and location.
          optionsForFile: (filePath) =>
            helperKeepsLibraryDefaults(filePath)
              ? { hardenedRuntime: true }
              : { hardenedRuntime: true, entitlements: macEntitlements },
        }
      : undefined,
    // The hatch exists to skip the notary round trip, so it has to suppress
    // this too: otherwise the app is notarized while the image is left
    // unsigned, which is the very shape of the incident this series closes.
    osxNotarize: macSignIdentity && !allowUnnotarized ? macNotarizeCredentials : undefined,
    ignore: ignoreDesktopPackage,
  },
  rebuildConfig: {
    // better-sqlite3 is a Node-API addon and ships its own prebuilt binary for
    // every platform, so the Electron ABI does not change what it loads and
    // rebuilding it buys nothing. It costs something on Windows, though: the
    // rebuild needs a Visual Studio C++ toolchain, and without one the desktop
    // app cannot start at all. Skip it there.
    ...(process.platform === 'win32' ? { ignoreModules: ['better-sqlite3'] } : {}),
  },
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'Leadzy-Studio',
        format: 'ULFO',
      },
    },
    // The disk image is for the first install; Squirrel.Mac updates itself from
    // a zip of the .app, so an update-capable release has to carry both.
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'LeadzyStudio',
        setupExe: `Leadzy-Studio-${packageJson.version}-Setup.exe`,
        setupIcon: join(projectRoot, 'build', 'icon.ico'),
        noMsi: true,
        ...(process.env.WINDOWS_CERTIFICATE_FILE
          ? {
              certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
              certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
            }
          : {}),
      },
    },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        // Releases live in a separate public feed so the updater can read them
        // independently from the source repository workflow.
        repository: { owner: 'leadzy', name: 'leadzy-studio-releases' },
        prerelease: false,
        // Uploaded as a draft on purpose: nothing reaches an installed app
        // until a human publishes the release. One click, and it is the last
        // gate before every customer gets the build.
        draft: true,
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
  hooks: {
    // Forge notarizes and staples the .app, but the disk image built around it
    // stays unsigned, and the disk image is what a person downloads.
    postMake: async (_forgeConfig, makeResults) => {
      // Under the hatch the image stays untouched. `make app` already covers
      // the only legitimate use (testing hardened runtime locally), so signing
      // a disk image here would just make an undeliverable file look ready.
      if (allowUnnotarized) {
        console.warn(
          'ALLOW_UNNOTARIZED=1: the disk image was left unsigned and unnotarized. It is a local test artifact — do not hand it to anyone.',
        );
        return makeResults;
      }
      const { notarizeDmg } = await import('./scripts/notarize-dmg.mjs');
      for (const result of makeResults) {
        if (result.platform !== 'darwin') continue;
        for (const artifact of result.artifacts) {
          if (artifact.endsWith('.dmg')) await notarizeDmg(artifact);
        }
      }
      return makeResults;
    },
  },
};
