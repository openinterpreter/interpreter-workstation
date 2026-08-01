import express from 'express';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import request from 'supertest';

const getGlobalDisabledToolsMock = mock(async () => [] as string[]);
const resolveAndExecuteCodexToolMock = mock(async () => ({
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
}));

mock.module('./mcpDependencies', () => ({
  getGlobalDisabledTools: getGlobalDisabledToolsMock,
  resolveAndExecuteCodexTool: resolveAndExecuteCodexToolMock,
}));

const mcpRouter = (await import('./mcp')).default;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/mcp', mcpRouter);
  return app;
}

describe('MCP router scoped tool calls', () => {
  beforeEach(() => {
    getGlobalDisabledToolsMock.mockClear();
    getGlobalDisabledToolsMock.mockResolvedValue([]);
    resolveAndExecuteCodexToolMock.mockClear();
    resolveAndExecuteCodexToolMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
  });

  test('forwards decoded profile and tab identity from scoped /mcp tool calls', async () => {
    const response = await request(createApp())
      .post(`/mcp/${encodeURIComponent('main agent')}/${encodeURIComponent('agent tab 1')}`)
      .send({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'custom-mcp__lookup',
          arguments: { q: 'status' },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    });
    expect(resolveAndExecuteCodexToolMock).toHaveBeenCalledTimes(1);
    expect(resolveAndExecuteCodexToolMock).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'custom-mcp',
      toolName: 'lookup',
      args: { q: 'status' },
      callerTabId: 'agent tab 1',
      profileId: 'main agent',
    }));
  });

  test('uses scoped tool profile override without losing caller tab ownership', async () => {
    const response = await request(createApp())
      .post(`/mcp/${encodeURIComponent('main-agent')}/${encodeURIComponent('agent-123')}`)
      .query({ tool_profile: 'profile-1' })
      .send({
        jsonrpc: '2.0',
        id: 'call-1',
        method: 'tools/call',
        params: {
          name: 'custom-mcp__lookup',
          arguments: { q: 'status' },
        },
      });

    expect(response.status).toBe(200);
    expect(resolveAndExecuteCodexToolMock).toHaveBeenCalledTimes(1);
    expect(resolveAndExecuteCodexToolMock).toHaveBeenCalledWith(expect.objectContaining({
      callerTabId: 'agent-123',
      profileId: 'profile-1',
    }));
  });
});
