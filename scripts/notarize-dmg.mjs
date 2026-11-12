import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Flags whose following value must never reach a log. */
const SECRET_FLAGS = new Set(['--password', '--key', '--key-id', '--issuer']);

/**
 * execFile spells the entire argv into its rejection message, so one transient
 * notary outage would print the Apple credential into the build output, and CI
 * keeps that output. Scrub every secret value before the error escapes.
 */
function redactSecrets(message, args) {
  let safe = message;
  for (let i = 0; i < args.length - 1; i += 1) {
    if (!SECRET_FLAGS.has(args[i])) continue;
    const value = args[i + 1];
    if (value.length > 0) safe = safe.split(value).join('••••••');
  }
  return safe;
}

async function runQuietly(file, args) {
  try {
    return await run(file, args);
  } catch (cause) {
    throw new Error(redactSecrets(cause.message, args));
  }
}

function credentialArgs() {
  const env = process.env;
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return [
      '--keychain-profile',
      env.APPLE_KEYCHAIN_PROFILE,
      ...(env.APPLE_KEYCHAIN ? ['--keychain', env.APPLE_KEYCHAIN] : []),
    ];
  }
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID) {
    return [
      '--key',
      env.APPLE_API_KEY,
      '--key-id',
      env.APPLE_API_KEY_ID,
      ...(env.APPLE_API_ISSUER ? ['--issuer', env.APPLE_API_ISSUER] : []),
    ];
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return [
      '--apple-id',
      env.APPLE_ID,
      '--password',
      env.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id',
      env.APPLE_TEAM_ID,
    ];
  }
  return null;
}

/**
 * Gatekeeper evaluates the container the person actually downloads. maker-dmg
 * emits an unsigned disk image, so a notarized app inside one still arrives in
 * a wrapper macOS cannot check ("no usable signature"). Sign, notarize and
 * staple the image itself, so the download passes even offline.
 */
export async function notarizeDmg(dmgPath) {
  const identity = process.env.MACOS_SIGN_IDENTITY?.trim();
  if (!identity) return false;

  await runQuietly('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity, dmgPath]);

  // Only past the signature can this message be true. Warning earlier would
  // report a signed image while the file on disk is still the unsigned one.
  const credentials = credentialArgs();
  if (credentials === null) {
    console.warn(
      `WARNING: ${dmgPath} was signed but NOT notarized — no Apple credentials in the environment. macOS will refuse this disk image on another computer.`,
    );
    return false;
  }

  const { stdout } = await runQuietly('/usr/bin/xcrun', [
    'notarytool',
    'submit',
    dmgPath,
    '--wait',
    '--output-format',
    'json',
    ...credentials,
  ]);
  // Shipped versions of `notarytool submit --wait` exit 0 on a rejected
  // submission, so the reported status decides, not the exit code.
  let status;
  try {
    status = JSON.parse(stdout).status;
  } catch {
    throw new Error(`Could not read the notarization result for ${dmgPath}:\n${stdout}`);
  }
  if (status !== 'Accepted') {
    throw new Error(`Notarization returned "${String(status)}" for ${dmgPath}`);
  }

  await runQuietly('/usr/bin/xcrun', ['stapler', 'staple', dmgPath]);
  return true;
}

// argv[1] keeps symlinks; import.meta.filename does not. Comparing them raw
// makes this script exit silently when reached through a linked path, which is
// exactly the manual recovery route someone takes when the hook did not run.
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  const [dmgPath] = process.argv.slice(2);
  if (!dmgPath) throw new Error('usage: notarize-dmg.mjs <path-to-dmg>');
  const done = await notarizeDmg(dmgPath);
  console.log(
    done
      ? `Disk image signed, notarized and stapled: ${dmgPath}`
      : 'Skipped: no signing identity in the environment',
  );
}
