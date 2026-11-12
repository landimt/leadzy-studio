'use client';

import * as React from 'react';
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/**
 * `viewportRef` is a local addition to the shadcn source. Radix moves the
 * scrolling box to an inner viewport element, so code that drives scrolling
 * imperatively — the transcript following the playhead, a list revealing the
 * selected row — has nothing to hold onto and silently stops working. Anything
 * that reads or writes scrollTop/scrollIntoView must take this ref instead of
 * the outer node.
 *
 * `maxHeight` is the second local addition, and it is not interchangeable with
 * `className="max-h-…"` on the Root: the Root has no overflow of its own, so a
 * max-height there clamps the Root's box while the Viewport (height:100% of an
 * indefinite parent) keeps growing past it — content paints outside the box and
 * nothing scrolls. The constraint has to land on the Viewport, which is the
 * element Radix gives `overflow-y: scroll`. Re-apply both after
 * `viewportClassName` keeps viewport-only layout rules in one place. The
 * viewport reserves the same 10px lane used by the vertical scrollbar, so the
 * thumb never covers row actions or metadata. Re-apply all three additions
 * after `shadcn add scroll-area`.
 */
function ScrollArea({
  className,
  children,
  viewportRef,
  viewportClassName,
  maxHeight,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportClassName?: string;
  maxHeight?: number;
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        {...(viewportRef === undefined ? {} : { ref: viewportRef })}
        {...(maxHeight === undefined ? {} : { style: { maxHeight } })}
        className={cn(
          'size-full pe-2.5 rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1',
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none p-0.5 transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border/90 transition-colors hover:bg-muted-foreground/45"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea };
