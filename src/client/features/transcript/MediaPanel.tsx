import { useMemo, useRef, useState, type JSX } from 'react';
import { FolderOpenIcon, ImageIcon, ListPlusIcon, RefreshCwIcon, SearchIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '../../components/Hint.js';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api, type MediaSummary } from '../../api.js';
import { t } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { BACKGROUND_EDITOR_TRACK_KEY, PROJECT_MEDIA_DRAG_MIME } from '../../state/docEdits.js';
import { playhead } from '../../state/playhead.js';
import { useStore } from '../../state/hooks.js';
import { UI_ICON, UiIcon } from '../../components/UiIcon.js';
import { useThumbnails } from '../timeline/thumbnails.js';
import { ICON_PLUS } from './shared.js';

function formatMediaDuration(durationS: number): string {
  const rounded = Math.max(0, Math.round(durationS));
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

function MediaPreview(props: { media: MediaSummary; used: boolean }): JSX.Element {
  const previewUrl =
    props.media.kind === 'video'
      ? api.mediaUrl(props.media.proxyRelPath ?? props.media.relPath)
      : undefined;
  const previewAt =
    props.media.kind === 'image' ? 0 : Math.min(Math.max(props.media.durationS / 3, 0), 1.5);
  const thumbnails = useThumbnails(previewUrl, previewAt, previewAt + 0.05, 220);
  const thumbnail =
    props.media.kind === 'image' ? api.mediaUrl(props.media.relPath) : thumbnails[0];

  return (
    <span className={`media-bin-thumb ${props.media.kind === 'audio' ? 'is-audio' : ''}`}>
      {thumbnail ? (
        <img src={thumbnail} alt={props.media.relPath} draggable={false} />
      ) : (
        <span className="media-bin-placeholder">
          <UiIcon d={props.media.kind === 'audio' ? UI_ICON.volume : UI_ICON.media} size={20} />
          {props.media.kind === 'audio' && <span>{t('media.audio')}</span>}
        </span>
      )}
      {props.media.kind !== 'image' && (
        <span className="media-bin-duration">{formatMediaDuration(props.media.durationS)}</span>
      )}
      {props.used && <span className="media-bin-used">{t('media.used')}</span>}
    </span>
  );
}

interface MediaUploadState {
  readonly fileName: string;
  readonly index: number;
  readonly count: number;
  readonly uploadedBytes: number;
  readonly totalBytes: number;
}

function MediaCard(props: {
  readonly media: MediaSummary;
  readonly usedCount: number;
  readonly disabled: boolean;
  readonly backgroundDisabled: boolean;
  readonly onReveal: (relPath: string) => void;
}): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const { media } = props;
  const canDrag = !props.disabled && media.kind !== 'image';
  return (
    <div
      className={`media-bin-card ${dragging ? 'is-dragging' : ''} ${canDrag ? '' : 'is-static'}`}
      draggable={canDrag}
      aria-label={canDrag ? `${media.relPath}. ${t('media.dragHint')}` : media.relPath}
      onDragStart={(event) => {
        if (!canDrag) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData(PROJECT_MEDIA_DRAG_MIME, media.relPath);
        event.dataTransfer.effectAllowed = 'copy';
        const image = event.currentTarget.querySelector('img');
        if (image) event.dataTransfer.setDragImage(image, 24, 18);
        setDragging(true);
      }}
      onDragEnd={() => {
        setDragging(false);
      }}
    >
      <MediaPreview media={media} used={props.usedCount > 0} />
      <span className="media-bin-actions">
        {media.kind === 'video' && (
          <>
            <Hint label={t('media.addToSequence')}>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="media-bin-action"
                aria-label={t('media.addToSequence')}
                disabled={props.disabled}
                draggable={false}
                onClick={() => {
                  store.appendToBase(media.relPath);
                }}
              >
                <ListPlusIcon />
              </Button>
            </Hint>
            <Hint label={t('media.addAsLayer')}>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="media-bin-action"
                aria-label={t('media.addAsLayer')}
                disabled={props.disabled}
                draggable={false}
                onClick={() => {
                  store.addLayer(media.relPath, playhead.time);
                }}
              >
                <UiIcon d={UI_ICON.layers} />
              </Button>
            </Hint>
          </>
        )}
        {media.hasAudio && (
          <Hint label={t('media.addAsAudio')}>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="media-bin-action"
              aria-label={t('media.addAsAudio')}
              disabled={props.disabled}
              draggable={false}
              onClick={() => {
                store.addAudioClip(media.relPath, playhead.time);
              }}
            >
              <UiIcon d={UI_ICON.volume} />
            </Button>
          </Hint>
        )}
        {(media.kind === 'image' || media.kind === 'video') && (
          <Hint label={t('media.useAsBackground')}>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="media-bin-action"
              aria-label={t('media.useAsBackground')}
              disabled={props.disabled || props.backgroundDisabled}
              draggable={false}
              onClick={() => {
                if (media.kind === 'image') store.setBackgroundImage(media.relPath);
                else store.setBackgroundVideo(media.relPath);
                store.selectBackground();
              }}
            >
              <ImageIcon />
            </Button>
          </Hint>
        )}
        <Hint label={t('media.reveal')}>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="media-bin-action"
            aria-label={t('media.reveal')}
            draggable={false}
            onClick={() => {
              props.onReveal(media.relPath);
            }}
          >
            <FolderOpenIcon />
          </Button>
        </Hint>
      </span>
      <span className="media-bin-name" title={media.relPath}>
        {media.relPath}
      </span>
      <span className="media-bin-meta">
        {media.kind === 'video' ? (
          <>
            <span>
              {String(media.width)}×{String(media.height)}
            </span>
            <span aria-hidden="true">·</span>
            <span>{t(media.hasAudio ? 'media.withAudio' : 'media.withoutAudio')}</span>
          </>
        ) : media.kind === 'audio' ? (
          <span>{t('media.audioTrack')}</span>
        ) : (
          <span>
            {String(media.width)}×{String(media.height)}
          </span>
        )}
        {media.transcriptEngine !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span>{t('media.transcribed')}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** Project media inventory: import originals, then deliberately place them in the edit. */
export function MediaPanel(): JSX.Element {
  const state = useStore();
  const mediaItems = state.project?.media ?? [];
  const inputRef = useRef<HTMLInputElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [upload, setUpload] = useState<MediaUploadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const visibleMedia = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return mediaItems;
    return mediaItems.filter((media) => media.relPath.toLocaleLowerCase().includes(normalized));
  }, [mediaItems, query]);

  const usageByPath = useMemo(() => {
    const usage = new Map<string, number>();
    if (!state.doc) return usage;
    for (const track of state.doc.tracks) {
      if (track.kind !== 'video' && track.kind !== 'audio') continue;
      for (const block of track.blocks) {
        const path = state.doc.sources[block.source]?.path;
        if (path) usage.set(path, (usage.get(path) ?? 0) + 1);
      }
    }
    const background = state.doc.canvas?.background;
    if (background?.kind === 'image') {
      usage.set(background.file, (usage.get(background.file) ?? 0) + 1);
    } else if (background?.kind === 'video') {
      const path = state.doc.sources[background.source]?.path;
      if (path) usage.set(path, (usage.get(path) ?? 0) + 1);
    }
    return usage;
  }, [state.doc]);

  const refreshMedia = (): void => {
    setRefreshing(true);
    setError(null);
    void (async () => {
      try {
        if (!(await store.flushSave())) return;
        await store.reloadFromServer(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRefreshing(false);
      }
    })();
  };

  const revealMedia = (relPath: string): void => {
    setError(null);
    void api.revealPath(relPath).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const importMediaFiles = (files: readonly File[]): void => {
    if (files.length === 0 || upload !== null) return;
    setError(null);
    void (async () => {
      const failures: string[] = [];
      for (const [index, file] of files.entries()) {
        setUpload({
          fileName: file.name,
          index,
          count: files.length,
          uploadedBytes: 0,
          totalBytes: file.size,
        });
        try {
          const response = await api.importMedia(file, (uploadedBytes, totalBytes) => {
            setUpload((current) =>
              current?.index === index
                ? { ...current, uploadedBytes, totalBytes: totalBytes || file.size }
                : current,
            );
          });
          store.registerImportedMedia(response.item);
        } catch (cause) {
          failures.push(`${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      setUpload(null);
      if (inputRef.current) inputRef.current.value = '';
      if (failures.length > 0) setError(failures.join('\n'));
    })();
  };

  const uploadProgress =
    upload === null || upload.totalBytes <= 0
      ? 0
      : Math.min(100, Math.round((upload.uploadedBytes / upload.totalBytes) * 100));

  return (
    <ScrollArea className="min-h-0 flex-1 px-3.5 py-3">
      <div className="media-bin-toolbar">
        <label className="media-bin-search">
          <SearchIcon aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t('media.searchPlaceholder')}
            aria-label={t('media.searchPlaceholder')}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
            }}
          />
        </label>
        <div className="media-bin-toolbar-actions">
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".mp4,.mov,.m4v,.mkv,.webm,.avi,.mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus,.aif,.aiff,.png,.jpg,.jpeg,.webp"
            className="hidden"
            onChange={(event) => {
              importMediaFiles(Array.from(event.currentTarget.files ?? []));
            }}
          />
          <Button
            type="button"
            size="xs"
            className="flex-none"
            disabled={upload !== null}
            onClick={() => {
              inputRef.current?.click();
            }}
          >
            <UiIcon d={ICON_PLUS} size={12} />
            {t('media.import')}
          </Button>
          <Hint label={refreshing ? t('media.refreshing') : t('media.refresh')}>
            <Button
              type="button"
              size="icon-xs"
              variant="outline"
              className="flex-none"
              aria-label={refreshing ? t('media.refreshing') : t('media.refresh')}
              disabled={refreshing || upload !== null}
              onClick={refreshMedia}
            >
              <RefreshCwIcon className={refreshing ? 'animate-spin' : ''} />
            </Button>
          </Hint>
        </div>
      </div>

      <div className="media-bin-summary">
        <strong>
          {String(mediaItems.length)} {t(mediaItems.length === 1 ? 'media.video' : 'media.videos')}
        </strong>
        <span>{t('media.dragHint')}</span>
      </div>

      {upload !== null && (
        <div role="status" aria-live="polite" className="mt-3 rounded-md bg-secondary px-2.5 py-2">
          <div className="type-compact flex min-w-0 items-center justify-between gap-3 text-secondary-foreground">
            <span className="min-w-0 truncate">
              {t('media.importing')} {upload.fileName}
            </span>
            <span className="flex-none tabular-nums">
              {String(upload.index + 1)}/{String(upload.count)} · {String(uploadProgress)}%
            </span>
          </div>
          <progress
            aria-label={`${t('media.importing')} ${upload.fileName}`}
            className="mt-1.5 block h-1.5 w-full accent-primary"
            max={100}
            value={uploadProgress}
          />
        </div>
      )}

      {error !== null && (
        <div
          role="alert"
          className="mt-3 whitespace-pre-line rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      {mediaItems.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-1 px-6 text-center">
          <strong className="text-sm text-foreground">{t('media.empty.title')}</strong>
          <span className="type-compact max-w-xs text-muted-foreground">
            {t('media.empty.body')}
          </span>
        </div>
      ) : visibleMedia.length === 0 ? (
        <div className="library-empty">{t('media.noResults')}</div>
      ) : (
        <div className="media-bin-grid">
          {visibleMedia.map((media) => (
            <MediaCard
              key={media.relPath}
              media={media}
              usedCount={usageByPath.get(media.relPath) ?? 0}
              disabled={state.doc === null}
              backgroundDisabled={state.lockedTrackKeys.has(BACKGROUND_EDITOR_TRACK_KEY)}
              onReveal={revealMedia}
            />
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
