import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { approvalManager } from '../approvalManager';
import { agentTabManager } from '../agentTabManager';
import { clearConfigCache, setConfigOverride } from '../configStore';
import { runWithWorkspaceOverride } from '../utils/workspace';
import {
  registerWindowSession,
  runWithWindowSessionOverride,
  unregisterWindowSession,
} from '../utils/windowSessions';
import { ToolManager } from './toolManager';

async function getAllApprovals() {
  return await runWithWindowSessionOverride(null, async () => {
    return await runWithWorkspaceOverride(null, async () => {
      return approvalManager.getApprovals();
    });
  });
}

async function waitForApproval() {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    const [approval] = await getAllApprovals();
    if (approval) {
      return approval;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Timed out waiting for ask_user_question approval');
}

async function waitForApprovalCount(expectedCount: number) {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    const approvals = await getAllApprovals();
    if (approvals.length === expectedCount) {
      return approvals;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for ${expectedCount} approvals`);
}

const WORKSPACE = process.platform === 'win32'
  ? 'C:\\Users\\test\\project'
  : '/Users/test/project';
const OUTSIDE_WORKSPACE_DOCX_PATH = process.platform === 'win32'
  ? 'C:\\Users\\test\\outside-window-b.docx'
  : '/Users/test/outside-window-b.docx';
const WORKSPACE_OUTPUT_DOCX_PATH = join(WORKSPACE, 'window-b-output.docx');

describe('ToolManager interpreter CLI approval ownership', () => {
  beforeEach(() => {
    approvalManager.setAutoApprove(false);
    approvalManager.clearAll();
    agentTabManager.clearAll();
    setConfigOverride({
      agents: {},
      codexSandboxMode: 'workspace-write',
      codexReadAccessMode: 'workspace-only',
      codexApprovalPolicy: 'on-request',
      codexMacosTempAccess: false,
      codexMacosScreenshotAccess: false,
    } as any);
  });

  afterEach(() => {
    setConfigOverride(null);
    clearConfigCache();
  });

  test('preserves the caller tab as the approval owner for ask_user_question with profile context', async () => {
    const toolManager = new ToolManager();
    agentTabManager.bindThread({
      agentId: 'agent-owner-tab',
      callerToken: 'caller-owner-tab',
      threadId: 'thread-owner-tab',
      windowSessionKey: 'window-owner-tab',
      workspacePath: WORKSPACE,
      allowedToolNames: ['builtin-ask-user__ask_user_question'],
      toolProfileId: 'profile-xyz',
    });

    const callPromise = toolManager.callTool(
      'builtin-ask-user',
      'ask_user_question',
      {
        questions: [
          {
            header: 'Color',
            question: 'Choose a color.',
            options: [
              { label: 'Cerulean', value: 'cerulean' },
              { label: 'Vermilion', value: 'vermilion' },
            ],
          },
        ],
      },
      false,
      'agent-owner-tab',
      {
        profileId: 'profile-xyz',
        modelConfig: {
          provider: 'api',
          modelId: 'gpt-5.4-mini',
          apiFormat: 'openai',
          baseURL: 'https://api.openai.com/v1',
        },
      },
    );

    const approval = await waitForApproval();
    expect(approval.agentId).toBe('agent-owner-tab');
    expect(approval.toolCallId).toBeUndefined();
    expect(approval.owner?.approvalOwnerKind).toBe('normal-agent');
    expect(approval.owner?.displayName).toBe('Interpreter agent (profile-xyz)');
    expect(approval.owner?.identity).toEqual({
      agentId: 'agent-owner-tab',
      threadId: 'thread-owner-tab',
      windowSessionKey: 'window-owner-tab',
      workspacePath: WORKSPACE,
      allowedToolNames: ['builtin-ask-user__ask_user_question'],
      toolProfileId: 'profile-xyz',
    });
    expect(JSON.stringify(approval)).not.toContain('caller-owner-tab');

    const respondResult = await approvalManager.respond(approval.id, {
      answers: { '0': 'cerulean' },
    });
    expect(respondResult).toEqual({ success: true });

    const toolResult = await callPromise as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(toolResult.isError).toBe(false);
    expect(JSON.parse(toolResult.content[0]?.text ?? '{}')).toEqual({
      answers: { '0': 'cerulean' },
    });
  });

  test('keeps concurrent CLI approvals and questions isolated by window session and owner agent', async () => {
    registerWindowSession({
      sessionKey: 'window-a',
      windowId: 101,
      workspacePath: WORKSPACE,
    });
    registerWindowSession({
      sessionKey: 'window-b',
      windowId: 102,
      workspacePath: WORKSPACE,
    });

    try {
      const toolManager = new ToolManager();

      const questionPromise = runWithWindowSessionOverride('window-a', async () => {
        return await runWithWorkspaceOverride(WORKSPACE, async () => {
          return await toolManager.callTool(
            'builtin-ask-user',
            'ask_user_question',
            {
              questions: [
                {
                  header: 'Color',
                  question: 'Choose a window A color.',
                  options: [
                    { label: 'Cerulean', value: 'cerulean' },
                    { label: 'Vermilion', value: 'vermilion' },
                  ],
                },
              ],
            },
            false,
            'agent-window-a',
          );
        });
      });
      void questionPromise.catch(() => {});

      const approvalPromise = runWithWindowSessionOverride('window-b', async () => {
        return await runWithWorkspaceOverride(WORKSPACE, async () => {
          return await toolManager.callTool(
            'builtin-docx',
            'create_docx',
            {
              path: WORKSPACE_OUTPUT_DOCX_PATH,
              content: '<p>Window B</p>',
            },
            false,
            'agent-window-b',
          );
        });
      });
      void approvalPromise.catch(() => {});

      const approvals = await waitForApprovalCount(2);
      const questionApproval = approvals.find((approval) => approval.agentId === 'agent-window-a');
      const simpleApproval = approvals.find((approval) => approval.agentId === 'agent-window-b');

      expect(questionApproval?.isSimpleApproval).toBe(false);
      expect(simpleApproval?.isSimpleApproval).toBe(true);
      expect(questionApproval?.owner?.approvalOwnerKind).toBe('normal-agent');
      expect(questionApproval?.owner?.identity).toMatchObject({
        agentId: 'agent-window-a',
        windowSessionKey: 'window-a',
        workspacePath: WORKSPACE,
      });
      expect(simpleApproval?.owner?.approvalOwnerKind).toBe('normal-agent');
      expect(simpleApproval?.owner?.identity).toMatchObject({
        agentId: 'agent-window-b',
        windowSessionKey: 'window-b',
        workspacePath: WORKSPACE,
      });

      await runWithWindowSessionOverride('window-a', async () => {
        await runWithWorkspaceOverride(WORKSPACE, async () => {
          const visibleApprovals = approvalManager.getApprovals();
          expect(visibleApprovals).toHaveLength(1);
          expect(visibleApprovals[0]?.agentId).toBe('agent-window-a');
          expect(visibleApprovals[0]?.questions[0]?.question).toBe('Choose a window A color.');
        });
      });

      await runWithWindowSessionOverride('window-b', async () => {
        await runWithWorkspaceOverride(WORKSPACE, async () => {
          const visibleApprovals = approvalManager.getApprovals();
          expect(visibleApprovals).toHaveLength(1);
          expect(visibleApprovals[0]?.agentId).toBe('agent-window-b');
          expect(visibleApprovals[0]?.context?.paths).toEqual([WORKSPACE_OUTPUT_DOCX_PATH]);
        });
      });

      const questionRespondResult = questionApproval
        ? approvalManager.respond(questionApproval.id, {
          answers: { '0': 'cerulean' },
        })
        : { success: false, error: 'Question approval missing' };
      expect(questionRespondResult).toEqual({ success: true });

      const simpleRespondResult = simpleApproval
        ? approvalManager.respond(simpleApproval.id, {
          answers: { '0': 'deny' },
        })
        : { success: false, error: 'Simple approval missing' };
      expect(simpleRespondResult).toEqual({ success: true });

      const questionResult = await questionPromise as {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };
      expect(questionResult.isError).toBe(false);
      expect(JSON.parse(questionResult.content[0]?.text ?? '{}')).toEqual({
        answers: { '0': 'cerulean' },
      });

      const approvalResult = await approvalPromise as {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };
      expect(approvalResult.isError).toBe(false);
      expect(approvalResult.content[0]?.text).toBe(`Operation denied by user: write: ${WORKSPACE_OUTPUT_DOCX_PATH}`);
    } finally {
      unregisterWindowSession(101);
      unregisterWindowSession(102);
    }
  });
});
