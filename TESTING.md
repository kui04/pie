# Testing map

This file is the one place to decide where a test belongs. The end-to-end
catalog is [`e2e/CASES.md`](e2e/CASES.md); the host setup and commands are in
[`e2e/README.md`](e2e/README.md); the session fixtures are described in
[`src-tauri/tests/fixtures/README.md`](src-tauri/tests/fixtures/README.md).

## Layers

| Layer                 | Command            | Location                                 | Owns                                                                      | Does not own                                       |
| --------------------- | ------------------ | ---------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| Frontend unit/UI      | `pnpm test`        | `src/**/__tests__`                       | React components, hooks, machines, transcript logic, local UI state       | Rust processes, SSH, real files, the desktop shell |
| Rust unit/integration | `pnpm rust-test`   | inline `#[cfg(test)]`, `src-tauri/tests` | Parsing, state, framing, session stores, host and channel logic           | The WebView and its rendered behavior              |
| Host environment      | `pnpm e2e:env`     | `e2e/verify-host.sh`, `e2e/lib`          | Docker host, SSH, pi version, packages, fixtures, mock determinism        | The app UI                                         |
| Android E2E           | `pnpm e2e:android` | `e2e/android`                            | The full Android debug app over adb and the WebView DevTools protocol     | Desktop-only windows and native pickers            |
| Linux desktop E2E     | `pnpm e2e:linux`   | `e2e/linux`                              | The full desktop debug binary through tauri-driver, WebKitWebDriver, Xvfb | Native file dialogs and real-model acceptance      |
| Real acceptance       | `pnpm e2e:real`    | `e2e/android/run.mjs`                    | Structural checks against a real provider                                 | Model wording as an oracle                         |
| Manual                | see `CASES.md`     | `e2e/CASES.md`                           | Native dialogs, visual quality, performance, destructive recovery         | Anything already covered below                     |

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

## Current inventory

As of 2026-11-03:

- Vitest: 72 files, 674 tests.
- Rust: 209 tests, 2 ignored live tests.
- E2E: 19 Android automatic cases, 4 Linux automatic smoke cases, 9 host checks.
- Fixtures: 14 session files under `mock`, `edge`, and `real`.
- Largest frontend test files: `ChatScreen.test.tsx` (37 tests),
  `DirectoryPicker.test.tsx` (30), `Composer.test.tsx` (28),
  `useSession.test.tsx` (27), `ConnectScreen.test.tsx` (24),
  `SessionSidebar.test.tsx` (24).
- Largest E2E files: `e2e/android/run.mjs` (19 cases) and `e2e/linux/run.mjs` (4
  cases).

The large files are candidates for splitting by behavior. File size alone is not
a reason to split; navigation and shared setup are.

## Case IDs and names

- A test name states the behavior: "a rejected password leaves the gate usable".
- One test checks one behavior. Several assertions may serve that behavior.
- A file or `describe` block names the feature or state, not the test type.
- E2E behavior IDs are stable: `CONN`, `SESS`, `RUN`, `MGMT`, `ERR`, `SEC`,
  `NF`.
- A platform column says where the behavior runs. Do not create a new behavior
  ID for a platform-specific copy.
- A composed smoke case lists the behavior IDs it covers. For example, the Linux
  `L-01` covers `CONN-03` and `SESS-01`. `L-01` is an executable smoke case, not
  a new requirement.
- Fixtures are named by scenario. The fixture README is the manifest.

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

## Cleanup order

1. Keep this map and the E2E catalog current. **Done.**
2. Move tests and stories to mirror the component layout, whole files, with no
   content split. **Done for the chat and dialog trees.**
3. Split the largest frontend test files by behavior, when navigation needs it.
4. Split the Android runner into case modules and extract platform-neutral UI
   actions.
5. Replace the Linux smoke IDs' duplicate names with `covers` metadata and add
   priority tags.
6. Move manual cases to a checklist with steps and a last-verified date.
7. Add slow/manual tags to commands and CI stages.

Do not move all Rust tests to `src-tauri/tests/`; inline unit tests are the Rust
convention for private code. Use `src-tauri/tests/` only for public integration
boundaries.

## Manual and known gaps

Manual coverage stays for native file dialogs, window-manager behavior, visual
quality, and performance. The Linux suite does not drive the native file
chooser. The real-model suite checks structure, not the model's words. The
Android suite cannot prove Linux WebKitGTK rendering or desktop window behavior.
