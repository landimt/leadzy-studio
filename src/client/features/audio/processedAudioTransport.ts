import { audioComparisonDuration, boundedAudioTime } from './processedAudioWaveform.js';

export type AudioPreviewVariant = 'before' | 'after';

/** Small surface shared by HTMLAudioElement and deterministic transport fakes. */
export interface AudioPreviewMedia {
  readonly readyState: number;
  readonly duration: number;
  currentTime: number;
  readonly paused: boolean;
  play: () => Promise<void>;
  pause: () => void;
}

interface AudioComparisonTransportCallbacks {
  readonly onActiveVariant: (variant: AudioPreviewVariant) => void;
  readonly onPlaying: (playing: boolean) => void;
  readonly onTime: (timeS: number) => void;
  readonly onDuration: (durationS: number) => void;
  readonly onError: (message: string | null) => void;
}

interface TransportOptions extends AudioComparisonTransportCallbacks {
  readonly fallbackDurationS: number;
  readonly getMedia: (variant: AudioPreviewVariant) => AudioPreviewMedia | null;
}

const HAVE_METADATA = 1;

/**
 * Coordinates the two native media elements as one A/B transport.
 *
 * A generation owns every asynchronous play request. Superseded requests may
 * resolve, but they cannot pause a newer request for the same active element;
 * an element that is no longer active is always paused.
 */
export class AudioComparisonTransport {
  private readonly options: TransportOptions;
  private readonly measuredDurations: Record<AudioPreviewVariant, number | null> = {
    before: null,
    after: null,
  };
  private readonly playOwner: Record<AudioPreviewVariant, number> = { before: 0, after: 0 };
  private activeVariant: AudioPreviewVariant = 'after';
  private desiredTimeS = 0;
  private wantsPlaying = false;
  private generation = 0;
  private disposed = false;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  get durationS(): number {
    return audioComparisonDuration(
      [this.measuredDurations.before, this.measuredDurations.after],
      this.options.fallbackDurationS,
    );
  }

  private media(variant: AudioPreviewVariant): AudioPreviewMedia | null {
    return this.options.getMedia(variant);
  }

  private nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private invalidatePlayRequests(generation: number): void {
    this.playOwner.before = generation;
    this.playOwner.after = generation;
  }

  private pauseAll(): void {
    for (const variant of ['before', 'after'] as const) {
      const media = this.media(variant);
      if (media && !media.paused) media.pause();
    }
  }

  private pauseInactive(): void {
    const inactive = this.activeVariant === 'before' ? 'after' : 'before';
    const media = this.media(inactive);
    if (media && !media.paused) media.pause();
  }

  private applyDesiredTime(media: AudioPreviewMedia | null): boolean {
    if (!media || media.readyState < HAVE_METADATA) return false;
    const mediaDuration = Number.isFinite(media.duration) ? media.duration : this.durationS;
    media.currentTime = boundedAudioTime(this.desiredTimeS, mediaDuration);
    return true;
  }

  private applyDesiredTimeToReadyMedia(): void {
    this.applyDesiredTime(this.media('before'));
    this.applyDesiredTime(this.media('after'));
  }

  private async requestPlay(variant: AudioPreviewVariant, generation: number): Promise<void> {
    const media = this.media(variant);
    if (!media || !this.applyDesiredTime(media)) return;
    this.playOwner[variant] = generation;
    try {
      await media.play();
    } catch (cause) {
      if (
        this.disposed ||
        this.playOwner[variant] !== generation ||
        this.generation !== generation ||
        this.activeVariant !== variant ||
        !this.wantsPlaying
      ) {
        return;
      }
      this.wantsPlaying = false;
      this.options.onPlaying(false);
      this.options.onError(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    // A newer request for this same element owns its playback. The old promise
    // must not pause it when A -> B -> A happens before play() settles.
    if (this.playOwner[variant] !== generation) {
      if (this.disposed || !this.wantsPlaying || this.activeVariant !== variant) media.pause();
      return;
    }
    if (
      this.disposed ||
      this.generation !== generation ||
      this.activeVariant !== variant ||
      !this.wantsPlaying
    ) {
      media.pause();
      return;
    }
    this.pauseInactive();
    this.options.onPlaying(true);
  }

  seek(timeS: number): void {
    this.desiredTimeS = boundedAudioTime(timeS, this.durationS);
    this.applyDesiredTimeToReadyMedia();
    this.options.onTime(this.desiredTimeS);
  }

  togglePlayback(): void {
    this.options.onError(null);
    const generation = this.nextGeneration();
    this.invalidatePlayRequests(generation);
    if (this.wantsPlaying) {
      this.wantsPlaying = false;
      const active = this.media(this.activeVariant);
      if (active?.readyState && Number.isFinite(active.currentTime)) {
        this.desiredTimeS = boundedAudioTime(active.currentTime, this.durationS);
        this.options.onTime(this.desiredTimeS);
      }
      this.pauseAll();
      this.options.onPlaying(false);
      return;
    }

    this.wantsPlaying = true;
    this.pauseInactive();
    void this.requestPlay(this.activeVariant, generation);
  }

  switchVariant(next: AudioPreviewVariant): void {
    if (this.activeVariant === next) {
      this.pauseInactive();
      return;
    }
    const outgoing = this.media(this.activeVariant);
    if (outgoing && outgoing.readyState >= HAVE_METADATA && Number.isFinite(outgoing.currentTime)) {
      this.desiredTimeS = boundedAudioTime(outgoing.currentTime, this.durationS);
    }

    const resume = this.wantsPlaying;
    const generation = this.nextGeneration();
    this.invalidatePlayRequests(generation);
    this.activeVariant = next;
    this.options.onActiveVariant(next);
    this.options.onError(null);
    this.pauseAll();
    this.options.onPlaying(false);
    this.applyDesiredTimeToReadyMedia();
    this.options.onTime(this.desiredTimeS);
    if (resume) void this.requestPlay(next, generation);
  }

  loadedMetadata(variant: AudioPreviewVariant, media: AudioPreviewMedia): void {
    if (!Number.isFinite(media.duration) || media.duration <= 0) return;
    this.measuredDurations[variant] = media.duration;
    const durationS = this.durationS;
    this.desiredTimeS = boundedAudioTime(this.desiredTimeS, durationS);
    this.applyDesiredTimeToReadyMedia();
    this.options.onDuration(durationS);
    this.options.onTime(this.desiredTimeS);
    if (this.wantsPlaying && this.activeVariant === variant) {
      void this.requestPlay(variant, this.generation);
    }
  }

  played(variant: AudioPreviewVariant, media: AudioPreviewMedia): void {
    if (this.disposed || !this.wantsPlaying || this.activeVariant !== variant) {
      media.pause();
      return;
    }
    this.pauseInactive();
    this.options.onPlaying(true);
  }

  paused(variant: AudioPreviewVariant, media: AudioPreviewMedia): void {
    if (this.activeVariant !== variant || !media.paused) return;
    // These elements have no native controls; pauses are initiated by this
    // transport. Time is captured before pausing so a delayed pause event from
    // a switch cannot overwrite the outgoing variant's synchronized position.
    // A delayed event from an earlier generation is also ignored once that
    // element is playing again.
    this.options.onPlaying(false);
  }

  syncFromActiveMedia(): void {
    const active = this.media(this.activeVariant);
    if (!active || active.readyState < HAVE_METADATA || !Number.isFinite(active.currentTime))
      return;
    this.desiredTimeS = boundedAudioTime(active.currentTime, this.durationS);
    this.options.onTime(this.desiredTimeS);
  }

  ended(variant: AudioPreviewVariant): void {
    if (this.activeVariant !== variant) return;
    const generation = this.nextGeneration();
    this.invalidatePlayRequests(generation);
    this.wantsPlaying = false;
    this.desiredTimeS = 0;
    this.applyDesiredTimeToReadyMedia();
    this.pauseAll();
    this.options.onPlaying(false);
    this.options.onTime(0);
  }

  dispose(): void {
    this.disposed = true;
    this.wantsPlaying = false;
    const generation = this.nextGeneration();
    this.invalidatePlayRequests(generation);
    this.pauseAll();
  }
}
