import { afterEach, describe, expect, test } from 'bun:test';

import {
  addBrowserAccessSessionGrant,
  clearBrowserAccessGrantsForTest,
  getBrowserAccessPolicyWithGrants,
  withTemporaryBrowserAccessGrant,
} from './browserAccessGrants';
import { doesBrowserAccessPolicyAllowUrl, type BrowserAccessPolicy } from '../../shared/browserAccessPolicy';

function askPolicy(): BrowserAccessPolicy {
  return {
    permissions: {
      read: { mode: 'ask', allowedPatterns: [] },
      write: { mode: 'ask', allowedPatterns: [] },
      action: { mode: 'ask', allowedPatterns: [] },
    },
    profilePolicies: [],
  };
}

describe('browserAccessGrants', () => {
  afterEach(() => {
    clearBrowserAccessGrantsForTest();
  });

  test('adds session grants only to the approved profile, origin, and permission kind', () => {
    addBrowserAccessSessionGrant({
      profileId: 'install:work',
      origin: 'https://docs.example.test',
      permissionKind: 'read',
    });

    const policy = getBrowserAccessPolicyWithGrants(askPolicy());

    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://docs.example.test/page', 'install:work', 'read')).toBe(true);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://docs.example.test/page', 'install:work', 'write')).toBe(false);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://docs.example.test/page', 'install:personal', 'read')).toBe(false);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example.test/page', 'install:work', 'read')).toBe(false);
  });

  test('does not override deny or unmatched allowList rules', () => {
    addBrowserAccessSessionGrant({
      profileId: 'install:work',
      origin: 'https://docs.example.test',
      permissionKind: 'action',
    });

    const policy = getBrowserAccessPolicyWithGrants({
      permissions: {
        read: { mode: 'ask', allowedPatterns: [] },
        write: { mode: 'ask', allowedPatterns: [] },
        action: { mode: 'deny', allowedPatterns: [] },
      },
      profilePolicies: [],
    });

    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://docs.example.test/page', 'install:work', 'action')).toBe(false);
  });

  test('temporary grants are removed after the callback finishes', async () => {
    const basePolicy = askPolicy();
    const duringCallback = await withTemporaryBrowserAccessGrant({
      profileId: 'install:work',
      origin: 'http://127.0.0.1:4321',
      permissionKind: 'write',
    }, async () => {
      const policy = getBrowserAccessPolicyWithGrants(basePolicy);
      return doesBrowserAccessPolicyAllowUrl(policy, 'http://127.0.0.1:4321/form', 'install:work', 'write');
    });

    const afterCallback = doesBrowserAccessPolicyAllowUrl(
      getBrowserAccessPolicyWithGrants(basePolicy),
      'http://127.0.0.1:4321/form',
      'install:work',
      'write',
    );

    expect(duringCallback).toBe(true);
    expect(afterCallback).toBe(false);
  });
});
