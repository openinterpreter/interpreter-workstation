import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CUA_ACCESS_POLICY,
  getCuaAccessAppPolicy,
  normalizeCuaAccessPolicy,
  resolveCuaAccessPolicyMode,
} from './cuaAccessPolicy';

describe('cuaAccessPolicy', () => {
  test('defaults native Computer Use access to ask', () => {
    expect(normalizeCuaAccessPolicy(undefined)).toEqual(DEFAULT_CUA_ACCESS_POLICY);
    expect(resolveCuaAccessPolicyMode(undefined, 'TextEdit', 'inspect')).toBe('ask');
    expect(resolveCuaAccessPolicyMode(undefined, 'TextEdit', 'control')).toBe('ask');
  });

  test('normalizes global and per-app modes without guessing unknown values', () => {
    const policy = normalizeCuaAccessPolicy({
      permissions: {
        inspect: { mode: 'deny' },
        control: { mode: 'ask' },
      },
      appPolicies: [
        {
          appId: ' TextEdit ',
          displayName: '',
          permissions: {
            inspect: { mode: 'all' },
            control: { mode: 'deny' },
          },
        },
        {
          appId: 'Finder',
          displayName: 'Finder',
          permissions: {
            inspect: { mode: 'ask' },
            control: { mode: 'all' },
          },
        },
      ],
    });

    expect(policy).toEqual({
      permissions: {
        inspect: { mode: 'deny' },
        control: { mode: 'ask' },
      },
      appPolicies: [
        {
          appId: 'TextEdit',
          displayName: 'TextEdit',
          permissions: {
            inspect: { mode: 'all' },
            control: { mode: 'deny' },
          },
        },
        {
          appId: 'Finder',
          displayName: 'Finder',
          permissions: {
            inspect: { mode: 'ask' },
            control: { mode: 'all' },
          },
        },
      ],
    });
    expect(resolveCuaAccessPolicyMode(policy, 'TextEdit', 'inspect')).toBe('all');
    expect(resolveCuaAccessPolicyMode(policy, 'TextEdit', 'control')).toBe('deny');
    expect(resolveCuaAccessPolicyMode(policy, 'Finder', 'control')).toBe('all');
    expect(resolveCuaAccessPolicyMode(policy, 'Slack', 'inspect')).toBe('deny');
    expect(getCuaAccessAppPolicy(policy, 'Unknown')).toBeNull();
  });

  test('rejects malformed policies', () => {
    expect(() => normalizeCuaAccessPolicy({
      permissions: {
        inspect: { mode: 'later' as 'ask' },
        control: { mode: 'ask' },
      },
      appPolicies: [],
    })).toThrow('Computer Use permission mode must be ask, deny, or all.');

    expect(() => normalizeCuaAccessPolicy({
      permissions: {
        inspect: { mode: 'ask' },
        control: { mode: 'ask' },
      },
      appPolicies: [{
        appId: ' ',
        displayName: '',
        permissions: {
          inspect: { mode: 'ask' },
          control: { mode: 'ask' },
        },
      }],
    })).toThrow('Computer Use app rules require an app name.');
  });
});

