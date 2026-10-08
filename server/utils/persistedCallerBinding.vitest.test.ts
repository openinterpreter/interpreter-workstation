import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistNativeCallerBinding, recoverNativeCallerBinding, revokeNativeCallerBinding } from './persistedCallerBinding';
import { agentTabManager } from '../agentTabManager';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'native-caller-')); roots.push(dir); return dir; };

describe.skipIf(process.platform !== 'linux')('native caller scope continuity', () => {
  const token = 'agtok_123456789abcdef';
  const binding = {
    agentId: 'agent-123', callerToken: token, threadId: 'thr-123', workspacePath: '/workspace/example',
    allowedToolNames: ['builtin-interpreter__interpreter_whole_computer_state_get'],
    modelConfig: { provider: 'openai-oauth' as const, modelId: 'gpt-6-sol', apiKey: 'MUST_NOT_PERSIST' },
  };

  it('recovers only the exact bearer and scoped thread after an in-memory loss without storing token or credential', () => {
    const dir = root();
    chmodSync(dir, 0o755); // Application data roots may be traversable.
    persistNativeCallerBinding(binding, dir);
    const stored = readFileSync(path.join(dir, 'native-caller-bindings', readdirSync(path.join(dir, 'native-caller-bindings'))[0]), 'utf8');
    expect(stored).not.toContain(token);
    expect(stored).not.toContain('MUST_NOT_PERSIST');
    expect(recoverNativeCallerBinding(token, dir)).toMatchObject({
      agentId: 'agent-123', threadId: 'thr-123', workspacePath: '/workspace/example',
      allowedToolNames: binding.allowedToolNames,
    });
    expect(recoverNativeCallerBinding('agtok_123456789abcdee', dir)).toBeUndefined();
    expect(recoverNativeCallerBinding(token, root())).toBeUndefined();
    revokeNativeCallerBinding(token, dir);
    expect(recoverNativeCallerBinding(token, dir)).toBeUndefined();
  });

  it('fails closed for delegated/window callers, broad file permissions and symlinks', () => {
    const dir = root();
    persistNativeCallerBinding({ ...binding, windowSessionKey: 'another-window' }, dir);
    expect(recoverNativeCallerBinding(token, dir)).toBeUndefined();
    persistNativeCallerBinding(binding, dir);
    const file = path.join(dir, 'native-caller-bindings', readdirSync(path.join(dir, 'native-caller-bindings'))[0]);
    chmodSync(file, 0o644);
    expect(recoverNativeCallerBinding(token, dir)).toBeUndefined();
    chmodSync(file, 0o600);
    const target = path.join(dir, 'untrusted');
    symlinkSync(file, target);
    rmSync(file);
    symlinkSync(target, file);
    expect(recoverNativeCallerBinding(token, dir)).toBeUndefined();
  });

  it('keeps a same-thread caller scoped after the manager loses its in-memory maps', () => {
    const dir = root();
    const prior = process.env.INTERPRETER_USER_DATA_DIR;
    process.env.INTERPRETER_USER_DATA_DIR = dir;
    try {
      agentTabManager.bindThread(binding);
      agentTabManager.clearAll();
      expect(agentTabManager.getBindingForThread(binding.threadId)).toBeUndefined();
      expect(agentTabManager.getBindingForCallerToken(token)).toMatchObject({
        threadId: binding.threadId, workspacePath: binding.workspacePath,
        allowedToolNames: binding.allowedToolNames,
      });
      expect(agentTabManager.getBindingForCallerToken('agtok_wrong123456789')).toBeUndefined();
      agentTabManager.bindThread({ ...binding, callerToken: 'agtok_replacement123456789' });
      expect(agentTabManager.getBindingForCallerToken(token)?.threadId).toBe(binding.threadId);
      // A still-loaded native turn may have the old shell caller until OIX
      // accepts a cold resume; neither scope is widened during that interval.
    } finally {
      revokeNativeCallerBinding(token, dir);
      revokeNativeCallerBinding('agtok_replacement123456789', dir);
      agentTabManager.clearAll();
      if (prior === undefined) delete process.env.INTERPRETER_USER_DATA_DIR;
      else process.env.INTERPRETER_USER_DATA_DIR = prior;
    }
  });
});
