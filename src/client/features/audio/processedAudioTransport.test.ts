import { describe, expect, it } from 'vitest';
import {
  AudioComparisonTransport,
  type AudioPreviewMedia,
  type AudioPreviewVariant,
} from './processedAudioTransport.js';

class DeferredMedia implements AudioPreviewMedia {
  readyState = 1;
  duration = 24.8;
  currentTime = 0;
  paused = true;
  pauseCalls = 0;
  private readonly pending: { resolve: () => void; reject: (cause: Error) => void }[] = [];

  play(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({
        resolve: () => {
          this.paused = false;
          resolve();
        },
        reject,
      });
    });
  }

  pause(): void {
    this.paused = true;
    this.pauseCalls += 1;
  }

  resolvePlay(index = 0): void {
    const request = this.pending.splice(index, 1)[0];
    if (!request) throw new Error('missing play request');
    request.resolve();
  }
}

function setup(
  before = new DeferredMedia(),
  after = new DeferredMedia(),
): {
  before: DeferredMedia;
  after: DeferredMedia;
  active: AudioPreviewVariant[];
  times: number[];
  playing: boolean[];
  transport: AudioComparisonTransport;
} {
  const media = { before, after };
  const active: AudioPreviewVariant[] = [];
  const times: number[] = [];
  const playing: boolean[] = [];
  const transport = new AudioComparisonTransport({
    fallbackDurationS: 49.6,
    getMedia: (variant) => media[variant],
    onActiveVariant: (variant) => active.push(variant),
    onPlaying: (value) => playing.push(value),
    onTime: (timeS) => times.push(timeS),
    onDuration: () => undefined,
    onError: () => undefined,
  });
  return { before, after, active, times, playing, transport };
}

describe('AudioComparisonTransport', () => {
  it('keeps only the active variant playing across rapid A/B/A switches', async () => {
    const { before, after, transport } = setup();

    transport.togglePlayback(); // after play request 0
    transport.switchVariant('before'); // before play request 0
    transport.switchVariant('after'); // after play request 1

    before.resolvePlay();
    await Promise.resolve();
    expect(before.paused).toBe(true);

    // The superseded request belongs to the now-active element. It may resolve,
    // but must not pause the newer request for that same element.
    after.resolvePlay();
    await Promise.resolve();
    expect(after.paused).toBe(false);

    after.resolvePlay();
    await Promise.resolve();
    expect(after.paused).toBe(false);
    expect(before.paused).toBe(true);
  });

  it('pauses a play request that settles after playback was stopped', async () => {
    const { after, transport } = setup();

    transport.togglePlayback();
    transport.togglePlayback();
    after.resolvePlay();
    await Promise.resolve();

    expect(after.paused).toBe(true);
  });

  it('immediately rejects a play event from the inactive element', () => {
    const { before, after, transport } = setup();

    transport.switchVariant('before');
    after.paused = false;
    transport.played('after', after);

    expect(after.paused).toBe(true);
    expect(before.paused).toBe(true);
  });

  it('ignores a delayed pause event after the same element is playing again', () => {
    const { after, playing, transport } = setup();

    after.paused = false;
    transport.paused('after', after);

    expect(playing).toEqual([]);
  });

  it('retains seek and switch time until delayed metadata is available', async () => {
    const before = new DeferredMedia();
    const after = new DeferredMedia();
    before.readyState = 0;
    after.readyState = 0;
    const { transport, times } = setup(before, after);

    transport.seek(12);
    transport.switchVariant('before');
    transport.togglePlayback();
    expect(before.currentTime).toBe(0);

    before.readyState = 1;
    transport.loadedMetadata('before', before);
    expect(before.currentTime).toBe(12);
    before.resolvePlay();
    await Promise.resolve();
    expect(before.paused).toBe(false);

    after.readyState = 1;
    transport.loadedMetadata('after', after);
    expect(after.currentTime).toBe(12);
    expect(times.at(-1)).toBe(12);
  });
});
