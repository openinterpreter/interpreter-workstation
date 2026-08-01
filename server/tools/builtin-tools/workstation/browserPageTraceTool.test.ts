import { afterEach, describe, expect, test } from 'bun:test';

import { interpreterServerDefinition } from './index';
import {
  browserPageTraceTool,
  setBrowserPageTraceProviderForTest,
  setBrowserPageTraceRelayEnsureProviderForTest,
} from './browserPageTraceTool';
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

function textFromResult(result: Awaited<ReturnType<typeof browserPageTraceTool.handler>>): string {
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return String(first?.text ?? '');
}

describe('browser page trace tool', () => {
  afterEach(() => {
    setBrowserPageTraceRelayEnsureProviderForTest(null);
    setBrowserPageTraceProviderForTest(null);
  });

  test('is exposed through the Interpreter builtin server', () => {
    expect(interpreterServerDefinition.tools.map((tool) => tool.name)).toContain('interpreter_browser_page_trace');
  });

  test('draws a browser page trace through the relay-backed provider', async () => {
    const calls: Array<{
      tabRef: string;
      frameId?: number;
      refId?: string;
      durationMs?: number;
    }> = [];
    let ensureCalled = false;
    setBrowserPageTraceRelayEnsureProviderForTest(async () => {
      ensureCalled = true;
    });
    setBrowserPageTraceProviderForTest(async (input) => {
      calls.push(input);
      return {
        tabRef: input.tabRef,
        chromeTabId: 201,
        frameId: input.frameId ?? 0,
        refId: input.refId ?? null,
        bounds: { x: 10, y: 20, width: 80, height: 32 },
      };
    });

    const result = await browserPageTraceTool.handler({
      target_identity: targetIdentity,
      ref_id: 'browser-element:rev-1:0',
      duration_ms: 900,
    });

    expect(result.isError).toBe(false);
    expect(ensureCalled).toBe(true);
    expect(calls).toEqual([{
      tabRef: 'install:profile-1:chrome-tab:201',
      frameId: 0,
      refId: 'browser-element:rev-1:0',
      durationMs: 900,
    }]);
    expect(textFromResult(result)).toBe(
      'Drew browser page trace for install:profile-1:chrome-tab:201 frame=0 ref=browser-element:rev-1:0',
    );
  });

  test('fails loudly for malformed input and stale refs', async () => {
    const malformed = await browserPageTraceTool.handler({ target_identity: targetIdentity });
    expect(malformed.isError).toBe(true);
    expect(textFromResult(malformed)).toBe('Failed to draw browser page trace: ref_id or bounds is required.');

    setBrowserPageTraceRelayEnsureProviderForTest(async () => {});
    setBrowserPageTraceProviderForTest(async () => {
      throw new Error('refId is stale or not visible');
    });

    const stale = await browserPageTraceTool.handler({
      target_identity: targetIdentity,
      ref_id: 'browser-element:old:0',
    });
    expect(stale.isError).toBe(true);
    expect(textFromResult(stale)).toBe('Failed to draw browser page trace: refId is stale or not visible');
  });
});
