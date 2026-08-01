import { afterEach, describe, expect, test } from 'bun:test';

import { interpreterServerDefinition } from './index';
import {
  browserTabActivateTool,
  setBrowserRelayEnsureProviderForTest,
  setBrowserTabActivationProviderForTest,
} from './browserTabActivateTool';

function textFromResult(result: Awaited<ReturnType<typeof browserTabActivateTool.handler>>): string {
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return String(first?.text ?? '');
}

describe('browser tab activate tool', () => {
  afterEach(() => {
    setBrowserRelayEnsureProviderForTest(null);
    setBrowserTabActivationProviderForTest(null);
  });

  test('is exposed through the Interpreter builtin server', () => {
    expect(interpreterServerDefinition.tools.map((tool) => tool.name)).toContain('interpreter_browser_tab_activate');
  });

  test('activates a browser tab through the relay-backed provider', async () => {
    const calls: Array<{ tabRef: string }> = [];
    let ensureCalled = false;
    setBrowserRelayEnsureProviderForTest(async () => {
      ensureCalled = true;
    });
    setBrowserTabActivationProviderForTest(async (input) => {
      calls.push(input);
      return { success: true };
    });

    const result = await browserTabActivateTool.handler({
      tab_ref: 'install:profile-1:chrome-tab:201',
    });

    expect(result.isError).toBe(false);
    expect(ensureCalled).toBe(true);
    expect(calls).toEqual([{ tabRef: 'install:profile-1:chrome-tab:201' }]);
    expect(textFromResult(result)).toBe('Activated browser tab install:profile-1:chrome-tab:201');
  });

  test('fails loudly for malformed tab refs and provider failures', async () => {
    const malformed = await browserTabActivateTool.handler({ tab_ref: '  ' });
    expect(malformed.isError).toBe(true);
    expect(textFromResult(malformed)).toBe('Failed to activate browser tab: tab_ref must be a non-empty string.');

    setBrowserRelayEnsureProviderForTest(async () => {});
    setBrowserTabActivationProviderForTest(async () => {
      throw new Error('Browser tab not found for tabRef: missing');
    });

    const missing = await browserTabActivateTool.handler({ tab_ref: 'missing' });
    expect(missing.isError).toBe(true);
    expect(textFromResult(missing)).toBe('Failed to activate browser tab: Browser tab not found for tabRef: missing');
  });
});
