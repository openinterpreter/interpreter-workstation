import { afterEach, describe, expect, test } from 'bun:test';

import { interpreterServerDefinition } from './index';
import {
  browserPageInspectTool,
  setBrowserPageInspectProviderForTest,
  setBrowserPageInspectRelayEnsureProviderForTest,
} from './browserPageInspectTool';
import { setBrowserPermissionReviewPromptProviderForTest } from './browserPermissionReviewPrompt';
import { buildBrowserPageTargetIdentity } from './browserTargetIdentity';

function textFromResult(result: Awaited<ReturnType<typeof browserPageInspectTool.handler>>): string {
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return String(first?.text ?? '');
}

describe('browser page inspect tool', () => {
  afterEach(() => {
    setBrowserPageInspectRelayEnsureProviderForTest(null);
    setBrowserPageInspectProviderForTest(null);
    setBrowserPermissionReviewPromptProviderForTest(null);
  });

  test('is exposed through the Interpreter builtin server', () => {
    expect(interpreterServerDefinition.tools.map((tool) => tool.name)).toContain('interpreter_browser_page_inspect');
  });

  test('inspects a browser page through the relay-backed provider', async () => {
    const calls: Array<{
      tabRef: string;
      maxElementsPerFrame?: number;
    }> = [];
    let ensureCalled = false;
    setBrowserPageInspectRelayEnsureProviderForTest(async () => {
      ensureCalled = true;
    });
    setBrowserPageInspectProviderForTest(async (input) => {
      calls.push(input);
      return {
        tabRef: input.tabRef,
        chromeTabId: 201,
        browserProfilePolicyId: 'install:profile-1',
        origin: 'https://example.com',
        frames: [
          {
            frameId: 0,
            chromeDocumentId: 'doc-1',
            url: 'https://example.com/form',
            documentRevision: 'rev-1',
            viewport: {
              width: 1280,
              height: 720,
              scrollX: 0,
              scrollY: 200,
              devicePixelRatio: 2,
            },
            totalElementCount: 3,
            returnedElementCount: 1,
            truncatedElementCount: 2,
            elements: [
              {
                refId: 'browser-element:rev-1:0',
                index: 0,
                tagName: 'button',
                role: 'button',
                name: 'Submit',
                text: 'Submit',
                value: null,
                inputType: null,
                checked: null,
                disabled: false,
                editable: false,
                clickable: true,
                bounds: { x: 10, y: 20, width: 80, height: 32 },
              },
            ],
          },
        ],
      };
    });

    const result = await browserPageInspectTool.handler({
      tab_ref: 'install:profile-1:chrome-tab:201',
      max_elements_per_frame: 5,
    });

    expect(result.isError).toBe(false);
    expect(ensureCalled).toBe(true);
    expect(calls).toEqual([{
      tabRef: 'install:profile-1:chrome-tab:201',
      maxElementsPerFrame: 5,
    }]);
    expect(JSON.parse(textFromResult(result))).toEqual({
      tab_ref: 'install:profile-1:chrome-tab:201',
      chrome_tab_id: 201,
      browser_profile_policy_id: 'install:profile-1',
      origin: 'https://example.com',
      frames: [
        {
          frame_id: 0,
          chrome_document_id: 'doc-1',
          url: 'https://example.com/form',
          document_revision: 'rev-1',
          viewport: {
            width: 1280,
            height: 720,
            scrollX: 0,
            scrollY: 200,
            devicePixelRatio: 2,
          },
          total_element_count: 3,
          returned_element_count: 1,
          truncated_element_count: 2,
          elements: [
            {
              ref_id: 'browser-element:rev-1:0',
              tab_ref: 'install:profile-1:chrome-tab:201',
              chrome_tab_id: 201,
              browser_profile_policy_id: 'install:profile-1',
              origin: 'https://example.com',
              frame_id: 0,
              chrome_document_id: 'doc-1',
              document_revision: 'rev-1',
              ref_lifetime: 'current_document_revision',
              target_identity: buildBrowserPageTargetIdentity({
                tabRef: 'install:profile-1:chrome-tab:201',
                chromeTabId: 201,
                browserWindowId: null,
                browserProfilePolicyId: 'install:profile-1',
                origin: 'https://example.com',
                frameId: 0,
                chromeDocumentId: 'doc-1',
                documentRevision: 'rev-1',
                url: 'https://example.com/form',
              }),
              index: 0,
              tag_name: 'button',
              role: 'button',
              name: 'Submit',
              text: 'Submit',
              value: null,
              input_type: null,
              checked: null,
              disabled: false,
              editable: false,
              clickable: true,
              bounds: { x: 10, y: 20, width: 80, height: 32 },
            },
          ],
        },
      ],
    });
  });

  test('fails loudly for malformed input and provider failures', async () => {
    const malformed = await browserPageInspectTool.handler({ tab_ref: '  ' });
    expect(malformed.isError).toBe(true);
    expect(textFromResult(malformed)).toBe('Failed to inspect browser page: tab_ref must be a non-empty string.');

    setBrowserPageInspectRelayEnsureProviderForTest(async () => {});
    setBrowserPageInspectProviderForTest(async () => {
      throw new Error('Browser tab not found for tabRef: missing');
    });

    const missing = await browserPageInspectTool.handler({ tab_ref: 'missing' });
    expect(missing.isError).toBe(true);
    expect(textFromResult(missing)).toBe(
      'Failed to inspect browser page: Browser tab not found for tabRef: missing',
    );
  });

  test('queues browser permission review card on browser policy denial', async () => {
    const prompts: Array<{
      toolName: string;
      tabRef: string;
      attemptedAction: string;
      contextAgentId?: string;
    }> = [];
    setBrowserPageInspectRelayEnsureProviderForTest(async () => {});
    setBrowserPageInspectProviderForTest(async () => {
      throw new Error(
        'Interpreter browser settings blocked this request. Cannot use "https://docs.example.test" because it does not match the allowed page rules (no allowed page rules). Change this in Settings > Browser.',
      );
    });
    setBrowserPermissionReviewPromptProviderForTest(async (input) => {
      prompts.push({
        toolName: input.toolName,
        tabRef: input.tabRef,
        attemptedAction: input.attemptedAction,
        contextAgentId: input.context?.agentId,
      });
      return { approved: false };
    });

    const result = await browserPageInspectTool.handler({
      tab_ref: 'install:work:chrome-tab:91',
      max_elements_per_frame: 12,
    }, {
      agentId: 'agent-1',
    });

    expect(result.isError).toBe(true);
    expect(textFromResult(result)).toContain('Interpreter browser settings blocked this request');
    expect(prompts).toEqual([{
      toolName: 'interpreter_browser_page_inspect',
      tabRef: 'install:work:chrome-tab:91',
      attemptedAction: 'Inspect page elements with max_elements_per_frame=12.',
      contextAgentId: 'agent-1',
    }]);
  });
});
