import { describe, expect, it } from 'vitest';
import type { MediaSummary } from '../../api.js';
import {
  estimateLabel,
  formatMediaDuration,
  formatUsageDuration,
  pendingLabel,
  transcriptBadge,
  transcriptionOverview,
} from './transcriptionOverview.js';

describe('transcriptionOverview', () => {
  it('counts only audio-backed media and keeps newest caches first', () => {
    const media: MediaSummary[] = [
      {
        kind: 'video',
        relPath: 'old.mp4',
        durationS: 90,
        fps: 30,
        width: 1080,
        height: 1920,
        hasAudio: true,
        transcriptEngine: 'scribe',
        transcriptUpdatedAt: '2026-08-25T10:00:00.000Z',
        proxyRelPath: null,
      },
      {
        kind: 'audio',
        relPath: 'new.wav',
        durationS: 30,
        hasAudio: true,
        transcriptEngine: 'scribe',
        transcriptUpdatedAt: '2026-08-26T10:00:00.000Z',
        proxyRelPath: null,
      },
      {
        kind: 'video',
        relPath: 'pending.mp4',
        durationS: 60,
        fps: 30,
        width: 1080,
        height: 1920,
        hasAudio: true,
        transcriptEngine: null,
        proxyRelPath: null,
      },
      {
        kind: 'video',
        relPath: 'silent.mp4',
        durationS: 600,
        fps: 30,
        width: 1080,
        height: 1920,
        hasAudio: false,
        transcriptEngine: null,
        proxyRelPath: null,
      },
    ];

    expect(transcriptionOverview(media)).toMatchObject({
      totalCount: 3,
      transcribedCount: 2,
      pendingCount: 1,
      totalDurationS: 180,
      transcribedDurationS: 120,
      pendingDurationS: 60,
    });
    expect(transcriptionOverview(media).history.map((item) => item.relPath)).toEqual([
      'new.wav',
      'old.mp4',
    ]);
  });

  it('counts a transcript that predates the keyterms as pending again, but keeps it in history', () => {
    const media: MediaSummary[] = [
      {
        kind: 'audio',
        relPath: 'stale.wav',
        durationS: 30,
        hasAudio: true,
        transcriptEngine: 'scribe',
        transcriptState: 'stale-media',
        proxyRelPath: null,
      },
      {
        kind: 'audio',
        relPath: 'fresh.wav',
        durationS: 20,
        hasAudio: true,
        transcriptEngine: 'scribe',
        transcriptState: 'fresh',
        proxyRelPath: null,
      },
    ];

    expect(transcriptionOverview(media)).toMatchObject({
      totalCount: 2,
      transcribedCount: 1,
      pendingCount: 1,
      staleCount: 1,
      transcribedDurationS: 20,
      pendingDurationS: 30,
    });
    expect(transcriptionOverview(media).history).toHaveLength(2);
  });

  it('formats project usage and individual media with stable units', () => {
    expect(formatUsageDuration(3720)).toBe('1h 02min');
    expect(formatUsageDuration(3599)).toBe('59min');
    expect(formatUsageDuration(30)).toBe('<1min');
    expect(formatMediaDuration(80)).toBe('1min 20s');
    expect(formatMediaDuration(9.6)).toBe('10s');
  });
});

describe('transcription labels', () => {
  const overview = (counts: { totalCount: number; pendingCount: number; staleCount: number }) => ({
    ...counts,
    transcribedCount: 0,
    totalDurationS: 0,
    transcribedDurationS: 0,
    pendingDurationS: 0,
    history: [],
  });

  it('names the badge after why the transcript would be redone', () => {
    expect(transcriptBadge('stale-media')).toBe('mídia trocada');
    expect(transcriptBadge('stale-keyterms')).toBe('keyterms novos');
    expect(transcriptBadge('fresh')).toBe('ElevenLabs Scribe');
    expect(transcriptBadge(undefined)).toBe('ElevenLabs Scribe');
  });

  it('describes what is pending with singular and plural forms', () => {
    expect(pendingLabel(overview({ totalCount: 0, pendingCount: 0, staleCount: 0 }))).toBe(
      'Nenhuma mídia com áudio neste projeto',
    );
    expect(pendingLabel(overview({ totalCount: 2, pendingCount: 0, staleCount: 0 }))).toBe(
      'Todas as mídias com áudio estão transcritas',
    );
    expect(pendingLabel(overview({ totalCount: 2, pendingCount: 1, staleCount: 0 }))).toBe(
      '1 mídia aguardando',
    );
    expect(pendingLabel(overview({ totalCount: 3, pendingCount: 2, staleCount: 1 }))).toBe(
      '2 mídias aguardando · 1 desatualizada',
    );
    expect(pendingLabel(overview({ totalCount: 3, pendingCount: 3, staleCount: 2 }))).toBe(
      '3 mídias aguardando · 2 desatualizadas',
    );
  });

  it('shows the estimate only when something is pending, with the keyterm count', () => {
    expect(estimateLabel(0.05, 0, 2)).toBeNull();
    expect(estimateLabel(0.05, 1, 0)).toBe('≈ US$\u00a00,05');
    expect(estimateLabel(0.05, 1, 2)).toBe('≈ US$\u00a00,05 · 2 keyterms');
  });
});
