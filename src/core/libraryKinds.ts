/** Closed set shared by server routes and client UI — extend HERE, both sides follow. */
export const LIBRARY_ITEM_KINDS = [
  'lower-third',
  'cta',
  'outro',
  'sticker',
  'title',
  'other',
] as const;

export type LibraryItemKind = (typeof LIBRARY_ITEM_KINDS)[number];
