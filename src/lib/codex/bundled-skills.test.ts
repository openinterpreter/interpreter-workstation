import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getBundledSkillPlatformVariantFileName } from './app-server-client';

const ALLOWED_BUNDLED_SKILLS = [
  'accrual-schedule',
  'audit-xls',
  'browser-control',
  'computer-use',
  'doc',
  'media-creation',
  'month-end-closer',
  'pdf',
  'playwright',
  'roll-forward',
  'screenshot',
  'settings',
  'skill-creator',
  'slides',
  'spreadsheets',
  'transcribe',
  'variance-commentary',
  'wiki-bootstrap',
  'wiki-ingest',
  'wiki-lint',
  'wiki-maintainer',
  'wiki-query',
  'xlsx-author',
];
const REQUIRED_BUNDLED_SKILL_FILES: Record<string, string[]> = {
  'accrual-schedule': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
  'audit-xls': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
  'browser-control': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'computer-use': [
    'SKILL.md',
    'SKILL.win32.md',
    'WEB_APPS.md',
    'agents/openai.yaml',
    'agents/openai.win32.yaml',
  ],
  doc: [
    'SKILL.md',
    'agents/openai.yaml',
    'scripts/render_docx.py',
  ],
  'media-creation': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'month-end-closer': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
  pdf: [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  playwright: [
    'SKILL.md',
    'agents/openai.yaml',
    'references/cli.md',
    'references/workflows.md',
    'scripts/playwright_cli.sh',
  ],
  'roll-forward': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
  screenshot: [
    'SKILL.md',
    'agents/openai.yaml',
    'scripts/take_screenshot.py',
  ],
  settings: [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'skill-creator': [
    'SKILL.md',
    'agents/openai.yaml',
    'references/openai_yaml.md',
    'scripts/generate_openai_yaml.py',
    'scripts/init_skill.py',
    'scripts/quick_validate.py',
  ],
  spreadsheets: [
    'SKILL.md',
    'agents/openai.yaml',
    'style_guidelines.md',
    'templates/financial_models.md',
  ],
  slides: [
    'SKILL.md',
    'agents/openai.yaml',
    'scripts/init_pro_deck_builder_js.js',
    'scripts/prepare_reference_prompts.js',
    'scripts/pro_deck_quality_check.js',
    'templates/build_pro_deck_template.js',
  ],
  'wiki-maintainer': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'wiki-ingest': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'wiki-query': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'wiki-lint': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  'wiki-bootstrap': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
  transcribe: [
    'SKILL.md',
    'agents/openai.yaml',
    'references/api.md',
  ],
  'variance-commentary': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
  'xlsx-author': [
    'SKILL.md',
    'agents/openai.yaml',
    'LICENSE.txt',
  ],
};

function listBundledSkillDirs(skillsRoot: string): string[] {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

describe('bundled Codex skills', () => {
  test('ships only the approved bundled skills', () => {
    const skillsRoot = path.resolve(process.cwd(), 'resources', 'codex-skills');

    expect(existsSync(skillsRoot)).toBe(true);
    expect(listBundledSkillDirs(skillsRoot)).toEqual(ALLOWED_BUNDLED_SKILLS);

    for (const skillName of ALLOWED_BUNDLED_SKILLS) {
      const requiredFiles = REQUIRED_BUNDLED_SKILL_FILES[skillName] ?? [];
      for (const relativeFilePath of requiredFiles) {
        expect(existsSync(path.join(skillsRoot, skillName, relativeFilePath))).toBe(true);
      }
    }
  });

  test('ships a REPL-safe browser-control skill bootstrap', () => {
    const skillPath = path.resolve(
      process.cwd(),
      'resources',
      'codex-skills',
      'browser-control',
      'SKILL.md',
    );
    const openAiPromptPath = path.resolve(
      process.cwd(),
      'resources',
      'codex-skills',
      'browser-control',
      'agents',
      'openai.yaml',
    );

    const content = readFileSync(skillPath, 'utf-8');
    const openAiPromptContent = readFileSync(openAiPromptPath, 'utf-8');

    expect(content).toContain('await import("interpreter-browser-control")');
    expect(content).toContain('globalThis.browserControlRuntime ??= await import("interpreter-browser-control")');
    expect(content).toContain('await globalThis.browserControlRuntime.setupInterpreterBrowserControl({');
    expect(content).toContain('globalThis.page = await globalThis.ensurePage();');
    expect(content).toContain('globalThis.tab = await agent.browser.tabs.selected();');
    expect(content).toContain('globalThis.selectedBrowserSessionId');
    expect(content).toContain('Use the exact `tab_ref` from `interpreter_whole_computer_state_get` when available');
    expect(content).toContain('<profile-key>:chrome-tab:<chrome-tab-id>');
    expect(content).toContain('put the JavaScript in the `code` argument of a `builtin-js-repl js_repl` call');
    expect(content).toContain('interpreter-app tools builtin-js-repl js_repl --stdin-arg code');
    expect(content).toContain('do not answer with a fenced JavaScript block');
    expect(content).toContain('For simple page inventory and element actions, prefer the unified browser page tools first');
    expect(content).toContain('interpreter-app tools builtin-interpreter interpreter_browser_page_inspect');
    expect(content).toContain('use the unified `builtin-interpreter` browser page tools for ordinary page inspect/click/type/select/scroll tasks');
    expect(content).toContain('use this Browser Use-shaped browser-control path for advanced Playwright work instead of opening a new Interpreter in-app browser tab');
    expect(content).toContain('use Interpreter layout tools for files, workspace UI layout, and local app previews, not for controlling the user\'s browser');
    expect(content).toContain('warn them first that the in-app browser is a separate session and they should not expect to be signed in there');
    expect(openAiPromptContent).toContain('not call a tool named `browser-control`');
    expect(openAiPromptContent).toContain('Use unified `builtin-interpreter` browser page tools first for simple');
    expect(openAiPromptContent).toContain('then use `interpreter_browser_page_inspect` with an exact `tab_ref`');
    expect(openAiPromptContent).toContain('Use the browser-control skill workflow for advanced Playwright-in-tab work');
    expect(openAiPromptContent).toContain('Put browser-control JavaScript in the');
    expect(openAiPromptContent).toContain('`interpreter-app tools builtin-js-repl js_repl --json ...`');
    expect(openAiPromptContent).toContain('browser-control tab ref');
    expect(openAiPromptContent).toContain('<profile-key>:chrome-tab:<chrome-tab-id>');
    expect(openAiPromptContent).toContain('do not answer with a');
    expect(openAiPromptContent).toContain('visible JavaScript code block');
    expect(content).toContain('For search, lookup, record-review, or form workflows, reread the page after each submit/navigation before deciding the result.');
    expect(content).toContain('Distinguish "no matching record found" from "record found, but requested content not found inside it."');
    expect(openAiPromptContent).toContain('For search, lookup, record-review, or form');
    expect(openAiPromptContent).toContain('reread the page after each submit/navigation before deciding the');
    expect(openAiPromptContent).toContain('distinguish no');
    expect(openAiPromptContent).toContain('matching record from a matching record whose requested content was not');
    expect(content).not.toContain('const { setupInterpreterBrowserControl } = await import("interpreter-browser-control");');
    expect(content).not.toContain('const page = await globalThis.ensurePage();');
    expect(content).not.toContain('selectedBrowserSessionId is not defined');
  });

  test('ships a browser-control runtime package for js_repl', () => {
    const packagePath = path.resolve(
      process.cwd(),
      'js-repl-runtime',
      'packages',
      'browser-control',
      'package.json',
    );
    const runtimePath = path.resolve(
      process.cwd(),
      'js-repl-runtime',
      'packages',
      'browser-control',
      'index.js',
    );

    expect(existsSync(packagePath)).toBe(true);
    expect(existsSync(runtimePath)).toBe(true);

    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
    const runtimeContent = readFileSync(runtimePath, 'utf-8');

    expect(packageJson.name).toBe('interpreter-browser-control');
    expect(runtimeContent).toContain('setupInterpreterBrowserControl');
    expect(runtimeContent).toContain('agent');
    expect(runtimeContent).toContain('browser');
    expect(runtimeContent).toContain('playwright');
    expect(runtimeContent).toContain('connectOverCDP');
  });

  test('ships Playwright guidance that distinguishes DOM snapshots from screenshots', () => {
    const skillPath = path.resolve(
      process.cwd(),
      'resources',
      'codex-skills',
      'playwright',
      'SKILL.md',
    );

    const content = readFileSync(skillPath, 'utf-8');

    expect(content).toContain('DOM snapshots');
    expect(content).toContain('`snapshot` returns text page state and element refs. It is not a screenshot.');
  });

  test('ships a computer-use skill for the native desktop driver', () => {
    const skillPath = path.resolve(
      process.cwd(),
      'resources',
      'codex-skills',
      'computer-use',
      'SKILL.md',
    );

    const content = readFileSync(skillPath, 'utf-8');

    expect(content).toContain('This skill is workflow guidance, not a callable tool.');
    expect(content).toContain('Do not call a tool named');
    expect(content).toContain('`computer-use`');
    expect(content).toContain('interpreter-app tools builtin-cua-driver get_app_state');
    expect(content).toContain('The tool surface is app-scoped and intentionally matches Computer Use');
    expect(content).toContain('launch_app({app?, name?, bundle_id?, path?, executable?, urls?})');
    expect(content).toContain('When `builtin-cua-driver__...` tools are visible as top-level tools');
    expect(content).toContain("Otherwise use `builtin-cua-driver` through Interpreter's normal CLI transport");
    expect(content).toContain('Do not use shell commands, AppleScript, AppKit, Quartz');
    expect(content).toContain('drag({app, from_x, from_y, to_x, to_y})');
    expect(content).toContain('get_app_state({app})');
    expect(content).toContain('<app_state>');
    expect(content).toContain('Electron, Chromium, and web-rendered desktop apps may expose broad `HTML');
    expect(content).toContain('That is still usable Computer Use state, not');
    expect(content).not.toContain('Windows UI Automation');
    expect(content).not.toContain('Win32/WinForms/WPF');
  });

  test('ships platform-specific computer-use skill instructions', () => {
    expect(getBundledSkillPlatformVariantFileName('computer-use', 'win32')).toBe('SKILL.win32.md');
    expect(getBundledSkillPlatformVariantFileName('computer-use', 'darwin')).toBeNull();
    expect(getBundledSkillPlatformVariantFileName('browser-control', 'win32')).toBeNull();

    const windowsSkillPath = path.resolve(
      process.cwd(),
      'resources',
      'codex-skills',
      'computer-use',
      'SKILL.win32.md',
    );
    const windowsContent = readFileSync(windowsSkillPath, 'utf-8');
    expect(windowsContent).toContain('This skill is workflow guidance, not a callable tool.');
    expect(windowsContent).toContain('Do not call a tool named');
    expect(windowsContent).toContain('`computer-use`');
    expect(windowsContent).toContain('cmd.exe /c "%INTERPRETER_CLI_PATH%" tools builtin-cua-driver get_app_state');
    expect(windowsContent).toContain('The tool surface is app-scoped and intentionally matches Computer Use');
    expect(windowsContent).toContain('list_apps({})');
    expect(windowsContent).toContain('launch_app({app?, path?, executable?, arguments?, window_style?})');
    expect(windowsContent).toContain('click({app, element_index?, x?, y?, click_count?, mouse_button?})');
    expect(windowsContent).toContain('type_text({app, text})');
    expect(windowsContent).toContain('Do not use `Start-Process`');
    expect(windowsContent).toContain('<app_state>');
    expect(windowsContent).toContain('Electron, Chromium, and web-rendered desktop apps may expose broad `HTML');
    expect(windowsContent).toContain('That is still usable Computer Use state, not');
    expect(windowsContent).not.toContain('list_windows');
    expect(windowsContent).not.toContain('get_window_state');
    expect(windowsContent).not.toContain('type_text_chars');
    expect(windowsContent).not.toContain("TryCua's Cua Driver");
    expect(windowsContent).not.toContain('TextEdit');

    const defaultAgentPrompt = readFileSync(path.resolve(
      process.cwd(),
      'resources',
      'codex-skills',
      'computer-use',
      'agents',
      'openai.yaml',
    ), 'utf-8');
    const windowsAgentPrompt = readFileSync(path.resolve(
      process.cwd(),
      'resources',
      'codex-skills',
      'computer-use',
      'agents',
      'openai.win32.yaml',
    ), 'utf-8');
    expect(defaultAgentPrompt).toContain('native macOS desktop control');
    expect(defaultAgentPrompt).toContain('Use the Computer Use workflow');
    expect(defaultAgentPrompt).toContain('Do not call a tool named `computer-use`');
    expect(defaultAgentPrompt).toContain('interpreter-app tools builtin-cua-driver');
    expect(defaultAgentPrompt).toContain('`list_apps`, `launch_app`, `get_app_state`, `click`, `drag`, `press_key`, `scroll`, `set_value`, `type_text`, and `perform_secondary_action`');
    expect(defaultAgentPrompt).not.toContain('$computer-use');
    expect(defaultAgentPrompt).not.toContain('Windows UI Automation');
    expect(windowsAgentPrompt).toContain('native Windows desktop control');
    expect(windowsAgentPrompt).toContain('Use the Computer Use workflow');
    expect(windowsAgentPrompt).toContain('Do not call a tool named `computer-use`');
    expect(windowsAgentPrompt).toContain('cmd.exe /c \\"%INTERPRETER_CLI_PATH%\\" tools builtin-cua-driver');
    expect(windowsAgentPrompt).toContain('Start with `get_app_state({app})`');
    expect(windowsAgentPrompt).not.toContain('$computer-use');
    expect(windowsAgentPrompt).toContain('after any UI-changing action, call `get_app_state` again');
    expect(windowsAgentPrompt).not.toContain('automation_id');
    expect(windowsAgentPrompt).not.toContain('--stdin-json');
  });

  test('marks office skills as workflow guidance instead of direct callable tools', () => {
    const skillsRoot = path.resolve(process.cwd(), 'resources', 'codex-skills');
    const docContent = readFileSync(path.join(skillsRoot, 'doc', 'SKILL.md'), 'utf-8');
    const spreadsheetContent = readFileSync(path.join(skillsRoot, 'spreadsheets', 'SKILL.md'), 'utf-8');

    expect(docContent).toContain('Skills are workflow guidance, not callable tools.');
    expect(docContent).toContain('Do not call a tool named');
    expect(docContent).toContain('`doc`');
    expect(docContent).toContain('do not call direct `builtin-docx__...` or `builtin-converter__...`');
    expect(spreadsheetContent).toContain('Skills are workflow guidance, not callable tools.');
    expect(spreadsheetContent).toContain('Do not call a tool named');
    expect(spreadsheetContent).toContain('`Excel`');
    expect(spreadsheetContent).toContain('does not assume a native');
    expect(spreadsheetContent).not.toContain('builtin-cells');
  });

  test('bundled agent prompts do not suggest skill names as tool calls', () => {
    const skillsRoot = path.resolve(process.cwd(), 'resources', 'codex-skills');
    const forbiddenSkillTokens = [
      ...ALLOWED_BUNDLED_SKILLS.map((skillName) => `$${skillName}`),
      '$Excel',
      '$PowerPoint',
    ];

    for (const skillName of ALLOWED_BUNDLED_SKILLS) {
      const agentsDir = path.join(skillsRoot, skillName, 'agents');
      if (!existsSync(agentsDir)) {
        continue;
      }

      for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.yaml')) {
          continue;
        }

        const promptContent = readFileSync(path.join(agentsDir, entry.name), 'utf-8');
        for (const forbiddenSkillToken of forbiddenSkillTokens) {
          expect(promptContent).not.toContain(forbiddenSkillToken);
        }
      }
    }
  });

  test('skill creator does not instruct generated prompts to use skill-call tokens', () => {
    const openAiYamlReference = readFileSync(path.resolve(
      process.cwd(),
      'resources',
      'codex-skills',
      'skill-creator',
      'references',
      'openai_yaml.md',
    ), 'utf-8');

    expect(openAiYamlReference).toContain('Do not format the skill name as a `$skill-name` token');
    expect(openAiYamlReference).toContain('can still be selected explicitly by the user');
    expect(openAiYamlReference).not.toContain('must explicitly mention the skill as `$skill-name`');
    expect(openAiYamlReference).not.toContain('invoked explicitly via `$skill`');
  });
});
