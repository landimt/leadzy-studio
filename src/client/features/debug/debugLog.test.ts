import { describe, expect, it } from 'vitest';
import {
  appendDebugEntry,
  DEBUG_LOG_LIMIT,
  debugEntryTone,
  describeServerEvent,
  formatDebugLog,
} from './debugLog.js';

describe('appendDebugEntry', () => {
  it('appends newest last and drops the oldest past the limit', () => {
    const log = Array.from({ length: DEBUG_LOG_LIMIT }, (_, i) => ({
      at: i,
      kind: 'k',
      text: `e${String(i)}`,
    }));

    const next = appendDebugEntry(log, { at: 999, kind: 'k', text: 'newest' });

    expect(next).toHaveLength(DEBUG_LOG_LIMIT);
    expect(next[0]?.text).toBe('e1');
    expect(next.at(-1)?.text).toBe('newest');
  });

  it('honours a custom limit and leaves the input untouched', () => {
    const log = [{ at: 1, kind: 'k', text: 'a' }];

    const next = appendDebugEntry(log, { at: 2, kind: 'k', text: 'b' }, 1);

    expect(next).toEqual([{ at: 2, kind: 'k', text: 'b' }]);
    expect(log).toHaveLength(1);
  });
});

describe('describeServerEvent', () => {
  it.each([
    [
      { kind: 'job', id: 7, type: 'render', state: 'running', progress: '[2/9] concat' },
      { kind: 'job:render', text: '#7 running — [2/9] concat' },
    ],
    [
      { kind: 'job', id: 7, type: 'render', state: 'running' },
      { kind: 'job:render', text: '#7 running — iniciado' },
    ],
    [
      { kind: 'job', id: 7, type: 'transcribe', state: 'done', result: {} },
      { kind: 'job:transcribe', text: '#7 done — concluído' },
    ],
    [
      { kind: 'job', id: 8, type: 'qa', state: 'error', error: 'ffmpeg died' },
      { kind: 'job:qa', text: '#8 error — erro: ffmpeg died' },
    ],
    [
      { kind: 'edit-changed', hash: 'abcdef0123456789', external: true },
      { kind: 'edit-changed', text: 'externo · abcdef012345' },
    ],
    [
      { kind: 'edit-changed', hash: 'abcdef0123456789', external: false },
      { kind: 'edit-changed', text: 'próprio · abcdef012345' },
    ],
    [{ kind: 'assets-changed' }, { kind: 'assets-changed', text: 'assets alterados no disco' }],
    [
      { kind: 'jobs-snapshot', jobs: [{ kind: 'job', id: 1, type: 'render', state: 'running' }] },
      { kind: 'jobs-snapshot', text: '1 job(s) em andamento no servidor' },
    ],
  ] as const)('describes %o', (event, expected) => {
    expect(describeServerEvent(event)).toEqual(expected);
  });
});

describe('debugEntryTone', () => {
  it.each([
    [{ at: 0, kind: 'job:render', text: '#1 error — erro: x' }, 'error'],
    [{ at: 0, kind: 'job:render', text: '#1 done — concluído' }, 'success'],
    [{ at: 0, kind: 'job:render', text: '#1 running — [1/2] a' }, 'running'],
    [{ at: 0, kind: 'edit-changed', text: 'próprio · abc' }, 'edit'],
    [{ at: 0, kind: 'assets-changed', text: 'assets alterados no disco' }, 'assets'],
    [{ at: 0, kind: 'jobs-snapshot', text: '0 job(s)' }, 'neutral'],
  ] as const)('%o → %s', (entry, tone) => {
    expect(debugEntryTone(entry)).toBe(tone);
  });
});

describe('formatDebugLog', () => {
  it('writes the facts, a blank line, then one aligned line per entry, oldest first', () => {
    const text = formatDebugLog(
      [
        {
          at: Date.UTC(2026, 7, 26, 13, 36, 8),
          kind: 'edit-changed',
          text: 'próprio · d6f411cb5913',
        },
        { at: Date.UTC(2026, 7, 26, 13, 36, 14), kind: 'job:render', text: '#5 error — erro: x' },
      ],
      [
        ['edit.json', 'd6f411cb5913'],
        ['preview desatualizado', 'sim'],
      ],
    );

    expect(text).toBe(
      'edit.json: d6f411cb5913\npreview desatualizado: sim\n\n' +
        '13:36:08  edit-changed        próprio · d6f411cb5913\n' +
        '13:36:14  job:render          #5 error — erro: x\n',
    );
  });
});
