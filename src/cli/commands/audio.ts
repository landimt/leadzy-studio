import { err, type Result } from '../../core/result.js';
import { loadEditDoc } from '../../server/services/project.js';
import { applyEditDocument, type ApplyEditOutcome } from '../../application/applyEditDocument.js';

export interface AudioSampleOptions {
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly expectHash: string;
  readonly strength?: number;
}

export async function setAudioNoiseSample(
  projectDir: string,
  options: AudioSampleOptions,
): Promise<Result<ApplyEditOutcome>> {
  if (!Number.isFinite(options.start) || !Number.isFinite(options.end)) {
    return err('invalid-edit-json', '--in and --out must be finite numbers');
  }
  if (options.strength !== undefined && !Number.isFinite(options.strength)) {
    return err('invalid-edit-json', '--strength must be a finite number between 0 and 1');
  }
  const loaded = await loadEditDoc(projectDir);
  if (!loaded.ok) return loaded;
  const { doc } = loaded.value;
  const next = {
    ...doc,
    output: {
      ...doc.output,
      ...(options.strength !== undefined ? { denoise: options.strength } : {}),
      denoiseSample: { source: options.source, start: options.start, end: options.end },
    },
  };
  return applyEditDocument(projectDir, next, { expectHash: options.expectHash });
}

export async function clearAudioNoiseSample(
  projectDir: string,
  expectHash: string,
): Promise<Result<ApplyEditOutcome>> {
  const loaded = await loadEditDoc(projectDir);
  if (!loaded.ok) return loaded;
  const { denoiseSample: _sample, ...output } = loaded.value.doc.output;
  return applyEditDocument(projectDir, { ...loaded.value.doc, output }, { expectHash });
}
