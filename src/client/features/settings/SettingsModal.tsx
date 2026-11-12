import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { CheckCircle2Icon, CircleAlertIcon, FolderOpenIcon, RotateCwIcon } from 'lucide-react';
import { api, type SettingsInfo, type SettingsPreferences } from '../../api.js';
import { UI_ICON, UiIcon } from '../../components/UiIcon.js';
import { desktopBridge } from '../../lib/desktop.js';
import { t } from '../../i18n/index.js';
import { useStore } from '../../state/hooks.js';
import { store } from '../../state/store.js';
import {
  StudioDialog,
  StudioDialogBody,
  StudioDialogError,
  StudioDialogFooter,
} from '@/components/StudioDialog';
import { PanelTabsList, PanelTabsTrigger } from '@/components/PanelTabs';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent } from '@/components/ui/tabs';

const SETTINGS_CHANGED_EVENT = 'leadzy:settings-changed';

type SettingsSection = 'general' | 'export' | 'transcription' | 'system' | 'storage';

const SECTIONS: readonly { readonly id: SettingsSection; readonly label: string }[] = [
  { id: 'general', label: t('settings.nav.general') },
  { id: 'export', label: t('settings.nav.export') },
  { id: 'transcription', label: t('settings.nav.transcription') },
  { id: 'system', label: t('settings.nav.system') },
  { id: 'storage', label: t('settings.nav.storage') },
];

/** Same bordered section used by Exportar: title strip, then compact divided rows. */
function SettingsGroup({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-[10px] border border-border bg-muted/15">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            {title}
          </h3>
          {description ? (
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

function PreferenceRow({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="grid min-h-11 grid-cols-[168px_minmax(0,1fr)] items-center gap-4 px-3 py-2">
      <div className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        {detail ? (
          <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{detail}</span>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function FolderField({
  value,
  placeholder,
  title,
  onChange,
}: {
  value: string | null;
  placeholder: string;
  title: string;
  onChange: (value: string | null) => void;
}): JSX.Element {
  const bridge = desktopBridge();
  return (
    <div className="flex min-w-0 gap-2">
      <Input
        className="h-8 min-w-0 flex-1 font-mono text-xs md:text-xs"
        value={value ?? ''}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value.trimStart() || null);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="lg"
        disabled={bridge === null}
        title={bridge === null ? 'O seletor nativo está disponível no aplicativo desktop.' : title}
        onClick={() => {
          if (bridge === null) return;
          void bridge
            .chooseDirectory({ title, ...(value ? { defaultPath: value } : {}) })
            .then((path) => {
              if (path) onChange(path);
            });
        }}
      >
        <FolderOpenIcon />
        {value ? t('settings.change') : t('settings.choose')}
      </Button>
    </div>
  );
}

function ToolStatus({
  name,
  detail,
  ready,
  message,
}: {
  name: string;
  detail: string;
  ready: boolean;
  message?: string | undefined;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-2.5">
      {ready ? (
        <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
      ) : (
        <CircleAlertIcon className="size-4 text-warning" aria-hidden="true" />
      )}
      <div className="min-w-0">
        <strong className="block text-xs font-medium">{name}</strong>
        <span className="block text-[10px] text-muted-foreground">{detail}</span>
        {message ? (
          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{message}</span>
        ) : null}
      </div>
      <span className={ready ? 'text-[10px] text-success' : 'text-[10px] text-warning'}>
        {ready ? t('settings.system.ready') : t('settings.system.missing')}
      </span>
    </div>
  );
}

/** Global machine preferences. Project-specific edit choices remain in edit.json. */
export function SettingsModal(): JSX.Element {
  const state = useStore();
  const [section, setSection] = useState<SettingsSection>('general');
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [draft, setDraft] = useState<SettingsPreferences | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = desktopBridge();

  const load = (): void => {
    setError(null);
    api
      .getSettings()
      .then((next) => {
        setInfo(next);
        setDraft(next.preferences);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  useEffect(() => {
    if (!state.settingsOpen) return;
    setSection('general');
    setKeyDraft('');
    setRevealed(false);
    setInfo(null);
    setDraft(null);
    load();
  }, [state.settingsOpen]);

  const dirty = useMemo(
    () =>
      keyDraft.trim().length > 0 ||
      (info !== null &&
        draft !== null &&
        JSON.stringify(info.preferences) !== JSON.stringify(draft)),
    [draft, info, keyDraft],
  );

  const close = (): void => {
    if (busy) return;
    store.setSettingsOpen(false);
  };

  const save = (): void => {
    if (draft === null) return;
    if (draft.exportMode === 'folder' && !draft.exportDirectory) {
      setSection('export');
      setError('Escolha a pasta usada para as entregas ou altere o destino padrão.');
      return;
    }
    const pattern = draft.exportFilenamePattern.trim();
    if (!pattern) {
      setSection('export');
      setError('Defina um nome para o arquivo exportado.');
      return;
    }
    const key = keyDraft.trim();
    if (key.length > 0 && key.length < 8) {
      setSection('transcription');
      setError('A chave da ElevenLabs precisa ter pelo menos 8 caracteres.');
      return;
    }
    setBusy(true);
    setError(null);
    api
      .saveSettings({
        preferences: { ...draft, exportFilenamePattern: pattern },
        ...(key.length > 0 ? { elevenLabsApiKey: key } : {}),
      })
      .then((next) => {
        const localeChanged = info?.preferences.locale !== next.preferences.locale;
        setInfo(next);
        setDraft(next.preferences);
        setKeyDraft('');
        store.patchApiKeyPresent(next.elevenLabs.present);
        window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
        if (localeChanged) window.location.reload();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const removeKey = (): void => {
    setBusy(true);
    setError(null);
    api
      .saveSettings({ elevenLabsApiKey: null })
      .then((next) => {
        setInfo(next);
        setDraft(next.preferences);
        setKeyDraft('');
        store.patchApiKeyPresent(next.elevenLabs.present);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const patch = (next: Partial<SettingsPreferences>): void => {
    setDraft((current) => (current ? { ...current, ...next } : current));
  };

  const elevenLabs = info?.elevenLabs;
  const statusLine = !elevenLabs
    ? '…'
    : !elevenLabs.present
      ? t('settings.elevenLabs.absent')
      : `${t('settings.elevenLabs.active')} ${elevenLabs.maskedTail ?? ''} · ${
          elevenLabs.source === 'env'
            ? t('settings.elevenLabs.sourceEnv')
            : t('settings.elevenLabs.sourceConfig')
        }`;

  return (
    <StudioDialog
      open={state.settingsOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('settings.title')}
      description={t('settings.description')}
      size="lg"
      className="flex h-[480px] max-h-[calc(100vh-24px)] flex-col sm:max-w-[620px]"
    >
      <Tabs
        value={section}
        onValueChange={(value) => {
          setSection(value as SettingsSection);
          setError(null);
        }}
        className="min-h-0 flex-1 gap-3"
      >
        <PanelTabsList>
          {SECTIONS.map((item) => (
            <PanelTabsTrigger key={item.id} value={item.id}>
              {item.label}
            </PanelTabsTrigger>
          ))}
        </PanelTabsList>

        <StudioDialogBody maxHeight={330}>
          {draft === null || info === null ? (
            <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
              {t('settings.loading')}
            </div>
          ) : (
            <>
              <TabsContent value="general">
                <div className="space-y-3">
                  <SettingsGroup
                    title={t('settings.general.title')}
                    description={t('settings.general.description')}
                  >
                    <PreferenceRow label={t('settings.general.projectFolder')}>
                      <FolderField
                        value={draft.defaultProjectDir}
                        placeholder={t('settings.general.projectFolder.empty')}
                        title={t('settings.general.projectFolder')}
                        onChange={(value) => {
                          patch({ defaultProjectDir: value });
                        }}
                      />
                    </PreferenceRow>
                  </SettingsGroup>

                  <SettingsGroup
                    title={t('settings.language.title')}
                    description={t('settings.language.description')}
                  >
                    <PreferenceRow label={t('settings.language.label')}>
                      <Select
                        value={draft.locale}
                        onValueChange={(value) => {
                          patch({ locale: value as SettingsPreferences['locale'] });
                        }}
                      >
                        <SelectTrigger size="sm" className="!h-8 w-full bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pt-BR" className="text-xs">
                            {t('settings.language.pt')}
                          </SelectItem>
                          <SelectItem value="en" className="text-xs">
                            {t('settings.language.en')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </PreferenceRow>
                  </SettingsGroup>
                </div>
              </TabsContent>

              <TabsContent value="export">
                <SettingsGroup
                  title={t('settings.export.title')}
                  description={t('settings.export.description')}
                >
                  <PreferenceRow label={t('settings.export.mode')}>
                    <Select
                      value={draft.exportMode}
                      onValueChange={(value) => {
                        patch({ exportMode: value as SettingsPreferences['exportMode'] });
                      }}
                    >
                      <SelectTrigger size="sm" className="!h-8 w-full bg-background">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="project" className="text-xs">
                          {t('settings.export.mode.project')}
                        </SelectItem>
                        <SelectItem value="folder" className="text-xs">
                          {t('settings.export.mode.folder')}
                        </SelectItem>
                        <SelectItem value="ask" className="text-xs">
                          {t('settings.export.mode.ask')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </PreferenceRow>
                  {draft.exportMode === 'folder' && (
                    <PreferenceRow label={t('settings.export.folder')}>
                      <FolderField
                        value={draft.exportDirectory}
                        placeholder={t('settings.export.folder.empty')}
                        title={t('settings.export.folder')}
                        onChange={(value) => {
                          patch({ exportDirectory: value });
                        }}
                      />
                    </PreferenceRow>
                  )}
                  <PreferenceRow
                    label={t('settings.export.filename')}
                    detail={t('settings.export.filename.hint')}
                  >
                    <div className="flex items-center">
                      <Input
                        className="h-8 rounded-r-none font-mono text-xs md:text-xs"
                        value={draft.exportFilenamePattern}
                        spellCheck={false}
                        maxLength={120}
                        onChange={(event) => {
                          patch({ exportFilenamePattern: event.target.value });
                        }}
                      />
                      <span className="flex h-8 items-center rounded-r-md border border-l-0 border-input bg-muted/40 px-2 font-mono text-xs text-muted-foreground">
                        .mp4
                      </span>
                    </div>
                  </PreferenceRow>
                  <PreferenceRow label={t('settings.export.reveal')}>
                    <Checkbox
                      checked={draft.revealAfterExport}
                      onCheckedChange={(checked) => {
                        patch({ revealAfterExport: checked === true });
                      }}
                    />
                  </PreferenceRow>
                </SettingsGroup>
              </TabsContent>

              <TabsContent value="transcription" className="space-y-3">
                <SettingsGroup
                  title={t('settings.elevenLabs.title')}
                  description={t('settings.elevenLabs.whatFor')}
                >
                  <div className="px-3 py-2.5">
                    <p className="font-mono text-[10px] text-muted-foreground">{statusLine}</p>
                    {elevenLabs?.source === 'env' && (
                      <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                        {elevenLabs.configured
                          ? t('settings.elevenLabs.shadowedHint')
                          : t('settings.elevenLabs.envHint')}
                      </p>
                    )}
                    <div className="mt-2 flex gap-2">
                      <div className="relative min-w-0 flex-1">
                        <Label htmlFor="settings-elevenlabs-key" className="sr-only">
                          {t('settings.elevenLabs.title')}
                        </Label>
                        <Input
                          id="settings-elevenlabs-key"
                          className="h-8 pr-9 font-mono text-xs md:text-xs"
                          type={revealed ? 'text' : 'password'}
                          placeholder={t('settings.elevenLabs.placeholder')}
                          value={keyDraft}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) => {
                            setKeyDraft(event.target.value);
                          }}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-lg"
                          className="absolute top-0 right-0"
                          aria-label={revealed ? t('settings.hide') : t('settings.reveal')}
                          title={revealed ? t('settings.hide') : t('settings.reveal')}
                          onClick={() => {
                            setRevealed(!revealed);
                          }}
                        >
                          <UiIcon d={revealed ? UI_ICON.eyeOff : UI_ICON.eye} />
                        </Button>
                      </div>
                      {elevenLabs?.configured && (
                        <Button
                          type="button"
                          variant="outline"
                          size="lg"
                          disabled={busy}
                          onClick={removeKey}
                        >
                          {t('settings.elevenLabs.remove')}
                        </Button>
                      )}
                    </div>
                  </div>
                </SettingsGroup>
              </TabsContent>

              <TabsContent value="system">
                <SettingsGroup
                  title={t('settings.system.title')}
                  description={t('settings.system.description')}
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        api
                          .getSettings()
                          .then(setInfo)
                          .catch((cause: unknown) => {
                            setError(cause instanceof Error ? cause.message : String(cause));
                          });
                      }}
                    >
                      <RotateCwIcon />
                      {t('settings.system.refresh')}
                    </Button>
                  }
                >
                  <ToolStatus
                    name="FFmpeg"
                    detail={t('settings.system.ffmpeg.detail')}
                    ready={state.project?.ffmpeg.ok === true}
                    message={state.project?.ffmpeg.message}
                  />
                  <ToolStatus
                    name="HyperFrames"
                    detail={t('settings.system.hyperframes.detail')}
                    ready={info.tools.hyperframes.ok}
                    message={info.tools.hyperframes.message}
                  />
                  <ToolStatus
                    name="Codex"
                    detail={t('settings.system.agent.detail')}
                    ready={state.project?.agents.codex === true}
                  />
                  <ToolStatus
                    name="Claude Code"
                    detail={t('settings.system.agent.detail')}
                    ready={state.project?.agents.claude === true}
                  />
                </SettingsGroup>
              </TabsContent>

              <TabsContent value="storage">
                <SettingsGroup
                  title={t('settings.storage.title')}
                  description={t('settings.storage.description')}
                >
                  <PreferenceRow
                    label={t('settings.storage.library')}
                    detail="~/.leadzy-studio/library"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      disabled={bridge === null}
                      onClick={() => void bridge?.revealUserData('library')}
                    >
                      <FolderOpenIcon />
                      {t('settings.storage.open')}
                    </Button>
                  </PreferenceRow>
                  <PreferenceRow label={t('settings.storage.config')} detail="~/.leadzy-studio">
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      disabled={bridge === null}
                      onClick={() => void bridge?.revealUserData('config')}
                    >
                      <FolderOpenIcon />
                      {t('settings.storage.open')}
                    </Button>
                  </PreferenceRow>
                  <PreferenceRow
                    label={t('settings.storage.cache')}
                    detail={t('settings.storage.cache.detail')}
                  >
                    <span className="font-mono text-[10px] text-muted-foreground">edit/cache/</span>
                  </PreferenceRow>
                </SettingsGroup>
              </TabsContent>
            </>
          )}
        </StudioDialogBody>
      </Tabs>

      <StudioDialogError>{error}</StudioDialogError>
      <StudioDialogFooter>
        <Button type="button" variant="outline" size="lg" disabled={busy} onClick={close}>
          {t('settings.cancel')}
        </Button>
        <Button type="button" size="lg" disabled={busy || !dirty} onClick={save}>
          {busy ? t('settings.saving') : t('settings.save')}
        </Button>
      </StudioDialogFooter>
    </StudioDialog>
  );
}
