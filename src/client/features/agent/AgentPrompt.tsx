import { agentContext, contextPrompt } from './agentContext.js';
import { store } from '../../state/store.js';
import { playhead } from '../../state/playhead.js';
import { useState, type JSX } from 'react';
import { Button } from '@/components/ui/button';
import { StudioDialog, StudioDialogBody, StudioDialogFooter } from '@/components/StudioDialog';
import { copyToClipboard } from '../../lib/clipboard.js';
import { t } from '../../i18n/index.js';
import { Hint } from '../../components/Hint.js';
import { UI_ICON, UiIcon } from '../../components/UiIcon.js';

/**
 * The standard "hand this to your agent" affordance: a sparkle in the agent
 * purple that opens a modal with a ready prompt for the person's own Claude
 * Code. Every section that an agent can drive gets this same button — one
 * icon, one dialog shape, one copy flow — instead of a bespoke ⧉ per panel.
 */
export function AgentPromptButton(props: {
  /** Dialog title — name the capability ("Legendas com o seu agente"). */
  title: string;
  /** One sentence on what the person's agent can do here. */
  description: string;
  /** The prompt handed to the agent, built fresh on each open. */
  buildPrompt: () => string;
  /** When set, the sparkle gains this label — for moments that deserve prominence (e.g. a pristine project). */
  label?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState<ReturnType<typeof agentContext> | null>(null);
  const [result, setResult] = useState<'idle' | 'copied' | 'failed'>('idle');

  const openDialog = (): void => {
    const current = agentContext(store.getState(), playhead.time);
    setContext(current);
    setPrompt(contextPrompt(props.buildPrompt(), current));
    setResult('idle');
    setOpen(true);
  };

  return (
    <>
      {props.label !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-agent hover:text-agent"
          onClick={openDialog}
        >
          <UiIcon d={UI_ICON.sparkle} filled size={14} /> {props.label}
        </Button>
      ) : (
        <Hint label={t('agentPrompt.hint')}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-agent hover:text-agent"
            aria-label={t('agentPrompt.hint')}
            onClick={openDialog}
          >
            <UiIcon d={UI_ICON.sparkle} filled size={14} />
          </Button>
        </Hint>
      )}
      <StudioDialog open={open} onOpenChange={setOpen} title={props.title} size="md">
        <StudioDialogBody>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{props.description}</p>
          {context && (
            <dl className="agent-context-summary">
              <div>
                <dt>Projeto</dt>
                <dd>{context.projectDir?.split('/').at(-1) ?? 'Nenhum'}</dd>
              </div>
              <div>
                <dt>Estado capturado</dt>
                <dd>{context.unsavedChanges ? 'Alterações ainda não salvas' : 'Salvo no disco'}</dd>
              </div>
              <div>
                <dt>Seleção</dt>
                <dd>
                  {context.selection
                    ? `${context.selection.trackId} · clipe ${String(context.selection.blockIndex + 1)}`
                    : 'Sem clipe selecionado'}
                </dd>
              </div>
              {context.colorTarget && (
                <div>
                  <dt>Destino da cor</dt>
                  <dd>
                    {context.colorTarget.trackId} ·{' '}
                    {context.colorTarget.scope === 'layer'
                      ? 'camada inteira'
                      : `clipe ${String((context.colorTarget.blockIndex ?? 0) + 1)}`}
                  </dd>
                </div>
              )}
              <div>
                <dt>Cursor</dt>
                <dd>{context.playheadSeconds.toFixed(2)}s</dd>
              </div>
            </dl>
          )}
          <p className="effects-panel-hint">
            Copie este contexto para seu agente. Nada é enviado automaticamente.
          </p>
          <details>
            <summary>Ver instruções e contexto</summary>
            <pre className="agent-prompt-block">{prompt}</pre>
          </details>
        </StudioDialogBody>
        <StudioDialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(false);
            }}
          >
            {t('common.close')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              copyToClipboard(prompt, (ok) => {
                setResult(ok ? 'copied' : 'failed');
              });
            }}
          >
            {result === 'copied'
              ? t('agentPrompt.copied')
              : result === 'failed'
                ? t('agentPrompt.failed')
                : t('agentPrompt.copy')}
          </Button>
        </StudioDialogFooter>
      </StudioDialog>
    </>
  );
}
