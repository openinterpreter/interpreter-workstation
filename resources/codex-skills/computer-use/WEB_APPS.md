# Browser And Web App Computer Use

Use the same app-scoped `builtin-cua-driver` CLI surface for browser windows as
for native apps:

```bash
interpreter-app tools builtin-cua-driver get_app_state --json '{"app":"Google Chrome"}'
interpreter-app tools builtin-cua-driver click --json '{"app":"Google Chrome","element_index":"12"}'
interpreter-app tools builtin-cua-driver type_text --json '{"app":"Google Chrome","text":"hello"}'
```

On Windows command execution, call the same tools through the fixed CLI path:

```text
cmd.exe /c "%INTERPRETER_CLI_PATH%" tools builtin-cua-driver get_app_state --json "{\"app\":\"Microsoft Edge\"}"
```

## Route Selection

Use unified `builtin-interpreter` browser page tools for ordinary page
inventory, inspect, trace, click, type, select, and scroll work when the browser
tab is available through the Chrome extension. Use browser-control/`js_repl` for
advanced Playwright-in-tab work after an exact tab ref is available and
permission-checked. Use Computer Use for browser chrome, menus, permission
prompts, file pickers, downloads UI, native dialogs, and browser content that
the user explicitly wants handled through visual/native desktop interaction.

For Computer Use browser tasks:

1. Call `get_app_state({app})`.
2. Use visible `element_index` values when the target is exposed.
3. Use screenshot coordinates only when the screenshot shows a real target that
   AX/UIA does not expose.
4. After `click`, `type_text`, `press_key`, `scroll`, `drag`, `set_value`, or
   `perform_secondary_action`, call `get_app_state({app})` again before trusting
   old indices or coordinates.

Sparse AX/UIA is not proof that the tool is broken. Continue with screenshot
coordinates when the image is usable, or use unified browser page tools when an
extension-observed tab exists. Do not activate the browser, switch Spaces, or use
shell/PowerShell/GUI fallbacks unless the user explicitly asked for visible
foreground control.

## Background Expectations

The Computer Use tool is designed to target an app by name without making it
frontmost. If a browser action unexpectedly foregrounds the app, treat that as a
backend behavior to report and fix, not as a reason to switch to shell scripts or
direct OS automation.
