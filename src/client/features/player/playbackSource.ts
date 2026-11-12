/**
 * What the player is showing: its own simulation of the edit, the
 * background-rendered program (base cuts, camera effects, canvas and the
 * final audio chain — layers, overlays and subtitles stay in the DOM), or
 * the fully burned preview, identical to the export.
 */
export type PlaybackMode = 'simulation' | 'engine' | 'proof';

export interface PlaybackModeInput {
  /** The user asked for the burned preview. */
  readonly proofRequested: boolean;
  /** `edit/preview.mp4` exists and matches the document. */
  readonly previewFresh: boolean;
  /** `edit/program.mp4` exists and matches the document's program projection. */
  readonly programFresh: boolean;
}

export function resolvePlaybackMode(input: PlaybackModeInput): PlaybackMode {
  if (input.proofRequested && input.previewFresh) return 'proof';
  if (input.programFresh) return 'engine';
  return 'simulation';
}

export interface PlaybackVersions {
  readonly programVersion: number;
  readonly previewVersion: number;
}

/** Cache-busted URL of the rendered file a non-simulation mode plays. */
export function playbackSourceUrl(
  mode: Exclude<PlaybackMode, 'simulation'>,
  versions: PlaybackVersions,
  mediaUrl: (relPath: string) => string,
): string {
  return mode === 'proof'
    ? `${mediaUrl('edit/preview.mp4')}?v=${String(versions.previewVersion)}`
    : `${mediaUrl('edit/program.mp4')}?v=${String(versions.programVersion)}`;
}
