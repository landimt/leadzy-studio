import type { JSX } from 'react';
import { t, type MessageKey } from '../../i18n/index.js';
import { useStore } from '../../state/hooks.js';
import type { DockPanelId } from './dock.js';
import { TranscriptPanel } from '../transcript/TranscriptPanel.js';
import { MediaPanel } from '../transcript/MediaPanel.js';
import { LibraryPanel } from '../transcript/LibraryPanel.js';
import { EffectsPanel } from '../transcript/EffectsPanel.js';
import { CutSuggestionsInspector } from '../inspector/CutSuggestionsInspector.js';
import { Inspector } from '../inspector/Inspector.js';
import { Player } from '../player/Player.js';
import { Timeline } from '../timeline/Timeline.js';

export const DOCK_PANEL_LABEL: Record<DockPanelId, MessageKey> = {
  player: 'dock.tab.player',
  timeline: 'dock.tab.timeline',
  transcript: 'workspace.textTab',
  media: 'workspace.mediaTab',
  library: 'library.title',
  effects: 'workspace.effectsTab',
  cuts: 'dock.tab.cuts',
  inspector: 'dock.tab.inspector',
};

/** The inspector tab never goes blank: with nothing to inspect it says so. */
function InspectorPanel(): JSX.Element {
  const state = useStore();
  const hasContent =
    state.doc !== null &&
    (state.subtitleInspectorOpen ||
      (state.backgroundInspectorOpen && state.doc.canvas !== undefined) ||
      state.selection !== null);
  if (!hasContent) return <div className="dock-empty">{t('inspector.empty')}</div>;
  return <Inspector />;
}

export function DockPanelContent({ panel }: { readonly panel: DockPanelId }): JSX.Element {
  switch (panel) {
    case 'player':
      return (
        <div className="player-host">
          <Player />
        </div>
      );
    case 'timeline':
      return (
        <div className="timeline-host">
          <Timeline />
        </div>
      );
    case 'transcript':
      return <TranscriptPanel />;
    case 'media':
      return <MediaPanel />;
    case 'library':
      return <LibraryPanel />;
    case 'effects':
      return <EffectsPanel />;
    case 'cuts':
      return <CutSuggestionsInspector />;
    case 'inspector':
      return <InspectorPanel />;
  }
}
