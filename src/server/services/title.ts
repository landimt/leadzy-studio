import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeHtml, substituteTemplate } from '../../core/htmlTemplate.js';
import { installationRoot } from '../../core/installation.js';
import { err, ok, type Result } from '../../core/result.js';
import { runFfmpeg } from './ffmpeg.js';
import { renderHyperframes } from './hyperframes.js';

const TEMPLATE_DIR = join(installationRoot(import.meta.url, 3), 'templates', 'reels', 'title-card');

type TitleStyle = 'dark' | 'paper' | 'plain';
type TitlePosition = 'top' | 'center';

export interface TitleSpec {
  readonly text: string;
  readonly style: TitleStyle;
  readonly pos: TitlePosition;
  readonly durationS: number;
}

/** `*word*` → emphasis. Runs AFTER escaping: the markers survive it, any HTML the author typed does not. */
function emphasize(escaped: string): string {
  return escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function slugOf(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'title'
  );
}

/**
 * Renders a Reels title card through HyperFrames (HTML+GSAP → webm with alpha)
 * and returns its project-relative path. Shared by the CLI and the UI so both
 * produce byte-identical assets.
 */
export async function renderTitleCard(
  projectDir: string,
  spec: TitleSpec,
): Promise<Result<string>> {
  const slug = slugOf(spec.text);
  const slot = join(projectDir, 'edit', 'assets', 'src', `title-${slug}`);
  const assetRel = `edit/assets/title-${slug}.webm`;
  try {
    await mkdir(slot, { recursive: true });
    await cp(TEMPLATE_DIR, slot, { recursive: true });
    const template = await readFile(join(slot, 'index.html'), 'utf8');
    const html = substituteTemplate(template, {
      TEXT: emphasize(escapeHtml(spec.text)),
      DUR: String(spec.durationS),
      TOP: spec.pos === 'center' ? '820' : '170',
      STYLE: spec.style,
    });
    await writeFile(join(slot, 'index.html'), html);
    const render = await renderHyperframes(slot);
    if (!render.ok) return render;
    await cp(join(slot, 'render.webm'), join(projectDir, assetRel));
    // Chrome paints VP9-alpha webm as opaque black in <video>; a transparent
    // PNG of the settled frame keeps the live preview honest.
    const companion = await runFfmpeg(
      [
        '-y',
        '-sseof',
        '-0.2',
        '-c:v',
        'libvpx-vp9',
        '-i',
        join(projectDir, assetRel),
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgba',
        join(projectDir, `${assetRel}.png`),
      ],
      { cwd: projectDir },
    );
    if (!companion.ok) return companion;
    return ok(assetRel);
  } catch (cause) {
    return err('io-failed', `failed to generate the title "${spec.text}"`, cause);
  }
}
