import { VideoEffectsInspector } from './VideoEffectsInspector.js';
import { type JSX } from 'react';
import { PIP_DEFAULT_SCALE } from '../../../core/overlayPlacement.js';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  agentJsonPrompt,
  LAYER_AGENT_PROMPT,
  OVERLAY_AGENT_PROMPT,
} from '../agent/agentPrompts.js';
import { t } from '../../i18n/index.js';
import { isLayerBlock } from '../../../core/schema.js';
import { outputDuration } from '../../../core/timeline.js';
import { store } from '../../state/store.js';
import { DEFAULT_LAYER_CELL } from '../../state/docEdits.js';
import { useStore } from '../../state/hooks.js';
import { AgentPromptButton } from '../agent/AgentPrompt.js';
import { SubtitleInspector } from './SubtitleInspector.js';
import { BackgroundInspector } from './BackgroundInspector.js';
import { TitleInspector } from './TitleInspector.js';
import { LibraryOverlayInspector } from './LibraryOverlayInspector.js';
import { OverlayDurationControl, SaveToLibraryControl } from './OverlayControls.js';
import { basename } from './basename.js';
import { EffectInspector } from './EffectInspector.js';

const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

/** Controls for the selected block: mode, audio policy, position, nudge. */
export function Inspector(): JSX.Element | null {
  const state = useStore();
  const { selection, doc } = state;
  if (!doc) return null;

  if (state.subtitleInspectorOpen)
    return (
      <SubtitleInspector
        doc={doc}
        selectedCue={state.selectedCue}
        transcripts={state.transcripts}
      />
    );

  if (state.backgroundInspectorOpen && doc.canvas) {
    return <BackgroundInspector doc={doc} canvas={doc.canvas} />;
  }

  const overlayTrack = selection
    ? doc.tracks.find((track) => track.id === selection.trackId && track.kind === 'overlay')
    : undefined;
  if (overlayTrack?.kind === 'overlay' && selection) {
    const overlayBlock = overlayTrack.blocks[selection.blockIndex];
    if (overlayBlock?.title) {
      return (
        <TitleInspector
          key={`${overlayTrack.id}:${String(selection.blockIndex)}:${overlayBlock.file}`}
          trackId={overlayTrack.id}
          blockIndex={selection.blockIndex}
          block={overlayBlock}
          // Only the title job itself conflicts — gating on every job kept the
          // button dead through each ~5s auto-preview render after any edit.
          busy={state.activeJobs.has('title')}
          isTitleJob={state.activeJobs.has('title')}
        />
      );
    }
    const libraryRef = overlayBlock?.library;
    const libraryVariables = libraryRef?.variables;
    if (overlayBlock && libraryRef && libraryVariables) {
      // The values are part of the key: drafts seed once per mount, and an
      // agent can rewrite the block's variables without changing its file.
      return (
        <LibraryOverlayInspector
          key={`${overlayTrack.id}:${String(selection.blockIndex)}:${overlayBlock.file}:${JSON.stringify(libraryVariables)}`}
          trackId={overlayTrack.id}
          blockIndex={selection.blockIndex}
          block={overlayBlock}
          itemId={libraryRef.item}
          variables={libraryVariables}
          libraryRevision={state.libraryRevision}
          // Only a running bake conflicts — gating on every job kept "Aplicar"
          // dead through each ~5s auto-preview render after any edit.
          busy={state.activeJobs.has('library-overlay')}
          isBaking={state.activeJobs.has('library-overlay')}
        />
      );
    }
    if (overlayBlock) {
      return (
        <div className="inspector overlay-inspector">
          <div className="inspector-heading">
            <span>{t('inspector.overlay.asset')}</span>
            <span className="inspector-time">
              {overlayBlock.at.toFixed(2)}s · {(overlayBlock.duration ?? 2).toFixed(1)}s
            </span>
            <AgentPromptButton
              title={t('inspector.overlay.agentDialogTitle')}
              description={t('inspector.overlay.agentDialogDescription')}
              buildPrompt={() => agentJsonPrompt(OVERLAY_AGENT_PROMPT, overlayBlock)}
            />
          </div>
          <div className="inspector-asset">{overlayBlock.file.split('/').at(-1)}</div>
          <OverlayDurationControl
            trackId={overlayTrack.id}
            blockIndex={selection.blockIndex}
            block={overlayBlock}
          />
          <SaveToLibraryControl
            key={`${overlayTrack.id}:${String(selection.blockIndex)}:${overlayBlock.file}`}
            file={overlayBlock.file}
            prefillName={basename(overlayBlock.file)}
            defaultKind="other"
            durationS={overlayBlock.duration}
          />
          <div className="inspector-hint">{t('inspector.overlay.managed')}</div>
        </div>
      );
    }
  }

  const effectTrack = selection
    ? doc.tracks.find((track) => track.id === selection.trackId && track.kind === 'effect')
    : undefined;
  if (effectTrack?.kind === 'effect' && selection) {
    const effectBlock = effectTrack.blocks[selection.blockIndex];
    if (effectBlock) {
      return (
        <EffectInspector
          trackId={effectTrack.id}
          blockIndex={selection.blockIndex}
          block={effectBlock}
          maxDuration={Math.max(0.2, outputDuration(doc) - effectBlock.at)}
        />
      );
    }
  }

  const track = selection
    ? doc.tracks.find((candidate) => candidate.id === selection.trackId)
    : undefined;
  const block =
    track?.kind === 'video' && selection ? track.blocks[selection.blockIndex] : undefined;

  const layer = block && isLayerBlock(block) ? block : null;

  return (
    <div className="inspector">
      {!block && (
        <div className="row" style={{ color: 'var(--ink-soft)', fontSize: 11 }}>
          {t('inspector.emptySelection')}
        </div>
      )}
      {block && (
        <>
          <div className="row" style={{ fontFamily: 'var(--font-data)', fontSize: 11 }}>
            <span style={{ minWidth: 0 }}>
              {block.source} · {block.in.toFixed(2)}–{block.out.toFixed(2)}s
              {layer ? ` @ ${layer.at.toFixed(2)}s` : ''}
            </span>
            {layer && (
              <AgentPromptButton
                title={t('inspector.layer.agentDialogTitle')}
                description={t('inspector.layer.agentDialogDescription')}
                buildPrompt={() => agentJsonPrompt(LAYER_AGENT_PROMPT, layer)}
              />
            )}
          </div>
          {track?.kind === 'video' && selection && (
            <VideoEffectsInspector
              key={`${track.id}:${String(selection.blockIndex)}`}
              track={track}
              blockIndex={selection.blockIndex}
              base={doc.tracks[0]?.id === track.id}
              locked={state.lockedTrackKeys.has(track.id)}
            />
          )}
          {layer && (
            <>
              <div className="row">
                <label>{t('inspector.mode')}</label>
                <span className="seg">
                  {(['fullscreen', 'split', 'pip', 'cell'] as const).map((mode) => (
                    <button
                      key={mode}
                      className={layer.mode === mode ? 'active' : ''}
                      onClick={() => {
                        store.updateSelectedLayerBlock(
                          mode === 'split'
                            ? { mode, split: layer.split ?? { ratio: 0.5, arrangement: 'top' } }
                            : mode === 'cell'
                              ? { mode, cell: layer.cell ?? DEFAULT_LAYER_CELL }
                              : { mode },
                        );
                      }}
                    >
                      {t(`inspector.mode.${mode}`)}
                    </button>
                  ))}
                </span>
              </div>
              <div className="row">
                <label>{t('inspector.audio')}</label>
                <span className="seg">
                  {(['mute', 'duck', 'solo'] as const).map((audio) => (
                    <button
                      key={audio}
                      className={layer.audio === audio ? 'active' : ''}
                      onClick={() => {
                        store.updateSelectedLayerBlock({ audio });
                      }}
                    >
                      {t(`inspector.audio.${audio}`)}
                    </button>
                  ))}
                </span>
              </div>
              {layer.mode === 'pip' && (
                <>
                  <div className="row">
                    <span className="seg">
                      <button
                        className={layer.swapped === true ? 'active' : ''}
                        aria-pressed={layer.swapped === true}
                        title={t('inspector.pip.swap.title')}
                        onClick={() => {
                          store.updateSelectedLayerBlock({
                            swapped: layer.swapped === true ? undefined : true,
                          });
                        }}
                      >
                        ⇄ {t('inspector.pip.swap')}
                      </button>
                    </span>
                    {layer.swapped === true && (
                      <div className="inspector-hint">{t('inspector.pip.swap.hint')}</div>
                    )}
                    <span className="seg">
                      {POSITIONS.map((position) => (
                        <button
                          key={position}
                          className={layer.position === position ? 'active' : ''}
                          onClick={() => {
                            store.updateSelectedLayerBlock({ position });
                          }}
                        >
                          {position
                            .replace('top-', '↑')
                            .replace('bottom-', '↓')
                            .replace('left', '←')
                            .replace('right', '→')}
                        </button>
                      ))}
                    </span>
                  </div>
                  <div className="row">
                    <label>{t('inspector.scale')}</label>
                    <Slider
                      min={0.15}
                      max={0.9}
                      step={0.01}
                      value={[layer.scale ?? PIP_DEFAULT_SCALE]}
                      aria-label={t('inspector.scale')}
                      className="flex-1"
                      onValueChange={([next]) => {
                        if (next === undefined) return;
                        store.updateSelectedLayerBlock({ scale: next }, 'layer:scale');
                      }}
                    />
                  </div>
                </>
              )}
              {layer.mode === 'split' && (
                <div className="row">
                  <label>{t('inspector.split.ratio')}</label>
                  <Slider
                    min={0.2}
                    max={0.8}
                    step={0.05}
                    value={[layer.split?.ratio ?? 0.5]}
                    aria-label={t('inspector.split.ratio')}
                    className="flex-1"
                    onValueChange={([next]) => {
                      if (next === undefined) return;
                      store.updateSelectedLayerBlock(
                        {
                          split: {
                            ratio: next,
                            arrangement: layer.split?.arrangement ?? 'top',
                          },
                        },
                        'layer:split-ratio',
                      );
                    }}
                  />
                  <span className="seg">
                    {(['top', 'bottom', 'left', 'right'] as const).map((arrangement) => (
                      <button
                        key={arrangement}
                        className={
                          (layer.split?.arrangement ?? 'top') === arrangement ? 'active' : ''
                        }
                        onClick={() => {
                          store.updateSelectedLayerBlock({
                            split: { ratio: layer.split?.ratio ?? 0.5, arrangement },
                          });
                        }}
                      >
                        {t(`inspector.split.${arrangement}`)}
                      </button>
                    ))}
                  </span>
                </div>
              )}
              {layer.mode === 'cell' && selection && (
                <div className="row">
                  <div className="layer-cell-inputs">
                    {(['x', 'y', 'w', 'h'] as const).map((field) => {
                      const cell = layer.cell ?? DEFAULT_LAYER_CELL;
                      return (
                        <label key={field}>
                          <span>{t(`inspector.cell.${field}`)}</span>
                          <Input
                            type="number"
                            min={field === 'w' || field === 'h' ? 0.05 : 0}
                            max={1}
                            step={0.01}
                            value={cell[field]}
                            aria-label={t(`inspector.cell.${field}`)}
                            onChange={(event) => {
                              store.updateLayerCell(
                                selection.trackId,
                                selection.blockIndex,
                                { ...cell, [field]: Number(event.target.value) },
                                `cell:${selection.trackId}:${String(selection.blockIndex)}`,
                              );
                            }}
                          />
                        </label>
                      );
                    })}
                  </div>
                  <div className="inspector-hint">{t('inspector.cell.hint')}</div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
