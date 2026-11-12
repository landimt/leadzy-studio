import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '../../api.js';
import { t } from '../../i18n/index.js';
import { baseTrackOf } from '../../../core/schema.js';
import { spokenWords } from '../../../core/transcript.js';
import {
  outputSegments,
  outputTimeOf,
  segmentOutputTime,
  wordStates,
} from '../../../core/timeline.js';
import { store } from '../../state/store.js';
import { playhead } from '../../state/playhead.js';
import { usePlayheadTime, useStore } from '../../state/hooks.js';
import { useThumbnails } from '../timeline/thumbnails.js';
import { formatSeconds } from './shared.js';

const SOURCE_FILM_CLASS = [
  'film-tab min-w-0 flex-none flex items-stretch overflow-hidden',
  '!h-[34px] !p-0 !rounded-[6px] !shadow-none',
  '!border !border-border !bg-muted transition-colors duration-150',
  'hover:!border-brand/50',
  'data-[state=active]:!border-brand data-[state=active]:!bg-secondary',
  'after:!hidden focus-visible:!outline-none focus-visible:!ring-1 focus-visible:!ring-ring',
].join(' ');

function sourceLabel(path: string): string {
  return path.replace(/\.[^.]+$/, '');
}

/** One frame from a third into the take — hooks can't run in the map loop above. */
function SourceFilmThumb(props: { path: string; durationS: number | undefined }): JSX.Element {
  const at = Math.min(Math.max((props.durationS ?? 0) / 3, 0), 1.5);
  const thumbs = useThumbnails(api.mediaUrl(props.path), at, at + 0.05, 56);
  const thumb = thumbs[0];
  return (
    <span className="film-thumb">
      {thumb ? <img src={thumb} alt="" draggable={false} /> : null}
    </span>
  );
}

/**
 * The transcript IS the editor (RF5): strike words to cut, click struck words
 * to restore, click any word to seek.
 */
export function TranscriptPanel(): JSX.Element {
  const state = useStore();
  const time = usePlayheadTime();
  const [activeSource, setActiveSource] = useState<string | null>(null); // null = Final
  const [anchor, setAnchor] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const doc = state.doc;
  const sourceKeys = useMemo(() => [...state.transcripts.keys()].sort(), [state.transcripts]);
  const currentSource = activeSource;

  // Final view: kept words in OUTPUT order — what will actually be spoken
  const finalWords = useMemo(() => {
    if (!doc) return [];
    const result: {
      text: string;
      outputTime: number;
      source: string;
      sourceIndex: number;
      blockIndex: number;
    }[] = [];
    for (const segment of outputSegments(doc)) {
      const transcript = state.transcripts.get(segment.source);
      if (!transcript) continue;
      const spoken = spokenWords(transcript);
      spoken.forEach((word, sourceIndex) => {
        const mid = (word.start + word.end) / 2;
        if (mid >= segment.in && mid < segment.out) {
          result.push({
            text: word.text,
            outputTime: segmentOutputTime(segment, word.start),
            source: segment.source,
            sourceIndex,
            blockIndex: segment.blockIndex,
          });
        }
      });
    }
    return result;
  }, [doc, state.transcripts]);
  const transcript = currentSource ? state.transcripts.get(currentSource) : undefined;

  const words = useMemo(() => (transcript ? spokenWords(transcript) : []), [transcript]);
  const states = useMemo(() => {
    if (!doc || !currentSource) return [];
    return wordStates(baseTrackOf(doc).blocks, currentSource, words);
  }, [doc, currentSource, words]);

  // timeline selection ↔ text: highlight the selected block's words and scroll to them.
  // Radix moves the scrolling box to an inner viewport (see ui/scroll-area.tsx) — this
  // ref must point there, not at the "words" content div, or scrollIntoView is a no-op.
  const viewportRef = useRef<HTMLDivElement>(null);
  const selectedRange = useMemo(() => {
    if (!doc || !state.selection || !currentSource) return null;
    const track = doc.tracks.find((candidate) => candidate.id === state.selection?.trackId);
    if (track?.kind !== 'video') return null;
    const block = track.blocks[state.selection.blockIndex];
    if (block?.source !== currentSource) return null;
    let first = -1;
    let last = -1;
    words.forEach((word, i) => {
      const mid = (word.start + word.end) / 2;
      if (mid >= block.in && mid < block.out) {
        if (first === -1) first = i;
        last = i;
      }
    });
    return first === -1 ? null : { first, last };
  }, [doc, state.selection, currentSource, words]);

  useEffect(() => {
    if (!selectedRange) return;
    const element = viewportRef.current?.querySelector(
      `[data-word-index="${String(selectedRange.first)}"]`,
    );
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selectedRange]);

  if (!doc) return <div className="transcript" />;

  const selectionRange =
    anchor !== null && hovered !== null
      ? { start: Math.min(anchor, hovered), end: Math.max(anchor, hovered) }
      : null;

  const finishSelection = (index: number): void => {
    if (anchor === null || !currentSource) return;
    const start = Math.min(anchor, index);
    const end = Math.max(anchor, index);
    setAnchor(null);
    setHovered(null);
    if (states[start] === 'cut') {
      store.restoreWords(currentSource, { startIndex: start, endIndex: end });
      return;
    }
    if (start === end) {
      // single click on a kept word = seek, not cut
      const word = words[index];
      if (word) {
        const output = outputTimeOf(doc, currentSource, (word.start + word.end) / 2);
        if (output !== null) playhead.seek(output);
      }
      return;
    }
    store.strikeWords(currentSource, { startIndex: start, endIndex: end });
  };

  const sourceTabValue = currentSource ?? 'final';
  const handleSourceTabChange = (value: string): void => {
    setActiveSource(value === 'final' ? null : value);
  };

  return (
    <div className="transcript">
      <div className="flex flex-none flex-col border-b border-border">
        {sourceKeys.length > 0 && (
          <div className="flex min-w-0 items-center px-4 pt-2 pb-2">
            <Tabs
              className="source-tabs-scroll min-w-0 flex-1 overflow-x-auto"
              value={sourceTabValue}
              onValueChange={handleSourceTabChange}
            >
              <TabsList
                variant="line"
                aria-label={t('workspace.sourcesLabel')}
                className="!h-auto w-max min-w-full justify-start !gap-1.5 !rounded-none bg-transparent p-0"
              >
                <TabsTrigger value="final" className={SOURCE_FILM_CLASS}>
                  <span className="film-thumb film-final" />
                  <span className="film-meta">
                    <span className="film-name">{t('transcript.finalTab')}</span>
                    <span className="film-dur">{formatSeconds(doc.totalDurationS)}</span>
                  </span>
                </TabsTrigger>
                {sourceKeys.map((key) => {
                  const source = doc.sources[key];
                  return (
                    <TabsTrigger
                      key={key}
                      value={key}
                      title={source?.path ?? key}
                      className={SOURCE_FILM_CLASS}
                    >
                      {source ? (
                        <SourceFilmThumb path={source.path} durationS={source.durationS} />
                      ) : (
                        <span className="film-thumb" />
                      )}
                      <span className="film-meta">
                        {/* the span is what truncates: `text-overflow` has no effect
                              on the flex container the trigger itself is */}
                        <span className="film-name min-w-0 truncate">
                          {sourceLabel(source?.path ?? key)}
                        </span>
                        <span className="film-dur">{formatSeconds(source?.durationS)}</span>
                      </span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
          </div>
        )}
      </div>

      <div className="mt-0 min-h-0 flex flex-1 flex-col">
        {sourceKeys.length === 0 ? (
          <div className="empty-state">
            {state.project?.apiKeyPresent === false ? t('noKey.message') : t('transcript.empty')}
          </div>
        ) : currentSource === null ? (
          <ScrollArea viewportRef={viewportRef} className="min-h-0 flex-1">
            <div className="words">
              {finalWords.map((word, index) => {
                const isCurrent = Math.abs(word.outputTime - time) < 0.35;
                const isBlockStart =
                  index > 0 && finalWords[index - 1]?.blockIndex !== word.blockIndex;
                const inSelectedBlock =
                  state.selection !== null &&
                  state.selection.trackId === baseTrackOf(doc).id &&
                  state.selection.blockIndex === word.blockIndex;
                return (
                  <span key={index}>
                    {isBlockStart && (
                      <span className="block-joint" title={t('transcript.blockJoint.title')}>
                        ⌇
                      </span>
                    )}
                    <span
                      className={[
                        'word',
                        isCurrent ? 'current' : '',
                        inSelectedBlock ? 'in-block' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      title={`${word.outputTime.toFixed(2)}s · ${doc.sources[word.source]?.path ?? word.source}`}
                      onClick={() => {
                        playhead.seek(word.outputTime);
                      }}
                      onDoubleClick={() => {
                        // jump to where this word lives (its source tab) — cutting
                        // happens there, with full context
                        setActiveSource(word.source);
                        setTimeout(() => {
                          viewportRef.current
                            ?.querySelector(`[data-word-index="${String(word.sourceIndex)}"]`)
                            ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        }, 60);
                      }}
                    >
                      {word.text}
                    </span>{' '}
                  </span>
                );
              })}
            </div>
          </ScrollArea>
        ) : (
          <ScrollArea
            viewportRef={viewportRef}
            className="min-h-0 flex-1"
            onPointerLeave={() => {
              setAnchor(null);
              setHovered(null);
            }}
          >
            <div className="words">
              {words.map((word, index) => {
                const wordState = states[index] ?? 'kept';
                const isSelected =
                  selectionRange !== null &&
                  index >= selectionRange.start &&
                  index <= selectionRange.end;
                const output = currentSource
                  ? outputTimeOf(doc, currentSource, (word.start + word.end) / 2)
                  : null;
                const isCurrent = output !== null && Math.abs(output - time) < 0.35;
                const inSelectedBlock =
                  selectedRange !== null &&
                  index >= selectedRange.first &&
                  index <= selectedRange.last;
                return (
                  <span
                    key={index}
                    data-word-index={index}
                    className={[
                      'word',
                      wordState === 'cut' ? 'cut' : '',
                      isSelected ? 'selected' : '',
                      isCurrent ? 'current' : '',
                      inSelectedBlock ? 'in-block' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    title={`${word.start.toFixed(2)}s`}
                    onPointerDown={() => {
                      setAnchor(index);
                      setHovered(index);
                    }}
                    onPointerEnter={() => {
                      if (anchor !== null) setHovered(index);
                    }}
                    onPointerUp={() => {
                      finishSelection(index);
                    }}
                    onDoubleClick={() => {
                      if (currentSource && states[index] === 'kept') {
                        store.strikeWords(currentSource, { startIndex: index, endIndex: index });
                      }
                    }}
                  >
                    {word.text}{' '}
                  </span>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
