import { type JSX } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { agentJsonPrompt, EFFECT_AGENT_PROMPT } from '../agent/agentPrompts.js';
import { EFFECT_TITLE_KEY, t } from '../../i18n/index.js';
import {
  SHAKE_DEFAULT_INTENSITY,
  SHAKE_INTENSITY_BOUNDS,
  ZOOM_SCALE_BOUNDS,
  type EffectBlock,
} from '../../../core/schema.js';
import { store } from '../../state/store.js';
import { effectDurationBounds } from '../../state/docEdits.js';
import { AgentPromptButton } from '../agent/AgentPrompt.js';
import { EFFECT_ICON } from './effectIcons.js';
import { UI_ICON, UiIcon } from '../../components/UiIcon.js';

/** The store's shared bounds plus slider granularity — zoom keeps its historical 0.1s step. */
function effectSliderBounds(type: EffectBlock['type']): { min: number; max: number; step: number } {
  return { ...effectDurationBounds(type), step: type === 'zoom' ? 0.1 : 0.01 };
}

export function EffectInspector(props: {
  trackId: string;
  blockIndex: number;
  block: EffectBlock;
  maxDuration: number;
}): JSX.Element {
  const bounds = effectSliderBounds(props.block.type);
  const durationMax = Math.max(
    bounds.min,
    Math.min(bounds.max, 30, props.maxDuration),
    props.block.duration,
  );
  return (
    <div className="inspector effect-inspector">
      <div className="inspector-heading">
        <span className="with-icon">
          <UiIcon d={EFFECT_ICON[props.block.type]} />
          {t(EFFECT_TITLE_KEY[props.block.type])}
        </span>
        <span className="inspector-time">
          {props.block.at.toFixed(2)}s · {props.block.duration.toFixed(1)}s
        </span>
        <AgentPromptButton
          title={t('inspector.effect.agentDialogTitle')}
          description={t('inspector.effect.agentDialogDescription')}
          buildPrompt={() => agentJsonPrompt(EFFECT_AGENT_PROMPT, props.block)}
        />
      </div>
      {props.block.type === 'zoom' && (
        <div className="effect-control">
          <div className="effect-control-label">
            <label>{t('inspector.effect.intensity')}</label>
            <output>{String(Math.round(props.block.scale * 100))}%</output>
          </div>
          <Slider
            min={ZOOM_SCALE_BOUNDS.min}
            max={ZOOM_SCALE_BOUNDS.max}
            step={0.01}
            value={[props.block.scale]}
            aria-label={t('inspector.effect.intensity')}
            onValueChange={([next]) => {
              if (next === undefined) return;
              store.updateEffectBlock(
                props.trackId,
                props.blockIndex,
                { scale: next },
                `effect-scale:${props.trackId}:${String(props.blockIndex)}`,
              );
            }}
          />
        </div>
      )}
      {props.block.type === 'shake' && (
        <div className="effect-control">
          <div className="effect-control-label">
            <label>{t('inspector.effect.intensity')}</label>
            <output>{String(props.block.intensity ?? SHAKE_DEFAULT_INTENSITY)}</output>
          </div>
          <Slider
            min={SHAKE_INTENSITY_BOUNDS.min}
            max={SHAKE_INTENSITY_BOUNDS.max}
            step={1}
            value={[props.block.intensity ?? SHAKE_DEFAULT_INTENSITY]}
            aria-label={t('inspector.effect.intensity')}
            onValueChange={([next]) => {
              if (next === undefined) return;
              store.updateEffectBlock(
                props.trackId,
                props.blockIndex,
                { intensity: next },
                `effect-intensity:${props.trackId}:${String(props.blockIndex)}`,
              );
            }}
          />
        </div>
      )}
      <div className="effect-control">
        <div className="effect-control-label">
          <label>{t('inspector.effect.duration')}</label>
          <output>{props.block.duration.toFixed(bounds.step < 0.1 ? 2 : 1)}s</output>
        </div>
        <Slider
          min={bounds.min}
          max={durationMax}
          step={bounds.step}
          value={[props.block.duration]}
          aria-label={t('inspector.effect.duration')}
          onValueChange={([next]) => {
            if (next === undefined) return;
            store.updateEffectBlock(
              props.trackId,
              props.blockIndex,
              { duration: next },
              `effect-duration:${props.trackId}:${String(props.blockIndex)}`,
            );
          }}
        />
      </div>
      <div className="inspector-footer">
        <span className="inspector-hint">{t('inspector.effect.dragHint')}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          title={t('inspector.delete')}
          aria-label={t('inspector.delete')}
          onClick={() => {
            store.deleteSelectedBlock();
          }}
        >
          <UiIcon d={UI_ICON.trash} />
        </Button>
      </div>
    </div>
  );
}
