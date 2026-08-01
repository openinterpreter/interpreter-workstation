// NOTE(victor): Keep mcp route tests from mock.module()'ing shared runtime
// modules. Bun module mocks are process-global across test files.
import { getGlobalDisabledTools } from '../configStore';
import type { resolveAndExecuteCodexTool as resolveAndExecuteCodexToolType } from '../utils/codexMcpBridge';

export { getGlobalDisabledTools };

type ResolveAndExecuteCodexTool = typeof resolveAndExecuteCodexToolType;

export const resolveAndExecuteCodexTool: ResolveAndExecuteCodexTool = async (...args) => {
  const bridge = await import('../utils/codexMcpBridge');
  return bridge.resolveAndExecuteCodexTool(...args);
};
