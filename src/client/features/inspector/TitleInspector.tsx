import { useState, type JSX } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '../../api.js';
import { agentJsonPrompt, OVERLAY_AGENT_PROMPT } from '../agent/agentPrompts.js';
import { t } from '../../i18n/index.js';
import { type OverlayBlock } from '../../../core/schema.js';
import { store } from '../../state/store.js';
import { AgentPromptButton } from '../agent/AgentPrompt.js';
import { OverlayDurationControl, SaveToLibraryControl } from './OverlayControls.js';
import { basename } from './basename.js';

export function TitleInspector(props: {
  trackId: string;
  blockIndex: number;
  block: OverlayBlock;
  busy: boolean;
  isTitleJob: boolean;
}): JSX.Element {
  const spec = props.block.title;
  const [draft, setDraft] = useState(spec?.text ?? '');
  if (!spec) return <></>;
  const text = draft.trim();
  const changed = text.length > 0 && text !== spec.text;
  const regenerate = (): void => {
    if (!changed || props.busy) return;
    void (async () => {
      try {
        if (!(await store.flushSave())) return;
        await api.startTitle({
          text,
          style: spec.style,
          pos: spec.pos,
          at: props.block.at,
          durationS: props.block.duration ?? 4,
          trackId: props.trackId,
          blockIndex: props.blockIndex,
        });
      } catch (cause) {
        store.showError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  };

  return (
    <div className="inspector overlay-inspector">
      <div className="inspector-heading">
        <span>{t('inspector.overlay.title')}</span>
        <span className="inspector-time">
          {props.block.at.toFixed(2)}s · {(props.block.duration ?? 4).toFixed(1)}s
        </span>
        <AgentPromptButton
          title={t('inspector.overlay.agentDialogTitle')}
          description={t('inspector.overlay.agentDialogDescription')}
          buildPrompt={() => agentJsonPrompt(OVERLAY_AGENT_PROMPT, props.block)}
        />
      </div>
      <Textarea
        value={draft}
        rows={2}
        placeholder={t('inspector.overlay.placeholder')}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') regenerate();
        }}
      />
      <OverlayDurationControl
        trackId={props.trackId}
        blockIndex={props.blockIndex}
        block={props.block}
      />
      <SaveToLibraryControl
        file={props.block.file}
        prefillName={spec.text.trim().length > 0 ? spec.text : basename(props.block.file)}
        defaultKind="title"
        durationS={props.block.duration}
      />
      <div className="inspector-footer">
        <span className="inspector-hint">{t('inspector.overlay.hint')}</span>
        <Button type="button" disabled={!changed || props.busy} onClick={regenerate}>
          {props.isTitleJob ? t('inspector.overlay.generating') : t('inspector.overlay.apply')}
        </Button>
      </div>
    </div>
  );
}
