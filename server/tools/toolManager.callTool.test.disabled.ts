import { describe, test, expect } from 'bun:test';
import { getBuiltinToolHandler } from './builtinTools';

// ---------------------------------------------------------------------------
// Integration: verify that real builtin tool definitions are correctly
// processed by enforceFilesystemBoundary when called through callTool.
//
// These tests exercise the guard with real tool definitions (not mocks)
// to catch mismatches between declared fileAccess metadata and the guard logic.
// They call enforceFilesystemBoundary directly (not callTool) to avoid needing
// full ToolManager setup, but use real tool definitions from the registry.
// ---------------------------------------------------------------------------

import { enforceFilesystemBoundary } from './filesystemBoundary';

const WORKSPACE = process.platform === 'win32'
  ? 'C:\\Users\\test\\project'
  : '/Users/test/project';

function makeMockApproval(approved: boolean) {
  const calls: any[] = [];
  return {
    calls,
    fn: async (args: any) => {
      calls.push(args);
      return { approved };
    },
  };
}

describe('callTool filesystem boundary with real tool definitions', () => {
  test('should_request_approval_for_builtin_pdf_create_pdf_outside_workspace', async () => {
    const tool = getBuiltinToolHandler('builtin-pdf', 'create_pdf');
    expect(tool).toBeDefined();
    expect(tool!.fileAccess?.mode).toBe('write');

    const mock = makeMockApproval(false);
    const result = await enforceFilesystemBoundary(
      {
        builtinTool: tool!,
        args: { path: '/Users/test/Documents/My Workspace/fast.pdf', content: '<html>test</html>' },
        workspace: WORKSPACE,
        serverId: 'builtin-pdf',
      },
      { requestFilesystemApproval: mock.fn },
    );

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(false);
    expect(result!.content[0].text).toContain('denied');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].category).toBe('fs_guard:write_outside');
    expect(mock.calls[0].paths).toContain('/Users/test/Documents/My Workspace/fast.pdf');
  });

  test('should_allow_builtin_pdf_create_pdf_targeting_path_inside_workspace', async () => {
    const tool = getBuiltinToolHandler('builtin-pdf', 'create_pdf');
    expect(tool).toBeDefined();

    const mock = makeMockApproval(true);

    const result = await enforceFilesystemBoundary(
      {
        builtinTool: tool!,
        args: { path: `${WORKSPACE}/output.pdf`, content: '<html>test</html>' },
        workspace: WORKSPACE,
        serverId: 'builtin-pdf',
      },
      { requestFilesystemApproval: mock.fn },
    );

    expect(result).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });

  test('should_request_approval_for_builtin_filesystem_write_file_content_outside_workspace', async () => {
    const tool = getBuiltinToolHandler('builtin-filesystem', 'write_file_content');
    expect(tool).toBeDefined();
    expect(tool!.fileAccess?.mode).toBe('write');

    const mock = makeMockApproval(false);
    const result = await enforceFilesystemBoundary(
      {
        builtinTool: tool!,
        args: { path: '/tmp/malicious.txt', content: 'pwned' },
        workspace: WORKSPACE,
        serverId: 'builtin-filesystem',
      },
      { requestFilesystemApproval: mock.fn },
    );

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(false);
    expect(mock.calls[0].category).toBe('fs_guard:write_outside');
  });

  test('should_request_approval_for_builtin_filesystem_copy_file_with_destination_outside_workspace', async () => {
    const tool = getBuiltinToolHandler('builtin-filesystem', 'copy_file');
    expect(tool).toBeDefined();
    expect(tool!.fileAccess?.mode).toBe('write');
    expect(tool!.fileAccess?.pathArgModes).toBeDefined();

    const mock = makeMockApproval(false);
    const result = await enforceFilesystemBoundary(
      {
        builtinTool: tool!,
        args: {
          source: `${WORKSPACE}/file.txt`,
          destination: '/tmp/stolen.txt',
        },
        workspace: WORKSPACE,
        serverId: 'builtin-filesystem',
      },
      { requestFilesystemApproval: mock.fn },
    );

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(false);
    expect(mock.calls[0].category).toBe('fs_guard:write_outside');
    expect(mock.calls[0].paths).toContain('/tmp/stolen.txt');
  });
});
