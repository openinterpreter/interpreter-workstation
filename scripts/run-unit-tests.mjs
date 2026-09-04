import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const ROOT = process.cwd();
const PNPM_BIN = process.platform === 'win32' ? 'pnpm' : 'pnpm';
const VOICE_TEST_PATTERNS = [
  /\/agent\/utils\/ambientVoice\.test\.ts$/,
  /\/agent\/utils\/qwenVoiceStreamBridge\.test\.ts$/,
  /\/agent\/utils\/voiceTranscript\.test\.ts$/,
  /\/server\/utils\/qwenAsrStream\.test\.ts$/,
];
const CODEX_INTEGRATION_TEST_PATTERNS = [
  /\/src\/lib\/codex\/.*\.integration\.test\.ts$/,
];
const ROOT_DIRS = [
  'server',
  'shared',
  'agent',
  join('electron', 'utils'),
  join('electron', 'services'),
  join('src', 'stores'),
  join('src', 'hooks'),
  join('src', 'utils'),
  join('src', 'lib'),
  join('apps', 'interpreter-overlay', 'electron'),
  join('apps', 'interpreter-overlay', 'renderer'),
];
const LEGACY_BUN_BATCH_SIZE = 1;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
      continue;
    }
    if (
      entry.isFile()
      && fullPath.endsWith('.test.ts')
      && !fullPath.endsWith('.live.test.ts')
      && !fullPath.endsWith('.vitest.test.ts')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function isVoiceUnitTest(filePath) {
  const normalizedPath = filePath.replaceAll('\\', '/');
  return VOICE_TEST_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

function isCodexIntegrationTest(filePath) {
  const normalizedPath = filePath.replaceAll('\\', '/');
  return CODEX_INTEGRATION_TEST_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

function ensureBundledJsReplRuntime() {
  execFileSync(PNPM_BIN, ['run', 'ensure:js-repl-runtime-assets'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function bundledInterpreterBinaryPath() {
  return resolve(
    ROOT,
    'resources',
    'oix',
    `${process.platform}-${process.arch}`,
    'bin',
    process.platform === 'win32' ? 'interpreter.exe' : 'interpreter',
  );
}

function ensureBundledInterpreterCliSmoke() {
  const interpreterBinary = bundledInterpreterBinaryPath();
  if (!existsSync(interpreterBinary)) {
    throw new Error(`Bundled Interpreter binary not found at ${interpreterBinary}. Run \`pnpm run download:oix -- --current-platform\` first.`);
  }

  execFileSync(PNPM_BIN, ['run', 'test:interpreter:smoke'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function bunSupportsTestIsolation() {
  const version = execFileSync('bun', ['--version'], {
    encoding: 'utf8',
  }).trim();
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 3);
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function runBun(args, env) {
  return new Promise((resolveExitCode) => {
    const child = spawn('bun', args, { stdio: 'inherit', env });
    child.on('exit', (code) => resolveExitCode(code ?? 1));
    child.on('error', () => resolveExitCode(1));
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const voiceOnly = rawArgs.includes('--voice');
  const extraArgs = rawArgs.filter((arg) => arg !== '--voice');
  console.log(`Running Bun ${voiceOnly ? 'voice ' : ''}unit tests (.test.ts only, excluding .vitest.test.ts). Use \`pnpm run test:vitest\` for renderer and browser-environment tests.`);
  const testFiles = [];
  for (const rootDir of ROOT_DIRS) {
    const fullRoot = resolve(ROOT, rootDir);
    try {
      const stats = await stat(fullRoot);
      if (!stats.isDirectory()) continue;
      testFiles.push(...await walk(fullRoot));
    } catch {
      // Ignore missing dirs
    }
  }

  const scopedTestFiles = voiceOnly
    ? testFiles.filter(isVoiceUnitTest)
    : testFiles.filter((filePath) => !isVoiceUnitTest(filePath));

  if (scopedTestFiles.length === 0) {
    console.error(`No ${voiceOnly ? 'voice ' : ''}unit test files found.`);
    process.exit(1);
  }

  if (scopedTestFiles.some(isCodexIntegrationTest)) {
    ensureBundledJsReplRuntime();
  }

  ensureBundledInterpreterCliSmoke();

  const supportsIsolation = bunSupportsTestIsolation();
  const isolationArgs = supportsIsolation ? ['--isolate'] : [];
  const relativeTestFiles = scopedTestFiles.map((filePath) => relative(ROOT, filePath));
  // Bun 1.2 does not support per-file isolation and can enter a sustained
  // 100%-CPU/ever-growing-memory loop after loading the entire suite at once.
  // Keep current Bun versions in one isolated invocation; split only the legacy
  // runner into deterministic subprocesses.
  const testBatches = supportsIsolation
    ? [relativeTestFiles]
    : chunk(relativeTestFiles, LEGACY_BUN_BATCH_SIZE);
  const testHomeParent = process.platform === 'win32'
    ? join(ROOT, '.tmp')
    : tmpdir();
  await mkdir(testHomeParent, { recursive: true });
  const testHome = await mkdtemp(join(testHomeParent, 'interpreter-unit-home-'));
  const env = {
    ...process.env,
    HOME: testHome,
    USERPROFILE: testHome,
    // NOTE(victor): Keep userData distinct from ~/.interpreter so migration tests
    // NOTE(victor): exercise the real move instead of collapsing old/new paths.
    INTERPRETER_USER_DATA_DIR: join(testHome, 'interpreter-user-data'),
  };
  // INTERPRETER_HOME takes precedence over HOME; omit any inherited value so
  // the unit suite remains inside the temporary test home.
  delete env.INTERPRETER_HOME;
  let exitCode = 0;
  try {
    for (const [index, batch] of testBatches.entries()) {
      if (testBatches.length > 1) {
        console.log(`Running unit-test batch ${index + 1}/${testBatches.length} (${batch.length} files).`);
      }
      exitCode = await runBun(
        ['test', ...isolationArgs, ...extraArgs, ...batch],
        env,
      );
      if (exitCode !== 0) {
        break;
      }
    }
  } finally {
    await rm(testHome, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

await main();
