import { afterEach, describe, expect, test } from 'bun:test';
import {
  browserPageClickTool,
  setBrowserPageClickProviderForTest,
  setBrowserPageClickRelayEnsureProviderForTest,
} from '../../../server/tools/builtin-tools/workstation/browserPageClickTool';
import { buildBrowserPageTargetIdentity } from '../../../server/tools/builtin-tools/workstation/browserTargetIdentity';
import { setBrowserPermissionReviewPromptProviderForTest } from '../../../server/tools/builtin-tools/workstation/browserPermissionReviewPrompt';
import type { OverlayContextItem, OverlayRegionContextItem } from '../shared/ipc';
import { buildOverlayCurrentSelectionContext } from '../shared/context-packet';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';
import type { OverlayTextControllerDirectCommand } from '../shared/text-controller';
import {
  executeOverlayTextControllerDirectCommand,
  OverlayTextDirectCommandExecutionError,
  type OverlayTextDirectCommandCallTool,
} from './text-controller-direct-command';

function targetRegion(): OverlayRegionContextItem {
  const bounds = { x: 10, y: 20, width: 300, height: 200 };
  const targetIdentity = buildOverlayTargetIdentity({
    kind: 'screen-region',
    bounds,
    display: {
      id: 'display-1',
      boundsDIP: { x: 0, y: 0, width: 1000, height: 800 },
      scaleFactor: 2,
    },
    targetWindowSessionKey: 'window-1',
    generation: 1,
    now: 1000,
  });
  return {
    id: 'target-1',
    kind: 'region',
    role: 'target',
    label: 'Checkout form',
    scopeKind: 'screen-region',
    bounds,
    displayId: 'display-1',
    targetWindowSessionKey: 'window-1',
    targetIdentity,
    snapshot: buildCurrentSelectionContext({
      targetIdentity,
      selectableRefs: [{
        id: 'ui-ref-1',
        role: 'button',
        label: 'Submit',
        bounds: { x: 12, y: 24, width: 80, height: 30 },
      }],
    }),
    previewText: null,
    previewImageDataUrl: null,
  };
}

const referenceFile: OverlayContextItem = {
  id: 'file-1',
  kind: 'file',
  role: 'reference',
  name: 'notes.txt',
  mimeType: 'text/plain',
  sizeBytes: 12,
  filePath: '/tmp/notes.txt',
  sourceKind: 'selected-file',
  sourceLabel: 'Selected file',
};

const selectedText: OverlayContextItem = {
  id: 'selected-text-1',
  kind: 'file',
  role: 'reference',
  name: 'Selected text.txt',
  mimeType: 'text/plain',
  sizeBytes: 24,
  filePath: null,
  dataUrl: `data:text/plain;base64,${Buffer.from('selected text body').toString('base64')}`,
  sourceKind: 'selected-text',
  sourceLabel: 'Selected text',
  sourceBounds: { x: 100, y: 120, width: 140, height: 30 },
  sourceDisplayId: 'display-1',
};

describe('overlay text controller direct command execution', () => {
  afterEach(() => {
    setBrowserPageClickRelayEnsureProviderForTest(null);
    setBrowserPageClickProviderForTest(null);
    setBrowserPermissionReviewPromptProviderForTest(null);
  });

  test('calls the matched tool through the app tool boundary with overlay ownership', async () => {
    const calls: Parameters<OverlayTextDirectCommandCallTool>[] = [];
    const callTool: OverlayTextDirectCommandCallTool = async (...args) => {
      calls.push(args);
      return {
        content: [{ type: 'text', text: '[{"pid":1234,"window_id":55}]' }],
      };
    };

    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'list_windows',
      args: { pid: 1234 },
    };

    const result = await executeOverlayTextControllerDirectCommand(command, {
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'profile-fast',
    }, callTool);
    expect(result.text).toBe('[{"pid":1234,"window_id":55}]');
    expect(result.toolCall).toEqual({
      serverId: 'builtin-cua-driver',
      toolName: 'list_windows',
      args: { pid: 1234 },
      resultText: '[{"pid":1234,"window_id":55}]',
      permissionResultText: null,
    });

    expect(calls).toEqual([
      [
        'builtin-cua-driver',
        'list_windows',
        { pid: 1234 },
        undefined,
        {
          callerTabId: 'overlay-agent-1',
          workspace: '/workspace',
          profileId: 'profile-fast',
        },
        undefined,
      ],
    ]);
  });

  test('reads current selection through the app tool boundary with overlay ownership', async () => {
    const calls: Parameters<OverlayTextDirectCommandCallTool>[] = [];
    const callTool: OverlayTextDirectCommandCallTool = async (...args) => {
      calls.push(args);
      return {
        content: [{ type: 'text', text: 'Current selection\nselected_text=null' }],
      };
    };

    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-selection',
      toolName: 'read_current_selection',
      args: {},
    };

    const result = await executeOverlayTextControllerDirectCommand(command, {
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'profile-fast',
    }, callTool);
    expect(result.text).toBe('Current selection\nselected_text=null');

    expect(calls).toEqual([
      [
        'builtin-selection',
        'read_current_selection',
        {},
        undefined,
        {
          callerTabId: 'overlay-agent-1',
          workspace: '/workspace',
          profileId: 'profile-fast',
        },
        undefined,
      ],
    ]);
  });

  test('reads whole computer state through the app tool boundary with overlay ownership', async () => {
    const calls: Parameters<OverlayTextDirectCommandCallTool>[] = [];
    const callTool: OverlayTextDirectCommandCallTool = async (...args) => {
      calls.push(args);
      return {
        content: [{ type: 'text', text: '{"total_window_count":1,"windows":[]}' }],
      };
    };

    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_whole_computer_state_get',
      args: {},
    };

    const result = await executeOverlayTextControllerDirectCommand(command, {
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'profile-fast',
    }, callTool);
    expect(result.text).toBe('{"total_window_count":1,"windows":[]}');

    expect(calls).toEqual([
      [
        'builtin-interpreter',
        'interpreter_whole_computer_state_get',
        {},
        undefined,
        {
          callerTabId: 'overlay-agent-1',
          workspace: '/workspace',
          profileId: 'profile-fast',
        },
        undefined,
      ],
    ]);
  });

  test('launches visible agents through the hidden builtin with selected overlay context', async () => {
    const calls: Parameters<OverlayTextDirectCommandCallTool>[] = [];
    const callTool: OverlayTextDirectCommandCallTool = async (...args) => {
      calls.push(args);
      return {
        content: [{ type: 'text', text: '{"status":"launch_requested","agent_id":"agent-1"}' }],
      };
    };
    const targetContext = targetRegion();
    const contextItems = [targetContext, referenceFile, selectedText];
    const selectedContext = buildOverlayCurrentSelectionContext(targetContext, contextItems);
    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'launch_agent_window',
      args: {
        initial_message: 'inspect the selected region',
        activate: true,
        completion_disposition: 'keep_open',
      },
    };

    const result = await executeOverlayTextControllerDirectCommand(command, {
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'profile-fast',
      targetWindowSessionKey: 'window-2',
      targetContext,
      contextItems,
      conversationContext: 'recent overlay context',
    }, callTool);
    expect(result.text).toBe('{"status":"launch_requested","agent_id":"agent-1"}');
    expect(result.toolCall.args).toEqual({
      initial_message: 'inspect the selected region',
      activate: true,
      completion_disposition: 'keep_open',
      workspace_path: '/workspace',
      target_window_session_key: 'window-2',
      conversation_context: 'recent overlay context',
      selected_context: selectedContext,
      target_refs: ['target-1', 'overlay-target-1', 'ui-ref-1'],
    });

    expect(calls).toEqual([
      [
        'builtin-agent-windows',
        'launch_agent_window',
        {
          initial_message: 'inspect the selected region',
          activate: true,
          completion_disposition: 'keep_open',
          workspace_path: '/workspace',
          target_window_session_key: 'window-2',
          conversation_context: 'recent overlay context',
          selected_context: selectedContext,
          target_refs: ['target-1', 'overlay-target-1', 'ui-ref-1'],
        },
        undefined,
        {
          callerTabId: 'overlay-agent-1',
          workspace: '/workspace',
          profileId: 'profile-fast',
        },
        { includeHiddenBuiltins: true },
      ],
    ]);
  });

  test('runs agent-window management commands through hidden builtin dispatch', async () => {
    const calls: Parameters<OverlayTextDirectCommandCallTool>[] = [];
    const callTool: OverlayTextDirectCommandCallTool = async (...args) => {
      calls.push(args);
      return {
        content: [{ type: 'text', text: '{"status":"reveal_requested","agent_id":"agent-1"}' }],
      };
    };
    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'reveal_agent_window',
      args: { agent_id: 'agent-1' },
    };

    const result = await executeOverlayTextControllerDirectCommand(command, {
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'profile-fast',
    }, callTool);
    expect(result.text).toBe('{"status":"reveal_requested","agent_id":"agent-1"}');

    expect(calls).toEqual([
      [
        'builtin-agent-windows',
        'reveal_agent_window',
        { agent_id: 'agent-1' },
        undefined,
        {
          callerTabId: 'overlay-agent-1',
          workspace: '/workspace',
          profileId: 'profile-fast',
        },
        { includeHiddenBuiltins: true },
      ],
    ]);
  });

  test('maps close-app direct commands to exact close_window calls', async () => {
    const calls: Parameters<OverlayTextDirectCommandCallTool>[] = [];
    const callTool: OverlayTextDirectCommandCallTool = async (...args) => {
      calls.push(args);
      const [, toolName] = args;
      if (toolName === 'list_windows') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify([{
              app_name: 'Google Chrome',
              pid: 123,
              window_id: 456,
              is_on_screen: true,
              on_current_space: true,
              z_index: 10,
              target_identity: {
                kind: 'app-window',
                app: { name: 'Google Chrome', pid: 123 },
                window: { native_window_id: 456, title: 'Chrome' },
              },
            }]),
          }],
        };
      }
      return {
        content: [{ type: 'text', text: '{"status":"closed"}' }],
      };
    };
    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'close_window',
      args: {
        app: 'Chrome',
      },
    };

    const result = await executeOverlayTextControllerDirectCommand(command, {
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'profile-fast',
    }, callTool);
    expect(result.text).toBe('{"status":"closed"}');
    expect(result.toolCall.args).toEqual({
      target_identity: {
        kind: 'app-window',
        app: { name: 'Google Chrome', pid: 123 },
        window: { native_window_id: 456, title: 'Chrome' },
      },
    });

    expect(calls).toEqual([
      [
        'builtin-cua-driver',
        'list_windows',
        {},
        undefined,
        {
          callerTabId: 'overlay-agent-1',
          workspace: '/workspace',
          profileId: 'profile-fast',
        },
        undefined,
      ],
      [
        'builtin-cua-driver',
        'close_window',
        {
          target_identity: {
            kind: 'app-window',
            app: { name: 'Google Chrome', pid: 123 },
            window: { native_window_id: 456, title: 'Chrome' },
          },
        },
        undefined,
        {
          callerTabId: 'overlay-agent-1',
          workspace: '/workspace',
          profileId: 'profile-fast',
        },
        undefined,
      ],
    ]);
  });

  test('sends agent-window messages with workspace scope through hidden builtin dispatch', async () => {
    const calls: Parameters<OverlayTextDirectCommandCallTool>[] = [];
    const callTool: OverlayTextDirectCommandCallTool = async (...args) => {
      calls.push(args);
      return {
        content: [{ type: 'text', text: '{"status":"send_requested","agent_id":"agent-1"}' }],
      };
    };
    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'send_agent_window_message',
      args: {
        agent_id: 'agent-1',
        message: 'continue the task',
      },
    };

    const result = await executeOverlayTextControllerDirectCommand(command, {
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'profile-fast',
    }, callTool);
    expect(result.text).toBe('{"status":"send_requested","agent_id":"agent-1"}');
    expect(result.toolCall.args).toEqual({
      agent_id: 'agent-1',
      message: 'continue the task',
      workspace_path: '/workspace',
    });

    expect(calls).toEqual([
      [
        'builtin-agent-windows',
        'send_agent_window_message',
        {
          agent_id: 'agent-1',
          message: 'continue the task',
          workspace_path: '/workspace',
        },
        undefined,
        {
          callerTabId: 'overlay-agent-1',
          workspace: '/workspace',
          profileId: 'profile-fast',
        },
        { includeHiddenBuiltins: true },
      ],
    ]);
  });

  test('calls hidden agents through hidden builtin dispatch with selected overlay context', async () => {
    const calls: Parameters<OverlayTextDirectCommandCallTool>[] = [];
    const callTool: OverlayTextDirectCommandCallTool = async (...args) => {
      calls.push(args);
      return {
        content: [{ type: 'text', text: '{"success":true,"agent_id":"hidden-agent-1"}' }],
      };
    };
    const targetContext = targetRegion();
    const contextItems = [targetContext, referenceFile, selectedText];
    const selectedContext = buildOverlayCurrentSelectionContext(targetContext, contextItems);
    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-interpreter-overlay',
      toolName: 'call_hidden_agent',
      args: {
        message: 'inspect selected context',
      },
    };

    const result = await executeOverlayTextControllerDirectCommand(command, {
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'profile-hidden',
      modelConfig: {
        provider: 'hosted',
        modelId: 'interpreter-fast',
        profileId: 'profile-hidden',
      },
      targetContext,
      contextItems,
      conversationContext: 'recent overlay context',
    }, callTool);
    expect(result.text).toBe('{"success":true,"agent_id":"hidden-agent-1"}');
    expect(result.toolCall.args).toEqual({
      message: 'inspect selected context',
      conversation_context: 'recent overlay context',
      selected_context: selectedContext,
      target_refs: ['target-1', 'overlay-target-1', 'ui-ref-1'],
    });

    expect(calls).toEqual([
      [
        'builtin-interpreter-overlay',
        'call_hidden_agent',
        {
          message: 'inspect selected context',
          conversation_context: 'recent overlay context',
          selected_context: selectedContext,
          target_refs: ['target-1', 'overlay-target-1', 'ui-ref-1'],
        },
        undefined,
        {
          callerTabId: 'overlay-agent-1',
          workspace: '/workspace',
          profileId: 'profile-hidden',
          modelConfig: {
            provider: 'hosted',
            modelId: 'interpreter-fast',
            profileId: 'profile-hidden',
          },
        },
        { includeHiddenBuiltins: true },
      ],
    ]);
  });

  test('calls hidden agents with targetless selected text context when no target is attached', async () => {
    const calls: Parameters<OverlayTextDirectCommandCallTool>[] = [];
    const callTool: OverlayTextDirectCommandCallTool = async (...args) => {
      calls.push(args);
      return {
        content: [{ type: 'text', text: '{"success":true,"agent_id":"hidden-agent-1"}' }],
      };
    };
    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-interpreter-overlay',
      toolName: 'call_hidden_agent',
      args: {
        message: 'summarize selected text',
      },
    };

    const result = await executeOverlayTextControllerDirectCommand(command, {
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'profile-hidden',
      modelConfig: {
        provider: 'hosted',
        modelId: 'interpreter-fast',
        profileId: 'profile-hidden',
      },
      contextItems: [selectedText],
      conversationContext: 'recent overlay context',
    }, callTool);

    expect(result.toolCall.args).toEqual({
      message: 'summarize selected text',
      conversation_context: 'recent overlay context',
      selected_context: {
        kind: 'targetless-selection',
        targetIdentityId: null,
        contextItemIds: ['selected-text-1'],
        selectedFileRefs: [],
        selectedTextRefs: [{
          id: 'selected-text-1',
          sourceLabel: 'Selected text',
          sourceBounds: { x: 100, y: 120, width: 140, height: 30 },
          sourceDisplayId: 'display-1',
          textPreview: 'selected text body',
        }],
      },
    });
    expect(calls[0]?.[2]).toEqual(result.toolCall.args);
  });

  test('queues browser permission review cards through the overlay text-controller tool path', async () => {
    const prompts: Array<{
      toolName: string;
      tabRef: string;
      attemptedAction: string;
      contextAgentId?: string;
      contextToolCallId?: string;
    }> = [];
    setBrowserPageClickRelayEnsureProviderForTest(async () => {});
    setBrowserPageClickProviderForTest(async () => {
      throw new Error(
        'Interpreter browser settings blocked this request. Cannot use "https://shop.example.test/checkout" because it does not match the allowed page rules.',
      );
    });
    setBrowserPermissionReviewPromptProviderForTest(async (input) => {
      prompts.push({
        toolName: input.toolName,
        tabRef: input.tabRef,
        attemptedAction: input.attemptedAction,
        contextAgentId: input.context?.agentId,
        contextToolCallId: input.context?.toolCallId,
      });
      return { approved: false };
    });

    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_browser_page_click',
      args: {
        target_identity: buildBrowserPageTargetIdentity({
          tabRef: 'install:work:chrome-tab:91',
          chromeTabId: 91,
          browserWindowId: 9,
          browserProfilePolicyId: 'install:work',
          origin: 'https://shop.example.test',
          frameId: 0,
          chromeDocumentId: 'doc-work',
          documentRevision: 'rev-1',
          url: 'https://shop.example.test/checkout',
        }),
        ref_id: 'browser-element:rev-1:0',
      },
    };

    const callTool: OverlayTextDirectCommandCallTool = async (
      serverId,
      toolName,
      args,
      _saveToDisk,
      toolContext,
    ) => {
      expect(serverId).toBe('builtin-interpreter');
      expect(toolName).toBe('interpreter_browser_page_click');
      return browserPageClickTool.handler(args, {
        agentId: toolContext.callerTabId,
        toolCallId: 'overlay-tool-call-1',
      });
    };

    await expect(executeOverlayTextControllerDirectCommand(command, {
      agentId: 'overlay-agent-1',
      workspacePath: '/workspace',
      profileId: 'profile-fast',
    }, callTool)).rejects.toThrow('Failed to click browser page element: Interpreter browser settings blocked this request.');

    expect(prompts).toEqual([{
      toolName: 'interpreter_browser_page_click',
      tabRef: 'install:work:chrome-tab:91',
      attemptedAction: 'Click ref browser-element:rev-1:0 in frame 0.',
      contextAgentId: 'overlay-agent-1',
      contextToolCallId: 'overlay-tool-call-1',
    }]);
  });

  test('fails loudly when the tool returns an error result', async () => {
    const command: OverlayTextControllerDirectCommand = {
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'set_window_bounds',
      args: {
        target_identity: {
          kind: 'app-window',
          app: { pid: 1234 },
          window: { native_window_id: 55 },
        },
        x: 10,
        y: 20,
        width: 800,
        height: 600,
      },
    };

    try {
      await executeOverlayTextControllerDirectCommand(command, {
        agentId: 'overlay-agent-1',
        workspacePath: null,
        profileId: 'profile-fast',
      }, async () => ({
        content: [{ type: 'text', text: 'User denied native desktop driver control access.' }],
        isError: true,
      }));
      throw new Error('expected command failure');
    } catch (error) {
      expect(error).toBeInstanceOf(OverlayTextDirectCommandExecutionError);
      expect((error as OverlayTextDirectCommandExecutionError).message).toBe('User denied native desktop driver control access.');
      expect((error as OverlayTextDirectCommandExecutionError).toolCall).toEqual({
        serverId: 'builtin-cua-driver',
        toolName: 'set_window_bounds',
        args: command.args,
        resultText: 'User denied native desktop driver control access.',
        permissionResultText: 'User denied native desktop driver control access.',
      });
    }
  });
});
