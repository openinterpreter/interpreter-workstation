import * as path from 'path';
import { describe, expect, test } from 'bun:test';
import { enforceFilesystemBoundary } from './filesystemBoundary';
import type { BuiltinToolDefinition } from './builtinTools';

const WORKSPACE = process.platform === 'win32'
  ? 'C:\\Users\\test\\project'
  : '/Users/test/project';

function workspacePath(...segments: string[]): string {
  return path.join(WORKSPACE, ...segments);
}

function makeWriteTool(
  pathArg: string | string[] = 'path',
  pathArgModes?: Record<string, 'read' | 'write'>,
): BuiltinToolDefinition {
  return {
    name: 'create_pdf',
    description: 'test',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    fileAccess: { mode: 'write', pathArg, ...(pathArgModes ? { pathArgModes } : {}) },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };
}

function makeReadTool(): BuiltinToolDefinition {
  return {
    name: 'read_pdf',
    description: 'test',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    fileAccess: { mode: 'read', pathArg: 'path' },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };
}

function makeNoFileAccessTool(): BuiltinToolDefinition {
  return {
    name: 'ask_user' as any,
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };
}

function makeBoundaryDeps(options?: {
  deniedReadPaths?: string[];
  deniedWritePaths?: string[];
  deniedByUserPaths?: string[];
  denialMessage?: string;
}) {
  const readPermissionCalls: Array<{
    agentId: string;
    filePath: string;
    mode: 'read' | 'write';
    workspace: string | null;
  }> = [];
  const writePermissionCalls: Array<{
    agentId: string;
    filePath: string;
    workspace: string | null;
    toolCallId?: string;
  }> = [];
  const deniedReadPaths = new Set(options?.deniedReadPaths ?? []);
  const deniedWritePaths = new Set(options?.deniedWritePaths ?? []);
  const deniedByUserPaths = new Set(options?.deniedByUserPaths ?? []);

  return {
    readPermissionCalls,
    writePermissionCalls,
    deps: {
      authorizeFileWriteAccess: async ({
        agentId,
        filePath,
        workspace,
        toolCallId,
      }: {
        agentId: string;
        filePath: string;
        workspace: string | null;
        toolCallId?: string;
      }) => {
        writePermissionCalls.push({ agentId, filePath, workspace, toolCallId });
        if (deniedByUserPaths.has(filePath)) {
          return { allowed: false, deniedByUser: true };
        }
        if (deniedWritePaths.has(filePath)) {
          return {
            allowed: false,
            message: options?.denialMessage ?? `Permission denied: ${filePath}`,
          };
        }
        return { allowed: true };
      },
      checkFileAccessPermissionAsync: async (
        agentId: string,
        filePath: string,
        mode: 'read' | 'write',
        workspace?: string | null,
      ) => {
        readPermissionCalls.push({
          agentId,
          filePath,
          mode,
          workspace: workspace ?? null,
        });
        return !deniedReadPaths.has(filePath);
      },
      getFileAccessDeniedMessage: (_agentId: string, filePath: string) =>
        options?.denialMessage ?? `Permission denied: ${filePath}`,
    },
  };
}

describe('enforceFilesystemBoundary pass-through', () => {
  test('returns null when tool has no file access declaration', async () => {
    const result = await enforceFilesystemBoundary({
      builtinTool: makeNoFileAccessTool(),
      args: {},
      workspace: WORKSPACE,
      serverId: 'builtin-utility',
    });
    expect(result).toBeNull();
  });

  test('returns null when workspace is null', async () => {
    const result = await enforceFilesystemBoundary({
      builtinTool: makeWriteTool(),
      args: { path: '/tmp/outside.pdf' },
      workspace: null,
      serverId: 'builtin-pdf',
    });
    expect(result).toBeNull();
  });

  test('returns null when write access is authorized', async () => {
    const mock = makeBoundaryDeps();
    const result = await enforceFilesystemBoundary({
      builtinTool: makeWriteTool(),
      args: { path: workspacePath('output.pdf') },
      workspace: WORKSPACE,
      serverId: 'builtin-pdf',
      toolCallId: 'tc-write-ok',
      agentId: 'agent-1',
    }, mock.deps);
    expect(result).toBeNull();
    expect(mock.writePermissionCalls).toEqual([
      {
        agentId: 'agent-1',
        filePath: workspacePath('output.pdf'),
        workspace: WORKSPACE,
        toolCallId: 'tc-write-ok',
      },
    ]);
  });

  test('skips non-string path arguments', async () => {
    const result = await enforceFilesystemBoundary({
      builtinTool: makeWriteTool(),
      args: { path: 42 },
      workspace: WORKSPACE,
      serverId: 'builtin-pdf',
    });
    expect(result).toBeNull();
  });
});

describe('enforceFilesystemBoundary write handling', () => {
  test('returns a settings denial when write access is blocked', async () => {
    const blockedPath = workspacePath('readonly.txt');
    const mock = makeBoundaryDeps({ deniedWritePaths: [blockedPath] });
    const result = await enforceFilesystemBoundary(
      {
        builtinTool: makeWriteTool(),
        args: { path: blockedPath },
        workspace: WORKSPACE,
        serverId: 'builtin-docx',
      },
      mock.deps,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain(blockedPath);
  });

  test('returns a user denial when write approval is rejected', async () => {
    const blockedPath = workspacePath('needs-approval.txt');
    const mock = makeBoundaryDeps({ deniedByUserPaths: [blockedPath] });
    const result = await enforceFilesystemBoundary(
      {
        builtinTool: makeWriteTool(),
        args: { path: blockedPath },
        workspace: WORKSPACE,
        serverId: 'builtin-docx',
      },
      mock.deps,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(false);
    expect(result!.content[0].text).toContain('denied');
  });

  test('handles mixed read/write path arguments independently', async () => {
    const deniedReadPath = '/Users/test/Documents/input.txt';
    const tool = makeWriteTool(['source', 'destination'], {
      source: 'read',
      destination: 'write',
    });
    const mock = makeBoundaryDeps({ deniedReadPaths: [deniedReadPath] });
    const result = await enforceFilesystemBoundary(
      {
        builtinTool: tool,
        args: {
          source: deniedReadPath,
          destination: workspacePath('output.txt'),
        },
        workspace: WORKSPACE,
        serverId: 'builtin-docx',
      },
      mock.deps,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(mock.readPermissionCalls.map((call) => call.filePath)).toContain(deniedReadPath);
    expect(mock.writePermissionCalls).toHaveLength(0);
  });
});

describe('enforceFilesystemBoundary read handling', () => {
  test('allows reads outside workspace when the global settings allow them', async () => {
    const outsidePath = '/Users/test/Documents/secret.pdf';
    const mock = makeBoundaryDeps();
    const result = await enforceFilesystemBoundary(
      {
        builtinTool: makeReadTool(),
        args: { path: outsidePath },
        workspace: WORKSPACE,
        serverId: 'builtin-pdf',
        agentId: 'agent-1',
      },
      mock.deps,
    );
    expect(result).toBeNull();
    expect(mock.readPermissionCalls).toEqual([
      {
        agentId: 'agent-1',
        filePath: outsidePath,
        mode: 'read',
        workspace: WORKSPACE,
      },
    ]);
  });

  test('returns a denial when read access is blocked', async () => {
    const deniedPath = '/Users/test/Documents/secret.pdf';
    const mock = makeBoundaryDeps({ deniedReadPaths: [deniedPath] });
    const result = await enforceFilesystemBoundary(
      {
        builtinTool: makeReadTool(),
        args: { path: deniedPath },
        workspace: WORKSPACE,
        serverId: 'builtin-pdf',
      },
      mock.deps,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain(deniedPath);
  });

  test('treats the agent-specific file permission result as narrower than global reach', async () => {
    const deniedPath = '/Users/test/Documents/agent-denied.pdf';
    const mock = makeBoundaryDeps({
      deniedReadPaths: [deniedPath],
      denialMessage: 'Permission denied by agent file scope',
    });
    const result = await enforceFilesystemBoundary(
      {
        builtinTool: makeReadTool(),
        args: { path: deniedPath },
        workspace: WORKSPACE,
        serverId: 'builtin-pdf',
        agentId: 'agent-narrow',
      },
      mock.deps,
    );

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toBe('Permission denied by agent file scope');
    expect(mock.readPermissionCalls).toEqual([
      {
        agentId: 'agent-narrow',
        filePath: deniedPath,
        mode: 'read',
        workspace: WORKSPACE,
      },
    ]);
    expect(mock.writePermissionCalls).toHaveLength(0);
  });

  test('enforces array-valued read path arguments', async () => {
    const tool = makeReadTool();
    tool.fileAccess = { mode: 'read', pathArg: 'attachments' };
    const deniedPath = '/tmp/secret.txt';
    const mock = makeBoundaryDeps({ deniedReadPaths: [deniedPath] });
    const result = await enforceFilesystemBoundary(
      {
        builtinTool: tool,
        args: { attachments: [workspacePath('ok.txt'), deniedPath] },
        workspace: WORKSPACE,
        serverId: 'builtin-nylas',
      },
      mock.deps,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(mock.readPermissionCalls.map((call) => call.filePath)).toContain(deniedPath);
  });
});
