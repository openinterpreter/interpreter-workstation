# Computer Use Verification

CUA is one product contract with platform-specific backends. Verify it as one thing.

## Acceptance vs Diagnostics

Agent E2E is the acceptance layer. These tests ask an actual agent to do a user task, then grade app state. Passing primitive tool calls is not enough.

Primitive CLI smoke is the diagnostics layer. These tests call `interpreter-app tools builtin-cua-driver ...` directly through the real CLI transport. They prove the tool server, approval routing, permissions, and native backend are working.

Do not replace agent E2E with direct handler calls, mocked calls, or direct backend imports.

## Main Commands

Run the platform suite on the current machine:

```bash
pnpm run test:cua
```

Run it in the Windows VM from the macOS checkout:

```bash
pnpm run winvm:workspace:run -- "pnpm run test:cua"
```

Run individual macOS checks:

```bash
pnpm run test:cua:agent:web
pnpm run test:mac-cua-driver
```

Run individual Windows checks:

```bash
pnpm run winvm:workspace:run -- "pnpm run test:win-cua-chromium"
pnpm run winvm:workspace:run -- "pnpm run test:win-cua-agent-calculator"
pnpm run winvm:workspace:run -- "pnpm run test:win-cua-driver"
```

Live agent tests require `OPENAI_API_KEY`. The Windows VM helper passes provider keys through when present.

## What The Suite Proves

macOS agent web app:

- Starts a real local browser form.
- Asks the agent to use `$computer-use`.
- Requires the normal-user web-app route from `WEB_APPS.md`: browser-control if available, otherwise `get_app_state({app})` plus app-scoped click/type against Chrome.
- Grades the real form submission received by the local HTTP server.

macOS native primitive app:

- Builds and opens a native fixture app.
- Calls `builtin-cua-driver` only through `interpreter-app tools ...`.
- Fills fields, toggles controls, handles a native file picker, and saves.
- Verifies the fixture state file.

Windows agent native app:

- Asks the agent to use `$computer-use`.
- Requires the agent to use `builtin-cua-driver` through the CLI.
- Requires the agent to use the app-scoped Computer Use surface to make Calculator visibly display `42`.
- Rejects shell launch shortcuts.

Windows Chromium web app:

- Starts a real local web form in Microsoft Edge, the Chromium-family browser installed in the Windows VM.
- Puts a separate sentinel window in the foreground, then targets Edge by app name.
- Verifies `get_app_state({app:"Microsoft Edge"})` returns enough state for the agent to reason from the app-scoped Computer Use surface.
- Fills and submits the page with app-scoped `click` plus `type_text`, then verifies the HTTP form submission while the sentinel remains foreground.

Windows native primitive app:

- Calls the Windows CUA backend directly through its smoke harness.
- Exercises UIA/HWND background control, screenshots, text, document text fields, keys, button/radio/checkbox clicks, cursor overlay, recording, and final submit while a separate sentinel window remains foreground.

Window positioning, focus, and lifecycle:

- `set_window_bounds` is a macOS and Windows Computer Use contract today.
- `focus_window` is a macOS and Windows Computer Use contract today.
- `minimize_window`, `restore_window`, and `maximize_window` are macOS Computer Use contracts today.
- Model-facing calls must pass the normalized `target_identity` object returned by `list_windows`, not raw backend `pid`/`window_id` fields. Native backend ids stay inside the app tool boundary.
- On Windows, the UIA bridge must resolve the exact `window_id`, call the Windows window-positioning primitive once, and fail loudly with the real backend error if the move/resize fails.
- Windows parity must be verified through the real Windows CUA CLI path against an instrumented target before it counts as full platform proof in the ambitious plan; the current full proof command is `pnpm run winvm:workspace:run -- "pnpm run test:win-cua-driver"`.

## Web App Rule

For browser-rendered apps, the agent must not treat sparse AX as generic CUA failure.

Chrome-family page work should route in this order:

1. Browser-control for an observed or claimed Chrome tab.
2. `get_app_state({app})` through `interpreter-app tools builtin-cua-driver`.
3. App-scoped `click` with an `element_index` when the target is exposed.
4. App-scoped screenshot-coordinate `click` plus `type_text` when the screenshot shows the target but AX/UIA does not expose a useful element.
5. `press_key`, `scroll`, `set_value`, or `perform_secondary_action` only when the visible state makes the action appropriate.

If `get_app_state` returns a sparse tree but a usable screenshot, continue with coordinates or browser-control. Do not activate Chrome or switch Spaces unless the user explicitly asked for visible foreground control.

## Adding Coverage

Add new CUA tests in this order:

1. Manually prove the task with `interpreter-app tools builtin-cua-driver ...`.
2. Add a primitive CLI smoke only if it preserves a useful backend invariant.
3. Add or update an agent E2E that asks the model to do the task and grades the resulting app state.

Keep web app and native app coverage separate inside the suite, but run them through the same `pnpm run test:cua` entrypoint.
