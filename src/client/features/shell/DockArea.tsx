import { Tabs, TabsContent } from '@/components/ui/tabs';
import { PanelTabsList, PanelTabsTrigger } from '@/components/PanelTabs';
import { useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { t, type MessageKey } from '../../i18n/index.js';
import { store } from '../../state/store.js';
import { useStore } from '../../state/hooks.js';
import { DOCK_AREAS, type DockAreaId, type DockPanelId } from './dock.js';
import { DOCK_PANEL_LABEL, DockPanelContent } from './dockPanels.js';

const AREA_LABEL: Record<DockAreaId, MessageKey> = {
  left: 'dock.area.left',
  workspace: 'dock.area.workspace',
  bottom: 'dock.area.bottom',
  side: 'dock.area.side',
};
const MOVE_LABEL: Record<DockAreaId, MessageKey> = {
  left: 'dock.move.left',
  workspace: 'dock.move.workspace',
  bottom: 'dock.move.bottom',
  side: 'dock.move.side',
};

/** Pointer travel before a press on a tab becomes a drag instead of a click. */
const DRAG_THRESHOLD_PX = 6;

interface Press {
  readonly panel: DockPanelId;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  dragging: boolean;
}

interface DropTarget {
  readonly area: DockAreaId;
  readonly index: number;
}

function dropTargetAt(x: number, y: number): DropTarget | null {
  const areaElement = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-dock-area]');
  if (!areaElement) return null;
  const area = areaElement.dataset.dockArea as DockAreaId;
  const tabs = [...areaElement.querySelectorAll<HTMLElement>('[data-dock-tab]')];
  const index = tabs.filter((tab) => {
    const rect = tab.getBoundingClientRect();
    return rect.left + rect.width / 2 < x;
  }).length;
  return { area, index };
}

function markDropHover(target: DropTarget | null): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-dock-area]')) {
    const hovered = target !== null && element.dataset.dockArea === target.area;
    if (hovered) element.setAttribute('data-drop-hover', '');
    else element.removeAttribute('data-drop-hover');
  }
}

/**
 * One dock area: its tab strip and the active panel. Tabs are dragged with
 * the pointer between areas (the ghost follows the pointer, the area under
 * it lights up) and, for the keyboard, moved through the tab's context menu.
 */
export function DockArea({ area }: { readonly area: DockAreaId }): JSX.Element {
  const state = useStore();
  const { tabs, active } = state.dockLayout[area];
  const pressRef = useRef<Press | null>(null);
  const [ghost, setGhost] = useState<{ panel: DockPanelId; x: number; y: number } | null>(null);
  const otherAreas = DOCK_AREAS.filter((candidate) => candidate !== area);

  const onTabPointerDown = (panel: DockPanelId) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pressRef.current = {
      panel,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
  };

  const onTabPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const press = pressRef.current;
    if (press?.pointerId !== event.pointerId) return;
    if (!press.dragging) {
      const travelled = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
      if (travelled < DRAG_THRESHOLD_PX) return;
      press.dragging = true;
      store.beginDockDrag(press.panel);
    }
    setGhost({ panel: press.panel, x: event.clientX, y: event.clientY });
    markDropHover(dropTargetAt(event.clientX, event.clientY));
  };

  const onTabPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const press = pressRef.current;
    if (press?.pointerId !== event.pointerId) return;
    pressRef.current = null;
    if (!press.dragging) {
      store.activateDockTab(press.panel);
      return;
    }
    const target = dropTargetAt(event.clientX, event.clientY);
    markDropHover(null);
    setGhost(null);
    if (target) store.moveDockTab(press.panel, target.area, target.index);
    store.endDockDrag();
  };

  const onTabPointerCancel = () => {
    const press = pressRef.current;
    pressRef.current = null;
    if (press?.dragging) {
      markDropHover(null);
      setGhost(null);
      store.endDockDrag();
    }
  };

  return (
    <Tabs
      value={active ?? ''}
      onValueChange={(value) => {
        const panel = tabs.find((item) => item === value);
        if (panel) store.activateDockTab(panel);
      }}
      className={cn('dock-area', tabs.length === 0 && 'dock-area-empty')}
      data-dock-area={area}
      aria-label={t(AREA_LABEL[area])}
    >
      <PanelTabsList aria-label={t(AREA_LABEL[area])}>
        {tabs.map((panel) => (
          <ContextMenu key={panel}>
            <ContextMenuTrigger asChild>
              <span className="contents">
                <PanelTabsTrigger
                  value={panel}
                  title={t(DOCK_PANEL_LABEL[panel])}
                  data-dock-tab={panel}
                  onPointerDown={onTabPointerDown(panel)}
                  onPointerMove={onTabPointerMove}
                  onPointerUp={onTabPointerUp}
                  onPointerCancel={onTabPointerCancel}
                >
                  {t(DOCK_PANEL_LABEL[panel])}
                </PanelTabsTrigger>
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {otherAreas.map((target) => (
                <ContextMenuItem
                  key={target}
                  onSelect={() => {
                    store.moveDockTabToArea(panel, target);
                  }}
                >
                  {t(MOVE_LABEL[target])}
                </ContextMenuItem>
              ))}
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </PanelTabsList>
      <TabsContent value={active ?? ''} className="dock-content">
        {active === null ? (
          <div className="dock-empty">{t('dock.empty')}</div>
        ) : (
          <DockPanelContent panel={active} />
        )}
      </TabsContent>
      {ghost !== null && (
        <div className="dock-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden="true">
          {t(DOCK_PANEL_LABEL[ghost.panel])}
        </div>
      )}
    </Tabs>
  );
}
