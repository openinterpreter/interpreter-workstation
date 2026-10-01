import { describe, expect, test } from 'bun:test';
import { buildSimpleOverlayMessage } from './simple-overlay-message';

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
});
