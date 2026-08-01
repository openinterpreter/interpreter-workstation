import { afterEach, beforeEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Question } from '../../shared/types/approval';
import { SERVER_REQUEST_METHOD, type ServerRequest } from '../../src/lib/codex/protocol';
import { agentTabManager } from '../agentTabManager';
import { clearConfigCache, setConfigOverride } from '../configStore';
import {
  attachCodexServerRequestApprovals,
  handleCodexServerRequest,
  type CodexServerRequestApprovalDeps,
} from './codexServerRequestApprovals';

function createDeps(approved = true): {
  deps: CodexServerRequestApprovalDeps;
  approvalCalls: Array<{
    toolName: string;
    serverId: string;
    args: unknown;
    timeout: number;
    toolCallId?: string;
    agentId?: string;
  }>;
  sessionApprovalCalls: Array<{
    toolName: string;
    serverId: string;
    args: unknown;
    warningMessage: string;
    timeout: number;
    toolCallId?: string;
    agentId?: string;
  }>;
  questionCalls: Array<{
    toolName: string;
    serverId: string;
    questions: Question[];
    context: unknown;
    timeout: number;
    toolCallId?: string;
    agentId?: string;
  }>;
  errors: unknown[];
} {
  const approvalCalls: Array<{
    toolName: string;
    serverId: string;
    args: unknown;
    timeout: number;
    toolCallId?: string;
    agentId?: string;
  }> = [];
  const sessionApprovalCalls: Array<{
    toolName: string;
    serverId: string;
    args: unknown;
    warningMessage: string;
    timeout: number;
    toolCallId?: string;
    agentId?: string;
  }> = [];
  const questionCalls: Array<{
    toolName: string;
    serverId: string;
    questions: Question[];
    context: unknown;
    timeout: number;
    toolCallId?: string;
    agentId?: string;
  }> = [];
  const errors: unknown[] = [];

  const deps: CodexServerRequestApprovalDeps = {
    createApproval: async (toolName, serverId, args, timeout, toolCallId, agentId) => {
      approvalCalls.push({ toolName, serverId, args, timeout, toolCallId, agentId });
      return approved;
    },
    createSessionAwareApproval: async (toolName, serverId, args, warningMessage, timeout, toolCallId, agentId) => {
      sessionApprovalCalls.push({ toolName, serverId, args, warningMessage, timeout, toolCallId, agentId });
      return { approved, mode: 'once' };
    },
    createQuestion: async (toolName, serverId, questions, context, timeout, toolCallId, agentId) => {
      questionCalls.push({ toolName, serverId, questions, context, timeout, toolCallId, agentId });
      return {
        answers: {
          '0': questions[0]?.default ?? questions[0]?.options[0]?.value ?? 'decision:0',
        },
      };
    },
    onError: (error) => {
      errors.push(error);
    },
  };

  return { deps, approvalCalls, sessionApprovalCalls, questionCalls, errors };
}

describe('codexServerRequestApprovals', () => {
  let tempRoot = '';
  let workspacePath = '';
  let outsidePath = '';

  beforeEach(async () => {
    agentTabManager.clearAll();
    tempRoot = await mkdtemp(path.join(tmpdir(), 'codex-shell-approvals-test-'));
    workspacePath = path.join(tempRoot, 'workspace');
    outsidePath = path.join(tempRoot, 'outside');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(outsidePath, { recursive: true });
    setConfigOverride({
      agents: {},
      codexSandboxMode: 'workspace-write',
      codexReadAccessMode: 'workspace-only',
      codexApprovalPolicy: 'untrusted',
      codexMacosTempAccess: false,
      codexMacosScreenshotAccess: false,
    } as any);
  });

  afterEach(async () => {
    setConfigOverride(null);
    clearConfigCache();
    agentTabManager.clearAll();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('handles view_image command approval via approval manager', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-view-image-1',
      threadId: 'thr_1',
      callerToken: 'agtok_view_image',
    });
    const { deps, approvalCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 7,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        approvalId: 'approval_1',
        reason: 'view_image: /tmp/image.png',
        command: 'view_image /tmp/image.png',
        cwd: '/tmp',
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 1);
    assert.deepEqual(approvalCalls[0], {
      toolName: 'view_image',
      serverId: 'main-agent-server',
      args: {
        path: '/tmp/image.png',
        reason: 'view_image: /tmp/image.png',
        threadId: 'thr_1',
        warning: 'Interpreter wants to view an image file.',
        description: 'Interpreter needs permission to view this image.',
        command: 'view_image /tmp/image.png',
        cwd: '/tmp',
        itemId: 'item_1',
      },
      timeout: 0,
      toolCallId: 'item_1',
      agentId: 'agent-view-image-1',
    });
    assert.deepEqual(response, { decision: 'accept' });
  });

  test('returns declined response when approval is rejected', async () => {
    const { deps } = createDeps(false);
    let response: unknown;

    const request: ServerRequest = {
      id: 8,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_2',
        reason: 'view_image: /tmp/image.png',
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.deepEqual(response, { decision: 'decline' });
  });

  test('routes file change approvals through question flow', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-patch-v2',
      threadId: 'thr_1',
      callerToken: 'agtok_patch_v2',
    });
    const { deps, approvalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 801,
      method: SERVER_REQUEST_METHOD.fileChangeApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_file_1',
        reason: 'Needs write access to apply patch',
        grantRoot: '/tmp',
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 1);
    assert.deepEqual(questionCalls[0], {
      toolName: 'Apply patch',
      serverId: 'codex',
      questions: [{
        question: 'How should Interpreter handle these file changes?',
        options: [
          {
            label: 'Allow once',
            value: 'decision:0',
            description: 'Make these changes this time.',
            recommended: true,
          },
          {
            label: 'Allow this folder for this session',
            value: 'decision:1',
            description: 'Approve these changes and stop asking again for this folder during this session.',
          },
          {
            label: "Don't allow",
            value: 'decision:2',
            description: 'Skip these changes and let Interpreter continue.',
          },
          {
            label: 'Stop here',
            value: 'decision:3',
            description: 'Skip these changes and stop this run.',
          },
        ],
        allowOther: false,
        default: 'decision:0',
      }],
      context: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_file_1',
        message: 'Interpreter wants to make changes to files.',
        description: 'Review these file changes before continuing.',
        reason: 'Needs write access to apply patch',
        grantRoot: '/tmp',
      },
      timeout: 0,
      toolCallId: 'item_file_1',
      agentId: 'agent-patch-v2',
    });
    assert.deepEqual(response, { decision: 'accept' });
  });

  test('declines file change approvals when the user chooses not to allow them', async () => {
    const { deps, questionCalls } = createDeps(true);
    deps.createQuestion = async (toolName, serverId, questions, context, timeout, toolCallId, agentId) => {
      questionCalls.push({ toolName, serverId, questions, context, timeout, toolCallId, agentId });
      return { answers: { '0': 'decision:2' } };
    };
    let response: unknown;

    const request: ServerRequest = {
      id: 802,
      method: SERVER_REQUEST_METHOD.fileChangeApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_file_2',
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(questionCalls.length, 1);
    assert.deepEqual(response, { decision: 'decline' });
  });

  test('routes legacy applyPatchApproval requests through question flow', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-patch-legacy',
      threadId: 'thr_legacy',
      callerToken: 'agtok_patch_legacy',
    });
    const { deps, approvalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 803,
      method: SERVER_REQUEST_METHOD.applyPatchApproval,
      params: {
        conversationId: 'thr_legacy',
        callId: 'call_legacy_patch',
        fileChanges: {},
        reason: null,
        grantRoot: null,
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 1);
    assert.deepEqual(questionCalls[0], {
      toolName: 'Apply patch',
      serverId: 'codex',
      questions: [{
        question: 'How should Interpreter handle these file changes?',
        options: [
          {
            label: 'Allow once',
            value: 'decision:0',
            description: 'Make these changes this time.',
            recommended: true,
          },
          {
            label: 'Allow these files for this session',
            value: 'decision:1',
            description: 'Approve these changes and stop asking again for these files during this session.',
          },
          {
            label: "Don't allow",
            value: 'decision:2',
            description: 'Skip these changes and let Interpreter continue.',
          },
          {
            label: 'Stop here',
            value: 'decision:3',
            description: 'Skip these changes and stop this run.',
          },
        ],
        allowOther: false,
        default: 'decision:0',
      }],
      context: {
        threadId: 'thr_legacy',
        itemId: 'call_legacy_patch',
        message: 'Interpreter wants to make changes to files.',
        description: 'Review these file changes before continuing.',
        reason: null,
        grantRoot: null,
        fileChanges: {},
      },
      timeout: 0,
      toolCallId: 'call_legacy_patch',
      agentId: 'agent-patch-legacy',
    });
    assert.deepEqual(response, { decision: 'approved' });
  });

  test('auto-accepts safe interpreter-app discovery commands', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-shell-1',
      threadId: 'thr_1',
      callerToken: 'agtok_shell',
      workspacePath,
    });
    const { deps, approvalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 9,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_3',
        reason: 'shell: interpreter-app tools list',
        command: "/bin/zsh -lc 'interpreter-app tools list'",
        cwd: workspacePath,
        commandActions: [],
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 0);
    assert.deepEqual(response, { decision: 'accept' });
  });

  test('declines shell js_repl invocations so the agent must call the native tool directly', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-shell-rich',
      threadId: 'thr_rich',
      callerToken: 'agtok_shell_rich',
      workspacePath,
    });
    const { deps, approvalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 10,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_rich',
        turnId: 'turn_rich',
        itemId: 'item_rich',
        reason: null,
        command: '/bin/zsh -c js_repl',
        cwd: workspacePath,
        commandActions: [],
        proposedExecpolicyAmendment: ['js_repl'],
        availableDecisions: [
          'accept',
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['js_repl'] } },
          'cancel',
        ],
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 0);
    assert.deepEqual(response, { decision: 'decline' });
  });

  test('routes legacy exec command approvals through approval manager', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-shell-legacy',
      threadId: 'thr_legacy',
      callerToken: 'agtok_legacy',
    });
    const { deps, approvalCalls } = createDeps(false);
    let response: unknown;

    const request: ServerRequest = {
      id: 11,
      method: SERVER_REQUEST_METHOD.execCommandApproval,
      params: {
        conversationId: 'thr_legacy',
        callId: 'call_legacy',
        approvalId: 'approval_legacy',
        command: ['/bin/zsh', '-lc', 'ls -la'],
        cwd: '/workspace',
        reason: 'legacy shell approval',
        parsedCmd: [],
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 1);
    assert.deepEqual(approvalCalls[0], {
      toolName: 'Shell command',
      serverId: 'codex',
      args: {
        threadId: 'thr_legacy',
        itemId: 'call_legacy',
        approvalId: 'approval_legacy',
        message: 'Interpreter wants to run a command.',
        description: 'legacy shell approval',
        command: ['/bin/zsh', '-lc', 'ls -la'],
        cwd: '/workspace',
        reason: 'legacy shell approval',
        commandActions: [],
      },
      timeout: 0,
      toolCallId: 'call_legacy',
      agentId: 'agent-shell-legacy',
    });
    assert.deepEqual(response, { decision: 'denied' });
  });

  test('routes message-only MCP tool approvals through session-aware permission flow', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-mcp-tool',
      threadId: 'thr_mcp_tool',
      callerToken: 'agtok_mcp_tool',
    });

    const { deps, approvalCalls, sessionApprovalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 1201,
      method: SERVER_REQUEST_METHOD.mcpServerElicitationRequest,
      params: {
        threadId: 'thr_mcp_tool',
        turnId: 'turn_mcp_tool',
        serverName: 'interpreter',
        mode: 'form',
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          persist: ['session', 'always'],
          tool_params: {
            path: '/tmp/report.pdf',
          },
        },
        message: 'Allow builtin-pdf__read_pdf?',
        requestedSchema: {
          type: 'object',
          properties: {},
        },
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 0);
    assert.equal(sessionApprovalCalls.length, 1);
    assert.deepEqual(sessionApprovalCalls[0], {
      toolName: 'interpreter__MCP tool',
      serverId: 'interpreter',
      args: {
        message: 'Interpreter wants to use an MCP tool.',
        description: 'Review this MCP tool call before continuing.',
        serverId: 'interpreter',
        toolName: 'MCP tool',
        args: {
          path: '/tmp/report.pdf',
        },
        threadId: 'thr_mcp_tool',
      },
      warningMessage: 'Interpreter wants to call interpreter__MCP tool.',
      timeout: 0,
      toolCallId: undefined,
      agentId: 'agent-mcp-tool',
    });
    assert.deepEqual(response, { action: 'accept', content: null, _meta: null });
  });

  test('maps boolean MCP form answers back into structured content', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-mcp-form',
      threadId: 'thr_mcp_form',
      callerToken: 'agtok_mcp_form',
    });

    const { deps, approvalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 1202,
      method: SERVER_REQUEST_METHOD.mcpServerElicitationRequest,
      params: {
        threadId: 'thr_mcp_form',
        turnId: 'turn_mcp_form',
        serverName: 'interpreter',
        mode: 'form',
        _meta: null,
        message: 'Confirm the import settings.',
        requestedSchema: {
          type: 'object',
          properties: {
            confirmed: {
              type: 'boolean',
              title: 'Confirm',
              description: 'Approve the pending action.',
            },
          },
          required: ['confirmed'],
        },
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 1);
    assert.deepEqual(questionCalls[0]?.questions, [{
      header: 'Confirm',
      question: 'Approve the pending action.',
      options: [
        {
          label: 'True',
          value: 'true',
        },
        {
          label: 'False',
          value: 'false',
        },
      ],
      allowOther: false,
      default: undefined,
      optional: false,
    }]);
    assert.deepEqual(response, {
      action: 'accept',
      content: {
        confirmed: true,
      },
      _meta: null,
    });
  });

  test('maps numeric MCP form answers from question input back into structured content', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-mcp-number',
      threadId: 'thr_mcp_number',
      callerToken: 'agtok_mcp_number',
    });

    const { deps, approvalCalls, questionCalls } = createDeps(true);
    deps.createQuestion = async (toolName, serverId, questions, context, timeout, toolCallId, agentId) => {
      questionCalls.push({ toolName, serverId, questions, context, timeout, toolCallId, agentId });
      return {
        answers: {
          '0': 'other:42',
        },
      };
    };
    let response: unknown;

    const request: ServerRequest = {
      id: 1203,
      method: SERVER_REQUEST_METHOD.mcpServerElicitationRequest,
      params: {
        threadId: 'thr_mcp_number',
        turnId: 'turn_mcp_number',
        serverName: 'interpreter',
        mode: 'form',
        _meta: null,
        message: 'Provide the row count.',
        requestedSchema: {
          type: 'object',
          properties: {
            count: {
              type: 'integer',
              title: 'Count',
              description: 'Enter the row count.',
            },
          },
          required: ['count'],
        },
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 1);
    assert.deepEqual(questionCalls[0]?.questions, [{
      header: 'Count',
      question: 'Enter the row count.',
      options: [],
      allowOther: true,
      optional: false,
    }]);
    assert.deepEqual(response, {
      action: 'accept',
      content: {
        count: 42,
      },
      _meta: null,
    });
  });

  test('suppresses cleanup cancellation error logging', async () => {
    const { deps, errors } = createDeps(true);
    let respondCallCount = 0;

    const request: ServerRequest = {
      id: 12,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_4',
        reason: 'view_image: /tmp/image.png',
      },
    };

    deps.createApproval = async () => {
      throw new Error('Request cleared during cleanup');
    };

    await handleCodexServerRequest(request, () => {
      respondCallCount += 1;
    }, deps);

    assert.equal(respondCallCount, 0);
    assert.equal(errors.length, 0);
  });

  test('logs non-cleanup errors', async () => {
    const { deps, errors } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 13,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_5',
        reason: 'view_image: /tmp/image.png',
      },
    };

    deps.createApproval = async () => {
      throw new Error('Unexpected failure');
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.deepEqual(response, { decision: 'decline' });
    assert.equal(errors.length, 1);
  });

  test('swallows disconnect when fallback deny response cannot be delivered', async () => {
    const { deps, errors } = createDeps(true);
    let respondCallCount = 0;

    const request: ServerRequest = {
      id: 12,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_6',
        reason: 'view_image: /tmp/image.png',
      },
    };

    deps.createApproval = async () => {
      throw new Error('Unexpected failure');
    };

    await handleCodexServerRequest(request, () => {
      respondCallCount += 1;
      throw new Error('codex app-server stdio is not writable');
    }, deps);

    assert.equal(respondCallCount, 1);
    assert.equal(errors.length, 1);
    assert.match((errors[0] as Error).message, /Unexpected failure/);
  });

  test('auto-accepts read-only shell commands inside the bound workspace', async () => {
    const secretPath = path.join(workspacePath, 'secret.txt');
    await writeFile(secretPath, 'workspace-secret', 'utf8');

    agentTabManager.bindThread({
      agentId: 'agent-shell-read',
      threadId: 'thr_shell_read',
      callerToken: 'agtok_shell_read',
      workspacePath,
    });

    const { deps, approvalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 2001,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_shell_read',
        turnId: 'turn_shell_read',
        itemId: 'item_shell_read',
        command: `cat ${secretPath}`,
        cwd: workspacePath,
        commandActions: [],
        additionalPermissions: {
          fileSystem: {
            read: [secretPath],
            write: [],
          },
          network: null,
        },
        availableDecisions: ['accept', 'decline'],
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 0);
    assert.deepEqual(response, { decision: 'accept' });
  });

  test('declines shell reads of installed runtime skill files', async () => {
    const userDataDir = path.join(tempRoot, 'user-data');
    const runtimeSkillDir = path.join(userDataDir, 'codex-home', 'skills', 'slides');
    const runtimeSkillPath = path.join(runtimeSkillDir, 'SKILL.md');
    await mkdir(runtimeSkillDir, { recursive: true });
    await writeFile(runtimeSkillPath, '# runtime skill', 'utf8');

    const originalUserDataDir = process.env.INTERPRETER_USER_DATA_DIR;
    process.env.INTERPRETER_USER_DATA_DIR = userDataDir;
    setConfigOverride({
      agents: {},
      codexSandboxMode: 'workspace-write',
      codexReadAccessMode: 'full-system',
      codexApprovalPolicy: 'never',
      codexMacosTempAccess: false,
      codexMacosScreenshotAccess: false,
    } as any);

    agentTabManager.bindThread({
      agentId: 'agent-shell-skill-read',
      threadId: 'thr_shell_skill_read',
      callerToken: 'agtok_shell_skill_read',
      workspacePath,
    });

    const { deps, approvalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    try {
      const request: ServerRequest = {
        id: 2004,
        method: SERVER_REQUEST_METHOD.commandExecutionApproval,
        params: {
          threadId: 'thr_shell_skill_read',
          turnId: 'turn_shell_skill_read',
          itemId: 'item_shell_skill_read',
          command: `/bin/zsh -lc "sed -n '1,40p' '${runtimeSkillPath}'"`,
          cwd: workspacePath,
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: ['accept', 'decline'],
        },
      };

      await handleCodexServerRequest(request, (result) => {
        response = result;
      }, deps);
    } finally {
      if (originalUserDataDir === undefined) {
        delete process.env.INTERPRETER_USER_DATA_DIR;
      } else {
        process.env.INTERPRETER_USER_DATA_DIR = originalUserDataDir;
      }
    }

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 0);
    assert.deepEqual(response, { decision: 'decline' });
  });

  test('prompts for workspace writes when ask-first is enabled', async () => {
    const outputPath = path.join(workspacePath, 'out.txt');

    agentTabManager.bindThread({
      agentId: 'agent-shell-write',
      threadId: 'thr_shell_write',
      callerToken: 'agtok_shell_write',
      workspacePath,
    });

    const { deps, approvalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 2002,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_shell_write',
        turnId: 'turn_shell_write',
        itemId: 'item_shell_write',
        command: `printf ok > ${outputPath}`,
        cwd: workspacePath,
        commandActions: [],
        additionalPermissions: {
          fileSystem: {
            read: [],
            write: [outputPath],
          },
          network: null,
        },
        availableDecisions: ['accept', 'decline'],
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 1);
    assert.deepEqual(response, { decision: 'accept' });
  });

  test('declines writes outside the bound workspace without prompting', async () => {
    const outputPath = path.join(outsidePath, 'blocked.txt');

    agentTabManager.bindThread({
      agentId: 'agent-shell-outside-write',
      threadId: 'thr_shell_outside_write',
      callerToken: 'agtok_shell_outside_write',
      workspacePath,
    });

    const { deps, approvalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 2003,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_shell_outside_write',
        turnId: 'turn_shell_outside_write',
        itemId: 'item_shell_outside_write',
        command: `printf blocked > ${outputPath}`,
        cwd: workspacePath,
        commandActions: [],
        additionalPermissions: {
          fileSystem: {
            read: [],
            write: [outputPath],
          },
          network: null,
        },
        availableDecisions: ['accept', 'decline'],
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 0);
    assert.deepEqual(response, { decision: 'decline' });
  });

  test('should_auto_accept_view_image_when_path_is_inside_workspace', async () => {
    const { deps, approvalCalls } = createDeps(true);
    deps.shouldAutoApproveViewImagePath = () => true;
    let response: unknown;

    const request: ServerRequest = {
      id: 900,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_ws_1',
        reason: 'view_image: /workspace/screenshot.png',
        command: 'view_image /workspace/screenshot.png',
        cwd: '/workspace',
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0, 'should not call createApproval for workspace images');
    assert.deepEqual(response, { decision: 'accept' });
  });

  test('should_auto_accept_view_image_when_path_is_in_trusted_macos_screenshot_staging', async () => {
    const { deps, approvalCalls } = createDeps(true);
    deps.shouldAutoApproveViewImagePath = () => true;
    let response: unknown;

    const request: ServerRequest = {
      id: 903,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_ws_4',
        reason: 'view_image: /private/var/folders/example/T/TemporaryItems/NSIRD_screencaptureui_123/Screenshot.png',
        command: 'view_image /private/var/folders/example/T/TemporaryItems/NSIRD_screencaptureui_123/Screenshot.png',
        cwd: '/workspace',
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0, 'should not call createApproval for trusted macOS screenshot staging images');
    assert.deepEqual(response, { decision: 'accept' });
  });

  test('should_prompt_approval_for_view_image_outside_workspace', async () => {
    const { deps, approvalCalls } = createDeps(true);
    deps.shouldAutoApproveViewImagePath = () => false;
    let response: unknown;

    const request: ServerRequest = {
      id: 901,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_ws_2',
        reason: 'view_image: /etc/secret.png',
        command: 'view_image /etc/secret.png',
        cwd: '/',
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 1, 'should call createApproval for outside-workspace images');
    assert.deepEqual(response, { decision: 'accept' });
  });

  test('should_prompt_approval_when_no_workspace_is_set', async () => {
    const { deps, approvalCalls } = createDeps(false);
    deps.shouldAutoApproveViewImagePath = () => false;
    let response: unknown;

    const request: ServerRequest = {
      id: 902,
      method: SERVER_REQUEST_METHOD.commandExecutionApproval,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_ws_3',
        reason: 'view_image: /tmp/image.png',
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 1, 'should call createApproval when no workspace');
    assert.deepEqual(response, { decision: 'decline' });
  });

  test('handles MCP tool approval elicitation via session-aware permission flow', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-mcp-1',
      threadId: 'thr_mcp_1',
      callerToken: 'agtok_mcp_1',
    });
    const { deps, sessionApprovalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 91,
      method: SERVER_REQUEST_METHOD.mcpServerElicitationRequest,
      params: {
        threadId: 'thr_mcp_1',
        turnId: 'turn_mcp_1',
        serverName: 'real-memory-e2e',
        mode: 'form',
        message: 'Allow Memory to create entities?',
        requestedSchema: {
          type: 'object',
          properties: {},
        },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          persist: ['session', 'always'],
          tool_title: 'Create Entities',
          tool_description: 'Create memory entities.',
          tool_params: {
            entities: [
              {
                name: 'interpreter-mcp-e2e',
                observations: ['works'],
              },
            ],
          },
        },
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(questionCalls.length, 0);
    assert.equal(sessionApprovalCalls.length, 1);
    assert.equal(sessionApprovalCalls[0]?.toolName, 'real-memory-e2e__Create Entities');
    assert.equal(sessionApprovalCalls[0]?.serverId, 'real-memory-e2e');
    assert.equal(sessionApprovalCalls[0]?.agentId, 'agent-mcp-1');
    assert.deepEqual(sessionApprovalCalls[0]?.args, {
      message: 'Interpreter wants to use an MCP tool.',
      description: 'Review this MCP tool call before continuing.',
      serverId: 'real-memory-e2e',
      toolName: 'Create Entities',
      args: {
        entities: [
          {
            name: 'interpreter-mcp-e2e',
            observations: ['works'],
          },
        ],
      },
      threadId: 'thr_mcp_1',
    });
    assert.deepEqual(response, { action: 'accept', content: null, _meta: null });
  });

  test('can accept MCP tool approval for the current session', async () => {
    const { deps, sessionApprovalCalls } = createDeps(true);
    deps.createSessionAwareApproval = async (toolName, serverId, args, warningMessage, timeout, toolCallId, agentId) => {
      sessionApprovalCalls.push({ toolName, serverId, args, warningMessage, timeout, toolCallId, agentId });
      return { approved: true, mode: 'session' };
    };
    let response: unknown;

    const request: ServerRequest = {
      id: 92,
      method: SERVER_REQUEST_METHOD.mcpServerElicitationRequest,
      params: {
        threadId: 'thr_mcp_2',
        turnId: 'turn_mcp_2',
        serverName: 'pubmed-http-e2e',
        mode: 'form',
        message: 'Allow PubMed search?',
        requestedSchema: {
          type: 'object',
          properties: {},
        },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          persist: 'session',
          tool_title: 'Search Articles',
        },
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(sessionApprovalCalls.length, 1);
    assert.deepEqual(response, {
      action: 'accept',
      content: null,
      _meta: { persist: 'session' },
    });
  });

  test('handles generic MCP URL elicitation through question flow', async () => {
    const { deps, approvalCalls, questionCalls } = createDeps(true);
    let response: unknown;

    const request: ServerRequest = {
      id: 93,
      method: SERVER_REQUEST_METHOD.mcpServerElicitationRequest,
      params: {
        threadId: 'thr_mcp_3',
        turnId: null,
        serverName: 'generic-mcp',
        mode: 'url',
        message: 'Open authorization URL?',
        url: 'https://example.com/oauth',
        elicitationId: 'elicit_1',
        _meta: null,
      },
    };

    await handleCodexServerRequest(request, (result) => {
      response = result;
    }, deps);

    assert.equal(approvalCalls.length, 0);
    assert.equal(questionCalls.length, 1);
    assert.equal(questionCalls[0]?.toolName, 'MCP request');
    assert.equal(questionCalls[0]?.serverId, 'generic-mcp');
    assert.deepEqual(questionCalls[0]?.questions[0]?.options.map((option) => option.value), [
      'accept',
      'decline',
      'cancel',
    ]);
    assert.deepEqual(response, { action: 'accept', content: null, _meta: null });
  });

  test('attaches request listener once per client instance', () => {
    const { deps } = createDeps(true);
    const handlers: Array<(request: ServerRequest, respond: (result: unknown) => void) => void> = [];

    const client = {
      subscribeServerRequests(
        handler: (request: ServerRequest, respond: (result: unknown) => void) => void,
      ) {
        handlers.push(handler);
        return () => {};
      },
    };

    attachCodexServerRequestApprovals(client, deps);
    attachCodexServerRequestApprovals(client, deps);

    assert.equal(handlers.length, 1);
  });
});
