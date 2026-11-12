import { compactProjectStatus } from './commands/compactStatus.js';
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { StudioDb } from '../db/index.js';
import { extractFrames } from '../server/services/frames.js';
import { editDocHash, loadEditDoc } from '../server/services/project.js';
import { renderProject } from '../server/services/render.js';
import { renderAudioPreview } from '../server/services/audioPreview.js';
import { runQa } from '../server/services/qa.js';
import type { Suggestion } from '../core/schema.js';
import type { RenderQuality, VideoEncoder } from '../core/render/options.js';
import { suggestionSummaryLine } from '../core/suggest.js';
import { loadDotEnv, preferLocalToolchain } from './env.js';
import { resolveElevenLabsApiKey } from '../server/services/userConfig.js';
import { resolveProjectDir } from './projectContext.js';
import {
  mediaSummaryLine,
  projectStatus,
  transcriptSummaryLine,
  validateProject,
} from './commands/inspect.js';
import { applyEditDocument } from '../application/applyEditDocument.js';
import {
  addLibraryItem,
  applyLibraryRebake,
  importLibraryItem,
  parseVariableAssignments,
  prepareLibraryRebake,
} from '../application/library.js';
import { EditHistory } from '../server/services/editHistory.js';
import { EditWriter } from '../server/services/editWriter.js';
import { probeMedia } from '../server/services/ffmpeg.js';
import { OverlayLibrary } from '../server/services/library.js';
import { clearAudioNoiseSample, setAudioNoiseSample } from './commands/audio.js';
import { diagnoseInstallation, studioVersion } from './commands/doctor.js';
import { openProject } from './commands/open.js';
import { autocut, reviewSuggestions, suggestCuts } from '../application/suggestCuts.js';
import { transcribeProject } from '../application/transcribeProject.js';
import { transcriptPack } from './commands/transcriptPack.js';
import { formatTranscriptWords, transcriptWords } from './commands/transcriptWords.js';
import type { Result } from '../core/result.js';
import { installAgentSkills } from './agentIntegration.js';
import { parseChoice, parseIdList, parseSeconds } from './args.js';

loadDotEnv();
preferLocalToolchain();

function formatSuggestion(suggestion: Suggestion): string {
  const kind = {
    silence: 'pause',
    repetition: 'repetition',
    'false-start': 'false-start',
    filler: 'filler',
  }[suggestion.type];
  return `[${kind}] ${suggestion.source} ${suggestion.start.toFixed(2)}–${suggestion.end.toFixed(2)}s — ${suggestion.reason}`;
}

const program = new Command()
  .name('studio')
  .version(studioVersion())
  .description('Leadzy Studio — transcript-first video editor, operable by an agent');

program
  .command('doctor')
  .description('checks Node, FFmpeg/FFprobe, resources, and optional agents')
  .option('--json', 'structured output for automation')
  .action(async (options: { json?: boolean }) => {
    const checks = await diagnoseInstallation();
    if (options.json) {
      console.log(
        JSON.stringify({ ok: checks.every((check) => check.status !== 'error'), checks }),
      );
    } else {
      for (const check of checks) {
        const mark = check.status === 'ok' ? '✓' : check.status === 'warning' ? '!' : '✗';
        console.log(`${mark} ${check.label}: ${check.message}`);
      }
    }
    if (checks.some((check) => check.status === 'error')) process.exitCode = 1;
  });

function fail(error: { code: string; message: string }): never {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
  process.exit(1);
}

function need<T>(result: Result<T>): T {
  if (!result.ok) fail(result.error);
  return result.value;
}

program
  .command('open', { isDefault: true })
  .description('prepares the creative folder (edit/, CLAUDE.md, waveforms, index) and opens the UI')
  .argument('[folder]', "folder with the creative's videos (default: the current folder)", '.')
  .option('--no-ui', 'only prepares, without starting the interface')
  .action(async (folder: string, options: { ui: boolean }) => {
    const projectDir = need(resolveProjectDir(folder));
    const summary = need(await openProject(projectDir));

    if (summary.ffmpegWarning) console.warn(`⚠ ${summary.ffmpegWarning}`);
    for (const warning of summary.warnings) console.warn(`⚠ ${warning}`);
    console.log(
      `Ready: ${String(summary.mediaFiles.length)} media file(s), ${String(summary.transcribedCount)} transcribed, ${String(summary.doc.tracks.length)} track(s).`,
    );

    if (options.ui) {
      const { startServer } = await import('../server/index.js');
      const { address } = await startServer(projectDir);
      console.log(`UI at ${address} — Ctrl+C to exit.`);
      const { default: open } = await import('node:child_process').then((m) => ({
        default: (url: string) => {
          const command =
            process.platform === 'darwin'
              ? ['open', url]
              : process.platform === 'win32'
                ? // cmd's `start` reads its first quoted argument as a window
                  // title, so the empty one keeps the URL in the URL slot.
                  ['cmd', '/c', 'start', '', url]
                : ['xdg-open', url];
          m.spawn(command[0] ?? 'open', command.slice(1), { stdio: 'ignore', detached: true });
        },
      }));
      open(address);
    }
  });

program
  .command('transcribe')
  .description(
    'transcribes media whose transcript is missing or whose media file or keyterms changed (ElevenLabs Scribe)',
  )
  .argument('<folder>')
  .option('-y, --yes', 'skips the confirmation before spending on the API')
  .option('--force', 'transcribes every media again; the old caches go to edit/history')
  .action(async (folder: string, options: { yes?: boolean; force?: boolean }) => {
    const projectDir = need(resolveProjectDir(folder));
    const { key: apiKey } = await resolveElevenLabsApiKey();
    const summary = need(
      await transcribeProject(projectDir, {
        ...(apiKey !== undefined ? { apiKey } : {}),
        force: options.force ?? false,
        assumeYes: options.yes ?? false,
      }),
    );
    for (const file of summary.skippedCached) console.log(`cached: ${file}`);
    for (const file of summary.transcribed) console.log(`transcribed: ${file}`);
  });

const transcriptCommand = program
  .command('transcript')
  .description("reads the project's transcript in agent-friendly formats");

transcriptCommand
  .command('pack')
  .description(
    'compact transcript view: stable text with exact source times, speakers, and audio events',
  )
  .argument('[folder]', "the creative's folder", '.')
  .option('--source <id>', 'limit the pack to a single source id')
  .action(async (folder: string, options: { source?: string }) => {
    const projectDir = need(resolveProjectDir(folder));
    const pack = need(
      await transcriptPack(
        projectDir,
        options.source !== undefined ? { source: options.source } : {},
      ),
    );
    console.log(pack);
  });

transcriptCommand
  .command('words')
  .description(
    'word-level source times for one source; with --block, the base-track {in, out} covering the words between --from and --to (50/80 ms of air, never into a neighbouring word)',
  )
  .argument('[folder]', "the creative's folder", '.')
  .requiredOption('--source <id>', 'the source id from edit.json')
  .option('--from <s>', 'keep words ending after this source time')
  .option('--to <s>', 'keep words starting before this source time')
  .option('--grep <text>', 'keep words containing this text (case-insensitive, plain substring)')
  .option('--block', 'also print the block covering the words between --from and --to')
  .option('--json', 'stable, parseable JSON output')
  .action(
    async (
      folder: string,
      options: {
        source: string;
        from?: string;
        to?: string;
        grep?: string;
        block?: boolean;
        json?: boolean;
      },
    ) => {
      const projectDir = need(resolveProjectDir(folder));
      const from = need(parseSeconds('--from', options.from));
      const to = need(parseSeconds('--to', options.to));
      const result = need(
        await transcriptWords(projectDir, {
          source: options.source,
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          ...(options.grep !== undefined ? { grep: options.grep } : {}),
          ...(options.block ? { block: true } : {}),
        }),
      );
      console.log(options.json ? JSON.stringify(result, null, 2) : formatTranscriptWords(result));
    },
  );

program
  .command('suggest')
  .description(
    'offline cut suggestions: pauses (always) + repetitions, false starts and fillers (with a transcript); --accept/--reject settle recorded ones instead',
  )
  .argument('<folder>')
  .option('--threshold-db <db>', 'silence threshold in dB', '-35')
  .option('--min-silence <s>', 'minimum silence duration in seconds', '0.5')
  .option('--accept <ids>', 'comma-separated suggestion ids to cut from the base track')
  .option('--accept-all', 'cut every recorded suggestion')
  .option('--reject <ids>', 'comma-separated suggestion ids to drop without cutting')
  .option('--json', 'stable, parseable JSON output')
  .action(
    async (
      folder: string,
      options: {
        thresholdDb: string;
        minSilence: string;
        accept?: string;
        acceptAll?: boolean;
        reject?: string;
        json?: boolean;
      },
    ) => {
      const projectDir = need(resolveProjectDir(folder));
      const accept = parseIdList(options.accept);
      const reject = parseIdList(options.reject);
      if (accept !== undefined || reject !== undefined || options.acceptAll) {
        const summary = need(
          await reviewSuggestions(projectDir, {
            ...(accept !== undefined ? { accept } : {}),
            ...(reject !== undefined ? { reject } : {}),
            ...(options.acceptAll ? { acceptAll: true } : {}),
          }),
        );
        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(
            `✓ ${String(summary.accepted.length)} accepted (cut) · ${String(summary.rejected.length)} rejected · ${String(summary.remaining)} still pending · final duration ${summary.totalDurationS.toFixed(2)}s`,
          );
          console.log(`editHash ${summary.editHash}`);
        }
        return;
      }
      const summary = need(
        await suggestCuts(projectDir, {
          thresholdDb: Number(options.thresholdDb),
          minSilenceS: Number(options.minSilence),
        }),
      );
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      if (!summary.hadTranscripts) {
        console.warn('⚠ no transcript: pause-only suggestions (repetitions need the text).');
      }
      for (const suggestion of summary.suggestions) {
        console.log(`${formatSuggestion(suggestion)} [${suggestion.id}]`);
      }
      console.log(
        `${String(summary.suggestions.length)} suggestion(s) (${suggestionSummaryLine(summary.suggestions)}) recorded in edit/edit.json — settle them with studio suggest <folder> --accept <ids> / --reject <ids> / --accept-all.`,
      );
      console.log(`editHash ${summary.editHash}`);
    },
  );

program
  .command('autocut')
  .description('fast cut: measures silence and applies ALL pause cuts at once')
  .argument('<folder>')
  .option('--threshold-db <db>', 'silence threshold in dB', '-35')
  .option('--min-silence <s>', 'minimum silence duration in seconds', '0.5')
  .action(async (folder: string, options: { thresholdDb: string; minSilence: string }) => {
    const projectDir = need(resolveProjectDir(folder));
    const summary = need(
      await autocut(projectDir, {
        thresholdDb: Number(options.thresholdDb),
        minSilenceS: Number(options.minSilence),
      }),
    );
    console.log(
      `✓ ${String(summary.applied)} pause(s) cut · −${summary.removedS.toFixed(1)}s · final duration ${summary.totalDurationS.toFixed(1)}s`,
    );
    console.log('Review it in the UI or run: studio render <folder> --preview');
  });

program
  .command('status')
  .description('summarizes the project for humans or agents, without changing files')
  .argument('[folder]', "the creative's folder", '.')
  .option('--json', 'stable, parseable JSON output')
  .option('--compact', 'bounded JSON with hash, pending work and the editing workflow')
  .action(async (folder: string, options: { json?: boolean; compact?: boolean }) => {
    const projectDir = need(resolveProjectDir(folder));
    const status = await projectStatus(projectDir);
    if (options.compact) {
      console.log(JSON.stringify(compactProjectStatus(status)));
    } else if (options.json) {
      console.log(JSON.stringify(status, null, 2));
    } else if (!('validation' in status)) {
      console.error(`✗ ${status.issues.map((issue) => issue.message).join('; ')}`);
    } else {
      console.log(
        `${status.projectName}: ${String(status.sources)} source(s), ${String(status.tracks)} track(s), ${String(status.blocks)} block(s), ${status.renderedDurationS.toFixed(2)}s final`,
      );
      console.log(`editHash ${status.editHash}`);
      console.log(
        `audio A/B ${status.audioComparisonExists ? (status.audioComparisonCurrent ? '✓' : 'stale') : '—'} · preview ${status.previewExists ? (status.previewCurrent ? '✓' : 'stale') : '—'} · final ${status.finalExists ? (status.finalCurrent ? '✓' : 'stale') : '—'} · validation ${status.validation.ok ? '✓' : '✗'}`,
      );
      console.log(transcriptSummaryLine(status.transcripts));
      const mediaLine = mediaSummaryLine(status.media);
      if (mediaLine !== null) console.log(mediaLine);
    }
    const valid = 'validation' in status && status.validation.ok;
    if (!valid) process.exitCode = 2;
  });

program
  .command('validate')
  .description('validates schema, media/asset references, and derived duration')
  .argument('[folder]', "the creative's folder", '.')
  .option('--json', 'stable, parseable JSON output')
  .action(async (folder: string, options: { json?: boolean }) => {
    const projectDir = need(resolveProjectDir(folder));
    const report = await validateProject(projectDir);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.ok) {
      console.log(`✓ edit.json and ${report.editHash ?? 'references'} valid`);
    } else {
      for (const issue of report.issues) {
        console.error(`✗ ${issue.path}: ${issue.message}`);
      }
    }
    if (!report.ok) process.exitCode = 2;
  });

const editCommand = program
  .command('edit')
  .description('mutates edit.json with validation, optimistic hash, atomic write, and history');

editCommand
  .command('apply')
  .description('applies a complete JSON document; reads stdin by default')
  .argument('[folder]', "the creative's folder", '.')
  .option('--file <json>', 'reads the document from this file instead of stdin')
  .requiredOption('--expect-hash <sha1>', 'hash returned by "studio status --json"')
  .option('--json', 'stable, parseable JSON output')
  .action(
    async (folder: string, options: { file?: string; expectHash: string; json?: boolean }) => {
      const projectDir = need(resolveProjectDir(folder));
      const raw = options.file
        ? await readFile(options.file, 'utf8')
        : await new Promise<string>((resolve, reject) => {
            let input = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (chunk: string) => {
              input += chunk;
            });
            process.stdin.on('end', () => {
              resolve(input);
            });
            process.stdin.on('error', reject);
          });
      let document: unknown;
      try {
        document = JSON.parse(raw) as unknown;
      } catch (cause) {
        fail({
          code: 'invalid-edit-json',
          message: `input is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
      const outcome = need(
        await applyEditDocument(projectDir, document, { expectHash: options.expectHash }),
      );
      if (options.json) console.log(JSON.stringify(outcome, null, 2));
      else console.log(`✓ edit.json ${outcome.editHash} · ${outcome.totalDurationS.toFixed(2)}s`);
    },
  );

const audioCommand = program
  .command('audio')
  .description('analyzes and configures audio treatment the agent can play back');

audioCommand
  .command('sample')
  .description("uses a room tone clip from the source as the noise's spectral profile")
  .argument('<folder>', "the creative's folder")
  .requiredOption('--source <id>', 'source id in edit.json')
  .requiredOption('--in <s>', 'clip start, in source time')
  .requiredOption('--out <s>', 'clip end, in source time')
  .requiredOption('--expect-hash <sha1>', 'hash returned by "studio status --json"')
  .option('--strength <0-1>', 'also sets output.denoise')
  .option('--json', 'stable, parseable JSON output')
  .action(
    async (
      folder: string,
      options: {
        source: string;
        in: string;
        out: string;
        expectHash: string;
        strength?: string;
        json?: boolean;
      },
    ) => {
      const projectDir = need(resolveProjectDir(folder));
      const outcome = need(
        await setAudioNoiseSample(projectDir, {
          source: options.source,
          start: Number(options.in),
          end: Number(options.out),
          expectHash: options.expectHash,
          ...(options.strength !== undefined ? { strength: Number(options.strength) } : {}),
        }),
      );
      if (options.json) console.log(JSON.stringify(outcome, null, 2));
      else console.log(`✓ room tone saved · edit.json ${outcome.editHash}`);
    },
  );

audioCommand
  .command('auto')
  .description('removes the manual sample and reverts to automatic room tone detection')
  .argument('<folder>', "the creative's folder")
  .requiredOption('--expect-hash <sha1>', 'hash returned by "studio status --json"')
  .option('--json', 'stable, parseable JSON output')
  .action(async (folder: string, options: { expectHash: string; json?: boolean }) => {
    const projectDir = need(resolveProjectDir(folder));
    const outcome = need(await clearAudioNoiseSample(projectDir, options.expectHash));
    if (options.json) console.log(JSON.stringify(outcome, null, 2));
    else console.log(`✓ automatic detection re-enabled · edit.json ${outcome.editHash}`);
  });

audioCommand
  .command('preview')
  .description('generates a before/after A/B .m4a comparison with the exact export chain')
  .argument('<folder>', "the creative's folder")
  .option('--json', 'stable, parseable JSON output')
  .action(async (folder: string, options: { json?: boolean }) => {
    const projectDir = need(resolveProjectDir(folder));
    const loaded = need(await loadEditDoc(projectDir));
    const outcome = need(
      await renderAudioPreview(projectDir, loaded.doc, (progress) => {
        if (!options.json) {
          console.log(`[${String(progress.index)}/${String(progress.total)}] ${progress.step}`);
        }
      }),
    );
    if (options.json) console.log(JSON.stringify(outcome, null, 2));
    else
      console.log(
        `✓ audio comparison · before: ${outcome.beforeOutputRel} · after: ${outcome.outputRel} (${outcome.durationS.toFixed(2)}s)`,
      );
  });

program
  .command('title')
  .description(
    'standard Reels on-screen text: an animated card with the text, already placed on the timeline',
  )
  .argument('<folder>')
  .argument('<text>', 'use *word* to highlight it in pink')
  .option('--at <s>', 'when it enters (output time)', '0.5')
  .option('--dur <s>', 'duration', '4')
  .option('--pos <pos>', 'top | center', 'top')
  .option('--style <style>', 'dark | paper | plain (no background)', 'dark')
  .action(
    async (
      folder: string,
      text: string,
      options: { at: string; dur: string; pos: string; style: string },
    ) => {
      const projectDir = need(resolveProjectDir(folder));
      const { renderTitleCard } = await import('../server/services/title.js');
      const spec = {
        text,
        style: options.style as 'dark' | 'paper' | 'plain',
        pos: options.pos as 'top' | 'center',
        durationS: Number(options.dur),
      };
      const assetRel = need(await renderTitleCard(projectDir, spec));
      const loaded = need(await loadEditDoc(projectDir));
      const doc = loaded.doc;
      const block = {
        file: assetRel,
        at: Number(options.at),
        duration: spec.durationS,
        title: { text: spec.text, style: spec.style, pos: spec.pos },
      };
      const overlayTrack = doc.tracks.find((track) => track.kind === 'overlay');
      const tracks = overlayTrack
        ? doc.tracks.map((track) =>
            track === overlayTrack ? { ...track, blocks: [...track.blocks, block] } : track,
          )
        : [...doc.tracks, { id: 'overlays', kind: 'overlay' as const, blocks: [block] }];
      need(
        await applyEditDocument(projectDir, { ...doc, tracks }, { expectHash: editDocHash(doc) }),
      );
      console.log(`✓ title live: "${text}" @ ${options.at}s for ${options.dur}s (${assetRel})`);
    },
  );

const RENDER_QUALITIES: readonly RenderQuality[] = ['recommended', 'high', 'max'];
const VIDEO_ENCODERS: readonly VideoEncoder[] = ['libx264', 'h264_videotoolbox', 'h264_nvenc'];

program
  .command('render')
  .description('renders the cut (hard rules: 30ms fades, concat without re-encode, subtitles last)')
  .argument('<folder>')
  .option('--preview', 'fast 720p render')
  .option('--no-subtitles', 'no burned-in subtitles')
  .option('--no-loudnorm', 'no loudness normalization')
  .option('--quality <level>', 'recommended | high | max — the final encode quality')
  .option(
    '--encoder <name>',
    'libx264 (the default, reproducible across machines) | h264_videotoolbox | h264_nvenc (hardware, much faster)',
  )
  .action(
    async (
      folder: string,
      options: {
        preview?: boolean;
        subtitles: boolean;
        loudnorm: boolean;
        quality?: string;
        encoder?: string;
      },
    ) => {
      const projectDir = need(resolveProjectDir(folder));
      const loaded = need(await loadEditDoc(projectDir));
      const quality = need(parseChoice('--quality', options.quality, RENDER_QUALITIES));
      const encoder = need(parseChoice('--encoder', options.encoder, VIDEO_ENCODERS));
      const outcome = need(
        await renderProject(
          projectDir,
          loaded.doc,
          {
            preview: options.preview ?? false,
            subtitles: options.subtitles,
            loudnorm: options.loudnorm,
            ...(quality !== undefined ? { quality } : {}),
            ...(encoder !== undefined ? { videoEncoder: encoder } : {}),
          },
          (progress) => {
            console.log(`[${String(progress.index)}/${String(progress.total)}] ${progress.step}`);
          },
        ),
      );
      const db = new StudioDb();
      try {
        const project = db.upsertProject(projectDir);
        db.recordRender(
          project.id,
          options.preview ? 'preview' : 'final',
          outcome.outputRel,
          outcome.durationS,
          null,
        );
      } finally {
        db.close();
      }
      console.log(
        `✓ ${outcome.outputRel} — ${outcome.durationS.toFixed(2)}s (expected ${outcome.expectedDurationS.toFixed(2)}s)`,
      );
    },
  );

program
  .command('qa')
  .description('retranscribes edit/final.mp4 and compares it with the expected cut')
  .argument('<folder>')
  .action(async (folder: string) => {
    const projectDir = need(resolveProjectDir(folder));
    const loaded = need(await loadEditDoc(projectDir));
    const { key: apiKey } = await resolveElevenLabsApiKey();
    const report = need(
      await runQa(projectDir, loaded.doc, {
        ...(apiKey !== undefined ? { apiKey } : {}),
      }),
    );
    for (const check of report.checks) {
      console.log(`${check.ok ? '✓' : '✗'} ${check.id}: ${check.detail}`);
    }
    console.log(
      report.ok
        ? '✓ QA green — report at edit/qa/report.json'
        : '✗ QA failed — see edit/qa/report.json',
    );

    const db = new StudioDb();
    try {
      const project = db.upsertProject(projectDir);
      db.setRenderQa(project.id, 'edit/final.mp4', report.ok);
    } finally {
      db.close();
    }
    if (!report.ok) process.exitCode = 1;
  });

program
  .command('frames')
  .description('extracts PNG frames from the preview for the agent to check visual positioning')
  .argument('<folder>')
  .option('--times <list>', 'times in seconds, comma-separated (e.g. 1.2,5.0)')
  .option('--final', 'uses edit/final.mp4 instead of edit/preview.mp4')
  .action(async (folder: string, options: { times?: string; final?: boolean }) => {
    const projectDir = need(resolveProjectDir(folder));
    const times = options.times
      ?.split(',')
      .map((t) => Number(t.trim()))
      .filter((t) => Number.isFinite(t));
    const result = need(
      await extractFrames(projectDir, {
        ...(times && times.length > 0 ? { times } : {}),
        ...(options.final ? { source: 'final' as const } : {}),
      }),
    );
    for (const frame of result.frames) {
      console.log(`${frame.timeS.toFixed(2)}s → ${frame.relPath}`);
    }
    console.log(
      'Open the PNGs and check: safe zone, overlap with face/subtitle, cuts mid-gesture.',
    );
  });

const libraryCommand = program
  .command('library')
  .description(
    'the personal overlay library (~/.leadzy-studio/library): list, import, re-bake, add',
  );

libraryCommand
  .command('list')
  .description('lists the reusable pieces with their kind, duration and editable variables')
  .option('--json', 'stable, parseable JSON output')
  .action(async (options: { json?: boolean }) => {
    const items = await new OverlayLibrary().list();
    if (options.json) {
      console.log(JSON.stringify({ items }, null, 2));
      return;
    }
    if (items.length === 0) {
      console.log('library is empty — save a piece from the UI or `studio library add <folder>`');
      return;
    }
    for (const item of items) {
      const variables = item.variables?.map((variable) => variable.name).join(', ');
      console.log(
        `${item.id}  [${item.kind}] ${item.name}${item.durationS !== undefined ? ` · ${String(item.durationS)}s` : ''}${variables ? ` · vars: ${variables}` : ''}`,
      );
    }
  });

libraryCommand
  .command('import')
  .description('copies a library piece into the project and appends an overlay block for it')
  .argument('<folder>', "the creative's folder")
  .requiredOption('--id <id>', 'library item id (see `studio library list`)')
  .requiredOption('--at <seconds>', 'output time where the piece starts')
  .option('--json', 'stable, parseable JSON output')
  .action(async (folder: string, options: { id: string; at: string; json?: boolean }) => {
    const projectDir = need(resolveProjectDir(folder));
    const at = Number(options.at);
    if (!Number.isFinite(at) || at < 0)
      fail({ code: 'invalid-argument', message: '--at must be a number of seconds, zero or more' });
    const outcome = await importLibraryItem(
      projectDir,
      {
        library: new OverlayLibrary(),
        editWriter: new EditWriter(projectDir, new EditHistory(projectDir)),
        probe: probeMedia,
        origin: 'agent',
      },
      { id: options.id, at },
    );
    if (!outcome.ok) fail({ code: outcome.code, message: outcome.message });
    if (options.json) {
      console.log(
        JSON.stringify({ ok: true, editHash: outcome.hash, file: outcome.file }, null, 2),
      );
      return;
    }
    console.log(
      `✓ imported ${options.id} at ${String(at)}s → ${outcome.file} (editHash ${outcome.hash})`,
    );
  });

libraryCommand
  .command('bake')
  .description(
    're-renders an imported parametric piece with new variable values and repoints its block',
  )
  .argument('<folder>', "the creative's folder")
  .requiredOption('--track <id>', 'overlay track id holding the block')
  .requiredOption('--block <index>', 'block index on that track')
  .option('--at <seconds>', "the block's current `at`, to tell twins apart")
  .option(
    '--var <NAME=value>',
    "variable value; repeat for each (all of the piece's variables)",
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option('--json', 'stable, parseable JSON output')
  .action(
    async (
      folder: string,
      options: { track: string; block: string; at?: string; var: string[]; json?: boolean },
    ) => {
      const projectDir = need(resolveProjectDir(folder));
      const blockIndex = Number(options.block);
      if (!Number.isInteger(blockIndex) || blockIndex < 0)
        fail({ code: 'invalid-argument', message: '--block must be a non-negative integer' });
      const at = options.at === undefined ? undefined : Number(options.at);
      if (at !== undefined && (!Number.isFinite(at) || at < 0))
        fail({ code: 'invalid-argument', message: '--at must be a number of seconds' });
      const parsedVariables = parseVariableAssignments(options.var);
      if (!parsedVariables.ok) fail({ code: 'invalid-argument', message: parsedVariables.message });
      const loaded = need(await loadEditDoc(projectDir));
      const track = loaded.doc.tracks.find(
        (candidate) => candidate.kind === 'overlay' && candidate.id === options.track,
      );
      const block = track?.kind === 'overlay' ? track.blocks[blockIndex] : undefined;
      if (block === undefined)
        fail({
          code: 'not-found',
          message: `no block ${String(blockIndex)} on overlay track "${options.track}"`,
        });
      const request = {
        trackId: options.track,
        blockIndex,
        file: block.file,
        ...(at !== undefined ? { at } : {}),
        variables: parsedVariables.variables,
      };
      const prepared = prepareLibraryRebake(loaded.doc, request);
      if (!prepared.ok) fail({ code: prepared.code, message: prepared.message });
      const { renderLibraryOverlay } = await import('../server/services/libraryOverlay.js');
      const baked = await applyLibraryRebake(
        projectDir,
        {
          editWriter: new EditWriter(projectDir, new EditHistory(projectDir)),
          probe: probeMedia,
          render: renderLibraryOverlay,
          origin: 'agent',
        },
        prepared.plan,
        request,
      );
      if (options.json) {
        console.log(JSON.stringify({ ok: true, editHash: baked.hash, file: baked.file }, null, 2));
        return;
      }
      console.log(`✓ baked → ${baked.file} (editHash ${baked.hash})`);
    },
  );

libraryCommand
  .command('add')
  .description('copies an item folder (item.json + asset + preview + template) into the library')
  .argument('<itemFolder>', 'a folder holding a valid item.json whose id matches the folder name')
  .option('--json', 'stable, parseable JSON output')
  .action(async (itemFolder: string, options: { json?: boolean }) => {
    const added = await addLibraryItem(new OverlayLibrary(), itemFolder);
    if (!added.ok) fail({ code: 'invalid-argument', message: added.message });
    if (options.json) {
      console.log(JSON.stringify({ ok: true, item: added.item }, null, 2));
      return;
    }
    console.log(`✓ library item ${added.item.id} added (${added.item.kind}: ${added.item.name})`);
  });

program
  .command('search')
  .description('searches the spoken text of every indexed project (FTS)')
  .argument('<text...>')
  .action((terms: string[]) => {
    const db = new StudioDb();
    try {
      const hits = db.search(terms.join(' '));
      if (hits.length === 0) {
        console.log('nothing found.');
        return;
      }
      for (const hit of hits) {
        console.log(`${hit.projectPath} :: ${hit.mediaRelPath}\n  ${hit.snippet}`);
      }
    } finally {
      db.close();
    }
  });

program
  .command('install-skill')
  .description('installs the Studio skill into Claude Code and Codex')
  .action(async () => {
    const installed = await installAgentSkills();
    for (const agent of installed) {
      console.log(`✓ skill instalada para ${agent}`);
    }
  });

// Commander switches to `from: 'electron'` whenever `process.versions.electron`
// exists — also under ELECTRON_RUN_AS_NODE, where argv is plain node-shaped
// and that mode would hand the script path to the first command as an argument.
program.parseAsync(process.argv, { from: 'node' }).catch((error: unknown) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
