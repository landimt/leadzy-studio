import { useState, type JSX } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { agentJsonPrompt, SUBTITLE_AGENT_PROMPT } from '../agent/agentPrompts.js';
import { t } from '../../i18n/index.js';
import { type EditDoc } from '../../../core/schema.js';
import { subtitleSettingsFor, subtitleThemeFor } from '../../../core/srt.js';
import { SUBTITLE_LIBRARY } from '../../../core/subtitleLibrary.js';
import { spokenWords, type Transcript } from '../../../core/transcript.js';
import { resolveCorrections } from '../../../core/srt.js';
import { store } from '../../state/store.js';
import { type SelectedCue } from '../../state/storeState.js';
import { AgentPromptButton } from '../agent/AgentPrompt.js';
import { UI_ICON, UiIcon } from '../../components/UiIcon.js';
import { LibraryStyleCard } from './LibraryStyleCard.js';
import { SubtitleThemeControls } from './SubtitleThemeControls.js';

/** Not in UiIcon's shared set — used once, only for the subtitle-locked heading badge. */

const LOCK_ICON_PATH = 'M4.5 7V5.5A3.5 3.5 0 0 1 11.5 5.5V7 M3.5 7h9v6.5h-9z';

/**
 * One word of the selected cue as an editable chip. The draft is local and
 * only commits on blur/Enter — trimming per keystroke made spaces impossible
 * to type and refilled the field with the original word while clearing it.
 */
function CorrectionChip(props: {
  source: string;
  /** Source time inside the word — what the correction is keyed on. */
  at: number;
  original: string;
  committed: string | undefined;
}): JSX.Element {
  const [draft, setDraft] = useState(props.committed ?? props.original);
  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed === (props.committed ?? props.original)) return;
    store.correctWord(props.source, props.at, trimmed);
  };
  return (
    <Input
      className={cn(
        'w-auto min-w-[34px] flex-none rounded-full text-center field-sizing-content',
        props.committed !== undefined && 'border-agent bg-agent/10',
      )}
      type="text"
      aria-label={t('inspector.cue.wordAria')}
      title={props.original}
      size={Math.max(3, draft.length)}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

/** Per-word correction inputs + hide-range action for the selected subtitle cue. */
function CueCorrectionSection(props: {
  doc: EditDoc;
  cue: SelectedCue;
  transcript: Transcript;
}): JSX.Element | null {
  const words = spokenWords(props.transcript);
  const first = words[props.cue.wordStart];
  const last = words[props.cue.wordEnd];
  if (!first || !last) return null;
  const corrections = resolveCorrections(
    words,
    (props.doc.subtitles.corrections ?? []).filter((c) => c.source === props.cue.source),
  );
  const correctionFor = (wordIndex: number): string | undefined => corrections.get(wordIndex);
  const wordCount = props.cue.wordEnd - props.cue.wordStart + 1;

  return (
    <div className="cue-correction">
      <div className="cue-correction-heading">
        <span className="with-icon">
          <UiIcon d={UI_ICON.captions} />
          {t('inspector.cue.title')}
        </span>
        <span className="inspector-time">
          {first.start.toFixed(2)}s – {last.end.toFixed(2)}s
        </span>
      </div>
      <div className="cue-correction-words">
        {Array.from({ length: wordCount }, (_, offset) => {
          const wordIndex = props.cue.wordStart + offset;
          const word = words[wordIndex];
          if (!word) return null;
          const committed = correctionFor(wordIndex);
          return (
            <CorrectionChip
              key={`${String(wordIndex)}:${committed ?? ''}`}
              source={props.cue.source}
              at={word.start}
              original={word.text}
              committed={committed}
            />
          );
        })}
      </div>
      <div className="inspector-footer">
        <span className="inspector-hint">{t('inspector.cue.hint')}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            store.hideSubtitleRange(props.cue.source, first.start, last.end);
            store.selectSubtitles();
          }}
        >
          {t('inspector.cue.hideButton')}
        </Button>
      </div>
    </div>
  );
}

export function SubtitleInspector(props: {
  doc: EditDoc;
  selectedCue: SelectedCue | null;
  transcripts: ReadonlyMap<string, Transcript>;
}): JSX.Element {
  const settings = subtitleSettingsFor(props.doc);
  const theme = subtitleThemeFor(props.doc);
  const updateMinWords = (raw: number): void => {
    if (!Number.isFinite(raw)) return;
    const minWordsPerCue = Math.min(6, Math.max(1, Math.round(raw)));
    store.updateSubtitleSettings({
      minWordsPerCue,
      maxWordsPerCue: Math.max(minWordsPerCue, settings.maxWordsPerCue),
    });
  };
  const updateMaxWords = (raw: number): void => {
    if (!Number.isFinite(raw)) return;
    const maxWordsPerCue = Math.min(6, Math.max(1, Math.round(raw)));
    store.updateSubtitleSettings({
      minWordsPerCue: Math.min(settings.minWordsPerCue, maxWordsPerCue),
      maxWordsPerCue,
    });
  };

  const cueTranscript = props.selectedCue
    ? props.transcripts.get(props.selectedCue.source)
    : undefined;

  return (
    <div className="inspector subtitle-inspector">
      {props.selectedCue && cueTranscript && (
        <CueCorrectionSection doc={props.doc} cue={props.selectedCue} transcript={cueTranscript} />
      )}
      <div className="inspector-heading">
        <span className="with-icon">
          <UiIcon d={UI_ICON.captions} />
          {t('inspector.subtitle.title')}
          {props.doc.subtitles.locked === true && (
            <span title={t('inspector.subtitle.lockedHint')}>
              <UiIcon d={LOCK_ICON_PATH} size={12} />
            </span>
          )}
        </span>
        <AgentPromptButton
          title={t('inspector.subtitle.agentDialogTitle')}
          description={t('inspector.subtitle.agentDialogDescription')}
          buildPrompt={() => agentJsonPrompt(SUBTITLE_AGENT_PROMPT, props.doc.subtitles)}
        />
      </div>

      <div className="subtitle-control">
        <label>{t('inspector.subtitle.style')}</label>
        <div className="subtitle-library-grid">
          {SUBTITLE_LIBRARY.map((style) => {
            const cardTheme = subtitleThemeFor({
              ...props.doc,
              subtitles: { ...props.doc.subtitles, preset: style.preset, theme: style.theme },
            });
            return (
              <LibraryStyleCard
                key={style.id}
                style={style}
                theme={cardTheme}
                // subtitleThemeFor always returns its fields in the same
                // order, so this stringify compare is stable — unlike
                // comparing the raw (optional-field) theme objects, whose
                // key order depends on how each was authored/round-tripped.
                active={
                  props.doc.subtitles.preset === style.preset &&
                  JSON.stringify(theme) === JSON.stringify(cardTheme)
                }
              />
            );
          })}
        </div>
        <p className="subtitle-agent-hint">{t('inspector.subtitle.agentHint')}</p>
      </div>

      <SubtitleThemeControls doc={props.doc} theme={theme} />

      {(props.doc.subtitles.hiddenRanges ?? []).length > 0 && (
        <div className="subtitle-hidden-list">
          <label>{t('inspector.subtitle.hiddenList')}</label>
          <div className="subtitle-hidden-items">
            {(props.doc.subtitles.hiddenRanges ?? []).map((range, index) => (
              <span className="subtitle-hidden-item" key={`${range.source}:${String(index)}`}>
                {range.start.toFixed(1)}–{range.end.toFixed(1)}s
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title={t('inspector.subtitle.showAgain')}
                  aria-label={t('inspector.subtitle.showAgain')}
                  onClick={() => {
                    store.unhideSubtitleRange(index);
                  }}
                >
                  ✕
                </Button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="subtitle-limit-row">
        <label>{t('inspector.subtitle.words')}</label>
        <span className="subtitle-limit-inputs">
          <label>
            <span>{t('inspector.subtitle.minimum')}</span>
            <Input
              type="number"
              min={1}
              max={6}
              value={settings.minWordsPerCue}
              onChange={(event) => {
                updateMinWords(Number(event.target.value));
              }}
            />
          </label>
          <span aria-hidden="true">–</span>
          <label>
            <span>{t('inspector.subtitle.maximum')}</span>
            <Input
              type="number"
              min={1}
              max={6}
              value={settings.maxWordsPerCue}
              onChange={(event) => {
                updateMaxWords(Number(event.target.value));
              }}
            />
          </label>
        </span>
      </div>

      <div className="effect-control">
        <div className="effect-control-label">
          <label>{t('inspector.subtitle.size')}</label>
          <output>{settings.fontSize}px</output>
        </div>
        <Slider
          min={10}
          max={28}
          step={1}
          value={[settings.fontSize]}
          aria-label={t('inspector.subtitle.size')}
          onValueChange={([next]) => {
            if (next === undefined) return;
            store.updateSubtitleSettings({ fontSize: next }, 'subtitles:fontSize');
          }}
        />
      </div>

      <div className="effect-control">
        <div className="effect-control-label">
          <label>{t('inspector.subtitle.position')}</label>
          <output>{String(Math.round((settings.marginV / 288) * 100))}%</output>
        </div>
        <Slider
          min={10}
          max={240}
          step={2}
          value={[settings.marginV]}
          aria-label={t('inspector.subtitle.position')}
          onValueChange={([next]) => {
            if (next === undefined) return;
            store.updateSubtitleSettings({ marginV: next }, 'subtitles:marginV');
          }}
        />
      </div>

      <div className="inspector-footer">
        <span className="inspector-hint">{t('inspector.subtitle.lockedHint')}</span>
        <label className="inspector-inline-toggle">
          <Checkbox
            checked={props.doc.subtitles.locked ?? false}
            onCheckedChange={(next) => {
              store.updateSubtitleSettings({ locked: next === true });
            }}
          />
          {t('inspector.subtitle.locked')}
        </label>
      </div>

      <div className="inspector-footer">
        <span className="inspector-hint">{t('inspector.subtitle.hint')}</span>
        <label className="inspector-inline-toggle">
          <Checkbox
            checked={props.doc.subtitles.enabled}
            onCheckedChange={(next) => {
              store.updateSubtitleSettings({ enabled: next === true });
            }}
          />
          {t('inspector.subtitle.enabled')}
        </label>
      </div>
    </div>
  );
}
