import { describe, expect, test } from 'bun:test';

import { resolveRipgrepBinaryPath, validateRipgrepBinary } from './ripgrep';

describe('resolveRipgrepBinaryPath', () => {
  test('rewrites Windows packaged path', () => {
    const input = 'C:\\Program Files\\Interpreter\\resources\\app.asar\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe';
    expect(resolveRipgrepBinaryPath(input)).toBe(
      'C:\\Program Files\\Interpreter\\resources\\app.asar.unpacked\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe'
    );
  });

  test('rewrites macOS packaged path', () => {
    const input = '/Applications/Interpreter.app/Contents/Resources/app.asar/node_modules/@vscode/ripgrep/bin/rg';
    expect(resolveRipgrepBinaryPath(input)).toBe(
      '/Applications/Interpreter.app/Contents/Resources/app.asar.unpacked/node_modules/@vscode/ripgrep/bin/rg'
    );
  });

  test('rewrites Linux packaged path', () => {
    const input = '/opt/Interpreter/resources/app.asar/node_modules/@vscode/ripgrep/bin/rg';
    expect(resolveRipgrepBinaryPath(input)).toBe(
      '/opt/Interpreter/resources/app.asar.unpacked/node_modules/@vscode/ripgrep/bin/rg'
    );
  });

  test('leaves non-packaged path unchanged', () => {
    const input = '/workspace/node_modules/@vscode/ripgrep/bin/rg';
    expect(resolveRipgrepBinaryPath(input)).toBe(input);
  });
});

describe('validateRipgrepBinary', () => {
  test('validates that ripgrep binary exists and runs', async () => {
    const result = await validateRipgrepBinary();
    expect(result.ok).toBe(true);
    expect(result.path).toBeTruthy();
    expect(result.version).toMatch(/ripgrep/);
  });
});
