import { useEffect, useState, type JSX } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type LibraryItem } from '../../api.js';
import {
  LIBRARY_OVERLAY_TIMING_VARIABLES,
  MAX_LIBRARY_VARIABLE_VALUE_LENGTH,
} from '../../../core/libraryItem.js';
import { agentJsonPrompt, OVERLAY_AGENT_PROMPT } from '../agent/agentPrompts.js';
import { t } from '../../i18n/index.js';
import { type OverlayBlock } from '../../../core/schema.js';
import { store } from '../../state/store.js';
import { AgentPromptButton } from '../agent/AgentPrompt.js';
import { OverlayDurationControl, SaveToLibraryControl } from './OverlayControls.js';
import { basename } from './basename.js';

/**
 * Variables form for an overlay imported from a parametric library piece.
 * Applying re-bakes the piece from the PROJECT's copy of its template, so it
 * keeps working after the global library item changes or goes away — only the
 * cosmetic labels and description come from the item, with the raw variable
 * name as the fallback when it is gone.
 */
export function LibraryOverlayInspector(props: {
  trackId: string;
  blockIndex: number;
  block: OverlayBlock;
  itemId: string;
  variables: Readonly<Record<string, string>>;
  libraryRevision: number;
  busy: boolean;
  isBaking: boolean;
}): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({ ...props.variables });
  const [item, setItem] = useState<LibraryItem | null>(null);
  // Covers the gap between POSTing the job and its SSE 'running' event landing
  // in activeJobs — a second click inside it would 409 ("já existe uma peça
  // sendo regerada") instead of being ignored. Cleared by the SSE arriving
  // (isBaking takes over) or by a failed POST — NOT on POST success, which
  // can resolve before the event does. A successful POST also clears the
  // short client-side guard: activeJobs owns the longer running state, while
  // this fallback prevents a missed/instant SSE cycle from trapping the form.
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (props.isBaking) setSubmitting(false);
  }, [props.isBaking]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getLibrary()
      .then((response) => {
        if (cancelled) return;
        setItem(response.items.find((candidate) => candidate.id === props.itemId) ?? null);
      })
      .catch(() => {
        // labels are cosmetic; the form falls back to the raw variable names
      });
    return () => {
      cancelled = true;
    };
  }, [props.itemId, props.libraryRevision]);

  // The FIELDS are the block's own values — they are what the project's
  // template substitutes and what the re-bake route accepts. The item only
  // contributes cosmetics: a friendlier label, and the author's ordering when
  // it still describes the same names.
  const labels = new Map(
    (item?.variables ?? []).map((variable) => [variable.name, variable.label]),
  );
  const authored = (item?.variables ?? [])
    .map((variable) => variable.name)
    .filter((name) => name in props.variables);
  const fields = [
    ...authored,
    ...Object.keys(props.variables)
      .filter((name) => !authored.includes(name))
      .sort((a, b) => a.localeCompare(b)),
  ].map((name) => ({ name, label: labels.get(name) }));
  const changed = fields.some(
    (field) => (drafts[field.name] ?? '') !== (props.variables[field.name] ?? ''),
  );
  const durationComesFromTemplate = Object.keys(LIBRARY_OVERLAY_TIMING_VARIABLES).some((name) =>
    Object.prototype.hasOwnProperty.call(props.variables, name),
  );

  const busy = props.busy || submitting;

  const apply = (): void => {
    if (!changed || busy) return;
    setSubmitting(true);
    void (async () => {
      try {
        if (!(await store.flushSave())) {
          setSubmitting(false);
          return;
        }
        await api.startLibraryOverlay({
          trackId: props.trackId,
          blockIndex: props.blockIndex,
          file: props.block.file,
          at: props.block.at,
          variables: drafts,
        });
        setSubmitting(false);
      } catch (cause) {
        setSubmitting(false);
        store.showError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  };

  return (
    <div className="inspector overlay-inspector">
      <div className="inspector-heading">
        <span>{item?.name ?? t('inspector.library.item')}</span>
        <span className="inspector-time">
          {props.block.at.toFixed(2)}s · {(props.block.duration ?? 2).toFixed(1)}s
        </span>
        <AgentPromptButton
          title={t('inspector.overlay.agentDialogTitle')}
          description={t('inspector.overlay.agentDialogDescription')}
          buildPrompt={() => agentJsonPrompt(OVERLAY_AGENT_PROMPT, props.block)}
        />
      </div>
      {item?.description !== undefined && <p className="inspector-hint">{item.description}</p>}
      <div className="library-variables">
        {fields.map((field) => {
          const timingBounds = LIBRARY_OVERLAY_TIMING_VARIABLES[field.name];
          return (
            <label key={field.name}>
              <span>{field.label ?? field.name}</span>
              <Input
                type={timingBounds === undefined ? 'text' : 'number'}
                value={drafts[field.name] ?? ''}
                maxLength={MAX_LIBRARY_VARIABLE_VALUE_LENGTH}
                {...(timingBounds === undefined
                  ? {}
                  : { min: timingBounds.min, max: timingBounds.max, step: 0.1 })}
                onChange={(event) => {
                  setDrafts((current) => ({ ...current, [field.name]: event.target.value }));
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') apply();
                }}
              />
            </label>
          );
        })}
      </div>
      {!durationComesFromTemplate && (
        <OverlayDurationControl
          trackId={props.trackId}
          blockIndex={props.blockIndex}
          block={props.block}
        />
      )}
      <SaveToLibraryControl
        file={props.block.file}
        prefillName={item?.name ?? basename(props.block.file)}
        defaultKind={item?.kind ?? 'other'}
        durationS={props.block.duration}
      />
      <div className="inspector-footer">
        <span className="inspector-hint">{t('inspector.library.applyHint')}</span>
        <Button type="button" disabled={!changed || busy} onClick={apply}>
          {props.isBaking ? t('inspector.library.applying') : t('inspector.library.apply')}
        </Button>
      </div>
    </div>
  );
}
