import { beforeEach, describe, expect, test } from 'bun:test';

import type { AgentModelConfig } from '../../../../shared/types/model';
import {
  AGENT_WINDOW_TOOL_NAMES,
  AGENT_WINDOW_TOOL_SERVER_ID,
  CUA_DRIVER_TOOL_SERVER_ID,
  HIDDEN_AGENT_OVERLAY_TOOL_NAMES,
  INTERPRETER_TOOL_SERVER_ID,
  INTERPRETER_OVERLAY_TOOL_SERVER_ID,
  OVERLAY_CUA_TOOL_NAMES,
  OVERLAY_INTERPRETER_TOOL_NAMES,
  OVERLAY_SELECTION_TOOL_NAMES,
  SELECTION_TOOL_SERVER_ID,
} from '../../../../shared/types/overlayToolCatalog';
import { prefixToolName } from '../../../../shared/utils/mcpToolName';
import { approvalManager } from '../../../approvalManager';
import { agentTabManager } from '../../../agentTabManager';
import {
  createCallHiddenAgentTool,
  overlayHiddenAgentAllowedToolNamesForTest,
  type CallHiddenAgentToolDeps,
} from './hiddenAgentTool';

const modelConfig: AgentModelConfig = {
  provider: 'hosted',
  modelId: 'interpreter-fast',
  profileId: 'interpreter',
};

describe('callHiddenAgentTool', () => {
  beforeEach(() => {
    agentTabManager.clearAll();
    approvalManager.setAutoApprove(false);
    approvalManager.clearAll();
  });

  test('builds hidden-agent allowed tools from the shared overlay catalog names', () => {
    const allowedToolNames = overlayHiddenAgentAllowedToolNamesForTest();

    for (const toolName of HIDDEN_AGENT_OVERLAY_TOOL_NAMES) {
      expect(allowedToolNames).toContain(prefixToolName(INTERPRETER_OVERLAY_TOOL_SERVER_ID, toolName));
    }
    for (const toolName of AGENT_WINDOW_TOOL_NAMES) {
      expect(allowedToolNames).toContain(prefixToolName(AGENT_WINDOW_TOOL_SERVER_ID, toolName));
    }
    for (const toolName of OVERLAY_CUA_TOOL_NAMES) {
      expect(allowedToolNames).toContain(prefixToolName(CUA_DRIVER_TOOL_SERVER_ID, toolName));
    }
    for (const toolName of OVERLAY_SELECTION_TOOL_NAMES) {
      expect(allowedToolNames).toContain(prefixToolName(SELECTION_TOOL_SERVER_ID, toolName));
    }
    for (const toolName of OVERLAY_INTERPRETER_TOOL_NAMES) {
      expect(allowedToolNames).toContain(prefixToolName(INTERPRETER_TOOL_SERVER_ID, toolName));
    }
    expect(allowedToolNames).not.toContain(prefixToolName(INTERPRETER_OVERLAY_TOOL_SERVER_ID, 'call_hidden_agent'));
  });

  test('runs a hidden agent with the overlay tool scope and returns compact metadata', async () => {
    const calls: Record<string, any[]> = {
      createSession: [],
      runSubagent: [],
      closeSession: [],
      attachToOverlaySession: [],
      releaseOverlaySession: [],
    };
    const session = {
      service: {} as any,
      profile: {} as any,
      agentId: 'hidden-agent-1',
      callerToken: 'agtok_hidden_secret',
      allowedToolNames: ['will-be-replaced'],
      modelConfig,
      dispose: () => {},
    };
    const deps: CallHiddenAgentToolDeps = {
      createSession: async (options) => {
        calls.createSession.push(options);
        return session;
      },
      runSubagent: async (options) => {
        calls.runSubagent.push(options);
        return {
          agentId: 'hidden-agent-1',
          threadId: 'thread-hidden',
          completed: true,
          messages: [
            {
              role: 'assistant',
              parts: [{ type: 'text', text: 'Done from the hidden agent.' }],
            },
          ],
        };
      },
      closeSession: (closedSession) => {
        calls.closeSession.push(closedSession);
      },
      getOverlaySessionSnapshot: () => ({
        id: 'overlay-session-1',
        agentId: 'overlay-agent-1',
        callerToken: 'agtok_overlay_secret',
        workspacePath: '/workspace',
        windowSessionKey: 'window-1',
        displayId: 'display-1',
        scopeBoundsDIP: null,
        createdAt: 1,
        updatedAt: 1,
        status: 'active',
        initialElementCount: 0,
        latestElementCount: 0,
        initialCaptureBoundsDIP: null,
        latestCaptureBoundsDIP: null,
        hasInitialScreenshot: false,
        hasLatestScreenshot: false,
        initialScreenshotPath: null,
        latestScreenshotPath: null,
      }),
      attachToOverlaySession: (sourceAgentId, delegatedAgentId) => {
        calls.attachToOverlaySession.push({ sourceAgentId, delegatedAgentId });
      },
      releaseOverlaySession: (delegatedAgentId) => {
        calls.releaseOverlaySession.push(delegatedAgentId);
      },
      getAgentBindingForAgentId: (agentId) => agentTabManager.getBindingForAgentId(agentId),
    };
    const tool = createCallHiddenAgentTool(deps);
    agentTabManager.bindThread({
      agentId: 'overlay-agent-1',
      callerToken: 'agtok_overlay_secret',
      threadId: 'thread-overlay-parent',
      windowSessionKey: 'window-1',
      workspacePath: '/workspace',
      toolProfileId: 'interpreter',
    });

    const result = await tool.handler(
      {
        message: 'Use the selected refs and summarize the fields.',
        conversation_context: 'User asked about the selected insurance form.',
        selected_context: {
          selected_context_snapshot_id: 'selected-context-1',
          target_identity_id: 'overlay-target-1',
        },
        target_refs: ['field-1', 'submit-1'],
        system: 'Be brief.',
        timeout_ms: 5000,
      },
      {
        agentId: 'overlay-agent-1',
        threadId: 'thread-overlay-context',
        modelConfig,
        workspace: '/workspace',
      },
    );
    const text = result.content[0]?.text ?? '';
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload).toEqual({
      success: true,
      agent_id: 'hidden-agent-1',
      thread_id: 'thread-hidden',
      completed: true,
      message_count: 1,
      assistant_text: 'Done from the hidden agent.',
      error: null,
    });
    expect(calls.runSubagent[0].message).toContain('Hidden agent handoff context:');
    expect(calls.runSubagent[0].message).toContain('"conversation_context": "User asked about the selected insurance form."');
    expect(calls.runSubagent[0].message).toContain('"selected_context_snapshot_id": "selected-context-1"');
    expect(calls.runSubagent[0].message).toContain('"target_refs":');
    expect(calls.runSubagent[0].message).toContain('Task:\nUse the selected refs and summarize the fields.');
    expect(calls.runSubagent[0].message).not.toContain('agtok_hidden_secret');
    expect(calls.runSubagent[0].message).not.toContain('agtok_overlay_secret');
    expect(text).not.toContain('agtok_hidden_secret');
    expect(text).not.toContain('agtok_overlay_secret');
    expect(calls.createSession[0].parentOwner).toEqual({
      approvalOwnerKind: 'overlay-agent',
      agentId: 'overlay-agent-1',
      threadId: 'thread-overlay-context',
      windowSessionKey: 'window-1',
      workspacePath: '/workspace',
      toolProfileId: 'interpreter',
    });
    expect(calls.createSession[0].allowedToolNames).toContain('builtin-interpreter-overlay__computer_batch');
    expect(calls.createSession[0].allowedToolNames).toContain('builtin-agent-windows__launch_agent_window');
    expect(calls.createSession[0].allowedToolNames).toContain('builtin-cua-driver__set_window_bounds');
    expect(calls.createSession[0].allowedToolNames).toContain('builtin-interpreter__interpreter_browser_page_inspect');
    expect(calls.createSession[0].allowedToolNames).toContain('builtin-interpreter__interpreter_browser_page_click');
    expect(calls.runSubagent[0]).toMatchObject({
      modelConfig,
      timeoutMs: 5000,
      workspace: '/workspace',
      session,
      parentOwner: calls.createSession[0].parentOwner,
    });
    expect(calls.runSubagent[0].system).toContain('You are a hidden Interpreter delegate called by the overlay controller.');
    expect(calls.runSubagent[0].system).toContain('builtin-interpreter-overlay__overlay_read_context');
    expect(calls.runSubagent[0].system).toContain('The same live overlay session is attached to you.');
    expect(calls.runSubagent[0].system).toContain('Treat element_id values as snapshot-scoped.');
    expect(calls.runSubagent[0].system).toContain('Be brief.');
    expect(calls.runSubagent[0].system).not.toContain('agtok_hidden_secret');
    expect(calls.runSubagent[0].system).not.toContain('agtok_overlay_secret');
    expect(calls.runSubagent[0].allowedToolNames).toEqual(calls.createSession[0].allowedToolNames);
    expect(approvalManager.getApprovals()).toEqual([]);
    expect(calls.attachToOverlaySession).toEqual([
      { sourceAgentId: 'overlay-agent-1', delegatedAgentId: 'hidden-agent-1' },
    ]);
    expect(calls.releaseOverlaySession).toEqual(['hidden-agent-1']);
    expect(calls.closeSession).toEqual([session]);
  });

  test('fails loudly without an overlay agent context', async () => {
    const tool = createCallHiddenAgentTool({
      createSession: async () => {
        throw new Error('should not create');
      },
      runSubagent: async () => {
        throw new Error('should not run');
      },
      closeSession: () => {},
      getOverlaySessionSnapshot: () => null,
      attachToOverlaySession: () => {},
      releaseOverlaySession: () => {},
      getAgentBindingForAgentId: () => undefined,
    });

    const result = await tool.handler({ message: 'delegate' }, { modelConfig });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('call_hidden_agent requires an overlay agent context.');
  });
});
