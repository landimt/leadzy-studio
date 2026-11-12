import { COLOR_PRESETS, COLOR_PRESET_DRAG_MIME } from '../../../core/colorPresets.js';
import { AgentPromptButton } from '../agent/AgentPrompt.js';
import { type JSX } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EFFECT_DESCRIPTION_KEY, EFFECT_TITLE_KEY, t } from '../../i18n/index.js';
import { EFFECT_LIBRARY } from '../../../core/effectLibrary.js';
import { store } from '../../state/store.js';
import { EFFECT_DRAG_MIME } from '../../state/docEdits.js';
import { usePlayheadTime, useStore } from '../../state/hooks.js';
import { EFFECT_ICON } from '../inspector/effectIcons.js';
import { UiIcon } from '../../components/UiIcon.js';
import { formatSeconds } from './shared.js';

/**
 * The effect catalog as clickable cards: one card per EFFECT_LIBRARY entry,
 * inserted at the playhead and immediately selected so the inspector opens on
 * it. Rendering is fully data-driven — a new effect appears here by adding a
 * catalog entry, never a new branch.
 */
export function EffectsPanel(): JSX.Element {
  const state = useStore();
  const time = usePlayheadTime();
  const disabled = state.doc === null;
  const videoTracks = state.doc?.tracks.filter((track) => track.kind === 'video') ?? [];
  const target =
    videoTracks.find((track) => track.id === state.selection?.trackId) ?? videoTracks[0];
  const selectedBlock =
    state.selection?.trackId === target?.id ? state.selection?.blockIndex : undefined;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="effects-panel">
        <header className="effects-section-heading">
          <p className="effects-panel-hint">
            Arraste Cor para um vídeo e escolha o preset no inspetor. Os efeitos de movimento entram
            no cursor.
          </p>
          <AgentPromptButton
            title="Efeitos com o agente"
            description="Leve o destino e os ajustes atuais para a conversa."
            buildPrompt={() =>
              `Ajuste os efeitos no Leadzy Studio. Destino: ${JSON.stringify({ trackId: target?.id, blockIndex: selectedBlock, color: target?.color })}. Cor é um efeito único; presets são configurações desse efeito: ${COLOR_PRESETS.map((p) => p.id).join(', ')}. Use color no track ou bloco e preserve input HDR. Use studio status e studio edit apply --expect-hash.`
            }
          />
        </header>
        <div className="effects-grid">
          <button
            type="button"
            className="effect-card"
            disabled={disabled}
            draggable={!disabled}
            title="Arraste para um clipe ou faixa de vídeo; clique para configurar a seleção"
            onDragStart={(event) => {
              event.dataTransfer.setData(COLOR_PRESET_DRAG_MIME, 'color');
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => {
              if (target)
                store.addVideoColorEffect({
                  trackId: target.id,
                  ...(selectedBlock !== undefined ? { blockIndex: selectedBlock } : {}),
                });
            }}
          >
            <span className="effect-tile effect-tile--color" aria-hidden="true">
              <span className="effect-tile-frame" />
            </span>
            <span className="effect-card-title">
              <span className="effect-card-name">Cor</span>
            </span>
            <span className="effect-card-desc">
              Presets e ajustes de brilho, contraste e coloração no inspetor.
            </span>
          </button>
          {EFFECT_LIBRARY.map((entry) => (
            <button
              key={entry.type}
              type="button"
              className="effect-card"
              disabled={disabled}
              draggable={!disabled}
              onDragStart={(event) => {
                event.dataTransfer.setData(EFFECT_DRAG_MIME, entry.type);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => {
                store.addEffect(entry.create(time));
              }}
            >
              {/* the tile DEMONSTRATES the effect on hover — a mini video frame
                  that zooms/flashes/shakes via the per-type CSS modifier */}
              <span className={`effect-tile effect-tile--${entry.type}`} aria-hidden="true">
                <span className="effect-tile-frame" />
                <span className="effect-tile-glyph">
                  <UiIcon d={EFFECT_ICON[entry.type]} size={13} />
                </span>
              </span>
              <span className="effect-card-title">
                <span className="effect-card-name">{t(EFFECT_TITLE_KEY[entry.type])}</span>
                <span className="effect-card-dur">{formatSeconds(entry.create(0).duration)}</span>
              </span>
              <span className="effect-card-desc">{t(EFFECT_DESCRIPTION_KEY[entry.type])}</span>
            </button>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}
