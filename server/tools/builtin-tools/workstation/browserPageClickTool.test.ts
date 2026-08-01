import { afterEach, describe, expect, test } from 'bun:test';

import { interpreterServerDefinition } from './index';
import {
  browserPageClickTool,
  setBrowserPageClickProviderForTest,
  setBrowserPageClickRelayEnsureProviderForTest,
} from './browserPageClickTool';
import { buildBrowserPageTargetIdentity } from './browserTargetIdentity';
import { setBrowserPermissionReviewPromptProviderForTest } from './browserPermissionReviewPrompt';

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

function textFromResult(result: Awaited<ReturnType<typeof browserPageClickTool.handler>>): string {
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return String(first?.text ?? '');
}

describe('browser page click tool', () => {
  afterEach(() => {
    setBrowserPageClickRelayEnsureProviderForTest(null);
    setBrowserPageClickProviderForTest(null);
    setBrowserPermissionReviewPromptProviderForTest(null);
  });

  test('is exposed through the Interpreter builtin server', () => {
    expect(interpreterServerDefinition.tools.map((tool) => tool.name)).toContain('interpreter_browser_page_click');
  });

  test('clicks a browser page element through the relay-backed provider', async () => {
    const calls: Array<{
      tabRef: string;
      frameId?: number;
      refId: string;
      durationMs?: number;
    }> = [];
    let ensureCalled = false;
    setBrowserPageClickRelayEnsureProviderForTest(async () => {
      ensureCalled = true;
    });
    setBrowserPageClickProviderForTest(async (input) => {
      calls.push(input);
      return {
        tabRef: input.tabRef,
        chromeTabId: 201,
        frameId: input.frameId ?? 0,
        refId: input.refId,
        bounds: { x: 10, y: 20, width: 80, height: 32 },
      };
    });

    const result = await browserPageClickTool.handler({
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
      'Clicked browser page element browser-element:rev-1:0 in install:profile-1:chrome-tab:201 frame=0',
    );
  });

  test('fails loudly for malformed input and stale refs', async () => {
    const malformed = await browserPageClickTool.handler({ ref_id: 'browser-element:rev-1:0' });
    expect(malformed.isError).toBe(true);
    expect(textFromResult(malformed)).toBe('Failed to click browser page element: target_identity must be a browser-page object copied from a current browser page ref.');

    setBrowserPageClickRelayEnsureProviderForTest(async () => {});
    setBrowserPageClickProviderForTest(async () => {
      throw new Error('refId is stale or not visible');
    });

    const stale = await browserPageClickTool.handler({
      target_identity: targetIdentity,
      ref_id: 'browser-element:old:0',
    });
    expect(stale.isError).toBe(true);
    expect(textFromResult(stale)).toBe('Failed to click browser page element: refId is stale or not visible');
  });

  test('queues browser permission review card on browser policy denial', async () => {
    const prompts: Array<{
      toolName: string;
      tabRef: string;
      message: string;
      attemptedAction: string;
      contextAgentId?: string;
      contextToolCallId?: string;
    }> = [];
    setBrowserPageClickRelayEnsureProviderForTest(async () => {});
    setBrowserPageClickProviderForTest(async () => {
      throw new Error(
        'Interpreter browser settings blocked this request. Cannot use "https://shop.example.test/checkout" because it does not match the allowed page rules (no allowed page rules). Change this in Settings > Browser.',
      );
    });
    setBrowserPermissionReviewPromptProviderForTest(async (input) => {
      prompts.push({
        toolName: input.toolName,
        tabRef: input.tabRef,
        message: input.message,
        attemptedAction: input.attemptedAction,
        contextAgentId: input.context?.agentId,
        contextToolCallId: input.context?.toolCallId,
      });
      return { approved: false };
    });

    const result = await browserPageClickTool.handler({
      target_identity: buildBrowserPageTargetIdentity({
        tabRef: 'install:work:chrome-tab:91',
        chromeTabId: 91,
        browserWindowId: 9,
        browserProfilePolicyId: 'install:work',
        origin: 'https://shop.example.test',
        frameId: 0,
        chromeDocumentId: 'doc-work',
        documentRevision: 'rev-1',
        url: 'https://shop.example.test/checkout',
      }),
      ref_id: 'browser-element:rev-1:0',
    }, {
      agentId: 'agent-1',
      toolCallId: 'tool-call-1',
    });

    expect(result.isError).toBe(true);
    expect(textFromResult(result)).toContain('Interpreter browser settings blocked this request');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].toolName).toBe('interpreter_browser_page_click');
    expect(prompts[0].tabRef).toBe('install:work:chrome-tab:91');
    expect(prompts[0].message).toContain('Interpreter browser settings blocked this request');
    expect(prompts[0].attemptedAction).toBe('Click ref browser-element:rev-1:0 in frame 0.');
    expect(prompts[0].contextAgentId).toBe('agent-1');
    expect(prompts[0].contextToolCallId).toBe('tool-call-1');
  });

  test('retries once when browser ask permission is approved', async () => {
    const calls: Array<{ refId: string }> = [];
    setBrowserPageClickRelayEnsureProviderForTest(async () => {});
    setBrowserPageClickProviderForTest(async (input) => {
      calls.push({ refId: input.refId });
      if (calls.length === 1) {
        throw new Error(
          'Interpreter browser settings blocked this request. Cannot use "https://shop.example.test/checkout" because it does not match the allowed page rules (no allowed page rules). Change this in Settings > Browser.',
        );
      }
      return {
        tabRef: input.tabRef,
        chromeTabId: 91,
        frameId: input.frameId ?? 0,
        refId: input.refId,
        bounds: { x: 1, y: 2, width: 30, height: 20 },
      };
    });
    setBrowserPermissionReviewPromptProviderForTest(async () => ({
      approved: true,
      grant: {
        profileId: 'install:work',
        origin: 'https://shop.example.test',
        permissionKind: 'action',
      },
    }));

    const result = await browserPageClickTool.handler({
      target_identity: buildBrowserPageTargetIdentity({
        tabRef: 'install:work:chrome-tab:91',
        chromeTabId: 91,
        browserWindowId: 9,
        browserProfilePolicyId: 'install:work',
        origin: 'https://shop.example.test',
        frameId: 0,
        chromeDocumentId: 'doc-work',
        documentRevision: 'rev-1',
        url: 'https://shop.example.test/checkout',
      }),
      ref_id: 'browser-element:rev-1:0',
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      { refId: 'browser-element:rev-1:0' },
      { refId: 'browser-element:rev-1:0' },
    ]);
    expect(textFromResult(result)).toBe(
      'Clicked browser page element browser-element:rev-1:0 in install:work:chrome-tab:91 frame=0',
    );
  });
});
