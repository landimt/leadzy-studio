import type { JSX, ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Tooltip for an icon-only control. The child keeps (or gains) an `aria-label`
 * and drops the native `title`: with both, the browser's own tooltip and the
 * Radix one stack on top of each other.
 *
 * Deliberately not used for `title` on non-interactive text — a truncated file
 * name, a word's timecode in the transcript. Those are hundreds of elements and
 * one Radix Tooltip each would cost far more than the native attribute.
 */
export function Hint({
  label,
  side = 'bottom',
  children,
}: {
  label: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
