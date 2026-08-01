import { describe, expect, test } from 'bun:test';

import {
  getMainAgentBaseInstructions,
  getMainAgentDeveloperPrompt,
} from './mainAgentPrompt';

describe('mainAgentPrompt', () => {
  test('base instructions carry stable Interpreter product policy', () => {
    const baseInstructions = getMainAgentBaseInstructions();

    expect(baseInstructions.length).toBeLessThan(18000);
    expect(baseInstructions).toContain('## Core behavior');
    expect(baseInstructions).toContain('You are Interpreter, a desktop agent.');
    expect(baseInstructions).toContain('Plan explicitly for substantial multi-step work. For straightforward tasks, act directly.');
    expect(baseInstructions).toContain('For substantial deliverables, call `update_plan` before the main authoring pass');
    expect(baseInstructions).toContain('Before answering, compare the produced artifact against every checklist item.');
    expect(baseInstructions).toContain('File existence, openability, render checks, and spot checks are necessary but not sufficient.');
    expect(baseInstructions).toContain("Reply in the same language as the user's latest message unless they ask for another language.");
    expect(baseInstructions).toContain('Use `update_plan` for non-trivial multi-step work');
    expect(baseInstructions).toContain('Wait for any file-mutation command or tool to complete before issuing verification reads, recalc calls, or refreshes.');
    expect(baseInstructions).toContain('Do not use shell commands, AppleScript, AppKit, Quartz, `open`, `osascript`, `screencapture`, or ad hoc Python to inspect or control desktop GUI state');
    expect(baseInstructions).toContain('When you create, edit, or export user-facing files, end the final answer with markdown links to the delivered files.');
    expect(baseInstructions).toContain('These links are the delivery mechanism.');
    expect(baseInstructions).toContain('for spreadsheets, the primary path is cohesive code execution guided by the spreadsheet skill');
    expect(baseInstructions).toContain('Treat refresh/recalc as mandatory post-edit hygiene, not optional polish.');
    expect(baseInstructions).toContain('reopen the saved file and verify formulas, values, sheet names, ranges, and styles');
    expect(baseInstructions).toContain('call `interpreter-app tools builtin-interpreter interpreter_refresh_file ...` once after the write completes');
    expect(baseInstructions).not.toContain('Before grouped tool actions or large edits');
    expect(baseInstructions).not.toContain('If the exact builtin or MCP tool is present, call it directly');
  });

  test('developer prompt is CLI-only by default for Interpreter app tools', () => {
    const developerPrompt = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
      { platform: 'win32' },
    );

    expect(developerPrompt.length).toBeLessThan(24000);
    expect(developerPrompt).toContain('Current selected model ID: "gpt-5.4-nano"');
    expect(developerPrompt).not.toContain('You are Interpreter, a desktop agent.');
    expect(developerPrompt).not.toContain('Plan explicitly for substantial multi-step work. For straightforward tasks, act directly.');
    expect(developerPrompt).not.toContain('Before grouped tool actions or large edits');
    expect(developerPrompt).not.toContain('For single-file office edits, do not send a plan or tool-choice message first');
    expect(developerPrompt).not.toContain('If the exact builtin or MCP tool is present, call it directly');
    expect(developerPrompt).toContain('App tools are available through the `interpreter-app` CLI command on `PATH`.');
    expect(developerPrompt).toContain('`$INTERPRETER_CLI_PATH` is available for environments that need an explicit executable form (/tmp/headless-cli/interpreter-app). Do not derive it from `$HOME`.');
    expect(developerPrompt).toContain('(/tmp/headless-cli/interpreter-app)');
    expect(developerPrompt).toContain('For app-tool workflows, start with `interpreter-app --help` when the exact command shape is unclear; skip this for browser-control tasks; the browser-control skill names the exact `builtin-js-repl` commands.');
    expect(developerPrompt).toContain('For settings, start with `interpreter-app config --help`');
    expect(developerPrompt).toContain('Top-level tools list does not list individual Interpreter app tools.');
    expect(developerPrompt).toContain('Prefer `interpreter-app tools find <query>` when the likely tool is clear but the host server is not.');
    expect(developerPrompt).toContain('Many built-in tools live on shared servers such as `builtin-interpreter`.');
    expect(developerPrompt).toContain('For workspace/UI/vault tools, inspect `builtin-interpreter` first.');
    expect(developerPrompt).toContain('Interpreter workstation tools are CLI-only for the model by default.');
    expect(developerPrompt).toContain('Use `interpreter-app` for Interpreter app-tool discovery and execution.');
    expect(developerPrompt).toContain('Skills are workflow instructions, not callable tools.');
    expect(developerPrompt).toContain('Never emit a tool call named after a skill such as `computer-use`, `doc`, `Excel`, `PowerPoint`, `pdf`, or `settings`');
    expect(developerPrompt).toContain('do not emit direct tool calls such as `builtin-cua-driver__get_app_state`, `builtin-docx__read_docx`, or `builtin-pdf__read_pdf` unless those exact tools are visibly injected');
    expect(developerPrompt).toContain('Use the OIX shell tool for `interpreter-app` discovery, exact `--help` checks, Interpreter app-tool execution, and ordinary shell/file work only');
    expect(developerPrompt).toContain('The OIX shell tool is a command surface. It cannot call native runtime tools by name.');
    expect(developerPrompt).toContain('The default OIX harness calls it `exec_command`; another selected harness may rename it');
    expect(developerPrompt).toContain('Do not run bare commands named `js_repl`, `apply_patch`, or other non-command capabilities.');
    expect(developerPrompt).toContain('`js_repl` runs JavaScript in a persistent Node kernel and lives on the `builtin-js-repl` server');
    expect(developerPrompt).toContain('To reveal a path in Finder/File Explorer/file manager, use `interpreter-app tools builtin-interpreter interpreter_show_in_folder --json');
    expect(developerPrompt).toContain('Use `interpreter-app config get|set` for persistent settings, `interpreter-app layout get|set` for live Interpreter layout such as file tabs, local app previews, and workspace UI state');
    expect(developerPrompt).toContain('Do not use layout tools as a browser-control substitute.');
    expect(developerPrompt).toContain('Do not use app-tool discovery for native runtime capabilities such as `apply_patch` or shell execution.');
    expect(developerPrompt).not.toContain('Skills describe preferred workflows, not proof that a tool is callable in the current session.');
    expect(developerPrompt).toContain('For office files, prefer the matching Interpreter app tool path before generic shell or Python fallback.');
    expect(developerPrompt).toContain('A `commandExecution` item without a completion event is still running.');
    expect(developerPrompt).toContain('`js_repl` needs no discovery: call `interpreter-app tools builtin-js-repl js_repl --json \'{"code":"..."}\'` directly');
    expect(developerPrompt).toContain('Use `interpreter-app config get|set` for persistent settings');
    expect(developerPrompt).toContain('Call tools with `interpreter-app tools <server-id> <tool-name> --json \'<json-object>\'`');
    expect(developerPrompt).toContain('For MCP installs, inspect `interpreter-app tools builtin-mcp-management mcp_add_server --help` and use that schema directly.');
    expect(developerPrompt).toContain('After adding, updating, removing, or toggling an MCP server, call `interpreter-app tools builtin-mcp-management mcp_refresh_tools --json');
    expect(developerPrompt).toContain('MCP tools remain CLI-only; do not look for native `mcp__...` tool names');
    expect(developerPrompt).toContain('do not manually run the MCP stdio server from shell as a workaround.');
    expect(developerPrompt).toContain('For local stdio MCPs that download packages on first run, use `startup_timeout_sec` when startup times out');
    expect(developerPrompt).toContain('Do not assume Node, npm, or npx is installed or bundled.');
    expect(developerPrompt).toContain('install Node/npm through the OS package manager with normal command approval');
    expect(developerPrompt).toContain('If the user gives a command like `npx ...`, treat it as a stdio MCP and split it into `command` plus `args`.');
    expect(developerPrompt).toContain('## Native desktop computer use');
    expect(developerPrompt).toContain('Native desktop computer-use tasks are `computer-use` skill-first.');
    expect(developerPrompt).toContain('For the first native desktop action, read `computer-use` `SKILL.md` if it is not already loaded');
    expect(developerPrompt).toContain('builtin-cua-driver launch_app --json');
    expect(developerPrompt).toContain('cmd.exe /c "%INTERPRETER_CLI_PATH%" tools builtin-cua-driver get_app_state --json');
    expect(developerPrompt).toContain('Use `builtin-cua-driver` through Interpreter\'s normal CLI transport: `interpreter-app tools builtin-cua-driver <tool-name> --json');
    expect(developerPrompt).toContain('Never use `Start-Process`, shell app launch, raw Windows UI Automation scripts, PowerShell window enumeration, or ad hoc Python as a desktop-control fallback.');
    expect(developerPrompt).toContain('Do not claim sandboxing blocks computer use unless `builtin-cua-driver` itself reports a sandbox error.');
    expect(developerPrompt).not.toContain('Launch apps with `launch_app`');
    expect(developerPrompt).toContain('The Computer Use tool surface is app-scoped on every supported desktop platform: `list_apps`, `launch_app`, `get_app_state`, `get_ui_elements`, `click`, `drag`, `press_key`, `scroll`, `set_value`, `type_text`, and `perform_secondary_action`.');
    expect(developerPrompt).toContain('For Electron, Chromium, and web-rendered desktop apps, treat `HTML content`, `webarea`, sparse UIA trees, or missing settable fields as ordinary Computer Use state, not as inaccessible content.');
    expect(developerPrompt).toContain('Do not tell the user the app cannot be accessed just because a control is inside web content.');
    expect(developerPrompt).not.toContain('backed by Windows UI Automation, HWND messages');
    expect(developerPrompt).not.toContain('bring_to_foreground:true');
    expect(developerPrompt).not.toContain('one PowerShell command with several explicit CLI tool calls');
    expect(developerPrompt).not.toContain('list_windows --json');
    expect(developerPrompt).not.toContain('Use the `builtin-cua-driver` tool server for native macOS desktop computer use.');
    expect(developerPrompt).not.toContain('Treat refresh/recalc as mandatory post-edit hygiene, not optional polish.');
    expect(developerPrompt).not.toContain('When you create, edit, or export user-facing files, end the final answer with markdown links to the delivered files.');
    expect(developerPrompt).toContain('## Network access');
    expect(developerPrompt).toContain('Network access is enabled in the sandbox for this runtime.');
    expect(developerPrompt).toContain('On Windows, the runtime executes shell-tool commands via `powershell.exe -Command`');
    expect(developerPrompt).toContain('Pass a plain command string, not JSON/array vectors like `["powershell.exe","-Command","..."]`');
    expect(developerPrompt).toContain('or quoted/comma-separated argv text.');
    expect(developerPrompt).toContain('PowerShell v5 does not support `&&`');
    expect(developerPrompt).toContain('Never run bare `interpreter-app` inside PowerShell');
    expect(developerPrompt).toContain('always use `cmd.exe /c "%INTERPRETER_CLI_PATH%" ...`');
    expect(developerPrompt).toContain('Windows administrator rights are separate from Interpreter sandbox access.');
    expect(developerPrompt).toContain('Full Access does not grant elevation.');
    expect(developerPrompt).toContain('explicitly reports access denied or elevation required');
    expect(developerPrompt).toContain('tell the user to reopen Interpreter as Administrator');
    expect(developerPrompt).not.toContain('fails while inspecting system diagnostics');
    expect(developerPrompt).toContain('Do not claim Sandbox Mode can bypass Windows administrator requirements.');
    expect(developerPrompt).toContain('## Local runtimes');
    expect(developerPrompt).toContain('Prefer built-in tools and already-available runtimes. Install Python, `uv`, Bun, or Node only when the task actually needs them.');
    expect(developerPrompt).toContain('Before installing anything, check existing runtimes once: `python --version`, `python3 --version`, `bun --version`, and `node --version`.');
    expect(developerPrompt).not.toContain('This run explicitly injects selected Interpreter app tools to the model as direct MCP tools');
  });

  test('developer prompt can explicitly describe the direct MCP injection experiment', () => {
    const developerPrompt = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
      {
        injectAppToolsAsMcp: true,
        platform: 'darwin',
      },
    );

    expect(developerPrompt).toContain('This run explicitly injects selected Interpreter app tools to the model as direct MCP tools in addition to the normal CLI path.');
    expect(developerPrompt).toContain('If a needed Interpreter app tool is visibly injected in the top-level tool list, call it directly.');
    expect(developerPrompt).toContain('Otherwise use `interpreter-app`.');
    expect(developerPrompt).toContain('When `builtin-cua-driver__...` tools are visible as top-level tools, use those direct tools for Computer Use.');
    expect(developerPrompt).toContain('direct `get_app_state` calls deliver screenshots as structured image content.');
    expect(developerPrompt).not.toContain('Use `builtin-cua-driver` through Interpreter\'s normal CLI transport: `interpreter-app tools builtin-cua-driver <tool-name> --json');
  });

  test('platform-specific shell guidance only includes the current platform branch', () => {
    const unixPrompt = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
      { platform: 'darwin' },
    );

    expect(unixPrompt).toContain('On Unix, prefer the bare `interpreter-app` command on `PATH`.');
    expect(unixPrompt).toContain('- macOS: `/Applications`');
    expect(unixPrompt).toContain('## Native desktop computer use');
    expect(unixPrompt).toContain('Native desktop computer-use tasks are `computer-use` skill-first.');
    expect(unixPrompt).not.toContain('Use the `builtin-cua-driver` tool server for native macOS desktop computer use.');
    expect(unixPrompt).toContain('interpreter-app tools builtin-cua-driver get_app_state --json');
    expect(unixPrompt).toContain('interpreter-app tools builtin-cua-driver launch_app --json');
    expect(unixPrompt).toContain('The Computer Use tool surface is app-scoped on every supported desktop platform: `list_apps`, `launch_app`, `get_app_state`, `get_ui_elements`, `click`, `drag`, `press_key`, `scroll`, `set_value`, `type_text`, and `perform_secondary_action`.');
    expect(unixPrompt).toContain('For Electron, Chromium, and web-rendered desktop apps, treat `HTML content`, `webarea`, sparse AX trees, or missing settable fields as ordinary Computer Use state, not as inaccessible content.');
    expect(unixPrompt).toContain('Never use `osascript System Events`, raw AppKit/NSWorkspace, Quartz/CGWindowList, `screencapture`, `open`, or ad hoc Python as a desktop-control fallback.');
    expect(unixPrompt).toContain('If `builtin-cua-driver` reports missing Accessibility or Screen Recording permission');
    expect(unixPrompt).toContain('Do not claim sandboxing blocks computer use unless `builtin-cua-driver` itself reports a sandbox error.');
    expect(unixPrompt).not.toContain('Windows administrator rights are separate from Interpreter sandbox access.');
    expect(unixPrompt).toContain('Prefer unified `builtin-interpreter` browser page tools for simple webpage content when the tab is available through the Chrome extension, and use browser-control/`js_repl` for advanced Playwright-in-tab work.');
    expect(unixPrompt).toContain('Simple browser page tasks are unified browser-tool first.');
    expect(unixPrompt).toContain('interpreter-app tools builtin-interpreter interpreter_whole_computer_state_get --json');
    expect(unixPrompt).toContain('interpreter-app tools builtin-interpreter interpreter_browser_page_inspect --json');
    expect(unixPrompt).toContain('Use `js_repl` plus the shipped browser-control skill for advanced Playwright-in-tab work after you have an exact browser-control tab ref or session key');
    expect(unixPrompt).toContain('If a browser-control tab is present and the user asks for simple inspect, scroll, click, type, select, or trace work on that page, start with the `builtin-interpreter` browser page tools');
    expect(unixPrompt).toContain('do not say browser control is unavailable just because `interpreter-app tools list browser-control` fails.');
    expect(unixPrompt).toContain('Use browser-control tabs from the Chrome extension as live browser state.');
    expect(unixPrompt).not.toContain('shared browser tab');
    expect(unixPrompt).not.toContain('shared browser tabs');
    expect(unixPrompt).toContain('To use `js_repl`, call `interpreter-app tools builtin-js-repl js_repl --json \'{"code":"..."}\'`');
    expect(unixPrompt).toContain('Do not answer browser-control tasks with a visible JavaScript code fence.');
    expect(unixPrompt).toContain('Never run a bare command named `js_repl` or raw `node` as a substitute for browser control.');
    expect(unixPrompt).toContain('If `interpreter-app tools builtin-js-repl js_repl` is unavailable, advanced Playwright browser control is unavailable in this runtime.');
    expect(unixPrompt).toContain('Only open a site in an Interpreter in-app browser tab when the user explicitly asks to try that route or when previewing a local app you built.');
    expect(unixPrompt).toContain('warn the user that it is a separate in-app browser session and they should not expect to be signed in there.');
    expect(unixPrompt).toContain('`js_repl` is a persistent JavaScript kernel.');
    expect(unixPrompt).toContain('do not redeclare top-level `let`, `const`, `class`, or `function` names');
    expect(unixPrompt).not.toContain('Treat `get_window_state` as the refresh step');
    expect(unixPrompt).not.toContain('After any UI change, rerun `get_window_state` before trusting old `element_index` values or screenshot coordinates.');
    expect(unixPrompt).toContain('On macOS, install `uv` with: `curl -LsSf https://astral.sh/uv/install.sh | sh`');
    expect(unixPrompt).toContain('Install Bun only when no suitable existing JS runtime is available or the task specifically benefits from Bun. On macOS, install Bun with: `curl -fsSL https://bun.com/install | bash`');
    expect(unixPrompt).not.toContain('On Windows, the runtime executes commands via `powershell.exe -Command`');
    expect(unixPrompt).not.toContain('install `uv` with: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`');
  });

  test('linux runtime bootstrap guidance stays linux-specific', () => {
    const linuxPrompt = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
      { platform: 'linux' },
    );

    expect(linuxPrompt).toContain('On Linux, install `uv` with: `curl -LsSf https://astral.sh/uv/install.sh | sh`');
    expect(linuxPrompt).toContain('Install Bun only when no suitable existing JS runtime is available or the task specifically benefits from Bun. On Linux, install Bun with: `curl -fsSL https://bun.com/install | bash`');
    expect(linuxPrompt).toContain('On Linux, Bun\'s official installer requires `unzip`');
    expect(linuxPrompt).not.toContain('## Native desktop computer use');
    expect(linuxPrompt).not.toContain('interpreter-app tools builtin-cua-driver list_apps --json');
    expect(linuxPrompt).not.toContain('install Bun on Windows');
    expect(linuxPrompt).not.toContain('install Bun on macOS');
  });

  test('adds download escalation guidance only when sandbox network access is enabled', () => {
    const withNetworkAccess = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
      { networkAccessEnabled: true },
    );
    const withoutNetworkAccess = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
      { networkAccessEnabled: false },
    );

    expect(withNetworkAccess).toContain('## Network access');
    expect(withNetworkAccess).toContain('Network access is enabled in the sandbox for this runtime.');
    expect(withNetworkAccess).toContain('Never request escalation for a download into the workspace unless there is explicit evidence of sandbox denial or permission failure.');
    expect(withoutNetworkAccess).not.toContain('## Network access');
  });

  test('defaults network access guidance to on when runtime access is unset', () => {
    const developerPrompt = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
    );

    expect(developerPrompt).toContain('## Network access');
    expect(developerPrompt).toContain('Network access is enabled in the sandbox for this runtime.');
  });

  test('omits browser-control guidance when that skill is disabled for the current app mode', () => {
    const developerPrompt = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
      { browserControlSkillEnabled: false, platform: 'darwin' },
    );

    expect(developerPrompt).not.toContain('## Browser control');
    expect(developerPrompt).not.toContain('the shipped browser-control skill');
    expect(developerPrompt).not.toContain('`browser-control` for the user\'s already-running browser session via `js_repl`.');
    expect(developerPrompt).toContain('## Native desktop computer use');
  });

  test('lists only the bundled skills enabled for the current runtime', () => {
    const developerPrompt = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
      {
        bundledSkillNames: ['Excel', 'pdf'],
      },
    );

    expect(developerPrompt).toContain('`Excel` for spreadsheets/`.xlsx`/`.xls`/`.csv`/`.tsv`; inspect and author workbooks through cohesive code execution');
    expect(developerPrompt).toContain('`pdf` for PDFs; prefer matching `interpreter-app tools builtin-pdf ...` reads first. For fillable PDF forms');
    expect(developerPrompt).not.toContain('`doc` for Word/`.docx`');
    expect(developerPrompt).not.toContain('`PowerPoint` for presentations/`.pptx`/`.ppt`');
  });

  test('keeps PowerPoint as the shipped skill without extra local summary text', () => {
    const developerPrompt = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
      {
        bundledSkillNames: ['PowerPoint'],
      },
    );

    expect(developerPrompt).toContain('This app ships bundled global Interpreter skills installed in the runtime: `PowerPoint`.');
    expect(developerPrompt).not.toContain('Treat skills as workflow guidance, not as proof that a native tool exists.');
    expect(developerPrompt).not.toContain('`PowerPoint` for presentations/`.pptx`/`.ppt`');
  });

  test('renders visible runtime skills with paths and usage contract', () => {
    const developerPrompt = getMainAgentDeveloperPrompt(
      'gpt-5.4-nano',
      true,
      '/tmp/headless-cli/interpreter-app',
      {
        visibleSkills: [
          {
            name: 'browser-control',
            description: 'Control the user Chrome extension browser-control session through js_repl.',
            path: '/tmp/interpreter-home/skills/browser-control/SKILL.md',
            scope: 'user',
          },
          {
            name: 'pdf',
            description: 'Read and edit PDFs.',
            path: '/tmp/interpreter-home/skills/pdf/SKILL.md',
            scope: 'system',
          },
        ],
      },
    );

    expect(developerPrompt).toContain('## Skills');
    expect(developerPrompt).toContain('These are the skills available in this session. Each skill is a local `SKILL.md` file.');
    expect(developerPrompt).toContain('`browser-control` (user) at `/tmp/interpreter-home/skills/browser-control/SKILL.md`: Control the user Chrome extension browser-control session through js_repl.');
    expect(developerPrompt).toContain('`pdf` (system) at `/tmp/interpreter-home/skills/pdf/SKILL.md`: Read and edit PDFs.');
    expect(developerPrompt).toContain('read that skill\'s `SKILL.md` from the path above');
    expect(developerPrompt).toContain('If a skill points to a native runtime capability such as `apply_patch` or shell execution, use that native capability directly');
  });
});
