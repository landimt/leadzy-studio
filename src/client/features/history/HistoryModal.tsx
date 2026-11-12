import { useEffect, useState, type JSX } from 'react';
import { api, type HistoryEntry, type HistoryOrigin } from '../../api.js';
import { t, type MessageKey } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { useStore } from '../../state/hooks.js';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

const ORIGIN_LABEL_KEY: Record<HistoryOrigin, MessageKey> = {
  ui: 'history.origin.ui',
  agent: 'history.origin.agent',
  title: 'history.origin.title',
  suggest: 'history.origin.suggest',
  restore: 'history.origin.restore',
  startup: 'history.origin.startup',
};

/** "agora" / "há 5 min" / "há 2 h" / "ontem" / "há 3 dias" — no ICU in this app's i18n, so words and numbers compose in JSX like the rest of the codebase's duration displays. */
function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMin = Math.max(0, Math.floor((nowMs - then) / 60_000));
  if (diffMin < 1) return t('history.time.now');
  if (diffMin < 60)
    return `${t('history.time.agoPrefix')} ${String(diffMin)} ${t('history.time.minUnit')}`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24)
    return `${t('history.time.agoPrefix')} ${String(diffHours)} ${t('history.time.hourUnit')}`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return t('history.time.yesterday');
  return `${t('history.time.agoPrefix')} ${String(diffDays)} ${t('history.time.dayUnit')}`;
}

/** Version history — snapshots recorded by the server on every meaningful edit.json write. */
export function HistoryModal(): JSX.Element {
  const state = useStore();
  const [entries, setEntries] = useState<readonly HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!state.historyOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .getHistory()
      .then((response) => {
        if (!cancelled) setEntries(response.entries);
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
  }, [state.historyOpen]);

  const renderRunning = state.activeJobs.has('render');

  const close = (): void => {
    setConfirmingId(null);
    store.setHistoryOpen(false);
  };

  const restore = (id: string): void => {
    setError(null);
    setRestoring(true);
    void (async () => {
      try {
        if (!(await store.flushSave())) return;
        await api.restoreHistory(id);
        await store.reloadFromServer(false);
        setConfirmingId(null);
        store.setHistoryOpen(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRestoring(false);
      }
    })();
  };

  return (
    <Dialog
      open={state.historyOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="gap-2 p-4 sm:max-w-md"
        onClick={() => {
          setConfirmingId(null);
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-[13px]">{t('history.title')}</DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="py-6 text-center text-xs text-muted-foreground">{t('history.loading')}</p>
        )}
        {error !== null && <p className="text-xs text-destructive">{error}</p>}
        {!loading && entries.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">{t('history.empty')}</p>
        )}
        {!loading && entries.length > 0 && (
          <ScrollArea maxHeight={320}>
            <div className="flex flex-col">
              {entries.map((entry, index) => (
                <div key={entry.id}>
                  {index > 0 && <Separator />}
                  <div className="flex items-center gap-2.5 py-2 text-xs">
                    <span className="min-w-16 font-mono text-[11px] text-muted-foreground">
                      {relativeTime(entry.ts, Date.now())}
                    </span>
                    <span className="flex-1 font-semibold">
                      {t(ORIGIN_LABEL_KEY[entry.origin])}
                    </span>
                    <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground">
                      {entry.totalDurationS.toFixed(1)}s · {String(entry.blocks)}{' '}
                      {t('history.blocksUnit')}
                    </span>
                    <Button
                      type="button"
                      size="lg"
                      variant={confirmingId === entry.id ? 'destructive' : 'outline'}
                      disabled={renderRunning || restoring}
                      title={renderRunning ? t('history.restoreDisabledTitle') : ''}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (confirmingId === entry.id) {
                          restore(entry.id);
                        } else {
                          setConfirmingId(entry.id);
                        }
                      }}
                    >
                      {confirmingId === entry.id ? t('history.confirm') : t('history.restore')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
