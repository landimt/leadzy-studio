import { describe, expect, it } from 'vitest';
import {
  awaitFlush,
  flushTimeoutDialogOptions,
  formatLogArguments,
  parseReleaseVersion,
  updateDialogOptions,
  updateOffer,
} from './updateNotice.mjs';

describe('parseReleaseVersion', () => {
  it('reads the tag the publisher writes', () => {
    expect(parseReleaseVersion('v1.2.3')).toEqual([1, 2, 3]);
  });

  it('reads a bare version too', () => {
    expect(parseReleaseVersion('1.2.3')).toEqual([1, 2, 3]);
  });

  it('gives up on a human-retitled release', () => {
    expect(parseReleaseVersion('Correções de áudio')).toBeNull();
  });

  it('gives up on a missing title instead of inventing one', () => {
    expect(parseReleaseVersion(undefined)).toBeNull();
  });
});

describe('updateOffer', () => {
  it('applies a strictly newer release', () => {
    expect(updateOffer('0.1.0', 'v0.1.1')).toEqual({ apply: true, version: '0.1.1' });
  });

  it('refuses the version already running', () => {
    expect(updateOffer('0.1.0', 'v0.1.0').apply).toBe(false);
  });

  // A signed but older build published under a newer tag would install and
  // then look current forever, silently ending updates for that machine.
  it('refuses a downgrade', () => {
    expect(updateOffer('1.2.0', 'v1.1.9')).toEqual({ apply: false, reason: 'not-newer' });
  });

  it('compares numerically, not as text', () => {
    expect(updateOffer('0.9.0', 'v0.10.0').apply).toBe(true);
    expect(updateOffer('0.10.0', 'v0.9.0').apply).toBe(false);
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(updateOffer('0.1.0', 'Correções')).toEqual({
      apply: false,
      reason: 'unreadable-version',
    });
  });
});

describe('formatLogArguments', () => {
  // The library logs `log('feedURL', url)`, and that line is what tells you
  // whether the release feed resolved at all.
  it('keeps the arguments after the first', () => {
    expect(formatLogArguments(['feedURL', 'https://update.electronjs.org/a/b'])).toBe(
      'feedURL https://update.electronjs.org/a/b',
    );
  });

  it('keeps an error stack instead of collapsing it to a message', () => {
    const error = new Error('feed offline');
    expect(formatLogArguments([error])).toContain('feed offline');
    expect(formatLogArguments([error]).split('\n').length).toBeGreaterThan(1);
  });

  it('serializes objects rather than printing [object Object]', () => {
    expect(formatLogArguments(['headers', { 'user-agent': 'studio' }])).toBe(
      'headers {"user-agent":"studio"}',
    );
  });
});

describe('awaitFlush', () => {
  it('reports persistence failure instead of authorizing a restart', async () => {
    let handler;
    expect(
      await awaitFlush({
        send: () => handler({ ok: false }),
        once: (fn) => {
          handler = fn;
        },
        off: () => undefined,
        timeoutMs: 50,
      }),
    ).toBe('failed');
  });
  it('resolves as soon as the window answers', async () => {
    let handler = null;
    const result = await awaitFlush({
      send: () => handler(),
      once: (fn) => {
        handler = fn;
      },
      off: () => undefined,
      timeoutMs: 50,
    });
    expect(result).toBe('flushed');
  });

  // A wedged renderer must not be able to strand someone on an old version.
  it('gives up on a window that never answers', async () => {
    const result = await awaitFlush({
      send: () => undefined,
      once: () => undefined,
      off: () => undefined,
      timeoutMs: 10,
    });
    expect(result).toBe('timeout');
  });

  it('stops listening once it settles, either way', async () => {
    let removed = 0;
    await awaitFlush({
      send: () => undefined,
      once: () => undefined,
      off: () => {
        removed += 1;
      },
      timeoutMs: 10,
    });
    expect(removed).toBe(1);
  });

  it('ignores a late answer after the timeout already fired', async () => {
    let handler = null;
    const result = await awaitFlush({
      send: () => undefined,
      once: (fn) => {
        handler = fn;
      },
      off: () => undefined,
      timeoutMs: 10,
    });
    expect(result).toBe('timeout');
    expect(() => handler?.()).not.toThrow();
  });
});

describe('flushTimeoutDialogOptions', () => {
  // Restarting on this branch would destroy the edit the flush exists to save,
  // and buy nothing: a downloaded update applies at the next launch anyway.
  it('says the app stays open rather than restarting', () => {
    const detail = flushTimeoutDialogOptions('0.1.1').detail;
    expect(detail).toContain('continua aberto');
    expect(detail).toContain('próxima vez que abrir');
  });

  it('offers no restart button, so the destructive path is unreachable', () => {
    expect(flushTimeoutDialogOptions('0.1.1').buttons).toEqual(['Entendi']);
  });

  it('names the version that is waiting', () => {
    expect(flushTimeoutDialogOptions('0.1.1').message).toContain('0.1.1');
  });
});

describe('updateDialogOptions', () => {
  it('names the version without the tag prefix leaking through', () => {
    expect(updateDialogOptions('0.1.1').message).toBe('A versão 0.1.1 está pronta.');
  });

  it('promises only what the flush actually delivers', () => {
    expect(updateDialogOptions('0.1.1').detail).toContain('é salvo antes de reiniciar');
  });
});
