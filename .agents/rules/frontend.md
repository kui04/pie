# Frontend rules — apply to src/**

Mobile first; desktop is the responsive expansion of the same tree — never a
forked layout.

## Layout

- Design and test at 360–430 px first; desktop arrives via breakpoints and
  panes.
- Sheets and drawers (vaul) before centered dialogs on touch. Every overlay
  handles `env(safe-area-inset-*)` and the on-screen keyboard (visualViewport).
- react-router in library mode — no framework-mode loaders/actions; routes in
  `src/routes/`; the Android back gesture must route through the router.
- Respect `prefers-color-scheme`: shadcn themes for light/dark.

## Markup and CSS

- Minimize JSX nesting: every element must earn its place. If it adds nothing
  structural, semantic, or stylistic that its parent or children cannot take,
  remove it.
- Reach for the simplest, most robust CSS that achieves the effect. Prefer
  well-supported properties over clever hacks; a hack is a sign the approach is
  wrong, and JS should never do what CSS already does well.
- Lay out with flex and grid; fixed dimensions and absolute positioning need a
  reason.
- Responsive behavior comes from Tailwind's breakpoint variants. Base styles are
  the mobile layout and wider screens layer on via the size variants —
  hand-written media queries need a reason.
- Try to give every element a meaningful `id`, kebab-case from its purpose: it
  is the stable hook for automation and semantics. Ids must be unique by
  construction — derive from data when a component renders repeatedly, never
  ship a duplicate. Component tests still query by role and text first; ids are
  the fallback, not the query.

## Components

- shadcn-ui (Radix + Tailwind) is the base; add via `shadcn add` into
  `src/components/ui/`. Those files stay the registry's own — never hand-edit
  one, so re-running `shadcn add <name> --overwrite` is the whole upgrade, and
  `pnpm ui-check` fails when one has drifted. A difference belongs in a call
  site's `className` through `cn` (a size that fights the app's own ramp is
  written `text-[length:var(--text-body-md)]`, because `cn` reads `text-body-md`
  as a colour and would leave the primitive's own size standing beside it), in
  the theme in `src/index.css`, or in pie's own component beside `ui/`
  (`ScrollPane`, `Sheet`, `OptionRow`) when the difference is structural — a
  prop the caller needs, markup the primitive keeps to itself. Icons:
  lucide-react.
- Every directory called `components/` has an `index.ts`, and that barrel is the
  only door a caller outside it uses: a primitive from `@/components/ui`, pie's
  own from `@/components` (pie's components live under `src/components/`, in
  `layout/` when they are the window's frame), a route's own from
  `@/routes/<screen>/`. A file inside a folder imports its neighbours by path,
  never from a barrel: a barrel must never be imported by a file it re-exports.
- A primitive nothing in the app imports is not vendored: `scroll-area`,
  `drawer` and `dropdown-menu` were removed once pie's own components took their
  job.
- Transcript rendering: react-markdown + remark-gfm, virtualized (virtua), and
  `shiki` only through the lazy chunk of `src/lib/shiki-bundle.ts` — a
  highlighter never reaches the initial bundle; diffs get a dedicated renderer.
- The only way out of React is the Tauri `invoke` bridge in `src/lib/bridge/` —
  no fetch, no WebSocket, no Tauri event listeners outside the bridge, and no
  `@tauri-apps/plugin-*` import: anything the frontend needs from a plugin, Rust
  exports as a command.
- UI strings are English, inline — no i18n layer yet.
