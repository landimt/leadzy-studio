import type { AudioTrack, EditDoc, VideoTrack } from '../../../core/schema.js';

/** Applies `update` to the video track with `trackId`; every other track is returned as-is. */
export function mapVideoTrack(
  doc: EditDoc,
  trackId: string,
  update: (track: VideoTrack) => VideoTrack,
): EditDoc {
  const tracks = doc.tracks.map((track) =>
    track.kind === 'video' && track.id === trackId ? update(track) : track,
  );
  return { ...doc, tracks };
}

/** Applies `update` to the audio track with `trackId`; every other track is returned as-is. */
export function mapAudioTrack(
  doc: EditDoc,
  trackId: string,
  update: (track: AudioTrack) => AudioTrack,
): EditDoc {
  const tracks = doc.tracks.map((track) =>
    track.kind === 'audio' && track.id === trackId ? update(track) : track,
  );
  return { ...doc, tracks };
}
