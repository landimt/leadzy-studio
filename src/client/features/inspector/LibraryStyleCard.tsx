import { type CSSProperties, type JSX } from 'react';
import { type SubtitleFill } from '../../../core/schema.js';
import { type ResolvedSubtitleTheme } from '../../../core/srt.js';
import { type SubtitleLibraryStyle } from '../../../core/subtitleLibrary.js';
import { store } from '../../state/store.js';

function fillStyle(fill: SubtitleFill): CSSProperties {
  if (fill.kind === 'solid') return { color: fill.color };
  return {
    backgroundImage: `linear-gradient(90deg, ${fill.from}, ${fill.to})`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  };
}

/**
 * Card preview goes through the SAME resolver the renderer uses
 * (subtitleThemeFor) so the swatch can never promise a look the export
 * won't deliver — see the highlightFill caveat in subtitleLibrary.ts.
 */
export function LibraryStyleCard(props: {
  style: SubtitleLibraryStyle;
  theme: ResolvedSubtitleTheme;
  active: boolean;
}): JSX.Element {
  const theme = props.theme;
  const previewFontSizePx = 13;
  const sourceFontSize = props.style.fontSize ?? 18;
  // CSS strokes are centered while ASS outlines grow outward. Preserve the
  // outline/font ratio, double it for CSS, and cap only at the card boundary.
  const previewOutlinePx = Math.min(
    6,
    (theme.outlineWidth / sourceFontSize) * previewFontSizePx * 2,
  );
  const textStyle: CSSProperties = {
    fontFamily: theme.fontFamily,
    fontWeight: theme.fontWeight,
    ...fillStyle(theme.fill),
    ...(theme.backgroundStyle === 'outline'
      ? {
          WebkitTextStroke: `${String(Math.round(previewOutlinePx * 10) / 10)}px ${theme.outlineColor}`,
          // stroke centers on the glyph edge and eats thin fills unless the
          // fill is painted on top — without this, light text over dark
          // preview reads as broken
          paintOrder: 'stroke fill',
        }
      : {}),
  };
  // Only 'pill' actually colors the spoken word differently (srt.ts) — the
  // preview must stay single-tone for the other presets, or it lies.
  const secondWordStyle =
    props.style.preset === 'pill' ? { ...textStyle, ...fillStyle(theme.highlightFill) } : textStyle;
  const pillStyle: CSSProperties | undefined =
    theme.backgroundStyle === 'pill'
      ? {
          background: `color-mix(in srgb, ${theme.backgroundColor} ${String(theme.backgroundOpacity * 100)}%, transparent)`,
          borderRadius: 999,
          padding: '3px 9px',
        }
      : undefined;
  return (
    <button
      type="button"
      className={`subtitle-library-card ${props.active ? 'active' : ''}`}
      onClick={() => {
        store.updateSubtitleSettings({
          preset: props.style.preset,
          theme: props.style.theme,
          fontSize: props.style.fontSize,
          marginV: props.style.marginV,
          minWordsPerCue: props.style.minWordsPerCue,
          maxWordsPerCue: props.style.maxWordsPerCue,
          forceStyle: undefined,
        });
      }}
    >
      <span className="subtitle-library-preview">
        <span style={pillStyle}>
          <span style={textStyle}>Aa </span>
          <span style={secondWordStyle}>Bb</span>
        </span>
      </span>
      <span className="subtitle-library-label">{props.style.label}</span>
    </button>
  );
}
