import type { DebugEntry } from '../features/debug/debugLog.js';
import type { ClipEditorSession } from '../features/timeline/clipRange.js';
import type { DockLayout, DockPanelId } from '../features/shell/dock.js';
import type { api } from '../api.js';
import { type JobType, type ProjectInfo, type RenderJobResult } from '../api.js';
import type { CanvasBackground, EditDoc } from '../../core/schema.js';
import type { Transcript } from '../../core/transcript.js';
import { type WaveformPeaks } from '../../core/peaks.js';
import type { SilenceInterval } from '../../core/silence.js';

export interface Selection {
  readonly trackId: string;
  readonly blockIndex: number;
}

/** A subtitle cue picked on the timeline or player, keyed by its spoken-word range. */
export interface SelectedCue {
  readonly source: string;
  readonly wordStart: number;
  readonly wordEnd: number;
}

export interface JobStatus {
  readonly id: number;
  readonly type: JobType;
  readonly state: 'running' | 'done' | 'error';
  readonly progress?: string;
  readonly error?: string;
}

interface MediaJobResult {
  readonly outputRel: string;
  readonly durationS: number;
  readonly editHash: string;
}

interface AudioPreviewResult extends MediaJobResult {
  readonly outputRel: 'edit/audio-preview.m4a';
  readonly beforeOutputRel: 'edit/audio-preview-before.m4a';
  readonly expectedDurationS: number;
  readonly semanticKey: string;
}

function isMediaJobResult(value: unknown): value is MediaJobResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { outputRel?: unknown; durationS?: unknown; editHash?: unknown };
  return (
    typeof candidate.outputRel === 'string' &&
    typeof candidate.durationS === 'number' &&
    typeof candidate.editHash === 'string'
  );
}

const RENDER_ARTIFACT_KINDS: ReadonlySet<string> = new Set(['program', 'preview', 'final']);

export function isRenderResult(value: unknown): value is RenderJobResult {
  if (!isMediaJobResult(value)) return false;
  const candidate = value as { canonical?: unknown; kind?: unknown; programKey?: unknown };
  return (
    typeof candidate.canonical === 'boolean' &&
    typeof candidate.kind === 'string' &&
    RENDER_ARTIFACT_KINDS.has(candidate.kind) &&
    typeof candidate.programKey === 'string'
  );
}

export function isAudioPreviewResult(value: unknown): value is AudioPreviewResult {
  if (!isMediaJobResult(value)) return false;
  const candidate = value as {
    outputRel: string;
    beforeOutputRel?: unknown;
    expectedDurationS?: unknown;
    semanticKey?: unknown;
  };
  return (
    candidate.outputRel === 'edit/audio-preview.m4a' &&
    candidate.beforeOutputRel === 'edit/audio-preview-before.m4a' &&
    typeof candidate.expectedDurationS === 'number' &&
    typeof candidate.semanticKey === 'string'
  );
}

type AudioPreviewRefreshState = 'idle' | 'debouncing' | 'saving' | 'queued';

export type CutReviewMode = 'suggestions' | 'silences';

export interface SilenceReviewOptions {
  readonly minSilenceS: number;
  readonly interior: boolean;
  readonly edges: boolean;
}

export interface SuggestionReviewOptions {
  readonly silence: boolean;
  readonly repetition: boolean;
  readonly 'false-start': boolean;
  readonly filler: boolean;
}

export type BackgroundFit = Extract<CanvasBackground, { kind: 'image' }>['fit'];

export interface StoreState {
  readonly project: ProjectInfo | null;
  readonly doc: EditDoc | null;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly conflict: boolean;
  readonly agentEdited: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly transcripts: ReadonlyMap<string, Transcript>;
  readonly peaks: ReadonlyMap<string, WaveformPeaks>;
  readonly silences: ReadonlyMap<string, readonly SilenceInterval[]>;
  readonly selection: Selection | null;
  readonly clipEditor: ClipEditorSession | null;
  readonly colorInspectorTarget: { trackId: string; blockIndex?: number } | null;
  /** ⌘/Ctrl+click and Shift+click on the timeline: extra blocks beyond the primary `selection`. Never contains it. */
  readonly extraSelections: readonly Selection[];
  /** UI-only inspector target for the generated subtitle system. */
  readonly subtitleInspectorOpen: boolean;
  /** UI-only inspector target for the root canvas/background configuration. */
  readonly backgroundInspectorOpen: boolean;
  /** Unified suggestions/silences review shown in the right inspector column. */
  readonly cutReviewOpen: boolean;
  readonly cutReviewMode: CutReviewMode;
  readonly suggestionReview: SuggestionReviewOptions;
  readonly silenceReview: SilenceReviewOptions;
  /** Waveform candidates dismissed from the current review session. */
  readonly dismissedSilenceCutKeys: ReadonlySet<string>;
  /** The specific subtitle cue picked on the timeline/player, for the correction UI. */
  readonly selectedCue: SelectedCue | null;
  /** ⌘/Ctrl+click and Shift+click on cues: extra cues beyond the primary `selectedCue`. Never contains it. */
  readonly extraCues: readonly SelectedCue[];
  readonly snapDisabled: boolean;
  readonly activeJobs: ReadonlyMap<JobStatus['type'], JobStatus>;
  readonly renderError: string | null;
  readonly previewOutdated: boolean;
  readonly previewVersion: number;
  /** The live document moved past what `edit/program.mp4` was rendered from. */
  readonly programOutdated: boolean;
  readonly programVersion: number;
  /** Freshness and cache-busting for the independent rendered audio proof. */
  readonly audioPreviewOutdated: boolean;
  readonly audioPreviewVersion: number;
  readonly audioPreviewError: string | null;
  /** Client-side auto-refresh lifecycle; the server job itself remains in `activeJobs`. */
  readonly audioPreviewRefreshState: AudioPreviewRefreshState;
  /** Cache-buster for a final export; intentionally independent of preview freshness. */
  readonly finalVersion: number;
  /** Cache-buster for generated overlay assets; intentionally independent of preview freshness. */
  readonly assetVersion: number;
  readonly loadError: string | null;
  /** Transient notice: the last edit was discarded because it would corrupt the doc. */
  readonly editWarning: string | null;
  /** BRIDGE: derived from `doc.tracks[].hidden` on every state update — kept under this name only until wave 2 migrates components to read the doc field directly. */
  readonly hiddenTracks: ReadonlySet<string>;
  /** Editor-only timeline locks. Track ids plus synthetic subtitle/background keys; never persisted in `EditDoc`. */
  readonly lockedTrackKeys: ReadonlySet<string>;
  readonly exportOpen: boolean;
  /** Set right after a final render's `done` event; drives the success banner. */
  readonly lastRender: {
    readonly outputRel: string;
    readonly durationS: number;
    readonly deliveryPath?: string;
    readonly deliveryName?: string;
  } | null;
  /** Every final export that finished this session, canonical or not — what the export dialog shows as done. */
  readonly lastExport: {
    readonly at: number;
    readonly outputRel: string;
    readonly durationS: number;
    readonly deliveryPath?: string;
    readonly deliveryName?: string;
  } | null;
  /** Set right after a preview render's `done` event; drives the preview viewer + its "ready" banner. */
  readonly lastPreviewRender: { readonly outputRel: string; readonly durationS: number } | null;
  readonly lastAudioPreview: {
    readonly outputRel: 'edit/audio-preview.m4a';
    readonly beforeOutputRel: 'edit/audio-preview-before.m4a';
    readonly durationS: number;
    readonly expectedDurationS: number;
  } | null;
  /** Whether the rendered-preview video dialog is open — separate from `lastPreviewRender` so closing it keeps the "ready" banner around to reopen. */
  readonly previewViewerOpen: boolean;
  readonly historyOpen: boolean;
  /** Where each dockable panel lives and which tab each area shows. Persisted. */
  readonly dockLayout: DockLayout;
  /** The tab being dragged between areas, while the pointer is down. */
  readonly dockDrag: DockPanelId | null;
  /** Bumped whenever the personal library's CONTENTS change, so the panel refetches its list. */
  readonly libraryRevision: number;
  readonly settingsOpen: boolean;
  readonly debugOpen: boolean;
  /** Newest last; what the debug panel lists. */
  readonly debugLog: readonly DebugEntry[];
  /** Project transcription workspace opened from Ferramentas. */
  readonly transcriptionOpen: boolean;
  /** Terminal background-job error kept visible inside the transcription modal. */
  readonly transcriptionError: string | null;
  /** Terminal cut-analysis error kept visible in the review panel. */
  readonly suggestionError: string | null;
  /** Project-level audio processing modal (normalization, denoise and join crossfade). */
  readonly audioOpen: boolean;
  /** Render a preview automatically a few seconds after edits settle. Persisted, default on. */
  readonly autoPreview: boolean;
  /** The player shows the burned preview (identical to the export) whenever it is fresh. */
  readonly proofMode: boolean;
}

export type Listener = () => void;

/** The slice of the HTTP client the store depends on — injectable for tests. */
export type StoreBackend = Pick<
  typeof api,
  'getProject' | 'putEdit' | 'getTranscript' | 'getPeaks' | 'startAudioPreview' | 'subscribe'
>;
