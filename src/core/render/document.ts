import { err, ok, type Result } from '../result.js';
import { type EditDoc } from '../schema.js';
import type { MediaProbe } from '../media.js';
import { denoiseActive } from './options.js';
import { quantizeAudioDuration } from './steps.js';

/**
 * Drops hidden tracks and prunes `sources` down to only the sources a
 * visible video track (base or layer) or audible audio track still references.
 * A muted audio row is absent from the execution document: it cannot affect
 * the mix and therefore must not force an otherwise-unused file to be
 * probed, hashed or resolved. Exported so
 * `render.ts` can apply it BEFORE probing/hashing media — a hidden overlay
 * or layer may point at a file that no longer exists (mid-authoring), and
 * probing it would fail the render for content that was never going to
 * render anyway. Idempotent: filtering an already-filtered doc changes
 * nothing, so `planRender` re-applying it below is always safe.
 */
export function visibleDoc(doc: EditDoc): EditDoc {
  const tracks = doc.tracks.filter((track) =>
    track.kind === 'audio' ? track.muted !== true : track.hidden !== true,
  );
  const referencedSources = new Set<string>();
  for (const track of tracks) {
    if (track.kind !== 'video' && track.kind !== 'audio') continue;
    for (const block of track.blocks) referencedSources.add(block.source);
  }
  // A hand-picked room-tone sample may intentionally come from a source
  // that is not visible in the montage. Keep that one source available for
  // probing/fingerprinting so the renderer can learn its spectral profile.
  if (denoiseActive(doc) && doc.output.denoiseSample !== undefined) {
    referencedSources.add(doc.output.denoiseSample.source);
  }
  const sources = Object.fromEntries(
    Object.entries(doc.sources).filter(([key]) => referencedSources.has(key)),
  );
  const visible = { ...doc, tracks, sources };
  // The generic projection feeds the audio-only A/B path as well as its
  // semantic freshness. Canvas is purely visual, so leaving it attached here
  // would make background images/videos enter that path's immutable lease.
  delete visible.canvas;
  return visible;
}

/**
 * Video-render projection. `visibleDoc` intentionally remains audio-friendly:
 * the A/B proof must never pin, probe or fingerprint a visual-only canvas
 * background. Preview/final rendering uses this projection to retain the one
 * additional authored source that can enter the canvas graph.
 */
export function visibleRenderDoc(doc: EditDoc): EditDoc {
  const audioSafeVisible = visibleDoc(doc);
  const visible: EditDoc =
    doc.canvas === undefined ? audioSafeVisible : { ...audioSafeVisible, canvas: doc.canvas };
  const background = doc.canvas?.background;
  if (background?.kind !== 'video') return visible;
  const source = doc.sources[background.source];
  if (source === undefined) return visible;
  return {
    ...visible,
    sources: { ...visible.sources, [background.source]: source },
  };
}

export function validateCanvasBackground(
  doc: EditDoc,
  probes: ReadonlyMap<string, MediaProbe>,
): Result<null> {
  const background = doc.canvas?.background;
  if (background?.kind !== 'video') return ok(null);
  const source = doc.sources[background.source];
  const probe = probes.get(background.source);
  if (source === undefined || probe === undefined) {
    return err('not-found', `no media information for canvas background "${background.source}"`);
  }
  if (probe.kind !== 'video') {
    return err(
      'invalid-edit-json',
      `canvas background source "${background.source}" has no video stream`,
    );
  }
  return ok(null);
}

/**
 * Shared media preflight for the full render and audio-proof planners.
 * Video rows must not accept audio-only media, and an audible authored window
 * must survive frame-grid quantization before either planner emits `-t`.
 */
export function validateVideoTrackMedia(
  doc: EditDoc,
  probes: ReadonlyMap<string, MediaProbe>,
): Result<null> {
  for (const track of doc.tracks) {
    if (track.kind === 'video') {
      for (const block of track.blocks) {
        if (doc.sources[block.source] === undefined || !probes.has(block.source)) {
          return err('not-found', `no media information for source "${block.source}"`);
        }
        if (probes.get(block.source)?.kind !== 'video') {
          return err(
            'invalid-edit-json',
            `video track "${track.id}" source "${block.source}" has no video stream`,
          );
        }
      }
      continue;
    }
    if (track.kind === 'audio') {
      for (const block of track.blocks) {
        if (quantizeAudioDuration(block.out - block.in, doc.fps) <= 0) {
          return err(
            'invalid-edit-json',
            `audio track "${track.id}" source "${block.source}" quantizes to zero frames at ${String(doc.fps)} fps`,
          );
        }
      }
    }
  }
  return ok(null);
}
