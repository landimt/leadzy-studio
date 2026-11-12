import type { JSX } from 'react';

export const UI_ICON = {
  split: 'M8 2v12 M3 4h3v8H3z M10 4h3v8h-3z',
  trimLeft: 'M10 2v12 M13 4h-1v8h1 M7 5 4 8l3 3',
  trimRight: 'M6 2v12 M3 4h1v8H3 M9 5l3 3-3 3',
  trash: 'M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5 5 13.5h6l.5-9 M6.8 7v4 M9.2 7v4',
  remove: 'M4 4h7l3 4-3 4H4L1.5 8 4 4z M6 6l4 4 M10 6l-4 4',
  zoom: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z M10.5 10.5 14 14',
  play: 'M4 2.5 13 8 4 13.5z',
  pause: 'M5 3v10 M11 3v10',
  toStart: 'M3.5 3v10 M12.5 3 6 8l6.5 5z',
  toEnd: 'M12.5 3v10 M3.5 3 10 8l-6.5 5z',
  frameBack: 'M5 3.5v9 M11 3.5 6.5 8l4.5 4.5',
  frameForward: 'M11 3.5v9 M5 3.5 9.5 8 5 12.5',
  fullscreenExit: 'M6 2v4H2 M10 2v4h4 M14 10h-4v4 M2 10h4v4',
  eye: 'M1.5 8s2.3-4 6.5-4 6.5 4 6.5 4-2.3 4-6.5 4S1.5 8 1.5 8z M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  eyeOff:
    'M2 2l12 12 M5.2 4.7C3 5.8 1.5 8 1.5 8s2.3 4 6.5 4c1 0 1.9-.2 2.7-.6 M7 4.1c.3-.1.7-.1 1-.1 4.2 0 6.5 4 6.5 4s-.7 1.2-2 2.3',
  fit: 'M2 6V2h4 M10 2h4v4 M14 10v4h-4 M6 14H2v-4',
  layers: 'M2.5 5.5 8 2.5l5.5 3L8 8.5l-5.5-3z M2.5 8.5l5.5 3 5.5-3 M2.5 11l5.5 3 5.5-3',
  media: 'M2 3h12v10H2z M5 3v10 M11 3v10 M2 6h3 M11 6h3 M2 10h3 M11 10h3',
  image:
    'M2 3h12v10H2z M3.5 11l3.2-3.2 2.1 2.1 1.6-1.6 2.1 2.7 M10.8 5.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z',
  library: 'M2.5 2.5h4.5V7H2.5z M9 2.5h4.5V7H9z M2.5 9h4.5v4.5H2.5z M9 9h4.5v4.5H9z',
  overlay: 'M2.5 3.5h8v8h-8z M5.5 6.5h8v7h-8z',
  captions: 'M2 3.5h12v9H2z M4.5 7h3 M4.5 9.5h2 M9 7h2.5 M8 9.5h3.5',
  loop: 'M13.5 6A5.5 5.5 0 0 0 4 3.5L2 5.5 M2 2.5v3h3 M2.5 10A5.5 5.5 0 0 0 12 12.5l2-2 M14 13.5v-3h-3',
  volume: 'M1.5 6h3l4-3v10l-4-3h-3z M10.7 5.7a3 3 0 0 1 0 4.6 M12.7 3.8a6 6 0 0 1 0 8.4',
  volumeOff: 'M1.5 6h3l4-3v10l-4-3h-3z M10.5 6l4 4 M14.5 6l-4 4',
  /* the agent affordance: a four-point spark with a satellite — always drawn
     in --agent purple, never in the accent pink */
  sparkle:
    'M8 1.5c.7 2.9 1.7 4.6 4.7 5.3-3 .8-4 2.5-4.7 5.4-.7-2.9-1.7-4.6-4.7-5.4 3-.7 4-2.4 4.7-5.3z M12.8 10.4c.3 1.3.8 2 2.1 2.4-1.3.3-1.8 1-2.1 2.3-.3-1.3-.8-2-2.1-2.3 1.3-.4 1.8-1.1 2.1-2.4z',
} as const;

export function UiIcon(props: { d: string; filled?: boolean; size?: number }): JSX.Element {
  const size = props.size ?? 15;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={props.filled ? 'currentColor' : 'none'}
      stroke={props.filled ? 'none' : 'currentColor'}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={props.d} />
    </svg>
  );
}
