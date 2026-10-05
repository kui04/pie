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

- shadcn-ui (Radix + Tailwind) is the base; add via `shadcn add`. Generated
  components are ours to adapt deliberately — mobile tuning goes in the CVA
  variants — but never hand-write a primitive shadcn already provides; pull
  upstream fixes with `shadcn add <name> --diff`. Icons: lucide-react.
- Transcript rendering: react-markdown + remark-gfm, virtualized (virtua), no
  heavy highlighters (shiki) in the initial bundle; diffs get a dedicated
  renderer.
- The only way out of React is the Tauri `invoke` bridge in `src/lib/bridge/` —
  no fetch, no WebSocket, no Tauri event listeners outside the bridge, and no
  `@tauri-apps/plugin-*` import: anything the frontend needs from a plugin, Rust
  exports as a command.
- UI strings are English, inline — no i18n layer yet.
