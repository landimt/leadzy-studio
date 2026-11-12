export interface RenderProgressSummary {
  /** 'segments' while the base segments are being extracted (the slow, cache-building phase). */
  readonly phase: 'segments' | 'steps';
  readonly done: number;
  readonly total: number;
}

const STEP_PATTERN = /^\[(\d+)\/(\d+)\]\s*(.*)$/;
const SEGMENT_PATTERN = /^segment (\d+)\/(\d+)$/;

/**
 * Reads the render job's progress line (`[8/59] segment 8/25`) into what the
 * player can honestly show: segment counts while extracting, step counts
 * otherwise. Anything unparsable is `null` — better no number than a wrong one.
 */
export function summarizeRenderProgress(
  progress: string | undefined,
): RenderProgressSummary | null {
  if (progress === undefined) return null;
  const step = STEP_PATTERN.exec(progress);
  if (!step) return null;
  const segment = SEGMENT_PATTERN.exec(step[3] ?? '');
  if (segment) return { phase: 'segments', done: Number(segment[1]), total: Number(segment[2]) };
  return { phase: 'steps', done: Number(step[1]), total: Number(step[2]) };
}
