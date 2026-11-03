# Testing rules — apply to every test and story

This file is the one place to decide where a test belongs. The end-to-end
catalog is [`e2e/CASES.md`](../../e2e/CASES.md); the host setup and commands are
in [`e2e/AGENTS.md`](../../e2e/AGENTS.md); the session fixtures are described in
[`src-tauri/tests/fixtures/AGENTS.md`](../../src-tauri/tests/fixtures/AGENTS.md).

## Layers

| Layer                 | Command            | Location                                 | Owns                                                                                   | Does not own                                       |
| --------------------- | ------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Frontend unit/UI      | `pnpm test`        | `src/**/__tests__`                       | React components, hooks, machines, transcript logic, local UI state                    | Rust processes, SSH, real files, the desktop shell |
| Rust unit/integration | `pnpm rust-test`   | inline `#[cfg(test)]`, `src-tauri/tests` | Parsing, state, framing, session stores, host and channel logic                        | The WebView and its rendered behavior              |
| Host environment      | `pnpm e2e:env`     | `e2e/verify-host.sh`, `e2e/lib`          | Docker host, SSH, pi version, packages, fixtures, mock determinism                     | The app UI                                         |
| Android E2E           | `pnpm e2e:android` | `e2e/runners/android`                    | The full Android debug app over adb and the WebView DevTools protocol                  | Desktop-only windows and native pickers            |
| Linux desktop E2E     | `pnpm e2e:linux`   | `e2e/runners/linux`                      | The full desktop debug binary through WebdriverIO, tauri-driver, WebKitWebDriver, Xvfb | Native file dialogs and real-model acceptance      |
| Real acceptance       | `pnpm e2e:real`    | `e2e/cases/real.mjs`                     | Structural checks against a real provider                                              | Model wording as an oracle                         |
| Manual                | see `CASES.md`     | `e2e/CASES.md`                           | Native dialogs, visual quality, performance, destructive recovery                      | Anything already covered below                     |

## Where a new test belongs

Use the lowest layer that can fail for the reason under test.

1. Pure logic, a parser, a reducer, or a state machine: Rust or Vitest unit
   test.
2. A button, form, menu, scroll pane, or visual state: component test.
3. A process, SSH channel, file system, or session file boundary: Rust test.
4. A behavior that needs the real app, the real Tauri bridge, or both platforms:
   E2E.
5. A native dialog, window-manager behavior, visual judgment, or performance
   budget: manual, recorded in the catalog.

Do not test the same behavior at two layers unless the extra layer checks a
different failure. A component test that already proves the menu opens does not
need an E2E duplicate; an E2E case should prove the boundary that the component
test cannot reach.

## Case IDs and names

- A test name states the behavior: "a rejected password leaves the gate usable".
- One test checks one behavior. Several assertions may serve that behavior.
- A file or `describe` block names the feature or state, not the test type.
- E2E behavior IDs are stable: `CONN`, `SESS`, `RUN`, `MGMT`, `ERR`, `SEC`,
  `NF`.
- A platform column says where the behavior runs. Do not create a new behavior
  ID for a platform-specific copy.
- An automatic case runs on every platform named by its `platforms` metadata.
  Android and Linux run the same behavior cases; a truly platform-specific case
  names only its platforms.
- Fixtures are named by scenario. The fixtures' `AGENTS.md` is the manifest.

## Test and story layout

Tests and stories mirror the component directory:

```text
src/routes/chat/composer/Composer.tsx
src/routes/chat/composer/__tests__/Composer.test.tsx
src/routes/chat/composer/__stories__/Composer.stories.tsx
```

A component at the route or component root keeps its tests in that root's
`__tests__`/`__stories__` directory. Do not flatten nested components into one
route-level test directory. Move a file whole; do not split a test only to make
the layout look mirrored. Split by behavior later, when the file is hard to
navigate.

Do not move all Rust tests to `src-tauri/tests/`; inline unit tests are the Rust
convention for private code. Use `src-tauri/tests/` only for public integration
boundaries.

## Adding or changing a test

1. Name the behavior and the layer that can prove it.
2. Check `e2e/CASES.md` before adding an E2E case; do not duplicate a
   lower-layer test.
3. Add the case to the catalog with its platform, automation, and priority.
4. Use the existing helpers and fixtures before adding a new one.
5. Run the narrow command while iterating, then the layer's full command.
6. For a bug, keep the regression test that failed before the fix.
7. Mark slow, flaky, or manual tests explicitly; do not hide a failure behind a
   retry.

## Coverage limits

Manual coverage stays for native file dialogs, window-manager behavior, visual
quality, and performance. The Linux suite does not drive the native file
chooser. The real-model suite checks structure, not the model's words. The
Android suite cannot prove Linux WebKitGTK rendering or desktop window behavior;
the Linux suite cannot prove Android WebView or native picker behavior.

## Open work

The plan, not a request: do not start one unasked.

- Split the largest frontend suites by behavior, when navigation needs it.
- Migrate Android from the CDP adapter to Appium under the same WebdriverIO
  runner.
- Move the manual cases to a checklist with steps and a last-verified date.
- Add slow and manual tags to the commands and the stages that run them.
