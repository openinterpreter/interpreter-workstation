import { afterEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { agentTabManager } from '../../../agentTabManager';
import { getProfile as getCodexProfile } from '../../../../src/lib/codex/profiles';
import type { AgentModelConfig } from '../../../../shared/types/model';
import type { v2 } from '../../../handlers/codex-generated-types';
import type { CodexSubagentSession } from './codexSubagentRunner';
import {
  closeCodexSubagentSession,
  createCodexSubagentSession,
  runCodexSubagent,
} from './codexSubagentRunner';

const ORIGINAL_INTERPRETER_HOME = process.env.INTERPRETER_HOME;

async function removeTemporaryHome(tempHome: string): Promise<void> {
  const retryableWindowsErrors = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(tempHome, { recursive: true, force: true });
      return;
    } catch (error: any) {
      const shouldRetry = process.platform === 'win32'
        && retryableWindowsErrors.has(error?.code);
      if (!shouldRetry) {
        throw error;
      }
      await delay(100);
    }
  }

  // Windows can retain a transient handle to Bun-created files until process
  // exit. The runner's temporary directory is disposable and cleaned with it.
}

afterEach(() => {
  agentTabManager.clearAll();
  if (ORIGINAL_INTERPRETER_HOME) {
    process.env.INTERPRETER_HOME = ORIGINAL_INTERPRETER_HOME;
  } else {
    delete process.env.INTERPRETER_HOME;
  }
});

describe('runCodexSubagent', () => {
  test('uses the shared runtime shell CLI contract instead of attaching interpreter MCP config', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'codex-subagent-cli-runtime-'));
    process.env.INTERPRETER_HOME = tempHome;

    const runTurnCalls: any[] = [];
    const accountRefreshCalls: boolean[] = [];
    const sandboxPolicy = {
      type: 'workspaceWrite',
      writableRoots: ['/tmp/workspace'],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    } satisfies v2.SandboxPolicy;
    const service = {
      async ensureProvider() {},
      async getAccount(refreshToken: boolean) {
        accountRefreshCalls.push(refreshToken);
        return { account: { type: 'chatgpt' } };
      },
      async runTurn(options: any) {
        runTurnCalls.push(options);
        options.onEvent({ kind: 'thread', threadId: 'thr_subagent' });
        options.onEvent({
          kind: 'turn',
          threadId: 'thr_subagent',
          turnId: 'turn_subagent',
          status: 'inProgress',
        });
        return {
          threadId: 'thr_subagent',
          turnId: 'turn_subagent',
          status: 'completed',
        };
      },
      async readThread() {
        return {
          turns: [
            {
              id: 'turn_subagent',
              items: [
                { type: 'agentMessage', text: 'Patched the document.' },
              ],
            },
          ],
        };
      },
    } as any;

    const modelConfig: AgentModelConfig = {
      provider: 'openai-oauth',
      modelId: 'gpt-5.3-codex',
      profileId: 'profile-main',
    };

    const session: CodexSubagentSession = {
      service,
      profile: getCodexProfile('default'),
      agentId: 'codex-agent-test',
      callerToken: 'agtok_subagent',
      allowedToolNames: ['builtin-docx__add_docx_relationship'],
      modelConfig,
      threadId: undefined,
      dispose: () => {},
    };

    try {
      const result = await runCodexSubagent({
        message: 'Edit the DOCX XML',
        modelConfig,
        workspace: '/tmp/workspace',
        session,
        sandboxPolicy,
        threadConfig: { reasoning_summary: 'none' },
      });

      expect(result.completed).toBe(true);
      expect(result.threadId).toBe('thr_subagent');
      expect(result.agentId).toBe('codex-agent-test');
      expect(accountRefreshCalls).toEqual([true]);
      expect(runTurnCalls).toHaveLength(1);
      expect(runTurnCalls[0].config.reasoning_summary).toBe('none');
      expect(runTurnCalls[0].config.forced_login_method).toBe('chatgpt');
      expect(runTurnCalls[0].config.shell_environment_policy).toBeDefined();
      expect(runTurnCalls[0].config['mcp_servers.interpreter']).toBeUndefined();
      expect(runTurnCalls[0].sandboxPolicy).toEqual(sandboxPolicy);
      expect(runTurnCalls[0].config.shell_environment_policy.set.INTERPRETER_CALLER_TOKEN).toBe('agtok_subagent');
    } finally {
      await removeTemporaryHome(tempHome);
    }
  });

  test('tears down caller-token bindings when a subagent session closes', async () => {
    const modelConfig: AgentModelConfig = {
      provider: 'openai-oauth',
      modelId: 'gpt-5.3-codex',
      profileId: 'profile-main',
    };

    const session = await createCodexSubagentSession({
      modelConfig,
      allowedToolNames: ['builtin-docx__add_docx_relationship'],
    });

    agentTabManager.bindThread({
      agentId: session.agentId,
      threadId: 'thr_subagent',
      callerToken: session.callerToken,
      allowedToolNames: session.allowedToolNames,
      modelConfig: session.modelConfig,
      toolProfileId: session.modelConfig.profileId,
    });

    expect(agentTabManager.getBindingForCallerToken(session.callerToken)).toBeDefined();

    closeCodexSubagentSession(session);

    expect(agentTabManager.getBindingForCallerToken(session.callerToken)).toBeUndefined();
    expect(agentTabManager.getBindingForThread('thr_subagent')).toBeUndefined();
  });
});
