import { basename } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import { packTranscript } from '../../core/transcriptPack.js';
import { loadEditDoc } from '../../server/services/project.js';
import { loadProjectTranscripts } from '../../server/services/projectTranscripts.js';

export interface TranscriptPackOptions {
  readonly source?: string;
}

/**
 * Agent-facing compact transcript view — one `packTranscript` block per
 * source, concatenated. `loadProjectTranscripts` already runs
 * `refineTranscript` before this, which `packTranscript` requires.
 */
export async function transcriptPack(
  projectDir: string,
  options: TranscriptPackOptions = {},
): Promise<Result<string>> {
  const loaded = await loadEditDoc(projectDir);
  if (!loaded.ok) return loaded;
  const { doc } = loaded.value;

  if (options.source !== undefined && !doc.sources[options.source]) {
    return err('not-found', `source "${options.source}" not found in edit.json`);
  }
  const entries = Object.entries(doc.sources).filter(
    ([key]) => options.source === undefined || key === options.source,
  );

  const transcripts = await loadProjectTranscripts(projectDir, doc);
  const packs: string[] = [];
  for (const [key, source] of entries) {
    const transcript = transcripts.get(key);
    if (!transcript) {
      if (options.source !== undefined) {
        return err(
          'not-found',
          `no cached transcript for source "${key}" — run "transcribe" first`,
        );
      }
      continue;
    }
    packs.push(
      packTranscript(
        basename(source.path),
        transcript,
        (doc.subtitles.corrections ?? []).filter((c) => c.source === key),
      ),
    );
  }

  if (packs.length === 0) {
    return err('not-found', 'no cached transcripts found for this project');
  }
  return ok(packs.join('\n\n'));
}
