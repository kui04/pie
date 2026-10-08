---
version: alpha
name: Pie
description:
  A mobile-first GUI for pi. A quiet instrument — flat surfaces, one accent, air
  around everything, and no outline where a surface step can speak.
colors:
  # The dark theme is the base: it is what `:root` in `src/index.css` holds. The
  # light theme overrides the same names under `prefers-color-scheme: light`.
  # Every value is VS Code's Dark Modern (the key is named in `src/index.css`).
  background: "#181818"
  foreground: "#cccccc"
  surface: "#1f1f1f"
  surface-dim: "#181818"
  surface-bright: "#37373d"
  surface-container: "#2b2b2b"
  surface-container-high: "#2a2d2e"
  surface-container-highest: "#313131"
  card: "#2b2b2b"
  popover: "#1f1f1f"
  primary: "#0078d4"
  primary-foreground: "#ffffff"
  primary-text: "#4daafc"
  secondary: "#313131"
  secondary-foreground: "#cccccc"
  muted: "#3c3c3c"
  muted-foreground: "#9d9d9d"
  accent: "#37373d"
  accent-foreground: "#ffffff"
  destructive: "#f88070"
  destructive-foreground: "#1c1011"
  success: "#2ea043"
  warning: "#cca700"
  tertiary: "#81b88b"
  user-run: "#b180d7"
  excluded: "#6e7681"
  border: "#2b2b2b"
  border-subtle: "#252526"
  divider: "#3c3c3c"
  border-strong: "#3c3c3c"
  input: "#3c3c3c"
  ring: "#0078d4"
  outline: "#989898"
  outline-variant: "#3c3c3c"
typography:
  title-lg:
    fontFamily:
      system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif
    fontSize: 22px
    lineHeight: 28px
    fontWeight: 500
  title-md:
    fontFamily:
      system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif
    fontSize: 16px
    lineHeight: 24px
    letterSpacing: 0.15px
    fontWeight: 500
  title-sm:
    fontFamily:
      system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif
    fontSize: 14px
    lineHeight: 20px
    letterSpacing: 0.1px
    fontWeight: 600
  body-lg:
    fontFamily:
      system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif
    fontSize: 16px
    lineHeight: 24px
    letterSpacing: 0.5px
  body-md:
    fontFamily:
      system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif
    fontSize: 14px
    lineHeight: 20px
    letterSpacing: 0.25px
  body-sm:
    fontFamily:
      system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif
    fontSize: 12px
    lineHeight: 16px
    letterSpacing: 0.4px
  label-lg:
    fontFamily:
      system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif
    fontSize: 14px
    lineHeight: 20px
    letterSpacing: 0.1px
    fontWeight: 500
  label-md:
    fontFamily:
      system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif
    fontSize: 12px
    lineHeight: 16px
    letterSpacing: 0.5px
  label-sm:
    fontFamily:
      system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif
    fontSize: 11px
    lineHeight: 14px
    letterSpacing: 0.5px
  code:
    fontFamily: ui-monospace, "SF Mono", Menlo, Consolas, monospace
    fontSize: 14px
    lineHeight: 20px
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  window:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  panel-recessed:
    backgroundColor: "{colors.surface-dim}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  divider:
    backgroundColor: "{colors.divider}"
    size: 1px
  tile:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: 12px
  tile-header:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    padding: 12px
  tile-footer:
    backgroundColor: "{colors.card}"
    textColor: "{colors.muted-foreground}"
    padding: 12px
  code-block:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: 12px
  bubble-user:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.full}"
    padding: 12px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    height: 48px
    padding: 12px
  button-ghost:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.sm}"
    size: 24px
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.lg}"
    height: 32px
    padding: 12px
  field:
    backgroundColor: "{colors.input}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: 48px
    padding: 12px
  inline-link:
    textColor: "{colors.primary-text}"
  selected-row:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
  control-hover:
    backgroundColor: "{colors.surface-container-high}"
    rounded: "{rounded.sm}"
  control-chosen:
    backgroundColor: "{colors.surface-container-highest}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  tool-name:
    textColor: "{colors.primary-text}"
  tool-name-user-run:
    textColor: "{colors.user-run}"
  status-mark-success:
    textColor: "{colors.success}"
  status-mark-failure:
    textColor: "{colors.destructive}"
  note-warning:
    textColor: "{colors.warning}"
  note-error:
    textColor: "{colors.destructive}"
  popover:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: 8px
  dialog:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: 24px
  scrollbar-thumb:
    backgroundColor: "{colors.outline}"
    rounded: "{rounded.full}"
---

## Overview

Pie is the window onto a pi session that runs on another machine — local or over
SSH. It is a chat transcript of tiles, two panels at most, and one gate screen
that asks where pi is. It is designed at 360–430px first; a desktop window is
the same tree with room to spread.

The identity is a **quiet instrument**. It does not decorate a conversation: it
shows one. Surfaces are flat and near-neutral, the type is the reader's own
platform's, and one muted blue carries every action. Nothing in the transcript
is outlined — a tile is told apart from the page by sitting one small step above
it, and where two things must be told apart in earnest (fields, frames, floating
layers) a single hairline does it.

Three rules follow from that and are not negotiable:

1. An in-flow surface has no outline and no shadow.
2. Air is what separates; every edge keeps at least 4px from its neighbour.
3. One accent, and the accent is never the only signal — a colour never carries
   meaning a reader could not also read.

## Colors

Both themes are authored, not derived: `src/index.css` holds the dark values in
`:root` and the light ones under `prefers-color-scheme: light`. The names are
the same in both, so a component reads one name and the theme decides the value.
A token is spelled `--card`, and its Tailwind utility is `bg-card`.

The palette is **VS Code's**: _Dark Modern_ and _Light Modern_, the theme a
reader most likely has open beside pie. `src/index.css` names the VS Code key
each value comes from, so a later bump of VS Code is a diff against it — and a
reader who knows that editor already knows what a menu, a field or a selected
row looks like here.

**The surface ladder.** Depth is a step of the same neutral, never a gradient:

| Token                       | Dark      | Light     | What it is                                             |
| --------------------------- | --------- | --------- | ------------------------------------------------------ |
| `background`                | `#181818` | `#f8f8f8` | The window behind the panels (`titleBar.background`)   |
| `surface-dim`               | `#181818` | `#f8f8f8` | A panel that should recede (the session list)          |
| `surface`                   | `#1f1f1f` | `#ffffff` | A panel: the plane everything is drawn on (`editor`)   |
| `card`                      | `#2b2b2b` | `#f8f8f8` | A tile: a transcript card, a code block, the gate card |
| `surface-container-high`    | `#2a2d2e` | `#f2f2f2` | A control under the pointer (`list.hoverBackground`)   |
| `surface-container-highest` | `#313131` | `#ffffff` | A chosen control, and a field's fill (`input`)         |
| `accent`                    | `#37373d` | `#e8e8e8` | A row under the pointer, or the chosen one             |
| `popover`                   | `#1f1f1f` | `#ffffff` | A layer that floats over the page (`menu`)             |

**Text.** `foreground` is what a sentence is written in (`#cccccc` dark,
`#3b3b3b` light); `muted-foreground` is everything a reader does not have to
read (a time, an elapsed duration, a directory) and still holds AA on `card` and
on `surface`. `outline` is the colour of a placeholder, never of a label.

**The two hairlines.** `border` is the edge of a surface — a panel against the
window, a sheet against the page — and is the grey VS Code gives `panel.border`.
`divider` is a hairline _inside_ one — a tile's footer, a markdown rule, a
menu's separator — and is the softer grey of `input.border`, one step under the
menu separator a menu would use: a tile here is lighter than a menu, and the
loud line reads as a frame. They are two tokens because one grey cannot be both:
on a tile the edge grey and the tile are the same colour, and the hairline would
disappear.

**The accent.** `primary` is a fill — a button, the reader's own bubble, a
working dot — and always takes `primary-foreground` (white in both themes).
`primary-text` is the same blue read as text or as an icon on a surface: links,
the tool name of a model call, a spinner. They are two tokens because one blue
cannot hold AA as white-on-fill and as text-on-dark at once; light theme happens
to give both the same value (`#005fb8`). `ring` is the focus ring.

**Status.** `success`, `warning` and `destructive` are for what happened, not
for what kind of thing this is; an indicator that is not text (a dot, a mark)
holds 3:1 and anything read holds 4.5:1. The red is the one a reader reads
rather than the one a squiggle is drawn in: VS Code's list error in dark
(`#f88070`), its deleted-file red in light (`#ad0707`), and
`destructive-foreground` is whatever ink that red holds — white in light,
near-black in dark, where the red is light enough to be read as a line of text.
The light warning is the olive the light lists use, because the amber does not
hold as text on white.

**Pie's own.** `tertiary` is the dot of a session that has a live process behind
it (VS Code's added-file green); `user-run` is a command the reader ran
themselves, and shows in the tool name and the `$` prompt line — never as a
status mark (`charts.purple`); `secondary` is a filled control that is not the
primary one. `excluded`, `border-subtle`, `outline-variant` and `surface-bright`
complete the ladder for a primitive that names a step; nothing draws with them
today, and that is allowed.

**The colour axis of a tool name.** A tool name says _what the call did_, not
how it went: a call of the model is `primary-text`, a command the reader ran is
`user-run`. How it went is the status mark's business (`success`,
`destructive`), and the two never trade places.

## Typography

The ramp is authored in `src/index.css` as Tailwind text sizes (`text-body-md`).
No font ships with the app: the stack is the platform's own — `system-ui` and
its fallbacks, with `Noto Sans SC` for CJK — and a monospace stack for code.

| Utility         | Size / line | Where                                               |
| --------------- | ----------- | --------------------------------------------------- |
| `text-title-lg` | 22 / 28     | The gate's heading, the landing wordmark            |
| `text-title-md` | 16 / 24     | A section that owns a screen                        |
| `text-title-sm` | 14 / 20     | The session bar's title                             |
| `text-body-lg`  | 16 / 24     | Long-form prose that asks to be read                |
| `text-body-md`  | 14 / 20     | Almost everything: a sentence, a list row, a header |
| `text-body-sm`  | 12 / 16     | A second line under a title, a failure note         |
| `text-label-lg` | 14 / 20     | A control's own label                               |
| `text-label-md` | 12 / 16     | Meta beside a row: a duration, a token count        |
| `text-label-sm` | 11 / 14     | The smallest meta: a fence's language               |
| `text-code`     | 14 / 20     | Code, and the numbered body of a file or a diff     |

Monospace is for code and for nothing else: a tool's header, footer and notes
are sans, a log body is sans, and a markdown body is sans. The one exception is
a numbered body — a file or a diff — whose line numbers and text are code.

## Layout

The window is one column of panels. A phone shows one panel, edge to edge: the
OS owns the frame there, so a solo panel has no margin, no hairline and no
corner. A desktop adds the title bar as the first panel, and every panel is then
inset 4px from the window and told apart from its neighbour by a hairline.

- **Mobile first.** Base styles are the phone's; wider windows layer on with
  Tailwind breakpoints. A pane that only exists above `lg` (the session column)
  is not mounted below it.
- **One scroller per pane.** The window itself never scrolls. A panel scrolls
  its own body; a transcript scrolls its list; a tool body scrolls its own lines
  sideways. A card never scrolls inside a pane that also scrolls in the same
  direction except where the content demands it (a diff's line column).
- **Air.** 4px between panels, 12px inside a tile, 8px around a tile's body and
  under its last line, 24px inside a floating layer, 48px of a control's height
  on a touch pointer.
- **Safe areas.** Every overlay and any bar pinned to the window edge respects
  `env(safe-area-inset-*)`, and the composer stays above the on-screen keyboard.

## Elevation & Depth

There are only two elevations.

**In flow — none.** A tile is flat: `card` on `surface`, no border, no shadow. A
divider inside a tile is a 1px hairline in `divider`; a tile's footer is
separated from its body by that hairline, never by a gap alone. This is what
keeps a long transcript readable: no edges accumulate down the column.

**Floating — one.** A layer that leaves the page — the gate card, the
jump-to-latest pill, a menu, a popover, a dialog, a sheet, a toast — carries the
theme's shadow and a 1px `ring` of `foreground` at 10%: `shadow-sm` for the gate
card, `shadow-md` for a pill or a popover, `shadow-lg` for a dialog or a sheet.
A dialog dims the page with `bg-black/10` behind it. Nothing else is allowed a
shadow: a shadow on an in-flow tile reads as a mistake, because the tile is not
above anything.

## Shapes

| Token  | Value  | Where                                                    |
| ------ | ------ | -------------------------------------------------------- |
| `sm`   | 4px    | A small control, a menu row, a radio pill inside a group |
| `md`   | 6px    | A tile, a code block, an inline code pill                |
| `lg`   | 8px    | A panel, a button, a field, a popover                    |
| `xl`   | 12px   | The gate card, a dialog, a sheet                         |
| `full` | 9999px | A one-line message bubble, a status dot                  |

A panel that is the whole window is square: the window's own edge is not a shape
to round. A divider is a hairline, not a shape. Nothing else is rounded, and a
radius never grows with the size of the surface it is on.

## Components

**Panel** (`src/components/Panel.tsx`) — a pane of the window. `surface`, one
hairline (`border`) and an 8px corner when it has a neighbour; nothing at all
when it is the window. A pane that opens — the session column — is revealed by a
clip, and the width it opens to is the panel's **whole margin box**: a reveal
that stopped at the panel's own width would cut the panel's right border as it
opens.

**Tile** — the transcript's card: a tool call and its result (`ToolResultCard`),
a thought (`ThinkingCard`), a notice (`NoticeCard`), a fenced code block
(`CodeBlock`). Every one of them is the same face: `bg-card`, 6px corner, no
outline, no shadow, 12px of padding at the header's and the footer's ends. The
header is one line, truncated, with the status mark at its end and centred in
it; the footer is a full-width button over a hairline.

**Tool body** — a log (plain lines) or a numbered body (a file, a diff: line
number, mark, text; the two columns scroll as one and only the text column
scrolls sideways). Closed, a log shows its last five lines and a file or diff
its first three; the rest arrives through the footer.

**Bubble** — the reader's own message: `primary`, `primary-foreground`, a pill
for one line and a rounded card for more, right-aligned. Its actions are its own
context menu, not a control in the corner.

**Field** — `input` fill, no visible stroke until focus, then a `ring` focus
ring and a caret; 48px tall on a touch pointer.

**Buttons** — primary (a `primary` fill, white ink, 8px, 48px on touch), outline
(a hairline, transparent inside, for the second action), ghost (no chrome, for a
key in a bar), and link (`primary-text`, underlined on hover).

**Overlay** — a popover, a menu, a dialog or a sheet: `popover` fill, 8px (12px
over a dialog or a sheet), the ring, and the shadow its elevation names. One
overlay at a time; the sheet is what a dialog becomes on a phone.

**Toast** — sonner, top-centre, over the page, never in the layout.

**Scrollbar** — the engine's own bar, and it floats:

- The app asks for a thin bar in the theme's own quiet colour
  (`scrollbar-width`, `scrollbar-color`) and never touches
  `::-webkit-scrollbar`. Styling that pseudo-element turns the bar into a
  classic one that the pane pays for in its own width; this bar takes no width
  at all.
- The bar floats **over** the pane. No lane is reserved for it, so the words of
  a pane never move when it arrives, and a bar may run right beside a panel's
  hairline without touching it.
- A finger gets no bar: a platform whose pointer cannot hover draws none.
- Inside a tile the air still does the work: the padding above where a
  horizontal bar floats keeps the last line clear of it, and the air below keeps
  it off the footer.
- Where a platform draws no overlay bar at all (a window's WebView2, a desktop
  Firefox), the bar is that platform's own: thin, and taken out of the pane
  while it scrolls.

## Do's and Don'ts

- **Do** tell surfaces apart with the surface ladder, and **don't** put an
  outline or a shadow on something that is in the flow of the page.
- **Do** keep a tile's internals to one hairline; **don't** draw a frame inside
  a frame to group things — a heading is cheaper.
- **Do** keep the accent for actions; **don't** colour a tool name with a status
  colour, and don't use two accents in one view.
- **Do** keep AA for anything a reader reads (4.5:1) and 3:1 for an icon or an
  indicator; **don't** put `primary` behind white text _or_ in front of a dark
  surface with the same token — that is what `primary-text` is for.
- **Do** leave 4px around anything a panel holds; **don't** let a divider or a
  tile touch a neighbour's edge. A scrollbar is no exception: it floats, so it
  never needs the room anyway.
- **Do** write the system's own words at 14/20 and hold bigger sizes for
  headings; **don't** reach for mono outside code.
- **Do** keep the phone's layout whole: one panel, no margin, safe areas
  respected; **don't** fork the tree for a wide window — let it spread.
