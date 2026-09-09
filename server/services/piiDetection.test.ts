import { describe, expect, test } from 'bun:test';

import { parseRedactTextResult } from './piiDetection';

describe('parseRedactTextResult', () => {
  test('maps basemind redact_text output onto the renderer contract', () => {
    const parsed = parseRedactTextResult({
      structuredContent: {
        result: {
          redacted_text: 'Call [EMAIL_0]',
          rehydration_map: { '[EMAIL_0]': 'john@example.com' },
          detections: [
            { category: 'email', start: 5, end: 21, text: 'john@example.com', confidence: 0.9 },
          ],
        },
      },
    });
    expect(parsed.redacted_text).toBe('Call [EMAIL_0]');
    expect(parsed.rehydration_map).toEqual({ '[EMAIL_0]': 'john@example.com' });
    expect(parsed.detections).toHaveLength(1);
  });

  test('returns empty detections for unknown shapes instead of throwing', () => {
    expect(parseRedactTextResult(null)).toEqual({
      redacted_text: '',
      rehydration_map: {},
      detections: [],
    });
  });
});
