/**
 * A project no one has shaped yet: base blocks still mirror the sources and no
 * auxiliary track has content. Block count is a reversible signal (heavy
 * trimming can dip below the source count), so callers should combine this
 * with an in-session signal such as undo depth before granting prominence.
 */
export interface PristineCheckDoc {
  readonly tracks: readonly { readonly blocks: readonly unknown[] }[];
  readonly sources: Readonly<Record<string, unknown>>;
}

export function isPristineProject(doc: PristineCheckDoc | null): boolean {
  if (doc === null) return false;
  const [base, ...auxiliary] = doc.tracks;
  if (auxiliary.some((track) => track.blocks.length > 0)) return false;
  return (base?.blocks.length ?? 0) <= Object.keys(doc.sources).length;
}
