---
version: alpha
name: Pie
description:
  A mobile-first GUI for pi. A quiet instrument — flat surfaces, one accent, air
  around everything, and no outline where a surface step can speak.
colors:
  # The dark theme is the base: it is what `:root` in `src/index.css` holds. The
  # light theme overrides the same names under `prefers-color-scheme: light`.
  # Every value is VS Code's Dark Modern (the key is named in `src/index.css`) —
  # save the window's two planes, which take VS Code's two greys in the order the
  # window wants them: the chat is the deeper one, and the column stands above it.
  background: "#181818"
  foreground: "#cccccc"
  surface: "#181818"
  surface-dim: "#1f1f1f"
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
  violet: "#b180d7"
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
  2xl: 16px
  3xl: 24px
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
  sidebar:
    backgroundColor: "{colors.surface-dim}"
    textColor: "{colors.foreground}"
  topbar:
    textColor: "{colors.foreground}"
  chat:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
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
    rounded: "{rounded.md}"
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
  marker:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.body-md}"
  kbd:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
  tool-name:
    textColor: "{colors.primary-text}"
  tool-name-reader-run:
    textColor: "{colors.violet}"
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
  composer-popup:
    backgroundColor: "{colors.card}"
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
SSH. It is a chat transcript of tiles, one region of the window more at most,
and one gate screen that asks where pi is. It is designed at 360–430px first; a
desktop window is the same tree with room to spread.

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
| `background`                | `#181818` | `#f8f8f8` | The window behind the regions (`titleBar.background`)  |
| `surface`                   | `#181818` | `#ffffff` | The chat: the plane everything is drawn on             |
| `surface-dim`               | `#1f1f1f` | `#f8f8f8` | The list's column, kept one step clear of the chat     |
| `card`                      | `#2b2b2b` | `#f8f8f8` | A tile: a transcript card, a code block, the gate card |
| `surface-container-high`    | `#2a2d2e` | `#f2f2f2` | A control under the pointer (`list.hoverBackground`)   |
| `surface-container-highest` | `#313131` | `#ffffff` | A chosen control, and a field's fill (`input`)         |
| `accent`                    | `#37373d` | `#e8e8e8` | A row under the pointer, or the chosen one             |
| `popover`                   | `#1f1f1f` | `#ffffff` | A layer that floats over the page (`menu`)             |

The chat and the column are never the same grey: the step between them is what
says there are two regions. Which of the two is the deeper one follows the theme
— dark, where the chat is the window's own plane and the column stands above it;
light, where the chat is the page and the column recedes under it.

**Text.** `foreground` is what a sentence is written in (`#cccccc` dark,
`#3b3b3b` light); `muted-foreground` is everything a reader does not have to
read (a time, an elapsed duration, a directory) and still holds AA on `card` and
on `surface`. `outline` is the colour of a placeholder, never of a label.

**The two hairlines.** `border` is the edge of a surface — the list's column
against the chat, a sheet against the page — and is the grey VS Code gives
`panel.border`. `divider` is a hairline _inside_ one — a tile's footer, a
markdown rule, a menu's separator — and is the softer grey of `input.border`,
one step under the menu separator a menu would use: a tile here is lighter than
a menu, and the loud line reads as a frame. They are two tokens because one grey
cannot be both: on a tile the edge grey and the tile are the same colour, and
the hairline would disappear.

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
it (VS Code's added-file green); `violet` (`charts.purple`) is everything that
is not the model's doing: a command the reader ran themselves, in the tool name
and the `$` prompt line, and the word a system notice leads with (`Compaction`,
`Summary`, `Skill`: pi's `customMessageLabel` violet) — never as a status mark;
`secondary` is a filled control that is not the primary one. `excluded`,
`border-subtle`, `outline-variant` and `surface-bright` complete the ladder for
a primitive that names a step; nothing draws with them today, and that is
allowed.

**The colour axis of a tool name.** A tool name says _what the call did_, not
how it went: a call of the model is `primary-text`, a command the reader ran is
`violet`. How it went is the status mark's business (`success`, `destructive`),
and the two never trade places.

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

The window is two regions, edge to edge: the list of sessions in a column of its
own, and the chat beside it, told apart by the one hairline the column carries.
A phone shows the chat alone — the list arrives as a sheet, not a column — and
the chat is a column of two: the bar, and the body under it.

The bar is the window's own handle: the window has no decorations, so a press on
the bar drags it, and the window's three keys sit at its end. Before them are
the session's slots — the way to the list, the name, the state of the context —
and while no conversation is open the bar carries the way to the list alone: the
landing has no session to name, and neither has a conversation that is on its
way. The bar says what the page it stands on can say, and the page of a
conversation being loaded is the landing's kind: only the read that answers
turns the bar into the session's own and hands the foot to the composer.

- **Mobile first.** Base styles are the phone's; wider windows layer on with
  Tailwind breakpoints. The column that only exists above `lg` (the session
  list) is not mounted below it.
- **One scroller per region.** The window itself never scrolls: the shell is
  `h-svh` and clips, and `html`/`body` carry `overflow: clip`, so nothing that
  lands outside the shell — a portal, a stray element — can scroll the window
  out from under its own bar. The list's column scrolls its rows; a transcript
  scrolls its list; a tool body scrolls its own lines sideways. A card never
  scrolls inside a region that also scrolls in the same direction except where
  the content demands it (a diff's line column).
- **Air.** 12px inside a tile, 8px around a tile's body and under its last line,
  24px inside a floating layer, 48px of a control's height on a touch pointer.
- **Safe areas.** A phone draws its status bar and its navigation bar over the
  window — Android enforces edge to edge from target 35 — and hands the room
  they take to the page as `safe-area-inset-*` (the viewport says
  `viewport-fit=cover`; the webview reports the system bars from M144). A
  screen's page is the safe area (`src/components/SafeArea.tsx`, around the
  column): the room is taken once, on the whole page and on all four sides, so
  nothing inside it can sit under a system bar. An overlay leaves the page for a
  portal, where the page's room does not reach: it takes its own side the same
  way.

## Elevation & Depth

Two questions stand behind a surface: whether it is in flow or leaves the page,
and — where two surfaces meet — which one the light is on.

**In flow — none.** A tile is flat: `card` on `surface`, no border, no shadow. A
divider inside a tile is a 1px hairline in `divider`; a tile's footer is
separated from its body by that hairline, never by a gap alone. This is what
keeps a long transcript readable: no edges accumulate down the column.

**Floating — over the transcript.** The bar floats transparent over the
transcript's head: no plane, no shadow, no hairline. The composer carries no
shadow either: it is a flat `card` with the `3xl` corner, a row of the column
under the words. What says depth at both ends is the fade over the rows: the
page's own plane (`surface`), gradient to transparent one content column wide,
so the rows scroll under the fade on their way to the bar and to the composer.
The bar sits on a solid backing with one line of fade below it; the composer
gets two lines of fade above it. The transcript keeps headroom above for the bar
and four lines of legroom below, above the fade's dense end, so no row hides
under either. The composer's own layers — its command list and its two pickers —
stand above it on the same plane (`card`): the command list takes the composer's
`3xl` corner, the two pickers the menu's `xl`; each is flat, with the composer's
`foreground` at 10% hairline and no shadow. The same flat key floats over the
transcript to take the reader back to the end; it sits above both fades, so no
gradient covers it.

**Floating — what the scrim does not.** The composer's layers, the session menu,
and the key that floats over the transcript are flat: `card`, a hairline, and no
shadow. Other layers that leave the page carry the theme's shadow: `shadow-sm`
for the gate card, `shadow-md` for a menu or a popover, and `shadow-lg` for a
submenu. A toast brings the library's own. Its edge is a 1px hairline —
`foreground` at 10% as a `ring` where the layer is a bare surface, the theme's
`border` where it has a frame of its own. A layer with a scrim behind it shows
no shadow at all: the scrim is what separates it, and a shadow on top of one
answers the same question twice. A dialog dims the page with `bg-black/10`, a
sheet with `surface-container-highest` at 70%, and each shows only its hairline.
Nothing else is allowed a shadow: a shadow on an in-flow tile reads as a
mistake, because the tile is not above anything.

## Shapes

| Token  | Value  | Where                                                    |
| ------ | ------ | -------------------------------------------------------- |
| `sm`   | 4px    | A small control, a menu row, a radio pill inside a group |
| `md`   | 6px    | A tile, a code block, an inline code pill, the bubble    |
| `lg`   | 8px    | A button, a field, a popover                             |
| `xl`   | 12px   | The gate card, a dialog, a sheet                         |
| `full` | 9999px | A round key, a status dot                                |

A divider is a hairline, not a shape. Nothing else is rounded, and a radius
never grows with the size of the surface it is on.

## Motion

One file answers how fast a thing moves (`src/lib/motion.ts`), and a component
names a token from it rather than a duration. Five kinds of change cover the
app:

| Change                             | Token          | Rule                                                                                                                                                |
| ---------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| The shell of the app opening       | `SHELL`        | 150ms of opacity; nothing travels, for a window that rose would be the window jumping                                                               |
| A page replacing a page            | `STAGE`        | 240ms arriving, 160ms leaving, no travel; two conversations are peers, so it fades through, and the page that is leaving goes first (`mode="wait"`) |
| A part arriving, leaving, changing | `SLOT`, `SWAP` | 150ms arriving, 120ms leaving; a slot slides 4px into place, a part replaced in the box it holds shrinks and grows                                  |
| A body moving its own height       | `REVEAL`       | 200ms arriving, 160ms leaving; the height itself moves, so nothing under it jumps                                                                   |
| The window's geometry              | `FRAME`        | 300ms on the list's column                                                                                                                          |
| Something endless                  | `TURN`         | One speed: the ring of a run at work and a spinner (1s), the sand (3s), the light of a row (2400ms), the shimmer of a thought (2s)                  |

A conversation giving up its place for another is a page replacing a page: it
fades through. The bar is the window's — the way to the list and the window's
own keys stand still for every stage and every conversation — and only a
session's own slots in it, its name and its context, change, fading between the
two. A page never travels — a rise would say "forward" about a move that has no
direction — and only a small part does, four pixels into its place. A form
dimmed where it stands (`FADE`) moves on the same clock as a slot that changes.

Three curves, one job each: an arrival is confident and fast off the mark, a
small part settles in gently, a leaving gathers speed and is gone — a leaving is
not an arrival backwards. Nothing bounces, and nothing elastic.

A reader who asked for less motion keeps the same page and loses only its
movement: no travel, no scale, and every fade cut to a tenth of a second,
because a thing that appears must still be seen to appear. The endless things
hold their place except one, which turns on at half its speed: the ring of a run
at work is what says the run is still going on, and a ring standing still says
the opposite. A light whose list is not on screen does not breathe: the column
that is out, or the sheet that is open, is the one that breathes. The test
environment answers for less motion (`src/test/setup.ts`), which is why nothing
in the suite waits on an animation.

What the app does not move itself: a picker's panel, a dialog, a menu and a
toast follow their library (Radix, sonner), and the sheet's slide is Vaul's own
half second — a drawer the library draws for a phone, beside a column that is
this app's layout. The transcript's own scroll is a distance over time rather
than a transition: it glides, and a reader who asked for less motion takes the
end at once.

## Components

**A lost connection** (`src/routes/connect/ConnectionLostOverlay.tsx`) — the one
surface that says the connection is gone. It stands over whichever page is up,
because the connection is not a page's business, and it is the only place that
says it: a read that fails says so where it was read, and a transcript that
stops says nothing at all, so neither can tell a quiet model from a host that
went away. The plane behind it stays visible through a blur — the window is not
replaced, it is veiled — and the card is the gate's own shape, so the app does
not look like another product mid-conversation. It offers the two things a
person can do: **Reconnect**, which dials the same machine with what Rust still
holds, so nothing is typed again and no secret crosses the boundary a second
time, and **Go to the gate**. `Escape` is the gate, and never a silent
dismissal: a dead connection nobody named is what this surface exists to
prevent.

**The window's frame** — no component holds it: each screen draws its own. The
window's shape is the screen's, so nothing fixes a side column or a bar as a
region of the window. The gate draws its card on the window's plane; the chat
draws the list's column, where there is one, and the chat beside it — two
regions, edge to edge, told apart by the one hairline the column carries, with
no margins and no corners, because the window's own edge is not a shape to
round.

What a frame shares is the bar: the window's own handle, and the one piece the
window owns. The window has no decorations, so a press on the bar drags it, and
its three keys (`WindowControls`) sit at its end, after the slots the page gives
it — the way to the list, the name, the state of the context. A page with no
slots to give — the gate, whose bar is only the handle and the keys — lets the
bar float over its plane, so that its card stands in the middle of the window
rather than in what is left below a row. The chat's bar (`#topbar`) floats
transparent over the transcript's top fade: no plane, no shadow, no hairline.
The bar is the page's first row on every platform; its keys are a desktop's,
because a phone's OS owns the frame there. On a desktop every inset is zero, so
the frame is one tree.

The body under the bar is the chat, and it is a column: the transcript, then the
composer at its foot. Both are capped to one content column, 64rem wide at most
and centred, and both keep 16px inside it, so the composer's box and the words
of the transcript stand on one line. The composer is a flat card (`card`, the
`3xl` corner, no shadow, and a hairline that holds where a light page keeps the
card and the surface close) at the foot of the column: the transcript ends where
the band begins, so no row hides under it and the scrollbar maps to the rows
alone. A fade at each end of the transcript — the page's own plane, gradient to
transparent, one content column wide — is what the rows scroll under, with
headroom above for the bar and legroom below above the fade's dense end. The
band takes the region's whole width, because the transcript's bar floats over
the scroller's edge (see **Scrollbar**) rather than taking room of its own. And
it shows itself only while the list moves, so a reader who is not scrolling sees
no bar at all. A column that opens — the session list above `lg` — is revealed
by a clip: its wrapper owns the width the transcript gives up (256px), and the
column inside it keeps its own width, so what moves is the edge and the hairline
on it, not the rows.

**Composer** (`src/routes/chat/composer/Composer.tsx`) — the card at the foot,
with the pictures of the next message above the words. A picture is a card of
its own: a 64px card with a 48px thumbnail, the name the picker gave it, its
kind and its size, and a key that removes it — shown on hover and focus, and
always on a touch pointer. The strip scrolls sideways rather than wrapping,
because the words and the controls must keep their place; when it overruns, the
end fades under a gradient of the card's own colour and a chevron pages it. The
words take the card's width in `text-body-lg`, 60px tall, two lines at most;
longer words scroll inside the box. The foot is two groups: the model and the
thinking level as 34px blue-tinted pills with a 13px label on the left, each
carrying the value in use, and the paperclip that stages pictures beside the
primary circle that sends, or stops a run, on the right. The pills keep their
labels at every width and truncate the model's name before the level's, so the
setting that is one word stays whole. `/` still opens the command list from the
words; the card has no key for it.

**Landing** (`src/routes/chat/SessionLanding.tsx`) — the window with no
conversation open, which is where it starts and where `Detach` will return it.
It draws the words of pi and the keys the window will answer to, centred, and
the bar above it carries only the way to the list and the window's own keys: a
session's slots (name, context) belong to a conversation, and there is none yet.
A key is shadcn's **kbd** (`text-body-md` at its side, `muted` under it), and
its binding is not made yet — the rows are the plan a reader can read
(`docs/TODO.md`). The chat has three pages and this is the first; the others are
the loading page and the conversation itself, and a page leaves before the next
arrives (`STAGE`).

**Loading** (`src/routes/chat/SessionLoading.tsx`) — a conversation is on its
way: the window keeps the bar of the landing — a conversation that has not
arrived has nothing to say about itself — and the page says
`Opening the session…` beside shadcn's **spinner** (`Loader2`,
`muted-foreground`), centred. No composer and no session slots until the read
answers, and nothing under it: a page of its own, entered and left with the same
motion as the others (`STAGE` of `src/lib/motion.ts`, `mode="wait"` between the
pages, and nothing moves where a reader asked for less motion). The landing and
the words leave before it arrives.

A switch is the same passage: the conversation on screen is given up for this
page, and the answer of the new one brings the words back. Nothing of the one
that is leaving stands under the ring, and nothing of it is drawn a second time
— the reader saw the page of that conversation go, come back and go again while
an older version kept it under the loading one (`ChatScreen`; the stage is
`machines/chat.machine.ts`, `loaded → loading → loaded`). A feed that cannot
open is not a page of its own either: the loading page says why, with the way to
try again.

**Tile** — the transcript's card: a tool call and its result (`ToolResultCard`),
a thought (`ThinkingCard`), a notice (`NoticeCard`), a fenced code block
(`CodeBlock`). Every one of them is the same face: `bg-card`, 6px corner, no
outline, no shadow, 12px of padding at the header's and the footer's ends. The
header is one line, truncated, with the status mark at its end and centred in
it; the footer is a full-width button over a hairline.

**Markdown** — what a model writes is read as a model writes it. GFM carries the
tables, the task lists and the footnotes; `$x^2$` and a `$$ … $$` block are set
as formulas by KaTeX; and a single newline ends a line, because that is what a
model means by it (pi's own renderer answers the same way). A dollar sign is not
always a formula: a pair whose content ends in whitespace, or is followed by a
digit, or is a shell variable joined to a word, stays the text it is
(`lib/remark-dollars.ts`, the same questions pi's renderer asks). An HTML tag
stays the text it is too, as it does in pi.

A fenced block is a tile of this page, so it keeps `bg-card`: only the ink comes
from the theme. That theme is VS Code's own pair, Dark+ and Light+ — the colours
the app's palette was cut from, so a block looks like its editor's. Every token
carries both palettes at once as custom properties and one rule in
`src/index.css` picks the one in force, which is why a scheme change recolours
code without a render. The colours arrive when the words stop: a block still
being written is drawn plain, because colouring a long one costs a frame of its
own.

**Stream** — what a model is doing while it works. A thought that is still
arriving says `Thinking…` in shadcn's **marker** with its **`shimmer`** utility
(from `shadcn/tailwind.css`, imported by `src/index.css`): the light is pure CSS
off the text's own colour, it brightens itself in dark, and it stands still
where a reader asked for less motion. No icon — the word is the whole signal.

A message of a run is drawn while the run writes it, not when it is over: the
answer, the call's arguments and the output a call streams all arrive as a row
that the read at the end of the run then replaces (`lib/stream.ts`). The row
keeps its name across that replacement, so a card the reader opened stays open
and the clock of a call runs on into its `Took`. A call whose tool is at work
shows what it streamed and its status mark turns over when the tool answers.

A run has one line of its own under the transcript, and two words for it:
`Waiting…` with the hourglass from the moment a reader sends until the model's
first output arrives — a connection over a network makes that stretch long
enough to name — and `Working…` with the turning ring from then until the run is
over, so a call that runs under a finished message is still the same run at
work.

A run pi takes up again is not a run that failed: the turn says nothing of its
failure while pi retries, and a toast carries the attempt, which the retry that
works takes away again.

The list keeps the reader where they are: it follows the end only while they are
at it, and the key below takes them back when they are not. A jump to the end is
taken again while the sizes settle under it — a row is measured when it is first
drawn, and a row whose words rewrapped changes height — for the end of the
transcript is wherever those sizes put it, and a jump measured against the older
ones lands short of it.

The key's jump is run, not cut: the scroller glides to the end over a length the
distance decides (a fixed number of pixels a millisecond between two bounds, so
a long transcript is not proportionally slower), easing out onto it, because the
rows between are rows the list has never drawn — a jump over them lands on their
estimated heights, while a run draws every one of them and arrives at the end it
measured. The reader's own hand ends the run where they take it back, and where
they asked for less motion the end is taken at once.

**Tool body** — a log (plain lines) or a numbered body (a file, a diff: line
number, mark, text; the two columns scroll as one and only the text column
scrolls sideways). Closed, a log shows its last five lines and a file or diff
its first three; the rest arrives through the footer.

**Bubble** — the reader's own message: `primary`, `primary-foreground`, the same
6px a tile takes, and right-aligned. One shape whatever the length; a single
line is the same bubble in a tighter box. Its actions are its own context menu,
not a control in the corner.

**Popup** (`src/routes/chat/composer/ModelPicker.tsx`, `ThinkingLevelPicker.tsx`
beside it) — the panel a picker of the composer opens, and the command list of
the message box with it: the composer's own plane (`card`) in the composer's
shape — the command list at the `3xl` corner and the pickers at the menu's `xl`,
flat with a hairline and no shadow — `space-sm` of padding, `space-xs` between
the rows, 17rem wide for the models and 11rem for the levels, and a fixed 240px
where a host may offer more models than fit — six hundred of them on a host with
every provider configured, and it draws every one of them and scrolls rather
than cutting the list short: the model in use leads, the rest follow one
provider after another, and a search ranks them by pi's own matching, so a model
that typing finds in pi is found by typing the same here. While the catalog is
on its way the popup holds those rows as bars, so it opens at the height it
keeps. A model row reads in the plane's own ink (`foreground`), every row the
same, and only its light changes: nothing is lit until the pointer or a key
moves the light, a search lights its best match, and the light leaves with the
pointer. A row of a level list follows the same rule. The model in use, and the
level in use, are marked by their check in `primary-text` and by nothing else —
not by a fill of their own. The mark of a model's provider leads its key and its
row — 16px, the shape of models.dev in the ink of the surface under it, and the
key of the composer where models.dev has no mark — fetched once and kept for a
day. The command menu's panel is the same plane and shape, as wide as the card
it stands above, and it is ten rows tall past the tenth of them and as tall as
its rows while there are fewer, so the rows past the ten are scrolled to rather
than clipped. Its rows take the menu's accent (`selected-row`) — the light is
the pointer's while the pointer is in the list and the keyboard's when it is
not, and it leaves with the pointer — and a row of the command menu reads in two
inks: the name in the plane's own (`foreground`), and what the command says
about itself in `muted-foreground`. The lit row reads in the accent's own ink,
because the muted ink on the accent fill is 4.37:1 — under what a sentence
needs.

**Field** — `input` fill, no visible stroke until focus, then a `ring` focus
ring and a caret; 48px tall on a touch pointer.

**Buttons** — primary (a `primary` fill, white ink, 8px, 48px on touch), outline
(a hairline, transparent inside, for the second action), ghost (no chrome, for a
key in a bar), and link (`primary-text`, underlined on hover).

**Overlay** — a popover, a menu, a dialog or a sheet: `popover` fill, 8px (12px
over a dialog or a sheet), and the edge and the shadow its layer names. One
overlay at a time; the sheet — shadcn's drawer over vaul, kept as pie's own
`src/components/Sheet.tsx` — is what a dialog becomes on a phone, and a bottom
sheet shows the drag bar that says it can be swiped away.

**Toast** — sonner, top-centre, over the page, never in the layout.

**Scrollbar** — a rounded pill that floats over the edge of what it scrolls, is
visible only while the region moves, and costs the region's width nothing:

- Every region pie draws itself — the transcript, the session list, a tool
  card's log or diff, a code block, a markdown table, the gate's form — scrolls
  inside a `ScrollPane` (Radix), which hands the region an 8px lane over its
  content with a 4px `{colors.outline}` thumb inset 2px either side and
  `{colors.foreground}` under the pointer, sized per orientation (`bars`: a log
  scrolls sideways, a transcript down). The viewport carries no native bar, so
  no engine draws its own inside one, and the bar costs the words nothing
  wherever it appears.
- One scroller is still the engine's own: a `textarea`. There
  `::-webkit-scrollbar` gives Blink and WebKit the same pill, and Firefox is
  handed the same two colours through `scrollbar-width` and `scrollbar-color`,
  where it shows the platform's thin bar — whose lane Blink keeps, so such a
  region is 8px narrower there than one that does not scroll.
- A bar shows itself while its region moves, and while the pointer is over the
  region. The Radix pill fades in and out (`160ms`, and it takes no pointer
  while it is away, so the pane's edge stays text to select); the engine's bar
  is simply there or not, and 700ms after the last scroll `is-scrolling` leaves
  the document, which is what it reads.
- `no-scrollbar` outranks these rules, so a short list can still scroll in
  silence.
- Inside a tile the air still does the work: the padding below the last line
  keeps it off a horizontal bar, and the air above the footer keeps the bar off
  the footer.

## Do's and Don'ts

- **Do** tell surfaces apart with the surface ladder, and **don't** put an
  outline or a shadow on a tile in the flow of the page — a depth belongs to the
  composer and to what floats over it.
- **Do** keep a tile's internals to one hairline; **don't** draw a frame inside
  a frame to group things — a heading is cheaper.
- **Do** keep the accent for actions; **don't** colour a tool name with a status
  colour, and don't use two accents in one view.
- **Do** keep AA for anything a reader reads (4.5:1) and 3:1 for an icon or an
  indicator; **don't** put `primary` behind white text _or_ in front of a dark
  surface with the same token — that is what `primary-text` is for.
- **Do** leave air around anything a region holds; **don't** let a divider or a
  tile touch a neighbour's edge.
- **Do** write the system's own words at 14/20 and hold bigger sizes for
  headings; **don't** reach for mono outside code.
- **Do** keep the phone's layout whole: the chat alone, safe areas respected;
  **don't** fork the tree for a wide window — let it spread.
