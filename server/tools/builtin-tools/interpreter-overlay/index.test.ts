import { describe, expect, test } from 'bun:test';

import { interpreterOverlayServerDefinition } from './index';

describe('interpreterOverlayServerDefinition', () => {
  test('exposes only the shared live overlay tools to normal agents', () => {
    expect(interpreterOverlayServerDefinition.tools.map((tool) => tool.name)).toEqual([
      'overlay_read_context',
      'overlay_screenshot',
      'computer_batch',
      'overlay_show_drawings',
      'overlay_clear_drawings',
      'call_hidden_agent',
      'overlay_detach',
      'overlay_complete',
    ]);
  });

  test('does not expose direct legacy evidence tools', () => {
    const toolNames = interpreterOverlayServerDefinition.tools.map((tool) => tool.name);

    expect(toolNames).not.toContain('query_attachment');
    expect(toolNames).not.toContain('query_screen');
  });
});
