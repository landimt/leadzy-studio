/** Compact editor duration: stable width without looking like a debug value. */
export function formatEditorDuration(durationS: number | null | undefined): string {
  if (durationS === null || durationS === undefined || !Number.isFinite(durationS)) return '–:––';
  const totalSeconds = Math.max(0, Math.round(durationS));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${mm}:${ss}` : `${mm}:${ss}`;
}
