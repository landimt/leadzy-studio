# Leadzy Studio — visual direction

The UI contract. Every component follows this document. If something here
conflicts with the taste of whoever is editing, change it **here first**, then
in the component.

## The product

A local, **transcript-first** video editor for performance teams cutting spoken
creatives (ads and reels). The job is: delete a word and the video gets
shorter. The transcript is not a side panel — it is the document being edited.

## The thesis

**Light mode is light. Dark mode is dark. No exceptions.**

The theme toggle belongs to the user, and no design decision may override
`data-theme` — not the timeline, not the menubar. This is a rule, not a
preference.

There is no region that stays dark in both themes. There is no theme-scoping
class (there was one, `.chrome`; it was removed). What exists are **roles**
that resolve to different values in each theme. A component names the role;
the theme decides the value.

## The direction of this workstation

**A warm, precise, quiet editorial bench.** Video and words are the center;
pink is only the pulse of work. Processing tools live under `Tools`, while
`Project` covers opening, saving and delivering. Audio and Speed are separate
tools: the first cleans/normalizes/smooths, the second changes the global pace.
Both follow the order proof → adjust → proof, with the rendered preview next
to the tool's own inspector. In Audio, the proof is the processed `.m4a` with
its own waveform and transport; video only appears in Speed, where picture and
pace must be judged together.

Transient feedback never changes the editor's geometry. "Preview ready" is a
floating toast; errors and conflicts stay as bars because they demand a
decision. Choosing the room tone is a task of its own, in a second modal with
source, excerpt and playback. The source's whole waveform is the primary
control: suggested silences are marked and the 0.5–2 s window is adjusted
directly over the waveform, not on abstract sliders or in a starring video
player.

## The three states of the player

The transport always says what is on screen: `simulação` (nothing rendered
yet, or `renderizando…` while the program is being made), `motor` (the
background-rendered program — what you hear is the export's audio) and
`prova` (the burned preview). The badge is quiet chrome; only `motor` and
`prova` take the accent, because those are the states where the picture is
the engine's. `prova` is a toggle next to the badge, available only while the
preview is fresh — a stale preview explains itself in the tooltip instead of
silently showing something older than the edit.

## Color

Color literals live **only** in the palette block of
`src/client/styles/tokens.css`. Anywhere else — including `index.css`, the
other `styles/*.css` files and a component's `className` — a `#` or `rgba()`
is a bug. Verifiable:

```bash
grep -lE '#[0-9a-fA-F]{3,8}|rgba?\([0-9]' src/client/index.css src/client/styles/*.css
# must print only src/client/styles/tokens.css
```

### Layers

1. **Palette** — the literals. Mirrors `leadzy-website-v4`; a brand change is
   born there. Includes the warm ramp `--warm-950`…`--warm-100`, consumed only
   by the dark theme's bindings.
2. **Roles** — what components use. They swap per theme.

### Roles

| Role                             | Use                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--accent`                       | action, selection, focus, toggle on, playhead. The only saturated color in the interface                                                         |
| `--accent-solid`                 | filled surface under white text (primary button) — 8.68:1                                                                                        |
| `--accent-wash` / `--accent-ink` | background and text of the selected state                                                                                                        |
| `--agent`                        | content authored by an agent                                                                                                                     |
| `--track-effect`                 | effects and layers track                                                                                                                         |
| `--track-overlay`                | fill of the overlays track                                                                                                                       |
| `--track-overlay-edge`           | **outline** of that same track — pure orange as a 1.5 px border measures 1.85:1 on paper, so fill and border have different values in light mode |
| `--data-audio`                   | waveform. **Data only**, never a control                                                                                                         |
| `--snap-guide`                   | purple on purpose: the playhead is `--accent`, and two overlapping pink lines are indistinguishable mid-drag                                     |
| `--chrome-*`                     | tool surfaces (menubar, toolbars, timeline, track header)                                                                                        |
| `--on-accent`                    | text on a filled accent surface                                                                                                                  |
| `--on-media` / `--media-void`    | chrome **over** the video and the letterbox **behind** it. Deliberately identical in both themes: a playhead over the picture is always white    |

Tailwind's `--color-ring` (in `index.css`) is bound to `--accent`; components
reach it as `--ring`.

### Tint strength

A wash calibrated for a dark background disappears on paper. That is why the
`color-mix` percentage comes from a token, not a literal:

|                 | light | dark |
| --------------- | ----- | ---- |
| `--tint-soft`   | 24%   | 14%  |
| `--tint-medium` | 34%   | 20%  |
| `--tint-strong` | 46%   | 28%  |

A block gets the same hue in both themes; only the weight changes.

### Dark is warm

`--warm-950` is `#17130f` — hue ~30°, a brown-black, not the `#1e1e1e` grey of
every other editor. It is the brand's warm paper inverted. Do not "fix" it to
grey.

## Typography

- **Inter** (`--font-body`) — interface.
- **Space Mono** (`--font-data`) — **every** number: timecode, duration, %,
  counts, dB. Always with `tabular-nums`. An editor without tabular numerals
  jitters.
- **Micro-label** — panel title: 10 px, `uppercase`, `letter-spacing: 0.08em`,
  `--chrome-ink-soft`.
- **Track header** — lowercase, 10 px/600, almost no tracking. Stacked, four
  uppercase labels become noise; the track is already identified by position
  and icon, so the name only has to be legible, not shouted.

Scale: 10 / 11 / 12 / 13 / 16. Default control 12 px. The transcript is the
exception (15–16 px) — it is the document, read for minutes at a time.

## Density

shadcn's default (`h-9` = 36 px) is too loose for an editor.

| Size               | Height | Where                           |
| ------------------ | ------ | ------------------------------- |
| `icon-xs` / `xs`   | 24 px  | timeline toolbar, block toolbar |
| `icon-sm` / `sm`   | 26 px  | transport, menubar              |
| `default` / `icon` | 28 px  | top actions, labelled button    |
| `lg`               | 32 px  | modal confirm/cancel only       |

**24 px is the floor** — WCAG 2.2's minimum target. Compact stops there. Where
the visible target is smaller (a 12 px slider thumb), the hit area is restored
with an invisible `before`.

A row of controls has **one** height. Verifiable in the browser:

```js
[
  ...new Set(
    [...document.querySelectorAll('.timeline-toolbar [data-slot=button]')].map((e) =>
      Math.round(e.getBoundingClientRect().height),
    ),
  ),
]; // must be [24]
```

## Contrast — a measured floor, not an estimate

Text ≥ 4.5:1. Non-text UI element (a delimiting border, a control outline)
≥ 3:1. **In both themes.**

Measure by compositing alpha over the real background, and **wait for the
transition to finish** before reading the style: the Radix viewport has
`transition-[color]`, and reading right after switching the theme returns the
value mid-interpolation — it has already produced a false "1.28:1" here.

## Known traps

Three things that already broke this project and will break it again:

1. **`.block` collides with Tailwind's `block` utility.** The app rule is
   confined to `.timeline .block` for that reason. Without the scope, any
   component that only wants `display:block` inherits
   `position:absolute; top:6px`. Before creating a component class, check that
   the name is not a Tailwind utility.
2. **A bare element rule leaks into shadcn primitives.** `button` and
   `.timeline-toolbar > button` are scoped with `:not([data-slot])`
   (`styles/shadcn.css`). Without it, every migrated button needs
   `border-0 p-0` at the call site — and someone will forget.
3. **Tailwind v4 uses `currentColor` as the default border.** The base layer in
   `index.css` corrects it. If a `shadcn add` overwrites it, the black border
   comes back.

## Hard rules

- Color literals only in the palette.
- Named radii: `--r-sm` 6 px (icon), `--r-md` 8 px (default), `--r-lg` 10 px
  (panel/popover), `--r-pill` (chip/badge).
- Focus always visible. `--ring` is the pink; do not remove `focus-visible`.
- Modals go through `StudioDialog` (`src/client/components/StudioDialog.tsx`) —
  the close button, the header, the error and the footer order are decided in
  one place.
- Functional motion only: playhead/existing transitions, toast enter/leave and
  the startup screen's progress sweep. All of it respects
  `prefers-reduced-motion`. No gradients, glow, glass or animated ornamental
  backgrounds.

## Out of scope for the shadcn migration

Stays in CSS, deliberately — there is no equivalent primitive and translating
to utilities is churn with zero visual gain:

- `src/client/features/timeline/Timeline.tsx` — waveform canvas, blocks, drag,
  snap guides, rulers, tracks. Only the toolbar migrated.
- `src/client/features/player/Player.tsx` — `player-stage`, reframe gizmo,
  PiP, overlays, rendered subtitles. Only the transport bar migrated.

## Open debt

- The **library cards** (`.library-card*`) and the **segmented groups**
  (`.seg`) of the inspector stay in CSS on purpose. On the card, wrapping the
  tile in `Button` to make it clickable would let the variants override the
  preview; in `.seg`, they would override the active state, which is the only
  signal of which mode is selected. In both cases the primitive takes more than
  it gives.
- `card` and `toggle-group` were removed from `ui/` because nobody imported
  them, and the unused sub-components of the remaining primitives went the same
  way. An unused dependency there is worse than anywhere else: the directory is
  exempt from three lint rules, so nothing would flag the dead code later. A
  `shadcn add` brings a primitive back in seconds when a screen needs it.
