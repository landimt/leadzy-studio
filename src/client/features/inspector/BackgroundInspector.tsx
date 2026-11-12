import { type JSX } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '../../i18n/index.js';
import { type CanvasConfig, type EditDoc, type LayerCell } from '../../../core/schema.js';
import { store } from '../../state/store.js';
import { DEFAULT_CANVAS_BACKGROUND_COLOR, DEFAULT_CANVAS_BASE_CELL } from '../../state/docEdits.js';
import { UI_ICON, UiIcon } from '../../components/UiIcon.js';
import { basename } from './basename.js';

const CANVAS_CELL_PRESETS: readonly {
  readonly key: 'center' | 'top' | 'bottom';
  readonly cell: LayerCell;
}[] = [
  { key: 'center', cell: DEFAULT_CANVAS_BASE_CELL },
  { key: 'top', cell: { x: 0.06, y: 0.06, w: 0.88, h: 0.46 } },
  { key: 'bottom', cell: { x: 0.06, y: 0.48, w: 0.88, h: 0.46 } },
];

function sameCell(a: LayerCell, b: LayerCell): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function canvasBackgroundAsset(doc: EditDoc): string | null {
  const background = doc.canvas?.background;
  if (background?.kind === 'image') return background.file;
  if (background?.kind === 'video')
    return doc.sources[background.source]?.path ?? background.source;
  return null;
}

/** Global canvas composition: one quiet panel for the backdrop and presenter window. */
export function BackgroundInspector(props: { doc: EditDoc; canvas: CanvasConfig }): JSX.Element {
  const { background, base } = props.canvas;
  const asset = canvasBackgroundAsset(props.doc);
  const setBaseMode = (mode: CanvasConfig['base']['mode']): void => {
    store.setCanvasBaseMode(mode);
  };

  return (
    <div className="inspector background-inspector">
      <div className="inspector-heading">
        <span className="with-icon">
          <UiIcon d={UI_ICON.image} />
          {t('inspector.background.title')}
        </span>
        <span className="background-kind-label">
          {t(`inspector.background.kind.${background.kind}`)}
        </span>
      </div>

      <div className="background-control-row">
        <label>{t('inspector.background.kind')}</label>
        {background.kind === 'color' ? (
          <label className="background-color-control">
            <input
              type="color"
              value={background.color}
              aria-label={t('inspector.background.color')}
              onChange={(event) => {
                store.setBackgroundColor(event.target.value);
              }}
            />
            <span>{background.color.toUpperCase()}</span>
          </label>
        ) : (
          <span className="background-asset-summary">
            <span className="background-asset-name" title={asset ?? undefined}>
              {asset === null ? t('inspector.background.chooseAsset') : basename(asset)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                store.setBackgroundColor(background.color ?? DEFAULT_CANVAS_BACKGROUND_COLOR);
              }}
            >
              {t('inspector.background.kind.color')}
            </Button>
          </span>
        )}
      </div>

      {background.kind !== 'color' && (
        <div className="background-control-row">
          <label>{t('inspector.background.fit')}</label>
          <span
            className="seg background-segment"
            role="group"
            aria-label={t('inspector.background.fit')}
          >
            {(['cover', 'contain'] as const).map((fit) => (
              <button
                key={fit}
                type="button"
                className={background.fit === fit ? 'active' : ''}
                aria-pressed={background.fit === fit}
                onClick={() => {
                  store.setBackgroundFit(fit);
                }}
              >
                {t(`inspector.background.fit.${fit}`)}
              </button>
            ))}
          </span>
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          store.setEditorPanelMode('media');
        }}
      >
        <UiIcon d={UI_ICON.image} />
        {t('inspector.background.openMedia')}
      </Button>

      <div className="background-divider" />

      <div className="background-control-row">
        <label>{t('inspector.background.baseLayout')}</label>
        <span
          className="seg background-segment"
          role="group"
          aria-label={t('inspector.background.baseLayout')}
        >
          {(['fill', 'cell'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={base.mode === mode ? 'active' : ''}
              aria-pressed={base.mode === mode}
              onClick={() => {
                setBaseMode(mode);
              }}
            >
              {t(`inspector.background.baseLayout.${mode}`)}
            </button>
          ))}
        </span>
      </div>

      {base.mode === 'cell' && (
        <>
          <div
            className="background-presets"
            role="group"
            aria-label={t('inspector.background.baseLayout')}
          >
            {CANVAS_CELL_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                aria-pressed={sameCell(base.cell, preset.cell)}
                onClick={() => {
                  store.setCanvasBaseCell(preset.cell);
                }}
              >
                <span className={`background-preset-glyph is-${preset.key}`} aria-hidden="true" />
                <span>{t(`inspector.background.preset.${preset.key}`)}</span>
              </button>
            ))}
          </div>
          <div className="layer-cell-inputs background-cell-inputs">
            {(['x', 'y', 'w', 'h'] as const).map((field) => (
              <label key={field}>
                <span>{t(`inspector.cell.${field}`)}</span>
                <Input
                  type="number"
                  min={field === 'w' || field === 'h' ? 0.05 : 0}
                  max={1}
                  step={0.01}
                  value={base.cell[field]}
                  aria-label={t(`inspector.cell.${field}`)}
                  onChange={(event) => {
                    store.setCanvasBaseCell({
                      ...base.cell,
                      [field]: Number(event.target.value),
                    });
                  }}
                />
              </label>
            ))}
          </div>
        </>
      )}

      <div className="inspector-footer background-footer">
        {background.kind === 'color' && (
          <span className="inspector-hint">{t('inspector.background.chooseAsset')}</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            store.removeBackground();
          }}
        >
          {t('inspector.background.remove')}
        </Button>
      </div>
    </div>
  );
}
