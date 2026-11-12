import { useEffect, useRef, useState, type JSX } from 'react';
import { isPanelActive } from '../shell/dock.js';
import { SearchIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Hint } from '../../components/Hint.js';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api, type LibraryItem } from '../../api.js';
import { LIBRARY_KIND_LABEL_KEY, t } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { LIBRARY_DRAG_MIME } from '../../state/docEdits.js';
import { playhead } from '../../state/playhead.js';
import { useStore } from '../../state/hooks.js';
import { UI_ICON, UiIcon } from '../../components/UiIcon.js';
import { AgentPromptButton } from '../agent/AgentPrompt.js';
import { agentJsonPrompt, LIBRARY_AGENT_PROMPT } from '../agent/agentPrompts.js';
import { ICON_PLUS } from './shared.js';

/** Chrome renders vp9-alpha webm as opaque black in <img>/<video> — thumbnails use the companion the server picked (animated webp > frozen png). */
function libraryThumbFilename(item: LibraryItem): string {
  return item.preview ?? item.file;
}

/** A parametric piece ships its HyperFrames source plus the values the Studio can re-bake it with. */
function isParametric(item: LibraryItem): boolean {
  return item.template !== undefined && item.variables !== undefined;
}

function libraryCopyText(item: LibraryItem): string {
  const duration = item.durationS !== undefined ? `${item.durationS.toFixed(1)}s` : '—';
  return [
    `Item da biblioteca: ${item.name}`,
    `id: ${item.id}`,
    `tipo: ${t(LIBRARY_KIND_LABEL_KEY[item.kind])}`,
    `duração: ${duration}`,
    ...(item.description !== undefined ? [`quando usar: ${item.description}`] : []),
    ...(item.tags !== undefined && item.tags.length > 0 ? [`tags: ${item.tags.join(', ')}`] : []),
    `arquivo: ~/.leadzy-studio/library/${item.id}/${item.file}`,
    ...(item.template !== undefined
      ? [`template: ~/.leadzy-studio/library/${item.id}/${item.template}`]
      : []),
    ...(item.variables !== undefined
      ? [
          `variáveis: ${item.variables
            .map((variable) => `{{${variable.name}}}=${variable.default}`)
            .join(' · ')}`,
        ]
      : []),
    '',
    t('library.card.copyInstruction'),
  ].join('\n');
}

function LibraryCard(props: {
  item: LibraryItem;
  importing: boolean;
  removing: boolean;
  disabled: boolean;
  onImport: (item: LibraryItem) => void;
  onRemove: (item: LibraryItem) => void;
}): JSX.Element {
  const { item } = props;
  const [copied, setCopied] = useState(false);
  // Deletion is permanent (no trash, no undo), so the button arms on the
  // first click and only the second one deletes; arming expires on its own.
  const [armedRemove, setArmedRemove] = useState(false);
  const thumbRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!armedRemove) return;
    const timer = setTimeout(() => {
      setArmedRemove(false);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [armedRemove]);

  return (
    <div
      className="library-card"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(LIBRARY_DRAG_MIME, item.id);
        event.dataTransfer.effectAllowed = 'copy';
        if (thumbRef.current) event.dataTransfer.setDragImage(thumbRef.current, 20, 20);
      }}
    >
      <span className="library-card-thumb">
        {item.hasPreview ? (
          <img
            ref={thumbRef}
            src={api.libraryFileUrl(item.id, libraryThumbFilename(item))}
            alt={item.name}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <span className="library-card-thumb-empty">
            <UiIcon d={UI_ICON.overlay} size={32} />
          </span>
        )}
      </span>
      <span className="library-card-actions">
        <Hint label={t('library.card.insertTitle')}>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="bg-background/85 text-foreground backdrop-blur-xs hover:bg-background"
            aria-label={t('library.card.insertTitle')}
            disabled={props.disabled}
            draggable={false}
            onClick={() => {
              props.onImport(item);
            }}
          >
            <UiIcon d={ICON_PLUS} size={12} />
          </Button>
        </Hint>
        <Hint label={t('library.card.copyTitle')}>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="bg-background/85 text-foreground backdrop-blur-xs hover:bg-background"
            aria-label={t('library.card.copyTitle')}
            draggable={false}
            onClick={() => {
              void navigator.clipboard.writeText(libraryCopyText(item)).then(() => {
                setCopied(true);
                setTimeout(() => {
                  setCopied(false);
                }, 1500);
              });
            }}
          >
            {copied ? '✓' : '⧉'}
          </Button>
        </Hint>
        <Hint label={armedRemove ? t('library.card.removeConfirm') : t('library.card.removeTitle')}>
          <Button
            type="button"
            size="icon-xs"
            variant={armedRemove ? 'destructive' : 'ghost'}
            className={
              armedRemove
                ? ''
                : 'bg-background/85 text-foreground backdrop-blur-xs hover:bg-background'
            }
            aria-label={
              armedRemove ? t('library.card.removeConfirm') : t('library.card.removeTitle')
            }
            aria-pressed={armedRemove}
            disabled={props.removing || props.disabled}
            draggable={false}
            onClick={() => {
              if (!armedRemove) {
                setArmedRemove(true);
                return;
              }
              setArmedRemove(false);
              props.onRemove(item);
            }}
          >
            <UiIcon d={UI_ICON.trash} size={12} />
          </Button>
        </Hint>
      </span>
      <span className="library-card-name" title={item.name}>
        {item.name}
      </span>
      {item.description !== undefined && (
        <span className="library-card-desc" title={item.description}>
          {item.description}
        </span>
      )}
      <span className="library-card-meta">
        <span className="library-card-chips">
          <span className="library-chip">{t(LIBRARY_KIND_LABEL_KEY[item.kind])}</span>
          {isParametric(item) && (
            <span className="library-chip is-parametric" title={t('library.card.parametricTitle')}>
              {t('library.card.parametric')}
            </span>
          )}
        </span>
        {props.importing && (
          <span className="library-card-duration">{t('library.card.importing')}</span>
        )}
        {!props.importing && item.durationS !== undefined && (
          <span className="library-card-duration">{item.durationS.toFixed(1)}s</span>
        )}
      </span>
    </div>
  );
}

/** Personal overlay library — items saved from the inspector or created by the agent, reusable across projects. Lives as a tab here (not a modal) so it stays open while the user drags items onto the timeline. */
export function LibraryPanel(): JSX.Element {
  const state = useStore();
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(new Set());

  // The tab is force-mounted behind CSS, so mounting is not the moment the
  // panel becomes visible. Refetch when it does — an agent writing an item
  // straight into the library folder would otherwise stay invisible until a
  // full page reload.
  const active = isPanelActive(state.dockLayout, 'library');
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .getLibrary()
      .then((response) => {
        if (!cancelled) setItems(response.items);
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
  }, [active, state.libraryRevision]);

  const importItem = (item: LibraryItem): void => {
    setError(null);
    setImportingId(item.id);
    void (async () => {
      try {
        if (!(await store.flushSave())) return;
        const at = Math.round(playhead.time * 100) / 100;
        await api.importLibraryItem(item.id, at);
        await store.reloadFromServer(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setImportingId(null);
      }
    })();
  };

  const normalized = (value: string): string => value.toLocaleLowerCase('pt-BR');
  const allTags = [...new Set(items.flatMap((item) => item.tags ?? []))].sort((a, b) =>
    a.localeCompare(b, 'pt-BR'),
  );
  const trimmedQuery = normalized(query.trim());
  const visibleItems = items.filter((item) => {
    // Multi-select is a facet: any selected tag admits the item.
    if (selectedTags.size > 0 && !(item.tags ?? []).some((tag) => selectedTags.has(tag))) {
      return false;
    }
    if (trimmedQuery === '') return true;
    return [
      item.name,
      item.id,
      item.description ?? '',
      ...(item.tags ?? []),
      t(LIBRARY_KIND_LABEL_KEY[item.kind]),
    ].some((text) => normalized(text).includes(trimmedQuery));
  });
  const filtersActive = trimmedQuery !== '' || selectedTags.size > 0;

  const toggleTag = (tag: string): void => {
    setSelectedTags((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const removeItem = (item: LibraryItem): void => {
    setError(null);
    setRemovingId(item.id);
    void (async () => {
      try {
        await api.deleteLibraryItem(item.id);
        // libraryChanged re-runs the fetch effect, so every open panel (this
        // grid, the inspector's save form) sees the same post-delete list.
        store.libraryChanged();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRemovingId(null);
      }
    })();
  };

  return (
    <ScrollArea className="min-h-0 flex-1 p-3.5">
      {!loading && (
        <div className="media-bin-toolbar">
          {items.length > 0 && (
            <label className="media-bin-search">
              <SearchIcon aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder={t('library.searchPlaceholder')}
                aria-label={t('library.searchPlaceholder')}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                }}
              />
            </label>
          )}
          {/* The prompt embeds the current item list — offering it before the
              list loads would tell the agent the library is empty when it isn't. */}
          {error === null && (
            <div className="media-bin-toolbar-actions ml-auto">
              <AgentPromptButton
                title={t('library.agentDialogTitle')}
                description={t('library.agentDialogDescription')}
                buildPrompt={() =>
                  agentJsonPrompt(
                    LIBRARY_AGENT_PROMPT,
                    items.map((item) => ({
                      name: item.name,
                      kind: item.kind,
                      ...(item.durationS !== undefined ? { durationS: item.durationS } : {}),
                      ...(item.description !== undefined ? { description: item.description } : {}),
                      ...(item.tags !== undefined ? { tags: item.tags } : {}),
                      ...(item.template !== undefined ? { template: item.template } : {}),
                      ...(item.variables !== undefined
                        ? {
                            variables: item.variables.map((variable) => ({
                              name: variable.name,
                              default: variable.default,
                            })),
                          }
                        : {}),
                    })),
                  )
                }
              />
            </div>
          )}
        </div>
      )}
      {!loading && items.length > 0 && (
        <>
          {allTags.length > 0 && (
            <div className="library-tag-row" role="group" aria-label={t('library.tags.aria')}>
              {allTags.map((tag) => (
                <Badge key={tag} asChild variant={selectedTags.has(tag) ? 'default' : 'outline'}>
                  <button
                    type="button"
                    className={
                      selectedTags.has(tag)
                        ? 'cursor-pointer hover:bg-primary/90'
                        : 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
                    }
                    aria-pressed={selectedTags.has(tag)}
                    onClick={() => {
                      toggleTag(tag);
                    }}
                  >
                    {tag}
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
      {loading && <div className="library-empty">{t('library.loading')}</div>}
      {error !== null && <div className="modal-error">{error}</div>}
      {!loading && items.length === 0 && (
        <div className="library-empty">
          <strong>{t('library.empty.title')}</strong>
          <span>{t('library.empty.body')}</span>
        </div>
      )}
      {!loading && items.length > 0 && visibleItems.length === 0 && filtersActive && (
        <div className="library-empty">
          <span>{t('library.noMatch')}</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              setQuery('');
              setSelectedTags(new Set());
            }}
          >
            {t('library.filters.clear')}
          </Button>
        </div>
      )}
      {!loading && visibleItems.length > 0 && (
        <div className="library-grid">
          {visibleItems.map((item) => (
            <LibraryCard
              key={item.id}
              item={item}
              importing={importingId === item.id}
              removing={removingId === item.id}
              disabled={importingId !== null || removingId !== null}
              onImport={importItem}
              onRemove={removeItem}
            />
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
