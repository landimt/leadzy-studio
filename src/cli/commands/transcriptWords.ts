import { err, ok, type Result } from '../../core/result.js';
import {
  blockForWords,
  formatWordLine,
  wordsInWindow,
  type WordBlock,
  type WordWindow,
} from '../../core/transcriptWords.js';
import type { TranscriptWord } from '../../core/transcript.js';
import { loadEditDoc } from '../../server/services/project.js';
import { loadProjectTranscripts } from '../../server/services/projectTranscripts.js';

export interface TranscriptWordsOptions extends WordWindow {
  readonly source: string;
  /** Also compute the base-track block that covers the words inside `from`–`to`. */
  readonly block?: boolean;
}

export interface TranscriptWordsResult {
  readonly source: string;
  readonly words: readonly TranscriptWord[];
  readonly block: (WordBlock & { readonly source: string }) | null;
}

/**
 * Word-level source times for one source — what the pack's line ranges hide
 * and what a cut inside a line needs. With `block`, the agent gets the exact
 * `{ in, out }` for a base-track block covering the words in the window,
 * padded 50/80 ms but never into a neighbouring word.
 */
export async function transcriptWords(
  projectDir: string,
  options: TranscriptWordsOptions,
): Promise<Result<TranscriptWordsResult>> {
  if (options.block && (options.from === undefined || options.to === undefined)) {
    return err('invalid-input', '--block needs both --from and --to');
  }
  const loaded = await loadEditDoc(projectDir);
  if (!loaded.ok) return loaded;
  const { doc } = loaded.value;
  const source = doc.sources[options.source];
  if (!source) {
    return err('not-found', `source "${options.source}" not found in edit.json`);
  }
  const transcript = (
    await loadProjectTranscripts(projectDir, { ...doc, sources: { [options.source]: source } })
  ).get(options.source);
  if (!transcript) {
    return err(
      'not-found',
      `no cached transcript for source "${options.source}" — run "transcribe" first`,
    );
  }
  const window: WordWindow = {
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.to !== undefined ? { to: options.to } : {}),
    ...(options.grep !== undefined ? { grep: options.grep } : {}),
  };
  const words = wordsInWindow(transcript, window);
  const block =
    options.block && options.from !== undefined && options.to !== undefined
      ? blockForWords(transcript, options.from, options.to)
      : null;
  return ok({
    source: options.source,
    words,
    block: block === null ? null : { source: options.source, ...block },
  });
}

export function formatTranscriptWords(result: TranscriptWordsResult): string {
  const lines = result.words.map(formatWordLine);
  if (result.block) {
    const { source, in: inS, out, firstWord, lastWord } = result.block;
    lines.push(
      `block: ${JSON.stringify({ source, in: inS, out })}  # "${firstWord}" … "${lastWord}"`,
    );
  }
  return lines.join('\n');
}
