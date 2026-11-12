import { useEffect, useState, type JSX } from 'react';
import { t } from '../../i18n/index.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { useStore } from '../../state/hooks.js';
import { store } from '../../state/store.js';
import { Button } from '@/components/ui/button';
import { debugEntryTone, formatDebugLog } from './debugLog.js';

const COPY_FEEDBACK_MS = 1500;

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

/** Floating, non-modal window: the store's view of jobs, freshness and events, live. */
export function DebugPanel(): JSX.Element | null {
  const state = useStore();
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  useEffect(() => {
    if (copied === 'idle') return;
    const timer = setTimeout(() => {
      setCopied('idle');
    }, COPY_FEEDBACK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  if (!state.debugOpen) return null;
  const project = state.project;
  const jobs = [...state.activeJobs.values()];
  const yesNo = (value: boolean): string => (value ? t('debug.yes') : t('debug.no'));
  const freshness: readonly (readonly [string, string])[] = [
    [t('debug.editHash'), project?.editHash?.slice(0, 12) ?? '—'],
    [
      t('debug.previewReceipt'),
      project?.previewEditHash === null || project?.previewEditHash === undefined
        ? '—'
        : project.previewEditHash === project.editHash
          ? t('debug.fresh')
          : t('debug.stale'),
    ],
    [t('debug.previewOutdated'), yesNo(state.previewOutdated)],
    [t('debug.audioPreview'), project?.audioPreviewCurrent ? t('debug.fresh') : t('debug.stale')],
    [t('debug.dirty'), yesNo(state.dirty)],
    [t('debug.undoDepth'), String(state.undoDepth)],
  ];
  const copyLabel =
    copied === 'ok'
      ? t('debug.copied')
      : copied === 'failed'
        ? t('debug.copyFailed')
        : t('debug.copy');
  return (
    <aside className="debug-panel" aria-label={t('debug.title')}>
      <header className="debug-panel-header">
        <span className="type-label">{t('debug.title')}</span>
        <div className="debug-panel-actions">
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              copyToClipboard(formatDebugLog(state.debugLog, freshness), (ok) => {
                setCopied(ok ? 'ok' : 'failed');
              });
            }}
          >
            {copyLabel}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t('debug.close')}
            onClick={() => {
              store.setDebugOpen(false);
            }}
          >
            ×
          </Button>
        </div>
      </header>
      <section>
        <span className="type-label">{t('debug.jobs')}</span>
        {jobs.length === 0 ? (
          <p className="debug-panel-empty">{t('debug.noJobs')}</p>
        ) : (
          <ul>
            {jobs.map((job) => (
              <li key={job.type} className="debug-entry">
                <span className="debug-badge debug-badge--running">{job.type}</span>
                <span>
                  #{job.id} {job.progress ?? ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <span className="type-label">{t('debug.freshness')}</span>
        <dl className="debug-panel-facts">
          {freshness.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <span className="type-label">{t('debug.events')}</span>
        {state.debugLog.length === 0 ? (
          <p className="debug-panel-empty">{t('debug.noEvents')}</p>
        ) : (
          <ol className="debug-panel-log">
            {[...state.debugLog].reverse().map((entry, index) => (
              <li key={`${String(entry.at)}-${String(index)}`} className="debug-entry">
                <span className="debug-panel-time">{formatTime(entry.at)}</span>
                <span className={`debug-badge debug-badge--${debugEntryTone(entry)}`}>
                  {entry.kind}
                </span>
                <span className="debug-entry-text">{entry.text}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}
