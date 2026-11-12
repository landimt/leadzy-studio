import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { COLOR_PRESETS, isColorPresetId } from '../../../core/colorPresets.js';
import { type JSX } from 'react';
import { useStore } from '../../state/hooks.js';
import type { VideoTrack, VideoColor } from '../../../core/schema.js';
import { store } from '../../state/store.js';
import { AgentPromptButton } from '../agent/AgentPrompt.js';
import { agentJsonPrompt } from '../agent/agentPrompts.js';
import './videoEffects.css';

const controls = [
  ['brightness', 'Brilho', -0.3, 0.3, 0.01, 0],
  ['contrast', 'Contraste', 0.5, 1.5, 0.01, 1],
  ['saturation', 'Saturação', 0, 2, 0.01, 1],
  ['gamma', 'Gama', 0.5, 2, 0.01, 1],
  ['hue', 'Matiz', -180, 180, 1, 0],
  ['warmth', 'Temperatura', -1, 1, 0.01, 0],
] as const;

export function VideoEffectsInspector({
  track,
  blockIndex,
  base,
  locked,
}: {
  track: VideoTrack;
  blockIndex: number;
  base: boolean;
  locked: boolean;
}): JSX.Element {
  const target = useStore().colorInspectorTarget;
  const scope = target?.trackId === track.id && target.blockIndex === blockIndex ? 'clip' : 'layer';
  const setScope = (next: 'layer' | 'clip'): void => {
    store.openColorInspector({ trackId: track.id, ...(next === 'clip' ? { blockIndex } : {}) });
  };
  const block = track.blocks[blockIndex];
  const color = scope === 'layer' ? track.color : (block?.color ?? track.color);
  const presetId =
    COLOR_PRESETS.find((preset) =>
      controls.every(
        ([key, , , , , fallback]) =>
          (color?.[key] ?? fallback) === ((preset.color as VideoColor)[key] ?? fallback),
      ),
    )?.id ?? 'custom';
  const update = (next: VideoColor | undefined): void => {
    store.setVideoColor(track.id, next, scope === 'clip' ? blockIndex : undefined);
  };
  const speed =
    scope === 'clip'
      ? (block?.speed ?? 1)
      : track.blocks.every((b) => (b.speed ?? 1) === (block?.speed ?? 1))
        ? (block?.speed ?? 1)
        : undefined;
  return (
    <section className="video-effects-inspector" aria-label="Efeitos do vídeo">
      <header>
        <div>
          <strong>Efeitos do vídeo</strong>
          <small>{track.label ?? track.id}</small>
        </div>
        <AgentPromptButton
          title="Editar efeitos com o agente"
          description="Ajustes desta camada no documento do projeto."
          buildPrompt={() =>
            agentJsonPrompt(
              {
                intro:
                  'Ajuste a cor desta camada ou clipe via studio edit apply com --expect-hash. color no clipe substitui color da camada. Converta HDR antes da composição. speed nos blocos da base altera a duração; confira posições de demonstrações e overlays. Preserve os outros elementos.',
                outro: 'Use o schema validado e confira a prévia renderizada.',
              },
              { trackId: track.id, scope, blockIndex, color, speed },
            )
          }
        />
      </header>
      <fieldset disabled={locked}>
        <Tabs
          value={scope}
          onValueChange={(value) => {
            if (value === 'layer' || value === 'clip') setScope(value);
          }}
        >
          <TabsList className="effects-scope" aria-label="Aplicar em">
            <TabsTrigger value="layer" disabled={locked}>
              Camada inteira
            </TabsTrigger>
            <TabsTrigger value="clip" disabled={locked}>
              Este clipe
            </TabsTrigger>
          </TabsList>
          <TabsContent value={scope}>
            <p>
              {scope === 'layer'
                ? 'Todos os clipes desta camada. Artes e outras camadas preservadas.'
                : 'Substitui os ajustes de cor da camada neste clipe.'}
            </p>
            <div className="effects-heading">
              <strong>Cor</strong>
              <label>
                <Checkbox
                  disabled={locked}
                  checked={color?.enabled !== false}
                  onCheckedChange={(checked) => {
                    update({ ...color, enabled: checked === true });
                  }}
                />{' '}
                Ativa
              </label>
            </div>
            <label className="effects-field">
              Preset
              <Select
                disabled={locked}
                value={presetId}
                onValueChange={(preset) => {
                  if (isColorPresetId(preset))
                    store.applyVideoColorPreset(
                      { trackId: track.id, ...(scope === 'clip' ? { blockIndex } : {}) },
                      preset,
                    );
                }}
              >
                <SelectTrigger className="w-full" aria-label="Preset de cor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="custom" disabled>
                    Personalizado
                  </SelectItem>
                  {COLOR_PRESETS.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="effects-field">
              Cor da gravação
              <Select
                disabled={locked}
                value={color?.input ?? 'sdr'}
                onValueChange={(input) => {
                  if (input === 'sdr' || input === 'hlg' || input === 'pq')
                    update({ ...color, input });
                }}
              >
                <SelectTrigger className="w-full" aria-label="Cor da gravação">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="sdr">SDR · padrão</SelectItem>
                  <SelectItem value="hlg">HDR · HLG → SDR</SelectItem>
                  <SelectItem value="pq">HDR · PQ → SDR</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {controls.map(([key, label, min, max, step, fallback]) => (
              <label className="effects-field" key={key}>
                <span className="effects-field-label">
                  {label}
                  <output>{(color?.[key] ?? fallback).toFixed(key === 'hue' ? 0 : 2)}</output>
                </span>
                <Slider
                  disabled={locked}
                  aria-label={label}
                  onValueCommit={() => {
                    store.endGesture();
                  }}
                  onBlur={() => {
                    store.endGesture();
                  }}
                  min={min}
                  max={max}
                  step={step}
                  value={[color?.[key] ?? fallback]}
                  onValueChange={([value]) => {
                    if (value !== undefined) update({ ...color, [key]: value });
                  }}
                />
              </label>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked}
              className="effects-reset"
              onClick={() => {
                update(undefined);
              }}
            >
              {scope === 'clip' ? 'Voltar à cor da camada' : 'Remover tratamento de cor'}
            </Button>
            {base && (
              <>
                <div className="effects-heading">
                  <strong>Velocidade</strong>
                </div>
                <label className="effects-field">
                  Ritmo da fala
                  <Input
                    disabled={locked}
                    aria-label="Velocidade do vídeo"
                    type="number"
                    min="0.5"
                    max="2"
                    step="0.05"
                    placeholder="Variada"
                    value={speed ?? ''}
                    onChange={(e) => {
                      if (e.target.value) {
                        const value = Number(e.target.value);
                        if (!Number.isFinite(value) || value < 0.5 || value > 2) return;
                        if (scope === 'clip') store.setBlockSpeed(blockIndex, value);
                        else store.setBaseLayerSpeed(value);
                      }
                    }}
                  />
                </label>
                <p>
                  Altera a duração da base e acompanha as legendas. Revise os encaixes de telas e
                  artes após mudar o ritmo.
                </p>
              </>
            )}
            <p className="effects-proof">A prévia renderizada confirma cor e conversão HDR.</p>
          </TabsContent>
        </Tabs>
      </fieldset>
    </section>
  );
}
