import { afterEach, describe, expect, test } from 'bun:test';

import { interpreterServerDefinition } from './index';
import {
  browserPageSelectTool,
  setBrowserPageSelectProviderForTest,
  setBrowserPageSelectRelayEnsureProviderForTest,
} from './browserPageSelectTool';
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

function textFromResult(result: Awaited<ReturnType<typeof browserPageSelectTool.handler>>): string {
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return String(first?.text ?? '');
}

describe('browser page select tool', () => {
  afterEach(() => {
    setBrowserPageSelectRelayEnsureProviderForTest(null);
    setBrowserPageSelectProviderForTest(null);
  });

  test('is exposed through the Interpreter builtin server', () => {
    expect(interpreterServerDefinition.tools.map((tool) => tool.name)).toContain('interpreter_browser_page_select');
  });

  test('selects a browser page option through the relay-backed provider', async () => {
    const calls: Array<{
      tabRef: string;
      frameId?: number;
      refId: string;
      value: string;
      durationMs?: number;
    }> = [];
    let ensureCalled = false;
    setBrowserPageSelectRelayEnsureProviderForTest(async () => {
      ensureCalled = true;
    });
    setBrowserPageSelectProviderForTest(async (input) => {
      calls.push(input);
      return {
        tabRef: input.tabRef,
        chromeTabId: 201,
        frameId: input.frameId ?? 0,
        refId: input.refId,
        value: input.value,
        bounds: { x: 10, y: 20, width: 80, height: 32 },
      };
    });

    const result = await browserPageSelectTool.handler({
      target_identity: targetIdentity,
      ref_id: 'browser-element:rev-1:0',
      value: 'operations',
      duration_ms: 900,
    });

    expect(result.isError).toBe(false);
    expect(ensureCalled).toBe(true);
    expect(calls).toEqual([{
      tabRef: 'install:profile-1:chrome-tab:201',
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      value: 'operations',
      durationMs: 900,
    }]);
    expect(textFromResult(result)).toBe(
      'Selected browser page element browser-element:rev-1:0 in install:profile-1:chrome-tab:201 frame=0 value="operations"',
    );
  });

  test('fails loudly for malformed input and stale refs', async () => {
    const malformed = await browserPageSelectTool.handler({
      target_identity: targetIdentity,
      ref_id: 'browser-element:rev-1:0',
    });
    expect(malformed.isError).toBe(true);
    expect(textFromResult(malformed)).toBe('Failed to select browser page element: value must be a string.');

    setBrowserPageSelectRelayEnsureProviderForTest(async () => {});
    setBrowserPageSelectProviderForTest(async () => {
      throw new Error('refId is stale or not visible');
    });

    const stale = await browserPageSelectTool.handler({
      target_identity: targetIdentity,
      ref_id: 'browser-element:old:0',
      value: 'support',
    });
    expect(stale.isError).toBe(true);
    expect(textFromResult(stale)).toBe('Failed to select browser page element: refId is stale or not visible');
  });
});
