import { constants } from 'node:fs';
import { copyFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { resolveExportFilename } from '../../core/exportFilename.js';

export interface ExportDelivery {
  readonly deliveryPath: string;
  readonly deliveryName: string;
}

/** The shared rule, applied to this project's folder name. */
export function exportDeliveryFilename(
  pattern: string,
  projectDir: string,
  now: Date = new Date(),
): string {
  return resolveExportFilename(pattern, basename(projectDir), now);
}

/**
 * Copies the canonical, receipt-backed final into a delivery folder. The
 * Studio artifact remains at edit/final.mp4; delivery names never overwrite.
 */
export async function deliverFinalExport(
  projectDir: string,
  directory: string,
  pattern: string,
): Promise<ExportDelivery> {
  if (!isAbsolute(directory)) throw new Error('a pasta de exportação precisa ser absoluta');
  const resolvedDirectory = await realpath(directory);
  const directoryStat = await stat(resolvedDirectory);
  if (!directoryStat.isDirectory()) throw new Error('o destino da exportação não é uma pasta');

  const source = join(projectDir, 'edit', 'final.mp4');
  const sourceStat = await stat(source);
  if (!sourceStat.isFile() || sourceStat.size === 0) {
    throw new Error('o vídeo final ainda não está disponível para entrega');
  }

  const baseName = exportDeliveryFilename(pattern, projectDir);
  const stem = baseName.slice(0, -'.mp4'.length);
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const deliveryName = suffix === 1 ? baseName : `${stem}-${String(suffix)}.mp4`;
    const deliveryPath = join(resolvedDirectory, deliveryName);
    try {
      await copyFile(source, deliveryPath, constants.COPYFILE_EXCL);
      return { deliveryPath, deliveryName };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw cause;
    }
  }
  throw new Error('não foi possível reservar um nome livre para a exportação');
}
