export const ICON_PLUS = 'M8 3v10 M3 8h10';

/* Each source renders as a small filmstrip — thumbnail, name, duration — so a
   take is recognised by its image, not decoded from an MVI_ file name. All the
   card visuals live in styles.css under .film-tab; the utilities only strip the
   primitive's own chrome. */

export function formatSeconds(durationS: number | undefined): string {
  return durationS === undefined ? '' : `${durationS.toFixed(1)}s`;
}
