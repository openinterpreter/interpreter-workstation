import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import {
  deletePathWithRetries,
  findProcessesUsingPaths,
  isDirectScriptExecution,
  resolveDarwinTccBundleIds,
} from './reset-config';

describe('findProcessesUsingPaths', () => {
  test('matches only processes that are using the reset directories', () => {
    const listing = [
      '101 /Applications/Interpreter.app --user-data-dir=/Users/alice/Library/Application Support/interpreter',
      '102 /Users/alice/app/resources/codex app-server --listen stdio:// -c skills={config=[{path="/Users/alice/Library/Application Support/interpreter/codex-home/skills/doc/SKILL.md"}]}',
      '103 node /Users/alice/.local/bin/codex',
      '104 /usr/bin/git clone https://github.com/openai/plugins.git /Users/alice/Library/Application Support/interpreter/codex-home/.tmp/plugins-clone-abc',
    ].join('\n');

    expect(
      findProcessesUsingPaths(listing, [
        '/Users/alice/Library/Application Support/interpreter',
      ], 'darwin'),
    ).toEqual([
      {
        pid: 101,
        command:
          '/Applications/Interpreter.app --user-data-dir=/Users/alice/Library/Application Support/interpreter',
      },
      {
        pid: 102,
        command:
          '/Users/alice/app/resources/codex app-server --listen stdio:// -c skills={config=[{path="/Users/alice/Library/Application Support/interpreter/codex-home/skills/doc/SKILL.md"}]}',
      },
      {
        pid: 104,
        command:
          '/usr/bin/git clone https://github.com/openai/plugins.git /Users/alice/Library/Application Support/interpreter/codex-home/.tmp/plugins-clone-abc',
      },
    ]);
  });
});

describe('isDirectScriptExecution', () => {
  test('detects tsx script invocation by argv entry', () => {
    expect(isDirectScriptExecution(import.meta.url, fileURLToPath(import.meta.url))).toBe(true);
    expect(isDirectScriptExecution(import.meta.url, '/tmp/other-script.ts')).toBe(false);
    expect(isDirectScriptExecution(import.meta.url, undefined)).toBe(false);
  });
});

describe('deletePathWithRetries', () => {
  test('retries transient delete races before succeeding', async () => {
    let attempts = 0;
    const waits: number[] = [];

    await deletePathWithRetries('/tmp/test-reset-target', {
      rmImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error('directory not empty') as NodeJS.ErrnoException;
          error.code = 'ENOTEMPTY';
          throw error;
        }
      },
      sleepImpl: async (ms: number) => {
        waits.push(ms);
      },
      retryDelaysMs: [1, 2, 3],
    });

    expect(attempts).toBe(3);
    expect(waits).toEqual([1, 2]);
  });
});

describe('resolveDarwinTccBundleIds', () => {
  test('includes packaged and known dev bundle identifiers', () => {
    expect(
      resolveDarwinTccBundleIds({
        darwinBundleIdentifier: 'com.openinterpreter.interpreter',
      }),
    ).toEqual([
      'com.openinterpreter.interpreter',
      'com.interpreter.dev',
      'com.openinterpreter.interpreter.dev',
      'com.openinterpreter.interpreter-internal.dev',
    ]);
  });
});
