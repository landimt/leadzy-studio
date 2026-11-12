import { baseTrackOf, isLayerBlock, type EditDoc } from './schema.js';

export const DEFAULT_JOIN_AUDIO_FADE_MS = 30;

/**
 * Source ids whose media bytes can enter the audio-only proof.
 *
 * The base montage is audible unless its track is muted. Layer media only
 * enters the mix for visible, unmuted video tracks whose block explicitly
 * ducks or solos. An active manual denoise sample is an audio input too, even
 * when its source is absent from the visible montage.
 */
export function audioPreviewAudibleSourceKeys(doc: EditDoc): ReadonlySet<string> {
  const keys = new Set<string>();
  const base = baseTrackOf(doc);
  if (base.muted !== true) {
    for (const block of base.blocks) keys.add(block.source);
  }

  for (const track of doc.tracks.slice(1)) {
    if (track.kind === 'audio') {
      if (track.muted !== true) {
        for (const block of track.blocks) keys.add(block.source);
      }
      continue;
    }
    if (track.kind === 'video' && track.hidden !== true && track.muted !== true) {
      for (const block of track.blocks) {
        if (isLayerBlock(block) && block.audio !== 'mute') keys.add(block.source);
      }
    }
  }

  if ((doc.output.denoise ?? 0) > 0 && doc.output.denoiseSample !== undefined) {
    keys.add(doc.output.denoiseSample.source);
  }
  return keys;
}

/**
 * Deterministic dependency key for the bytes emitted by planAudioPreview.
 *
 * This deliberately is not editDocHash: effects, overlays, subtitles and
 * other visual authoring metadata do not make an audio proof stale. Keep this
 * projection beside the audio planner's contract and cover every field that
 * changes its montage, timing, audible layers or DSP chain.
 */
export function audioPreviewSemanticKey(doc: EditDoc): string {
  const base = baseTrackOf(doc);
  const baseMuted = base.muted === true;
  const denoise = doc.output.denoise ?? 0;
  const audibleLayers = doc.tracks.slice(1).flatMap((track) => {
    if (track.kind !== 'video' || track.hidden === true || track.muted === true) return [];
    return track.blocks
      .filter(isLayerBlock)
      .filter((block) => block.audio !== 'mute')
      .map((block) => ({
        source: block.source,
        in: block.in,
        out: block.out,
        at: block.at,
        audio: block.audio,
      }));
  });
  const audioBlocks = doc.tracks.flatMap((track) => {
    if (track.kind !== 'audio' || track.muted === true) return [];
    return track.blocks.map((block) => ({
      source: block.source,
      in: block.in,
      out: block.out,
      at: block.at,
      gainDb: block.gainDb ?? 0,
      fadeInS: block.fadeInS ?? 0,
      fadeOutS: block.fadeOutS ?? 0,
    }));
  });

  const sourceKeys = audioPreviewAudibleSourceKeys(doc);
  const sources = [...sourceKeys]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => [key, doc.sources[key]?.path ?? null] as const);

  return JSON.stringify({
    fps: doc.fps,
    output: {
      loudnormLufs: doc.output.loudnormLufs,
      denoise,
      denoiseSample: denoise > 0 ? (doc.output.denoiseSample ?? null) : null,
      // Both controls operate only on joins in the base program. A muted
      // base is synthesized as silence, so changing either value cannot alter
      // the proof.
      joinAudioFadeMs: baseMuted
        ? null
        : (doc.output.joinAudioFadeMs ?? DEFAULT_JOIN_AUDIO_FADE_MS),
      joinAudioCrossfadeMs: baseMuted ? null : (doc.output.joinAudioCrossfadeMs ?? 0),
      speed: doc.output.speed ?? 1,
    },
    sources,
    base: {
      muted: baseMuted,
      blocks: base.blocks.map((block) =>
        baseMuted
          ? {
              duration: block.out - block.in,
              speed: block.speed ?? 1,
            }
          : {
              source: block.source,
              in: block.in,
              out: block.out,
              speed: block.speed ?? 1,
            },
      ),
    },
    audibleLayers,
    audioBlocks,
  });
}
