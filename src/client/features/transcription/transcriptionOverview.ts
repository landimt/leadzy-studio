import type { MediaSummary } from '../../api.js';

type TimedMedia = Extract<MediaSummary, { kind: 'video' | 'audio' }>;

export interface TranscriptionOverview {
  readonly totalCount: number;
  /** Media whose transcript is current; a stale one counts as pending, not as covered. */
  readonly transcribedCount: number;
  /** Media with no transcript plus media whose transcript predates the keyterms. */
  readonly pendingCount: number;
  readonly staleCount: number;
  readonly totalDurationS: number;
  readonly transcribedDurationS: number;
  readonly pendingDurationS: number;
  readonly history: readonly TimedMedia[];
}

export function isStaleTranscript(media: Pick<MediaSummary, 'transcriptState'>): boolean {
  return media.transcriptState === 'stale-media' || media.transcriptState === 'stale-keyterms';
}

function isTranscribable(media: MediaSummary): media is TimedMedia {
  return media.kind !== 'image' && media.hasAudio;
}

/** Derives the operational view from project files; no separate usage ledger can drift. */
export function transcriptionOverview(media: readonly MediaSummary[]): TranscriptionOverview {
  const candidates = media.filter(isTranscribable);
  const transcribed = candidates.filter((item) => item.transcriptEngine !== null);
  const current = transcribed.filter((item) => !isStaleTranscript(item));
  const totalDurationS = candidates.reduce((sum, item) => sum + item.durationS, 0);
  const transcribedDurationS = current.reduce((sum, item) => sum + item.durationS, 0);
  const history = [...transcribed].sort((a, b) => {
    const aTime = a.transcriptUpdatedAt ? Date.parse(a.transcriptUpdatedAt) : 0;
    const bTime = b.transcriptUpdatedAt ? Date.parse(b.transcriptUpdatedAt) : 0;
    return bTime - aTime || a.relPath.localeCompare(b.relPath);
  });
  return {
    totalCount: candidates.length,
    transcribedCount: current.length,
    pendingCount: candidates.length - current.length,
    staleCount: transcribed.length - current.length,
    totalDurationS,
    transcribedDurationS,
    pendingDurationS: Math.max(0, totalDurationS - transcribedDurationS),
    history,
  };
}

export function formatUsageDuration(durationS: number): string {
  const minutes = Math.floor(Math.max(0, durationS) / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (durationS > 0 && minutes === 0) return '<1min';
  return hours > 0
    ? `${String(hours)}h ${String(remainder).padStart(2, '0')}min`
    : `${String(minutes)}min`;
}

export function formatMediaDuration(durationS: number): string {
  const rounded = Math.max(0, Math.round(durationS));
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return minutes > 0
    ? `${String(minutes)}min ${String(seconds).padStart(2, '0')}s`
    : `${String(seconds)}s`;
}

const USD = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });

export function transcriptBadge(state: MediaSummary['transcriptState']): string {
  if (state === 'stale-media') return 'mídia trocada';
  if (state === 'stale-keyterms') return 'keyterms novos';
  return 'ElevenLabs Scribe';
}

/** The status header when nothing is running: what is pending, and how much of it is a redo. */
export function pendingLabel(overview: TranscriptionOverview): string {
  if (overview.totalCount === 0) return 'Nenhuma mídia com áudio neste projeto';
  if (overview.pendingCount === 0) return 'Todas as mídias com áudio estão transcritas';
  const waiting = `${String(overview.pendingCount)} ${overview.pendingCount === 1 ? 'mídia aguardando' : 'mídias aguardando'}`;
  if (overview.staleCount === 0) return waiting;
  return `${waiting} · ${String(overview.staleCount)} ${overview.staleCount === 1 ? 'desatualizada' : 'desatualizadas'}`;
}

/** `≈ US$ 0,05 · 2 keyterms`; nothing when nothing is pending. */
export function estimateLabel(
  estimateUsd: number,
  pendingCount: number,
  keytermCount: number,
): string | null {
  if (pendingCount === 0) return null;
  const keyterms = keytermCount > 0 ? ` · ${String(keytermCount)} keyterms` : '';
  return `≈ ${USD.format(estimateUsd)}${keyterms}`;
}
