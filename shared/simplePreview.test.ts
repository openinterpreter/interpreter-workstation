import { describe, expect, test } from 'bun:test';
import { SIMPLE_PREVIEW_TICKET_PARAM, simplePreviewTarget } from './simplePreview';

describe('Simple preview target', () => {
  test('ignores only the renewable preview ticket', () => {
    const base = 'https://preview.example/?windowSessionKey=ws_1';
    expect(simplePreviewTarget(`${base}&${SIMPLE_PREVIEW_TICKET_PARAM}=t1.a.1.b`))
      .toBe(simplePreviewTarget(`${base}&${SIMPLE_PREVIEW_TICKET_PARAM}=t1.c.2.d`));
    expect(simplePreviewTarget(base)).not.toBe(simplePreviewTarget('https://preview.example/?windowSessionKey=ws_2'));
    expect(simplePreviewTarget('http://127.0.0.1:43800')).toBe('http://127.0.0.1:43800/');
    expect(simplePreviewTarget(null)).toBeNull();
  });
});
