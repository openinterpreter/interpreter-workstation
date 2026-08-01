# Browser Extension Development

This repo currently keeps the browser-extension bridge in the Git submodule:

- `apps/interpreter-extension`

For now, keep that submodule close to upstream. Do app-side integration work in this repo and
extension/relay work inside the submodule repo.

The desktop app now stages a real bundled browser runtime under:

- `resources/browser-extension-relay`

and starts the local browser bridge automatically on app launch. The app root intentionally does
not expose a manual `extension:serve` command anymore. Normal app usage should not require manual
bridge startup.

## Source Of Truth

`resources/browser-extension-relay` is generated staging output. Do not edit it.

Edit the real source here:

- `apps/interpreter-extension/extension`
- `apps/interpreter-extension/playwriter`

Why the staged copy exists:

- the desktop app uses that deployed runtime in development and in packaged builds
- the browser-form harness uses the same deployed runtime shape
- this catches packaging/runtime drift earlier than pointing the app at raw submodule files

If you change the submodule source, rebuild/restage it with:

```bash
pnpm run extension:build
pnpm run ensure:browser-extension-relay-assets
```

The staged directory is gitignored on purpose and should be treated like build output.

## Why This Is Separate From The Overlay Benchmarks

The private benchmark suite exercises the overlay runtime against realistic GUI tasks.
The browser extension covers a different contract:

- Chrome/Chromium with the extension loaded
- relay server availability
- CDP visibility for approved tabs
- `playwright-core` connecting to the relay

The extension test path stays separate because it verifies a different runtime boundary.

## One-Time Setup

From the app repo root:

```bash
pnpm run extension:bootstrap
```

That does two things:

1. Initializes the `apps/interpreter-extension` submodule and its nested `playwright` submodule.
2. Runs the upstream bootstrap flow inside the submodule.

If you skip this step, the later build/test scripts will fail fast.

This does not add or update a Git remote for the upstream browser-runtime repo. Keep the build/setup path and the upstream-sync path separate.

## Upstream Browser Runtime Remote

`apps/interpreter-extension` uses:

- `origin` for the Open Interpreter fork
- `upstream` for the upstream browser-runtime repo

One-time manual setup:

```bash
git -C apps/interpreter-extension remote add upstream https://github.com/remorses/playwriter.git
git -C apps/interpreter-extension fetch upstream --tags --prune
```

If the `upstream` remote already exists, just fetch it:

```bash
pnpm run extension:upstream:fetch
```

Do not assume `origin` is the upstream browser-runtime repo. It is not.

## Root Commands

Run everything from the app repo root:

```bash
pnpm run extension:build
pnpm run extension:watch
pnpm run extension:reload
pnpm run extension:upstream:fetch
pnpm run extension:browser:start
pnpm run extension:test
pnpm run extension:test:integration
pnpm run extension:test:integration:full
pnpm run extension:verify
```

What each one does:

- `extension:build`
  - Builds the relay package and the Chrome extension using the submodule's upstream build flow.
- `extension:watch`
  - Runs the submodule watch flow for iterative extension/relay development.
- `extension:reload`
  - Rebuilds the submodule and opens the Chrome extensions page for the current extension ID.
- `extension:browser:start`
  - Starts a managed Chromium/Chrome-for-Testing instance with the bundled extension.
  - Run `extension:build` first so the extension dist exists.
  - This path also auto-starts the relay if needed.
- `extension:upstream:fetch`
  - Ensures the vendored `apps/interpreter-extension` repo has an `upstream` remote pointing at `https://github.com/remorses/playwriter.git`.
  - Fetches that upstream so you can inspect or rebase onto the latest upstream commits without retargeting `origin`.
- `extension:test`
  - Runs the full upstream submodule test suite.
- `extension:test:integration`
  - Runs the browser/relay smoke coverage that matters most for this app integration:
    - `src/extension-connection.test.ts`
    - `src/relay-navigation.test.ts`
  - This is the default app-facing integration check because it proves:
    - source-built extension loading
    - relay connectivity
    - Playwright-over-CDP page control
    - navigation/frame behavior through the relay
- `extension:test:integration:full`
  - Runs the larger browser/relay regression set from the submodule:
    - `src/extension-connection.test.ts`
    - `src/relay-core.test.ts`
    - `src/relay-navigation.test.ts`
    - `src/relay-session.test.ts`
    - `src/relay-state.test.ts`
    - `test/security.test.ts`
- `extension:verify`
  - Builds the pinned extension and relay runtime.
  - Restages `resources/browser-extension-relay` so the desktop app uses the same runtime shape.
  - Runs the focused deterministic Chromium extension integration suite.
  - Use this before and after Chrome extension or browser-control changes.

## Install Into Your Chrome

If you want this running in your own Chrome profile, use the unpacked extension flow.

### Local Unpacked Install

From the app repo root:

```bash
pnpm run extension:bootstrap
pnpm run dev
```

That starts the app, stages the bundled relay runtime, and starts the relay. The unpacked
extension files you want are in:

- `resources/browser-extension-relay/dist/extension`

That path is generated. If you are editing the extension or relay, change files under:

- `apps/interpreter-extension/extension`
- `apps/interpreter-extension/playwriter`

Then rebuild/restage. Do not patch `resources/browser-extension-relay` directly.

Then in Chrome:

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select:
   - `resources/browser-extension-relay/dist/extension`
5. Pin the extension if you want easy access from the toolbar
6. Open the target tab
7. Click the extension icon on that tab so it becomes exposed to the relay

At that point the desktop app or a local Playwright client can connect through:

- `http://127.0.0.1:19988`

Notes:

- For normal app development, the desktop app starts the local browser bridge automatically.
- If you truly need standalone bridge debugging while editing `apps/interpreter-extension`, run the
  submodule CLI from that repo directly. The app root intentionally does not wrap that flow in a
  top-level `pnpm` command.
- For local development, you do not need to pack or zip anything.
- If you rebuild with `pnpm run extension:build`, Chrome may need a manual `Reload` on the extension card in `chrome://extensions`.
- If you run `pnpm run extension:watch`, the output directory stays the same:
  - `apps/interpreter-extension/extension/dist`
  but Chrome still may need a manual reload after file changes.
- If you are actively editing extension source and want the submodule's live dist output instead of
  the app-staged runtime, load unpacked from:
  - `apps/interpreter-extension/extension/dist`
  The desktop app still runs the staged deploy under `resources/browser-extension-relay` on purpose.

### Managed Browser vs Your Chrome

There are two supported local flows:

- Managed browser:
  - `pnpm run extension:browser:start`
  - launches a dedicated Chromium/Chrome-for-Testing instance with the built extension already loaded
- Your own Chrome:
  - `pnpm run dev`
  - then load unpacked from `resources/browser-extension-relay/dist/extension`

Use the managed browser for automated tests and reproducible debugging.
Use your own Chrome when you want your normal profile, tabs, cookies, and extensions.

### Packed / Zip Builds

For local use, ignore this.

If you ever need a packaged extension artifact for store-style distribution, the submodule has a
release script that builds a release dist and zips it:

```bash
cd apps/interpreter-extension
pnpm run release
```

That produces:

- `apps/interpreter-extension/extension.zip`

But again, for your own Chrome during development, the right path is still:

- `apps/interpreter-extension/extension/dist`

## Dev-Friendly Automated Test Flow

Use this when you want to verify that the extension/relay stack can really control a browser in a
reproducible local setup:

```bash
pnpm run extension:bootstrap
pnpm run extension:verify
```

That verification path builds the pinned extension/runtime, restages the app's bundled relay assets,
and runs the deterministic submodule tests that cover the right layer:

- launch Chromium with the extension loaded
- toggle the extension on a tab
- connect with Playwright over CDP
- verify pages/frames/navigation remain visible through the relay
- verify the relay security path

That is the right automated test bed for the browser bridge itself.

## App-Level Browser-Control Harness

Use this when you need proof that Interpreter itself can drive a real browser through `$browser-control`, not just that the submodule relay tests pass.

```bash
pnpm run browser-form-tests:auto
pnpm run browser-form-tests:auto -- --test contact-intake
pnpm run browser-form-tests:auto -- --skip-setup --browser-headless
```

This harness:

- starts a localhost form server
- starts the app's headless runtime so it owns the relay
- launches a managed Chromium session with the staged extension
- runs a real agent task through `js_repl` and bundled `playwright-core`
- grades the submitted form values

Use it after changing:

- relay startup or packaging
- staged browser-extension assets
- browser-control skill behavior
- `js_repl` / `playwright-core` integration

Detailed commands, options, and artifact docs live in `browser-form-tests/README.md`.

## Manual Smoke With The App

Use this when you want to verify the app's `js_repl` + browser skill path against a live browser.

### Option A: Managed Chromium

```bash
pnpm run extension:bootstrap
pnpm run dev
pnpm run extension:browser:start
```

Then:

1. In the managed browser window, open the target site.
2. Click the extension icon on the tab you want to expose.
3. In the app, ask the agent to use the browser-control skill or directly use `js_repl`.

### Option B: Your Existing Chrome

```bash
pnpm run extension:bootstrap
pnpm run dev
```

Then:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Load unpacked from:
   - `resources/browser-extension-relay/dist/extension`
5. Open the target site in Chrome.
6. Click the extension icon on the tab you want to expose.
7. Use the app agent against that running browser tab.

## What The App Side Assumes

The current app integration assumes:

- The `builtin-js-repl` app tool server is available through `interpreter-app tools` (the persistent Node kernel is managed by the app's Express backend, not by the agent runtime).
- The bundled `js_repl` runtime (`resources/js-repl-runtime`) provides `playwright-core` and the kernel.
- The bundled `browser-control` skill is available to Interpreter.
- The desktop app starts the bundled relay automatically from `resources/browser-extension-relay`.
- If the relay cannot start, app startup continues and Interpreter logs the failure instead of showing a blocking startup error.
- Browser code uses normal Playwright-over-CDP:

```js
const { chromium } = await import("playwright-core");
const browser = await chromium.connectOverCDP("http://127.0.0.1:19988");
const context = browser.contexts()[0];
const page = context.pages()[0];
```

Current rule:

- do not call `browser.close()` when connected to the user's live browser

## Current Approval Model

Right now, the safe scope is still extension-level consent:

- user clicks the extension on a tab
- that tab becomes visible through the relay

App-level scoped approvals for:

- list tabs
- use tab X
- allow `google.com/*`
- allow opening a new tab only on an allowed domain

are not implemented yet. When that work starts, it should happen at the trusted browser boundary,
not inside the agent's raw `js_repl` code.

## Troubleshooting

- If the app cannot see any pages, make sure the app is running and the relay responds on `127.0.0.1:19988`.
- The app-managed relay log files live next to the current session log:
  - `browser-extension-relay.log`
  - `browser-extension-relay-cdp.jsonl`
- If `connectOverCDP` works but there are no useful pages, click the extension icon on the tab.
- If the relay behaves strangely, read the relay logs from the submodule CLI:
  - `pnpm --dir apps/interpreter-extension run cli -- logfile`
- If build/test commands fail after a fresh clone, rerun:
  - `pnpm run extension:bootstrap`
