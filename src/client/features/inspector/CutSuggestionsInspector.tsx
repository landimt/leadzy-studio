import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { Suggestion } from '../../../core/schema.js';
import { baseTrackOf } from '../../../core/schema.js';
import { api } from '../../api.js';
import { store } from '../../state/store.js';
import { playhead } from '../../state/playhead.js';
import { useStore } from '../../state/hooks.js';
import { silenceCutKey } from '../../state/edits/suggestions.js';
import { CutSuggestionsPanel, type LocatedSilenceCut } from '../timeline/CutSuggestionsPanel.js';
import { silenceCutOutputRange, suggestionOutputRange } from '../timeline/cutSuggestionReview.js';

export function CutSuggestionsInspector(): JSX.Element | null {
  const state = useStore();
  const doc = state.doc;
  const [analysisAttempted, setAnalysisAttempted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusedSilenceKey, setFocusedSilenceKey] = useState<string | null>(null);
  const [silenceResult, setSilenceResult] = useState<string | null>(null);
  const running = state.activeJobs.has('suggest');

  const startAnalysis = useCallback((): void => {
    setAnalysisAttempted(true);
    setStartError(null);
    store.dismissSuggestionError();
    void (async () => {
      try {
        if (!(await store.flushSave())) return;
        await api.startSuggest();
      } catch (cause) {
        setStartError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, []);

  const silenceCuts = useMemo<LocatedSilenceCut[]>(() => {
    if (!doc) return [];
    return store
      .computeSilenceCuts(state.silenceReview.minSilenceS, {
        interior: state.silenceReview.interior,
        edges: state.silenceReview.edges,
      })
      .flatMap((cut) => {
        const range = silenceCutOutputRange(doc, cut);
        return range ? [{ cut, ...range }] : [];
      });
  }, [doc, state.dismissedSilenceCutKeys, state.peaks, state.silenceReview]);

  const suggestionRefreshNeeded = useMemo(() => {
    if (!doc) return false;
    if (doc.suggestions === undefined) return true;
    return (
      doc.suggestions.length === 0 ||
      doc.suggestions.some((suggestion) => suggestionOutputRange(doc, suggestion) === null)
    );
  }, [doc]);

  useEffect(() => {
    if (!running) return;
    setAnalysisAttempted(true);
  }, [running]);

  useEffect(() => {
    if (
      !doc ||
      state.cutReviewMode !== 'suggestions' ||
      running ||
      analysisAttempted ||
      !suggestionRefreshNeeded
    ) {
      return;
    }
    startAnalysis();
  }, [
    analysisAttempted,
    doc,
    running,
    startAnalysis,
    state.cutReviewMode,
    suggestionRefreshNeeded,
  ]);

  if (!doc) return null;

  const focusSuggestion = (suggestion: Suggestion, play: boolean): void => {
    const range = suggestionOutputRange(doc, suggestion);
    setFocusedId(suggestion.id);
    if (!range) return;
    playhead.seek(range.at);
    if (play) playhead.setPlaying(true);
  };

  const progress = state.activeJobs.get('suggest')?.progress;

  return (
    <CutSuggestionsPanel
      doc={doc}
      mode={state.cutReviewMode}
      running={running}
      {...(progress !== undefined ? { progress } : {})}
      error={startError ?? state.suggestionError}
      baseLocked={state.lockedTrackKeys.has(baseTrackOf(doc).id)}
      transcriptCount={state.transcripts.size}
      focusedId={focusedId}
      focusedSilenceKey={focusedSilenceKey}
      silenceCuts={silenceCuts}
      dismissedSilenceCount={state.dismissedSilenceCutKeys.size}
      suggestionReview={state.suggestionReview}
      silenceReview={state.silenceReview}
      silenceResult={silenceResult}
      onModeChange={(mode) => {
        store.setCutReviewMode(mode);
      }}
      onFocus={(suggestion) => {
        focusSuggestion(suggestion, false);
      }}
      onPreview={(suggestion) => {
        focusSuggestion(suggestion, true);
      }}
      onAccept={(id) => {
        store.acceptSuggestion(id);
      }}
      onReject={(id) => {
        store.rejectSuggestionById(id);
      }}
      onAcceptMany={(ids) => {
        store.acceptSuggestions(ids);
      }}
      onRejectMany={(ids) => {
        store.rejectSuggestions(ids);
      }}
      onAnalyze={startAnalysis}
      onFocusSilence={(entry) => {
        setFocusedSilenceKey(silenceCutKey(entry.cut));
        playhead.seek(entry.at);
      }}
      onDismissSilence={(entry) => {
        const key = silenceCutKey(entry.cut);
        store.dismissSilenceCut(entry.cut);
        if (focusedSilenceKey === key) setFocusedSilenceKey(null);
        setSilenceResult(null);
      }}
      onRestoreSilences={() => {
        store.restoreDismissedSilenceCuts();
        setSilenceResult(null);
      }}
      onSuggestionReviewChange={(patch) => {
        store.setSuggestionReview(patch);
      }}
      onSilenceReviewChange={(patch) => {
        setFocusedSilenceKey(null);
        setSilenceResult(null);
        store.setSilenceReview(patch);
      }}
      onApplySilences={() => {
        const applied = store.cutAllSilences(state.silenceReview.minSilenceS, {
          interior: state.silenceReview.interior,
          edges: state.silenceReview.edges,
        });
        setSilenceResult(
          applied > 0
            ? `✓ ${String(applied)} silêncios cortados. Use ⌘Z para desfazer.`
            : 'Nenhuma pausa encontrada com estes ajustes.',
        );
      }}
    />
  );
}
