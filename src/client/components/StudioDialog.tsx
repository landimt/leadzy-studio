import type { JSX, ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

/**
 * The one modal shell for the Studio. Every dialog goes through it so that the
 * close affordance, header rhythm, body scrolling, error line and footer order
 * are decided once instead of per-screen.
 *
 * Open state is always owned by the caller (the store), never by this
 * component — a modal that owns its own visibility cannot be driven by an
 * agent, a keyboard shortcut, or a restored session.
 */

const SIZE_CLASS = {
  sm: 'sm:max-w-[380px]',
  md: 'sm:max-w-[520px]',
  lg: 'sm:max-w-[760px]',
} as const;

export type StudioDialogSize = keyof typeof SIZE_CLASS;

export function StudioDialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  size?: StudioDialogSize;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('gap-3 rounded-[var(--r-lg)] p-4', SIZE_CLASS[size], className)}>
        <DialogHeader className="gap-1">
          <DialogTitle className="text-[13px] leading-none font-semibold">{title}</DialogTitle>
          {description === undefined ? null : (
            <DialogDescription className="text-[11px]">{description}</DialogDescription>
          )}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Body of a dialog. `maxHeight` opts into scrolling — pass it only when the
 * content is a list that can grow (history, media, cues); a form that always
 * fits should not scroll, because a scrollbar on a short form reads as a bug.
 */
export function StudioDialogBody({
  maxHeight,
  className,
  children,
}: {
  maxHeight?: number;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const body = <div className={cn('flex flex-col gap-2 text-xs', className)}>{children}</div>;
  if (maxHeight === undefined) return body;
  return <ScrollArea maxHeight={maxHeight}>{body}</ScrollArea>;
}

/**
 * Failure line. Rendered as a live region so a screen reader announces the
 * error without the user having to go hunting for it after pressing Save.
 */
export function StudioDialogError({ children }: { children?: string | null }): JSX.Element | null {
  if (children === undefined || children === null || children === '') return null;
  return (
    <p role="alert" className="text-[11px] text-destructive">
      {children}
    </p>
  );
}

/**
 * Action row. Confirm goes last in DOM order so it is both the rightmost
 * control and the last stop in the tab order — put the buttons in as
 * cancel-then-confirm and the layout follows.
 */
export function StudioDialogFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <DialogFooter className={cn('gap-2 sm:justify-end', className)}>{children}</DialogFooter>;
}
