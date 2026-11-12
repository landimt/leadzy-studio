import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  CheckIcon,
  LoaderCircleIcon,
  PlayIcon,
  RotateCwIcon,
  ScissorsIcon,
  XIcon,
} from 'lucide-react';
import type { EditDoc, Suggestion } from '../../../core/schema.js';
import { silenceCutKey, type SilenceCut } from '../../state/edits/suggestions.js';
import type {
  CutReviewMode,
  SilenceReviewOptions,
  SuggestionReviewOptions,
} from '../../state/storeState.js';
import { PanelTabsList, PanelTabsTrigger } from '@/components/PanelTabs';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import {
  formatSuggestionTime,
  suggestionCopy,
  suggestionOutputRange,
} from './cutSuggestionReview.js';

const EMPTY_SUGGESTIONS: readonly Suggestion[] = [];
const SUGGESTION_CRITERIA: readonly {
  readonly id: Suggestion['type'];
  readonly label: string;
}[] = [
  { id: 'silence', label: 'Pausas' },
  { id: 'repetition', label: 'Repetições' },
  { id: 'false-start', label: 'Falsos começos' },
  { id: 'filler', label: 'Vícios' },
];

const TYPE_LABEL: Record<Suggestion['type'], string> = {
  silence: 'Pausa',
  repetition: 'Repetição',
  'false-start': 'Falso começo',
  filler: 'Vício',
};

function countLabel(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

function formatCompactDuration(durationS: number): string {
  if (durationS > 0 && durationS < 0.05) return '<0,1s';
  return `${durationS.toFixed(1).replace('.', ',')}s`;
}

interface LocatedSuggestion {
  readonly suggestion: Suggestion;
  readonly at: number;
  readonly durationS: number;
}

export interface LocatedSilenceCut {
  readonly cut: SilenceCut;
  readonly at: number;
  readonly durationS: number;
}

export function CutSuggestionsPanel({
  doc,
  mode,
  running,
  progress,
  error,
  baseLocked,
  transcriptCount,
  focusedId,
  focusedSilenceKey,
  silenceCuts,
  dismissedSilenceCount,
  suggestionReview,
  silenceReview,
  silenceResult,
  onModeChange,
  onFocus,
  onPreview,
  onAccept,
  onReject,
  onAcceptMany,
  onRejectMany,
  onAnalyze,
  onFocusSilence,
  onDismissSilence,
  onRestoreSilences,
  onSuggestionReviewChange,
  onSilenceReviewChange,
  onApplySilences,
}: {
  doc: EditDoc;
  mode: CutReviewMode;
  running: boolean;
  progress?: string;
  error?: string | null;
  baseLocked: boolean;
  transcriptCount: number;
  focusedId: string | null;
  focusedSilenceKey: string | null;
  silenceCuts: readonly LocatedSilenceCut[];
  dismissedSilenceCount: number;
  suggestionReview: SuggestionReviewOptions;
  silenceReview: SilenceReviewOptions;
  silenceResult: string | null;
  onModeChange: (mode: CutReviewMode) => void;
  onFocus: (suggestion: Suggestion) => void;
  onPreview: (suggestion: Suggestion) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptMany: (ids: ReadonlySet<string>) => void;
  onRejectMany: (ids: ReadonlySet<string>) => void;
  onAnalyze: () => void;
  onFocusSilence: (cut: LocatedSilenceCut) => void;
  onDismissSilence: (cut: LocatedSilenceCut) => void;
  onRestoreSilences: () => void;
  onSuggestionReviewChange: (patch: Partial<SuggestionReviewOptions>) => void;
  onSilenceReviewChange: (patch: Partial<SilenceReviewOptions>) => void;
  onApplySilences: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const suggestions = doc.suggestions ?? EMPTY_SUGGESTIONS;
  const located = useMemo<LocatedSuggestion[]>(
    () =>
      suggestions.flatMap((suggestion) => {
        const range = suggestionOutputRange(doc, suggestion);
        return range ? [{ suggestion, ...range }] : [];
      }),
    [doc, suggestions],
  );
  const visible = located.filter((entry) => suggestionReview[entry.suggestion.type]);
  const hiddenCount = suggestions.length - located.length;
  const visibleIds = visible.map((entry) => entry.suggestion.id);
  const selectedVisibleCount = visibleIds.filter((id) => selected.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const visibleDurationS = visible.reduce((sum, entry) => sum + entry.durationS, 0);
  const silenceDurationS = silenceCuts.reduce((sum, entry) => sum + entry.durationS, 0);
  const counts = {
    silence: located.filter((entry) => entry.suggestion.type === 'silence').length,
    repetition: located.filter((entry) => entry.suggestion.type === 'repetition').length,
    filler: located.filter((entry) => entry.suggestion.type === 'filler').length,
  };
  const sourceCount = Object.keys(doc.sources).length;
  const transcriptCoverage =
    transcriptCount === 0
      ? 'Sem transcrição: a análise encontra apenas pausas.'
      : transcriptCount < sourceCount
        ? 'O texto está disponível em parte da mídia.'
        : 'Pausas, repetições e vícios de linguagem.';

  useEffect(() => {
    const currentIds = new Set(
      suggestions
        .filter((suggestion) => suggestionReview[suggestion.type])
        .map((suggestion) => suggestion.id),
    );
    setSelected((current) => {
      const next = new Set([...current].filter((id) => currentIds.has(id)));
      const unchanged = next.size === current.size && [...next].every((id) => current.has(id));
      return unchanged ? current : next;
    });
  }, [suggestions, suggestionReview]);

  const toggleSelected = (id: string, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleVisible = (checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  return (
    <section className="inspector cut-suggestions-inspector h-full min-h-0 !gap-0 overflow-hidden">
      <Tabs
        value={mode}
        onValueChange={(value) => {
          onModeChange(value as CutReviewMode);
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <PanelTabsList>
          <PanelTabsTrigger value="silences">
            Silêncios
            <span className="font-mono text-[9px] font-normal tabular-nums text-muted-foreground">
              {String(silenceCuts.length)}
            </span>
          </PanelTabsTrigger>
          <PanelTabsTrigger value="suggestions">
            Sugestões
            <span className="font-mono text-[9px] font-normal tabular-nums text-muted-foreground">
              {String(visible.length)}
            </span>
          </PanelTabsTrigger>
        </PanelTabsList>

        <TabsContent value="suggestions" className="min-h-0 flex flex-1 flex-col">
          <div className="flex shrink-0 items-start gap-2 border-b border-border py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] leading-4 text-muted-foreground">
                {running ? (progress ?? 'Analisando a montagem…') : transcriptCoverage}
              </p>
              {!running && located.length > 0 ? (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {countLabel(counts.silence, 'pausa', 'pausas')} ·{' '}
                  {countLabel(counts.repetition, 'repetição', 'repetições')} ·{' '}
                  {countLabel(counts.filler, 'vício', 'vícios')}
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-mt-1 -mr-1"
              disabled={running}
              aria-label="Analisar novamente"
              title="Analisar novamente"
              onClick={onAnalyze}
            >
              {running ? <LoaderCircleIcon className="animate-spin" /> : <RotateCwIcon />}
            </Button>
          </div>

          {located.length > 0 ? (
            <div className="shrink-0 border-b border-border py-2.5">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={
                    allVisibleSelected ? true : selectedVisibleCount > 0 ? 'indeterminate' : false
                  }
                  aria-label="Selecionar sugestões visíveis"
                  onCheckedChange={(checked) => {
                    toggleVisible(checked === true);
                  }}
                />
                <span className="min-w-0 flex-1 text-[10px] text-muted-foreground">
                  Selecionar visíveis
                </span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  −{visibleDurationS.toFixed(1)}s
                </span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-x-2">
                {SUGGESTION_CRITERIA.map((criterion) => {
                  const count = located.filter(
                    (entry) => entry.suggestion.type === criterion.id,
                  ).length;
                  return (
                    <label
                      key={criterion.id}
                      className="flex min-w-0 cursor-pointer items-center gap-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Checkbox
                        checked={suggestionReview[criterion.id]}
                        aria-label={`Revisar ${criterion.label.toLocaleLowerCase('pt-BR')}`}
                        onCheckedChange={(checked) => {
                          onSuggestionReviewChange({ [criterion.id]: checked === true });
                        }}
                      />
                      <span className="min-w-0 truncate">{criterion.label}</span>
                      <span className="font-mono text-[9px] tabular-nums">{String(count)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
            {located.length === 0 && !running ? (
              <div className="px-1 py-7 text-left">
                <strong className="text-xs font-medium">
                  {error ? 'A análise não terminou' : 'Nenhuma sugestão nesta montagem'}
                </strong>
                <p className="mt-1 max-w-[260px] text-[10px] leading-4 text-muted-foreground">
                  {error
                    ? 'Confira o erro abaixo e tente analisar novamente.'
                    : 'A montagem está enxuta para os critérios atuais.'}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  disabled={running}
                  onClick={onAnalyze}
                >
                  <RotateCwIcon /> Analisar novamente
                </Button>
              </div>
            ) : located.length === 0 ? (
              <div className="flex items-center gap-2 py-7 text-[10px] text-muted-foreground">
                <LoaderCircleIcon className="size-3.5 animate-spin text-brand" />
                Medindo pausas e conferindo o texto…
              </div>
            ) : visible.length === 0 ? (
              <div className="py-7 text-[10px] leading-4 text-muted-foreground">
                Todos os tipos foram ignorados. Marque um critério acima para voltar a revisar.
              </div>
            ) : (
              <ScrollArea className="h-full">
                <div className="divide-y divide-border/70">
                  {visible.map(({ suggestion, at, durationS }) => {
                    const focused = focusedId === suggestion.id;
                    return (
                      <div
                        key={suggestion.id}
                        className={`group grid grid-cols-[18px_minmax(0,1fr)] gap-2 px-1 py-2.5 transition-colors ${focused ? 'bg-accent/55' : 'hover:bg-muted/35'}`}
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={selected.has(suggestion.id)}
                          aria-label={`Selecionar ${suggestionCopy(suggestion, durationS)}`}
                          onCheckedChange={(checked) => {
                            toggleSelected(suggestion.id, checked === true);
                          }}
                        />
                        <div className="min-w-0">
                          <button
                            type="button"
                            data-slot="cut-suggestion-focus"
                            className="block w-full cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                            onClick={() => {
                              onFocus(suggestion);
                            }}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-[9px] font-semibold tracking-[0.08em] text-primary/80 uppercase">
                                {TYPE_LABEL[suggestion.type]}
                              </span>
                              <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
                                {formatSuggestionTime(at)} · {formatCompactDuration(durationS)}
                              </span>
                            </span>
                            <span className="mt-0.5 block text-[11px] leading-4 font-medium text-foreground">
                              {suggestionCopy(suggestion, durationS)}
                            </span>
                          </button>
                          <div className="mt-1 flex items-center gap-0.5 text-muted-foreground transition-colors group-hover:text-foreground">
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="-ml-1 text-muted-foreground"
                              onClick={() => {
                                onPreview(suggestion);
                              }}
                            >
                              <PlayIcon /> Ouvir
                            </Button>
                            <span className="flex-1" />
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="text-primary hover:text-primary"
                              disabled={baseLocked}
                              title={
                                baseLocked
                                  ? 'Desbloqueie a linha-base para aplicar'
                                  : 'Aplicar corte'
                              }
                              onClick={() => {
                                onAccept(suggestion.id);
                              }}
                            >
                              <CheckIcon /> Aplicar
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="!size-5 text-muted-foreground/70 hover:!bg-muted/70 hover:!text-foreground"
                              aria-label="Ignorar sugestão"
                              title="Ignorar sugestão"
                              onClick={() => {
                                onReject(suggestion.id);
                              }}
                            >
                              <XIcon />
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>

          <footer className="shrink-0 border-t border-border pt-2.5">
            {error ? (
              <p role="alert" className="mb-2 text-[10px] leading-4 text-destructive">
                {error}
              </p>
            ) : null}
            {hiddenCount > 0 ? (
              <p className="mb-2 text-[9px] text-muted-foreground">
                {String(hiddenCount)} sugestões desatualizadas foram ocultadas.
              </p>
            ) : null}
            {located.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-[10px] text-muted-foreground">
                  {String(selected.size)} selecionadas
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={selected.size === 0}
                  onClick={() => {
                    onRejectMany(selected);
                    setSelected(new Set());
                  }}
                >
                  Ignorar
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={selected.size === 0 || baseLocked}
                  title={baseLocked ? 'Desbloqueie a linha-base para aplicar' : ''}
                  onClick={() => {
                    onAcceptMany(selected);
                    setSelected(new Set());
                  }}
                >
                  Aplicar
                </Button>
              </div>
            ) : null}
          </footer>
        </TabsContent>

        <TabsContent value="silences" className="min-h-0 flex flex-1 flex-col">
          <div className="shrink-0 border-b border-border py-3">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <strong className="text-xs font-semibold">
                  {String(silenceCuts.length)}{' '}
                  {silenceCuts.length === 1 ? 'pausa detectada' : 'pausas detectadas'}
                </strong>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  A prévia rosa aparece na linha-base.
                </p>
              </div>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {silenceDurationS > 0 ? `−${silenceDurationS.toFixed(1)}s` : '0,0s'}
              </span>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <label className="text-[11px] font-medium">Pausa mínima</label>
              <strong className="font-mono text-[11px] tabular-nums">
                {silenceReview.minSilenceS.toFixed(1)}s
              </strong>
            </div>
            <Slider
              min={0.2}
              max={1.5}
              step={0.1}
              value={[silenceReview.minSilenceS]}
              className="mt-2 w-full"
              aria-label="Pausa mínima"
              onValueChange={([next]) => {
                if (next !== undefined) onSilenceReviewChange({ minSilenceS: next });
              }}
            />
          </div>

          <div className="shrink-0 divide-y divide-border border-b border-border">
            <label className="flex cursor-pointer items-start gap-2 py-2.5">
              <Checkbox
                className="mt-0.5"
                checked={silenceReview.interior}
                onCheckedChange={(checked) => {
                  onSilenceReviewChange({ interior: checked === true });
                }}
              />
              <span>
                <strong className="block text-[11px] font-medium">Entre falas</strong>
                <span className="block text-[10px] leading-4 text-muted-foreground">
                  Remove pausas dentro dos clipes.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 py-2.5">
              <Checkbox
                className="mt-0.5"
                checked={silenceReview.edges}
                onCheckedChange={(checked) => {
                  onSilenceReviewChange({ edges: checked === true });
                }}
              />
              <span>
                <strong className="block text-[11px] font-medium">Nas emendas</strong>
                <span className="block text-[10px] leading-4 text-muted-foreground">
                  Limpa respiros encostados nos cortes existentes.
                </span>
              </span>
            </label>
          </div>

          <div className="min-h-0 flex-1">
            {silenceCuts.length === 0 ? (
              <div className="px-1 py-7 text-left">
                <strong className="text-xs font-medium">
                  {dismissedSilenceCount > 0
                    ? 'Pausas removidas da revisão'
                    : 'Nenhuma pausa com estes ajustes'}
                </strong>
                <p className="mt-1 max-w-[260px] text-[10px] leading-4 text-muted-foreground">
                  {dismissedSilenceCount > 0
                    ? 'Restaure as pausas removidas para revisá-las novamente.'
                    : 'Diminua a pausa mínima ou habilite outro tipo de detecção.'}
                </p>
              </div>
            ) : (
              <ScrollArea className="h-full">
                <div className="divide-y divide-border">
                  {silenceCuts.map((entry, index) => {
                    const key = silenceCutKey(entry.cut);
                    const focused = focusedSilenceKey === key;
                    return (
                      <div
                        key={key}
                        className={`group flex items-center gap-0.5 px-1 py-1.5 transition-colors duration-150 ${focused ? 'bg-muted/60' : 'hover:bg-muted/35'}`}
                      >
                        <button
                          type="button"
                          data-slot="silence-cut-focus"
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm py-1 text-left outline-none transition-colors focus-visible:bg-muted/70"
                          onClick={() => {
                            onFocusSilence(entry);
                          }}
                        >
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[9px] text-muted-foreground">
                            {String(index + 1)}
                          </span>
                          <span className="min-w-0 flex-1 text-[11px]">Pausa detectada</span>
                          <span className="font-mono text-[9px] tabular-nums whitespace-nowrap text-muted-foreground">
                            {formatSuggestionTime(entry.at)} · {entry.durationS.toFixed(1)}s
                          </span>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="!size-5 text-muted-foreground/70 hover:!bg-muted/70 hover:!text-foreground"
                          aria-label="Remover pausa da lista"
                          title="Remover da lista"
                          onClick={() => {
                            onDismissSilence(entry);
                          }}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>

          <footer className="shrink-0 border-t border-border pt-2.5">
            {dismissedSilenceCount > 0 ? (
              <div className="mb-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="min-w-0 flex-1">
                  {String(dismissedSilenceCount)}{' '}
                  {dismissedSilenceCount === 1 ? 'pausa removida' : 'pausas removidas'}
                </span>
                <Button type="button" variant="ghost" size="xs" onClick={onRestoreSilences}>
                  Restaurar
                </Button>
              </div>
            ) : null}
            <p className="mb-2 min-h-4 text-[10px] leading-4 text-muted-foreground">
              {silenceResult ?? 'Todos os cortes entram em uma única etapa de desfazer.'}
            </p>
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={silenceCuts.length === 0 || baseLocked}
              title={baseLocked ? 'Desbloqueie a linha-base para aplicar' : ''}
              onClick={onApplySilences}
            >
              <ScissorsIcon /> Cortar {String(silenceCuts.length)}{' '}
              {silenceCuts.length === 1 ? 'silêncio' : 'silêncios'}
            </Button>
          </footer>
        </TabsContent>
      </Tabs>
    </section>
  );
}
