import { type JSX } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { t } from '../../i18n/index.js';
import { type EditDoc, type SubtitleFill, type SubtitleTheme } from '../../../core/schema.js';
import { type ResolvedSubtitleTheme } from '../../../core/srt.js';
import { store } from '../../state/store.js';

const SUBTITLE_FONTS = [
  'Helvetica',
  'Arial',
  'Arial Black',
  'Avenir Next',
  'Futura',
  'Georgia',
  'Impact',
  'Courier New',
] as const;

const SUBTITLE_WEIGHTS = [400, 500, 600, 700, 800, 900] as const;

function fillColorOf(fill: SubtitleFill): string {
  return fill.kind === 'solid' ? fill.color : fill.from;
}

/**
 * The quick human tweaks over the active look — color, font, weight. Anything
 * beyond this (gradients, outlines, backgrounds) is the agent's territory
 * through `subtitles.theme`; these controls only ever write solid colors.
 */
export function SubtitleThemeControls(props: {
  doc: EditDoc;
  theme: ResolvedSubtitleTheme;
}): JSX.Element {
  const { theme } = props;
  const patchTheme = (patch: SubtitleTheme): void => {
    store.updateSubtitleSettings(
      { theme: { ...props.doc.subtitles.theme, ...patch } },
      'subtitle-theme',
    );
  };
  // 2p-caps and 3p-natural render every word in `fill` — a highlight picker
  // there would edit a color the export never shows.
  const highlightUsed = props.doc.subtitles.preset === 'pill';
  return (
    <div className="subtitle-custom">
      <label className="subtitle-custom-color">
        <input
          type="color"
          value={fillColorOf(theme.fill).toLowerCase()}
          aria-label={t('inspector.subtitle.textColor')}
          onChange={(event) => {
            patchTheme({ fill: { kind: 'solid', color: event.target.value.toUpperCase() } });
          }}
        />
        <span>{t('inspector.subtitle.textColor')}</span>
      </label>
      <label
        className={cn('subtitle-custom-color', !highlightUsed && 'is-inert')}
        title={highlightUsed ? undefined : t('inspector.subtitle.highlightInert')}
      >
        <input
          type="color"
          disabled={!highlightUsed}
          value={fillColorOf(theme.highlightFill).toLowerCase()}
          aria-label={t('inspector.subtitle.highlightColor')}
          onChange={(event) => {
            patchTheme({
              highlightFill: { kind: 'solid', color: event.target.value.toUpperCase() },
            });
          }}
        />
        <span>{t('inspector.subtitle.highlightColor')}</span>
      </label>
      <Select
        value={theme.fontFamily}
        onValueChange={(value) => {
          patchTheme({ fontFamily: value });
        }}
      >
        <SelectTrigger
          aria-label={t('inspector.subtitle.font')}
          className="subtitle-custom-font w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {!(SUBTITLE_FONTS as readonly string[]).includes(theme.fontFamily) && (
            <SelectItem value={theme.fontFamily}>{theme.fontFamily}</SelectItem>
          )}
          {SUBTITLE_FONTS.map((font) => (
            <SelectItem key={font} value={font}>
              <span style={{ fontFamily: font }}>{font}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={String(theme.fontWeight)}
        onValueChange={(value) => {
          patchTheme({ fontWeight: Number(value) });
        }}
      >
        <SelectTrigger
          aria-label={t('inspector.subtitle.weight')}
          className="subtitle-custom-weight"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {!(SUBTITLE_WEIGHTS as readonly number[]).includes(theme.fontWeight) && (
            <SelectItem value={String(theme.fontWeight)}>{String(theme.fontWeight)}</SelectItem>
          )}
          {SUBTITLE_WEIGHTS.map((weight) => (
            <SelectItem key={weight} value={String(weight)}>
              {String(weight)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
