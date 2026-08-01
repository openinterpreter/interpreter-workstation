# Browser Form Tests

Standalone localhost form harness for testing Interpreter's browser-control path end to end through:

- the app's real headless agent runtime
- Interpreter `js_repl`
- bundled `playwright-core`
- the generated staged browser runtime in `resources/browser-extension-relay`
- a managed Chromium session launched with the staged extension loaded

`resources/browser-extension-relay` is not source. Edit:

- `apps/interpreter-extension/extension`
- `apps/interpreter-extension/playwriter`

then rebuild/restage before rerunning this harness.

This is intentionally closer to `form-tests` than to a browser-bridge smoke test:

- the harness serves a real browser form on localhost
- the app agent receives a normal task prompt
- the agent must use browser automation to open, fill, and submit the form
- the page/server grades the actual submitted values

Use this harness when you changed any of these layers:

- browser-bridge startup, staging, or packaging
- browser-control skill or prompt contract
- `js_repl` or bundled `playwright-core`
- headless app orchestration for browser control

The harness intentionally uses the staged deploy instead of the raw submodule output so it
exercises the same runtime shape the app packages and ships.

Do not use this as a substitute for:

- `pnpm run extension:test:integration` when you only need the submodule browser/relay regression layer
- the private overlay benchmark suite when you need full GUI/computer-use scoring instead of browser-control coverage

## Run

From the app repo root:

```bash
pnpm run browser-form-tests:auto
pnpm run browser-form-tests:auto -- --test contact-intake
pnpm run browser-form-tests:auto -- --test shipping-profile --browser-headless
pnpm run browser-form-tests:auto -- --skip-setup --keep-browser
pnpm run browser-form-tests:auto -- --help
```

Current case ids:

- `contact-intake`
- `shipping-profile`

## What It Does

1. Prepares the local runtime assets unless `--skip-setup` is used:
   - bundled Interpreter runtime
   - bundled Node for `js_repl`
   - bundled `js_repl` runtime payload with `playwright-core`
   - generated staged browser runtime under `resources/browser-extension-relay`
2. Starts a localhost form server.
3. Starts a headless Interpreter sidecar that owns the app-managed browser bridge.
4. Starts a managed Chromium / Chrome-for-Testing browser with the staged extension loaded.
5. Waits for the browser bridge and extension connection on `127.0.0.1:19988`.
6. Runs the real app headless agent task with a prompt that tells it to use `$browser-control` and `js_repl`.
7. Grades the form submission recorded by the localhost harness.

This does not require `pnpm dev`. The harness uses `pnpm headless` directly so it can own the relay and the task runtime inside one reproducible flow.

## Preconditions

- `OPENAI_API_KEY` must be set.
- `pnpm headless` must already be usable on the current machine.
- The machine must have a supported Chromium-family browser executable that the staged browser runtime can launch.
- If you use `--skip-setup`, `resources/js-repl-runtime` and `resources/browser-extension-relay` must already be current.

## Options

- `--skip-setup`
  - Skips runtime downloads and build steps. Use this only after a recent successful setup/build or when you explicitly prepared the staged assets yourself.
- `--test <id,id>`
  - Runs only the listed case ids.
- `--timeout-ms <ms>`
  - Sets the per-case agent timeout. Default: `180000`.
- `--browser-headless`
  - Forces the managed browser to run headless.
- `--keep-browser`
  - Leaves the managed browser process open after the run for visual inspection.
  - The harness still shuts down the localhost form server and the bridge-owner sidecar, so this is for post-run browser inspection, not for keeping browser control attached.

## Browser Session Selection

If your own Chrome session is attached to the local browser bridge at the same time as the harness-managed Chromium session, the agent may see multiple sessions.

The harness now reads `/extensions/status`, selects the live managed browser session, and
passes that exact stable key into the agent prompt.

That works, but the cleanest runs are still:

- do not attach your own Chrome extension session during the test
- disconnect it before running the harness

## Artifacts

Each run writes to:

- `browser-form-tests/test-output/<timestamp>--<id>/`

Useful files inside a run:

- `setup-download-oix.log`
- `setup-download-node.log`
- `setup-js-repl-runtime.log`
- `setup-browser-extension-relay.log`
- `relay-owner.log`
- `relay-owner-server.log`
- `browser-extension-relay.log`
- `browser-extension-relay-cdp.jsonl`
- `relay-ready.json`
- `managed-browser.json`
- `extension-status.json`
- `<case>-system.txt`
- `<case>-message.txt`
- `<case>-agent.log`
- `<case>-headless-server.log`
- `<case>-result.json`
- `<case>-evaluation.json`
- `cleanup-relay.log`
- `summary.json`

Notes:

- `setup-*.log` files exist only when setup runs.
- `browser-extension-relay.log` and `browser-extension-relay-cdp.jsonl` exist when the harness-owned sidecar starts the relay instead of reusing an already-running one.
- `summary.json` is the top-level pass/fail artifact for the whole run.
- `<case>-evaluation.json` is the quickest way to see whether a failure came from task completion or incorrect submitted values.

## Troubleshooting

- Fails immediately with `OPENAI_API_KEY is required`
  - Export `OPENAI_API_KEY` before running the harness.
- Times out waiting for browser-bridge readiness
  - Inspect `relay-owner.log`, `relay-owner-server.log`, and `browser-extension-relay.log`.
- Times out waiting for extension connection
  - Inspect `managed-browser.json` and `extension-status.json`.
  - Make sure the staged extension exists under `resources/browser-extension-relay/dist/extension`.
- Agent task completes with `completed: false`
  - Inspect `<case>-agent.log`, `<case>-headless-server.log`, and `<case>-result.json`.
- Form grading fails even though the agent ran
  - Inspect `<case>-evaluation.json` for the exact mismatched fields.

## Current Scope

This harness is for the browser-control path only. It does not use the overlay runtime or the Interpreter overlay form-surface contract.
