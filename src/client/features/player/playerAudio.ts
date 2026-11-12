import type { AudioBlock } from '../../../core/schema.js';

/** Keep the live player aligned with the fixed edge de-click used by export. */
const PLAYER_AUDIO_EDGE_FADE_S = 0.03;

const PLAYER_AUDIO_MAX_GAIN_DB = 12;
const PLAYER_AUDIO_MAX_LINEAR_GAIN = 10 ** (PLAYER_AUDIO_MAX_GAIN_DB / 20);
const PAUSED_SEEK_TOLERANCE_S = 0.05;
/** Audible A/V drift becomes obvious well before the looser video decode tolerance. */
const PLAYING_SEEK_TOLERANCE_S = 0.08;

interface PlayerAudioGraph {
  readonly context: AudioContext;
  readonly source: MediaElementAudioSourceNode;
  readonly gain: GainNode;
  connected: boolean;
}

export interface PlayerAudioController {
  /** Idempotent for an element's entire lifetime, including React StrictMode ref cycles. */
  attach(element: HTMLMediaElement): void;
  /** Disconnect without forgetting the one-shot MediaElementSource association. */
  detach(element: HTMLMediaElement): void;
  setGain(element: HTMLMediaElement, linearGain: number): void;
  resume(): Promise<void>;
}

export interface PlayerAudioFrame {
  readonly active: boolean;
  readonly audible: boolean;
  readonly sourceTime: number | null;
  readonly linearGain: number;
}

export interface PlayerAudioSyncInput {
  readonly element: HTMLAudioElement;
  readonly frame: PlayerAudioFrame;
  readonly playing: boolean;
  readonly playbackRate: number;
  readonly controller?: PlayerAudioController | undefined;
}

export type PlayerAudioContextFactory = () => AudioContext | null;

export function dbToPlayerLinearGain(db: number): number {
  return 10 ** (db / 20);
}

/**
 * The render gives inserted audio a 30 ms edge de-click. User fades replace
 * that minimum on their respective edge instead of stacking with it.
 */
export function resolvePlayerAudioFades(
  durationS: number,
  requestedFadeInS = 0,
  requestedFadeOutS = 0,
): { readonly fadeInS: number; readonly fadeOutS: number } {
  const duration = Math.max(0, durationS);
  if (duration === 0) return { fadeInS: 0, fadeOutS: 0 };

  let fadeInS = Math.min(duration, Math.max(0, requestedFadeInS));
  let fadeOutS = Math.min(duration, Math.max(0, requestedFadeOutS));
  const requestedTotal = fadeInS + fadeOutS;
  if (requestedTotal > duration) {
    const scale = duration / requestedTotal;
    fadeInS *= scale;
    fadeOutS *= scale;
  }

  const desiredInS = Math.max(fadeInS, PLAYER_AUDIO_EDGE_FADE_S);
  const desiredOutS = Math.max(fadeOutS, PLAYER_AUDIO_EDGE_FADE_S);
  const extraNeededInS = desiredInS - fadeInS;
  const extraNeededOutS = desiredOutS - fadeOutS;
  const totalExtraNeededS = extraNeededInS + extraNeededOutS;
  const availableExtraS = Math.max(0, duration - fadeInS - fadeOutS);
  if (totalExtraNeededS <= availableExtraS) {
    return { fadeInS: desiredInS, fadeOutS: desiredOutS };
  }
  if (totalExtraNeededS === 0 || availableExtraS === 0) {
    return { fadeInS, fadeOutS };
  }
  return {
    fadeInS: fadeInS + availableExtraS * (extraNeededInS / totalExtraNeededS),
    fadeOutS: fadeOutS + availableExtraS * (extraNeededOutS / totalExtraNeededS),
  };
}

/** Derive the frame-grid-aligned audio-block state from the output clock. */
export function playerAudioFrame(
  block: AudioBlock,
  outputTime: number,
  trackMuted: boolean,
  fps: number,
): PlayerAudioFrame {
  // Same semantics as renderPlan.quantizeAudioDuration(..., fps) at speed=1.
  // Keeping the tiny calculation here avoids pulling renderPlan's Node-only
  // render dependencies into the browser bundle.
  const durationS = Math.round((block.out - block.in) * fps) / fps;
  const relativeTime = outputTime - block.at;
  if (relativeTime < 0 || relativeTime >= durationS) {
    return { active: false, audible: false, sourceTime: null, linearGain: 0 };
  }

  const { fadeInS, fadeOutS } = resolvePlayerAudioFades(durationS, block.fadeInS, block.fadeOutS);
  const fadeInGain = fadeInS > 0 ? Math.min(1, relativeTime / fadeInS) : 1;
  const fadeOutGain =
    fadeOutS > 0 ? Math.min(1, Math.max(0, (durationS - relativeTime) / fadeOutS)) : 1;
  const envelopeGain = Math.min(fadeInGain, fadeOutGain);
  const linearGain = trackMuted ? 0 : dbToPlayerLinearGain(block.gainDb ?? 0) * envelopeGain;

  return {
    active: true,
    audible: !trackMuted,
    sourceTime: block.in + relativeTime,
    linearGain,
  };
}

function createBrowserAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const audioWindow = window as unknown as {
    readonly AudioContext?: typeof AudioContext;
    readonly webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextConstructor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  return AudioContextConstructor ? new AudioContextConstructor() : null;
}

/**
 * Route media elements through Web Audio so gain may exceed the media
 * element's 0..1 `volume` ceiling. The WeakMap is important: browsers throw
 * if `createMediaElementSource()` is called twice for the same element.
 */
export function createPlayerAudioController(
  createContext: PlayerAudioContextFactory = createBrowserAudioContext,
): PlayerAudioController {
  const graphs = new WeakMap<HTMLMediaElement, PlayerAudioGraph>();
  const unroutableElements = new WeakSet<HTMLMediaElement>();
  let context: AudioContext | null = null;
  let contextCreationFailed = false;

  const getContext = (retry: boolean): AudioContext | null => {
    if (context) return context;
    if (contextCreationFailed && !retry) return null;
    try {
      context = createContext();
      contextCreationFailed = context === null;
    } catch {
      contextCreationFailed = true;
      context = null;
    }
    return context;
  };

  const graphFor = (element: HTMLMediaElement): PlayerAudioGraph | null => {
    const existing = graphs.get(element);
    if (existing) {
      if (!existing.connected) {
        existing.source.connect(existing.gain);
        existing.gain.connect(existing.context.destination);
        existing.connected = true;
      }
      return existing;
    }
    if (unroutableElements.has(element)) return null;
    const audioContext = getContext(false);
    if (!audioContext) return null;
    try {
      const source = audioContext.createMediaElementSource(element);
      const gain = audioContext.createGain();
      source.connect(gain);
      gain.connect(audioContext.destination);
      const graph = { context: audioContext, source, gain, connected: true };
      graphs.set(element, graph);
      return graph;
    } catch {
      // The native media element remains a safe unity-or-lower fallback.
      unroutableElements.add(element);
      return null;
    }
  };

  return {
    attach(element): void {
      graphFor(element);
    },
    detach(element): void {
      const graph = graphs.get(element);
      if (graph) {
        graph.gain.gain.value = 0;
        if (graph.connected) {
          graph.source.disconnect();
          graph.gain.disconnect();
          graph.connected = false;
        }
      } else {
        element.muted = true;
        element.volume = 0;
      }
    },
    setGain(element, linearGain): void {
      const boundedGain = Math.min(
        PLAYER_AUDIO_MAX_LINEAR_GAIN,
        Math.max(0, Number.isFinite(linearGain) ? linearGain : 0),
      );
      const graph = graphFor(element);
      if (graph) {
        // `muted` and `volume` can affect the source signal in browsers; the
        // GainNode is the single authority after routing.
        element.muted = false;
        element.volume = 1;
        graph.gain.gain.value = boundedGain;
        return;
      }
      // Web Audio is unavailable: preserve correct mute/fades and attenuated
      // gain. Positive dB cannot be represented by HTMLMediaElement.volume.
      element.muted = boundedGain === 0;
      element.volume = Math.min(1, boundedGain);
    },
    resume(): Promise<void> {
      // Retry construction here because Safari may reject an AudioContext
      // created before the first user gesture.
      const audioContext = getContext(true);
      if (!audioContext || audioContext.state === 'running' || audioContext.state === 'closed') {
        return Promise.resolve();
      }
      return audioContext.resume().catch(() => undefined);
    },
  };
}

export const playerAudioController = createPlayerAudioController();

/** Keep one audio element chased to the output clock; it never drives it. */
export function syncPlayerAudioElement(input: PlayerAudioSyncInput): void {
  const controller = input.controller ?? playerAudioController;
  const { element, frame } = input;
  controller.setGain(element, frame.linearGain);

  if (!frame.active || !frame.audible || frame.sourceTime === null) {
    if (!element.paused) element.pause();
    return;
  }

  if (element.playbackRate !== input.playbackRate) {
    element.playbackRate = input.playbackRate;
  }
  const tolerance = input.playing ? PLAYING_SEEK_TOLERANCE_S : PAUSED_SEEK_TOLERANCE_S;
  if (Math.abs(element.currentTime - frame.sourceTime) > tolerance) {
    try {
      element.currentTime = frame.sourceTime;
    } catch {
      // Metadata may not be loaded on the first frame. Silence this frame and
      // retry the seek on the next RAF instead of playing from source time 0.
      controller.setGain(element, 0);
      if (!element.paused) element.pause();
      return;
    }
  }

  if (input.playing) {
    if (element.paused) void element.play().catch(() => undefined);
  } else if (!element.paused) {
    element.pause();
  }
}
