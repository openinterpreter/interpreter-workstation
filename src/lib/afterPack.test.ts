import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assertRequiredBundledResources,
  copyWindowsRuntimeDlls,
  assertWindowsDelayLoadDlls,
  getMacExtraResourceBinariesForSigning,
} = require('../../scripts/electron-builder/afterPack.cjs');
const {
  assertBundledCodexSkills,
  REQUIRED_BUNDLED_SKILL_FILES,
} = require('../../scripts/electron-builder/checkBundledCodexSkills.cjs');

const tempDirs: string[] = [];
const OIX_UNIX_PACKAGE_FILES = [
  'oix/bin/interpreter',
  'oix/bin/i',
  'oix/bin/codex-code-mode-host',
  'oix/codex-package.json',
  'oix/codex-path/rg',
  'oix/codex-resources/zsh/bin/zsh',
];
const OIX_WINDOWS_PACKAGE_FILES = [
  'oix/bin/interpreter.exe',
  'oix/bin/i.exe',
  'oix/bin/codex-code-mode-host.exe',
  'oix/codex-package.json',
  'oix/codex-path/rg.exe',
];
const JS_REPL_RUNTIME_FILES = [
  'js-repl-runtime/package.json',
  'js-repl-runtime/node_modules/playwright-core/package.json',
  'js-repl-runtime/node_modules/interpreter-browser-control/package.json',
  'js-repl-runtime/kernel/kernel.cjs',
  'js-repl-runtime/kernel/meriyah.umd.min.cjs',
];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'after-pack-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, 'ok');
}

function writeValidSkillDoc(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    '---\nname: valid-skill\ndescription: Valid bundled skill fixture.\n---\n\n# Body\n',
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('electron-builder mac privacy metadata', () => {
  test('declares feature-accurate usage descriptions for macOS TCC-gated capture APIs', () => {
    const config = fs.readFileSync(path.join(process.cwd(), 'electron-builder.yml'), 'utf8');

    const requiredUsageDescriptions = {
      NSCameraUsageDescription: 'Interpreter uses camera access when you choose a camera as a video recording source.',
      NSMicrophoneUsageDescription: 'Interpreter uses microphone access when you start voice input, Push to Talk, Ambient speech-to-text, or connect a microphone as an audio recording source.',
      NSSpeechRecognitionUsageDescription: 'Interpreter uses speech recognition to detect Ambient voice phrases and transcribe voice input when you enable voice mode.',
      NSAudioCaptureUsageDescription: 'Interpreter uses audio capture to record and transcribe audio only when you start voice input or connect an audio source for recording.',
    } as const;

    for (const [usageKey, description] of Object.entries(requiredUsageDescriptions)) {
      expect(config).toContain(`${usageKey}: ${description}`);
    }
  });
});

describe('assertRequiredBundledResources', () => {
  function writeRelayRuntime(resourcesRoot: string): void {
    for (const relativePath of [
      'browser-extension-relay/package.json',
      'browser-extension-relay/runtime-manifest.json',
      'browser-extension-relay/dist/start-relay-server.js',
      'browser-extension-relay/dist/extension/manifest.json',
      'browser-extension-relay/node_modules/hono/package.json',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }
  }

  test('allows packaged mac app with bundled live relay runtime', () => {
    const resourcesRoot = makeTempDir();

    for (const relativePath of [
      ...OIX_UNIX_PACKAGE_FILES,
      'pdfcpu/pdfcpu',
      ...JS_REPL_RUNTIME_FILES,
      'qwen-asr/darwin-arm64/qwen_asr',
      'cua-driver/cua-driver',
      'cua-driver/tool-metadata.json',
      'cua-driver/macos-agent-activity-overlay.jxa',
      'interpreter-overlay/accessibility-tree',
      'interpreter-overlay/ax-set-focused-text',
      'interpreter-overlay/focus-window',
      'interpreter-overlay/keyboard-monitor',
      'interpreter-overlay/progressive-blur',
      'interpreter-overlay/speech-recognizer',
      'interpreter-overlay/verified-point',
      'interpreter-overlay/window-tracker',
      'interpreter-overlay/native/window_pin.node',
      'interpreter-overlay/window-tracker',
      'interpreter-overlay/native/window_pin.node',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }
    writeRelayRuntime(resourcesRoot);

    expect(() => assertRequiredBundledResources(resourcesRoot, 'darwin', 'arm64')).not.toThrow();
  });

  test('allows packaged Windows app with bundled live relay runtime', () => {
    const resourcesRoot = makeTempDir();

    for (const relativePath of [
      ...OIX_WINDOWS_PACKAGE_FILES,
      'codex-command-runner.exe',
      'codex-windows-sandbox-setup.exe',
      'pdfcpu/pdfcpu.exe',
      ...JS_REPL_RUNTIME_FILES,
      'cua-driver/windows-uia.ps1',
      'interpreter-overlay/native/window_pin.node',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }
    writeRelayRuntime(resourcesRoot);

    expect(() => assertRequiredBundledResources(resourcesRoot, 'win32', 'x64')).not.toThrow();
  });

  test('fails when a packaged mac app omits pdfcpu', () => {
    const resourcesRoot = makeTempDir();

    for (const relativePath of [
      ...OIX_UNIX_PACKAGE_FILES,
      ...JS_REPL_RUNTIME_FILES,
      'qwen-asr/darwin-arm64/qwen_asr',
      'cua-driver/cua-driver',
      'cua-driver/tool-metadata.json',
      'cua-driver/macos-agent-activity-overlay.jxa',
      'interpreter-overlay/accessibility-tree',
      'interpreter-overlay/ax-set-focused-text',
      'interpreter-overlay/focus-window',
      'interpreter-overlay/keyboard-monitor',
      'interpreter-overlay/progressive-blur',
      'interpreter-overlay/speech-recognizer',
      'interpreter-overlay/verified-point',
      'interpreter-overlay/window-tracker',
      'interpreter-overlay/native/window_pin.node',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }
    writeRelayRuntime(resourcesRoot);

    expect(() => assertRequiredBundledResources(resourcesRoot, 'darwin', 'arm64')).toThrow(
      `[afterPack] Missing required bundled resource: ${path.join(resourcesRoot, 'pdfcpu', 'pdfcpu')}`,
    );
  });

  test('fails when a packaged mac app omits the unified interpreter binary', () => {
    const resourcesRoot = makeTempDir();

    for (const relativePath of [
      ...OIX_UNIX_PACKAGE_FILES.filter((entry) => entry !== 'oix/bin/interpreter'),
      'pdfcpu/pdfcpu',
      ...JS_REPL_RUNTIME_FILES,
      'qwen-asr/darwin-arm64/qwen_asr',
      'cua-driver/cua-driver',
      'cua-driver/tool-metadata.json',
      'cua-driver/macos-agent-activity-overlay.jxa',
      'interpreter-overlay/accessibility-tree',
      'interpreter-overlay/ax-set-focused-text',
      'interpreter-overlay/focus-window',
      'interpreter-overlay/keyboard-monitor',
      'interpreter-overlay/progressive-blur',
      'interpreter-overlay/speech-recognizer',
      'interpreter-overlay/verified-point',
      'interpreter-overlay/window-tracker',
      'interpreter-overlay/native/window_pin.node',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }
    writeRelayRuntime(resourcesRoot);

    expect(() => assertRequiredBundledResources(resourcesRoot, 'darwin', 'arm64')).toThrow(
      `[afterPack] Missing required bundled resource: ${path.join(resourcesRoot, 'oix', 'bin', 'interpreter')}`,
    );
  });

  test('fails when a packaged mac app omits relay runtime-manifest.json', () => {
    const resourcesRoot = makeTempDir();

    for (const relativePath of [
      ...OIX_UNIX_PACKAGE_FILES,
      'pdfcpu/pdfcpu',
      ...JS_REPL_RUNTIME_FILES,
      'qwen-asr/darwin-arm64/qwen_asr',
      'cua-driver/cua-driver',
      'cua-driver/tool-metadata.json',
      'cua-driver/macos-agent-activity-overlay.jxa',
      'interpreter-overlay/accessibility-tree',
      'interpreter-overlay/focus-window',
      'interpreter-overlay/keyboard-monitor',
      'interpreter-overlay/progressive-blur',
      'interpreter-overlay/speech-recognizer',
      'interpreter-overlay/verified-point',
      'interpreter-overlay/window-tracker',
      'interpreter-overlay/native/window_pin.node',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }
    for (const relativePath of [
      'browser-extension-relay/package.json',
      'browser-extension-relay/dist/start-relay-server.js',
      'browser-extension-relay/dist/extension/manifest.json',
      'browser-extension-relay/node_modules/hono/package.json',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }

    expect(() => assertRequiredBundledResources(resourcesRoot, 'darwin', 'arm64')).toThrow(
      `[afterPack] Missing required bundled resource: ${path.join(resourcesRoot, 'browser-extension-relay', 'runtime-manifest.json')}`,
    );
  });

  test('fails when a packaged mac app still includes relay archive', () => {
    const resourcesRoot = makeTempDir();

    for (const relativePath of [
      ...OIX_UNIX_PACKAGE_FILES,
      'pdfcpu/pdfcpu',
      'browser-extension-relay.zip',
      ...JS_REPL_RUNTIME_FILES,
      'qwen-asr/darwin-arm64/qwen_asr',
      'cua-driver/cua-driver',
      'cua-driver/tool-metadata.json',
      'cua-driver/macos-agent-activity-overlay.jxa',
      'interpreter-overlay/accessibility-tree',
      'interpreter-overlay/ax-set-focused-text',
      'interpreter-overlay/focus-window',
      'interpreter-overlay/keyboard-monitor',
      'interpreter-overlay/progressive-blur',
      'interpreter-overlay/speech-recognizer',
      'interpreter-overlay/verified-point',
      'interpreter-overlay/window-tracker',
      'interpreter-overlay/native/window_pin.node',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }
    writeRelayRuntime(resourcesRoot);

    expect(() => assertRequiredBundledResources(resourcesRoot, 'darwin', 'arm64')).toThrow(
      `[afterPack] Packaged app must not include a relay archive: ${path.join(resourcesRoot, 'browser-extension-relay.zip')}`,
    );
  });

  test('fails when a packaged Windows app omits codex-windows-sandbox-setup.exe', () => {
    const resourcesRoot = makeTempDir();

    for (const relativePath of [
      ...OIX_WINDOWS_PACKAGE_FILES,
      'codex-command-runner.exe',
      'pdfcpu/pdfcpu.exe',
      ...JS_REPL_RUNTIME_FILES,
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }
    writeRelayRuntime(resourcesRoot);

    expect(() => assertRequiredBundledResources(resourcesRoot, 'win32', 'x64')).toThrow(
      `[afterPack] Missing required bundled resource: ${path.join(resourcesRoot, 'codex-windows-sandbox-setup.exe')}`,
    );
  });

  test('fails when a packaged Linux app omits relay runtime', () => {
    const resourcesRoot = makeTempDir();

    for (const relativePath of [
      ...OIX_UNIX_PACKAGE_FILES,
      'pdfcpu/pdfcpu',
      ...JS_REPL_RUNTIME_FILES,
      'qwen-asr/linux-x64/qwen_asr',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }

    expect(() => assertRequiredBundledResources(resourcesRoot, 'linux', 'x64')).toThrow(
      `[afterPack] Missing required bundled resource: ${path.join(resourcesRoot, 'browser-extension-relay', 'package.json')}`,
    );
  });

  test('fails when a packaged non-mac app still includes relay archive', () => {
    const resourcesRoot = makeTempDir();

    for (const relativePath of [
      ...OIX_WINDOWS_PACKAGE_FILES,
      'codex-command-runner.exe',
      'codex-windows-sandbox-setup.exe',
      'pdfcpu/pdfcpu.exe',
      'browser-extension-relay.zip',
      ...JS_REPL_RUNTIME_FILES,
      'cua-driver/windows-uia.ps1',
      'interpreter-overlay/native/window_pin.node',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }
    writeRelayRuntime(resourcesRoot);

    expect(() => assertRequiredBundledResources(resourcesRoot, 'win32', 'x64')).toThrow(
      `[afterPack] Packaged app must not include a relay archive: ${path.join(resourcesRoot, 'browser-extension-relay.zip')}`,
    );
  });
});

describe('copyWindowsRuntimeDlls', () => {
  const REQUIRED_DLLS = [
    'vcruntime140.dll',
    'vcruntime140_1.dll',
    'msvcp140.dll',
    'concrt140.dll',
  ];

  test('copies all VC runtime DLLs to target directory', () => {
    const fakeSystemRoot = makeTempDir();
    const system32 = path.join(fakeSystemRoot, 'System32');
    mkdirSync(system32, { recursive: true });
    for (const dll of REQUIRED_DLLS) {
      writeFileSync(path.join(system32, dll), `fake-${dll}`);
    }

    const targetDir = makeTempDir();
    const origSystemRoot = process.env.SystemRoot;
    try {
      process.env.SystemRoot = fakeSystemRoot;
      copyWindowsRuntimeDlls(targetDir);
    } finally {
      if (origSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = origSystemRoot;
      }
    }

    for (const dll of REQUIRED_DLLS) {
      const copied = path.join(targetDir, dll);
      expect(fs.existsSync(copied)).toBe(true);
    }
  });

  test('throws when a required DLL is missing from the build machine', () => {
    const fakeSystemRoot = makeTempDir();
    const system32 = path.join(fakeSystemRoot, 'System32');
    mkdirSync(system32, { recursive: true });
    writeFileSync(path.join(system32, 'vcruntime140.dll'), 'fake');

    const targetDir = makeTempDir();
    const origSystemRoot = process.env.SystemRoot;
    try {
      process.env.SystemRoot = fakeSystemRoot;
      expect(() => copyWindowsRuntimeDlls(targetDir)).toThrow(
        '[afterPack] Missing required Windows runtime DLL: vcruntime140_1.dll',
      );
    } finally {
      if (origSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = origSystemRoot;
      }
    }
  });
});

describe('assertWindowsDelayLoadDlls', () => {
  test('passes when ffmpeg.dll sits next to the executable', () => {
    const appOutDir = makeTempDir();
    writeFileSync(path.join(appOutDir, 'ffmpeg.dll'), 'fake-ffmpeg');
    expect(() => assertWindowsDelayLoadDlls(appOutDir)).not.toThrow();
  });

  test('throws when ffmpeg.dll is missing (delay-load would crash the renderer at startup)', () => {
    const appOutDir = makeTempDir();
    expect(() => assertWindowsDelayLoadDlls(appOutDir)).toThrow(
      `[afterPack] Missing delay-loaded Windows runtime DLL next to the executable: ${path.join(appOutDir, 'ffmpeg.dll')}`,
    );
  });
});

describe('getMacExtraResourceBinariesForSigning', () => {
  test('includes the bundled cua-driver binary', () => {
    const resourcesRoot = makeTempDir();
    for (const relativePath of [
      ...OIX_UNIX_PACKAGE_FILES,
      'pdfcpu/pdfcpu',
      'cua-driver/cua-driver',
      'interpreter-overlay/accessibility-tree',
    ]) {
      writeFile(path.join(resourcesRoot, relativePath));
    }

    const binaries = getMacExtraResourceBinariesForSigning(resourcesRoot);
    expect(binaries).toContain(path.join(resourcesRoot, 'oix', 'bin', 'interpreter'));
    expect(binaries).toContain(path.join(resourcesRoot, 'cua-driver', 'cua-driver'));
  });
});

describe('assertBundledCodexSkills', () => {
  test('accepts the full packaged bundled skill payload', () => {
    const skillsRoot = makeTempDir();

    for (const [skillName, requiredFiles] of Object.entries(REQUIRED_BUNDLED_SKILL_FILES as Record<string, string[]>)) {
      for (const relativePath of requiredFiles) {
        const targetPath = path.join(skillsRoot, skillName, relativePath);
        if (relativePath === 'SKILL.md') {
          writeValidSkillDoc(targetPath);
        } else {
          writeFile(targetPath);
        }
      }
    }

    expect(() => assertBundledCodexSkills(skillsRoot)).not.toThrow();
  });

  test('fails when packaged skills omit wiki-maintainer', () => {
    const skillsRoot = makeTempDir();

    for (const relativePath of [
      'browser-control/SKILL.md',
      'browser-control/agents/openai.yaml',
      'skill-creator/SKILL.md',
      'skill-creator/agents/openai.yaml',
      'skill-creator/references/openai_yaml.md',
      'skill-creator/scripts/generate_openai_yaml.py',
      'skill-creator/scripts/init_skill.py',
      'skill-creator/scripts/quick_validate.py',
    ]) {
      writeFile(path.join(skillsRoot, relativePath));
    }

    expect(() => assertBundledCodexSkills(skillsRoot)).toThrow(
      `[bundled-skills] Unexpected bundled Codex skills in ${skillsRoot}. Expected: accrual-schedule, audit-xls, browser-control, computer-use, doc, media-creation, month-end-closer, pdf, playwright, roll-forward, screenshot, settings, skill-creator, slides, spreadsheets, transcribe, variance-commentary, wiki-bootstrap, wiki-ingest, wiki-lint, wiki-maintainer, wiki-query, xlsx-author. Found: browser-control, skill-creator.`,
    );
  });

  test('fails when a bundled SKILL.md is missing its opening frontmatter delimiter', () => {
    const skillsRoot = makeTempDir();

    for (const [skillName, requiredFiles] of Object.entries(REQUIRED_BUNDLED_SKILL_FILES as Record<string, string[]>)) {
      for (const relativePath of requiredFiles) {
        const targetPath = path.join(skillsRoot, skillName, relativePath);
        if (relativePath === 'SKILL.md') {
          mkdirSync(path.dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, 'name: broken\ndescription: broken\n---\n\n# Body\n');
        } else {
          writeFile(targetPath);
        }
      }
    }

    expect(() => assertBundledCodexSkills(skillsRoot)).toThrow(
      `[bundled-skills] ${path.join(skillsRoot, 'accrual-schedule', 'SKILL.md')} must start with YAML frontmatter delimited by ---`,
    );
  });
});
