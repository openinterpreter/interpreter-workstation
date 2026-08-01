import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const INTERPRETER_BINARY = join(
  ROOT,
  'resources',
  'oix',
  `${process.platform}-${process.arch}`,
  'bin',
  process.platform === 'win32' ? 'interpreter.exe' : 'interpreter',
);

function extractJsonPayload(rawOutput) {
  const firstJsonLine = rawOutput
    .split('\n')
    .findIndex((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('[') || trimmed.startsWith('{');
    });

  if (firstJsonLine === -1) {
    throw new Error(
      `interpreter mcp list --json did not return JSON output: ${JSON.stringify(rawOutput)}`,
    );
  }

  return rawOutput
    .split('\n')
    .slice(firstJsonLine)
    .join('\n');
}

if (!existsSync(INTERPRETER_BINARY)) {
  throw new Error(
    `Bundled Interpreter binary not found at ${INTERPRETER_BINARY}. Run \`pnpm run download:oix -- --current-platform\` first.`,
  );
}

const testInterpreterHome = mkdtempSync(join(tmpdir(), 'interpreter-cli-smoke-'));

try {
  const isolatedHome = join(testInterpreterHome, 'home');
  const env = {
    ...process.env,
    CODEX_HOME: testInterpreterHome,
    INTERPRETER_HOME: testInterpreterHome,
    OPEN_INTERPRETER_HOME: testInterpreterHome,
    INTERPRETER_DISABLE_SYSTEM_IMPORT: '1',
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
  };

  const stdout = execFileSync(INTERPRETER_BINARY, ['mcp', 'list', '--json'], {
    env,
    encoding: 'utf8',
  });

  const parsed = JSON.parse(extractJsonPayload(stdout));
  assert.ok(Array.isArray(parsed), `Expected array payload, got: ${JSON.stringify(parsed)}`);
  console.log(`[interpreter-cli-smoke] ok binary=${INTERPRETER_BINARY} entries=${parsed.length}`);
} finally {
  rmSync(testInterpreterHome, { recursive: true, force: true });
}
