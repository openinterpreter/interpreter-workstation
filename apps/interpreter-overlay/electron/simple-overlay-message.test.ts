import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { buildSimpleOverlayMessage, resolveSimpleOverlayWindowSessionKey } from './simple-overlay-message';

describe('Simple overlay message envelope', () => {
  test('keeps the user request and selected file context bounded', () => {
    const output = buildSimpleOverlayMessage('Please summarize', [{
      id: 'file-1', kind: 'file', role: 'reference', name: 'notes.md',
      filePath: '/Documents/Interpreter/notes.md', mimeType: 'text/markdown', sizeBytes: 5,
    }]);
    expect(output).toContain('[Message from the Simple desktop overlay]');
    expect(output).toContain('/Documents/Interpreter/notes.md');
    expect(output).toContain('Please summarize');
    expect(buildSimpleOverlayMessage('a'.repeat(50000), []).length).toBeLessThan(20100);
  });

  test('targets the explicit interface window before falling back to selected context', () => {
    const context = [{
      id: 'target-1', kind: 'region' as const, role: 'target' as const,
      label: 'Interface', scopeKind: 'active-app' as const,
      bounds: { x: 0, y: 0, width: 100, height: 100 }, displayId: 1,
      targetWindowSessionKey: 'context-window',
      targetIdentity: {} as never, snapshot: {} as never,
      previewText: null, previewImageDataUrl: null,
    }];
    expect(resolveSimpleOverlayWindowSessionKey('explicit-window', context)).toBe('explicit-window');
    expect(resolveSimpleOverlayWindowSessionKey(null, context)).toBe('context-window');
    expect(resolveSimpleOverlayWindowSessionKey(null, [])).toBeNull();
  });
});

describe('Simple overlay runtime policy', () => {
  test('keeps the overlay available in Simple mode and follows live experience changes', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'service.ts'), 'utf8');

    expect(source).toContain("onBooleanUISettingChanged('advancedMode'");
    expect(source).toContain('if (simpleMode && this.accessState.allowed)');
    expect(source).toContain('enabled: true');
    expect(source).toContain("if (this.effectiveSettings.enabled && !this.baseUrl && !simpleMode)");
    expect(source).toContain("simpleMode: !getBooleanUISettingSync('advancedMode')");
  });
});
