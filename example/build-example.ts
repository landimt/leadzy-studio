import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'media');

/**
 * Builds a tiny synthetic creative (two 5s takes, no heavy media in git) —
 * a repeatable playground for `studio open example/media`.
 */
async function generateTake(path: string, hue: number): Promise<void> {
  await execa('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=duration=5:size=720x1280:rate=25,hue=h=${String(hue)}`,
    '-f',
    'lavfi',
    '-i',
    "sine=frequency=330:duration=5,volume=volume='if(between(t,2,2.8),0.0001,0.4)':eval=frame",
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    path,
  ]);
}

await mkdir(EXAMPLE_DIR, { recursive: true });
await generateTake(join(EXAMPLE_DIR, 'take1.mp4'), 0);
await generateTake(join(EXAMPLE_DIR, 'take2.mp4'), 120);
await writeFile(
  join(EXAMPLE_DIR, 'README.md'),
  'Criativo sintético de exemplo — rode `pnpm studio open example/media`.\n',
);
console.log(`example creative ready at ${EXAMPLE_DIR}`);
