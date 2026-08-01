import { afterEach, describe, expect, test } from 'bun:test';

import { interpreterServerDefinition } from './index';
import {
  browserPageScrollTool,
  setBrowserPageScrollProviderForTest,
  setBrowserPageScrollRelayEnsureProviderForTest,
} from './browserPageScrollTool';
import { buildBrowserPageTargetIdentity } from './browserTargetIdentity';

const targetIdentity = buildBrowserPageTargetIdentity({
  tabRef: 'install:profile-1:chrome-tab:201',
  chromeTabId: 201,
  browserWindowId: 10,
  browserProfilePolicyId: 'install:profile-1',
  origin: 'https://example.com',
  frameId: 0,
  chromeDocumentId: 'doc-1',
  documentRevision: 'rev-1',
  url: 'https://example.com/form',
});

function textFromResult(result: Awaited<ReturnType<typeof browserPageScrollTool.handler>>): string {
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return String(first?.text ?? '');
}

describe('browser page scroll tool', () => {
  afterEach(() => {
    setBrowserPageScrollRelayEnsureProviderForTest(null);
    setBrowserPageScrollProviderForTest(null);
  });

  test('is exposed through the Interpreter builtin server', () => {
    expect(interpreterServerDefinition.tools.map((tool) => tool.name)).toContain('interpreter_browser_page_scroll');
  });

  test('scrolls a browser page through the relay-backed provider', async () => {
    const calls: Array<{
      tabRef: string;
      frameId?: number;
      refId?: string;
      deltaX?: number;
      deltaY?: number;
    }> = [];
    let ensureCalled = false;
    setBrowserPageScrollRelayEnsureProviderForTest(async () => {
      ensureCalled = true;
    });
    setBrowserPageScrollProviderForTest(async (input) => {
      calls.push(input);
      return {
        tabRef: input.tabRef,
        chromeTabId: 201,
        frameId: input.frameId ?? 0,
        scrollX: input.deltaX ?? 0,
        scrollY: input.deltaY ?? 0,
        viewport: { width: 1280, height: 720 },
      };
    });

    const result = await browserPageScrollTool.handler({
      target_identity: targetIdentity,
      delta_y: 700,
    });

    expect(result.isError).toBe(false);
    expect(ensureCalled).toBe(true);
    expect(calls).toEqual([{
      tabRef: 'install:profile-1:chrome-tab:201',
      frameId: 0,
      deltaX: 0,
      deltaY: 700,
    }]);
    expect(textFromResult(result)).toBe(
      'Scrolled browser page install:profile-1:chrome-tab:201 frame=0 to x=0 y=700',
    );
  });

  test('passes optional element ref for element-scoped browser scrolls', async () => {
    const calls: Array<{
      tabRef: string;
      frameId?: number;
      refId?: string;
      deltaX?: number;
      deltaY?: number;
    }> = [];
    setBrowserPageScrollRelayEnsureProviderForTest(async () => {});
    setBrowserPageScrollProviderForTest(async (input) => {
      calls.push(input);
      return {
        tabRef: input.tabRef,
        chromeTabId: 201,
        frameId: input.frameId ?? 0,
        refId: input.refId,
        scrollX: 0,
        scrollY: input.deltaY ?? 0,
        viewport: { width: 1280, height: 720 },
      };
    });

    const result = await browserPageScrollTool.handler({
      target_identity: targetIdentity,
      ref_id: 'browser-element:rev-1:4',
      delta_y: 240,
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{
      tabRef: 'install:profile-1:chrome-tab:201',
      frameId: 0,
      refId: 'browser-element:rev-1:4',
      deltaX: 0,
      deltaY: 240,
    }]);
    expect(textFromResult(result)).toBe(
      'Scrolled browser page element browser-element:rev-1:4 in install:profile-1:chrome-tab:201 frame=0 to x=0 y=240',
    );
  });

  test('fails loudly for malformed input and provider failures', async () => {
    const malformed = await browserPageScrollTool.handler({
      target_identity: targetIdentity,
    });
    expect(malformed.isError).toBe(true);
    expect(textFromResult(malformed)).toBe('Failed to scroll browser page: delta_x or delta_y must be non-zero.');

    setBrowserPageScrollRelayEnsureProviderForTest(async () => {});
    setBrowserPageScrollProviderForTest(async () => {
      throw new Error('Browser tab not found for tabRef: missing');
    });

    const missing = await browserPageScrollTool.handler({
      target_identity: buildBrowserPageTargetIdentity({
        tabRef: 'missing',
        chromeTabId: 999,
        browserWindowId: 10,
        browserProfilePolicyId: 'install:profile-1',
        origin: 'https://example.com',
        frameId: 0,
        chromeDocumentId: 'doc-1',
        documentRevision: 'rev-1',
        url: 'https://example.com/form',
      }),
      delta_y: 100,
    });
    expect(missing.isError).toBe(true);
    expect(textFromResult(missing)).toBe(
      'Failed to scroll browser page: Browser tab not found for tabRef: missing',
    );
  });
});
