import { afterEach, describe, expect, test } from 'bun:test';

import { interpreterServerDefinition } from './index';
import {
  browserPageTypeTool,
  setBrowserPageTypeProviderForTest,
  setBrowserPageTypeRelayEnsureProviderForTest,
} from './browserPageTypeTool';
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

function textFromResult(result: Awaited<ReturnType<typeof browserPageTypeTool.handler>>): string {
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return String(first?.text ?? '');
}

describe('browser page type tool', () => {
  afterEach(() => {
    setBrowserPageTypeRelayEnsureProviderForTest(null);
    setBrowserPageTypeProviderForTest(null);
  });

  test('is exposed through the Interpreter builtin server', () => {
    expect(interpreterServerDefinition.tools.map((tool) => tool.name)).toContain('interpreter_browser_page_type');
  });

  test('types into a browser page element through the relay-backed provider', async () => {
    const calls: Array<{
      tabRef: string;
      frameId?: number;
      refId: string;
      text: string;
      durationMs?: number;
    }> = [];
    let ensureCalled = false;
    setBrowserPageTypeRelayEnsureProviderForTest(async () => {
      ensureCalled = true;
    });
    setBrowserPageTypeProviderForTest(async (input) => {
      calls.push(input);
      return {
        tabRef: input.tabRef,
        chromeTabId: 201,
        frameId: input.frameId ?? 0,
        refId: input.refId,
        value: input.text,
        bounds: { x: 10, y: 20, width: 80, height: 32 },
      };
    });

    const result = await browserPageTypeTool.handler({
      target_identity: targetIdentity,
      ref_id: 'browser-element:rev-1:0',
      text: 'Ada Lovelace',
      duration_ms: 900,
    });

    expect(result.isError).toBe(false);
    expect(ensureCalled).toBe(true);
    expect(calls).toEqual([{
      tabRef: 'install:profile-1:chrome-tab:201',
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      text: 'Ada Lovelace',
      durationMs: 900,
    }]);
    expect(textFromResult(result)).toBe(
      'Typed browser page element browser-element:rev-1:0 in install:profile-1:chrome-tab:201 frame=0',
    );
  });

  test('fails loudly for malformed input and stale refs', async () => {
    const malformed = await browserPageTypeTool.handler({
      target_identity: targetIdentity,
      ref_id: 'browser-element:rev-1:0',
    });
    expect(malformed.isError).toBe(true);
    expect(textFromResult(malformed)).toBe('Failed to type browser page element: text must be a string.');

    setBrowserPageTypeRelayEnsureProviderForTest(async () => {});
    setBrowserPageTypeProviderForTest(async () => {
      throw new Error('refId is stale or not visible');
    });

    const stale = await browserPageTypeTool.handler({
      target_identity: targetIdentity,
      ref_id: 'browser-element:old:0',
      text: 'Grace Hopper',
    });
    expect(stale.isError).toBe(true);
    expect(textFromResult(stale)).toBe('Failed to type browser page element: refId is stale or not visible');
  });
});
