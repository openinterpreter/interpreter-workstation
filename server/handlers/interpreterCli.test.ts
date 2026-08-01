import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

import JSZip from 'jszip';
import { agentTabManager } from '../agentTabManager';
import { approvalManager } from '../approvalManager';
import { clearConfigCache, setConfigOverride } from '../configStore';
import { calculatorTool } from '../tools/builtin-tools/utility/calculatorTool';
import { ToolManager } from '../tools/toolManager';
import { setToolManager } from '../tools/toolManagerAccessor';
import { setReadToolPromptInjectionGuardRunnerForTests } from '../utils/readToolPromptInjectionGuard';
import { setCurrentWorkspace } from '../utils/workspace';
import {
  callInterpreterCliTool,
  describeInterpreterCliTool,
  findInterpreterCliTools,
  getInterpreterCliConfig,
  listInterpreterCliServerTools,
  listInterpreterCliTools,
  restartInterpreterCliRuntime,
  setInterpreterCliConfig,
} from './interpreterCli';

async function createDocx(
  filePath: string,
  paragraphXmls: string[],
): Promise<void> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder('word')?.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphXmls.join('')}<w:sectPr/></w:body></w:document>`,
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await writeFile(filePath, buffer);
}

async function waitForApprovalRequest(toolName: string) {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    const request = approvalManager
      .getRequests()
      .find((approval) => approval.toolName === toolName);
    if (request) {
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for ${toolName} approval`);
}

describe('interpreterCli handlers', () => {
  beforeEach(() => {
    agentTabManager.clearAll();
    approvalManager.setAutoApprove(false);
    approvalManager.clearAll();
    setCurrentWorkspace(null);
    setConfigOverride(null);
    setReadToolPromptInjectionGuardRunnerForTests(null);
    clearConfigCache();
  });

  test('lists visible servers for a bound caller token', async () => {
    setToolManager({
      async getToolServer() {
        return {
          id: 'builtin-docx',
          name: 'Word Documents',
          description: 'DOCX tools',
          state: {
            status: 'connected',
            tools: [
              { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object' } },
            ],
            resources: [],
            prompts: [],
          },
        };
      },
      async listAllToolServers() {
        return [
          {
            id: 'builtin-docx',
            name: 'Word Documents',
            description: 'DOCX tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object' } },
              ],
            },
          },
          {
            id: 'custom-mcp',
            name: 'Custom MCP',
            description: 'Offline',
            state: {
              status: 'disconnected',
              tools: [],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-1',
      threadId: 'thr_1',
      callerToken: 'agtok_1',
      allowedToolNames: ['builtin-docx__read_word'],
    });

    await expect(listInterpreterCliTools('agtok_1')).resolves.toEqual({
      servers: [
        {
          id: 'builtin-docx',
          name: 'Word Documents',
          description: 'DOCX tools',
          toolCount: 1,
        },
      ],
    });
  });

  test('calls visible built-in tools without hydrating MCP server statuses', async () => {
    const calls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }> = [];
    setToolManager({
      async listAllToolServers() {
        throw new Error('should not list all servers for an exact built-in tool call');
      },
      async getToolServer(serverId: string) {
        expect(serverId).toBe('builtin-mcp-management');
        return {
          id: 'builtin-mcp-management',
          name: 'MCP Management',
          description: 'Manage MCP servers',
          state: {
            status: 'connected',
            tools: [
              { name: 'mcp_list_servers', description: 'List MCP servers', inputSchema: { type: 'object' } },
            ],
            resources: [],
            prompts: [],
          },
        };
      },
      async callTool(
        serverId: string,
        toolName: string,
        args: Record<string, unknown>,
      ) {
        calls.push({ serverId, toolName, args });
        return { ok: true };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-fast-builtin',
      threadId: 'thr_fast_builtin',
      callerToken: 'agtok_fast_builtin',
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_fast_builtin',
      serverId: 'builtin-mcp-management',
      toolName: 'mcp_list_servers',
      args: { includeBuiltin: false },
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        serverId: 'builtin-mcp-management',
        toolName: 'mcp_list_servers',
        args: { includeBuiltin: false },
      },
    ]);
  });

  test('keeps image bytes out of CLI tool stdout results', async () => {
    setToolManager({
      async listAllToolServers() {
        throw new Error('should not list all servers for an exact built-in tool call');
      },
      async getToolServer(serverId: string) {
        expect(serverId).toBe('builtin-mcp-management');
        return {
          id: 'builtin-mcp-management',
          name: 'MCP Management',
          description: 'Manage MCP servers',
          state: {
            status: 'connected',
            tools: [
              { name: 'mcp_list_servers', description: 'List MCP servers', inputSchema: { type: 'object' } },
            ],
            resources: [],
            prompts: [],
          },
        };
      },
      async callTool() {
        return {
          content: [
            { type: 'text', text: 'Computer Use state' },
            {
              type: 'image',
              image: {
                data: 'aW1hZ2UtYnl0ZXM=',
                mimeType: 'image/jpeg',
              },
            },
          ],
          imagePaths: ['/tmp/interpreter-desktop-driver-state.jpg'],
          isError: false,
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-cua-cli-image',
      threadId: 'thr_cua_cli_image',
      callerToken: 'agtok_cua_cli_image',
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_cua_cli_image',
      serverId: 'builtin-mcp-management',
      toolName: 'mcp_list_servers',
      args: {},
    })).resolves.toEqual({
      content: [
        { type: 'text', text: 'Computer Use state' },
        { type: 'text', text: 'Image content is available at: /tmp/interpreter-desktop-driver-state.jpg' },
      ],
      imagePaths: ['/tmp/interpreter-desktop-driver-state.jpg'],
      isError: false,
    });
  });

  test('blocks read-only Interpreter CLI output when the prompt-injection guard flags it', async () => {
    const guardCalls: Array<{ modelProfileId: string; resultText: string }> = [];
    setReadToolPromptInjectionGuardRunnerForTests(async (input, modelProfileId) => {
      guardCalls.push({ modelProfileId, resultText: input.resultText });
      return { verdict: 'block', reason: 'tool output contains agent-directed instructions' };
    });
    setToolManager(new ToolManager());
    setConfigOverride({
      agents: {},
      profiles: [{
        id: 'guard-profile',
        name: 'Guard Profile',
        modelId: 'interpreter-fast',
        isBuiltin: false,
        provider: 'hosted',
      }],
      interpreterOverlay: {
        accountUserId: null,
        enabled: false,
        permissionSetupPending: false,
        hotkey: 'Control+Space',
        preferredWorkspacePath: null,
        preferredNoWorkspace: false,
        preferredProfileId: null,
        advancedVoiceEnabled: true,
        advancedVoiceWorkspacePath: null,
        advancedVoiceModel: 'interpreter-fast',
        hiddenAgentModel: 'interpreter-fast',
        readToolPromptInjectionGuard: {
          enabled: true,
          modelProfileId: 'guard-profile',
        },
      },
    });
    agentTabManager.bindThread({
      agentId: 'agent-guard-read',
      threadId: 'thr_guard_read',
      callerToken: 'agtok_guard_read',
      allowedToolNames: ['builtin-utility__calculate'],
    });

    const result = await callInterpreterCliTool({
      callerToken: 'agtok_guard_read',
      serverId: 'builtin-utility',
      toolName: 'calculate',
      args: { expression: '2 + 2' },
    }) as { content: Array<{ text?: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      'Read tool result blocked by prompt-injection guard: tool output contains agent-directed instructions',
    );
    expect(result.content[0]?.text).not.toContain('4');
    expect(guardCalls).toEqual([{
      modelProfileId: 'guard-profile',
      resultText: `{
  "expression": "2 + 2",
  "result": 4
}`,
    }]);
  });

  test('does not run the prompt-injection guard for write Interpreter CLI tools', async () => {
    let guardCallCount = 0;
    setReadToolPromptInjectionGuardRunnerForTests(async () => {
      guardCallCount += 1;
      return { verdict: 'block', reason: 'should not be called' };
    });
    setConfigOverride({
      agents: {},
      profiles: [{
        id: 'guard-profile',
        name: 'Guard Profile',
        modelId: 'interpreter-fast',
        isBuiltin: false,
        provider: 'hosted',
      }],
      interpreterOverlay: {
        accountUserId: null,
        enabled: false,
        permissionSetupPending: false,
        hotkey: 'Control+Space',
        preferredWorkspacePath: null,
        preferredNoWorkspace: false,
        preferredProfileId: null,
        advancedVoiceEnabled: true,
        advancedVoiceWorkspacePath: null,
        advancedVoiceModel: 'interpreter-fast',
        hiddenAgentModel: 'interpreter-fast',
        readToolPromptInjectionGuard: {
          enabled: true,
          modelProfileId: 'guard-profile',
        },
      },
    });
    setToolManager({
      async listAllToolServers() {
        throw new Error('should not list all servers for an exact built-in tool call');
      },
      async getToolServer(serverId: string) {
        expect(serverId).toBe('builtin-mcp-management');
        return {
          id: 'builtin-mcp-management',
          name: 'MCP Management',
          description: 'Manage MCP servers',
          state: {
            status: 'connected',
            tools: [
              { name: 'mcp_refresh_tools', description: 'Refresh MCP tools', inputSchema: { type: 'object' } },
            ],
            resources: [],
            prompts: [],
          },
        };
      },
      async callTool() {
        return {
          content: [{ type: 'text', text: 'refreshed' }],
          isError: false,
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-guard-write',
      threadId: 'thr_guard_write',
      callerToken: 'agtok_guard_write',
      allowedToolNames: ['builtin-mcp-management__mcp_refresh_tools'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_guard_write',
      serverId: 'builtin-mcp-management',
      toolName: 'mcp_refresh_tools',
      args: { reason: 'test' },
    })).resolves.toEqual({
      content: [{ type: 'text', text: 'refreshed' }],
      isError: false,
    });
    expect(guardCallCount).toBe(0);
  });

  test('guards annotated read-only built-in Interpreter CLI tools', async () => {
    const guardCalls: string[] = [];
    setReadToolPromptInjectionGuardRunnerForTests(async (input) => {
      guardCalls.push(`${input.serverId}/${input.toolName}:${input.resultText}`);
      return { verdict: 'block', reason: 'metadata-marked read result is untrusted' };
    });
    setConfigOverride({
      agents: {},
      profiles: [{
        id: 'guard-profile',
        name: 'Guard Profile',
        modelId: 'interpreter-fast',
        isBuiltin: false,
        provider: 'hosted',
      }],
      interpreterOverlay: {
        accountUserId: null,
        enabled: false,
        permissionSetupPending: false,
        hotkey: 'Control+Space',
        preferredWorkspacePath: null,
        preferredNoWorkspace: false,
        preferredProfileId: null,
        advancedVoiceEnabled: true,
        advancedVoiceWorkspacePath: null,
        advancedVoiceModel: 'interpreter-fast',
        hiddenAgentModel: 'interpreter-fast',
        readToolPromptInjectionGuard: {
          enabled: true,
          modelProfileId: 'guard-profile',
        },
      },
    });
    setToolManager({
      async listAllToolServers() {
        throw new Error('should not list all servers for an exact built-in tool call');
      },
      async getToolServer(serverId: string) {
        expect(serverId).toBe('builtin-mcp-management');
        return {
          id: 'builtin-mcp-management',
          name: 'MCP Management',
          description: 'Manage MCP servers',
          state: {
            status: 'connected',
            tools: [
              { name: 'mcp_list_servers', description: 'List MCP servers', inputSchema: { type: 'object' } },
            ],
            resources: [],
            prompts: [],
          },
        };
      },
      async callTool() {
        return {
          content: [{ type: 'text', text: '{"servers":["private-server"]}' }],
          isError: false,
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-guard-annotated-read',
      threadId: 'thr_guard_annotated_read',
      callerToken: 'agtok_guard_annotated_read',
      allowedToolNames: ['builtin-mcp-management__mcp_list_servers'],
    });

    const result = await callInterpreterCliTool({
      callerToken: 'agtok_guard_annotated_read',
      serverId: 'builtin-mcp-management',
      toolName: 'mcp_list_servers',
      args: {},
    }) as { content: Array<{ text?: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      'Read tool result blocked by prompt-injection guard: metadata-marked read result is untrusted',
    );
    expect(result.content[0]?.text).not.toContain('private-server');
    expect(guardCalls).toEqual([
      'builtin-mcp-management/mcp_list_servers:{"servers":["private-server"]}',
    ]);
  });

  test('fails loudly when read-tool guard is enabled without a model profile', async () => {
    setToolManager(new ToolManager());
    setConfigOverride({
      agents: {},
      interpreterOverlay: {
        accountUserId: null,
        enabled: false,
        permissionSetupPending: false,
        hotkey: 'Control+Space',
        preferredWorkspacePath: null,
        preferredNoWorkspace: false,
        preferredProfileId: null,
        advancedVoiceEnabled: true,
        advancedVoiceWorkspacePath: null,
        advancedVoiceModel: 'interpreter-fast',
        hiddenAgentModel: 'interpreter-fast',
        readToolPromptInjectionGuard: {
          enabled: true,
          modelProfileId: null,
        },
      },
    });
    agentTabManager.bindThread({
      agentId: 'agent-guard-no-model',
      threadId: 'thr_guard_no_model',
      callerToken: 'agtok_guard_no_model',
      allowedToolNames: ['builtin-utility__calculate'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_guard_no_model',
      serverId: 'builtin-utility',
      toolName: 'calculate',
      args: { expression: '2 + 2' },
    })).rejects.toThrow('Read-tool prompt-injection guard is enabled but no model profile is configured');
  });

  test('lists tools for one visible server', async () => {
    setToolManager({
      async getToolServer() {
        return {
          id: 'builtin-docx',
          name: 'Word Documents',
          description: 'DOCX tools',
          state: {
            status: 'connected',
            tools: [
              { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object' } },
            ],
            resources: [],
            prompts: [],
          },
        };
      },
      async listAllToolServers() {
        return [
          {
            id: 'builtin-docx',
            name: 'Word Documents',
            description: 'DOCX tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object' } },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-server-tools',
      threadId: 'thr_server_tools',
      callerToken: 'agtok_server_tools',
      allowedToolNames: ['builtin-docx__read_word'],
    });

    await expect(listInterpreterCliServerTools('agtok_server_tools', 'builtin-docx')).resolves.toEqual({
      server: {
        id: 'builtin-docx',
        name: 'Word Documents',
        description: 'DOCX tools',
      },
      tools: [
        { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object' } },
      ],
    });
  });

  test('returns an empty-tool notice for connected MCP servers without discovered tools', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'fresh-mcp',
            name: 'Fresh MCP',
            description: 'Just installed',
            state: {
              status: 'connected',
              tools: [],
              resources: [],
              prompts: [],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-empty-mcp',
      threadId: 'thr_empty_mcp',
      callerToken: 'agtok_empty_mcp',
    });

    await expect(listInterpreterCliServerTools('agtok_empty_mcp', 'fresh-mcp')).resolves.toEqual({
      server: {
        id: 'fresh-mcp',
        name: 'Fresh MCP',
        description: 'Just installed',
      },
      tools: [],
      notice: expect.stringContaining('mcp_refresh_tools'),
    });
  });

  test('does not expose empty-tool notice outside caller tool scope', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'fresh-mcp',
            name: 'Fresh MCP',
            description: 'Just installed',
            state: {
              status: 'connected',
              tools: [],
              resources: [],
              prompts: [],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-scoped-empty-mcp',
      threadId: 'thr_scoped_empty_mcp',
      callerToken: 'agtok_scoped_empty_mcp',
      allowedToolNames: ['builtin-docx__read_word'],
    });

    await expect(listInterpreterCliServerTools('agtok_scoped_empty_mcp', 'fresh-mcp')).rejects.toThrow(
      "Tool server 'fresh-mcp' is not available.",
    );
  });

  test('treats empty allowedToolNames as unrestricted for discovery', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-cells',
            name: 'Excel Spreadsheets',
            description: 'Spreadsheet tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_spreadsheet', description: 'Read workbook', inputSchema: { type: 'object' } },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-empty-allowed-tools',
      threadId: 'thr_empty_allowed_tools',
      callerToken: 'agtok_empty_allowed_tools',
      allowedToolNames: [],
    });

    await expect(listInterpreterCliTools('agtok_empty_allowed_tools')).resolves.toEqual({
      servers: [
        {
          id: 'builtin-cells',
          name: 'Excel Spreadsheets',
          description: 'Spreadsheet tools',
          toolCount: 1,
        },
      ],
    });

    await expect(listInterpreterCliServerTools('agtok_empty_allowed_tools', 'builtin-cells')).resolves.toEqual({
      server: {
        id: 'builtin-cells',
        name: 'Excel Spreadsheets',
        description: 'Spreadsheet tools',
      },
      tools: [
        { name: 'read_spreadsheet', description: 'Read workbook', inputSchema: { type: 'object' } },
      ],
    });
  });

  test('finds visible tools across shared servers', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-interpreter',
            name: 'Interpreter',
            description: 'Interpreter tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'interpreter_vault', description: 'Inspect note graph', inputSchema: { type: 'object' } },
                { name: 'interpreter_settings_get', description: 'Read settings', inputSchema: { type: 'object' } },
              ],
            },
          },
          {
            id: 'builtin-docx',
            name: 'Word Documents',
            description: 'DOCX tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object' } },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-find-tools',
      threadId: 'thr_find_tools',
      callerToken: 'agtok_find_tools',
      allowedToolNames: ['builtin-interpreter__interpreter_vault'],
    });

    await expect(findInterpreterCliTools('agtok_find_tools', 'interpreter_vault')).resolves.toEqual({
      query: 'interpreter_vault',
      matches: [
        {
          qualifiedName: 'builtin-interpreter__interpreter_vault',
          server: {
            id: 'builtin-interpreter',
            name: 'Interpreter',
            description: 'Interpreter tools',
          },
          tool: {
            name: 'interpreter_vault',
            description: 'Inspect note graph',
            inputSchema: { type: 'object' },
          },
        },
      ],
    });
  });

  test('prefers exact token coverage over substring matches in tool search', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-cells',
            name: 'Excel Spreadsheets',
            description: 'Read and edit Excel (.xlsx, .xls, .xlsm) spreadsheets',
            state: {
              status: 'connected',
              tools: [
                {
                  name: 'recalculate_workbook',
                  description: 'Recalculate all formulas in an Excel workbook and save refreshed cached results back into the file.',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          },
          {
            id: 'builtin-utility',
            name: 'Utility Tools',
            description: 'General utility tools like wait/sleep and calculator',
            state: {
              status: 'connected',
              tools: [
                {
                  name: 'calculate',
                  description: 'Evaluate a math expression or calculate the difference between two dates.',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-find-ranking',
      threadId: 'thr_find_ranking',
      callerToken: 'agtok_find_ranking',
      allowedToolNames: [],
    });

    const result = await findInterpreterCliTools('agtok_find_ranking', 'recalculate workbook excel');
    expect(result.query).toBe('recalculate workbook excel');
    expect(result.matches[0]?.qualifiedName).toBe('builtin-cells__recalculate_workbook');
  });

  test('still ranks direct calculator queries to the calculator tool', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-cells',
            name: 'Excel Spreadsheets',
            description: 'Read and edit Excel (.xlsx, .xls, .xlsm) spreadsheets',
            state: {
              status: 'connected',
              tools: [
                {
                  name: 'recalculate_workbook',
                  description: 'Recalculate all formulas in an Excel workbook and save refreshed cached results back into the file.',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          },
          {
            id: 'builtin-utility',
            name: 'Utility Tools',
            description: 'General utility tools like wait/sleep and calculator',
            state: {
              status: 'connected',
              tools: [
                {
                  name: 'calculate',
                  description: 'Evaluate a math expression or calculate the difference between two dates.',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-find-ranking-calc',
      threadId: 'thr_find_ranking_calc',
      callerToken: 'agtok_find_ranking_calc',
      allowedToolNames: [],
    });

    const result = await findInterpreterCliTools('agtok_find_ranking_calc', 'calculate');
    expect(result.query).toBe('calculate');
    expect(result.matches[0]?.qualifiedName).toBe('builtin-utility__calculate');
  });

  test('prefers the PDF server over description-only PDF mentions', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-cells',
            name: 'Excel Spreadsheets',
            description: 'Read and edit Excel (.xlsx, .xls, .xlsm) spreadsheets',
            state: {
              status: 'connected',
              tools: [
                {
                  name: 'export_spreadsheet',
                  description: 'Export a spreadsheet to PDF or HTML for sharing and visual review.',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          },
          {
            id: 'builtin-pdf',
            name: 'PDF Documents',
            description: 'Read, create, and inspect PDF files',
            state: {
              status: 'connected',
              tools: [
                {
                  name: 'read_pdf',
                  description: 'Read text and metadata from a PDF file.',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-find-ranking-pdf',
      threadId: 'thr_find_ranking_pdf',
      callerToken: 'agtok_find_ranking_pdf',
      allowedToolNames: [],
    });

    const result = await findInterpreterCliTools('agtok_find_ranking_pdf', 'pdf');
    expect(result.query).toBe('pdf');
    expect(result.matches[0]?.qualifiedName).toBe('builtin-pdf__read_pdf');
  });

  test('prefers the DOCX server over converter description hits for docx queries', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-converter',
            name: 'File Converter',
            description: 'Convert files between formats like docx, pdf, html, and images.',
            state: {
              status: 'connected',
              tools: [
                {
                  name: 'convert_file',
                  description: 'Convert a source document such as DOCX to PDF or another supported format.',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          },
          {
            id: 'builtin-docx',
            name: 'Word Documents',
            description: 'Read and edit Word DOCX files',
            state: {
              status: 'connected',
              tools: [
                {
                  name: 'read_docx',
                  description: 'Read the visible text from a DOCX file.',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-find-ranking-docx',
      threadId: 'thr_find_ranking_docx',
      callerToken: 'agtok_find_ranking_docx',
      allowedToolNames: [],
    });

    const result = await findInterpreterCliTools('agtok_find_ranking_docx', 'docx');
    expect(result.query).toBe('docx');
    expect(result.matches[0]?.qualifiedName).toBe('builtin-docx__read_docx');
  });

  test('prefers read_spreadsheet over export_spreadsheet for read-oriented workbook queries', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-cells',
            name: 'Excel Spreadsheets',
            description: 'Read and edit Excel (.xlsx, .xls, .xlsm) spreadsheets',
            state: {
              status: 'connected',
              tools: [
                {
                  name: 'export_spreadsheet',
                  description: 'Export an Excel workbook to a different format (PDF, HTML, CSV, JSON, XML, TXT, MD)',
                  inputSchema: { type: 'object' },
                },
                {
                  name: 'read_spreadsheet',
                  description: 'Read comprehensive spreadsheet data in a single operation.',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-find-ranking-read-sheet',
      threadId: 'thr_find_ranking_read_sheet',
      callerToken: 'agtok_find_ranking_read_sheet',
      allowedToolNames: [],
    });

    const result = await findInterpreterCliTools(
      'agtok_find_ranking_read_sheet',
      'read spreadsheet workbook cells excel',
    );
    expect(result.query).toBe('read spreadsheet workbook cells excel');
    expect(result.matches[0]?.qualifiedName).toBe('builtin-cells__read_spreadsheet');
  });

  test('hides built-in browser tools on the default CLI surface', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-docx',
            name: 'Word Documents',
            description: 'DOCX tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object' } },
              ],
            },
          },
          {
            id: 'builtin-browser',
            name: 'Browser',
            description: 'Browser tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'navigate', description: 'Open page', inputSchema: { type: 'object' } },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-default-surface',
      threadId: 'thr_default_surface',
      callerToken: 'agtok_default_surface',
    });

    await expect(listInterpreterCliTools('agtok_default_surface')).resolves.toEqual({
      servers: [
        {
          id: 'builtin-docx',
          name: 'Word Documents',
          description: 'DOCX tools',
          toolCount: 1,
        },
      ],
    });
  });

  test('hides DOCX helper tools on the default CLI surface', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-docx',
            name: 'Word Documents',
            description: 'DOCX tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object' } },
                { name: 'add_docx_relationship', description: 'Add DOCX relationship', inputSchema: { type: 'object' } },
                { name: 'add_docx_image', description: 'Add DOCX image', inputSchema: { type: 'object' } },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-hidden-docx-helpers',
      threadId: 'thr_hidden_docx_helpers',
      callerToken: 'agtok_hidden_docx_helpers',
    });

    await expect(listInterpreterCliTools('agtok_hidden_docx_helpers')).resolves.toEqual({
      servers: [
        {
          id: 'builtin-docx',
          name: 'Word Documents',
          description: 'DOCX tools',
          toolCount: 1,
        },
      ],
    });
  });

  test('allows CLI DOCX tool calls for builtin office tools', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'interpreter-cli-docx-'));

    try {
      const docxPath = path.join(tempDir, 'status.docx');
      await createDocx(docxPath, [
        '<w:p><w:r><w:t>Project status</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Release date: TBD</w:t></w:r></w:p>',
      ]);

      setConfigOverride({
        agents: {},
        mcpServers: {},
        builtinToolsEnabled: {
          'builtin-docx': true,
        },
      } as any);
      setToolManager(new ToolManager());
      agentTabManager.bindThread({
        agentId: 'agent-docx-edit',
        threadId: 'thr_docx_edit',
        callerToken: 'agtok_docx_edit',
        workspacePath: tempDir,
        allowedToolNames: [
          'builtin-docx__replace_text_in_docx',
          'builtin-docx__read_word',
        ],
      });

      const visibleTools = await listInterpreterCliTools('agtok_docx_edit');
      expect(visibleTools.servers).toHaveLength(1);
      expect(visibleTools.servers[0]).toMatchObject({
        id: 'builtin-docx',
        toolCount: 2,
      });

      await expect(callInterpreterCliTool({
        callerToken: 'agtok_docx_edit',
        serverId: 'builtin-docx',
        toolName: 'replace_text_in_docx',
        args: {
          path: 'status.docx',
          replacements: [
            {
              old_text: 'Release date: TBD',
              new_text: 'Release date: April 30',
            },
          ],
        },
      })).resolves.toBeDefined();

      const updatedZip = await JSZip.loadAsync(await readFile(docxPath));
      const updatedDocumentXml = await updatedZip.file('word/document.xml')?.async('string');
      expect(updatedDocumentXml).toContain('Release date: April 30');
      expect(updatedDocumentXml).not.toContain('Release date: TBD');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  test('lists explicitly scoped hidden builtin tools', async () => {
    setToolManager({
      async listAllToolServers() {
        return [];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-hidden-test-approval',
      threadId: 'thr_hidden_test_approval',
      callerToken: 'agtok_hidden_test_approval',
      allowedToolNames: ['builtin-test-approval__test_approval'],
    });

    await expect(listInterpreterCliTools('agtok_hidden_test_approval')).resolves.toEqual({
      servers: [
        {
          id: 'builtin-test-approval',
          name: 'Test Approval',
          description: 'Tools for testing the approval system',
          toolCount: 1,
        },
      ],
    });
  });

  test('allows explicitly scoped hidden builtin tools to be called', async () => {
    const calls: any[] = [];

    setToolManager({
      async listAllToolServers() {
        return [];
      },
      async getToolServerIncludingHidden(serverId: string) {
        expect(serverId).toBe('builtin-test-approval');
        return {
          id: 'builtin-test-approval',
          name: 'Test Approval',
          description: 'Tools for testing the approval system',
          state: {
            status: 'connected',
            tools: [
              {
                name: 'test_approval',
                description: 'A test tool that requires user approval before executing. Used to test the approval system.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    timeout: { type: 'number' },
                  },
                  required: [],
                },
              },
            ],
          },
        };
      },
      async callTool(
        serverId: string,
        toolName: string,
        args: Record<string, unknown>,
        _saveToDisk: boolean,
        callerTabId?: string,
        _toolContext?: Record<string, unknown>,
        _externalToolCallId?: string,
        options?: { includeHiddenBuiltins?: boolean },
      ) {
        calls.push({ serverId, toolName, args, callerTabId, options });
        return { ok: true };
      },
    } as any);

    agentTabManager.bindThread({
      agentId: 'agent-hidden-test-approval-call',
      threadId: 'thr_hidden_test_approval_call',
      callerToken: 'agtok_hidden_test_approval_call',
      allowedToolNames: ['builtin-test-approval__test_approval'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_hidden_test_approval_call',
      serverId: 'builtin-test-approval',
      toolName: 'test_approval',
      args: { message: 'hello' },
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        serverId: 'builtin-test-approval',
        toolName: 'test_approval',
        args: { message: 'hello' },
        callerTabId: 'agent-hidden-test-approval-call',
        options: { includeHiddenBuiltins: true },
      },
    ]);
  });

  test('creates CLI approvals with the bound originating agent identity', async () => {
    setToolManager(new ToolManager());
    agentTabManager.bindThread({
      agentId: 'agent-cli-approval-owner',
      threadId: 'thr_cli_approval_owner',
      callerToken: 'agtok_cli_approval_owner',
      windowSessionKey: 'window-cli-approval-owner',
      workspacePath: '/workspace-cli-approval-owner',
      allowedToolNames: ['builtin-test-approval__test_approval'],
      toolProfileId: 'profile-cli-approval-owner',
      modelConfig: {
        provider: 'openai-oauth',
        modelId: 'gpt-5.4',
        profileId: 'profile-cli-approval-owner',
      },
    });

    const pendingCall = callInterpreterCliTool({
      callerToken: 'agtok_cli_approval_owner',
      serverId: 'builtin-test-approval',
      toolName: 'test_approval',
      args: { message: 'confirm CLI owner', timeout: 0 },
    });
    void pendingCall.catch(() => {});

    const request = await waitForApprovalRequest('test_approval');
    expect(request.serverId).toBe('builtin-test-approval');
    expect(request.agentId).toBe('agent-cli-approval-owner');
    expect(request.owner?.approvalOwnerKind).toBe('normal-agent');
    expect(request.owner?.displayName).toBe('Interpreter agent (profile-cli-approval-owner)');
    expect(request.owner?.identity).toEqual({
      agentId: 'agent-cli-approval-owner',
      threadId: 'thr_cli_approval_owner',
      windowSessionKey: 'window-cli-approval-owner',
      workspacePath: '/workspace-cli-approval-owner',
      allowedToolNames: ['builtin-test-approval__test_approval'],
      toolProfileId: 'profile-cli-approval-owner',
    });
    expect(JSON.stringify(request)).not.toContain('agtok_cli_approval_owner');

    approvalManager.approve(request.id);
    const result = await pendingCall as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      approved: true,
      message: 'confirm CLI owner',
    });
  });

  test('passes CLI progress callbacks through to tool manager calls', async () => {
    const progress: string[] = [];
    const mediaTool = {
      name: 'run_media_model',
      description: 'Run a media model',
      inputSchema: {
        type: 'object',
        required: ['endpoint_id', 'input'],
      },
    };

    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-media-ai',
            name: 'Media AI',
            description: 'Media generation tools',
            state: {
              status: 'connected',
              tools: [mediaTool],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'builtin-media-ai',
          name: 'Media AI',
          description: 'Media generation tools',
          state: {
            status: 'connected',
            tools: [mediaTool],
          },
        };
      },
      async callTool(
        serverId: string,
        toolName: string,
        args: Record<string, unknown>,
        _saveToDisk: boolean,
        callerTabId?: string,
        toolContext?: { progressReporter?: (text: string) => void | Promise<void> },
      ) {
        expect(serverId).toBe('builtin-media-ai');
        expect(toolName).toBe('run_media_model');
        expect(callerTabId).toBe('agent-cli-progress');
        expect(args).toEqual({
          endpoint_id: 'fal-ai/ben/v2/video',
          input: '{"video_url":"https://example.com/clip.mp4"}',
        });
        await toolContext?.progressReporter?.('[MediaAI] phase=queue_status status="IN_PROGRESS"');
        return { ok: true };
      },
    } as any);

    agentTabManager.bindThread({
      agentId: 'agent-cli-progress',
      threadId: 'thr_cli_progress',
      callerToken: 'agtok_cli_progress',
      allowedToolNames: ['builtin-media-ai__run_media_model'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_cli_progress',
      serverId: 'builtin-media-ai',
      toolName: 'run_media_model',
      args: {
        endpoint_id: 'fal-ai/ben/v2/video',
        input: '{"video_url":"https://example.com/clip.mp4"}',
      },
      onProgress: (text) => {
        progress.push(text);
      },
    })).resolves.toEqual({ ok: true });

    expect(progress).toEqual([
      '[MediaAI] phase=queue_status status="IN_PROGRESS"',
    ]);
  });

  test('describes a visible tool for the bound caller token', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-interpreter',
            name: 'Interpreter',
            description: 'Query and control the Interpreter UI',
            state: {
              status: 'connected',
              tools: [
                { name: 'interpreter_settings_set', description: 'Set Interpreter settings', inputSchema: { type: 'object', required: ['path', 'value'] } },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-describe',
      threadId: 'thr_describe',
      callerToken: 'agtok_describe',
      allowedToolNames: ['builtin-interpreter__interpreter_settings_set'],
    });

    await expect(describeInterpreterCliTool(
      'agtok_describe',
      'builtin-interpreter',
      'interpreter_settings_set',
    )).resolves.toEqual({
      server: {
        id: 'builtin-interpreter',
        name: 'Interpreter',
        description: 'Query and control the Interpreter UI',
      },
      tool: {
        name: 'interpreter_settings_set',
        description: 'Set Interpreter settings',
        inputSchema: { type: 'object', required: ['path', 'value'] },
      },
    });
  });

  test('describes visible builtin tools with annotations from their source definition', async () => {
    setToolManager(new ToolManager());
    agentTabManager.bindThread({
      agentId: 'agent-calculator-describe',
      threadId: 'thr_calculator_describe',
      callerToken: 'agtok_calculator_describe',
      allowedToolNames: ['builtin-utility__calculate'],
    });

    const described = await describeInterpreterCliTool(
      'agtok_calculator_describe',
      'builtin-utility',
      'calculate',
    );

    expect(described.tool).toEqual({
      name: calculatorTool.name,
      description: calculatorTool.description,
      inputSchema: calculatorTool.inputSchema,
      annotations: calculatorTool.annotations,
    });
  });

  test('calls visible custom MCP tools discovered through the CLI server list', async () => {
    const calls: Array<{
      serverId: string;
      toolName: string;
      args: Record<string, unknown>;
      callerTabId?: string;
    }> = [];
    const pubmedTool = {
      name: 'search_articles',
      description: 'Search PubMed articles',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          max_results: { type: 'number' },
        },
        required: ['query'],
      },
    };

    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'pubmed',
            name: 'PubMed',
            description: 'PubMed MCP tools',
            state: {
              status: 'connected',
              tools: [pubmedTool],
            },
          },
        ];
      },
      async callTool(
        serverId: string,
        toolName: string,
        args: Record<string, unknown>,
        _saveToDisk: boolean,
        callerTabId?: string,
      ) {
        calls.push({ serverId, toolName, args, callerTabId });
        return { ok: true };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-pubmed',
      threadId: 'thr_pubmed',
      callerToken: 'agtok_pubmed',
      allowedToolNames: ['pubmed__search_articles'],
    });

    await expect(describeInterpreterCliTool(
      'agtok_pubmed',
      'pubmed',
      'search_articles',
    )).resolves.toMatchObject({
      server: { id: 'pubmed' },
      tool: { name: 'search_articles' },
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_pubmed',
      serverId: 'pubmed',
      toolName: 'search_articles',
      args: {
        query: '2026[Publication Date]',
        max_results: 5,
      },
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        serverId: 'pubmed',
        toolName: 'search_articles',
        args: {
          query: '2026[Publication Date]',
          max_results: 5,
        },
        callerTabId: 'agent-pubmed',
      },
    ]);
  });

  test('suggests the closest server and matching tool when the server id is wrong', async () => {
    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-mcp-management',
            name: 'MCP Management',
            description: 'Manage MCP servers',
            state: {
              status: 'connected',
              tools: [
                { name: 'mcp_list_servers', description: 'List MCP servers', inputSchema: { type: 'object' } },
                { name: 'mcp_add_server', description: 'Add MCP server', inputSchema: { type: 'object' } },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-mcp-suggest',
      threadId: 'thr_mcp_suggest',
      callerToken: 'agtok_mcp_suggest',
    });

    await expect(describeInterpreterCliTool(
      'agtok_mcp_suggest',
      'builtin-tools',
      'mcp_add_server',
    )).rejects.toThrow(
      "Tool server 'builtin-tools' is not available. Did you mean 'builtin-mcp-management'? Try: 'interpreter-app tools builtin-mcp-management mcp_add_server --help'.",
    );
  });

  test('maps friendly Interpreter config aliases on get', async () => {
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    setToolManager({
      async callTool(
        _serverId: string,
        toolName: string,
        args: Record<string, unknown>,
      ) {
        calls.push({ toolName, args });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                codexNetworkAccess: true,
                codexSandboxMode: 'workspace-write',
                onboardingState: {
                  version: 1,
                  completed: false,
                  completedStepIds: ['overlay-first-use'],
                  interviewDraft: '',
                  interviewResult: null,
                  extensionDecisions: {},
                  importedToolSummary: {
                    generatedAt: null,
                    sources: [],
                    summary: '',
                  },
                },
                theme: 'dark',
              }),
            },
          ],
          isError: false,
        };
      },
      async listAllToolServers() {
        return [
          {
            id: 'builtin-interpreter',
            name: 'Interpreter',
            description: 'Query and control the Interpreter UI',
            state: {
              status: 'connected',
              tools: [
                { name: 'interpreter_settings_get', description: 'Get Interpreter settings', inputSchema: { type: 'object', required: ['path'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'builtin-interpreter',
          name: 'Interpreter',
          description: 'Query and control the Interpreter UI',
          state: {
            status: 'connected',
            tools: [
              { name: 'interpreter_settings_get', description: 'Get Interpreter settings', inputSchema: { type: 'object', required: ['path'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-config-get',
      threadId: 'thr_config_get',
      callerToken: 'agtok_config_get',
      allowedToolNames: ['builtin-interpreter__interpreter_settings_get'],
    });

    await expect(getInterpreterCliConfig('agtok_config_get', '')).resolves.toEqual({
      agentAccess: {
        network: true,
        sandboxMode: 'workspace-write',
      },
      onboarding: {
        version: 1,
        completed: false,
        completedStepIds: ['overlay-first-use'],
        interviewDraft: '',
        interviewResult: null,
        extensionDecisions: {},
        importedToolSummary: {
          generatedAt: null,
          sources: [],
          summary: '',
        },
      },
      theme: 'dark',
    });

    await expect(getInterpreterCliConfig('agtok_config_get', 'onboarding')).resolves.toEqual({
      version: 1,
      completed: false,
      completedStepIds: ['overlay-first-use'],
      interviewDraft: '',
      interviewResult: null,
      extensionDecisions: {},
      importedToolSummary: {
        generatedAt: null,
        sources: [],
        summary: '',
      },
    });

    expect(calls).toEqual([
      {
        toolName: 'interpreter_settings_get',
        args: { path: '' },
      },
      {
        toolName: 'interpreter_settings_get',
        args: { path: '' },
      },
    ]);
  });

  test('maps friendly Interpreter config aliases on set', async () => {
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    setToolManager({
      async callTool(
        _serverId: string,
        toolName: string,
        args: Record<string, unknown>,
      ) {
        calls.push({ toolName, args });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                path: 'codexNetworkAccess',
                value: true,
              }),
            },
          ],
          isError: false,
        };
      },
      async listAllToolServers() {
        return [
          {
            id: 'builtin-interpreter',
            name: 'Interpreter',
            description: 'Query and control the Interpreter UI',
            state: {
              status: 'connected',
              tools: [
                { name: 'interpreter_settings_set', description: 'Set Interpreter settings', inputSchema: { type: 'object', required: ['path', 'value'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'builtin-interpreter',
          name: 'Interpreter',
          description: 'Query and control the Interpreter UI',
          state: {
            status: 'connected',
            tools: [
              { name: 'interpreter_settings_set', description: 'Set Interpreter settings', inputSchema: { type: 'object', required: ['path', 'value'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-config-set',
      threadId: 'thr_config_set',
      callerToken: 'agtok_config_set',
      allowedToolNames: ['builtin-interpreter__interpreter_settings_set'],
    });

    await expect(setInterpreterCliConfig({
      callerToken: 'agtok_config_set',
      path: 'agentAccess.network',
      value: true,
      restartRuntime: true,
    })).resolves.toEqual({
      success: true,
      path: 'agentAccess.network',
      value: true,
    });

    expect(calls).toEqual([
      {
        toolName: 'interpreter_settings_set',
        args: {
          path: 'codexNetworkAccess',
          value: true,
          restart_runtime: true,
        },
      },
    ]);
  });

  test('maps onboarding config aliases on set', async () => {
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    setToolManager({
      async callTool(
        _serverId: string,
        toolName: string,
        args: Record<string, unknown>,
      ) {
        calls.push({ toolName, args });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                path: 'onboardingState.completed',
                value: true,
              }),
            },
          ],
          isError: false,
        };
      },
      async listAllToolServers() {
        return [
          {
            id: 'builtin-interpreter',
            name: 'Interpreter',
            description: 'Query and control the Interpreter UI',
            state: {
              status: 'connected',
              tools: [
                { name: 'interpreter_settings_set', description: 'Set Interpreter settings', inputSchema: { type: 'object', required: ['path', 'value'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'builtin-interpreter',
          name: 'Interpreter',
          description: 'Query and control the Interpreter UI',
          state: {
            status: 'connected',
            tools: [
              { name: 'interpreter_settings_set', description: 'Set Interpreter settings', inputSchema: { type: 'object', required: ['path', 'value'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-onboarding-set',
      threadId: 'thr_onboarding_set',
      callerToken: 'agtok_onboarding_set',
      allowedToolNames: ['builtin-interpreter__interpreter_settings_set'],
    });

    await expect(setInterpreterCliConfig({
      callerToken: 'agtok_onboarding_set',
      path: 'onboarding.completed',
      value: true,
    })).resolves.toEqual({
      success: true,
      path: 'onboarding.completed',
      value: true,
    });

    expect(calls).toEqual([
      {
        toolName: 'interpreter_settings_set',
        args: {
          path: 'onboardingState.completed',
          value: true,
        },
      },
    ]);
  });

  test('requests runtime restart through the config CLI surface', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-config-restart',
      threadId: 'thr_config_restart',
      callerToken: 'agtok_config_restart',
      allowedToolNames: [],
    });

    const pendingRestart = restartInterpreterCliRuntime({
      callerToken: 'agtok_config_restart',
      reason: 'Refresh MCP tools after installing a server',
    });
    const request = approvalManager
      .getRequests()
      .find((approval) => approval.toolName === 'interpreter_config_restart_runtime');

    expect(request).toBeTruthy();
    expect(request?.serverId).toBe('builtin-interpreter');
    expect(request?.agentId).toBe('agent-config-restart');
    expect(request?.context?.message).toContain('Refresh MCP tools after installing a server');
    expect(request?.context?.runtimeRestart).toBe(true);

    approvalManager.deny(request!.id);

    await expect(pendingRestart).resolves.toMatchObject({
      success: false,
      reason: 'Refresh MCP tools after installing a server',
      restartRequested: true,
      restartPerformed: false,
      restartDeclined: true,
    });
  });

  test('calls tools with the bound agent as caller identity', async () => {
    const calls: any[] = [];
    setToolManager({
      async callTool(
        serverId: string,
        toolName: string,
        args: Record<string, unknown>,
        saveToDisk?: boolean,
        callerTabId?: string,
        toolContext?: Record<string, unknown>,
      ) {
        calls.push({ serverId, toolName, args, saveToDisk, callerTabId, toolContext });
        return { ok: true };
      },
      async listAllToolServers() {
        return [
          {
            id: 'custom-files',
            name: 'Custom Files',
            description: 'Custom file tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'custom-files',
          name: 'Custom Files',
          description: 'Custom file tools',
          state: {
            status: 'connected',
            tools: [
              { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-2',
      threadId: 'thr_2',
      callerToken: 'agtok_2',
      workspacePath: '/tmp/workspace-root',
      allowedToolNames: ['custom-files__read_file'],
      modelConfig: {
        provider: 'api',
        modelId: 'gpt-5.4-mini',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
      },
      toolProfileId: 'profile-xyz',
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_2',
      serverId: 'custom-files',
      toolName: 'read_file',
      args: { path: '/tmp/scoped/sample.docx' },
      saveToDisk: true,
      saveToDiskPath: '/tmp/scoped/output.png',
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        serverId: 'custom-files',
        toolName: 'read_file',
        args: { path: '/tmp/scoped/sample.docx' },
        saveToDisk: true,
        callerTabId: 'agent-2',
        toolContext: {
          profileId: 'profile-xyz',
          modelConfig: {
            provider: 'api',
            modelId: 'gpt-5.4-mini',
            apiFormat: 'openai',
            baseURL: 'https://api.openai.com/v1',
          },
          progressReporter: undefined,
          threadId: 'thr_2',
          workspace: '/tmp/workspace-root',
          saveToDiskPath: '/tmp/scoped/output.png',
        },
      },
    ]);
  });

  test('forwards the bound thread context when calling MCP tools', async () => {
    const calls: any[] = [];
    setToolManager({
      async callTool(
        serverId: string,
        toolName: string,
        args: Record<string, unknown>,
        saveToDisk?: boolean,
        callerTabId?: string,
        toolContext?: Record<string, unknown>,
      ) {
        calls.push({ serverId, toolName, args, saveToDisk, callerTabId, toolContext });
        return { ok: true };
      },
      async listAllToolServers() {
        return [
          {
            id: 'custom-mcp',
            name: 'Custom MCP',
            description: 'MCP tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'lookup', description: 'Lookup data', inputSchema: { type: 'object', required: ['query'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'custom-mcp',
          name: 'Custom MCP',
          description: 'MCP tools',
          state: {
            status: 'connected',
            tools: [
              { name: 'lookup', description: 'Lookup data', inputSchema: { type: 'object', required: ['query'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-cli-mcp',
      threadId: 'thr_cli_mcp',
      callerToken: 'agtok_cli_mcp',
      workspacePath: '/tmp/mcp-workspace',
      allowedToolNames: ['custom-mcp__lookup'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_cli_mcp',
      serverId: 'custom-mcp',
      toolName: 'lookup',
      args: { query: 'whoami' },
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        serverId: 'custom-mcp',
        toolName: 'lookup',
        args: { query: 'whoami' },
        saveToDisk: undefined,
        callerTabId: 'agent-cli-mcp',
        toolContext: {
          profileId: undefined,
          modelConfig: undefined,
          threadId: 'thr_cli_mcp',
          workspace: '/tmp/mcp-workspace',
          progressReporter: undefined,
        },
      },
    ]);
  });

  test('returns tool isError results but logs them as failed outcomes', async () => {
    const originalLog = console.log;
    const logLines: string[] = [];
    console.log = (...args: unknown[]) => {
      logLines.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
    };
    try {
      setToolManager({
        async callTool() {
          return {
            content: [{ type: 'text', text: 'Tool-level failure' }],
            isError: true,
          };
        },
        async listAllToolServers() {
          return [
            {
              id: 'custom-files',
              name: 'Custom Files',
              description: 'Custom file tools',
              state: {
                status: 'connected',
                tools: [
                  { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
                ],
              },
            },
          ];
        },
        async getToolServer() {
          return {
            id: 'custom-files',
            name: 'Custom Files',
            description: 'Custom file tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
              ],
            },
          };
        },
      } as any);
      agentTabManager.bindThread({
        agentId: 'agent-tool-error',
        threadId: 'thr_tool_error',
        callerToken: 'agtok_tool_error',
        allowedToolNames: ['custom-files__read_file'],
      });

      await expect(callInterpreterCliTool({
        callerToken: 'agtok_tool_error',
        serverId: 'custom-files',
        toolName: 'read_file',
        args: {},
      })).resolves.toEqual({
        content: [{ type: 'text', text: 'Tool-level failure' }],
        isError: true,
      });

      expect(logLines.some((line) => (
        line.includes('[INTERPRETER_CLI_TOOL] phase=result')
        && line.includes('ok=false')
        && line.includes('tool=read_file')
      ))).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test('logs JSON text error results as failed outcomes', async () => {
    const originalLog = console.log;
    const logLines: string[] = [];
    console.log = (...args: unknown[]) => {
      logLines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    try {
      setToolManager({
        async listAllToolServers() {
          return [
            {
              id: 'custom-files',
              name: 'Custom Files',
              state: {
                status: 'connected',
                tools: [
                  { name: 'read_file', inputSchema: { type: 'object' } },
                ],
              },
            },
          ];
        },
        async getToolServer() {
          return {
            id: 'custom-files',
            name: 'Custom Files',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_file', inputSchema: { type: 'object' } },
              ],
            },
          };
        },
        async callTool() {
          return {
            content: [{ type: 'text', text: JSON.stringify({ is_error: true, message: 'native failed' }) }],
          };
        },
      } as any);
      agentTabManager.bindThread({
        agentId: 'agent-tool-json-error',
        threadId: 'thr_tool_json_error',
        callerToken: 'agtok_tool_json_error',
        allowedToolNames: ['custom-files__read_file'],
      });

      await callInterpreterCliTool({
        callerToken: 'agtok_tool_json_error',
        serverId: 'custom-files',
        toolName: 'read_file',
        args: {},
      });

      expect(logLines.some((line) => (
        line.includes('[INTERPRETER_CLI_TOOL] phase=result')
        && line.includes('ok=false')
        && line.includes('tool=read_file')
      ))).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test('hides and blocks globally disabled tool servers', async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: ['builtin-docx'],
    } as any);

    setToolManager({
      async listAllToolServers() {
        return [
          {
            id: 'builtin-docx',
            name: 'Word Documents',
            description: 'DOCX tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object' } },
              ],
            },
          },
        ];
      },
      async callTool() {
        throw new Error('should not be called');
      },
      async getToolServer() {
        throw new Error('should not be called');
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-disabled',
      threadId: 'thr_disabled',
      callerToken: 'agtok_disabled',
      allowedToolNames: ['builtin-docx__read_word'],
    });

    await expect(listInterpreterCliTools('agtok_disabled')).resolves.toEqual({
      servers: [],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_disabled',
      serverId: 'builtin-docx',
      toolName: 'read_word',
      args: { path: '/tmp/sample.docx' },
    })).rejects.toThrow("Tool server 'builtin-docx' is disabled for this interpreter runtime.");
  });

  test('fails fast when required tool args are missing', async () => {
    setToolManager({
      async callTool() {
        throw new Error('should not be called');
      },
      async listAllToolServers() {
        return [
          {
            id: 'custom-files',
            name: 'Custom Files',
            description: 'Custom file tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'custom-files',
          name: 'Custom Files',
          description: 'Custom file tools',
          state: {
            status: 'connected',
            tools: [
              { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-validate',
      threadId: 'thr_validate',
      callerToken: 'agtok_validate',
      allowedToolNames: ['custom-files__read_file'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_validate',
      serverId: 'custom-files',
      toolName: 'read_file',
      args: { file_path: 'notes.docx' },
    })).rejects.toThrow(
      "Missing required args for 'interpreter-app tools custom-files read_file': path. Run 'interpreter-app tools custom-files read_file --help' for the full schema. Input schema: {\"type\":\"object\",\"required\":[\"path\"]}",
    );
  });

  test('allows CLI tool calls for builtin office tools', async () => {
    setToolManager({
      async callTool(
        serverId: string,
        toolName: string,
        args: Record<string, unknown>,
      ) {
        return { ok: true, serverId, toolName, args };
      },
      async listAllToolServers() {
        return [
          {
            id: 'builtin-cells',
            name: 'Excel Spreadsheets',
            description: 'Spreadsheet tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_spreadsheet', description: 'Read workbook', inputSchema: { type: 'object', required: ['path'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'builtin-cells',
          name: 'Excel Spreadsheets',
          description: 'Spreadsheet tools',
          state: {
            status: 'connected',
            tools: [
              { name: 'read_spreadsheet', description: 'Read workbook', inputSchema: { type: 'object', required: ['path'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-block-cli-office',
      threadId: 'thr_block_cli_office',
      callerToken: 'agtok_block_cli_office',
      allowedToolNames: ['builtin-cells__read_spreadsheet'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_block_cli_office',
      serverId: 'builtin-cells',
      toolName: 'read_spreadsheet',
      args: { path: 'sheet.xlsx' },
    })).resolves.toEqual({
      ok: true,
      serverId: 'builtin-cells',
      toolName: 'read_spreadsheet',
      args: { path: 'sheet.xlsx' },
    });
  });

  test('suggests the closest visible tool on the same server when the tool name is wrong', async () => {
    setToolManager({
      async getToolServer() {
        return {
          id: 'builtin-mcp-management',
          name: 'MCP Management',
          description: 'Manage MCP servers',
          state: {
            status: 'connected',
            tools: [
              { name: 'mcp_list_servers', description: 'List MCP servers', inputSchema: { type: 'object' } },
              { name: 'mcp_add_server', description: 'Add MCP server', inputSchema: { type: 'object' } },
            ],
          },
        };
      },
      async listAllToolServers() {
        return [
          {
            id: 'builtin-mcp-management',
            name: 'MCP Management',
            description: 'Manage MCP servers',
            state: {
              status: 'connected',
              tools: [
                { name: 'mcp_list_servers', description: 'List MCP servers', inputSchema: { type: 'object' } },
                { name: 'mcp_add_server', description: 'Add MCP server', inputSchema: { type: 'object' } },
              ],
            },
          },
        ];
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-mcp-tool-suggest',
      threadId: 'thr_mcp_tool_suggest',
      callerToken: 'agtok_mcp_tool_suggest',
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_mcp_tool_suggest',
      serverId: 'builtin-mcp-management',
      toolName: 'mcp_list_server',
      args: {},
    })).rejects.toThrow(
      "Tool 'mcp_list_server' was not found on server 'builtin-mcp-management'. Did you mean 'mcp_list_servers'? Other similar tools on 'builtin-mcp-management': 'mcp_add_server'. Try: 'interpreter-app tools builtin-mcp-management mcp_list_servers --help'.",
    );
  });

  test('resolves relative file arguments against the bound workspace, not the global workspace', async () => {
    const calls: any[] = [];
    const agentWorkspace = path.join('/tmp', 'agent-workspace');
    const globalWorkspace = path.join('/tmp', 'window-workspace');

    setCurrentWorkspace(globalWorkspace);
    setToolManager({
      async callTool(
        serverId: string,
        toolName: string,
        args: Record<string, unknown>,
      ) {
        calls.push({ serverId, toolName, args });
        return { ok: true };
      },
      async listAllToolServers() {
        return [
          {
            id: 'custom-files',
            name: 'Custom Files',
            description: 'Custom file tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'custom-files',
          name: 'Custom Files',
          description: 'Custom file tools',
          state: {
            status: 'connected',
            tools: [
              { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-scope',
      threadId: 'thr_scope',
      callerToken: 'agtok_scope',
      workspacePath: agentWorkspace,
      allowedToolNames: ['custom-files__read_file'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_scope',
      serverId: 'custom-files',
      toolName: 'read_file',
      args: {
        path: path.join('docs', 'notes.docx'),
      },
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        serverId: 'custom-files',
        toolName: 'read_file',
        args: {
          path: path.join('docs', 'notes.docx'),
        },
      },
    ]);
  });

  test('passes Windows paths through without extra per-agent path scoping', async () => {
    const calls: any[] = [];
    setToolManager({
      async callTool(
        serverId: string,
        toolName: string,
        args: Record<string, unknown>,
      ) {
        calls.push({ serverId, toolName, args });
        return { ok: true };
      },
      async listAllToolServers() {
        return [
          {
            id: 'custom-files',
            name: 'Custom Files',
            description: 'Custom file tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'custom-files',
          name: 'Custom Files',
          description: 'Custom file tools',
          state: {
            status: 'connected',
            tools: [
              { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-win-scope',
      threadId: 'thr_win_scope',
      callerToken: 'agtok_win_scope',
      workspacePath: 'C:\\Repo',
      allowedToolNames: ['custom-files__read_file'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_win_scope',
      serverId: 'custom-files',
      toolName: 'read_file',
      args: {
        path: 'c:\\repo\\docs\\notes.docx',
      },
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        serverId: 'custom-files',
        toolName: 'read_file',
        args: {
          path: 'c:\\repo\\docs\\notes.docx',
        },
      },
    ]);
  });

  test('does not apply extra per-agent path scoping to tool calls', async () => {
    const calls: any[] = [];
    setToolManager({
      async callTool(
        serverId: string,
        toolName: string,
        args: Record<string, unknown>,
      ) {
        calls.push({ serverId, toolName, args });
        return { ok: true };
      },
      async listAllToolServers() {
        return [
          {
            id: 'custom-files',
            name: 'Custom Files',
            description: 'Custom file tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'custom-files',
          name: 'Custom Files',
          description: 'Custom file tools',
          state: {
            status: 'connected',
            tools: [
              { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-3',
      threadId: 'thr_3',
      callerToken: 'agtok_3',
      allowedToolNames: ['custom-files__read_file'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_3',
      serverId: 'custom-files',
      toolName: 'read_file',
      args: { path: '/tmp/out-of-scope/sample.docx' },
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        serverId: 'custom-files',
        toolName: 'read_file',
        args: { path: '/tmp/out-of-scope/sample.docx' },
      },
    ]);
  });

  test('rejects tools that are not explicitly scoped into the caller binding', async () => {
    setToolManager({
      async callTool() {
        throw new Error('should not be called');
      },
      async listAllToolServers() {
        return [
          {
            id: 'builtin-docx',
            name: 'Word Documents',
            description: 'DOCX tools',
            state: {
              status: 'connected',
              tools: [
                { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object', required: ['path'] } },
              ],
            },
          },
        ];
      },
      async getToolServer() {
        return {
          id: 'builtin-docx',
          name: 'Word Documents',
          description: 'DOCX tools',
          state: {
            status: 'connected',
            tools: [
              { name: 'read_word', description: 'Read a DOCX', inputSchema: { type: 'object', required: ['path'] } },
            ],
          },
        };
      },
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-hidden-default',
      threadId: 'thr_hidden_default',
      callerToken: 'agtok_hidden_default',
      allowedToolNames: ['builtin-browser__navigate'],
    });

    await expect(callInterpreterCliTool({
      callerToken: 'agtok_hidden_default',
      serverId: 'builtin-docx',
      toolName: 'read_word',
      args: { path: '/tmp/sample.docx' },
    })).rejects.toThrow("Tool 'builtin-docx__read_word' is not allowed");
  });
});
