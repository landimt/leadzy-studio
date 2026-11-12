import type { ServerEvent } from '../../../server/jobs.js';

export interface DebugEntry {
  /** Milliseconds since the epoch, taken when the event reached the store. */
  readonly at: number;
  readonly kind: string;
  readonly text: string;
}

export const DEBUG_LOG_LIMIT = 100;

/** Newest last; the oldest entries fall off once the limit is reached. */
export function appendDebugEntry(
  log: readonly DebugEntry[],
  entry: DebugEntry,
  limit = DEBUG_LOG_LIMIT,
): readonly DebugEntry[] {
  const next = [...log, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** One line per server event, in the words the panel shows. */
export function describeServerEvent(event: ServerEvent): { kind: string; text: string } {
  switch (event.kind) {
    case 'job': {
      const detail =
        event.state === 'running'
          ? (event.progress ?? 'iniciado')
          : event.state === 'done'
            ? 'concluído'
            : `erro: ${event.error ?? '?'}`;
      return { kind: `job:${event.type}`, text: `#${String(event.id)} ${event.state} — ${detail}` };
    }
    case 'edit-changed':
      return {
        kind: 'edit-changed',
        text: `${event.external ? 'externo' : 'próprio'} · ${event.hash.slice(0, 12)}`,
      };
    case 'artifacts-changed':
      return { kind: 'artifacts-changed', text: 'áudio ou vídeo renderizado atualizado no disco' };
    case 'assets-changed':
      return { kind: 'assets-changed', text: 'assets alterados no disco' };
    case 'jobs-snapshot':
      return {
        kind: 'jobs-snapshot',
        text: `${String(event.jobs.length)} job(s) em andamento no servidor`,
      };
  }
}

export type DebugTone = 'error' | 'success' | 'running' | 'edit' | 'assets' | 'neutral';

/** The colour a row gets: failures and completions stand out, the rest stays quiet. */
export function debugEntryTone(entry: DebugEntry): DebugTone {
  if (entry.kind.startsWith('job:')) {
    if (entry.text.includes(' error ')) return 'error';
    if (entry.text.includes(' done ')) return 'success';
    return 'running';
  }
  if (entry.kind === 'edit-changed') return 'edit';
  if (entry.kind === 'assets-changed') return 'assets';
  return 'neutral';
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

/** Plain text for the clipboard: oldest first, one line per entry, with a header of facts. */
export function formatDebugLog(
  entries: readonly DebugEntry[],
  facts: readonly (readonly [string, string])[],
): string {
  const header = facts.map(([label, value]) => `${label}: ${value}`).join('\n');
  const lines = entries.map(
    (entry) => `${clock(entry.at)}  ${entry.kind.padEnd(18)}  ${entry.text}`,
  );
  return `${header}\n\n${lines.join('\n')}\n`;
}
