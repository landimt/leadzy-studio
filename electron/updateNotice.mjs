/**
 * The decision half of auto-update, kept apart from Electron so it can be
 * tested: given the running version and whatever the release feed reports,
 * decide whether to offer the update and what to say.
 */

/** Feed titles are human-edited, so `v1.2.0`, `1.2.0` and `Correções` all arrive here. */
export function parseReleaseVersion(releaseName) {
  if (typeof releaseName !== 'string') return null;
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(releaseName);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Squirrel trusts any bundle carrying our signature, which means a release
 * published out of order — an older build under a newer tag — would install
 * and then look current forever. Refuse anything that is not strictly newer,
 * and refuse anything whose version cannot be read at all.
 */
export function updateOffer(currentVersion, releaseName) {
  const current = parseReleaseVersion(currentVersion);
  const offered = parseReleaseVersion(releaseName);
  if (current === null || offered === null) return { apply: false, reason: 'unreadable-version' };
  if (compareVersions(offered, current) <= 0) return { apply: false, reason: 'not-newer' };
  return { apply: true, version: offered.join('.') };
}

/**
 * The library logs variadically, and its single most diagnostic line is
 * `log('feedURL', url)` — the one that says whether the release feed resolved
 * at all. Keeping only the first argument would throw exactly that away.
 */
export function formatLogArguments(args) {
  return args
    .map((value) => {
      if (value instanceof Error) return value.stack ?? String(value);
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
}

/**
 * Asks the open window to persist before the bundle is swapped. Bounded on
 * purpose: the UI remains open if persistence fails or times out. Dependencies
 * are injected so both failure paths are reachable in tests.
 */
export function awaitFlush({ send, once, off, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off(handler);
      resolve(reason);
    };
    const handler = (result) => {
      finish(result?.ok === false ? 'failed' : 'flushed');
    };
    const timer = setTimeout(() => {
      finish('timeout');
    }, timeoutMs);
    once(handler);
    send();
  });
}

/**
 * Shown when the window never confirmed the save. Restarting now would trade
 * an unrecoverable edit for nothing: a downloaded update is applied at the
 * next launch whether or not the app is restarted on demand.
 */
export function flushTimeoutDialogOptions(version) {
  return {
    type: 'warning',
    buttons: ['Entendi'],
    defaultId: 0,
    title: 'Atualização adiada',
    message: `A versão ${version} está pronta, mas o projeto não confirmou o salvamento.`,
    detail:
      'O aplicativo continua aberto para você não perder nada. Salve o que estiver fazendo e feche quando quiser: a atualização é aplicada sozinha na próxima vez que abrir.',
  };
}

export function updateDialogOptions(version) {
  return {
    type: 'info',
    buttons: ['Reiniciar agora', 'Depois'],
    defaultId: 0,
    cancelId: 1,
    title: 'Atualização do Leadzy Studio',
    message: `A versão ${version} está pronta.`,
    detail:
      'Ela é aplicada ao reiniciar o aplicativo. O que estiver aberto é salvo antes de reiniciar.',
  };
}
