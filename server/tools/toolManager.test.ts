import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('../utils/mcpServiceBridge', () => ({
  getMcpService: () => ({
    listServers: async () => ({ data: [], nextCursor: null }),
    listServersForDisplay: async () => ({ data: [], nextCursor: null }),
    listAuthStatusesViaCli: async () => new Map(),
    getServerStatus: async () => null,
    getDisplayServerStatus: async () => null,
  }),
  McpService: {
    toToolServerStatus: (s: any) => ({ id: s.name, name: s.name, state: { status: 'connected', tools: [], resources: [], prompts: [] } }),
    toToolConnectionState: (s: any) => ({ status: 'connected', tools: [], resources: [], prompts: [] }),
  },
}));

import { approvalManager } from '../approvalManager';
import { clearConfigCache, setConfigOverride } from '../configStore';
import { setCurrentWorkspace } from '../utils/workspace';
import { ToolManager } from './toolManager';

const WORKSPACE = process.platform === 'win32'
  ? 'C:\\Users\\test\\project'
  : '/Users/test/project';

async function waitForApproval() {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    const [approval] = approvalManager.getApprovals();
    if (approval) {
      return approval;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Timed out waiting for approval');
}

describe('ToolManager callTool', () => {
  beforeEach(() => {
    clearConfigCache();
    setCurrentWorkspace(WORKSPACE);
    approvalManager.setAutoApprove(false);
    approvalManager.clearAll();
    setConfigOverride({
      agents: {},
      mcpServers: {},
    });
  });

  afterEach(() => {
    setCurrentWorkspace(null);
    approvalManager.clearAll();
    setConfigOverride(null);
    clearConfigCache();
  });

  test('uses callerTabId as builtin tool agent context when no agentId is available', async () => {
    const manager = new ToolManager();

    const callPromise = manager.callTool(
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
      undefined,
      'main-agent',
    );

    const approval = await waitForApproval();
    expect(approval.agentId).toBe('main-agent');

    const respondResult = await approvalManager.respond(approval.id, {
      answers: { '0': 'cerulean' },
    });
    expect(respondResult).toEqual({ success: true });

    const result = await callPromise as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      answers: { '0': 'cerulean' },
    });
  });

  test('omits hosted Media AI from the community distribution', async () => {
    const manager = new ToolManager();

    const servers = await manager.listAllToolServers();
    const mediaServer = servers.find((server) => server.id === 'builtin-media-ai');
    expect(mediaServer).toBeUndefined();

    const agentTools = await manager.getEnabledToolsForAgent();
    expect(agentTools
      .filter((tool) => tool.serverId === 'builtin-media-ai')
      .map((tool) => tool.name)
      .sort()).toEqual([]);
  });
});
