import { describe, expect, test } from 'bun:test';
import type { OverlayContextItem, OverlayRegionContextItem } from './ipc';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from './target-identity';
import {
  buildOverlayBrowserControlStateFromStatus,
  buildOverlayTextControllerContextPrompt,
  buildOverlayWholeComputerStateText,
  buildOverlayWorkingPreferencesText,
  buildOverlayTextControllerTargetScopeKey,
  buildOverlayTextControllerRequest,
  getTargetContextItem,
  isExecutableOverlayTextControllerDirectCommand,
  matchOverlayTextControllerDirectCommand,
  mergeOverlayContextItems,
  recordOverlayTextControllerDirectCommandResult,
  recordOverlayTextControllerAgentFailureResult,
  recordOverlayTextControllerAgentLaunchResult,
  reusableOverlayTextControllerManagedContext,
} from './text-controller';

const targetRegion = (id: string, label: string): OverlayRegionContextItem => ({
  ...(() => {
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
      id,
      kind: 'region' as const,
      role: 'target' as const,
      label,
      scopeKind: 'screen-region' as const,
      bounds,
      displayId: 'display-1',
      targetWindowSessionKey: 'window-1',
      targetIdentity,
      snapshot: buildCurrentSelectionContext({ targetIdentity }),
      previewText: null,
      previewImageDataUrl: null,
    };
  })(),
});

const referenceFile: OverlayContextItem = {
  id: 'file-1',
  kind: 'file',
  role: 'reference',
  name: 'notes.txt',
  mimeType: 'text/plain',
  sizeBytes: 12,
  filePath: '/tmp/notes.txt',
};

const targetScopeKey = (targetId = 'target-1', contextScope = targetId) => (
  `/workspace|window-2|${targetId}|selected-context-1|${contextScope}|overlay-target-1|1|no-native-window|window-1|display-1|10,20,300,200`
);

describe('overlay text controller request', () => {
  test('merges submitted and service context with service state winning by id', () => {
    const staleSubmittedTarget = targetRegion('target-1', 'Old target');
    const currentServiceTarget = targetRegion('target-1', 'Current target');

    expect(mergeOverlayContextItems(
      [currentServiceTarget],
      [staleSubmittedTarget, referenceFile],
    )).toEqual([
      currentServiceTarget,
      referenceFile,
    ]);
  });

  test('finds the selected target context without treating references as targets', () => {
    const target = targetRegion('target-1', 'Checkout form');

    expect(getTargetContextItem([referenceFile])).toBeNull();
    expect(getTargetContextItem([referenceFile, target])).toBe(target);
  });

  test('builds one typed-controller request without choosing an execution route', () => {
    const target = targetRegion('target-1', 'Checkout form');
    const attachment = {
      id: 'attachment-1',
      kind: 'file' as const,
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
      filePath: '/tmp/invoice.pdf',
    };

    expect(buildOverlayTextControllerRequest({
      text: '  Fill this from the invoice  ',
      serviceContextItems: [target],
      submittedContextItems: [referenceFile],
      attachments: [attachment],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: 'profile-rendered',
      inputMethod: 'text',
      now: 1000,
    })).toEqual({
      text: 'Fill this from the invoice',
      contextItems: [referenceFile, target],
      targetContext: target,
      attachments: [attachment],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-rendered',
      inputMethod: 'text',
      directCommand: null,
      targetScopeKey: targetScopeKey('target-1', 'file-1,target-1'),
      managedContext: null,
      hasUserInput: true,
    });
  });

  test('treats empty text without attachments or context as no user input', () => {
    expect(buildOverlayTextControllerRequest({
      text: '   ',
      serviceContextItems: [],
      submittedContextItems: undefined,
      attachments: undefined,
      workspacePath: null,
      targetWindowSessionKey: null,
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'voice',
    }).hasUserInput).toBeFalse();
  });

  test('matches low-latency list windows commands to the CUA driver primitive', () => {
    expect(matchOverlayTextControllerDirectCommand('list windows')).toEqual({
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'list_windows',
      args: {},
    });

    expect(matchOverlayTextControllerDirectCommand('show windows for pid 1234')).toEqual({
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'list_windows',
      args: { pid: 1234 },
    });
  });

  test('matches explicit current-selection reads to the selection primitive', () => {
    expect(matchOverlayTextControllerDirectCommand('read selection')).toEqual({
      kind: 'tool',
      serverId: 'builtin-selection',
      toolName: 'read_current_selection',
      args: {},
    });

    expect(matchOverlayTextControllerDirectCommand("what's selected?")).toEqual({
      kind: 'tool',
      serverId: 'builtin-selection',
      toolName: 'read_current_selection',
      args: {},
    });

    expect(matchOverlayTextControllerDirectCommand('select the submit button')).toBeNull();
  });

  test('matches explicit computer-state reads to the Interpreter state primitive', () => {
    expect(matchOverlayTextControllerDirectCommand('show computer state')).toEqual({
      kind: 'tool',
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_whole_computer_state_get',
      args: {},
    });

    expect(matchOverlayTextControllerDirectCommand('what is the whole computer state?')).toEqual({
      kind: 'tool',
      serverId: 'builtin-interpreter',
      toolName: 'interpreter_whole_computer_state_get',
      args: {},
    });

    expect(matchOverlayTextControllerDirectCommand("what's on my screen?")).toBeNull();
  });

  test('matches explicit window bounds commands only when all required fields are present', () => {
    expect(matchOverlayTextControllerDirectCommand('focus window pid 1234 window_id 55')).toEqual({
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'focus_window',
      args: {
        target_identity: {
          kind: 'app-window',
          app: { pid: 1234 },
          window: { native_window_id: 55 },
        },
      },
    });

    expect(matchOverlayTextControllerDirectCommand('reveal window pid=1234 window=55')).toEqual({
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'focus_window',
      args: {
        target_identity: {
          kind: 'app-window',
          app: { pid: 1234 },
          window: { native_window_id: 55 },
        },
      },
    });

    expect(matchOverlayTextControllerDirectCommand(
      'move window pid 1234 window_id 55 x 10 y 20 width 800 height 600',
    )).toEqual({
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
    });

    expect(matchOverlayTextControllerDirectCommand(
      'resize window pid=1234 window=55 x=10 y=20 w=800 h=600',
    )).toEqual({
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
    });

    expect(matchOverlayTextControllerDirectCommand('move Chrome to the left')).toBeNull();
    expect(matchOverlayTextControllerDirectCommand('focus window')).toBeNull();
    expect(matchOverlayTextControllerDirectCommand('close window')).toBeNull();
  });

  test('matches explicit close-app commands to exact close-window commands only for named apps', () => {
    expect(matchOverlayTextControllerDirectCommand('close Chrome')).toEqual({
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'close_window',
      args: {
        app: 'Chrome',
      },
    });

    expect(matchOverlayTextControllerDirectCommand('quit Google Chrome')).toEqual({
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'close_window',
      args: {
        app: 'Google Chrome',
      },
    });

    expect(matchOverlayTextControllerDirectCommand('close this')).toBeNull();
    expect(matchOverlayTextControllerDirectCommand('close tab')).toBeNull();
  });

  test('matches explicit visible-agent handoff commands only when a task is present', () => {
    expect(matchOverlayTextControllerDirectCommand(
      'launch visible agent: summarize the selected form state',
    )).toEqual({
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'launch_agent_window',
      args: {
        initial_message: 'summarize the selected form state',
        activate: true,
        completion_disposition: 'keep_open',
      },
    });

    expect(matchOverlayTextControllerDirectCommand(
      'ask a windowed agent to compare these two selected fields',
    )).toEqual({
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'launch_agent_window',
      args: {
        initial_message: 'compare these two selected fields',
        activate: true,
        completion_disposition: 'keep_open',
      },
    });

    expect(matchOverlayTextControllerDirectCommand('launch visible agent')).toBeNull();
    expect(matchOverlayTextControllerDirectCommand('help me with this')).toBeNull();
  });

  test('matches explicit hidden-agent handoff commands only when a task is present', () => {
    expect(matchOverlayTextControllerDirectCommand('call hidden agent: inspect the selected context')).toEqual({
      kind: 'tool',
      serverId: 'builtin-interpreter-overlay',
      toolName: 'call_hidden_agent',
      args: {
        message: 'inspect the selected context',
      },
    });

    expect(matchOverlayTextControllerDirectCommand('ask a hidden agent to summarize this')).toEqual({
      kind: 'tool',
      serverId: 'builtin-interpreter-overlay',
      toolName: 'call_hidden_agent',
      args: {
        message: 'summarize this',
      },
    });

    expect(matchOverlayTextControllerDirectCommand('call hidden agent')).toBeNull();
    expect(matchOverlayTextControllerDirectCommand('ask an agent to summarize this')).toBeNull();
  });

  test('matches explicit agent-window management commands without treating app closes as agent closes', () => {
    expect(matchOverlayTextControllerDirectCommand('list agent windows')).toEqual({
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'list_agent_windows',
      args: {},
    });

    expect(matchOverlayTextControllerDirectCommand('reveal agent window agent-123')).toEqual({
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'reveal_agent_window',
      args: { agent_id: 'agent-123' },
    });

    expect(matchOverlayTextControllerDirectCommand('stop agent window agent_id:agent-123')).toEqual({
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'stop_agent_window',
      args: { agent_id: 'agent-123' },
    });

    expect(matchOverlayTextControllerDirectCommand('await agent window agent-123')).toEqual({
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'await_agent_window',
      args: { agent_id: 'agent-123' },
    });

    expect(matchOverlayTextControllerDirectCommand('close agent window agent-123')).toEqual({
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'close_agent_window',
      args: { agent_id: 'agent-123' },
    });

    expect(matchOverlayTextControllerDirectCommand('close Chrome')).toEqual({
      kind: 'tool',
      serverId: 'builtin-cua-driver',
      toolName: 'close_window',
      args: {
        app: 'Chrome',
      },
    });
    expect(matchOverlayTextControllerDirectCommand('close agent window')).toBeNull();
  });

  test('matches explicit agent-window message commands only with an agent id and message', () => {
    expect(matchOverlayTextControllerDirectCommand('send agent window agent-123: check the logs')).toEqual({
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'send_agent_window_message',
      args: {
        agent_id: 'agent-123',
        message: 'check the logs',
      },
    });

    expect(matchOverlayTextControllerDirectCommand('message agent window agent_id:agent-123: continue')).toEqual({
      kind: 'tool',
      serverId: 'builtin-agent-windows',
      toolName: 'send_agent_window_message',
      args: {
        agent_id: 'agent-123',
        message: 'continue',
      },
    });

    expect(matchOverlayTextControllerDirectCommand('message agent-123: continue')).toBeNull();
    expect(matchOverlayTextControllerDirectCommand('send agent window agent-123')).toBeNull();
    expect(matchOverlayTextControllerDirectCommand('send agent window agent-123:')).toBeNull();
  });

  test('treats all currently matched direct commands as executable', () => {
    expect(isExecutableOverlayTextControllerDirectCommand(
      matchOverlayTextControllerDirectCommand('list windows'),
    )).toBeTrue();

    expect(isExecutableOverlayTextControllerDirectCommand(
      matchOverlayTextControllerDirectCommand('read selection'),
    )).toBeTrue();

    expect(isExecutableOverlayTextControllerDirectCommand(
      matchOverlayTextControllerDirectCommand('move window pid 1234 window_id 55 x 10 y 20 width 800 height 600'),
    )).toBeTrue();

    expect(isExecutableOverlayTextControllerDirectCommand(
      matchOverlayTextControllerDirectCommand('focus window pid 1234 window_id 55'),
    )).toBeTrue();

    expect(isExecutableOverlayTextControllerDirectCommand(
      matchOverlayTextControllerDirectCommand('open windowed agent: inspect this'),
    )).toBeTrue();

    expect(isExecutableOverlayTextControllerDirectCommand(
      matchOverlayTextControllerDirectCommand('list agent windows'),
    )).toBeTrue();

    expect(isExecutableOverlayTextControllerDirectCommand(
      matchOverlayTextControllerDirectCommand('send agent window agent-123: continue'),
    )).toBeTrue();

    expect(isExecutableOverlayTextControllerDirectCommand(
      matchOverlayTextControllerDirectCommand('call hidden agent: inspect this'),
    )).toBeTrue();
  });

  test('reuses managed context only for the same recent target scope', () => {
    const target = targetRegion('target-1', 'Checkout form');
    const targetScopeKey = buildOverlayTextControllerTargetScopeKey({
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      targetContext: target,
      contextItems: [target],
    });
    const managedContext = {
      targetScopeKey,
      updatedAt: 1000,
      turns: [{
        at: 1000,
        userText: 'list windows',
        controllerDecision: 'direct_command',
        directCommand: matchOverlayTextControllerDirectCommand('list windows'),
        toolCalls: [{
          serverId: 'builtin-cua-driver',
          toolName: 'list_windows',
          args: {},
          resultText: '[{"pid":1234}]',
          permissionResultText: null,
        }],
        toolResultText: '[{"pid":1234}]',
        permissionResultText: null,
        agentLaunch: null,
      }],
    };

    expect(buildOverlayTextControllerRequest({
      text: 'what about that one?',
      serviceContextItems: [target],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      managedContext,
      now: 1100,
    }).managedContext).toBe(managedContext);

    expect(reusableOverlayTextControllerManagedContext({
      managedContext,
      targetScopeKey,
      now: 1000 + (3 * 60 * 1000) + 1,
    })).toBeNull();

    expect(buildOverlayTextControllerRequest({
      text: 'what about that one?',
      serviceContextItems: [targetRegion('target-2', 'Other app')],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      managedContext,
      now: 1100,
    }).managedContext).toBeNull();

    expect(buildOverlayTextControllerRequest({
      text: 'what about that file?',
      serviceContextItems: [target, referenceFile],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      managedContext,
      now: 1100,
    }).managedContext).toBeNull();
  });

  test('records direct command results into a capped managed context', () => {
    const target = targetRegion('target-1', 'Checkout form');
    let request = buildOverlayTextControllerRequest({
      text: 'move window pid 1234 window_id 55 x 10 y 20 width 800 height 600',
      serviceContextItems: [target],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      now: 1000,
    });
    let managedContext = recordOverlayTextControllerDirectCommandResult({
      managedContext: null,
      request,
      toolResultText: 'moved window',
      now: 1000,
    });

    expect(managedContext).toEqual({
      targetScopeKey: targetScopeKey(),
      updatedAt: 1000,
      turns: [{
        at: 1000,
        userText: 'move window pid 1234 window_id 55 x 10 y 20 width 800 height 600',
        controllerDecision: 'direct_command',
        directCommand: request.directCommand,
        toolCalls: [{
          serverId: 'builtin-cua-driver',
          toolName: 'set_window_bounds',
          args: request.directCommand?.args ?? {},
          resultText: 'moved window',
          permissionResultText: null,
        }],
        toolResultText: 'moved window',
        permissionResultText: null,
        agentLaunch: null,
      }],
    });

    for (let index = 0; index < 7; index += 1) {
      request = buildOverlayTextControllerRequest({
        text: `move window pid 1234 window_id 55 x ${index} y 20 width 800 height 600`,
        serviceContextItems: [target],
        workspacePath: '/workspace',
        targetWindowSessionKey: 'window-2',
        profileId: 'profile-action',
        renderedProfileId: null,
        inputMethod: 'text',
        managedContext,
        now: 1100 + index,
      });
      managedContext = recordOverlayTextControllerDirectCommandResult({
        managedContext: request.managedContext,
        request,
        toolResultText: `moved ${index}`,
        now: 1100 + index,
      });
    }

    expect(managedContext.turns).toHaveLength(6);
    expect(managedContext.turns[0].userText).toContain('x 1 y');
    expect(managedContext.turns[5].toolResultText).toBe('moved 6');
  });

  test('records direct command failures with permission details when provided', () => {
    const request = buildOverlayTextControllerRequest({
      text: 'close Chrome',
      serviceContextItems: [],
      submittedContextItems: [],
      attachments: [],
      workspacePath: '/workspace',
      targetWindowSessionKey: null,
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      now: 1000,
    });

    const managedContext = recordOverlayTextControllerDirectCommandResult({
      managedContext: request.managedContext,
      request,
      toolResultText: 'Error: User denied native desktop driver control access.',
      permissionResultText: 'User denied native desktop driver control access.',
      now: 1000,
    });

    expect(managedContext.turns).toHaveLength(1);
    expect(managedContext.turns[0]?.controllerDecision).toBe('direct_command');
    expect(managedContext.turns[0]?.directCommand?.toolName).toBe('close_window');
    expect(managedContext.turns[0]?.toolCalls).toEqual([{
      serverId: 'builtin-cua-driver',
      toolName: 'close_window',
      args: { app: 'Chrome' },
      resultText: 'Error: User denied native desktop driver control access.',
      permissionResultText: 'User denied native desktop driver control access.',
    }]);
    expect(managedContext.turns[0]?.toolResultText).toBe('Error: User denied native desktop driver control access.');
    expect(managedContext.turns[0]?.permissionResultText).toBe('User denied native desktop driver control access.');
  });

  test('records actual direct tool call args when the executor expands the matched command', () => {
    const request = buildOverlayTextControllerRequest({
      text: 'close Chrome',
      serviceContextItems: [],
      submittedContextItems: [],
      attachments: [],
      workspacePath: '/workspace',
      targetWindowSessionKey: null,
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      now: 1000,
    });

    const managedContext = recordOverlayTextControllerDirectCommandResult({
      managedContext: null,
      request,
      toolResultText: 'closed',
      toolCalls: [{
        serverId: 'builtin-cua-driver',
        toolName: 'close_window',
        args: {
          target_identity: {
            kind: 'app-window',
            app: { name: 'Google Chrome', pid: 123 },
            window: { native_window_id: 456, title: 'Chrome' },
          },
        },
        resultText: 'closed',
        permissionResultText: null,
      }],
      now: 1000,
    });

    expect(managedContext.turns[0]?.directCommand?.args).toEqual({ app: 'Chrome' });
    expect(managedContext.turns[0]?.toolCalls[0]?.args).toEqual({
      target_identity: {
        kind: 'app-window',
        app: { name: 'Google Chrome', pid: 123 },
        window: { native_window_id: 456, title: 'Chrome' },
      },
    });
  });

  test('records fast model agent launch decisions into managed context', () => {
    const target = targetRegion('target-1', 'Checkout form');
    const request = buildOverlayTextControllerRequest({
      text: 'fill this form',
      serviceContextItems: [target],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      now: 1000,
    });

    const managedContext = recordOverlayTextControllerAgentLaunchResult({
      managedContext: null,
      request,
      launch: {
        agentId: 'overlay-agent-1',
        target: 'overlay_target',
        profileId: 'profile-action',
        workspacePath: '/workspace',
        targetWindowSessionKey: 'window-2',
        allowedToolCount: 6,
        initialElementCount: 14,
      },
      toolCalls: [{
        serverId: 'builtin-agent-windows',
        toolName: 'launch_agent_window',
        args: {
          target: 'overlay_target',
          activate: true,
        },
        resultText: 'Started visible Interpreter agent.',
        permissionResultText: null,
      }],
      now: 1000,
    });

    expect(managedContext).toEqual({
      targetScopeKey: targetScopeKey(),
      updatedAt: 1000,
      turns: [{
        at: 1000,
        userText: 'fill this form',
        controllerDecision: 'fast_model_agent',
        directCommand: null,
        toolCalls: [{
          serverId: 'builtin-agent-windows',
          toolName: 'launch_agent_window',
          args: {
            target: 'overlay_target',
            activate: true,
          },
          resultText: 'Started visible Interpreter agent.',
          permissionResultText: null,
        }],
        toolResultText: 'Started visible Interpreter agent.',
        permissionResultText: null,
        agentLaunch: {
          agentId: 'overlay-agent-1',
          target: 'overlay_target',
          profileId: 'profile-action',
          workspacePath: '/workspace',
          targetWindowSessionKey: 'window-2',
          allowedToolCount: 6,
          initialElementCount: 14,
        },
      }],
    });

    const prompt = buildOverlayTextControllerContextPrompt(buildOverlayTextControllerRequest({
      text: 'continue',
      serviceContextItems: [target],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      managedContext,
      now: 1100,
    }));

    expect(prompt).toContain('controller_decision: fast_model_agent');
    expect(prompt).toContain('"tool_name":"launch_agent_window"');
    expect(prompt).toContain('"agent_id":"overlay-agent-1"');
    expect(prompt).toContain('"target":"overlay_target"');
    expect(prompt).toContain('tool_result: Started visible Interpreter agent.');
  });

  test('records fast model agent launch failures into managed context', () => {
    const target = targetRegion('target-1', 'Checkout form');
    const request = buildOverlayTextControllerRequest({
      text: 'fill this form',
      serviceContextItems: [target],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      now: 1000,
    });

    const managedContext = recordOverlayTextControllerAgentFailureResult({
      managedContext: request.managedContext,
      request,
      toolResultText: 'Error: permission denied for selected target',
      toolCalls: [{
        serverId: 'builtin-agent-windows',
        toolName: 'launch_agent_window',
        args: {
          target: 'overlay_target',
          activate: true,
        },
        resultText: 'Error: permission denied for selected target',
        permissionResultText: 'permission denied for selected target',
      }],
      permissionResultText: 'permission denied for selected target',
      now: 1000,
    });

    expect(managedContext.turns).toEqual([{
      at: 1000,
      userText: 'fill this form',
      controllerDecision: 'fast_model_agent',
      directCommand: null,
      toolCalls: [{
        serverId: 'builtin-agent-windows',
        toolName: 'launch_agent_window',
        args: {
          target: 'overlay_target',
          activate: true,
        },
        resultText: 'Error: permission denied for selected target',
        permissionResultText: 'permission denied for selected target',
      }],
      toolResultText: 'Error: permission denied for selected target',
      permissionResultText: 'permission denied for selected target',
      agentLaunch: null,
    }]);

    const prompt = buildOverlayTextControllerContextPrompt({
      ...request,
      managedContext,
    });
    expect(prompt).toContain('controller_decision: fast_model_agent');
    expect(prompt).toContain('agent_launch: none');
    expect(prompt).toContain('permission_result: permission denied for selected target');
    expect(prompt).toContain('tool_result: Error: permission denied for selected target');
  });

  test('builds the controller context prompt from selected context and user text', () => {
    const target = targetRegion('target-1', 'Checkout form');
    const request = buildOverlayTextControllerRequest({
      text: 'What is selected?',
      serviceContextItems: [target],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      now: 1000,
    });

    const prompt = buildOverlayTextControllerContextPrompt(request, {
      availableToolsText: '<overlay_available_tools>\n<tool name="computer_batch">\n</overlay_available_tools>',
      wholeComputerState: {
        workspacePath: '/workspace',
        targetWindowSessionKey: 'window-2',
        targetContextLabel: 'Checkout form',
        targetIdentityId: 'overlay-target-1',
        overlayTarget: {
          label: 'Checkout form',
          targetKind: 'active-app',
          targetIdentityId: 'overlay-target-1',
          coordinateSpace: 'screen-dip',
          displayId: 'display-1',
          scaleFactor: 2,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          capturedAt: 1000,
          appName: 'Safari',
          appPid: 1234,
          appBundlePath: '/Applications/Safari.app',
          nativeWindowId: 55,
        },
        contextItemCount: 1,
        referenceContextCount: 0,
        windows: [{
          kind: 'interpreter-window',
          windowSessionKey: 'window-2',
          workspacePath: '/workspace',
          windowId: 12,
        }, {
          kind: 'agent-window',
          windowSessionKey: 'window-2',
          workspacePath: '/workspace',
          agentId: 'overlay-agent-1',
          threadId: 'thread-1',
          activityLabel: 'Working',
          isRunning: true,
          lastMessagePreview: 'Inspecting the form',
        }],
        browserControl: null,
      },
    });

    expect(prompt).toContain('<overlay_context_packet>');
    expect(prompt).toContain('label="Checkout form"');
    expect(prompt).toContain('<overlay_whole_computer_state>');
    expect(prompt).toContain('target_context_label: "Checkout form"');
    expect(prompt).toContain('<overlay_target_state>');
    expect(prompt).toContain('target_kind: "active-app"');
    expect(prompt).toContain('app_name: "Safari"');
    expect(prompt).toContain('native_window_id: 55');
    expect(prompt).toContain('bounds: x=10 y=20 width=300 height=200');
    expect(prompt).toContain('window kind="interpreter-window" window_session_key="window-2" workspace_path="/workspace" window_id=12');
    expect(prompt).toContain('window kind="agent-window" window_session_key="window-2" workspace_path="/workspace" agent_id="overlay-agent-1"');
    expect(prompt).toContain('<overlay_available_tools>');
    expect(prompt.endsWith('\n\nWhat is selected?')).toBeTrue();
    expect(prompt).not.toContain('<overlay_recent_turns');
  });

  test('formats saved custom instructions as overlay working preferences', () => {
    expect(buildOverlayWorkingPreferencesText('   ')).toBe('');

    const text = buildOverlayWorkingPreferencesText(' Prefer short checklists. ');

    expect(text).toContain('<overlay_working_preferences source="saved_custom_instructions">');
    expect(text).toContain('These are the saved Interpreter working preferences');
    expect(text).toContain('Prefer short checklists.');
    expect(text).toContain('</overlay_working_preferences>');
  });

  test('adds working preferences to the controller context prompt', () => {
    const target = targetRegion('target-1', 'Checkout form');
    const request = buildOverlayTextControllerRequest({
      text: 'What is selected?',
      serviceContextItems: [target],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      now: 1000,
    });

    const prompt = buildOverlayTextControllerContextPrompt(request, {
      availableToolsText: '<overlay_available_tools>\n<tool name="computer_batch">\n</overlay_available_tools>',
      customInstructions: ' Prefer short checklists. ',
      wholeComputerState: {
        workspacePath: '/workspace',
        targetWindowSessionKey: 'window-2',
        targetContextLabel: 'Checkout form',
        targetIdentityId: 'overlay-target-1',
        overlayTarget: null,
        contextItemCount: 1,
        referenceContextCount: 0,
        windows: [],
        browserControl: null,
      },
    });

    expect(prompt).toContain('<overlay_context_packet>');
    expect(prompt).toContain('<overlay_whole_computer_state>');
    expect(prompt).toContain('<overlay_working_preferences source="saved_custom_instructions">');
    expect(prompt).toContain('Prefer short checklists.');
    expect(prompt).toContain('<overlay_available_tools>');
    expect(prompt.indexOf('<overlay_working_preferences')).toBeGreaterThan(prompt.indexOf('</overlay_whole_computer_state>'));
    expect(prompt.indexOf('<overlay_available_tools>')).toBeGreaterThan(prompt.indexOf('</overlay_working_preferences>'));
    expect(prompt.endsWith('\n\nWhat is selected?')).toBeTrue();
  });

  test('formats whole-computer state with bounded window output', () => {
    const text = buildOverlayWholeComputerStateText({
      workspacePath: '/workspace',
      targetWindowSessionKey: null,
      targetContextLabel: null,
      targetIdentityId: null,
      overlayTarget: null,
      contextItemCount: 0,
      referenceContextCount: 0,
      windows: Array.from({ length: 42 }, (_, index) => ({
        kind: 'interpreter-window',
        windowSessionKey: `window-${index}`,
        workspacePath: '/workspace',
        windowId: index,
      })),
      browserControl: null,
    });

    expect(text).toContain('<windows count="42">');
    expect(text).toContain('window_session_key="window-0"');
    expect(text).toContain('window_session_key="window-39"');
    expect(text).not.toContain('window_session_key="window-40"');
    expect(text).toContain('truncated_window_count: 2');
    expect(text).toContain('browser_control: none');
  });

  test('formats whole-computer state with bounded browser-control output', () => {
    const browserControl = buildOverlayBrowserControlStateFromStatus({
      relay: {
        phase: 'ready',
        reachable: true,
        version: '1.0.0',
        runtimeDir: '/tmp/relay-runtime',
        relayLogPath: '/tmp/relay.log',
        relayCdpLogPath: '/tmp/relay-cdp.log',
        ownsRelayProcess: true,
        lastError: null,
        endpoint: 'http://127.0.0.1:48174',
      },
      connectedBrowsers: 1,
      activeSessions: 1,
      profiles: [{
        profileId: 'local:abc',
        policyProfileId: 'install:profile-1',
        browserName: 'Chrome',
        browserChannel: 'stable',
        profileName: 'Work',
        profilePath: '/Users/test/Library/Application Support/Google/Chrome/Profile 1',
        userDataDir: '/Users/test/Library/Application Support/Google/Chrome',
        extensionId: 'extension-1',
        stableKey: 'install:profile-1',
        connectionState: 'connected',
        activeSessions: 1,
        windowCount: 1,
        tabCount: 2,
      }],
      connections: [{
        extensionId: 'extension-1',
        stableKey: 'install:profile-1',
        profileId: 'install:profile-1',
        browserName: 'Chrome',
        version: '140.0.0.0',
        activeSessions: 1,
        targets: [],
        focusedWindowId: 10,
        activeTabRef: 'install:profile-1:tab:101',
        focusedWindow: null,
        activeTab: null,
        browserWindows: [{
          windowId: 10,
          focused: true,
          type: 'normal',
          state: 'normal',
          tabs: [{
            tabRef: 'install:profile-1:tab:101',
            chromeTabId: 101,
            windowId: 10,
            index: 0,
            active: true,
            highlighted: true,
            pinned: false,
            title: 'Interpreter',
            url: 'https://example.com/work',
            status: 'complete',
            controlState: 'controllable',
            targetId: 'target-101',
          }, {
            tabRef: 'install:profile-1:tab:102',
            chromeTabId: 102,
            windowId: 10,
            index: 1,
            active: false,
            highlighted: false,
            pinned: false,
            title: 'Reference',
            url: 'https://example.org/reference',
            status: 'complete',
            controlState: 'observable',
          }],
        }],
      }],
    }, 1);

    const text = buildOverlayWholeComputerStateText({
      workspacePath: '/workspace',
      targetWindowSessionKey: null,
      targetContextLabel: null,
      targetIdentityId: null,
      overlayTarget: null,
      contextItemCount: 0,
      referenceContextCount: 0,
      windows: [],
      browserControl,
    });

    expect(text).toContain('<browser_control relay_reachable="true" relay_phase="ready" connected_browser_count="1" active_session_count="1" total_tab_count="2" returned_tab_count="1" truncated_tab_count="1">');
    expect(text).toContain('browser_profile_id="local:abc"');
    expect(text).toContain('browser_profile_policy_id="install:profile-1"');
    expect(text).toContain('profile_name="Work"');
    expect(text).toContain('browser_tab tab_ref="install:profile-1:tab:101"');
    expect(text).toContain('origin="https://example.com"');
    expect(text).toContain('control_state="controllable"');
    expect(text).not.toContain('Reference');
    expect(text).not.toContain('/tmp/relay-runtime');
    expect(text).not.toContain('/tmp/relay.log');
  });

  test('adds recent managed turns to the controller context prompt', () => {
    const target = targetRegion('target-1', 'Checkout form');
    const firstRequest = buildOverlayTextControllerRequest({
      text: 'move window pid 1234 window_id 55 x 10 y 20 width 800 height 600',
      serviceContextItems: [target],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      now: 1000,
    });
    const managedContext = recordOverlayTextControllerDirectCommandResult({
      managedContext: null,
      request: firstRequest,
      toolResultText: 'moved window 55',
      now: 1000,
    });
    const followUpRequest = buildOverlayTextControllerRequest({
      text: 'put it back',
      serviceContextItems: [target],
      workspacePath: '/workspace',
      targetWindowSessionKey: 'window-2',
      profileId: 'profile-action',
      renderedProfileId: null,
      inputMethod: 'text',
      managedContext,
      now: 1100,
    });

    const prompt = buildOverlayTextControllerContextPrompt(followUpRequest);

    expect(prompt).toContain(`<overlay_recent_turns target_scope_key="${targetScopeKey()}">`);
    expect(prompt).toContain('controller_decision: direct_command');
    expect(prompt).toContain('direct_tool: builtin-cua-driver/set_window_bounds');
    expect(prompt).toContain('tool_calls: {"server_id":"builtin-cua-driver","tool_name":"set_window_bounds"');
    expect(prompt).toContain('"result":"moved window 55"');
    expect(prompt).toContain('agent_launch: none');
    expect(prompt).toContain('permission_result: none');
    expect(prompt).toContain('tool_result: moved window 55');
    expect(prompt.endsWith('\n\nput it back')).toBeTrue();
  });
});
