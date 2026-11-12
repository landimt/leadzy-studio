import { useEffect, useState, type JSX } from 'react';
import { togglePlayerFullscreen } from '../player/fullscreen.js';
import { outputDuration } from '../../../core/timeline.js';
import { DOCK_PRESETS, type DockPresetId, matchingPreset } from './dock.js';
import {
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  Clock3Icon,
  EyeIcon,
  LoaderCircleIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
} from '@/components/ui/menubar';
import { StudioDialog, StudioDialogBody } from '@/components/StudioDialog';
import logoUrl from '../../../../assets/brand/leadzy-studio-mark.svg';
import { api } from '../../api.js';
import { t, type MessageKey } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { playhead } from '../../state/playhead.js';
import { usePlayheadTime, useStore } from '../../state/hooks.js';
import { applyTheme, nextTheme, readTheme, type StudioTheme } from '../../theme/theme.js';
import { requestSpeedTool, requestSuggestionsTool } from './toolEvents.js';
import { AgentPromptButton } from '../agent/AgentPrompt.js';
import { buildAgentSetupPrompt, desktopBridge, type IntegrationStatus } from '../../lib/desktop.js';
import { isPristineProject } from '../../state/pristineProject.js';
import { formatEditorDuration } from './statusFormat.js';
import { basename } from '../inspector/basename.js';

const LAYOUT_LABEL: Record<DockPresetId, MessageKey> = {
  default: 'menu.view.layout.default',
  compact: 'menu.view.layout.compact',
  vertical: 'menu.view.layout.vertical',
  landscape: 'menu.view.layout.landscape',
};

interface MenuAction {
  readonly label: string;
  readonly shortcut?: readonly string[];
  readonly title?: string;
  readonly disabled?: boolean;
  readonly run?: () => void;
  /** A submenu: the entry opens these instead of running. */
  readonly children?: readonly MenuAction[];
}

type MenuEntry = MenuAction | 'separator';

/** Editor-style menu bar — every action here also exists as a shortcut or button. */
export function MenuBar(): JSX.Element {
  const state = useStore();
  const time = usePlayheadTime();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [systemChecksOpen, setSystemChecksOpen] = useState(false);
  const [theme, setTheme] = useState<StudioTheme>(() => readTheme());
  const [launcherIntegration, setLauncherIntegration] = useState<IntegrationStatus | null>(null);
  const renderRunning = state.activeJobs.has('render');
  const activePreset = matchingPreset(state.dockLayout);
  const ffmpeg = state.project?.ffmpeg;
  const agents = state.project?.agents;
  const launcher = desktopBridge();

  // The launcher knows the real bridge path (absolute, even off-PATH); fetch it
  // once so the setup prompt can be built synchronously on click.
  useEffect(() => {
    if (launcher === null) return;
    let cancelled = false;
    void launcher
      .getLauncherState()
      .then((result) => {
        if (!cancelled) setLauncherIntegration(result.integration);
      })
      // Without the real bridge path the prompt falls back to a bare `studio`,
      // which may not be on PATH — the user must know the fetch failed.
      .catch((error: unknown) => {
        store.showError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [launcher]);

  const buildSetupPrompt = (): string => {
    const fallback: IntegrationStatus = {
      bridgePath: 'studio',
      bridgeOnPath: true,
      ffmpeg: ffmpeg?.ok === true,
      ffprobe: ffmpeg?.ok === true,
      agents: {
        claude: { binaryPath: agents?.claude ? 'claude' : null, skillInstalled: false },
        codex: { binaryPath: agents?.codex ? 'codex' : null, skillInstalled: false },
      },
    };
    return buildAgentSetupPrompt(state.project?.projectDir ?? '', launcherIntegration ?? fallback);
  };

  // The setup prompt earns its label only before any shaping: block counts are
  // reversible, so the in-session signals keep the label from reappearing.
  const pristineProject =
    state.undoDepth === 0 && !state.agentEdited && isPristineProject(state.doc);

  /** Flush any pending autosave before a job reads edit.json, then start it. Reports whether the job actually started (POST resolved), so a caller can gate follow-up state on it. */
  const job = async (start: () => Promise<{ id: number }>): Promise<boolean> => {
    if (!(await store.flushSave())) return false;
    try {
      await start();
      return true;
    } catch (error) {
      store.showError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  /**
   * Marks the render as user-requested only once the POST actually started it —
   * marking it up front would leak past a failed/rejected request (flushSave
   * declining, or startRender throwing) with no job ever created and so no
   * 'error' event to consume the flag, leaking it into a later unrelated
   * preview (even the silent auto-preview).
   */
  const startPreviewRender = async (): Promise<void> => {
    const started = await job(() => api.startRender({ preview: true }));
    if (started) store.requestPreviewRender();
  };

  const reviewPreview = (): void => {
    if (state.project?.hasPreview === true && !state.previewOutdated) {
      store.setPreviewViewerOpen(true);
      return;
    }
    void startPreviewRender();
  };

  const saveState = state.conflict
    ? 'conflict'
    : state.saving
      ? 'saving'
      : state.dirty
        ? 'pending'
        : 'saved';
  const saveLabel =
    saveState === 'conflict'
      ? t('topbar.save.conflict')
      : saveState === 'saving'
        ? t('topbar.save.saving')
        : saveState === 'pending'
          ? t('topbar.save.pending')
          : t('topbar.save.saved');
  const previewReady = state.project?.hasPreview === true && !state.previewOutdated;

  const menus: Record<string, { readonly label: string; readonly entries: MenuEntry[] }> = {
    project: {
      label: t('menu.project'),
      entries: [
        ...(launcher
          ? ([
              {
                label: t('menu.project.home'),
                run: () => {
                  void store.flushSave().then((saved) => {
                    if (saved) void launcher.showHome();
                  });
                },
              },
              'separator',
            ] satisfies MenuEntry[])
          : []),
        {
          label: t('menu.project.renderPreview'),
          disabled: renderRunning,
          run: () => {
            reviewPreview();
          },
        },
        {
          label: t('menu.project.export'),
          disabled: renderRunning,
          run: () => {
            store.setExportOpen(true);
          },
        },
        {
          label: t('menu.project.reveal'),
          run: () => {
            // revealing `edit/` selects it inside the project folder
            void api.revealPath('edit').catch((cause: unknown) => {
              store.showError(cause instanceof Error ? cause.message : String(cause));
            });
          },
        },
        'separator',
        {
          label: t('menu.project.settings'),
          shortcut: ['⌘', ','],
          run: () => {
            store.setSettingsOpen(true);
          },
        },
      ],
    },
    edit: {
      label: t('menu.edit'),
      entries: [
        {
          label: t('menu.edit.undo'),
          shortcut: ['⌘', 'Z'],
          disabled: state.undoDepth === 0,
          run: () => {
            store.undo();
          },
        },
        {
          label: t('menu.edit.redo'),
          shortcut: ['⇧', '⌘', 'Z'],
          disabled: state.redoDepth === 0,
          run: () => {
            store.redo();
          },
        },
        {
          label: t('menu.edit.history'),
          run: () => {
            store.setHistoryOpen(true);
          },
        },
        'separator',
        {
          label: t('menu.edit.split'),
          shortcut: ['S'],
          run: () => {
            store.splitAtPlayhead(time);
          },
        },
        {
          label: t('menu.edit.trimLeft'),
          shortcut: ['Q'],
          run: () => {
            store.trimAtPlayhead('left', time);
          },
        },
        {
          label: t('menu.edit.trimRight'),
          shortcut: ['W'],
          run: () => {
            store.trimAtPlayhead('right', time);
          },
        },
        {
          label: t('menu.edit.deleteBlock'),
          shortcut: ['⌫'],
          disabled: state.selection === null,
          run: () => {
            store.deleteSelectedBlock();
          },
        },
      ],
    },
    tools: {
      label: t('menu.tools'),
      entries: [
        {
          label: t('menu.tools.transcribe'),
          run: () => {
            store.setTranscriptionOpen(true);
          },
        },
        {
          label: t('menu.tools.suggest'),
          run: requestSuggestionsTool,
        },
        'separator',
        {
          label: t('menu.tools.audio'),
          run: () => {
            store.setAudioOpen(true);
          },
        },
        {
          label: t('menu.tools.speed'),
          run: requestSpeedTool,
        },
      ],
    },
    view: {
      label: t('menu.view'),
      entries: [
        {
          label: t('menu.view.goToStart'),
          shortcut: ['Home'],
          run: () => {
            playhead.seek(0);
          },
        },
        {
          label: t('menu.view.goToEnd'),
          shortcut: ['End'],
          run: () => {
            if (state.doc) playhead.seek(outputDuration(state.doc));
          },
        },
        {
          label: t('menu.view.playPause'),
          shortcut: ['Espaço'],
          run: () => {
            playhead.setPlaying(!playhead.playing);
          },
        },
        {
          label: t('menu.view.fullscreen'),
          shortcut: ['F'],
          run: togglePlayerFullscreen,
        },
        'separator',
        {
          label: t('menu.view.layout'),
          children: DOCK_PRESETS.map((preset) => ({
            label: `${activePreset === preset ? '✓ ' : ''}${t(LAYOUT_LABEL[preset])}`,
            run: () => {
              store.applyDockPreset(preset);
            },
          })),
        },
        'separator',
        {
          label: theme === 'dark' ? t('menu.view.lightTheme') : t('menu.view.darkTheme'),
          run: () => {
            const next = nextTheme(theme);
            applyTheme(next);
            setTheme(next);
          },
        },
      ],
    },
    help: {
      label: t('menu.help'),
      entries: [
        {
          label: t('menu.help.shortcuts'),
          run: () => {
            setShortcutsOpen(true);
          },
        },
        {
          label: t('menu.help.systemChecks'),
          run: () => {
            setSystemChecksOpen(true);
          },
        },
        'separator',
        {
          label: state.debugOpen ? `✓ ${t('menu.view.debug')}` : t('menu.view.debug'),
          title: t('menu.view.debug.title'),
          run: () => {
            store.setDebugOpen(!state.debugOpen);
          },
        },
        'separator',
        { label: `Leadzy Studio v${__APP_VERSION__}`, disabled: true },
      ],
    },
  };

  return (
    <div className="menubar">
      <img className="brand-logo" src={logoUrl} alt="Leadzy" />
      <Menubar className="h-auto border-none bg-transparent p-0 shadow-none">
        {Object.entries(menus).map(([name, menu]) => (
          <MenubarMenu key={name}>
            <MenubarTrigger className="h-6.5 border-0 bg-transparent px-1.5 text-xs">
              {menu.label}
            </MenubarTrigger>
            <MenubarContent className="rounded-lg">
              {menu.entries.map((entry, i) =>
                entry === 'separator' ? (
                  <MenubarSeparator key={i} />
                ) : entry.children ? (
                  <MenubarSub key={entry.label}>
                    <MenubarSubTrigger className="py-1 text-xs">{entry.label}</MenubarSubTrigger>
                    <MenubarSubContent>
                      {entry.children.map((child) => (
                        <MenubarItem
                          key={child.label}
                          disabled={child.disabled ?? false}
                          className="py-1 text-xs focus:bg-primary focus:text-primary-foreground"
                          onSelect={() => {
                            child.run?.();
                          }}
                        >
                          {child.label}
                        </MenubarItem>
                      ))}
                    </MenubarSubContent>
                  </MenubarSub>
                ) : (
                  <MenubarItem
                    key={entry.label}
                    disabled={entry.disabled ?? false}
                    title={entry.title ?? ''}
                    className="py-1 text-xs focus:bg-primary focus:text-primary-foreground"
                    onSelect={() => {
                      entry.run?.();
                    }}
                  >
                    <span>{entry.label}</span>
                    {entry.shortcut && (
                      <MenubarShortcut>
                        <KbdGroup>
                          {entry.shortcut.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </KbdGroup>
                      </MenubarShortcut>
                    )}
                  </MenubarItem>
                ),
              )}
            </MenubarContent>
          </MenubarMenu>
        ))}
      </Menubar>
      <span className="mb-project">
        {state.project ? basename(state.project.projectDir) : undefined}
      </span>
      <span style={{ flex: 1 }} />
      <div className="editor-status" role="status" aria-live="polite">
        <span className={`editor-save-state is-${saveState}`}>
          {saveState === 'saving' ? (
            <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />
          ) : saveState !== 'saved' ? (
            <span className="editor-save-dot" aria-hidden="true" />
          ) : null}
          {saveLabel}
        </span>
        <span
          className="editor-duration"
          title={`${t('topbar.duration')}: ${state.doc?.totalDurationS?.toFixed(1) ?? '–'}s`}
        >
          <Clock3Icon className="size-3" aria-hidden="true" />
          {formatEditorDuration(state.doc?.totalDurationS)}
        </span>
      </div>
      <Separator orientation="vertical" className="mx-1 h-4" />
      <AgentPromptButton
        title={t('agentSetup.title')}
        description={t('agentSetup.description')}
        buildPrompt={buildSetupPrompt}
        {...(pristineProject ? { label: t('agentSetup.action') } : {})}
      />
      <Button
        size="sm"
        variant="outline"
        className="relative gap-1.5"
        disabled={renderRunning}
        title={previewReady ? t('review.preview.watch') : t('review.preview.generate')}
        aria-label={previewReady ? t('review.preview.watch') : t('review.preview.generate')}
        onClick={reviewPreview}
      >
        {renderRunning ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <EyeIcon className="size-3.5" aria-hidden="true" />
        )}
        {t('topbar.review')}
        {!previewReady && !renderRunning && (
          <span
            aria-hidden="true"
            className="absolute -top-0.75 -right-0.75 size-1.75 rounded-full bg-warning"
          />
        )}
      </Button>
      <Button
        size="sm"
        disabled={renderRunning}
        onClick={() => {
          store.setExportOpen(true);
        }}
      >
        {t('topbar.render')}
      </Button>
      <StudioDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        title={t('menu.help.shortcuts')}
        size="md"
      >
        <StudioDialogBody maxHeight={360}>
          <table className="shortcuts">
            <tbody>
              <tr>
                <td>
                  <Kbd>Espaço</Kbd>
                </td>
                <td>tocar / pausar</td>
              </tr>
              <tr>
                <td>
                  <Kbd>Home</Kbd>
                </td>
                <td>vai para o início</td>
              </tr>
              <tr>
                <td>
                  <Kbd>End</Kbd>
                </td>
                <td>vai para o fim</td>
              </tr>
              <tr>
                <td>
                  <Kbd>←</Kbd> <Kbd>→</Kbd>
                </td>
                <td>avança / recua o cursor (0,05s; shift: 1s)</td>
              </tr>
              <tr>
                <td>
                  <Kbd>S</Kbd>
                </td>
                <td>dividir o bloco no cursor</td>
              </tr>
              <tr>
                <td>
                  <Kbd>Q</Kbd>
                </td>
                <td>apara a borda esquerda do bloco no cursor</td>
              </tr>
              <tr>
                <td>
                  <Kbd>W</Kbd>
                </td>
                <td>apara a borda direita do bloco no cursor</td>
              </tr>
              <tr>
                <td>
                  <Kbd>⌫</Kbd>
                </td>
                <td>remover bloco selecionado</td>
              </tr>
              <tr>
                <td>
                  <KbdGroup>
                    <Kbd>⌘</Kbd>
                    <Kbd>Z</Kbd>
                  </KbdGroup>{' '}
                  /{' '}
                  <KbdGroup>
                    <Kbd>⇧</Kbd>
                    <Kbd>⌘</Kbd>
                    <Kbd>Z</Kbd>
                  </KbdGroup>
                </td>
                <td>desfazer / refazer</td>
              </tr>
              <tr>
                <td>
                  <Kbd>⌘</Kbd>+scroll
                </td>
                <td>zoom na timeline</td>
              </tr>
              <tr>
                <td>
                  <Kbd>Alt</Kbd>+arrastar borda
                </td>
                <td>ignora o snap em palavra</td>
              </tr>
              <tr>
                <td>duplo clique (aba Final)</td>
                <td>vai até a palavra no vídeo de origem</td>
              </tr>
              <tr>
                <td>duplo clique (aba do vídeo)</td>
                <td>corta a palavra</td>
              </tr>
              <tr>
                <td>arrastar palavras</td>
                <td>corta o trecho</td>
              </tr>
              <tr>
                <td>clique em palavra riscada</td>
                <td>restaura</td>
              </tr>
              <tr>
                <td>botão direito no bloco</td>
                <td>menu de edição</td>
              </tr>
              <tr>
                <td>botão direito na legenda</td>
                <td>tamanho e estilo da legenda</td>
              </tr>
              <tr>
                <td>arrastar legenda / PiP</td>
                <td>reposiciona (vai pro render)</td>
              </tr>
            </tbody>
          </table>
        </StudioDialogBody>
      </StudioDialog>
      <StudioDialog
        open={systemChecksOpen}
        onOpenChange={setSystemChecksOpen}
        title={t('systemChecks.title')}
        description={t('systemChecks.description')}
        size="sm"
      >
        <StudioDialogBody className="gap-0 overflow-hidden rounded-lg border border-border/80">
          <div className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-border/70 px-3 py-2.5">
            {ffmpeg?.ok === true ? (
              <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />
            ) : ffmpeg?.ok === false ? (
              <CircleXIcon className="size-4 text-destructive" aria-hidden="true" />
            ) : (
              <CircleMinusIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
            <strong className="font-medium">FFmpeg</strong>
            <span
              className={
                ffmpeg?.ok === true
                  ? 'text-success'
                  : ffmpeg?.ok === false
                    ? 'text-destructive'
                    : 'text-muted-foreground'
              }
            >
              {ffmpeg?.ok === true
                ? t('systemChecks.available')
                : ffmpeg?.ok === false
                  ? t('systemChecks.problem')
                  : t('systemChecks.checking')}
            </span>
            {ffmpeg?.message && (
              <span className="col-start-2 col-end-4 mt-1 text-[10px] leading-4 text-muted-foreground">
                {ffmpeg.message}
              </span>
            )}
          </div>
          {(
            [
              ['Claude Code', agents?.claude === true],
              ['Codex', agents?.codex === true],
            ] as const
          ).map(([label, available], index) => (
            <div
              key={label}
              className={`grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-2.5 ${index === 0 ? 'border-b border-border/70' : ''}`}
            >
              {available ? (
                <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />
              ) : (
                <CircleMinusIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              )}
              <strong className="font-medium">{label}</strong>
              <span className={available ? 'text-success' : 'text-muted-foreground'}>
                {available ? t('systemChecks.available') : t('systemChecks.notDetected')}
              </span>
            </div>
          ))}
        </StudioDialogBody>
      </StudioDialog>
    </div>
  );
}
