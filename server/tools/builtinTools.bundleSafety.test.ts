import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const builtinToolsSource = fs.readFileSync(
  path.join(import.meta.dir, 'builtinTools.ts'),
  'utf8',
);

describe('builtinTools bundler visibility', () => {
  test('uses bundler-visible static imports for builtin server entrypoints', () => {
    expect(builtinToolsSource).toContain("import { interpreterServerDefinition } from './builtin-tools/workstation/index';");
    expect(builtinToolsSource).toContain("import { utilityServerDefinition } from './builtin-tools/utility/index';");
    expect(builtinToolsSource).toContain("import { tasksServerDefinition } from './builtin-tools/tasks/index';");
    expect(builtinToolsSource).toContain("import { askUserServerDefinition } from './builtin-tools/ask-user/index';");
    expect(builtinToolsSource).toContain("import { mcpManagementServerDefinition } from './builtin-tools/mcp-management/index';");
    expect(builtinToolsSource).toContain("import { mediaAiServerDefinition } from './builtin-tools/media-ai/index';");
  });

  test('does not hide builtin server entrypoints behind joined require paths', () => {
    expect(builtinToolsSource).not.toContain("modulePathParts.join('/')");
    expect(builtinToolsSource).not.toContain("require(['./builtin-tools/");
  });

  test('does not use import.meta-based createRequire for conditional builtin loaders', () => {
    expect(builtinToolsSource).not.toContain('createRequire(import.meta.url)');
  });
});
