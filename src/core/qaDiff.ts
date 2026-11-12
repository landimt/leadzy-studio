import { baseTrackOf, type EditDoc } from './schema.js';
import { outputSegments, segmentOutputTime } from './timeline.js';
import { normalizeToken, spokenWords, type Transcript } from './transcript.js';

export interface ExpectedWord {
  readonly token: string;
  readonly text: string;
  readonly outputTime: number;
  readonly blockIndex: number;
  readonly isBlockEdge: boolean;
}

/**
 * The words the final video SHOULD contain, in output order with output
 * times. Output times are the FINAL clock a retranscription of the rendered
 * file would see: per-block speed first (via `segmentOutputTime`), then
 * `doc.output.speed` — the global export speed applied last, after montage
 * and subtitle burn (see core/render/plan.ts).
 */
export function expectedWords(
  doc: EditDoc,
  transcripts: ReadonlyMap<string, Transcript>,
): ExpectedWord[] {
  const globalSpeed = doc.output.speed ?? 1;
  const result: ExpectedWord[] = [];
  for (const segment of outputSegments(doc)) {
    const transcript = transcripts.get(segment.source);
    if (!transcript) continue;
    const inBlock = spokenWords(transcript).filter(
      (w) => (w.start + w.end) / 2 >= segment.in && (w.start + w.end) / 2 < segment.out,
    );
    inBlock.forEach((word, i) => {
      result.push({
        token: normalizeToken(word.text),
        text: word.text,
        outputTime: segmentOutputTime(segment, word.start) / globalSpeed,
        blockIndex: segment.blockIndex,
        isBlockEdge: i === 0 || i === inBlock.length - 1,
      });
    });
  }
  return result;
}

interface AlignedPair {
  readonly expectedIndex: number;
  readonly actualIndex: number;
}

interface Alignment {
  readonly pairs: readonly AlignedPair[];
  readonly deletions: readonly number[];
  readonly insertions: readonly number[];
}

/** Needleman-Wunsch over normalized tokens. */
export function alignSequences(expected: readonly string[], actual: readonly string[]): Alignment {
  const n = expected.length;
  const m = actual.length;
  const MATCH = 2;
  const MISMATCH = -1;
  const GAP = -1;

  const cols = m + 1;
  const score = new Int32Array((n + 1) * cols);
  for (let i = 1; i <= n; i += 1) score[i * cols] = i * GAP;
  for (let j = 1; j <= m; j += 1) score[j] = j * GAP;

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const diagonal =
        (score[(i - 1) * cols + (j - 1)] ?? 0) +
        (expected[i - 1] === actual[j - 1] ? MATCH : MISMATCH);
      const up = (score[(i - 1) * cols + j] ?? 0) + GAP;
      const left = (score[i * cols + (j - 1)] ?? 0) + GAP;
      score[i * cols + j] = Math.max(diagonal, up, left);
    }
  }

  const pairs: AlignedPair[] = [];
  const deletions: number[] = [];
  const insertions: number[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const current = score[i * cols + j] ?? 0;
    if (
      i > 0 &&
      j > 0 &&
      current ===
        (score[(i - 1) * cols + (j - 1)] ?? 0) +
          (expected[i - 1] === actual[j - 1] ? MATCH : MISMATCH)
    ) {
      if (expected[i - 1] === actual[j - 1]) {
        pairs.push({ expectedIndex: i - 1, actualIndex: j - 1 });
      } else {
        // substitution: ASR heard a different word where one was expected.
        // NOT an insertion — leaked cut content is EXTRA words (pure inserts).
        deletions.push(i - 1);
      }
      i -= 1;
      j -= 1;
    } else if (i > 0 && current === (score[(i - 1) * cols + j] ?? 0) - 1) {
      deletions.push(i - 1);
      i -= 1;
    } else {
      insertions.push(j - 1);
      j -= 1;
    }
  }
  pairs.reverse();
  deletions.reverse();
  insertions.reverse();
  return { pairs, deletions, insertions };
}

/** One actionable spot in the OUTPUT clock the user can jump to from the QA modal. */
interface QaIssue {
  readonly outputTime: number;
  readonly label: string;
}

interface QaCheck {
  readonly id:
    | 'words-present-in-order'
    | 'block-edges-intact'
    | 'no-cut-content-leaked'
    | 'subtitle-drift'
    | 'duration';
  readonly ok: boolean;
  readonly detail: string;
  /** Worst offenders first, capped — omitted when the check has no derivable output time (e.g. duration). */
  readonly issues?: readonly QaIssue[];
}

export interface QaReport {
  readonly ok: boolean;
  readonly checks: readonly QaCheck[];
  readonly stats: {
    readonly expectedWordCount: number;
    readonly matchedWordCount: number;
    readonly matchRatio: number;
    readonly meanDriftMs: number;
    readonly p95DriftMs: number;
    readonly insertionRunMax: number;
    readonly expectedDurationS: number;
    readonly actualDurationS: number;
  };
  readonly finalText: string;
}

const MATCH_RATIO_FLOOR = 0.85;
/** Long enough that one differing letter is a homophone, not another word. */
const HOMOPHONE_MIN_CHARS = 6;

/** Same length with one letter swapped, or one letter inserted/removed — nothing more. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return a.length === b.length
    ? a.slice(i + 1) === b.slice(i + 1)
    : a.length > b.length
      ? a.slice(i + 1) === b.slice(i)
      : a.slice(i) === b.slice(i + 1);
}

/** "atendido" heard as "entendido": the onset differs, the body of the word is the same. */
const SHARED_ENDING_MIN_CHARS = 6;

function sharesEnding(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let shared = 0;
  while (
    shared < a.length &&
    shared < b.length &&
    a[a.length - 1 - shared] === b[b.length - 1 - shared]
  ) {
    shared += 1;
  }
  return shared >= SHARED_ENDING_MIN_CHARS && shared < Math.min(a.length, b.length);
}

export function isHomophoneOf(expectedToken: string, heardToken: string): boolean {
  if (expectedToken.length < HOMOPHONE_MIN_CHARS || heardToken.length < HOMOPHONE_MIN_CHARS) {
    return false;
  }
  return withinOneEdit(expectedToken, heardToken) || sharesEnding(expectedToken, heardToken);
}

function softMatchNote(
  matches: readonly { readonly expected: string; readonly heard: string }[],
): string {
  if (matches.length === 0) return '';
  return ` (heard as a homophone: ${matches.map((m) => `"${m.expected}"≈"${m.heard}"`).join(', ')})`;
}
const DRIFT_LIMIT_MS = 150;
const DURATION_TOLERANCE = 0.01;
const LEAK_RUN_LIMIT = 3;

function longestRun(indexes: readonly number[]): number {
  let best = 0;
  let current = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const index of indexes) {
    current = index === previous + 1 ? current + 1 : 1;
    best = Math.max(best, current);
    previous = index;
  }
  return best;
}

export function buildQaReport(input: {
  doc: EditDoc;
  transcripts: ReadonlyMap<string, Transcript>;
  finalTranscript: Transcript;
  actualDurationS: number;
}): QaReport {
  // A muted base is a deliberate silent cut: the source transcript still
  // exists, but none of its words reach the output audio. Expecting them
  // would fail the whole report at 0% match on a correct render.
  const baseMuted = baseTrackOf(input.doc).muted === true;
  const expected = baseMuted ? [] : expectedWords(input.doc, input.transcripts);
  const actual = spokenWords(input.finalTranscript);
  const alignment = alignSequences(
    expected.map((w) => w.token),
    actual.map((w) => normalizeToken(w.text)),
  );

  const matchRatio = expected.length === 0 ? 1 : alignment.pairs.length / expected.length;

  const matchedIndexes = new Set(alignment.pairs.map((p) => p.expectedIndex));
  // ASR tokenization drifts between runs: "megaoperação" can come back as
  // "mega"+"operação". A compound present as consecutive actual tokens is
  // spoken audio, not a cut.
  const actualTokens = actual.map((w) => normalizeToken(w.text));
  const actualPairConcat = new Set(
    actualTokens.slice(0, -1).map((token, i) => token + (actualTokens[i + 1] ?? '')),
  );
  // A clipped block edge kills recognition of the whole boundary region; a
  // lone short word ("a", "e") missing while its neighbour matched is ASR
  // noise on the retranscription, not a mid-word cut. So is a long word
  // that came back one letter off ("atendido" heard as "entendido"): the
  // audio is there, the engine picked the homophone.
  const softMatches: { readonly expected: string; readonly heard: string }[] = [];
  const edgeMisses = expected
    .map((word, index) => ({ word, index }))
    .filter(({ word, index }) => {
      if (!word.isBlockEdge || matchedIndexes.has(index)) return false;
      if (actualPairConcat.has(word.token)) return false;
      const neighborMatched = [index - 1, index + 1].some(
        (n) => matchedIndexes.has(n) && expected[n]?.blockIndex === word.blockIndex,
      );
      if (word.token.length <= 3 && neighborMatched) return false;
      const heard = actualTokens.find((token) => isHomophoneOf(word.token, token));
      if (heard !== undefined) {
        softMatches.push({ expected: word.text, heard });
        return false;
      }
      return true;
    });

  const driftedPairs = alignment.pairs
    .map((pair) => {
      const expectedWord = expected[pair.expectedIndex];
      const actualWord = actual[pair.actualIndex];
      if (!expectedWord || !actualWord) return null;
      return {
        outputTime: expectedWord.outputTime,
        driftMs: Math.abs(expectedWord.outputTime - actualWord.start) * 1000,
      };
    })
    .filter((d): d is { outputTime: number; driftMs: number } => d !== null);
  const drifts = driftedPairs.map((d) => d.driftMs).sort((a, b) => a - b);
  const meanDriftMs =
    drifts.length === 0 ? 0 : drifts.reduce((sum, d) => sum + d, 0) / drifts.length;
  const p95DriftMs = drifts.length === 0 ? 0 : (drifts[Math.floor(drifts.length * 0.95)] ?? 0);
  const MAX_ISSUES = 8;
  // Per-word, independent of the aggregate p95 check: a single word can
  // genuinely drift past the limit while the 95th-percentile statistic over
  // the whole render still passes (percentile math on a large sample). That
  // word is still a real, fixable defect — worth a jump-to-it chip even when
  // the aggregate check is green.
  const driftIssues: QaIssue[] = [...driftedPairs]
    .filter((d) => d.driftMs > DRIFT_LIMIT_MS)
    .sort((a, b) => b.driftMs - a.driftMs)
    .slice(0, MAX_ISSUES)
    .map((d) => ({ outputTime: d.outputTime, label: `drift ${String(Math.round(d.driftMs))}ms` }));

  const insertionRunMax = longestRun(alignment.insertions);
  const globalSpeed = input.doc.output.speed ?? 1;
  const expectedDurationS = (input.doc.totalDurationS ?? 0) / globalSpeed;
  const durationDelta =
    expectedDurationS === 0
      ? 0
      : Math.abs(input.actualDurationS - expectedDurationS) / expectedDurationS;

  const edgeIssues: QaIssue[] = edgeMisses
    .slice(0, MAX_ISSUES)
    .map(({ word }) => ({ outputTime: word.outputTime, label: word.text }));
  // deletions covers both pure omissions and substitutions — both are an
  // expected word that never landed at its promised output time, in order.
  const missingOrderIssues: QaIssue[] = alignment.deletions
    .slice(0, MAX_ISSUES)
    .map((index) => expected[index])
    .filter((word): word is ExpectedWord => word !== undefined)
    .map((word) => ({ outputTime: word.outputTime, label: word.text }));

  const MUTED_NA =
    'base track muted — the main audio is deliberately absent from the output; speech checks not applicable';
  const durationCheck: QaCheck = {
    id: 'duration',
    ok: durationDelta <= DURATION_TOLERANCE,
    detail: `expected ${expectedDurationS.toFixed(2)}s, got ${input.actualDurationS.toFixed(2)}s (${(durationDelta * 100).toFixed(2)}% off, tolerance ${String(DURATION_TOLERANCE * 100)}%)`,
  };
  const checks: QaCheck[] = baseMuted
    ? [
        { id: 'words-present-in-order', ok: true, detail: MUTED_NA },
        { id: 'block-edges-intact', ok: true, detail: MUTED_NA },
        { id: 'no-cut-content-leaked', ok: true, detail: MUTED_NA },
        { id: 'subtitle-drift', ok: true, detail: MUTED_NA },
        durationCheck,
      ]
    : [
        {
          id: 'words-present-in-order',
          ok: matchRatio >= MATCH_RATIO_FLOOR,
          detail: `${String(alignment.pairs.length)}/${String(expected.length)} expected words matched in order (${(matchRatio * 100).toFixed(1)}%)`,
          ...(missingOrderIssues.length > 0 ? { issues: missingOrderIssues } : {}),
        },
        {
          id: 'block-edges-intact',
          ok: edgeMisses.length === 0,
          detail:
            edgeMisses.length === 0
              ? `first/last word of every block present — no mid-word cuts detected${softMatchNote(softMatches)}`
              : `missing block-edge words: ${edgeMisses
                  .slice(0, 5)
                  .map(({ word }) => `"${word.text}" (block ${String(word.blockIndex)})`)
                  .join(', ')}`,
          ...(edgeIssues.length > 0 ? { issues: edgeIssues } : {}),
        },
        {
          id: 'no-cut-content-leaked',
          ok: insertionRunMax < LEAK_RUN_LIMIT,
          detail:
            insertionRunMax < LEAK_RUN_LIMIT
              ? 'no run of unexpected words — cut content did not leak into the output'
              : `found a run of ${String(insertionRunMax)} unexpected words — a cut segment may have survived`,
        },
        {
          id: 'subtitle-drift',
          ok: p95DriftMs <= DRIFT_LIMIT_MS,
          detail: `word timing drift mean ${meanDriftMs.toFixed(0)}ms, p95 ${p95DriftMs.toFixed(0)}ms (limit ${String(DRIFT_LIMIT_MS)}ms)`,
          ...(driftIssues.length > 0 ? { issues: driftIssues } : {}),
        },
        durationCheck,
      ];

  return {
    ok: checks.every((c) => c.ok),
    checks,
    stats: {
      expectedWordCount: expected.length,
      matchedWordCount: alignment.pairs.length,
      matchRatio,
      meanDriftMs,
      p95DriftMs,
      insertionRunMax,
      expectedDurationS,
      actualDurationS: input.actualDurationS,
    },
    finalText: input.finalTranscript.text,
  };
}
