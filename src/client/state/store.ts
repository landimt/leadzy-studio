import { applyColorPreset, type ColorPresetId, type ColorTarget } from '../../core/colorPresets.js';
import type { VideoColor } from '../../core/schema.js';
import { appendDebugEntry, describeServerEvent } from '../features/debug/debugLog.js';
import {
  applyClipRange,
  clipRangeInfo,
  type ClipEditorSession,
  type ClipRange,
} from '../features/timeline/clipRange.js';
import {
  activatePanel,
  areaOf,
  DOCK_PRESET_LAYOUT,
  type DockPresetId,
  type DockAreaId,
  type DockLayout,
  type DockPanelId,
  isPanelActive,
  moveTab,
  moveTabToArea,
} from '../features/shell/dock.js';
import { readDockLayout, writeDockLayout } from '../features/shell/dockPreference.js';
import { api, ApiError, type MediaSummary, type ProjectInfo, type ServerEvent } from '../api.js';
import { CoalescingHistory } from './history.js';
import {
  appendToBase,
  deleteBlocks,
  insertIntoBase,
  moveTimedBlock,
  nudgeSelectedBlock,
  reorderBaseBlock,
  resizeTimedBlock,
  setBlockSpeed,
  setBlockTransition,
  setSelectedTransform,
  splitAtPlayhead,
  trimAtPlayhead,
  trimSelectedEdge,
  updateOverlayBlock,
  updateSelectedLayerBlock,
} from './edits/blocks.js';
import {
  correctWord,
  hideCues,
  hideSubtitleRange,
  restoreWords,
  setSubtitleMargin,
  setSubtitlePreset,
  strikeWords,
  unhideSubtitleRange,
  updateSubtitleSettings,
} from './edits/subtitles.js';
import {
  addAudioClip,
  addEmptyTrack,
  addLayer,
  addOverlayImage,
  removeTrack,
  reorderTrack,
  setTrackHidden,
  setTrackMuted,
} from './edits/tracks.js';
import {
  ensureBackground,
  removeBackground,
  setBackgroundColor,
  setBackgroundFit,
  setBackgroundImage,
  setBackgroundVideo,
  setBackgroundVideoSource,
  setCanvasBaseCell,
  setCanvasBaseMode,
  setOutputSize,
  updateLayerCell,
} from './edits/canvas.js';
import {
  addEffect,
  addFlashEffect,
  addShakeEffect,
  addZoomEffect,
  updateEffectBlock,
  type EffectAddition,
  type EffectPatch,
} from './edits/effects.js';
import {
  setAudioBlockFades,
  setAudioBlockGain,
  setDenoise,
  setDenoiseSample,
  setJoinAudioCrossfadeMs,
  setLoudnormLufs,
  setOutputSpeed,
  type AudioFadePatch,
} from './edits/audio.js';
import {
  acceptAllSuggestions,
  acceptSuggestions,
  computeSilenceCuts,
  cutSilences,
  cutSuggestionInterval,
  rejectSuggestions,
  silenceCutKey,
  type SilenceCut,
  type SilenceCutKinds,
} from './edits/suggestions.js';
import { t } from '../i18n/index.js';
import type {
  BlockTransition,
  CanvasConfig,
  EditDoc,
  EffectBlock,
  LayerCell,
  OverlayBlock,
  Suggestion,
  VideoTrack,
  DenoiseSample,
} from '../../core/schema.js';
import { baseTrackOf, parseEditDoc, SHAKE_DEFAULT_INTENSITY } from '../../core/schema.js';
import type { Transcript } from '../../core/transcript.js';
import { refineTranscript, spokenWords } from '../../core/transcript.js';
import { silencesFromPeaks, type WaveformPeaks } from '../../core/peaks.js';
import type { SilenceInterval } from '../../core/silence.js';
import { audioPreviewSemanticKey } from '../../core/audioPreviewFreshness.js';
import { programKey } from '../../core/render/freshness.js';
import {
  applySuggestion,
  outputSegments,
  rejectSuggestion,
  snapEdge,
  withRecomputedDuration,
  type BlockEdge,
  type SnapResult,
  type WordRange,
} from '../../core/timeline.js';
import {
  SUBTITLE_EDITOR_TRACK_KEY,
  BACKGROUND_EDITOR_TRACK_KEY,
  AUTO_PREVIEW_STORAGE_KEY,
  AUDIO_PREVIEW_DEBOUNCE_MS,
  readAutoPreviewDefault,
  hiddenTracksOf,
  lockedTrackKeysForDoc,
  sourceKeysReferencedOutsideCanvas,
  changesLockedTimelineContent,
} from './docEdits.js';
import type {
  Selection,
  SelectedCue,
  JobStatus,
  BackgroundFit,
  StoreState,
  Listener,
  StoreBackend,
} from './storeState.js';
import { isRenderResult, isAudioPreviewResult } from './storeState.js';
import { playhead } from './playhead.js';

/** DataTransfer MIME type for dragging a library item card onto the timeline — shared so drag source (TranscriptPanel) and drop target (Timeline) agree on the key. */

function programOutdatedFor(doc: EditDoc | null, project: ProjectInfo | null): boolean {
  if (doc === null || project === null) return false;
  return !(project.hasProgram && programKey(doc) === project.programKey);
}

/** A different `edit/program.mp4` is on disk — the player must reload it. */
function programArtifactChanged(previous: ProjectInfo | null, next: ProjectInfo): boolean {
  return previous?.hasProgram !== next.hasProgram || previous.programKey !== next.programKey;
}

export class EditorStore {
  constructor(private readonly backend: StoreBackend = api) {}

  private state: StoreState = {
    project: null,
    doc: null,
    dirty: false,
    saving: false,
    conflict: false,
    agentEdited: false,
    undoDepth: 0,
    redoDepth: 0,
    transcripts: new Map(),
    peaks: new Map(),
    silences: new Map(),
    selection: null,
    clipEditor: null,
    colorInspectorTarget: null,
    extraSelections: [],
    subtitleInspectorOpen: false,
    backgroundInspectorOpen: false,
    cutReviewOpen: false,
    cutReviewMode: 'suggestions',
    suggestionReview: { silence: true, repetition: true, 'false-start': true, filler: true },
    silenceReview: { minSilenceS: 0.5, interior: true, edges: true },
    dismissedSilenceCutKeys: new Set(),
    selectedCue: null,
    extraCues: [],
    snapDisabled: false,
    activeJobs: new Map(),
    renderError: null,
    previewOutdated: false,
    previewVersion: 0,
    programOutdated: false,
    programVersion: 0,
    audioPreviewOutdated: false,
    audioPreviewVersion: 0,
    audioPreviewError: null,
    audioPreviewRefreshState: 'idle',
    finalVersion: 0,
    assetVersion: 0,
    loadError: null,
    editWarning: null,
    hiddenTracks: new Set(),
    lockedTrackKeys: new Set(),
    exportOpen: false,
    lastRender: null,
    lastExport: null,
    lastPreviewRender: null,
    lastAudioPreview: null,
    previewViewerOpen: false,
    historyOpen: false,
    dockLayout: readDockLayout(),
    dockDrag: null,
    libraryRevision: 0,
    settingsOpen: false,
    debugOpen: false,
    debugLog: [],
    transcriptionOpen: false,
    transcriptionError: null,
    suggestionError: null,
    audioOpen: false,
    autoPreview: readAutoPreviewDefault(),
    proofMode: false,
  };

  private readonly listeners = new Set<Listener>();
  private readonly history = new CoalescingHistory<EditDoc>();
  private lastSavedHash = '';
  private renderedDocJson: string | null = null;
  /**
   * Program projection of the document whose last render failed. The
   * background render waits for the document to move past it — retrying the
   * same document would fail the same way, forever.
   */
  private programRenderFailedKey: string | null = null;
  /**
   * Program projection the auto-preview asked to render, captured at the
   * request. Null while the running render is a user preview or a final
   * export — their failures say nothing about the program — and after a page
   * reload mid-render, where one more attempt is the accepted cost.
   */
  private renderingProgramKey: string | null = null;
  /** Audible projection that produced the currently published A/B pair. */
  private audioPreviewDocKey: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private audioPreviewTimer: ReturnType<typeof setTimeout> | null = null;
  private audioPreviewQueued = false;
  private audioPreviewRequestInFlight = false;
  private hasSeenJobsSnapshot = false;
  private initPromise: Promise<void> | null = null;
  private eventUnsubscribe: (() => void) | null = null;
  private jobEventRevision = 0;
  private jobsReconcileEpoch = 0;
  private documentRevision = 0;
  private documentReloadEpoch = 0;
  private derivedDataEpoch = 0;
  private readonly lastTerminalJobId = new Map<JobStatus['type'], number>();
  /** Serializes HTTP saves so every request uses the hash returned by its predecessor. */
  private saveChain: Promise<void> = Promise.resolve();
  private warningTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `requestPreviewRender` — distinguishes a user-clicked Preview from the silent 5s auto-preview, so only the former can pop the viewer open. */
  private previewRequestedByUser = false;
  /** Last non-null LUFS target the user picked — seeded from the loaded doc, updated on every `setLoudnormLufs` call. Backs `setLoudnormEnabled`'s "on" restore value. */
  private lastLoudnormLufs = -14;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): StoreState => this.state;

  private set(partial: Partial<StoreState>): void {
    if (partial.doc !== undefined) this.documentRevision += 1;
    const merged = { ...this.state, ...partial };
    const lockedTrackKeys = lockedTrackKeysForDoc(merged.lockedTrackKeys, merged.doc);
    const validSelections = [merged.selection, ...merged.extraSelections].filter(
      (selection): selection is Selection =>
        selection !== null &&
        !lockedTrackKeys.has(selection.trackId) &&
        (merged.doc?.tracks.some(
          (track) =>
            track.id === selection.trackId &&
            Number.isInteger(selection.blockIndex) &&
            selection.blockIndex >= 0 &&
            selection.blockIndex < track.blocks.length,
        ) ??
          false),
    );
    const subtitlesLocked = lockedTrackKeys.has(SUBTITLE_EDITOR_TRACK_KEY);
    const backgroundLocked = lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY);
    this.state = {
      ...merged,
      hiddenTracks: hiddenTracksOf(merged.doc),
      lockedTrackKeys,
      selection: validSelections[0] ?? null,
      extraSelections: validSelections.slice(1),
      ...(subtitlesLocked
        ? { subtitleInspectorOpen: false, selectedCue: null, extraCues: [] }
        : {}),
      backgroundInspectorOpen:
        merged.backgroundInspectorOpen &&
        merged.doc?.canvas !== undefined &&
        !backgroundLocked &&
        merged.selection === null &&
        !merged.subtitleInspectorOpen &&
        merged.selectedCue === null,
    };
    for (const listener of this.listeners) listener();
  }

  init(): Promise<void> {
    if (this.initPromise !== null) return this.initPromise;
    const task = this.initialize();
    this.initPromise = task;
    void task.then(() => {
      // StartupScreen's Retry must be able to make a new request after an
      // initial project-load failure. Successful initialization stays pinned
      // so React StrictMode cannot create a second EventSource.
      if (this.state.doc === null) this.initPromise = null;
    });
    return task;
  }

  private async initialize(): Promise<void> {
    try {
      const project = await this.backend.getProject();
      const previewCurrent =
        project.hasPreview &&
        project.doc !== null &&
        project.editHash !== null &&
        project.previewEditHash === project.editHash;
      const audioPreviewCurrent =
        project.hasAudioComparison && project.doc !== null && project.audioPreviewCurrent;
      const projectDocJson = project.doc === null ? null : JSON.stringify(project.doc);
      this.renderedDocJson = previewCurrent ? projectDocJson : null;
      this.audioPreviewDocKey = audioPreviewCurrent ? audioPreviewSemanticKey(project.doc) : null;
      this.set({
        project,
        doc: project.doc,
        dismissedSilenceCutKeys: new Set(),
        previewOutdated: project.hasPreview && project.doc !== null && !previewCurrent,
        programOutdated: programOutdatedFor(project.doc, project),
        audioPreviewOutdated:
          project.hasAudioComparison && project.doc !== null && !audioPreviewCurrent,
      });
      if (project.doc && project.doc.output.loudnormLufs !== null) {
        this.lastLoudnormLufs = project.doc.output.loudnormLufs;
      }
      if (project.editHash) this.lastSavedHash = project.editHash;
      // Subscribe before the potentially slow transcript/waveform hydration.
      // React already has a document to render at this point, so no job event
      // may be allowed to fall into that interactive initialization window.
      this.eventUnsubscribe = this.backend.subscribe((event) => {
        this.handleEvent(event);
      });
      await this.loadDerivedData(project);
    } catch (error) {
      this.set({ loadError: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Primarily for HMR/tests; the app-wide singleton otherwise lives for the page lifetime. */
  dispose(): void {
    this.eventUnsubscribe?.();
    this.eventUnsubscribe = null;
    this.initPromise = null;
    this.hasSeenJobsSnapshot = false;
  }

  private async loadDerivedData(project: ProjectInfo): Promise<void> {
    const epoch = ++this.derivedDataEpoch;
    const doc = project.doc;
    if (!doc) return;
    const transcripts = new Map<string, Transcript>();
    const peaks = new Map<string, WaveformPeaks>();
    const silences = new Map<string, readonly SilenceInterval[]>();
    for (const key of sourceKeysReferencedOutsideCanvas(doc)) {
      const source = doc.sources[key];
      if (!source) continue;
      const [transcript, sourcePeaks] = await Promise.all([
        this.backend.getTranscript(source.path),
        this.backend.getPeaks(source.path).catch(() => null),
      ]);
      if (sourcePeaks) {
        peaks.set(key, sourcePeaks);
        silences.set(key, silencesFromPeaks(sourcePeaks));
      }
      if (transcript) {
        const sourceSilences = sourcePeaks ? silencesFromPeaks(sourcePeaks) : [];
        transcripts.set(key, refineTranscript(transcript, sourceSilences));
      }
    }
    if (epoch === this.derivedDataEpoch) this.set({ transcripts, peaks, silences });
  }

  // --- document editing -------------------------------------------------------

  /**
   * Every discrete edit goes through here: undo snapshot + autosave debounce.
   * A continuous gesture (canvas drag, slider) passes a coalesceKey — while the
   * same key repeats, the whole gesture stays ONE undo step; any other edit,
   * undo/redo or endGesture() closes it.
   */
  applyDoc(next: EditDoc, coalesceKey?: string): void {
    const current = this.state.doc;
    if (!current) return;
    const recomputed = withRecomputedDuration(next);
    if (changesLockedTimelineContent(current, recomputed, this.state.lockedTrackKeys)) return;
    const validated = parseEditDoc(recomputed);
    if (!validated.ok) {
      console.warn('operação descartada — documento ficaria inválido:', validated.error.message);
      this.flashEditWarning();
      return;
    }
    this.history.record(current, coalesceKey);
    const audioPreviewChanged =
      audioPreviewSemanticKey(current) !== audioPreviewSemanticKey(recomputed);
    this.set({
      doc: recomputed,
      dirty: true,
      undoDepth: this.history.undoDepth,
      redoDepth: 0,
      previewOutdated: JSON.stringify(recomputed) !== this.renderedDocJson,
      programOutdated: programOutdatedFor(recomputed, this.state.project),
      audioPreviewOutdated:
        this.state.project?.hasAudioComparison === true &&
        audioPreviewSemanticKey(recomputed) !== this.audioPreviewDocKey,
    });
    this.scheduleSave();
    if (audioPreviewChanged) this.scheduleAudioPreviewRefresh();
  }

  /** The pointer went up: the next coalesced edit starts a fresh undo step. */
  endGesture(): void {
    this.history.endGesture();
  }

  private flashEditWarning(): void {
    this.set({ editWarning: t('edit.discarded') });
    if (this.warningTimer) clearTimeout(this.warningTimer);
    this.warningTimer = setTimeout(() => {
      this.warningTimer = null;
      this.set({ editWarning: null });
    }, 4000);
  }

  undo(): void {
    const current = this.state.doc;
    if (!current) return;
    const previous = this.history.undo(current);
    if (!previous) return;
    if (changesLockedTimelineContent(current, previous, this.state.lockedTrackKeys)) {
      // `CoalescingHistory` has no peek API. Reverse the speculative pop so a
      // blocked undo is invisible to both the document and history depths.
      this.history.redo(previous);
      return;
    }
    this.set({
      doc: previous,
      dirty: true,
      undoDepth: this.history.undoDepth,
      redoDepth: this.history.redoDepth,
      // undo/redo can shift or remove blocks the extras pointed at — drop them rather than risk stale indices.
      extraSelections: [],
      extraCues: [],
      previewOutdated: JSON.stringify(previous) !== this.renderedDocJson,
      programOutdated: programOutdatedFor(previous, this.state.project),
      audioPreviewOutdated:
        this.state.project?.hasAudioComparison === true &&
        audioPreviewSemanticKey(previous) !== this.audioPreviewDocKey,
    });
    this.scheduleSave();
    if (audioPreviewSemanticKey(current) !== audioPreviewSemanticKey(previous)) {
      this.scheduleAudioPreviewRefresh();
    }
  }

  redo(): void {
    const current = this.state.doc;
    if (!current) return;
    const next = this.history.redo(current);
    if (!next) return;
    if (changesLockedTimelineContent(current, next, this.state.lockedTrackKeys)) {
      // Symmetric rollback of the speculative redo pop; see `undo()` above.
      this.history.undo(next);
      return;
    }
    this.set({
      doc: next,
      dirty: true,
      undoDepth: this.history.undoDepth,
      redoDepth: this.history.redoDepth,
      extraSelections: [],
      extraCues: [],
      previewOutdated: JSON.stringify(next) !== this.renderedDocJson,
      programOutdated: programOutdatedFor(next, this.state.project),
      audioPreviewOutdated:
        this.state.project?.hasAudioComparison === true &&
        audioPreviewSemanticKey(next) !== this.audioPreviewDocKey,
    });
    this.scheduleSave();
    if (audioPreviewSemanticKey(current) !== audioPreviewSemanticKey(next)) {
      this.scheduleAudioPreviewRefresh();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 500);
  }

  /**
   * Coalesces audio-control gestures into one lightweight A/B render. The
   * desired refresh stays queued while the previous job is running; its old
   * pair remains playable until the replacement job completes.
   */
  private scheduleAudioPreviewRefresh(): void {
    this.audioPreviewQueued = true;
    if (this.audioPreviewTimer) clearTimeout(this.audioPreviewTimer);
    const blocked = this.audioPreviewRequestInFlight || this.state.activeJobs.has('audio-preview');
    this.set({
      audioPreviewError: null,
      audioPreviewRefreshState: blocked ? 'queued' : 'debouncing',
    });
    this.audioPreviewTimer = setTimeout(() => {
      this.audioPreviewTimer = null;
      void this.startQueuedAudioPreview();
    }, AUDIO_PREVIEW_DEBOUNCE_MS);
  }

  private async startQueuedAudioPreview(): Promise<boolean> {
    if (!this.audioPreviewQueued) return false;
    if (this.audioPreviewRequestInFlight || this.state.activeJobs.has('audio-preview')) {
      this.set({ audioPreviewRefreshState: 'queued' });
      return false;
    }

    this.audioPreviewQueued = false;
    this.audioPreviewRequestInFlight = true;
    this.set({ audioPreviewRefreshState: 'saving', audioPreviewError: null });
    try {
      if (!(await this.flushSave())) {
        this.set({
          audioPreviewRefreshState: 'idle',
          audioPreviewError: t('audio.audioPreview.saveFailed'),
        });
        return false;
      }
      if (this.state.activeJobs.has('audio-preview')) {
        this.audioPreviewQueued = true;
        this.set({ audioPreviewRefreshState: 'queued' });
        return false;
      }
      await this.backend.startAudioPreview();
      return true;
    } catch (cause) {
      this.set({
        audioPreviewRefreshState: 'idle',
        audioPreviewError: cause instanceof Error ? cause.message : String(cause),
      });
      return false;
    } finally {
      this.audioPreviewRequestInFlight = false;
      if (
        !this.audioPreviewQueued &&
        !this.state.activeJobs.has('audio-preview') &&
        this.state.audioPreviewRefreshState === 'saving'
      ) {
        this.set({ audioPreviewRefreshState: 'idle' });
      }
    }
  }

  /** User-triggered retry/update; bypasses the debounce but shares the same save/job guards. */
  async requestAudioPreview(): Promise<boolean> {
    if (this.audioPreviewTimer) {
      clearTimeout(this.audioPreviewTimer);
      this.audioPreviewTimer = null;
    }
    this.audioPreviewQueued = true;
    return this.startQueuedAudioPreview();
  }

  private resumeQueuedAudioPreview(): void {
    if (!this.audioPreviewQueued) {
      this.set({ audioPreviewRefreshState: 'idle' });
      return;
    }
    if (this.audioPreviewTimer) {
      this.set({ audioPreviewRefreshState: 'debouncing' });
      return;
    }
    void this.startQueuedAudioPreview();
  }

  async save(): Promise<void> {
    const task = this.saveChain.then(() => this.persistLatest());
    this.saveChain = task.catch(() => undefined);
    return task;
  }

  private async persistLatest(): Promise<void> {
    const doc = this.state.doc;
    if (!doc || !this.state.dirty || this.state.conflict) return;
    const savedDocJson = JSON.stringify(doc);
    const expectHash = this.lastSavedHash;
    this.set({ saving: true });
    try {
      const { hash } = await this.backend.putEdit(doc, expectHash);
      this.lastSavedHash = hash;
      // A slider/drag may have produced a newer document while this request
      // was in flight. Only the exact document acknowledged by the server is
      // clean; the queued debounce/flush will persist the newer one next.
      const currentMatchesSaved =
        this.state.doc !== null && JSON.stringify(this.state.doc) === savedDocJson;
      this.set({ saving: false, dirty: !currentMatchesSaved });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 428)) {
        this.set({ saving: false, conflict: true });
        return;
      }
      let message = error instanceof Error ? error.message : String(error);
      if (message.includes('Unrecognized key')) {
        message += ' — servidor com schema antigo: feche (Ctrl+C) e rode studio open de novo';
      }
      this.set({ saving: false, loadError: message });
    }
  }

  /**
   * Cancels the pending autosave debounce and, if dirty, saves right now.
   * Returns whether the doc is really persisted — a failed save leaves the
   * banner up and the caller MUST abort its job instead of running against
   * the stale file on disk.
   */
  async flushSave(): Promise<boolean> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.state.dirty) return true;
    await this.save();
    return !this.state.dirty;
  }

  /**
   * Replaces optimistic SSE state with the server's authoritative running-job
   * snapshot. Every EventSource reconnection receives one, so a terminal event
   * lost while offline cannot leave controls blocked forever.
   */
  private handleJobsSnapshot(event: Extract<ServerEvent, { kind: 'jobs-snapshot' }>): void {
    const previousJobs = this.state.activeJobs;
    const activeJobs = new Map<JobStatus['type'], JobStatus>();
    for (const job of event.jobs) {
      if (job.state !== 'running') continue;
      activeJobs.set(job.type, {
        id: job.id,
        type: job.type,
        state: 'running',
        ...(job.progress !== undefined ? { progress: job.progress } : {}),
      });
    }

    const reconnect = this.hasSeenJobsSnapshot;
    this.hasSeenJobsSnapshot = true;
    this.set({
      activeJobs,
      ...(activeJobs.has('transcribe') ? { transcriptionError: null } : {}),
      ...(activeJobs.has('suggest') ? { suggestionError: null } : {}),
    });
    if (!reconnect) return;

    // Hold the audio queue until project receipts have been reconciled. This
    // also covers a debounce timer firing while the reconnect fetch is active.
    this.audioPreviewRequestInFlight = true;
    const reconcileEpoch = ++this.jobsReconcileEpoch;
    void this.reconcileAfterJobsSnapshot(
      previousJobs,
      activeJobs,
      this.jobEventRevision,
      reconcileEpoch,
    );
  }

  private async reconcileAfterJobsSnapshot(
    previousJobs: ReadonlyMap<JobStatus['type'], JobStatus>,
    activeJobs: ReadonlyMap<JobStatus['type'], JobStatus>,
    eventRevision: number,
    reconcileEpoch: number,
  ): Promise<void> {
    const audioMayHaveCompleted =
      previousJobs.has('audio-preview') && !activeJobs.has('audio-preview');
    const renderMayHaveCompleted = previousJobs.has('render') && !activeJobs.has('render');
    const savedHash = this.lastSavedHash;
    try {
      const project = await this.backend.getProject();
      // A newer running/terminal event is more authoritative than a GET that
      // may have been captured before artifact promotion. Its handler (and the
      // finally block below for queued audio) now owns reconciliation.
      if (
        eventRevision !== this.jobEventRevision ||
        reconcileEpoch !== this.jobsReconcileEpoch ||
        savedHash !== this.lastSavedHash
      ) {
        return;
      }
      const serverDocChanged =
        project.editHash !== null &&
        this.lastSavedHash !== '' &&
        project.editHash !== this.lastSavedHash;

      const oldProject = this.state.project;
      const programChanged = programArtifactChanged(oldProject, project);
      if (serverDocChanged) {
        if (this.state.dirty) {
          this.set({
            project,
            conflict: true,
            programOutdated: programOutdatedFor(this.state.doc, project),
            ...(programChanged ? { programVersion: this.state.programVersion + 1 } : {}),
          });
        } else {
          // `project` is already the response protected by both revision and
          // reconciliation epoch. Re-fetching here would open a second,
          // unguarded window in which a pre-promotion response could arrive
          // after a newer terminal event and hide its artifacts.
          await this.applyReloadedProject(project, false, true);
        }
      } else {
        const doc = this.state.doc;
        const previewReceiptCurrent =
          project.hasPreview &&
          doc !== null &&
          project.editHash !== null &&
          project.previewEditHash === project.editHash;
        const previewCurrent = !this.state.dirty && previewReceiptCurrent;
        const authoritativeAudioKey =
          project.doc === null ? null : audioPreviewSemanticKey(project.doc);
        const localAudioKey = doc === null ? null : audioPreviewSemanticKey(doc);
        const audioPreviewReceiptCurrent =
          project.hasAudioComparison &&
          project.audioPreviewCurrent &&
          authoritativeAudioKey !== null;
        const audioPreviewCurrent =
          audioPreviewReceiptCurrent &&
          localAudioKey !== null &&
          localAudioKey === authoritativeAudioKey;
        let audioArtifactChanged = audioMayHaveCompleted;
        let previewArtifactChanged = renderMayHaveCompleted;
        if (oldProject === null) {
          audioArtifactChanged = true;
          previewArtifactChanged = true;
        } else {
          audioArtifactChanged ||=
            oldProject.hasAudioComparison !== project.hasAudioComparison ||
            oldProject.audioPreviewEditHash !== project.audioPreviewEditHash;
          previewArtifactChanged ||=
            oldProject.hasPreview !== project.hasPreview ||
            oldProject.previewEditHash !== project.previewEditHash;
        }
        // The GET carries the authoritative saved document whose hash the
        // receipts reference. Use that snapshot even while the local document
        // is dirty; it lets undo/freshness and the audio-only gate compare
        // against the exact artifact rather than an absent or speculative doc.
        const authoritativeDocJson = project.doc === null ? null : JSON.stringify(project.doc);
        this.renderedDocJson = previewReceiptCurrent ? authoritativeDocJson : null;
        this.audioPreviewDocKey = audioPreviewReceiptCurrent ? authoritativeAudioKey : null;
        this.set({
          project,
          // With no artifact, a reconnect must not erase a pending visual
          // edit or advance its baseline before the 5s auto-preview fires.
          previewOutdated: project.hasPreview
            ? doc !== null && !previewCurrent
            : this.state.previewOutdated,
          programOutdated: programOutdatedFor(doc, project),
          audioPreviewOutdated: project.hasAudioComparison && doc !== null && !audioPreviewCurrent,
          ...(audioPreviewCurrent ? { audioPreviewError: null } : {}),
          ...(previewArtifactChanged
            ? {
                previewVersion: this.state.previewVersion + 1,
                finalVersion: this.state.finalVersion + 1,
              }
            : {}),
          ...(audioArtifactChanged
            ? { audioPreviewVersion: this.state.audioPreviewVersion + 1 }
            : {}),
          ...(programChanged ? { programVersion: this.state.programVersion + 1 } : {}),
        });
      }
    } catch (error) {
      if (reconcileEpoch === this.jobsReconcileEpoch) {
        this.set({ loadError: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      // Only the latest reconnect owns this gate. An older GET resolving last
      // must neither overwrite state nor release a queue held by its successor.
      if (reconcileEpoch === this.jobsReconcileEpoch) {
        this.audioPreviewRequestInFlight = false;
        if (!activeJobs.has('audio-preview')) this.resumeQueuedAudioPreview();
      }
    }
  }

  // --- external events --------------------------------------------------------

  private acceptsJobEvent(event: Extract<ServerEvent, { kind: 'job' }>): boolean {
    const lastTerminalId = this.lastTerminalJobId.get(event.type);
    if (lastTerminalId !== undefined && event.id <= lastTerminalId) return false;
    if (event.state === 'running') {
      const active = this.state.activeJobs.get(event.type);
      // A delayed progress event from an older job must not replace the
      // authoritative newer ID installed by a reconnect snapshot.
      return active === undefined || event.id >= active.id;
    }

    const active = this.state.activeJobs.get(event.type);
    if (active !== undefined && active.id !== event.id) {
      // IDs grow monotonically for a given server process. Remember an older
      // stale terminal without allowing it to erase the newer active job.
      if (event.id < active.id) this.lastTerminalJobId.set(event.type, event.id);
      return false;
    }
    this.lastTerminalJobId.set(event.type, event.id);
    return true;
  }

  private handleEvent(event: ServerEvent): void {
    this.set({
      debugLog: appendDebugEntry(this.state.debugLog, {
        at: Date.now(),
        ...describeServerEvent(event),
      }),
    });
    if (event.kind === 'jobs-snapshot') {
      this.handleJobsSnapshot(event);
      return;
    }
    if (event.kind === 'artifacts-changed') {
      // Reconcile receipts without reloading the document or clearing undo.
      // The same revision guard as reconnect ignores stale GET responses.
      this.audioPreviewRequestInFlight = true;
      void this.reconcileAfterJobsSnapshot(
        this.state.activeJobs,
        this.state.activeJobs,
        this.jobEventRevision,
        ++this.jobsReconcileEpoch,
      );
      return;
    }
    if (event.kind === 'edit-changed') {
      if (event.hash === this.lastSavedHash) return;
      if (!event.external) {
        // Internal write we didn't originate ourselves (title job, suggest
        // job, restore route): if we have no unsaved edits, pick it up
        // silently — no conflict banner, no agent badge. If we're dirty, the
        // job's own 'done' event reloads once the doc is settled.
        if (!this.state.dirty) void this.reloadFromServer(false);
        return;
      }
      if (this.state.dirty) {
        this.set({ conflict: true });
      } else {
        void this.reloadFromServer(true);
      }
      return;
    }
    if (event.kind === 'assets-changed') {
      this.set({ assetVersion: this.state.assetVersion + 1 });
      return;
    }
    if (!this.acceptsJobEvent(event)) return;
    this.jobEventRevision += 1;
    const status: JobStatus = {
      id: event.id,
      type: event.type,
      state: event.state,
      ...(event.progress !== undefined ? { progress: event.progress } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
    };
    if (event.state === 'running') {
      const activeJobs = new Map(this.state.activeJobs);
      activeJobs.set(event.type, status);
      this.set({
        activeJobs,
        ...(event.type === 'render'
          ? {
              renderError: null,
              lastRender: null,
              lastPreviewRender: null,
              previewViewerOpen: false,
            }
          : {}),
        ...(event.type === 'audio-preview'
          ? {
              audioPreviewError: null,
              audioPreviewRefreshState: this.audioPreviewQueued ? 'queued' : 'idle',
            }
          : {}),
        ...(event.type === 'transcribe' ? { transcriptionError: null } : {}),
        ...(event.type === 'suggest' ? { suggestionError: null } : {}),
      });
      if (event.type === 'audio-preview') this.audioPreviewRequestInFlight = false;
      return;
    }
    if (event.state === 'error') {
      const activeJobs = new Map(this.state.activeJobs);
      activeJobs.delete(event.type);
      // The failed render is the one `requestPreviewRender` was tracking (if any) —
      // drop the flag here too, or a later unrelated preview (even a silent
      // auto-preview) would wrongly inherit this request and pop the viewer open.
      if (event.type === 'render') {
        this.previewRequestedByUser = false;
        this.programRenderFailedKey = this.renderingProgramKey;
        this.renderingProgramKey = null;
      }
      this.set({
        activeJobs,
        ...(event.type === 'render' ? { renderError: event.error ?? t('jobs.unknownError') } : {}),
        ...(event.type === 'audio-preview'
          ? { audioPreviewError: event.error ?? t('jobs.unknownError') }
          : {}),
        ...(event.type === 'transcribe'
          ? { transcriptionError: event.error ?? t('jobs.unknownError') }
          : {}),
        ...(event.type === 'suggest'
          ? { suggestionError: event.error ?? t('jobs.unknownError') }
          : {}),
      });
      if (event.type === 'audio-preview') {
        this.audioPreviewRequestInFlight = false;
        this.resumeQueuedAudioPreview();
      }
      // A failed bake has no banner of its own; without this the Apply button
      // just re-enables and the user is told nothing.
      if (event.type === 'library-overlay') {
        this.showError(event.error ?? t('jobs.unknownError'));
      }
      return;
    }
    // done
    const activeJobs = new Map(this.state.activeJobs);
    activeJobs.delete(event.type);
    this.set({ activeJobs });
    if (event.type === 'render') {
      // Consumed unconditionally — whatever render job this was (preview or
      // final), it's the one the flag referred to; a later render starts fresh.
      const requestedThisRender = this.previewRequestedByUser;
      this.previewRequestedByUser = false;
      this.programRenderFailedKey = null;
      this.renderingProgramKey = null;
      const result = isRenderResult(event.result) ? event.result : undefined;
      const project = this.state.project;
      if (result?.outputRel === 'edit/final.mp4') {
        this.set({
          lastExport: {
            at: Date.now(),
            outputRel: result.outputRel,
            durationS: result.durationS,
            ...(result.deliveryPath !== undefined ? { deliveryPath: result.deliveryPath } : {}),
            ...(result.deliveryName !== undefined ? { deliveryName: result.deliveryName } : {}),
          },
          // Every final the user asked for gets its banner and its reveal —
          // a clean-captions delivery included. Only freshness receipts stay
          // gated on `canonical` (a burned final must not look fresh after it).
          lastRender: {
            outputRel: result.outputRel,
            durationS: result.durationS,
            ...(result.deliveryPath !== undefined ? { deliveryPath: result.deliveryPath } : {}),
            ...(result.deliveryName !== undefined ? { deliveryName: result.deliveryName } : {}),
          },
          finalVersion: this.state.finalVersion + 1,
          ...(project ? { project: { ...project, hasFinal: true } } : {}),
        });
      }
      if (result?.outputRel === 'edit/preview.mp4') {
        const previewCurrent =
          result.canonical &&
          !this.state.dirty &&
          this.lastSavedHash !== '' &&
          result.editHash === this.lastSavedHash;
        const currentDocJson = this.state.doc === null ? null : JSON.stringify(this.state.doc);
        this.renderedDocJson = previewCurrent ? currentDocJson : null;
        // Reveal only for a render the user actually asked for (Preview button/menu) — the
        // silent 5s auto-preview must never pop a dialog over an unrelated edit in progress.
        // Even then, an active playhead makes an interrupting dialog worse than the bug it
        // fixes — the "ready" banner below stays the clickable fallback in both cases.
        this.set({
          lastPreviewRender: result.canonical
            ? { outputRel: result.outputRel, durationS: result.durationS }
            : null,
          previewViewerOpen: previewCurrent && requestedThisRender && !playhead.playing,
          previewOutdated: !previewCurrent,
          previewVersion: this.state.previewVersion + 1,
          ...(project
            ? {
                project: {
                  ...project,
                  hasPreview: true,
                  // The renderer removes the canonical receipt before an
                  // override, so mirror that absence until the next reload.
                  previewEditHash: result.canonical ? result.editHash : null,
                },
              }
            : {}),
        });
      }
      if (result?.kind === 'program') {
        const doc = this.state.doc;
        this.set({
          programVersion: this.state.programVersion + 1,
          programOutdated: doc !== null && programKey(doc) !== result.programKey,
          ...(project
            ? { project: { ...project, hasProgram: true, programKey: result.programKey } }
            : {}),
        });
      }
    }
    if (event.type === 'audio-preview') {
      const result = isAudioPreviewResult(event.result) ? event.result : undefined;
      const project = this.state.project;
      if (result) {
        const audioPreviewCurrent =
          this.state.doc !== null && result.semanticKey === audioPreviewSemanticKey(this.state.doc);
        // Keep the artifact's audible baseline even when a newer audio edit
        // landed during the job. Undoing back to it can then become current
        // immediately without a redundant render.
        this.audioPreviewDocKey = result.semanticKey;
        this.set({
          lastAudioPreview: {
            outputRel: result.outputRel,
            beforeOutputRel: result.beforeOutputRel,
            durationS: result.durationS,
            expectedDurationS: result.expectedDurationS,
          },
          audioPreviewOutdated: !audioPreviewCurrent,
          audioPreviewVersion: this.state.audioPreviewVersion + 1,
          ...(project
            ? {
                project: {
                  ...project,
                  hasAudioPreview: true,
                  hasAudioComparison: true,
                  audioPreviewEditHash: result.editHash,
                  audioPreviewCurrent,
                },
              }
            : {}),
        });
      }
      this.audioPreviewRequestInFlight = false;
      this.resumeQueuedAudioPreview();
    }
    if (
      event.type === 'suggest' ||
      event.type === 'transcribe' ||
      event.type === 'title' ||
      event.type === 'library-overlay'
    ) {
      // Never clobber unsaved local edits with the job's doc — the conflict
      // flow (or the next save) resolves it instead.
      if (!this.state.dirty) void this.reloadFromServer(false);
    }
  }

  async reloadFromServer(fromAgent: boolean, preserveAudioRefresh = false): Promise<void> {
    const epoch = ++this.documentReloadEpoch;
    const revision = this.documentRevision;
    try {
      // An acknowledged save must precede the snapshot we choose to reload.
      await this.saveChain;
      if (epoch !== this.documentReloadEpoch) return;
      const savedHash = this.lastSavedHash;
      const project = await this.backend.getProject();
      if (epoch !== this.documentReloadEpoch) return;
      // The user can edit while GET /project is pending, even after choosing
      // Reload in the conflict banner. Never discard those newer edits or
      // their undo history. A save completed during the GET also makes its
      // snapshot obsolete, even when the document itself stayed unchanged.
      if (revision !== this.documentRevision || savedHash !== this.lastSavedHash) {
        if (this.state.dirty && project.editHash !== this.lastSavedHash) {
          this.set({ conflict: true });
        }
        return;
      }
      if (!preserveAudioRefresh && this.audioPreviewTimer) {
        clearTimeout(this.audioPreviewTimer);
        this.audioPreviewTimer = null;
      }
      if (!preserveAudioRefresh) this.audioPreviewQueued = false;
      await this.applyReloadedProject(project, fromAgent, preserveAudioRefresh);
    } catch (error) {
      if (epoch === this.documentReloadEpoch) {
        this.set({ loadError: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async applyReloadedProject(
    project: ProjectInfo,
    fromAgent: boolean,
    preserveAudioRefresh: boolean,
  ): Promise<void> {
    this.history.clear();
    if (project.editHash) this.lastSavedHash = project.editHash;
    const previewCurrent =
      project.hasPreview &&
      project.doc !== null &&
      project.editHash !== null &&
      project.previewEditHash === project.editHash;
    const audioPreviewCurrent =
      project.hasAudioComparison && project.doc !== null && project.audioPreviewCurrent;
    const projectDocJson = project.doc === null ? null : JSON.stringify(project.doc);
    this.renderedDocJson = previewCurrent ? projectDocJson : null;
    this.audioPreviewDocKey = audioPreviewCurrent ? audioPreviewSemanticKey(project.doc) : null;
    this.set({
      project,
      doc: project.doc,
      dirty: false,
      conflict: false,
      agentEdited: fromAgent,
      undoDepth: 0,
      redoDepth: 0,
      selection: null,
      extraSelections: [],
      subtitleInspectorOpen: false,
      backgroundInspectorOpen: false,
      selectedCue: null,
      extraCues: [],
      previewOutdated: project.hasPreview && project.doc !== null && !previewCurrent,
      programOutdated: programOutdatedFor(project.doc, project),
      ...(programArtifactChanged(this.state.project, project)
        ? { programVersion: this.state.programVersion + 1 }
        : {}),
      audioPreviewOutdated:
        project.hasAudioComparison && project.doc !== null && !audioPreviewCurrent,
      audioPreviewRefreshState: preserveAudioRefresh ? this.state.audioPreviewRefreshState : 'idle',
      ...(this.state.project?.audioPreviewEditHash !== project.audioPreviewEditHash
        ? { audioPreviewVersion: this.state.audioPreviewVersion + 1 }
        : {}),
    });
    if (project.doc && project.doc.output.loudnormLufs !== null) {
      this.lastLoudnormLufs = project.doc.output.loudnormLufs;
    }
    await this.loadDerivedData(project);
    if (fromAgent && this.state.audioPreviewOutdated) this.scheduleAudioPreviewRefresh();
  }

  keepMine(): void {
    void this.keepMineAgainstLatest();
  }

  private async keepMineAgainstLatest(): Promise<void> {
    try {
      const project = await this.backend.getProject();
      if (!project.editHash || !this.state.doc) return;
      this.lastSavedHash = project.editHash;
      this.set({
        project,
        conflict: false,
        dirty: true,
        programOutdated: programOutdatedFor(this.state.doc, project),
      });
      await this.save();
    } catch (error) {
      this.set({ loadError: error instanceof Error ? error.message : String(error) });
    }
  }

  // --- selection & block ops --------------------------------------------------

  select(selection: Selection | null): void {
    if (selection !== null) this.revealInspector();
    if (selection && this.state.lockedTrackKeys.has(selection.trackId)) return;
    this.set({
      selection,
      extraSelections: [],
      subtitleInspectorOpen: false,
      backgroundInspectorOpen: false,
      selectedCue: null,
      extraCues: [],
    });
  }

  selectSubtitles(): void {
    this.revealInspector();
    if (this.state.lockedTrackKeys.has(SUBTITLE_EDITOR_TRACK_KEY)) return;
    this.set({
      selection: null,
      extraSelections: [],
      subtitleInspectorOpen: true,
      backgroundInspectorOpen: false,
      selectedCue: null,
      extraCues: [],
    });
  }

  selectCue(cue: SelectedCue): void {
    this.revealInspector();
    if (this.state.lockedTrackKeys.has(SUBTITLE_EDITOR_TRACK_KEY)) return;
    this.set({
      selection: null,
      extraSelections: [],
      subtitleInspectorOpen: true,
      backgroundInspectorOpen: false,
      selectedCue: cue,
      extraCues: [],
    });
  }

  selectBackground(): void {
    this.revealInspector();
    if (this.state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)) return;
    this.set({
      selection: null,
      extraSelections: [],
      subtitleInspectorOpen: false,
      backgroundInspectorOpen: true,
      selectedCue: null,
      extraCues: [],
    });
  }

  private selectionEquals(a: Selection, b: Selection): boolean {
    return a.trackId === b.trackId && a.blockIndex === b.blockIndex;
  }

  private cueEquals(a: SelectedCue, b: SelectedCue): boolean {
    return a.source === b.source && a.wordStart === b.wordStart && a.wordEnd === b.wordEnd;
  }

  /**
   * ⌘/Ctrl+click on a block: toggles membership in the multi-selection. The
   * clicked block always becomes (or, if it already was) the primary — the
   * one the inspector, drag and block-toolbar keep operating on.
   */
  toggleSelect(selection: Selection): void {
    if (this.state.lockedTrackKeys.has(selection.trackId)) return;
    const { selection: primary, extraSelections } = this.state;
    if (primary && this.selectionEquals(primary, selection)) {
      const [nextPrimary, ...rest] = extraSelections;
      this.set({
        selection: nextPrimary ?? null,
        extraSelections: rest,
        subtitleInspectorOpen: false,
        selectedCue: null,
        extraCues: [],
      });
      return;
    }
    const extraIndex = extraSelections.findIndex((candidate) =>
      this.selectionEquals(candidate, selection),
    );
    if (extraIndex >= 0) {
      this.set({ extraSelections: extraSelections.filter((_, i) => i !== extraIndex) });
      return;
    }
    this.set({
      selection,
      extraSelections: primary ? [...extraSelections, primary] : extraSelections,
      subtitleInspectorOpen: false,
      selectedCue: null,
      extraCues: [],
    });
  }

  /**
   * Shift+click on a block: selects the contiguous run between the primary
   * and the target — only when both are on the same track. Across tracks it
   * falls back to a normal single select, since "contiguous" is undefined.
   */
  rangeSelect(selection: Selection): void {
    if (this.state.lockedTrackKeys.has(selection.trackId)) return;
    const { selection: primary, doc } = this.state;
    const track = doc?.tracks.find((candidate) => candidate.id === selection.trackId);
    if (primary?.trackId !== selection.trackId || !track) {
      this.select(selection);
      return;
    }
    const lo = Math.min(primary.blockIndex, selection.blockIndex);
    const hi = Math.max(primary.blockIndex, selection.blockIndex);
    const extraSelections: Selection[] = [];
    for (let i = lo; i <= hi; i += 1) {
      if (i === primary.blockIndex || i < 0 || i >= track.blocks.length) continue;
      extraSelections.push({ trackId: selection.trackId, blockIndex: i });
    }
    this.set({ extraSelections, subtitleInspectorOpen: false, selectedCue: null, extraCues: [] });
  }

  /** ⌘/Ctrl+click on a subtitle cue — same toggle semantics as `toggleSelect`. */
  toggleSelectCue(cue: SelectedCue): void {
    if (this.state.lockedTrackKeys.has(SUBTITLE_EDITOR_TRACK_KEY)) return;
    const { selectedCue: primary, extraCues } = this.state;
    if (primary && this.cueEquals(primary, cue)) {
      const [nextPrimary, ...rest] = extraCues;
      this.set({
        selection: null,
        extraSelections: [],
        subtitleInspectorOpen: true,
        selectedCue: nextPrimary ?? null,
        extraCues: rest,
      });
      return;
    }
    const extraIndex = extraCues.findIndex((candidate) => this.cueEquals(candidate, cue));
    if (extraIndex >= 0) {
      this.set({ extraCues: extraCues.filter((_, i) => i !== extraIndex) });
      return;
    }
    this.set({
      selection: null,
      extraSelections: [],
      subtitleInspectorOpen: true,
      selectedCue: cue,
      extraCues: primary ? [...extraCues, primary] : extraCues,
    });
  }

  /**
   * Shift+click on a cue: range within `orderedCues` — the caller (the
   * timeline) supplies the currently visible cues in display order, since
   * cues aren't indexed anywhere in the doc. Same-source only; a cross-source
   * target falls back to a normal single select.
   */
  rangeSelectCue(cue: SelectedCue, orderedCues: readonly SelectedCue[]): void {
    if (this.state.lockedTrackKeys.has(SUBTITLE_EDITOR_TRACK_KEY)) return;
    const primary = this.state.selectedCue;
    const primaryIndex = primary ? orderedCues.findIndex((c) => this.cueEquals(c, primary)) : -1;
    const targetIndex = orderedCues.findIndex((c) => this.cueEquals(c, cue));
    if (primary?.source !== cue.source || primaryIndex < 0 || targetIndex < 0) {
      this.selectCue(cue);
      return;
    }
    const lo = Math.min(primaryIndex, targetIndex);
    const hi = Math.max(primaryIndex, targetIndex);
    const extraCues: SelectedCue[] = [];
    for (let i = lo; i <= hi; i += 1) {
      if (i === primaryIndex) continue;
      const candidate = orderedCues[i];
      if (candidate) extraCues.push(candidate);
    }
    this.set({ extraCues, selection: null, extraSelections: [] });
  }

  hideCues(cues: readonly SelectedCue[], transcripts: ReadonlyMap<string, Transcript>): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = hideCues(doc, cues, transcripts);
    if (next) this.applyDoc(next);
  }

  /** Manual fix for a mistranscribed word; an empty text removes the correction. */
  correctWord(source: string, at: number, text: string, coalesceKey?: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(correctWord(doc, source, at, text), coalesceKey);
  }

  /** Suppresses subtitles over a SOURCE-time window (persisted, independent of cuts/reordering). */
  hideSubtitleRange(source: string, start: number, end: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = hideSubtitleRange(doc, source, start, end);
    if (next) this.applyDoc(next);
  }

  unhideSubtitleRange(index: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(unhideSubtitleRange(doc, index));
  }

  setSnapDisabled(disabled: boolean): void {
    if (this.state.snapDisabled !== disabled) this.set({ snapDisabled: disabled });
  }

  /**
   * Locks live only in editor state. Locking a row also releases its selected
   * blocks/cues so keyboard and inspector commands cannot keep editing it.
   */
  setTrackLocked(trackKey: string, locked: boolean): void {
    const doc = this.state.doc;
    if (!doc) return;
    if (
      trackKey !== SUBTITLE_EDITOR_TRACK_KEY &&
      trackKey !== BACKGROUND_EDITOR_TRACK_KEY &&
      !doc.tracks.some((track) => track.id === trackKey)
    ) {
      return;
    }
    if (this.state.lockedTrackKeys.has(trackKey) === locked) return;
    const lockedTrackKeys = new Set(this.state.lockedTrackKeys);
    if (locked) lockedTrackKeys.add(trackKey);
    else lockedTrackKeys.delete(trackKey);
    this.set({ lockedTrackKeys });
  }

  toggleTrackLocked(trackKey: string): void {
    this.setTrackLocked(trackKey, !this.state.lockedTrackKeys.has(trackKey));
  }

  openColorInspector(target: ColorTarget): void {
    this.select({ trackId: target.trackId, blockIndex: target.blockIndex ?? 0 });
    this.set({ colorInspectorTarget: target });
    this.activateDockTab('inspector');
  }

  addVideoColorEffect(target: ColorTarget): void {
    const track = this.state.doc?.tracks.find((item) => item.id === target.trackId);
    if (track?.kind !== 'video' || this.state.lockedTrackKeys.has(target.trackId)) return;
    const block = target.blockIndex === undefined ? undefined : track.blocks[target.blockIndex];
    if (target.blockIndex !== undefined && !block) return;
    const ownColor = target.blockIndex === undefined ? track.color : block?.color;
    if (!ownColor) {
      this.endGesture();
      this.setVideoColor(
        target.trackId,
        { ...(block?.color ?? track.color ?? {}) },
        target.blockIndex,
      );
      this.endGesture();
    }
    this.openColorInspector(target);
  }

  applyVideoColorPreset(target: ColorTarget, preset: ColorPresetId): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(target.trackId)) return;
    const next = applyColorPreset(doc, target, preset);
    if (!next) return;
    this.applyDoc(next);
    this.openColorInspector(target);
  }

  setVideoColor(trackId: string, color: VideoColor | undefined, blockIndex?: number): void {
    this.updateTrack(
      trackId,
      (track) =>
        blockIndex === undefined
          ? { ...track, color }
          : {
              ...track,
              blocks: track.blocks.map((block, i) =>
                i === blockIndex ? { ...block, color } : block,
              ),
            },
      `color:${trackId}:${String(blockIndex ?? 'layer')}`,
    );
  }

  setBaseLayerSpeed(speed: number): void {
    let next = this.state.doc;
    if (!next) return;
    for (let i = 0; i < baseTrackOf(next).blocks.length; i++)
      next = setBlockSpeed(next, i, speed) ?? next;
    this.applyDoc(next, 'base-layer-speed');
  }

  private updateTrack(
    trackId: string,
    update: (track: VideoTrack) => VideoTrack,
    coalesceKey?: string,
  ): void {
    const doc = this.state.doc;
    if (!doc) return;
    const tracks = doc.tracks.map((track) =>
      track.kind === 'video' && track.id === trackId ? update(track) : track,
    );
    this.applyDoc({ ...doc, tracks }, coalesceKey);
  }

  strikeWords(sourceKey: string, range: WordRange): void {
    const doc = this.state.doc;
    const transcript = this.state.transcripts.get(sourceKey);
    if (!doc || !transcript) return;
    this.applyDoc(strikeWords(doc, transcript, sourceKey, range));
    // cutting out an interval can insert/remove base-track blocks — stale indices, drop them
    this.set({ extraSelections: [] });
  }

  restoreWords(sourceKey: string, range: WordRange): void {
    const doc = this.state.doc;
    const transcript = this.state.transcripts.get(sourceKey);
    if (!doc || !transcript) return;
    this.applyDoc(restoreWords(doc, transcript, sourceKey, range));
    this.set({ extraSelections: [] });
  }

  deleteSelectedBlock(): void {
    const { selection, extraSelections, doc } = this.state;
    if (!selection || !doc) return;
    this.applyDoc(deleteBlocks(doc, [selection, ...extraSelections]));
    this.set({ selection: null, extraSelections: [] });
  }

  /** CapCut-style: cut away everything left/right of the cursor inside the block under it. */
  trimAtPlayhead(side: 'left' | 'right', outputTime: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const trimmed = trimAtPlayhead(doc, this.state.selection, side, outputTime);
    if (!trimmed) return;
    this.applyDoc(trimmed.doc);
    // a base-track trim can drop a block trimmed to near-zero — stale indices, drop the extras
    if (trimmed.clearsExtraSelections) this.set({ extraSelections: [] });
  }

  splitAtPlayhead(playhead: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = splitAtPlayhead(doc, this.state.selection, playhead);
    if (!next) return;
    this.applyDoc(next);
    // a successful split inserts a block, shifting every later index — stale, drop the extras
    this.set({ extraSelections: [] });
  }

  /** Resize with word snap (silence fallback); returns what the edge snapped to. */
  resizeBlock(
    trackId: string,
    blockIndex: number,
    edge: BlockEdge,
    rawTime: number,
  ): SnapResult | null {
    const doc = this.state.doc;
    if (!doc || !Number.isFinite(rawTime)) return null;
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    if (track?.kind === 'audio') {
      const block = track.blocks[blockIndex];
      if (!block) return null;
      const sourceRawTime = block.in + (rawTime - block.at);
      const transcript = this.state.transcripts.get(block.source);
      const words = transcript ? spokenWords(transcript) : [];
      const silences = this.state.silences.get(block.source) ?? [];
      const sourceSnap = this.state.snapDisabled
        ? { time: sourceRawTime, snapped: false }
        : snapEdge(sourceRawTime, edge, words, silences);
      const outputSnap: SnapResult = {
        time: block.at + (sourceSnap.time - block.in),
        snapped: sourceSnap.snapped,
      };
      this.resizeTimedBlock(trackId, blockIndex, edge, outputSnap.time);
      return outputSnap;
    }
    if (track?.kind !== 'video') return null;
    const block = track.blocks[blockIndex];
    if (!block) return null;

    const transcript = this.state.transcripts.get(block.source);
    const words = transcript ? spokenWords(transcript) : [];
    const silences = this.state.silences.get(block.source) ?? [];
    const snap = this.state.snapDisabled
      ? { time: rawTime, snapped: false }
      : snapEdge(rawTime, edge, words, silences);

    const limit = 0.05;
    const time =
      edge === 'in'
        ? Math.min(snap.time, block.out - limit)
        : Math.max(snap.time, block.in + limit);
    this.updateTrack(trackId, (current) => ({
      ...current,
      blocks: current.blocks.map((candidate, i) =>
        i === blockIndex ? { ...candidate, [edge]: Math.max(0, time) } : candidate,
      ),
    }));
    return snap;
  }

  /** Entry transition for a base block's emenda with the previous one; `undefined` clears it. */
  setBlockTransition(
    blockIndex: number,
    transition: BlockTransition | undefined,
    coalesceKey?: string,
  ): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(setBlockTransition(doc, blockIndex, transition), coalesceKey);
  }

  /**
   * Per-block playback speed on the base track — see `setBlockSpeed` in
   * edits/blocks.ts for the clamp/round/removal rules and why `speed <= 0`
   * must stay a no-op. The call site (Timeline.tsx) also skips the empty
   * string outright so the field can be cleared without a spurious write.
   */
  setBlockSpeed(blockIndex: number, speed: number, coalesceKey?: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = setBlockSpeed(doc, blockIndex, speed);
    if (next) this.applyDoc(next, coalesceKey);
  }

  /** Drop a base block at a new output position: reorder the cut sequence. */
  reorderBaseBlock(blockIndex: number, dropOutputStart: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const reordered = reorderBaseBlock(doc, blockIndex, dropOutputStart);
    if (!reordered) return;
    this.applyDoc(reordered.doc);
    // the whole base track just got reshuffled — every extra's index is now stale
    const base = baseTrackOf(doc);
    this.set({
      extraSelections: [],
      ...(reordered.nextIndex >= 0
        ? { selection: { trackId: base.id, blockIndex: reordered.nextIndex } }
        : {}),
    });
  }

  /** Move any output-positioned block on the timeline with one shared contract. */
  moveTimedBlock(trackId: string, blockIndex: number, at: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = moveTimedBlock(doc, trackId, blockIndex, at);
    if (next) this.applyDoc(next);
  }

  /** Resize an output-positioned block while keeping its opposite edge anchored. */
  resizeTimedBlock(trackId: string, blockIndex: number, edge: BlockEdge, rawTime: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = resizeTimedBlock(doc, trackId, blockIndex, edge, rawTime);
    if (next) this.applyDoc(next);
  }

  updateOverlayBlock(
    trackId: string,
    blockIndex: number,
    patch: Partial<Pick<OverlayBlock, 'at' | 'duration' | 'position' | 'scale'>>,
    coalesceKey?: string,
  ): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(updateOverlayBlock(doc, trackId, blockIndex, patch), coalesceKey);
  }

  openClipEditor(selection: Selection): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(selection.trackId) || !clipRangeInfo(doc, selection))
      return;
    this.select(selection);
    this.set({ clipEditor: { doc, selection } });
  }

  closeClipEditor(): void {
    this.set({ clipEditor: null });
  }

  commitClipRange(session: ClipEditorSession, range: ClipRange, duration: number): boolean {
    if (this.state.doc !== session.doc || this.state.lockedTrackKeys.has(session.selection.trackId))
      return false;
    const next = applyClipRange(session.doc, session.selection, range, duration);
    if (!next || changesLockedTimelineContent(session.doc, next, this.state.lockedTrackKeys))
      return false;
    this.applyDoc(next);
    this.closeClipEditor();
    return true;
  }

  /** An `undefined` patch value REMOVES the key — the doc stays JSON-clean. */
  updateSelectedLayerBlock(patch: Record<string, unknown>, coalesceKey?: string): void {
    const { selection, doc } = this.state;
    if (!selection || !doc) return;
    this.applyDoc(updateSelectedLayerBlock(doc, selection, patch), coalesceKey);
  }

  setSelectedTransform(patch: Partial<{ scale: number; x: number; y: number }>): void {
    const { selection, doc } = this.state;
    if (!selection || !doc) return;
    this.applyDoc(
      setSelectedTransform(doc, selection, patch),
      `transform:${selection.trackId}:${String(selection.blockIndex)}`,
    );
  }

  nudgeSelectedBlock(deltaS: number): void {
    const { selection, doc } = this.state;
    if (!selection || !doc) return;
    const next = nudgeSelectedBlock(doc, selection, deltaS);
    if (next) this.applyDoc(next);
  }

  /** A continuation take: appended to the END of the base line. */
  appendToBase(relPath: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    const media = this.state.project?.media.find((m) => m.relPath === relPath);
    const appended = appendToBase(doc, media, relPath);
    if (!appended) return;
    this.applyDoc(appended.doc);
    void this.refreshSourceData(appended.key, relPath);
  }

  /** Insert a project asset at the nearest cut boundary in the base sequence. */
  insertIntoBase(relPath: string, dropOutputTime: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const base = baseTrackOf(doc);
    if (this.state.lockedTrackKeys.has(base.id)) return;
    const media = this.state.project?.media.find((item) => item.relPath === relPath);
    const inserted = insertIntoBase(doc, media, relPath, dropOutputTime);
    if (!inserted) return;
    this.applyDoc(inserted.doc);
    this.set({
      selection: { trackId: base.id, blockIndex: inserted.insertIndex },
      extraSelections: [],
    });
    void this.refreshSourceData(inserted.key, relPath);
  }

  /** Fine trim: move ONE edge of the selected block by deltaS (shave/extend). */
  trimSelectedEdge(edge: BlockEdge, deltaS: number): void {
    const { selection, doc } = this.state;
    if (!selection || !doc) return;
    const next = trimSelectedEdge(doc, selection, edge, deltaS);
    if (next) this.applyDoc(next);
  }

  /** Create an empty first-class media row and return its collision-safe id. */
  addEmptyTrack(kind: 'video' | 'audio' | 'effect'): string | null {
    const doc = this.state.doc;
    if (!doc) return null;
    const added = addEmptyTrack(doc, kind);
    this.applyDoc(added.doc);
    return added.trackId;
  }

  /** Reorder within one kind while leaving every other kind in its existing persisted slot. */
  reorderTrack(trackId: string, targetTrackId: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = reorderTrack(doc, this.state.lockedTrackKeys, trackId, targetTrackId);
    if (next) this.applyDoc(next);
  }

  /** Place the full audio stream on a requested/empty row, creating one when necessary. */
  addAudioClip(relPath: string, at: number, targetTrackId?: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    const media = this.state.project?.media.find((item) => item.relPath === relPath);
    const added = addAudioClip(doc, this.state.lockedTrackKeys, media, relPath, at, targetTrackId);
    if (!added) return;
    this.applyDoc(added.doc);
    this.set({ selection: added.selection, extraSelections: [] });
    void this.refreshSourceData(added.key, relPath);
  }

  addLayer(relPath: string, at: number, targetTrackId?: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    const media = this.state.project?.media.find((item) => item.relPath === relPath);
    const added = addLayer(doc, this.state.lockedTrackKeys, media, relPath, at, targetTrackId);
    if (!added) return;
    this.applyDoc(added.doc);
    this.set({ selection: added.selection, extraSelections: [] });
    void this.refreshSourceData(added.key, relPath);
  }

  private async refreshSourceData(key: string, relPath: string): Promise<void> {
    const [transcript, sourcePeaks] = await Promise.all([
      this.backend.getTranscript(relPath),
      this.backend.getPeaks(relPath).catch(() => null),
    ]);
    const transcripts = new Map(this.state.transcripts);
    const peaks = new Map(this.state.peaks);
    const silences = new Map(this.state.silences);
    if (sourcePeaks) {
      peaks.set(key, sourcePeaks);
      silences.set(key, silencesFromPeaks(sourcePeaks));
    }
    if (transcript) {
      transcripts.set(
        key,
        refineTranscript(transcript, sourcePeaks ? silencesFromPeaks(sourcePeaks) : []),
      );
    }
    this.set({ transcripts, peaks, silences });
  }

  /** Where the scissors will land — see computeSilenceCuts in edits/suggestions.ts. */
  computeSilenceCuts(
    minSilenceS: number,
    kinds: SilenceCutKinds = { interior: true, edges: true },
  ): SilenceCut[] {
    const doc = this.state.doc;
    if (!doc) return [];
    return computeSilenceCuts(doc, this.state.peaks, minSilenceS, kinds).filter(
      (cut) => !this.state.dismissedSilenceCutKeys.has(silenceCutKey(cut)),
    );
  }

  /** The scissors: apply every computed silence cut in one undoable step. */
  cutAllSilences(
    minSilenceS: number,
    kinds: SilenceCutKinds = { interior: true, edges: true },
  ): number {
    const doc = this.state.doc;
    if (!doc) return 0;
    const cuts = this.computeSilenceCuts(minSilenceS, kinds);
    const next = cutSilences(doc, cuts);
    if (!next) return 0;
    this.applyDoc(next);
    // every cut can insert/remove base-track blocks — stale indices, drop the extras
    this.set({ extraSelections: [] });
    return cuts.length;
  }

  cutSuggestionInterval(suggestion: Suggestion): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(cutSuggestionInterval(doc, suggestion));
    this.set({ extraSelections: [] });
  }

  acceptSuggestion(id: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(applySuggestion(doc, id));
    this.set({ extraSelections: [] });
  }

  rejectSuggestionById(id: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    // rejecting only drops suggestion metadata — the tracks are untouched, extras stay valid
    this.applyDoc(rejectSuggestion(doc, id));
  }

  acceptAllSuggestions(): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(acceptAllSuggestions(doc));
    this.set({ extraSelections: [] });
  }

  acceptSuggestions(ids: ReadonlySet<string>): void {
    const doc = this.state.doc;
    if (!doc || ids.size === 0) return;
    this.applyDoc(acceptSuggestions(doc, ids));
    this.set({ extraSelections: [] });
  }

  rejectSuggestions(ids: ReadonlySet<string>): void {
    const doc = this.state.doc;
    if (!doc || ids.size === 0) return;
    this.applyDoc(rejectSuggestions(doc, ids));
  }

  rejectAllSuggestions(): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc({ ...doc, suggestions: [] });
  }

  dismissError(): void {
    this.set({ loadError: null, renderError: null });
  }

  setExportOpen(open: boolean): void {
    this.set({ exportOpen: open });
  }

  setHistoryOpen(open: boolean): void {
    this.set({ historyOpen: open });
  }

  /** Brings a dockable panel forward in whichever area it lives. */
  setEditorPanelMode(panel: DockPanelId): void {
    this.activateDockTab(panel);
  }

  activateDockTab(panel: DockPanelId): void {
    this.applyDockLayout(activatePanel(this.state.dockLayout, panel));
  }

  moveDockTab(panel: DockPanelId, to: DockAreaId, index: number): void {
    this.applyDockLayout(moveTab(this.state.dockLayout, panel, to, index));
  }

  applyDockPreset(preset: DockPresetId): void {
    this.applyDockLayout(DOCK_PRESET_LAYOUT[preset]);
  }

  moveDockTabToArea(panel: DockPanelId, to: DockAreaId): void {
    this.applyDockLayout(moveTabToArea(this.state.dockLayout, panel, to));
  }

  beginDockDrag(panel: DockPanelId): void {
    this.set({ dockDrag: panel });
  }

  endDockDrag(): void {
    this.set({ dockDrag: null });
  }

  /** The cut reviewer is "open" exactly while its tab is on screen — the timeline markers follow the tab. */
  private applyDockLayout(layout: DockLayout): void {
    if (layout === this.state.dockLayout) return;
    writeDockLayout(layout);
    this.set({ dockLayout: layout, cutReviewOpen: isPanelActive(layout, 'cuts') });
  }

  /** Selecting something brings the inspector forward, NLE-style. */
  private revealInspector(): void {
    this.activateDockTab('inspector');
  }

  /** Call after writing a new item to the personal library — the panel is not notified otherwise. */
  libraryChanged(): void {
    this.set({ libraryRevision: this.state.libraryRevision + 1 });
  }

  /** Add a freshly imported original to the project index without reloading the edit or clearing undo. */
  registerImportedMedia(item: MediaSummary): void {
    const project = this.state.project;
    if (!project) return;
    const media = [
      ...project.media.filter((candidate) => candidate.relPath !== item.relPath),
      item,
    ].sort((a, b) => a.relPath.localeCompare(b.relPath));
    this.set({ project: { ...project, media } });
  }

  setDebugOpen(open: boolean): void {
    this.set({ debugOpen: open });
  }

  setSettingsOpen(open: boolean): void {
    this.set({ settingsOpen: open });
  }

  setCutReviewOpen(open: boolean): void {
    const layout = this.state.dockLayout;
    if (open) {
      this.activateDockTab('cuts');
      return;
    }
    const area = areaOf(layout, 'cuts');
    const sibling = layout[area].tabs.find((tab) => tab !== 'cuts');
    if (sibling !== undefined) this.activateDockTab(sibling);
  }

  setCutReviewMode(mode: StoreState['cutReviewMode']): void {
    this.set({ cutReviewMode: mode });
  }

  setSuggestionReview(patch: Partial<StoreState['suggestionReview']>): void {
    this.set({ suggestionReview: { ...this.state.suggestionReview, ...patch } });
  }

  setSilenceReview(patch: Partial<StoreState['silenceReview']>): void {
    this.set({
      silenceReview: { ...this.state.silenceReview, ...patch },
      dismissedSilenceCutKeys: new Set(),
    });
  }

  dismissSilenceCut(cut: SilenceCut): void {
    const dismissedSilenceCutKeys = new Set(this.state.dismissedSilenceCutKeys);
    dismissedSilenceCutKeys.add(silenceCutKey(cut));
    this.set({ dismissedSilenceCutKeys });
  }

  restoreDismissedSilenceCuts(): void {
    if (this.state.dismissedSilenceCutKeys.size === 0) return;
    this.set({ dismissedSilenceCutKeys: new Set() });
  }

  setTranscriptionOpen(open: boolean): void {
    this.set({ transcriptionOpen: open });
  }

  dismissTranscriptionError(): void {
    this.set({ transcriptionError: null });
  }

  dismissSuggestionError(): void {
    this.set({ suggestionError: null });
  }

  setAudioOpen(open: boolean): void {
    this.set({ audioOpen: open });
  }

  setAutoPreview(enabled: boolean): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTO_PREVIEW_STORAGE_KEY, enabled ? 'on' : 'off');
    }
    this.set({ autoPreview: enabled });
  }

  setProofMode(enabled: boolean): void {
    this.set({ proofMode: enabled });
  }

  /**
   * Whether the background program render is worth starting: the document
   * moved past what `edit/program.mp4` was rendered from, has something to
   * render, and is not the exact projection whose last render failed.
   */
  shouldAutoPreviewCurrentDoc(): boolean {
    const doc = this.state.doc;
    if (!doc || !this.state.programOutdated) return false;
    if (baseTrackOf(doc).blocks.length === 0) return false;
    return programKey(doc) !== this.programRenderFailedKey;
  }

  /** QA issue chip → timeline: selects the base block under the given OUTPUT time, or clears selection if none. */
  selectBlockAtOutputTime(outputTime: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const base = baseTrackOf(doc);
    const segment = outputSegments(doc).find(
      (candidate) => outputTime >= candidate.outputStart && outputTime < candidate.outputEnd,
    );
    if (!segment) {
      this.select(null);
      return;
    }
    this.select({ trackId: base.id, blockIndex: segment.blockIndex });
  }

  /** A saved API key flips availability instantly — no full reload (which would clear undo). */
  patchApiKeyPresent(present: boolean): void {
    const project = this.state.project;
    if (project && project.apiKeyPresent !== present) {
      this.set({ project: { ...project, apiKeyPresent: present } });
    }
  }

  dismissLastRender(): void {
    this.set({ lastRender: null });
  }

  /** Marks the render about to start as user-initiated — call right before `api.startRender({ preview: true })` from the Preview button/menu, never from the silent auto-preview. */
  requestPreviewRender(): void {
    this.previewRequestedByUser = true;
    this.renderingProgramKey = null;
  }

  /**
   * Starts the background program render and remembers which projection it
   * was asked for, so a failure is blamed on that projection and not
   * retried until the document moves. A request the server refuses leaves
   * nothing behind — a later user preview or export failing must not be
   * blamed on the program.
   */
  async startProgramRender(start: () => Promise<unknown>): Promise<void> {
    this.renderingProgramKey = this.state.doc === null ? null : programKey(this.state.doc);
    let accepted = false;
    try {
      await start();
      accepted = true;
    } finally {
      if (!accepted) this.renderingProgramKey = null;
    }
  }

  setPreviewViewerOpen(open: boolean): void {
    this.set({ previewViewerOpen: open });
  }

  dismissLastPreviewRender(): void {
    this.set({ lastPreviewRender: null, previewViewerOpen: false });
  }

  /** Surfaces an error through the app's existing dismissible error banner. */
  showError(message: string): void {
    this.set({ loadError: message });
  }

  setSubtitlePreset(preset: 'pill' | '2p-caps' | '3p-natural'): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(setSubtitlePreset(doc, preset));
  }

  updateSubtitleSettings(patch: Partial<EditDoc['subtitles']>, coalesceKey?: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(updateSubtitleSettings(doc, patch), coalesceKey);
  }

  /** Enable the first-class canvas using the restrained talking-head default. */
  ensureBackground(): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)) return;
    const next = ensureBackground(doc);
    if (next) this.applyDoc(next);
  }

  /** Return to the legacy full-frame composition without leaving partial canvas state behind. */
  removeBackground(): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)) return;
    const next = removeBackground(doc);
    if (!next) return;
    this.applyDoc(next);
    this.set({ backgroundInspectorOpen: false });
  }

  setBackgroundColor(color: string): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)) return;
    const next = setBackgroundColor(doc, color);
    if (next) this.applyDoc(next, 'canvas:background:color');
  }

  setBackgroundImage(file: string, fit: BackgroundFit = 'cover'): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)) return;
    const next = setBackgroundImage(doc, file, fit);
    if (next) this.applyDoc(next);
  }

  /** Pick an already-registered video source (useful for agent-authored edit.json). */
  setBackgroundVideoSource(source: string, fit: BackgroundFit = 'cover'): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)) return;
    const sourcePath = doc.sources[source]?.path;
    const media = this.state.project?.media.find((item) => item.relPath === sourcePath);
    const next = setBackgroundVideoSource(doc, media, source, fit);
    if (next) this.applyDoc(next);
  }

  /** Register a project video path collision-safely and make it the canvas background. */
  setBackgroundVideo(relPath: string, fit: BackgroundFit = 'cover'): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)) return;
    const media = this.state.project?.media.find((item) => item.relPath === relPath);
    const next = setBackgroundVideo(doc, media, relPath, fit);
    if (next) this.applyDoc(next);
  }

  setBackgroundFit(fit: BackgroundFit): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)) return;
    const next = setBackgroundFit(doc, fit);
    if (next) this.applyDoc(next);
  }

  setCanvasBaseMode(mode: CanvasConfig['base']['mode']): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)) return;
    const next = setCanvasBaseMode(doc, mode);
    if (next) this.applyDoc(next);
  }

  setCanvasBaseCell(cell: LayerCell): void {
    const doc = this.state.doc;
    if (!doc || this.state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)) return;
    const next = setCanvasBaseCell(doc, cell);
    if (next) this.applyDoc(next, 'canvas:base:cell');
  }

  setOutputSize(width: number, height: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(setOutputSize(doc, width, height));
  }

  /** Effects land over the LOCKED cut on their own track; the new block becomes the selection. */
  private applyEffectAddition(added: EffectAddition): void {
    this.applyDoc(added.doc);
    this.set({ selection: added.selection, extraSelections: [] });
  }

  /** Catalog entry point (effects panel): per-type clamps applied, so a library default can never violate the schema bounds. */
  addEffect(block: EffectBlock): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyEffectAddition(addEffect(doc, block));
  }

  addZoomEffect(at: number, duration: number, scale: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyEffectAddition(addZoomEffect(doc, at, duration, scale));
  }

  addFlashEffect(at: number, duration: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyEffectAddition(addFlashEffect(doc, at, duration));
  }

  addShakeEffect(at: number, duration: number, intensity: number = SHAKE_DEFAULT_INTENSITY): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyEffectAddition(addShakeEffect(doc, at, duration, intensity));
  }

  updateEffectBlock(
    trackId: string,
    blockIndex: number,
    patch: EffectPatch,
    coalesceKey?: string,
  ): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(updateEffectBlock(doc, trackId, blockIndex, patch), coalesceKey);
  }

  addOverlayImage(relPath: string, at: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(addOverlayImage(doc, relPath, at));
  }

  setSubtitleMargin(bottomFraction: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    this.applyDoc(setSubtitleMargin(doc, bottomFraction), 'subtitles:marginV');
  }

  removeTrack(trackId: string): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = removeTrack(doc, this.state.lockedTrackKeys, trackId);
    if (!next) return;
    const [selection = null, ...extraSelections] = [
      this.state.selection,
      ...this.state.extraSelections,
    ].filter(
      (candidate): candidate is Selection => candidate !== null && candidate.trackId !== trackId,
    );
    this.applyDoc(next);
    this.set({ selection, extraSelections });
  }

  /** Persisted visibility for visual tracks — audio rows use mute instead. */
  toggleTrackVisibility(trackId: string): void {
    const track = this.state.doc?.tracks.find((candidate) => candidate.id === trackId);
    if (!track || track.kind === 'audio') return;
    this.setTrackHidden(trackId, track.hidden !== true);
  }

  /** Persisted per-track visibility (honored by the renderer). No-op on the base track and on an unknown id. */
  setTrackHidden(trackId: string, hidden: boolean): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = setTrackHidden(doc, trackId, hidden);
    if (next) this.applyDoc(next);
  }

  /** Persisted per-track mute for video and audio rows. */
  setTrackMuted(trackId: string, muted: boolean): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = setTrackMuted(doc, trackId, muted);
    if (next) this.applyDoc(next);
  }

  /** Per-clip gain in dB; zero is canonicalized to the omitted/default value. */
  setAudioBlockGain(trackId: string, blockIndex: number, gainDb: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = setAudioBlockGain(doc, trackId, blockIndex, gainDb);
    if (next) this.applyDoc(next, `audio-gain:${trackId}:${String(blockIndex)}`);
  }

  /** Patch the fade envelope; zero clears a side and omitted sides keep their current value. */
  setAudioBlockFades(trackId: string, blockIndex: number, fades: AudioFadePatch): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = setAudioBlockFades(doc, trackId, blockIndex, fades);
    if (next) this.applyDoc(next, `audio-fades:${trackId}:${String(blockIndex)}`);
  }

  /** Free editor-style rect for mode "cell"; see updateLayerCell in edits/canvas.ts for the NaN rule. */
  updateLayerCell(
    trackId: string,
    blockIndex: number,
    cell: LayerCell,
    coalesceKey?: string,
  ): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = updateLayerCell(doc, trackId, blockIndex, cell);
    if (next) this.applyDoc(next, coalesceKey);
  }

  /** Noise-reduction intensity ahead of loudnorm — see setDenoise in edits/audio.ts. */
  setDenoise(value: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = setDenoise(doc, value);
    if (next) this.applyDoc(next, 'output:denoise');
  }

  /** Explicit room tone in SOURCE time; `null` returns to automatic silence analysis. */
  setDenoiseSample(sample: DenoiseSample | null): void {
    const doc = this.state.doc;
    if (!doc) return;
    const sourcePath = sample === null ? undefined : doc.sources[sample.source]?.path;
    const sourceMedia = this.state.project?.media.find((media) => media.relPath === sourcePath);
    const next = setDenoiseSample(doc, sourceMedia, sample);
    if (next) this.applyDoc(next);
  }

  /**
   * The loudnorm target LUFS, and whether normalization runs at all: `null` disables
   * normalization outright; a number turns it on at that target. A non-null value also
   * updates `lastLoudnormLufs`, the target `setLoudnormEnabled(true)` restores after the
   * field has been turned off.
   */
  setLoudnormLufs(value: number | null): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = setLoudnormLufs(doc, value);
    if (!next) return;
    if (next.output.loudnormLufs !== null) this.lastLoudnormLufs = next.output.loudnormLufs;
    this.applyDoc(next, 'output:loudnorm');
  }

  /**
   * UI toggle behind the AudioModal's (Ferramentas ▸ Áudio…) "Normalizar áudio"
   * switch: off writes `loudnormLufs: null` (see `setLoudnormLufs`); on
   * restores the last target the user picked, or the −14 default on a doc
   * that never had one.
   */
  setLoudnormEnabled(enabled: boolean): void {
    this.setLoudnormLufs(enabled ? this.lastLoudnormLufs : null);
  }

  /** Global export speed applied after montage and subtitle burn — see setOutputSpeed in edits/audio.ts. */
  setOutputSpeed(value: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = setOutputSpeed(doc, value);
    if (next) this.applyDoc(next, 'output:speed');
  }

  /** Audio crossfade overlap at every base joint, in ms. */
  setJoinAudioCrossfadeMs(value: number): void {
    const doc = this.state.doc;
    if (!doc) return;
    const next = setJoinAudioCrossfadeMs(doc, value);
    if (next) this.applyDoc(next, 'output:joinAudioCrossfadeMs');
  }
}

export const store = new EditorStore();
