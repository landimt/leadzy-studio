import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CloudIcon,
  FileAudioIcon,
  LoaderCircleIcon,
} from 'lucide-react';
import { transcriptionKeyterms } from '../../../core/schema.js';
import { estimateScribeCostUsd } from '../../../core/scribeCost.js';
import { api, type SettingsInfo } from '../../api.js';
import { store } from '../../state/store.js';
import { useStore } from '../../state/hooks.js';
import { StudioDialog, StudioDialogError, StudioDialogFooter } from '@/components/StudioDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  estimateLabel,
  formatMediaDuration,
  formatUsageDuration,
  pendingLabel,
  transcriptBadge,
  transcriptionOverview,
} from './transcriptionOverview.js';

const HISTORY_DATE = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function historyDate(value: string | null | undefined): string {
  if (!value) return 'cache anterior';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'cache anterior' : HISTORY_DATE.format(date);
}

/** Project transcription workspace: choose once, observe the job, audit every cache. */
export function TranscriptionModal(): JSX.Element {
  const state = useStore();
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overview = useMemo(
    () => transcriptionOverview(state.project?.media ?? []),
    [state.project?.media],
  );
  const activeJob = state.activeJobs.get('transcribe');
  const running = activeJob !== undefined;
  const keyterms = state.doc ? transcriptionKeyterms(state.doc) : [];
  const estimate = estimateLabel(
    estimateScribeCostUsd(overview.pendingDurationS, keyterms.length),
    overview.pendingCount,
    keyterms.length,
  );

  useEffect(() => {
    if (!state.transcriptionOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .getSettings()
      .then((next) => {
        if (cancelled) return;
        setSettings(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.transcriptionOpen]);

  const engineReady = settings?.elevenLabs.present === true;
  const statusLabel = running
    ? (activeJob.progress ?? 'Transcrevendo mídias pendentes…')
    : pendingLabel(overview);
  const mainLabel = running
    ? 'Transcrevendo…'
    : overview.pendingCount === 0
      ? 'Tudo transcrito'
      : !engineReady
        ? 'Chave necessária'
        : `Transcrever ${String(overview.pendingCount)} ${overview.pendingCount === 1 ? 'mídia' : 'mídias'}`;

  const start = (): void => {
    if (!engineReady || overview.pendingCount === 0 || running || submitting) return;
    setSubmitting(true);
    setError(null);
    store.dismissTranscriptionError();
    void (async () => {
      try {
        if (!(await store.flushSave())) return;
        await api.startTranscribe();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
    <StudioDialog
      open={state.transcriptionOpen}
      onOpenChange={(open) => {
        if (!open) store.setTranscriptionOpen(false);
      }}
      title="Transcrever mídia"
      description="Transforme o áudio em texto para editar palavras, cortes e legendas diretamente no Studio."
      size="lg"
      className="flex h-[540px] max-h-[calc(100vh-24px)] flex-col sm:max-w-[680px]"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 text-xs">
        <section className="shrink-0 overflow-hidden rounded-[10px] border border-border bg-muted/15">
          <header className="flex min-h-8 items-center gap-2 border-b border-border px-3 py-2">
            {running ? (
              <LoaderCircleIcon className="size-3.5 animate-spin text-primary" aria-hidden="true" />
            ) : overview.pendingCount === 0 && overview.totalCount > 0 ? (
              <CheckCircle2Icon className="size-3.5 text-success" aria-hidden="true" />
            ) : (
              <CircleAlertIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            )}
            <strong className="text-[11px] font-medium">{statusLabel}</strong>
          </header>
          <div className="grid grid-cols-3 divide-x divide-border">
            <div className="px-3 py-2.5">
              <span className="block text-[9px] tracking-[0.1em] text-muted-foreground uppercase">
                Transcrito
              </span>
              <strong className="mt-0.5 block font-mono text-sm font-medium tabular-nums">
                {formatUsageDuration(overview.transcribedDurationS)}
              </strong>
            </div>
            <div className="px-3 py-2.5">
              <span className="block text-[9px] tracking-[0.1em] text-muted-foreground uppercase">
                Cobertura
              </span>
              <strong className="mt-0.5 block font-mono text-sm font-medium tabular-nums">
                {String(overview.transcribedCount)} / {String(overview.totalCount)}
              </strong>
            </div>
            <div className="px-3 py-2.5">
              <span className="block text-[9px] tracking-[0.1em] text-muted-foreground uppercase">
                Pendente
              </span>
              <strong className="mt-0.5 block font-mono text-sm font-medium tabular-nums">
                {formatUsageDuration(overview.pendingDurationS)}
              </strong>
              {estimate !== null ? (
                <span className="block font-mono text-[9px] text-muted-foreground tabular-nums">
                  {estimate}
                </span>
              ) : null}
            </div>
          </div>
        </section>

        <section className="shrink-0 overflow-hidden rounded-[10px] border border-border bg-muted/15">
          <header className="border-b border-border px-3 py-2">
            <h3 className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              Nova transcrição
            </h3>
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              Transcreve o que está pendente: mídia sem transcrição, arquivo trocado ou keyterms
              novos. O que já está atual não é cobrado de novo.
            </p>
          </header>
          <div className="flex items-center gap-3 px-3 py-2.5">
            <CloudIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <span className="block text-xs font-medium">ElevenLabs Scribe</span>
              <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                Nuvem · precisão palavra por palavra · envia somente o áudio.
              </span>
            </div>
            {!loading && !engineReady ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  store.setTranscriptionOpen(false);
                  store.setSettingsOpen(true);
                }}
              >
                Adicionar chave
              </Button>
            ) : null}
          </div>
        </section>

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-muted/15">
          <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
            <div>
              <h3 className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                Histórico neste projeto
              </h3>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Arquivo, duração do áudio e data do cache.
              </p>
            </div>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
              {String(overview.history.length)}
            </Badge>
          </header>
          {overview.history.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
              A primeira transcrição aparecerá aqui, com o tempo processado.
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="divide-y divide-border">
                {overview.history.map((item) => (
                  <div
                    key={item.relPath}
                    className="grid grid-cols-[18px_minmax(0,1fr)_auto_auto] items-center gap-2 px-3 py-2"
                  >
                    <FileAudioIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0">
                      <strong className="block truncate text-[11px] font-medium">
                        {item.relPath}
                      </strong>
                      <span className="block text-[9px] text-muted-foreground">
                        {historyDate(item.transcriptUpdatedAt)}
                      </span>
                    </div>
                    <Badge
                      variant="outline"
                      className="px-1.5 py-0 text-[9px] font-normal text-muted-foreground"
                    >
                      {transcriptBadge(item.transcriptState)}
                    </Badge>
                    <span className="min-w-14 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                      {formatMediaDuration(item.durationS)}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </section>
      </div>

      <StudioDialogError>{error ?? state.transcriptionError}</StudioDialogError>
      <StudioDialogFooter className="shrink-0">
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={() => {
            store.setTranscriptionOpen(false);
          }}
        >
          Fechar
        </Button>
        <Button
          type="button"
          size="lg"
          disabled={running || submitting || loading || !engineReady || overview.pendingCount === 0}
          onClick={start}
        >
          {mainLabel}
        </Button>
      </StudioDialogFooter>
    </StudioDialog>
  );
}
