import { useEffect, useRef, useState, type JSX } from 'react';
import { togglePlayerFullscreen } from './features/player/fullscreen.js';
import { TooltipProvider } from '@/components/ui/tooltip';
import { t } from './i18n/index.js';
import { outputDuration } from '../core/timeline.js';
import { api } from './api.js';
import { store } from './state/store.js';
import { type StoreState } from './state/storeState.js';
import { playhead } from './state/playhead.js';
import { useStore } from './state/hooks.js';
import { matchingPreset } from './features/shell/dock.js';
import { DockArea } from './features/shell/DockArea.js';
import { StatusBar } from './features/shell/TopBar.js';
import { MenuBar } from './features/shell/MenuBar.js';
import { StartupScreen } from './features/startup/StartupScreen.js';
import { HomeScreen } from './features/home/HomeScreen.js';
import { canStartAutoPreview, startAutoPreviewAfterSave } from './features/export/autoPreview.js';
import { desktopBridge, isLauncherMode } from './lib/desktop.js';
import { isLauncherPreview, previewDesktopBridge } from './lib/desktopPreview.js';
import { onSuggestionsToolRequest } from './features/shell/toolEvents.js';
import { resolveEditorShortcut } from './features/shell/keyboardShortcuts.js';

// reads playhead.time imperatively: subscribing here would re-render the whole app at 60fps
function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.defaultPrevented ||
        target?.closest(
          'input, textarea, select, button, a, [role="tablist"], [role="dialog"], [role="alertdialog"], [role="slider"], [role="menu"], [role="listbox"], [contenteditable]',
        )
      ) {
        return;
      }
      if (event.key === 'Alt') store.setSnapDisabled(true);
      const shortcut = resolveEditorShortcut(event);
      if (shortcut === null) return;
      event.preventDefault();
      switch (shortcut) {
        case 'playPause':
          playhead.setPlaying(!playhead.playing);
          break;
        case 'seekLeft':
        case 'seekRight': {
          const step = (event.shiftKey ? 1 : 0.05) * (shortcut === 'seekLeft' ? -1 : 1);
          const doc = store.getState().doc;
          const limit = doc ? outputDuration(doc) : Number.POSITIVE_INFINITY;
          playhead.seek(Math.min(limit, Math.max(0, playhead.time + step)));
          break;
        }
        case 'settings':
          store.setSettingsOpen(true);
          break;
        case 'fullscreen':
          togglePlayerFullscreen();
          break;
        case 'start':
          playhead.seek(0);
          break;
        case 'end': {
          const doc = store.getState().doc;
          if (doc) playhead.seek(outputDuration(doc));
          break;
        }
        case 'split':
          store.splitAtPlayhead(playhead.time);
          break;
        case 'trimLeft':
          store.trimAtPlayhead('left', playhead.time);
          break;
        case 'trimRight':
          store.trimAtPlayhead('right', playhead.time);
          break;
        case 'delete':
          store.deleteSelectedBlock();
          break;
        case 'undo':
          store.undo();
          break;
        case 'redo':
          store.redo();
          break;
        case 'save':
          void store.flushSave();
          break;
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') store.setSnapDisabled(false);
      // keyboard-driven sliders coalesce their undo step per held key, not forever
      if (event.key.startsWith('Arrow')) store.endGesture();
    };
    const onPointerUp = (): void => {
      store.endGesture();
    };
    const onBlur = (): void => {
      store.setSnapDisabled(false);
      store.endGesture();
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);
}

const AUTO_PREVIEW_DELAY_MS = 5000;

/**
 * Renders the program (the engine's playback source) in the background once
 * edits settle: every doc change resets the debounce, so this fires only
 * after 5s of no further edits. Re-checks
 * the conditions with store.getState() when the timer fires — the store may
 * have moved on (job started elsewhere, preview already caught up) during
 * the wait, and a stale closure over `state` would double-fire or race it.
 */
function useAutoPreview(state: StoreState): void {
  useEffect(() => {
    if (!canStartAutoPreview(state, store.shouldAutoPreviewCurrentDoc())) {
      return;
    }
    const timer = setTimeout(() => {
      void startAutoPreviewAfterSave(
        store,
        () => store.startProgramRender(() => api.startRender({ preview: true, layers: 'omit' })),
        (message) => {
          store.showError(message);
        },
      );
    }, AUTO_PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [
    state.doc,
    state.autoPreview,
    state.programOutdated,
    state.activeJobs,
    state.audioPreviewRefreshState,
    state.project,
    state.undoDepth,
    state.agentEdited,
  ]);
}

function useDesktopMenuBridge(): void {
  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge === null) return;
    const disposeOpen = bridge.onOpenProjectRequest(() => {
      void (async () => {
        if (!(await store.flushSave())) return;
        const projectDir = await bridge.chooseProject();
        if (projectDir) await bridge.openProject(projectDir);
      })();
    });
    const disposeHome = bridge.onShowHomeRequest(() => {
      void store.flushSave().then((saved) => {
        if (saved) return bridge.showHome();
      });
    });
    // An update is about to replace the app underneath us. The autosave runs on
    // a debounce, so without this the last edit before accepting would be lost.
    const disposeFlush = bridge.onFlushSaveRequest(() => store.flushSave());
    return () => {
      disposeOpen();
      disposeHome();
      disposeFlush();
    };
  }, []);
}

function EditorApp(): JSX.Element {
  const state = useStore();
  useKeyboardShortcuts();
  useAutoPreview(state);
  useDesktopMenuBridge();

  useEffect(() => {
    const disposeSuggestions = onSuggestionsToolRequest(() => {
      store.dismissSuggestionError();
      store.setCutReviewMode('suggestions');
      store.setCutReviewOpen(true);
    });
    return () => {
      disposeSuggestions();
    };
  }, []);

  useEffect(() => {
    void store.init();
    // trackpad pinch = ctrl+wheel: never let it zoom the whole page
    const blockPageZoom = (event: WheelEvent): void => {
      if (event.ctrlKey) event.preventDefault();
    };
    window.addEventListener('wheel', blockPageZoom, { passive: false });
    return () => {
      window.removeEventListener('wheel', blockPageZoom);
    };
  }, []);

  const [playerWidth, setPlayerWidth] = useState(340);
  const [transcriptHeight, setTranscriptHeight] = useState<number | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(300);
  const dividerDrag = useRef<'col' | 'row' | 'inspector' | null>(null);

  // The side column exists while it holds tabs — and while a tab is being
  // dragged, so an emptied column can receive one back.
  const areaOpen = (area: 'left' | 'workspace' | 'bottom' | 'side'): boolean =>
    state.dockLayout[area].tabs.length > 0 || state.dockDrag !== null;
  const leftOpen = areaOpen('left');
  const workspaceOpen = areaOpen('workspace');
  const bottomOpen = areaOpen('bottom');
  const sideOpen = areaOpen('side');
  const compact = matchingPreset(state.dockLayout) === 'compact';

  if (state.loadError !== null && !state.doc) {
    return (
      <StartupScreen
        error={state.loadError}
        onRetry={() => {
          store.dismissError();
          void store.init();
        }}
      />
    );
  }
  if (!state.doc) {
    return <StartupScreen />;
  }

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <div
        className="app"
        onPointerMove={(event) => {
          if (dividerDrag.current === 'col') {
            setPlayerWidth(Math.min(560, Math.max(260, event.clientX)));
          } else if (dividerDrag.current === 'row') {
            setTranscriptHeight(
              Math.min(window.innerHeight - 220, Math.max(120, event.clientY - 60)),
            );
          } else if (dividerDrag.current === 'inspector') {
            setInspectorWidth(Math.min(480, Math.max(240, window.innerWidth - event.clientX - 8)));
          }
        }}
        onPointerUp={() => {
          dividerDrag.current = null;
        }}
      >
        <MenuBar />
        {state.loadError !== null && (
          <div className="banner error">
            <span>{state.loadError}</span>
            <button
              onClick={() => {
                store.dismissError();
              }}
            >
              ✕
            </button>
          </div>
        )}
        {state.editWarning !== null && (
          <div className="banner warn" role="status" aria-live="polite">
            <span>{state.editWarning}</span>
          </div>
        )}
        {state.conflict ? (
          <div className="banner conflict">
            <span>{t('conflict.message')}</span>
            <button
              onClick={() => {
                store.keepMine();
              }}
            >
              {t('conflict.keepMine')}
            </button>
            <button
              className="primary"
              onClick={() => {
                void store.reloadFromServer(true);
              }}
            >
              {t('conflict.reload')}
            </button>
          </div>
        ) : (
          <div />
        )}
        <div
          className="main px-2 pt-1 pb-2"
          data-compact={compact || undefined}
          style={{
            gridTemplateColumns: `${
              leftOpen
                ? `${compact ? `clamp(210px, ${String(playerWidth)}px, 38%)` : `${String(playerWidth)}px`} var(--pane-divider-size) `
                : ''
            }minmax(0, 1fr)${
              sideOpen ? ` var(--pane-divider-size) ${String(inspectorWidth)}px` : ''
            }`,
          }}
        >
          {leftOpen && (
            <>
              <DockArea area="left" />
              <div
                className="pane-divider"
                onPointerDown={() => {
                  dividerDrag.current = 'col';
                }}
              />
            </>
          )}
          <div className="right-pane">
            {workspaceOpen && (
              <div
                style={
                  transcriptHeight === null || !bottomOpen
                    ? { flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column' }
                    : {
                        height: transcriptHeight,
                        flex: 'none',
                        minHeight: 120,
                        display: 'flex',
                        flexDirection: 'column',
                      }
                }
              >
                <DockArea area="workspace" />
              </div>
            )}
            {workspaceOpen && bottomOpen && (
              <div
                className="row-divider"
                onPointerDown={() => {
                  dividerDrag.current = 'row';
                }}
              />
            )}
            {bottomOpen && (
              <div className="bottom-zone">
                <DockArea area="bottom" />
              </div>
            )}
          </div>
          {sideOpen && (
            <>
              <div
                className="pane-divider"
                onPointerDown={() => {
                  dividerDrag.current = 'inspector';
                }}
              />
              <DockArea area="side" />
            </>
          )}
        </div>
        <StatusBar />
      </div>
    </TooltipProvider>
  );
}

export function App(): JSX.Element {
  // A browser tab can ask for the Home with sample data to review its design.
  const bridge =
    desktopBridge() ?? (isLauncherPreview(window.location.search) ? previewDesktopBridge() : null);
  if (isLauncherMode(window.location.search, bridge) && bridge !== null) {
    return (
      <TooltipProvider delayDuration={400} skipDelayDuration={200}>
        <HomeScreen bridge={bridge} />
      </TooltipProvider>
    );
  }
  return <EditorApp />;
}
