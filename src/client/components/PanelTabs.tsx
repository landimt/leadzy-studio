import type { ComponentProps, JSX } from 'react';
import { TabsList, TabsTrigger } from './ui/tabs';
import { cn } from '@/lib/utils';
import './panelTabs.css';

/** Shared compact tabs for editor panels and secondary tool modes. */
export function PanelTabsList({
  className,
  ...props
}: ComponentProps<typeof TabsList>): JSX.Element {
  return <TabsList variant="line" className={cn('panel-tabs-list', className)} {...props} />;
}

export function PanelTabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsTrigger>): JSX.Element {
  return <TabsTrigger className={cn('panel-tabs-trigger', className)} {...props} />;
}
