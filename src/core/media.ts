import type { TranscriptFreshness } from './transcript.js';
/** Media contracts shared by the server, editor and render planner. */
interface TimedMediaProbeBase {
  readonly durationS: number;
  readonly hasAudio: boolean;
}

export interface VideoMediaProbe extends TimedMediaProbeBase {
  readonly kind: 'video';
  readonly fps: number;
  readonly width: number;
  readonly height: number;
}

interface AudioMediaProbe extends TimedMediaProbeBase {
  readonly kind: 'audio';
  readonly hasAudio: true;
}

export interface ImageMediaProbe {
  readonly kind: 'image';
  readonly width: number;
  readonly height: number;
  readonly hasAudio: false;
}

export type TimedMediaProbe = VideoMediaProbe | AudioMediaProbe;
export type MediaProbe = TimedMediaProbe;

interface MediaSummaryBase {
  readonly relPath: string;
  readonly hasAudio: boolean;
  readonly transcriptEngine: string | null;
  /** Cache modification time. The cache remains the source of truth for history. */
  readonly transcriptUpdatedAt?: string | null;
  /** Why the next transcribe would redo this media; absent when unknown (the document could not be read). */
  readonly transcriptState?: TranscriptFreshness;
  readonly proxyRelPath: string | null;
}

interface VideoMediaSummary extends MediaSummaryBase {
  readonly kind: 'video';
  readonly durationS: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
}

interface AudioMediaSummary extends MediaSummaryBase {
  readonly kind: 'audio';
  readonly durationS: number;
  readonly hasAudio: true;
  readonly proxyRelPath: null;
}

interface ImageMediaSummary extends MediaSummaryBase {
  readonly kind: 'image';
  readonly width: number;
  readonly height: number;
  readonly hasAudio: false;
  readonly transcriptEngine: null;
  readonly proxyRelPath: null;
}

export type MediaSummary = VideoMediaSummary | AudioMediaSummary | ImageMediaSummary;
