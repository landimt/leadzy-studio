import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '../../core/result.js';
import { audioPreviewAudibleSourceKeys } from '../../core/audioPreviewFreshness.js';
import { baseTrackOf, parseEditDoc, type EditDoc } from '../../core/schema.js';
import { visibleDoc, visibleRenderDoc } from '../../core/render/document.js';
import type { RenderArtifactKind } from '../../core/render/options.js';
import { programSourceKeys } from '../../core/render/freshness.js';
import { mediaHash } from './mediaHash.js';
import { editDocHash, resolveProjectFile } from './project.js';
import { transcriptCachePath } from './transcribe.js';

/** Everything a receipt can describe: the published artifacts plus the audio-only proof. */
export type ReceiptKind = RenderArtifactKind | 'audio-preview';

/**
 * Semantic renderer contract. Bump whenever the same edit document and input
 * bytes can produce a meaningfully different artifact (for example, a preset
 * default or filtergraph/encoding behavior changes).
 */
// v2: overlay/pip placement now mirrors the live player (full-frame {x,y}
// anchors, per-axis corner margins) — earlier renders place overlays
// somewhere the preview never showed and must read as stale.
export const RENDERER_CONTRACT_FINGERPRINT = 'leadzy-renderer-contract-v2';

interface RenderInputsReceipt {
  readonly version: 1;
  readonly rendererContract: typeof RENDERER_CONTRACT_FINGERPRINT;
  readonly kind: ReceiptKind;
  readonly editHash: string;
  readonly inputs: Readonly<Record<string, string>>;
}

/**
 * Cheap identities for every input that can change the rendered bytes.
 * Audio previews depend only on audible media; video artifacts additionally
 * include overlays and transcript caches used for burned subtitles. A lease
 * may supply media hashes captured atomically while pinning; those replace
 * only source/overlay stats, while transcript caches are always read live.
 */
export async function renderInputFingerprints(
  projectDir: string,
  inputDoc: EditDoc,
  kind: ReceiptKind,
  executionDoc?: EditDoc,
  capturedMediaHashes?: ReadonlyMap<string, string>,
): Promise<Result<Readonly<Record<string, string>>>> {
  const projectDoc = kind === 'audio-preview' ? visibleDoc : visibleRenderDoc;
  const doc = projectDoc(inputDoc);
  const executed = executionDoc === undefined ? doc : projectDoc(executionDoc);
  const candidates = new Map<
    string,
    { path: string; optional: boolean; authoringMediaPath?: string }
  >();
  const audioSourceKeys =
    kind === 'audio-preview'
      ? audioPreviewAudibleSourceKeys(doc)
      : kind === 'program'
        ? programSourceKeys(doc)
        : undefined;
  const subtitleSourceKeys =
    kind !== 'audio-preview' && kind !== 'program' && doc.subtitles.enabled
      ? new Set(baseTrackOf(doc).blocks.map((block) => block.source))
      : undefined;
  for (const [key, source] of Object.entries(doc.sources)) {
    if (audioSourceKeys !== undefined && !audioSourceKeys.has(key)) continue;
    candidates.set(`source:${key}`, {
      path: executed.sources[key]?.path ?? source.path,
      optional: false,
      authoringMediaPath: source.path,
    });
    if (subtitleSourceKeys?.has(key) === true) {
      candidates.set(`transcript:${key}`, {
        path: transcriptCachePath(projectDir, source.path),
        optional: true,
      });
    }
  }
  if (kind !== 'audio-preview') {
    const background = doc.canvas?.background;
    if (background?.kind === 'image') {
      const executedBackground = executed.canvas?.background;
      candidates.set(`background:${background.file}`, {
        path: executedBackground?.kind === 'image' ? executedBackground.file : background.file,
        optional: false,
        authoringMediaPath: background.file,
      });
    }
    // the program never composes overlays, so their files cannot stale it
    const overlayTracks = kind === 'program' ? [] : [...doc.tracks.entries()];
    for (const [trackIndex, track] of overlayTracks) {
      if (track.kind !== 'overlay') continue;
      const executedTrack = executed.tracks[trackIndex];
      for (const [blockIndex, block] of track.blocks.entries()) {
        const executedBlock =
          executedTrack?.kind === 'overlay' ? executedTrack.blocks[blockIndex] : undefined;
        candidates.set(`overlay:${block.file}`, {
          path: executedBlock?.file ?? block.file,
          optional: false,
          authoringMediaPath: block.file,
        });
      }
    }
  }

  const inputs: Record<string, string> = {};
  for (const [key, candidate] of [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (candidate.authoringMediaPath !== undefined && capturedMediaHashes !== undefined) {
      const captured = capturedMediaHashes.get(candidate.authoringMediaPath);
      if (captured === undefined) {
        return err(
          'io-failed',
          `reserved media fingerprint is missing for "${candidate.authoringMediaPath}"`,
        );
      }
      inputs[key] = captured;
      continue;
    }
    let absolute: string;
    if (isAbsolute(candidate.path)) {
      absolute = candidate.path;
    } else {
      const resolved = await resolveProjectFile(projectDir, candidate.path);
      if (!resolved.ok) return resolved;
      absolute = resolved.value;
    }
    if (candidate.optional) {
      const present = await access(absolute).then(
        () => true,
        () => false,
      );
      if (!present) {
        inputs[key] = 'missing';
        continue;
      }
    }
    const fingerprint = await mediaHash(absolute);
    if (!fingerprint.ok) return fingerprint;
    inputs[key] = fingerprint.value;
  }
  return ok(inputs);
}

export async function writeRenderReceipt(
  projectDir: string,
  kind: ReceiptKind,
  doc: EditDoc,
  inputs: Readonly<Record<string, string>>,
): Promise<void> {
  const cacheDir = join(projectDir, 'edit', 'cache');
  await mkdir(cacheDir, { recursive: true });
  const snapshotPath = join(cacheDir, `${kind}.edit.json`);
  const inputsPath = join(cacheDir, `${kind}.inputs.json`);
  const suffix = `.tmp-${String(process.pid)}`;
  const receipt: RenderInputsReceipt = {
    version: 1,
    rendererContract: RENDERER_CONTRACT_FINGERPRINT,
    kind,
    editHash: editDocHash(doc),
    inputs,
  };
  await writeFile(`${snapshotPath}${suffix}`, `${JSON.stringify(doc, null, 2)}\n`);
  await writeFile(`${inputsPath}${suffix}`, `${JSON.stringify(receipt, null, 2)}\n`);
  await rename(`${snapshotPath}${suffix}`, snapshotPath);
  await rename(`${inputsPath}${suffix}`, inputsPath);
}

export interface RenderSnapshotInfo {
  /** Full authoring document retained for provenance and semantic comparisons. */
  readonly doc: EditDoc;
  /** Full editDocHash of `doc`; this remains provenance, not semantic freshness. */
  readonly editHash: string;
}

/**
 * Validated immutable authoring snapshot that produced a render artifact.
 * Returns null when either receipt integrity or any relevant media fingerprint
 * no longer matches.
 */
export async function renderSnapshotInfo(
  projectDir: string,
  kind: ReceiptKind,
): Promise<RenderSnapshotInfo | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(projectDir, 'edit', 'cache', `${kind}.edit.json`), 'utf8'),
    ) as unknown;
    const parsed = parseEditDoc(raw);
    if (!parsed.ok) return null;
    const receipt = JSON.parse(
      await readFile(join(projectDir, 'edit', 'cache', `${kind}.inputs.json`), 'utf8'),
    ) as {
      version?: unknown;
      rendererContract?: unknown;
      kind?: unknown;
      editHash?: unknown;
      inputs?: unknown;
    };
    const snapshotHash = editDocHash(parsed.value);
    if (
      receipt.version !== 1 ||
      receipt.rendererContract !== RENDERER_CONTRACT_FINGERPRINT ||
      receipt.kind !== kind ||
      receipt.editHash !== snapshotHash ||
      typeof receipt.inputs !== 'object' ||
      receipt.inputs === null ||
      Array.isArray(receipt.inputs)
    ) {
      return null;
    }
    const current = await renderInputFingerprints(projectDir, parsed.value, kind);
    if (!current.ok) return null;
    const inputsMatch = (() => {
      if (kind !== 'audio-preview') {
        return JSON.stringify(current.value) === JSON.stringify(receipt.inputs);
      }
      const receiptInputs = receipt.inputs as Readonly<Record<string, unknown>>;
      const legacyKnownKeys = new Set(
        Object.keys(visibleDoc(parsed.value).sources).map((key) => `source:${key}`),
      );
      // Version-1 receipts may contain now-irrelevant fingerprints from muted
      // visual layers. Accept those known legacy keys, but reject arbitrary or
      // malformed extras and still require every audible fingerprint to match.
      return (
        Object.entries(receiptInputs).every(
          ([key, fingerprint]) => legacyKnownKeys.has(key) && typeof fingerprint === 'string',
        ) &&
        Object.entries(current.value).every(
          ([key, fingerprint]) => receiptInputs[key] === fingerprint,
        )
      );
    })();
    if (!inputsMatch) return null;
    return { doc: parsed.value, editHash: snapshotHash };
  } catch {
    return null;
  }
}

/** Hash of the immutable authoring snapshot that produced a render artifact. */
export async function renderSnapshotHash(
  projectDir: string,
  kind: ReceiptKind,
): Promise<string | null> {
  return (await renderSnapshotInfo(projectDir, kind))?.editHash ?? null;
}
