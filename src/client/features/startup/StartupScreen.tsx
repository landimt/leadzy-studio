import type { JSX } from 'react';
import { Button } from '@/components/ui/button';
import logoUrl from '../../../../assets/brand/leadzy-studio-mark.svg';
import { t } from '../../i18n/index.js';

export function StartupScreen({
  error,
  onRetry,
  title,
  detail,
}: {
  error?: string;
  onRetry?: () => void;
  title?: string;
  detail?: string;
}): JSX.Element {
  const failed = error !== undefined;
  return (
    <main
      className={`startup-screen${failed ? ' startup-screen-error' : ''}`}
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
      aria-label={failed ? error : t('app.loading')}
    >
      <header className="startup-brand">
        <img src={logoUrl} alt="" />
        <strong>Leadzy Studio</strong>
        <span>{t('app.localAgentNative')}</span>
      </header>

      <section className="startup-workspace" aria-hidden="true">
        <div className="startup-player">
          <span className="startup-frame-mark" />
        </div>
        <div className="startup-copy">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="startup-timeline">
          <span />
          <span />
          <span />
          <span />
        </div>
      </section>

      <div className="startup-status">
        <p>{failed ? t('app.loadingErrorTitle') : (title ?? t('app.loadingTitle'))}</p>
        <span>{failed ? error : (detail ?? t('app.loadingDetail'))}</span>
        {failed ? (
          <Button type="button" onClick={onRetry}>
            {t('app.retry')}
          </Button>
        ) : (
          <div className="startup-progress" aria-hidden="true">
            <i />
          </div>
        )}
      </div>
    </main>
  );
}
