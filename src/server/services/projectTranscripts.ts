import { silencesFromPeaks } from '../../core/peaks.js';
import type { EditDoc } from '../../core/schema.js';
import { refineTranscript, type Transcript } from '../../core/transcript.js';
import { readCachedTranscript } from './transcribe.js';
import { getOrBuildPeaks } from './waveform.js';

export async function loadProjectTranscripts(
  projectDir: string,
  doc: EditDoc,
): Promise<Map<string, Transcript>> {
  const transcripts = new Map<string, Transcript>();
  for (const [key, source] of Object.entries(doc.sources)) {
    const transcript = await readCachedTranscript(projectDir, source.path);
    if (!transcript) continue;
    // word ends reconciled with measured audio — see refineWordEnds
    const peaks = await getOrBuildPeaks(projectDir, source.path);
    const silences = peaks.ok ? silencesFromPeaks(peaks.value) : [];
    transcripts.set(key, refineTranscript(transcript, silences));
  }
  return transcripts;
}
