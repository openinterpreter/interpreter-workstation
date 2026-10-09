import { describe, expect, test, vi } from 'vitest';

vi.mock('@/ipc', () => ({
  simpleLive: {
    status: async () => ({ configured: false, source: 'none' }),
    createSession: async () => ({ answerSdp: '', sessionId: '' }),
  },
}));

import { appendBoundedTranscript, delegatedRequestText } from './useSimpleLive';

describe('Simple GPT Live transcript delegation', () => {
  test('keeps only bounded recent voice context', () => {
    const transcript = appendBoundedTranscript('a'.repeat(3_990), 'b'.repeat(20));
    expect(transcript).toHaveLength(4_000);
    expect(transcript.endsWith('b'.repeat(20))).toBe(true);
  });

  test('sends one model-authored delegation message when GPT Live provides it', () => {
    expect(delegatedRequestText(
      { text: 'Open the June report and summarize it.' },
      'Uh, could you maybe open the June report?',
    )).toBe('Open the June report and summarize it.');
  });

  test('falls back to the current spoken request without replaying recent transcript', () => {
    expect(delegatedRequestText(undefined, '  Open the June report.  '))
      .toBe('Open the June report.');
  });
});
