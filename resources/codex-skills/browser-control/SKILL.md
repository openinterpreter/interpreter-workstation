---
name: browser-control
description: Use this skill when the user needs advanced Playwright control of an already running browser session through Interpreter's app-managed browser bridge and the `builtin-js-repl` `js_repl` tool, after simple browser page work cannot be handled by the unified `builtin-interpreter` browser page tools.
metadata:
  short-description: Advanced live-browser Playwright control
---

# Browser Control

Use this skill when the user needs advanced Playwright control of an already running browser session rather than launch a local dev browser from source.

For simple page inventory and element actions, prefer the unified browser page tools first:

- `interpreter-app tools builtin-interpreter interpreter_whole_computer_state_get --json '{}'`
- `interpreter-app tools builtin-interpreter interpreter_browser_page_inspect --json '{"tab_ref":"<tab_ref>"}'`
- the matching `builtin-interpreter` browser page trace/click/type/select/scroll tool using the exact `tab_ref`, `frame_id`, `ref_id`, and `target_identity` fields returned by inventory/inspect

Use this skill for advanced Playwright-in-tab work after you have an exact browser-control tab ref or session key, or when the simple `builtin-interpreter` page primitives cannot express the task.

This skill is for advanced live browser control:

- run browser-action JavaScript through the `js_repl` app tool: `interpreter-app tools builtin-js-repl js_repl --json '{"code":"..."}'`
- for multi-line JavaScript, prefer `--stdin-arg code`, which reads the raw JavaScript from stdin with no JSON escaping:

  ```bash
  interpreter-app tools builtin-js-repl js_repl --stdin-arg code <<'JS'
  globalThis.page = await globalThis.ensurePage();
  console.log(globalThis.page.url());
  JS
  ```

- actions that trigger navigation or slow network work can outlive the default execution timeout; pass `timeout_ms` in the same call (`--json '{"timeout_ms":300000}' --stdin-arg code <<'JS' ... JS`). A timed-out call keeps the kernel and `globalThis` state, and the action may still have completed in the background, so reread page state before retrying instead of repeating the action blindly

- when acting on the browser, put the JavaScript in the `code` argument of a `builtin-js-repl js_repl` call; do not answer with a fenced JavaScript block for the user to run, and do not run raw `node` instead
- use the unified `builtin-interpreter` browser page tools for ordinary page inspect/click/type/select/scroll tasks, and use this Browser Use-shaped browser-control path for advanced Playwright work instead of opening a new Interpreter in-app browser tab
- treat `js_repl` as a persistent JavaScript kernel: top-level `let`, `const`, `class`, and `function` names remain declared after each call in the same thread; `interpreter-app tools builtin-js-repl js_repl_reset --json '{}'` clears kernel state
- write every browser-control snippet so it can run more than once without `Identifier has already been declared`
- in the desktop app, assume Interpreter should already be running the local browser bridge
- import `interpreter-browser-control` with `await import("interpreter-browser-control")`; the helper imports `playwright-core` and exposes raw Playwright as `globalThis.playwright`, `globalThis.chromium`, and the live `globalThis.page`
- if the task already names a browser session key or browser-control tab ref, use it directly and skip discovery
- inspect the local browser-session status endpoint only when the task did not already tell you which session to use
- connect to Interpreter's browser-control bridge with `chromium.connectOverCDP(...)`
- reuse the existing pages from that connection
- do not call `browser.close()` on the user's live browser
- do not use Interpreter's built-in browser tools, workstation browser/email tabs, or `interpreter-app layout get|set` as substitutes for this workflow
- use Interpreter layout tools for files, workspace UI layout, and local app previews, not for controlling the user's browser
- if the user explicitly asks to try opening a website inside the Interpreter app, warn them first that the in-app browser is a separate session and they should not expect to be signed in there

Because `js_repl` persists across turns, all browser-control bootstrap code must be idempotent and should store long-lived state on `globalThis` rather than redeclaring top-level `let` or `const` bindings.

## Preconditions

- In the desktop app, Interpreter's browser bridge should already be running on `127.0.0.1:19988`.
- In non-desktop runtimes, ensure the browser bridge/server is running on `127.0.0.1:19988`.
- The user must already have at least one live browser tab exposed to Interpreter.
- `interpreter-app tools builtin-js-repl js_repl` must be available.

If those preconditions are not met, stop and tell the user what is missing.

## Hard Rules

- `js_repl` needs no discovery: call `interpreter-app tools builtin-js-repl js_repl` directly instead of inspecting `interpreter-app tools list` first.
- Never provide browser-control JavaScript as visible Markdown instead of running it through `builtin-js-repl js_repl`.
- Never use web search, capability probing, or generic discovery as a substitute for the `js_repl` browser-control path.
- Never use Interpreter workstation context browser tabs or email tabs as evidence of the user's live external browser state.
- Never use `interpreter-app layout get|set` to open or manipulate an external website as a workaround for browser control.
- Never fall back to Interpreter's legacy built-in browser tool server for this skill.
- If `interpreter-app tools builtin-js-repl js_repl` is unavailable, say that directly instead of trying a different browser path.
- Do not assume a fresh `js_repl` runtime. Re-running bootstrap code must be safe.
- Do not declare top-level browser-control variables with `const` or `let`, including imports, `browser`, `context`, `page`, `tab`, or `selectedBrowserSessionId`.

## REPL Safety

- Prefer `globalThis.foo ??= ...` for long-lived browser-control state.
- Define helpers with `globalThis.helper ??= async function helper() { ... }` so follow-up turns can reuse them safely.
- Put imported modules on `globalThis`, for example `globalThis.browserControlRuntime ??= await import("interpreter-browser-control")`.
- Do not redeclare top-level `let` or `const` bindings like `browser`, `page`, or `browserBridgeHttpEndpoint` across turns.
- Do not write top-level follow-up snippets that rebind `page` from `globalThis.ensurePage()` across turns. Persist the handle on `globalThis.page` and act through that instead.
- Do not reference `selectedBrowserSessionId` without the `globalThis.` prefix.
- If a handle is missing or stale, repair the `globalThis` state with the idempotent bootstrap instead of pasting a second conflicting bootstrap.

## Default Workflow

1. Run the browser-control JavaScript through `interpreter-app tools builtin-js-repl js_repl`. The JavaScript belongs in that tool call's `code` argument, not in the assistant message.
2. Set `globalThis.selectedBrowserSessionId` first if the task already names the exact browser session key or browser-control tab ref.
3. Run the idempotent bootstrap once so `agent.browser`, `display`, and `globalThis.ensurePage()` exist.
4. Inspect `/extensions/status` only if the task did not already name the session.
5. Call `globalThis.page = await globalThis.ensurePage();`.
6. Prefer the Browser Use-shaped `agent.browser` primitives for Playwright-backed observation and tab management, and use normal Playwright APIs on `globalThis.page` when you need raw Playwright.
7. Keep follow-up turns small and reuse the existing globals.
8. Leave the browser running when finished.

## Bootstrap

```javascript
globalThis.selectedBrowserSessionId ??= undefined;
globalThis.page ??= undefined;
globalThis.browserControlRuntime ??= await import("interpreter-browser-control");

await globalThis.browserControlRuntime.setupInterpreterBrowserControl({
  globals: globalThis,
  sessionId: globalThis.selectedBrowserSessionId,
});

globalThis.page = await globalThis.ensurePage();
globalThis.tab = await agent.browser.tabs.selected();

console.log({
  browserSessionId: globalThis.selectedBrowserSessionId,
  title: await globalThis.page.title().catch(() => ""),
  url: globalThis.page.url(),
});
```

## Usage Notes

- Keep the first `js_repl` call small. Do not paste a giant helper when the task already names the session you should use.
- Separate session selection from bootstrap:
  `globalThis.selectedBrowserSessionId = "<stableKey-or-tab-ref>";`
  then bootstrap if needed,
  then `globalThis.page = await globalThis.ensurePage();`.
- If the task already tells you which session or tab ref to use, set `globalThis.selectedBrowserSessionId = "<that value>"` before running `globalThis.ensurePage()`. Use the exact `tab_ref` from `interpreter_whole_computer_state_get` when available, including refs shaped like `<profile-key>:chrome-tab:<chrome-tab-id>`; when browser policy allows that page, the runtime claims an observed tab for Playwright control and selects the matching page. Use `browser_profile_policy_id` / `extension_stable_key` or an exact `tab_ref` as the control identity; `browser_profile_name` and `browser_profile_path` are display context, not CDP session keys.
- The bootstrap installs Browser Use-shaped globals:
  - `agent.browser.nameSession(name)`
  - `agent.browser.tabs.selected()`, `list()`, `get(id)`, and `new()`
  - `agent.browser.user.openTabs()`
  - tab methods: `goto(url)`, `reload()`, `back()`, `forward()`, `close()`, `title()`, and `url()`
  - `tab.playwright` methods matching the Browser Use skill API such as `domSnapshot()`, `screenshot()`, `getByRole()`, `getByText()`, `locator()`, `waitForLoadState()`, and `waitForURL()`
  - `tab.cua` methods matching the Browser Use skill API such as `click()`, `double_click()`, `drag()`, `get_visible_screenshot()`, `keypress()`, `move()`, `scroll()`, and `type()`
  - `tab.dev.logs()` and `tab.clipboard.*`
- Screenshots returned by `tab.playwright.screenshot()` and `tab.cua.get_visible_screenshot()` are image objects with `toBase64()`. Use `await display(image)` to save them; the tool result reports the saved image path, which you can open with `view_image` when you need to see it.
- Raw Playwright is also available: use `globalThis.page` for the live page, `globalThis.chromium` for the browser type, and `globalThis.playwright` for the imported `playwright-core` module.
- Write ordinary Playwright code after connecting.
- After bootstrap, follow-up turns should usually only set the session if needed, call `globalThis.ensurePage()`, and act.
- Prefer this follow-up shape:
  `globalThis.page = await globalThis.ensurePage();`
  then `await globalThis.page.locator(...).click();`
- If a turn starts fresh or the kernel reset, rerun the bootstrap so `globalThis.ensurePage()` exists again before touching `page`.
- If multiple browser sessions are connected and the task did not already choose one, stop and ask the user for the desired `stableKey` or exact tab ref.
- Prefer `getByRole`, `locator`, and explicit waits when needed.
- If multiple pages exist, inspect `context.pages()` and choose the correct one explicitly.
- If the user wants a specific tab, confirm which page URL/title you are acting on before doing destructive actions.
- For search, lookup, record-review, or form workflows, reread the page after each submit/navigation before deciding the result. Verify that the intended field accepted the intended value, that the page is in the expected search/results/detail state, and that the result text supports the conclusion.
- Distinguish "no matching record found" from "record found, but requested content not found inside it." Only report no matching record after the visible search results or detail page confirms there is no matching record for the identifier you submitted.
- If the browser bridge disconnects or no pages are present, stop and ask the user to fix the browser side. In the desktop app, that usually means confirming the app is still running and at least one tab is already shared with Interpreter.
- If browser actions fail because of Settings > Browser, do not try to edit those settings yourself. You may read `browserAccessPolicy` via `interpreter_settings_get`, but only the user can change it.

## Search And Form Result Verification

Before writing a file or giving a final answer from a browser search or form:

- Read the current URL/title and visible page text after the action.
- Confirm the target field was the field the user intended, not a nearby filter, grouping, or unrelated control.
- Confirm the submitted value is still present in the target field or reflected on the result/detail page when the app exposes it.
- If the page is still on a filter, grouping, stale result, or unrelated detail page, navigate back to the clean search form and retry from the verified field instead of continuing.
- Keep outcome labels precise: use one label for "no matching record found" and a different label for "matching record exists, requested item not found."

### Minimal Follow-up Turn

```javascript
globalThis.selectedBrowserSessionId = "<stableKey-or-tab-ref>";
globalThis.page = await globalThis.ensurePage();
globalThis.tab = await agent.browser.tabs.selected();
await globalThis.tab.goto("https://www.wellsfargo.com/");
console.log({
  title: await globalThis.tab.title(),
  url: await globalThis.tab.url(),
});
```

### Browser Use-Shaped Example

```javascript
await agent.browser.nameSession("Browser task");
globalThis.tab = await agent.browser.tabs.selected();
console.log(await globalThis.tab.playwright.domSnapshot());
await display(await globalThis.tab.cua.get_visible_screenshot());
```

### Troubleshooting

- `Identifier has already been declared`: reuse `globalThis` state and do not redeclare top-level names like `const page = ...` in follow-up turns.
- `X is not defined`: initialize that value on `globalThis` or rerun the idempotent bootstrap. If the missing value is `selectedBrowserSessionId`, use `globalThis.selectedBrowserSessionId`.
- Bridge connected but no page: ask the user to make a browser tab accessible to Interpreter first.
- Multiple sessions found: ask the user which `stableKey` to use, then set `globalThis.selectedBrowserSessionId` explicitly.

## Disconnecting

Do not close the user's browser. If you need to discard local handles, do this instead:

```javascript
globalThis.page = undefined;
globalThis.context = undefined;
globalThis.browser = undefined;
```

## Scope

This skill assumes normal Playwright-over-CDP usage. Do not assume extension-specific fork APIs or internal helper utilities unless they are explicitly available in the runtime.
