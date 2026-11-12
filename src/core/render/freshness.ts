import { DEFAULT_JOIN_AUDIO_FADE_MS } from '../audioPreviewFreshness.js';
import { baseTrackOf, isLayerBlock, type EditDoc } from '../schema.js';

/**
 * Sources whose bytes enter the program: the base montage, layers that keep
 * their audio, canvas background media and audio-track clips. Overlay files
 * are composed by the browser and never reach the program.
 */
export function programSourceKeys(doc: EditDoc): ReadonlySet<string> {
  const keys = new Set<string>();
  const base = baseTrackOf(doc);
  for (const block of base.blocks) keys.add(block.source);
  for (const track of doc.tracks) {
    if (track.kind === 'audio' && track.muted !== true) {
      for (const block of track.blocks) keys.add(block.source);
    }
    if (track.kind === 'video' && track !== base && track.muted !== true && track.hidden !== true) {
      for (const block of track.blocks) {
        if (isLayerBlock(block) && block.audio !== 'mute') keys.add(block.source);
      }
    }
  }
  // burned into every frame
  if (doc.canvas?.background.kind === 'video') keys.add(doc.canvas.background.source);
  // the denoise profile is learned from the sample's bytes
  if ((doc.output.denoise ?? 0) > 0 && doc.output.denoiseSample !== undefined) {
    keys.add(doc.output.denoiseSample.source);
  }
  return keys;
}

/**
 * Identity of the program render: only what `planRender` reads with
 * `layers: 'omit'`. Overlay tracks, subtitles and the geometry of layer blocks
 * are deliberately absent, so moving an overlay, editing a caption or
 * resizing a PiP never invalidates the rendered program. Mirrors
 * `audioPreviewSemanticKey`; a change here means a re-render for every user.
 */
export function programKey(doc: EditDoc): string {
  const base = baseTrackOf(doc);
  const layerAudio = doc.tracks.slice(1).flatMap((track) => {
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
    return track.blocks;
  });
  const effects = doc.tracks.flatMap((track) =>
    track.kind === 'effect' && track.hidden !== true ? track.blocks : [],
  );
  const sources = [...programSourceKeys(doc)]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => [key, doc.sources[key]?.path ?? null] as const);
  return JSON.stringify({
    fps: doc.fps,
    output: {
      width: doc.output.width,
      height: doc.output.height,
      speed: doc.output.speed ?? 1,
      loudnormLufs: doc.output.loudnormLufs,
      denoise: doc.output.denoise ?? 0,
      denoiseSample: (doc.output.denoise ?? 0) > 0 ? (doc.output.denoiseSample ?? null) : null,
      joinAudioFadeMs: doc.output.joinAudioFadeMs ?? DEFAULT_JOIN_AUDIO_FADE_MS,
      joinAudioCrossfadeMs: doc.output.joinAudioCrossfadeMs ?? 0,
    },
    canvas: doc.canvas ?? null,
    sources,
    base: {
      muted: base.muted === true,
      hidden: base.hidden === true,
      color: base.color ?? null,
      blocks: base.blocks,
    },
    layerAudio,
    audioBlocks,
    effects,
  });
}
