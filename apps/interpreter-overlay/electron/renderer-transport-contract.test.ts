import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const RENDERER_DIR = path.resolve(import.meta.dir, '../renderer');

function listRendererSourceFiles(): string[] {
  return fs.readdirSync(RENDERER_DIR)
    .filter((fileName) => /\.(ts|tsx)$/.test(fileName))
    .map((fileName) => path.join(RENDERER_DIR, fileName));
}

describe('overlay renderer transport contract', () => {
  test('keeps tool semantics out of renderer source files', () => {
    const forbiddenPatterns = [
      /text-controller/,
      /text-controller-tool-catalog/,
      /text-controller-direct-command/,
      /overlay-agent-tools/,
      /server\/handlers\/toolServers/,
      /ToolManager/,
      /matchOverlayTextControllerDirectCommand/,
      /executeOverlayTextControllerDirectCommand/,
      /postAdvancedVoiceCreateCall/,
      /\/realtime\/calls/,
    ];

    for (const filePath of listRendererSourceFiles()) {
      const source = fs.readFileSync(filePath, 'utf8');
      for (const pattern of forbiddenPatterns) {
        expect(source, `${path.relative(RENDERER_DIR, filePath)} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
