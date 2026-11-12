import { useEffect, useState, type JSX } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { api, LIBRARY_ITEM_KINDS, type LibraryItemKind } from '../../api.js';
import { LIBRARY_KIND_LABEL_KEY, t } from '../../i18n/index.js';
import { type OverlayBlock } from '../../../core/schema.js';
import { store } from '../../state/store.js';

export function OverlayDurationControl(props: {
  trackId: string;
  blockIndex: number;
  block: OverlayBlock;
}): JSX.Element {
  const value = props.block.duration ?? 2;
  return (
    <div className="effect-control">
      <div className="effect-control-label">
        <label>{t('inspector.overlay.duration')}</label>
        <output>{value.toFixed(1)}s</output>
      </div>
      <Slider
        min={0.5}
        max={Math.max(20, value)}
        step={0.1}
        value={[value]}
        aria-label={t('inspector.overlay.duration')}
        onValueChange={([next]) => {
          if (next === undefined) return;
          store.updateOverlayBlock(
            props.trackId,
            props.blockIndex,
            { duration: next },
            `overlay-duration:${props.trackId}:${String(props.blockIndex)}`,
          );
        }}
      />
    </div>
  );
}

/** Inline "save to library" affordance for an overlay block — a toggle button that expands into a name+kind mini-form. */
export function SaveToLibraryControl(props: {
  file: string;
  prefillName: string;
  defaultKind: LibraryItemKind;
  durationS?: number | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(props.prefillName);
  const [kind, setKind] = useState<LibraryItemKind>(props.defaultKind);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => {
      setSaved(false);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [saved]);

  const trimmedName = name.trim();
  const confirm = (): void => {
    if (!trimmedName || saving) return;
    setSaving(true);
    void api
      .saveToLibrary({
        file: props.file,
        name: trimmedName,
        kind,
        ...(props.durationS !== undefined ? { durationS: props.durationS } : {}),
      })
      .then(() => {
        setSaving(false);
        setOpen(false);
        setSaved(true);
        store.libraryChanged();
      })
      .catch((cause: unknown) => {
        setSaving(false);
        store.showError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  if (saved) return <div className="library-save-done">{t('inspector.library.saved')}</div>;

  if (!open)
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          setName(props.prefillName);
          setKind(props.defaultKind);
          setOpen(true);
        }}
      >
        {t('inspector.library.save')}
      </Button>
    );

  return (
    <div className="library-save-form">
      <Input
        type="text"
        value={name}
        placeholder={t('inspector.library.namePlaceholder')}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <Select
        value={kind}
        onValueChange={(next) => {
          setKind(next as LibraryItemKind);
        }}
      >
        <SelectTrigger aria-label={t('inspector.library.kindLabel')} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LIBRARY_ITEM_KINDS.map((k) => (
            <SelectItem key={k} value={k}>
              {t(LIBRARY_KIND_LABEL_KEY[k])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="library-save-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => {
            setOpen(false);
          }}
        >
          {t('common.cancel')}
        </Button>
        <Button type="button" size="sm" disabled={saving || !trimmedName} onClick={confirm}>
          {saving ? t('inspector.library.saving') : t('inspector.library.confirm')}
        </Button>
      </div>
    </div>
  );
}
