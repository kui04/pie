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
- Respect `prefers-color-scheme` and `prefers-reduced-motion`: shadcn themes for
  light/dark, no unconditional animation.

## Components

- shadcn-ui (Radix + Tailwind) is the base; add via `shadcn add` and only
  hand-roll what shadcn has no answer for. Icons: lucide-react.
- Transcript rendering: react-markdown + remark-gfm, virtualized (virtua), no
  heavy highlighters (shiki) in the initial bundle; diffs get a dedicated
  renderer.
- The only way out of React is the Tauri `invoke` bridge in `src/lib/bridge.ts`
  — no fetch, no WebSocket, no Tauri event listeners outside the bridge.
- UI strings are English, inline — no i18n layer yet.
