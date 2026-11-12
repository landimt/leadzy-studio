import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves files shipped with the Studio in both source checkouts and packaged
 * desktop builds. Electron sets LEADZY_STUDIO_ROOT to process.resourcesPath;
 * source/CLI runs keep resolving relative to the current module.
 */
export function installationRoot(moduleUrl: string, parentLevels: number): string {
  const configured = process.env.LEADZY_STUDIO_ROOT?.trim();
  if (configured) return resolve(configured);
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const compiledMarker = `${sep}dist${sep}node${sep}`;
  const compiledAt = moduleDir.lastIndexOf(compiledMarker);
  if (compiledAt >= 0) return moduleDir.slice(0, compiledAt);
  return resolve(moduleDir, ...Array<string>(parentLevels).fill('..'));
}
