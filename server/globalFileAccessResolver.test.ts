import { describe, test, expect, beforeEach } from 'bun:test';
import { globalFileAccessResolver } from './globalFileAccessResolver';
import {
  setConfigOverride,
} from './configStore';
import { getGlobalAgentFileAccessPolicySync } from './utils/agentFilePermissions';

beforeEach(() => {
  setConfigOverride({
    agents: {},
    codexSandboxMode: 'workspace-write',
    codexReadAccessMode: 'full-system',
    codexApprovalPolicy: 'never',
    codexMacosTempAccess: true,
    codexMacosScreenshotAccess: true,
    allowModelSkillEditing: true,
  } as any);
  globalFileAccessResolver.clearRequester('agent-1');
  globalFileAccessResolver.clearRequester('agent-2');
});

describe('globalFileAccessResolver', () => {
  test('resolveForRequester returns the current global file-access policy', () => {
    const perms = globalFileAccessResolver.resolveForRequester('nonexistent');
    const expected = getGlobalAgentFileAccessPolicySync();

    expect(perms).toEqual(expected);
  });

  test('clearRequester does not affect the global file-access policy', () => {
    const before = globalFileAccessResolver.resolveForRequester('agent-1');
    globalFileAccessResolver.clearRequester('agent-1');
    const after = globalFileAccessResolver.resolveForRequester('agent-1');

    expect(after).toEqual(before);
  });

  test('hasResolvedPolicy returns true for known agent ids', () => {
    expect(globalFileAccessResolver.hasResolvedPolicy('agent-1')).toBe(true);
  });

  test('hasResolvedPolicy returns true for unknown agent ids', () => {
    expect(globalFileAccessResolver.hasResolvedPolicy('ghost')).toBe(true);
  });

  test('resolveForRequester returns a fresh copy each time', () => {
    const first = globalFileAccessResolver.resolveForRequester('unknown-1');
    first.system = 'none';
    first.customPaths['/secret'] = 'write';

    const second = globalFileAccessResolver.resolveForRequester('unknown-1');
    const expected = getGlobalAgentFileAccessPolicySync();

    expect(second).toEqual(expected);
  });
});
