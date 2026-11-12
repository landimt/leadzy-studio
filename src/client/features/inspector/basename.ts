export function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
