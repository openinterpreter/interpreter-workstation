import { describe, expect, test } from 'bun:test';
import {
  doesBrowserAccessPolicyAllowUrl,
  doesBrowserPatternMatchUrl,
  normalizeBrowserAccessPattern,
  normalizeBrowserAccessPolicy,
} from './browserAccessPolicy';

describe('browserAccessPolicy', () => {
  test('normalizes host-only rules to wildcard paths', () => {
    expect(normalizeBrowserAccessPattern('Example.com')).toBe('example.com/*');
    expect(normalizeBrowserAccessPattern('https://docs.example.com/guides/')).toBe(
      'docs.example.com/guides/*',
    );
  });

  test('matches wildcard hosts and paths', () => {
    expect(doesBrowserPatternMatchUrl('*.example.com/*', 'https://app.example.com/settings')).toBe(
      true,
    );
    expect(doesBrowserPatternMatchUrl('example.com/docs/*', 'https://example.com/docs')).toBe(true);
    expect(doesBrowserPatternMatchUrl('example.com/docs/*', 'https://example.com/docs/api')).toBe(
      true,
    );
    expect(doesBrowserPatternMatchUrl('example.com/docs/*', 'https://example.com/blog')).toBe(
      false,
    );
  });

  test('supports exact ports for local development pages', () => {
    expect(
      doesBrowserPatternMatchUrl('localhost:3000/*', 'http://localhost:3000/settings/profile'),
    ).toBe(true);
    expect(
      doesBrowserPatternMatchUrl('localhost:3000/*', 'http://localhost:5173/settings/profile'),
    ).toBe(false);
  });

  test('applies allow-list policies and defaults to ask when unset', () => {
    const policy = normalizeBrowserAccessPolicy({
      permissions: {
        read: {
          mode: 'allowList',
          allowedPatterns: ['example.com/*', 'example.com/*', 'localhost:3000/*'],
        },
        write: { mode: 'ask', allowedPatterns: [] },
        action: { mode: 'deny', allowedPatterns: ['example.com/*'] },
      },
      profilePolicies: [],
    });

    expect(policy).toEqual({
      permissions: {
        read: {
          mode: 'allowList',
          allowedPatterns: ['example.com/*', 'localhost:3000/*'],
        },
        write: { mode: 'ask', allowedPatterns: [] },
        action: { mode: 'deny', allowedPatterns: ['example.com/*'] },
      },
      profilePolicies: [],
    });
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://example.com/account')).toBe(true);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://blocked.example.net')).toBe(false);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://example.com/account', null, 'write')).toBe(false);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://example.com/account', null, 'action')).toBe(false);
    expect(doesBrowserAccessPolicyAllowUrl(undefined, 'https://example.com')).toBe(false);
    expect(normalizeBrowserAccessPolicy(undefined)).toEqual({
      permissions: {
        read: { mode: 'ask', allowedPatterns: [] },
        write: { mode: 'ask', allowedPatterns: [] },
        action: { mode: 'ask', allowedPatterns: [] },
      },
      profilePolicies: [],
    });
    expect(doesBrowserAccessPolicyAllowUrl({
      permissions: {
        read: { mode: 'deny', allowedPatterns: ['example.com/*'] },
        write: { mode: 'ask', allowedPatterns: [] },
        action: { mode: 'ask', allowedPatterns: [] },
      },
      profilePolicies: [],
    }, 'https://example.com')).toBe(false);
  });

  test('applies profile-specific policies by profile identity', () => {
    const policy = normalizeBrowserAccessPolicy({
      permissions: {
        read: { mode: 'deny', allowedPatterns: ['blocked.example/*'] },
        write: { mode: 'deny', allowedPatterns: [] },
        action: { mode: 'deny', allowedPatterns: [] },
      },
      profilePolicies: [
        {
          profileId: 'install:work',
          permissions: {
            read: { mode: 'allowList', allowedPatterns: ['work.example/*', 'work.example/*'] },
            write: { mode: 'allowList', allowedPatterns: ['write.example/*'] },
            action: { mode: 'deny', allowedPatterns: [] },
          },
        },
        {
          profileId: 'chrome-profile-personal',
          permissions: {
            read: { mode: 'all', allowedPatterns: [] },
            write: { mode: 'deny', allowedPatterns: [] },
            action: { mode: 'all', allowedPatterns: [] },
          },
        },
      ],
    });

    expect(policy.profilePolicies).toEqual([
      {
        profileId: 'install:work',
        permissions: {
          read: { mode: 'allowList', allowedPatterns: ['work.example/*'] },
          write: { mode: 'allowList', allowedPatterns: ['write.example/*'] },
          action: { mode: 'deny', allowedPatterns: [] },
        },
      },
      {
        profileId: 'chrome-profile-personal',
        permissions: {
          read: { mode: 'all', allowedPatterns: [] },
          write: { mode: 'deny', allowedPatterns: [] },
          action: { mode: 'all', allowedPatterns: [] },
        },
      },
    ]);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://work.example/docs', 'install:work')).toBe(true);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example/docs', 'install:work')).toBe(false);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://write.example/docs', 'install:work', 'write')).toBe(true);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://work.example/docs', 'install:work', 'action')).toBe(false);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example/docs', 'chrome-profile-personal')).toBe(true);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example/docs', 'chrome-profile-personal', 'action')).toBe(true);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://other.example/docs', 'chrome-profile-personal', 'write')).toBe(false);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://work.example/docs', 'local:work')).toBe(false);
    expect(doesBrowserAccessPolicyAllowUrl(policy, 'https://work.example/docs', 'unknown-profile')).toBe(false);
  });

  test('rejects unsupported schemes and malformed rules', () => {
    expect(() => normalizeBrowserAccessPattern('chrome://settings')).toThrow(
      'Only http and https page rules are supported.',
    );
    expect(() => normalizeBrowserAccessPattern('bad host/*')).toThrow(
      'Rules cannot contain spaces.',
    );
  });
});
