import { describe, expect, test } from 'bun:test';
import { trEn } from '../serverI18n';

const initialTranslation = trEn('errors.chat.streamStartHttp', { status: 503 });

describe('server translations', () => {
  test('are available synchronously on import', () => {
    expect(initialTranslation).toBe('Failed to start turn stream (HTTP 503).');
  });

  test('interpolate without escaping server text', () => {
    expect(trEn('errors.turn.responsesContract.provider', { provider: '<local>' }))
      .toBe('The selected model on <local> does not support Interpreter\'s Responses/tool-calling contract.');
  });
});
