import { describe, expect, test } from 'bun:test';
import { addVideoReviewNote, formatVideoTime, parseVideoReviewNotes } from './videoReviewNotes';

describe('video review notes', () => {
  test('captures the video playhead, not wall-clock time, and preserves fractional seconds', () => {
    const result = addVideoReviewNote({ version: 1, notes: [] }, {
      id: 'comment-1', atSeconds: 61.375, text: '  The corner is too dark.  ',
    });
    expect(result.notes[0]).toEqual({ id: 'comment-1', atSeconds: 61.375, text: 'The corner is too dark.' });
    expect(formatVideoTime(result.notes[0]!.atSeconds)).toBe('00:01:01');
    expect(parseVideoReviewNotes(JSON.stringify(result))).toEqual(result);
  });

  test('rejects malformed, duplicate or non-finite timestamps rather than corrupting sidecar', () => {
    const first = addVideoReviewNote({ version: 1, notes: [] }, { id: 'one', atSeconds: 0, text: 'intro' });
    expect(() => addVideoReviewNote(first, { id: 'one', atSeconds: 2, text: 'duplicate' })).toThrow();
    expect(() => addVideoReviewNote(first, { id: 'two', atSeconds: Number.NaN, text: 'bad' })).toThrow();
    expect(() => parseVideoReviewNotes('{"version":1,"notes":[{"id":"bad","atSeconds":-1,"text":"bad"}]}')).toThrow();
    expect(() => parseVideoReviewNotes('{"version":2,"notes":[]}')).toThrow();
  });
});
