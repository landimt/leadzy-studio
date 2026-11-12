import { basename, join } from 'node:path';
import { err, ok, unwrap, type Result } from '../core/result.js';
import { baseTrackOf, type EditDoc, type Suggestion } from '../core/schema.js';
import { probeMedia } from '../server/services/ffmpeg.js';
import { detectSilences, type SilenceOptions } from '../core/silence.js';
import { buildSuggestions } from '../core/suggest.js';
import { refineWordEnds, spokenWords } from '../core/transcript.js';
import {
  actionableSourceIntervalOutputRanges,
  applySuggestion,
  rejectSuggestion,
  withRecomputedDuration,
  withSuggestions,
} from '../core/timeline.js';
import { loadPcm, PCM_SAMPLE_RATE } from '../server/services/audio.js';
import { editDocHash, loadEditDoc } from '../server/services/project.js';
import { loadProjectTranscripts } from '../server/services/projectTranscripts.js';
import { applyEditDocument } from './applyEditDocument.js';

export interface SuggestSummary {
  readonly suggestions: readonly Suggestion[];
  readonly hadTranscripts: boolean;
  /** The document hash after the suggestions were recorded — the next `edit apply` expects it. */
  readonly editHash: string;
}

/**
 * RF8: offline cut candidates. Pauses work with zero APIs; repetitions and
 * fillers join in when a transcript cache exists. Nothing is applied — the
 * suggestions land in edit.json for the user (or agent) to accept/reject.
 */
export async function suggestCuts(
  projectDir: string,
  options: SilenceOptions = {},
  saveDoc?: (doc: EditDoc, expectHash: string) => Promise<string>,
  onProgress?: (message: string) => void,
): Promise<Result<SuggestSummary>> {
  const loaded = await loadEditDoc(projectDir);
  if (!loaded.ok) return loaded;
  const { doc } = loaded.value;
  const expectHash = editDocHash(doc);

  const transcripts = await loadProjectTranscripts(projectDir, doc);
  const all: Suggestion[] = [];

  // Suggestions can only cut the base montage. Muted screen recordings and
  // unused library media must not prevent analysis of the speaker's audio.
  const baseSources = new Set(baseTrackOf(doc).blocks.map((block) => block.source));
  const sources = Object.entries(doc.sources).filter(([key]) => baseSources.has(key));
  for (const [index, [key, source]] of sources.entries()) {
    onProgress?.(
      `Analisando ${String(index + 1)} de ${String(sources.length)} · ${basename(source.path)}`,
    );
    const probe = await probeMedia(join(projectDir, source.path));
    if (!probe.ok) return probe;
    if (!probe.value.hasAudio) continue;
    const pcm = await loadPcm(join(projectDir, source.path));
    if (!pcm.ok) return pcm;
    const silences = detectSilences(pcm.value, PCM_SAMPLE_RATE, options);
    const transcript = transcripts.get(key);
    const candidates = buildSuggestions({
      source: key,
      silences,
      ...(transcript ? { words: refineWordEnds(spokenWords(transcript), silences) } : {}),
    });
    // Media can be longer than the current montage, and old edits can leave a
    // few milliseconds of an otherwise already-applied cut at a block edge.
    // Neither case is useful review work.
    all.push(
      ...candidates.filter(
        (suggestion) =>
          actionableSourceIntervalOutputRanges(
            doc,
            suggestion.source,
            suggestion.start,
            suggestion.end,
          ).length > 0,
      ),
    );
  }

  const next = withSuggestions(doc, all);
  // The hash must come from the write, never from `next`: the writer re-parses
  // the document and serialises keys in schema order, so an in-memory hash of
  // a doc that gained `suggestions` after `totalDurationS` is not what is on disk.
  const editHash = saveDoc
    ? await saveDoc(next, expectHash)
    : unwrap(await applyEditDocument(projectDir, next, { expectHash })).editHash;
  return ok({ suggestions: all, hadTranscripts: transcripts.size > 0, editHash });
}

export interface SuggestionReview {
  readonly accept?: readonly string[];
  readonly acceptAll?: boolean;
  readonly reject?: readonly string[];
}

export interface ReviewSummary {
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly remaining: number;
  readonly totalDurationS: number;
  readonly editHash: string;
}

/**
 * The agent's verdict on recorded suggestions, as one document change:
 * accepted ones cut their interval from the base track, rejected ones are
 * simply dropped. An unknown id is an error, not a silent no-op — the agent
 * copies ids from `suggest` output and a typo must not pass as "done".
 */
export async function reviewSuggestions(
  projectDir: string,
  review: SuggestionReview,
): Promise<Result<ReviewSummary>> {
  const loaded = await loadEditDoc(projectDir);
  if (!loaded.ok) return loaded;
  const original = loaded.value.doc;
  const known = new Set((original.suggestions ?? []).map((s) => s.id));
  const accept = review.acceptAll ? [...known] : [...(review.accept ?? [])];
  const reject = [...(review.reject ?? [])];
  const unknown = [...accept, ...reject].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return err(
      'not-found',
      `unknown suggestion id(s): ${unknown.join(', ')} — run "studio suggest" and copy the ids it prints`,
    );
  }
  const both = accept.filter((id) => reject.includes(id));
  if (both.length > 0) {
    return err('invalid-input', `cannot both accept and reject: ${both.join(', ')}`);
  }

  let doc = original;
  for (const id of accept) doc = applySuggestion(doc, id);
  for (const id of reject) doc = rejectSuggestion(doc, id);
  doc = withRecomputedDuration(doc);

  const saved = await applyEditDocument(projectDir, doc, { expectHash: editDocHash(original) });
  if (!saved.ok) return saved;
  return ok({
    accepted: accept,
    rejected: reject,
    remaining: doc.suggestions?.length ?? 0,
    totalDurationS: saved.value.totalDurationS,
    editHash: saved.value.editHash,
  });
}

export interface AutocutSummary {
  readonly applied: number;
  readonly removedS: number;
  readonly totalDurationS: number;
}

/**
 * The fast path: pause cutting is math, not taste — measure silence, apply
 * every silence cut, done in seconds. Agents reason only about retakes,
 * beats and overlays on top of this.
 */
export async function autocut(
  projectDir: string,
  options: SilenceOptions = {},
): Promise<Result<AutocutSummary>> {
  const suggested = await suggestCuts(projectDir, options);
  if (!suggested.ok) return suggested;

  const loaded = await loadEditDoc(projectDir);
  if (!loaded.ok) return loaded;
  let doc = loaded.value.doc;
  const before = doc.totalDurationS ?? 0;

  const silenceCuts = (doc.suggestions ?? []).filter((s) => s.type === 'silence');
  for (const suggestion of silenceCuts) {
    doc = applySuggestion(doc, suggestion.id);
  }
  doc = withRecomputedDuration(doc);

  const saved = await applyEditDocument(projectDir, doc, {
    expectHash: editDocHash(loaded.value.doc),
  });
  if (!saved.ok) return saved;
  return ok({
    applied: silenceCuts.length,
    removedS: Math.round((before - (doc.totalDurationS ?? 0)) * 100) / 100,
    totalDurationS: doc.totalDurationS ?? 0,
  });
}
