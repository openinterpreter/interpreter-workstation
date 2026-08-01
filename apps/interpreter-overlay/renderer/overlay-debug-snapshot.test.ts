import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

import { getRendererDomSnapshot } from './overlay-debug-snapshot';

describe('getRendererDomSnapshot', () => {
  test('counts a large root subtree without reading root innerHTML', () => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const document = dom.window.document;
    const root = document.getElementById('root');
    if (!(root instanceof dom.window.HTMLElement)) {
      throw new Error('Expected test root to be an HTMLElement');
    }

    for (let index = 0; index < 2_005; index += 1) {
      root.appendChild(document.createElement('span'));
    }

    Object.defineProperty(root, 'innerHTML', {
      configurable: true,
      get() {
        throw new Error('root.innerHTML was read');
      },
    });

    const snapshot = getRendererDomSnapshot(document, dom.window as unknown as Window & typeof globalThis);

    expect(snapshot.rootChildCount).toBe(2_005);
    expect(snapshot.rootDescendantElements).toEqual({ count: 2_000, truncated: true });
    expect(Object.keys(snapshot)).not.toContain('rootInnerHtmlLength');
  });
});
