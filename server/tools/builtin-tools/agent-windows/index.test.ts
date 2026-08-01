import { afterEach, describe, expect, test } from 'bun:test';
import { clearConfigCache, setConfigOverride } from '../../../configStore';
import { setElectronBroadcaster } from '../../../handlers/broadcast';
import { agentTabManager } from '../../../agentTabManager';
import {
  registerWindowSession,
  unregisterWindowSession,
} from '../../../utils/windowSessions';
import { ToolManager } from '../../toolManager';
import {
  agentWindowsServerDefinition,
  awaitAgentWindowTool,
  closeAgentWindowTool,
  launchAgentWindowTool,
  listAgentWindowsTool,
  revealAgentWindowTool,
  sendAgentWindowMessageTool,
  stopAgentWindowTool,
} from './index';

afterEach(() => {
  setElectronBroadcaster(() => {});
  agentTabManager.clearAll();
  setConfigOverride(null);
  clearConfigCache();
  unregisterWindowSession(101);
  unregisterWindowSession(202);
});

describe('agent windows builtin tools', () => {
  test('lists Interpreter-owned agent window metadata without internal tokens or secrets', async () => {
    registerWindowSession({
      sessionKey: 'window-main',
      windowId: 101,
      workspacePath: '/workspace/main',
    });

    agentTabManager.bindThread({
      agentId: 'agent-main',
      callerToken: 'agtok_secret',
      threadId: 'thread-main',
      windowSessionKey: 'window-main',
      workspacePath: '/workspace/main',
      allowedToolNames: ['builtin-interpreter-overlay__overlay_read_context'],
      toolProfileId: 'profile-tools',
      modelConfig: {
        provider: 'api',
        modelId: 'fast-model',
        profileId: 'profile-model',
        apiKey: 'secret-api-key',
      },
    });

    const result = await listAgentWindowsTool.handler({});
    const text = result.content[0]?.text ?? '';
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload.agents).toEqual([
      {
        agent_id: 'agent-main',
        thread_id: 'thread-main',
        window_session_key: 'window-main',
        workspace_path: '/workspace/main',
        tool_profile_id: 'profile-tools',
        allowed_tool_names: ['builtin-interpreter-overlay__overlay_read_context'],
        model: {
          provider: 'api',
          modelId: 'fast-model',
          profileId: 'profile-model',
        },
        activity: null,
        window: {
          window_id: 101,
          workspace_path: '/workspace/main',
          created_at: expect.any(Number),
        },
      },
    ]);
    expect(text).not.toContain('agtok_secret');
    expect(text).not.toContain('secret-api-key');
  });

  test('lists safe renderer-reported activity for registered agent windows', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-active',
      callerToken: 'agtok_active_secret',
      threadId: 'thread-active',
      windowSessionKey: 'window-active',
      workspacePath: '/workspace/active',
    });
    agentTabManager.reportAgentWindowActivity('agent-active', {
      label: 'Fill the PDF',
      isRunning: true,
      messageCount: 4,
      unreadCount: 1,
      lastMessagePreview: 'I found the selected fields.',
      updatedAt: '2026-06-21T12:00:00.000Z',
    });

    const result = await listAgentWindowsTool.handler({});
    const text = result.content[0]?.text ?? '';
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload.agents[0].activity).toEqual({
      label: 'Fill the PDF',
      is_running: true,
      message_count: 4,
      unread_count: 1,
      last_message_preview: 'I found the selected fields.',
      updated_at: '2026-06-21T12:00:00.000Z',
    });
    expect(text).not.toContain('agtok_active_secret');
  });

  test('filters by workspace path and window session key', async () => {
    registerWindowSession({
      sessionKey: 'window-one',
      windowId: 101,
      workspacePath: '/workspace/one',
    });
    registerWindowSession({
      sessionKey: 'window-two',
      windowId: 202,
      workspacePath: '/workspace/two',
    });

    agentTabManager.bindThread({
      agentId: 'agent-one',
      callerToken: 'agtok_one',
      threadId: 'thread-one',
      windowSessionKey: 'window-one',
      workspacePath: '/workspace/one',
    });
    agentTabManager.bindThread({
      agentId: 'agent-two',
      callerToken: 'agtok_two',
      threadId: 'thread-two',
      windowSessionKey: 'window-two',
      workspacePath: '/workspace/two',
    });

    const byWorkspace = await listAgentWindowsTool.handler({
      workspace_path: '/workspace/two',
    });
    expect(JSON.parse(byWorkspace.content[0]?.text ?? '{}').agents.map((agent: any) => agent.agent_id)).toEqual([
      'agent-two',
    ]);

    const byWindow = await listAgentWindowsTool.handler({
      window_session_key: 'window-one',
    });
    expect(JSON.parse(byWindow.content[0]?.text ?? '{}').agents.map((agent: any) => agent.agent_id)).toEqual([
      'agent-one',
    ]);
  });

  test('is a hidden read-only builtin server', () => {
    expect(agentWindowsServerDefinition.id).toBe('builtin-agent-windows');
    expect(agentWindowsServerDefinition.tools).toEqual([
      listAgentWindowsTool,
      launchAgentWindowTool,
      sendAgentWindowMessageTool,
      revealAgentWindowTool,
      stopAgentWindowTool,
      closeAgentWindowTool,
      awaitAgentWindowTool,
    ]);
    expect(listAgentWindowsTool.annotations?.readOnlyHint).toBe(true);
    expect(launchAgentWindowTool.annotations?.readOnlyHint).toBe(false);
    expect(sendAgentWindowMessageTool.annotations?.readOnlyHint).toBe(false);
    expect(revealAgentWindowTool.annotations?.readOnlyHint).toBe(false);
    expect(stopAgentWindowTool.annotations?.readOnlyHint).toBe(false);
    expect(closeAgentWindowTool.annotations?.destructiveHint).toBe(true);
    expect(awaitAgentWindowTool.annotations?.readOnlyHint).toBe(true);
  });

  test('runs through ToolManager hidden-builtin dispatch without exposing caller tokens', async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      mcpServers: {},
    } as any);
    agentTabManager.bindThread({
      agentId: 'agent-cli',
      callerToken: 'agtok_cli_secret',
      threadId: 'thread-cli',
      windowSessionKey: 'window-cli',
      workspacePath: '/workspace/cli',
    });

    const toolManager = new ToolManager();
    const result = await toolManager.callTool(
      'builtin-agent-windows',
      'list_agent_windows',
      {},
      false,
      'agent-cli',
      { threadId: 'thread-cli', workspace: '/workspace/cli' },
      undefined,
      { includeHiddenBuiltins: true },
    );
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(JSON.parse(text).agents.map((agent: any) => agent.agent_id)).toEqual(['agent-cli']);
    expect(text).not.toContain('agtok_cli_secret');
  });

  test('launches a visible agent task with an initial message without exposing caller tokens', async () => {
    const result = await launchAgentWindowTool.handler({
      initial_message: 'Use the selected context and summarize it.',
      workspace_path: '/workspace/main',
      target_window_session_key: 'window-main',
      activate: true,
      completion_disposition: 'keep_open',
    });
    const text = result.content[0]?.text ?? '';
    const payload = JSON.parse(text);
    const [pendingRequest] = agentTabManager.getPendingRequests();

    expect(result.isError).toBe(false);
    expect(payload).toEqual({
      status: 'launch_requested',
      agent_id: pendingRequest.agentId,
      request_id: pendingRequest.requestId,
      startup_id: pendingRequest.requestId,
      thread_id: null,
      workspace_path: '/workspace/main',
      target_window_session_key: 'window-main',
      inherited_allowed_tool_names: [],
    });
    expect(pendingRequest.initialMessage).toBe('Use the selected context and summarize it.');
    expect(pendingRequest.workspacePath).toBe('/workspace/main');
    expect(pendingRequest.targetWindowSessionKey).toBe('window-main');
    expect(pendingRequest.activate).toBe(true);
    expect(pendingRequest.completionDisposition).toBe('keep_open');
    expect(text).not.toContain(pendingRequest.callerToken);
  });

  test('launches a visible agent with handoff context, target refs, inherited tools, and parent owner', async () => {
    agentTabManager.bindThread({
      agentId: 'overlay-agent-windowed-parent',
      callerToken: 'agtok_windowed_parent_secret',
      threadId: 'thread-windowed-parent',
      windowSessionKey: 'window-parent',
      workspacePath: '/workspace/parent',
      allowedToolNames: [
        'builtin-interpreter-overlay__overlay_read_context',
        'builtin-agent-windows__send_agent_window_message',
      ],
      toolProfileId: 'profile-parent',
    });

    const result = await launchAgentWindowTool.handler(
      {
        initial_message: 'Fill the selected form.',
        workspace_path: '/workspace/parent',
        conversation_context: 'The user asked to use the selected PDF and current form.',
        selected_context: {
          selected_context_snapshot_id: 'snapshot-1',
          target_identity_id: 'target-1',
          selected_files: ['/workspace/parent/source.pdf'],
        },
        target_refs: ['element:name', 'element:email'],
      },
      {
        agentId: 'overlay-agent-windowed-parent',
        threadId: 'thread-windowed-parent',
        workspace: '/workspace/parent',
      },
    );
    const text = result.content[0]?.text ?? '';
    const [pendingRequest] = agentTabManager.getPendingRequests();

    expect(result.isError).toBe(false);
    expect(JSON.parse(text).inherited_allowed_tool_names).toEqual([
      'builtin-interpreter-overlay__overlay_read_context',
      'builtin-agent-windows__send_agent_window_message',
    ]);
    expect(pendingRequest.allowedToolNames).toEqual([
      'builtin-interpreter-overlay__overlay_read_context',
      'builtin-agent-windows__send_agent_window_message',
    ]);
    expect(pendingRequest.parentOwner).toEqual({
      approvalOwnerKind: 'overlay-agent',
      agentId: 'overlay-agent-windowed-parent',
      threadId: 'thread-windowed-parent',
      windowSessionKey: 'window-parent',
      workspacePath: '/workspace/parent',
      toolProfileId: 'profile-parent',
    });
    expect(pendingRequest.initialMessage).toContain('Fill the selected form.');
    expect(pendingRequest.initialMessage).toContain('Windowed agent handoff context:');
    expect(pendingRequest.initialMessage).toContain('"conversation_context": "The user asked to use the selected PDF and current form."');
    expect(pendingRequest.initialMessage).toContain('"selected_context_snapshot_id": "snapshot-1"');
    expect(pendingRequest.initialMessage).toContain('"target_refs"');
    expect(pendingRequest.initialMessage).toContain('"element:name"');
    expect(pendingRequest.initialMessage).toContain('"allowed_tool_names"');
    expect(text).not.toContain('agtok_windowed_parent_secret');
  });

  test('launch_agent_window runs through ToolManager hidden-builtin dispatch', async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      mcpServers: {},
    } as any);

    const toolManager = new ToolManager();
    const result = await toolManager.callTool(
      'builtin-agent-windows',
      'launch_agent_window',
      {
        initial_message: 'Open a visible agent from the overlay.',
        workspace_path: '/workspace/overlay',
      },
      false,
      'agent-overlay',
      { threadId: 'thread-overlay', workspace: '/workspace/overlay' },
      undefined,
      { includeHiddenBuiltins: true },
    );
    const text = result.content[0]?.text ?? '';
    const [pendingRequest] = agentTabManager.getPendingRequests();

    expect(result.isError).toBe(false);
    expect(JSON.parse(text).agent_id).toBe(pendingRequest.agentId);
    expect(JSON.parse(text).inherited_allowed_tool_names).toEqual([]);
    expect(pendingRequest.initialMessage).toBe('Open a visible agent from the overlay.');
    expect(pendingRequest.workspacePath).toBe('/workspace/overlay');
    expect(text).not.toContain(pendingRequest.callerToken);
  });

  test('sends a message to a registered agent window through scoped local broadcast', async () => {
    const events: Array<{ channel: string; data: any; scope: any }> = [];
    setElectronBroadcaster((channel, data, scope) => {
      events.push({ channel, data, scope });
    });
    agentTabManager.bindThread({
      agentId: 'agent-target',
      callerToken: 'agtok_send_secret',
      threadId: 'thread-target',
      windowSessionKey: 'window-target',
      workspacePath: '/workspace/target',
    });

    const result = await sendAgentWindowMessageTool.handler({
      agent_id: 'agent-target',
      thread_id: 'thread-target',
      message: 'Continue with the selected refs.',
    });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(JSON.parse(text)).toEqual({
      status: 'send_requested',
      agent_id: 'agent-target',
      thread_id: 'thread-target',
      window_session_key: 'window-target',
      workspace_path: '/workspace/target',
    });
    expect(events).toEqual([
      {
        channel: 'agent-tab:send-requested',
        data: {
          agentId: 'agent-target',
          threadId: 'thread-target',
          message: 'Continue with the selected refs.',
          workspacePath: '/workspace/target',
          messageSource: null,
        },
        scope: {
          windowSessionKey: 'window-target',
        },
      },
    ]);
    expect(text).not.toContain('agtok_send_secret');
  });

  test('send_agent_window_message runs through ToolManager hidden-builtin dispatch', async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      mcpServers: {},
    } as any);
    const events: Array<{ channel: string; data: any; scope: any }> = [];
    setElectronBroadcaster((channel, data, scope) => {
      events.push({ channel, data, scope });
    });
    agentTabManager.bindThread({
      agentId: 'agent-send-cli',
      callerToken: 'agtok_send_cli_secret',
      threadId: 'thread-send-cli',
      workspacePath: '/workspace/send-cli',
    });

    const toolManager = new ToolManager();
    const result = await toolManager.callTool(
      'builtin-agent-windows',
      'send_agent_window_message',
      {
        agent_id: 'agent-send-cli',
        message: 'Please continue from the overlay.',
      },
      false,
      'agent-overlay',
      { threadId: 'thread-overlay', workspace: '/workspace/send-cli' },
      undefined,
      { includeHiddenBuiltins: true },
    );
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(JSON.parse(text).agent_id).toBe('agent-send-cli');
    expect(events[0]).toMatchObject({
      channel: 'agent-tab:send-requested',
      data: {
        agentId: 'agent-send-cli',
        threadId: 'thread-send-cli',
        message: 'Please continue from the overlay.',
        workspacePath: '/workspace/send-cli',
      },
      scope: {
        workspacePath: '/workspace/send-cli',
      },
    });
    expect(text).not.toContain('agtok_send_cli_secret');
  });

  test('send_agent_window_message fails loudly for unknown agent ids', async () => {
    const result = await sendAgentWindowMessageTool.handler({
      agent_id: 'agent-missing',
      message: 'Are you there?',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('No Interpreter agent window is registered for agent_id="agent-missing".');
  });

  test('reveals a registered agent window through the existing focus-tab event', async () => {
    const events: Array<{ channel: string; data: any; scope: any }> = [];
    setElectronBroadcaster((channel, data, scope) => {
      events.push({ channel, data, scope });
    });
    agentTabManager.bindThread({
      agentId: 'agent-reveal',
      callerToken: 'agtok_reveal_secret',
      threadId: 'thread-reveal',
      windowSessionKey: 'window-reveal',
      workspacePath: '/workspace/reveal',
    });

    const result = await revealAgentWindowTool.handler({
      agent_id: 'agent-reveal',
    });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(JSON.parse(text)).toEqual({
      status: 'reveal_requested',
      agent_id: 'agent-reveal',
      thread_id: 'thread-reveal',
      window_session_key: 'window-reveal',
      workspace_path: '/workspace/reveal',
    });
    expect(events).toEqual([
      {
        channel: 'workstation:focus-tab',
        data: { id: 'agent-reveal' },
        scope: { windowSessionKey: 'window-reveal' },
      },
    ]);
    expect(text).not.toContain('agtok_reveal_secret');
  });

  test('reveal_agent_window runs through ToolManager hidden-builtin dispatch', async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      mcpServers: {},
    } as any);
    const events: Array<{ channel: string; data: any; scope: any }> = [];
    setElectronBroadcaster((channel, data, scope) => {
      events.push({ channel, data, scope });
    });
    agentTabManager.bindThread({
      agentId: 'agent-reveal-cli',
      callerToken: 'agtok_reveal_cli_secret',
      workspacePath: '/workspace/reveal-cli',
    });

    const toolManager = new ToolManager();
    const result = await toolManager.callTool(
      'builtin-agent-windows',
      'reveal_agent_window',
      {
        agent_id: 'agent-reveal-cli',
      },
      false,
      'agent-overlay',
      { threadId: 'thread-overlay', workspace: '/workspace/reveal-cli' },
      undefined,
      { includeHiddenBuiltins: true },
    );
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(JSON.parse(text).agent_id).toBe('agent-reveal-cli');
    expect(events[0]).toMatchObject({
      channel: 'workstation:focus-tab',
      data: { id: 'agent-reveal-cli' },
      scope: { workspacePath: '/workspace/reveal-cli' },
    });
    expect(text).not.toContain('agtok_reveal_cli_secret');
  });

  test('reveal_agent_window fails loudly for unknown agent ids', async () => {
    const result = await revealAgentWindowTool.handler({
      agent_id: 'agent-missing',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('No Interpreter agent window is registered for agent_id="agent-missing".');
  });

  test('stops a registered agent window through the existing runtime cancel event', async () => {
    const events: Array<{ channel: string; data: any; scope: any }> = [];
    setElectronBroadcaster((channel, data, scope) => {
      events.push({ channel, data, scope });
    });
    agentTabManager.bindThread({
      agentId: 'agent-stop',
      callerToken: 'agtok_stop_secret',
      threadId: 'thread-stop',
      windowSessionKey: 'window-stop',
      workspacePath: '/workspace/stop',
    });

    const result = await stopAgentWindowTool.handler({
      agent_id: 'agent-stop',
    });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(JSON.parse(text)).toEqual({
      status: 'stop_requested',
      agent_id: 'agent-stop',
      thread_id: 'thread-stop',
      window_session_key: 'window-stop',
      workspace_path: '/workspace/stop',
    });
    expect(events).toEqual([
      {
        channel: 'agent-tab:stop-requested',
        data: {
          agentId: 'agent-stop',
          threadId: 'thread-stop',
        },
        scope: { windowSessionKey: 'window-stop' },
      },
    ]);
    expect(text).not.toContain('agtok_stop_secret');
  });

  test('stop_agent_window runs through ToolManager hidden-builtin dispatch', async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      mcpServers: {},
    } as any);
    const events: Array<{ channel: string; data: any; scope: any }> = [];
    setElectronBroadcaster((channel, data, scope) => {
      events.push({ channel, data, scope });
    });
    agentTabManager.bindThread({
      agentId: 'agent-stop-cli',
      callerToken: 'agtok_stop_cli_secret',
      workspacePath: '/workspace/stop-cli',
    });

    const toolManager = new ToolManager();
    const result = await toolManager.callTool(
      'builtin-agent-windows',
      'stop_agent_window',
      {
        agent_id: 'agent-stop-cli',
      },
      false,
      'agent-overlay',
      { threadId: 'thread-overlay', workspace: '/workspace/stop-cli' },
      undefined,
      { includeHiddenBuiltins: true },
    );
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(JSON.parse(text).agent_id).toBe('agent-stop-cli');
    expect(events[0]).toMatchObject({
      channel: 'agent-tab:stop-requested',
      data: { agentId: 'agent-stop-cli' },
      scope: { workspacePath: '/workspace/stop-cli' },
    });
    expect(text).not.toContain('agtok_stop_cli_secret');
  });

  test('stop_agent_window fails loudly for unknown agent ids', async () => {
    const result = await stopAgentWindowTool.handler({
      agent_id: 'agent-missing',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('No Interpreter agent window is registered for agent_id="agent-missing".');
  });

  test('closes a registered agent window through the existing close-tab event', async () => {
    const events: Array<{ channel: string; data: any; scope: any }> = [];
    setElectronBroadcaster((channel, data, scope) => {
      events.push({ channel, data, scope });
    });
    agentTabManager.bindThread({
      agentId: 'agent-close',
      callerToken: 'agtok_close_secret',
      threadId: 'thread-close',
      windowSessionKey: 'window-close',
      workspacePath: '/workspace/close',
    });

    const result = await closeAgentWindowTool.handler({
      agent_id: 'agent-close',
    });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(JSON.parse(text)).toEqual({
      status: 'close_requested',
      agent_id: 'agent-close',
      thread_id: 'thread-close',
      window_session_key: 'window-close',
      workspace_path: '/workspace/close',
    });
    expect(events).toEqual([
      {
        channel: 'workstation:close-tab',
        data: { id: 'agent-close' },
        scope: { windowSessionKey: 'window-close' },
      },
    ]);
    expect(text).not.toContain('agtok_close_secret');
  });

  test('close_agent_window runs through ToolManager hidden-builtin dispatch', async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      mcpServers: {},
    } as any);
    const events: Array<{ channel: string; data: any; scope: any }> = [];
    setElectronBroadcaster((channel, data, scope) => {
      events.push({ channel, data, scope });
    });
    agentTabManager.bindThread({
      agentId: 'agent-close-cli',
      callerToken: 'agtok_close_cli_secret',
      workspacePath: '/workspace/close-cli',
    });

    const toolManager = new ToolManager();
    const result = await toolManager.callTool(
      'builtin-agent-windows',
      'close_agent_window',
      {
        agent_id: 'agent-close-cli',
      },
      false,
      'agent-overlay',
      { threadId: 'thread-overlay', workspace: '/workspace/close-cli' },
      undefined,
      { includeHiddenBuiltins: true },
    );
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(JSON.parse(text).agent_id).toBe('agent-close-cli');
    expect(events[0]).toMatchObject({
      channel: 'workstation:close-tab',
      data: { id: 'agent-close-cli' },
      scope: { workspacePath: '/workspace/close-cli' },
    });
    expect(text).not.toContain('agtok_close_cli_secret');
  });

  test('close_agent_window fails loudly for unknown agent ids', async () => {
    const result = await closeAgentWindowTool.handler({
      agent_id: 'agent-missing',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('No Interpreter agent window is registered for agent_id="agent-missing".');
  });

  test('awaits a matching agent completion event and returns safe completion metadata', async () => {
    const taskPromise = agentTabManager.createAgentTask({
      initialMessage: 'Finish this task.',
      agentId: 'agent-await',
      callerToken: 'agtok_await_secret',
      threadId: 'thread-await',
      timeout: 1_000,
    });
    const [pendingRequest] = agentTabManager.getPendingRequests();
    expect(pendingRequest).toBeDefined();
    agentTabManager.onTabCreated(pendingRequest!.requestId, 'agent-await');
    await taskPromise;

    const awaitPromise = awaitAgentWindowTool.handler({
      agent_id: 'agent-await',
      thread_id: 'thread-await',
      timeout_ms: 1_000,
    });
    setTimeout(() => {
      agentTabManager.onTabCompleted(
        pendingRequest!.requestId,
        [{ role: 'assistant', content: 'Done from the windowed agent.' }],
        undefined,
        'thread-await',
      );
    }, 0);

    const result = await awaitPromise;
    const text = result.content[0]?.text ?? '';
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload).toEqual({
      agent_id: 'agent-await',
      thread_id: 'thread-await',
      request_id: pendingRequest!.requestId,
      startup_id: null,
      status: 'completed',
      error: null,
      message_count: 1,
      latest_assistant_text: 'Done from the windowed agent.',
    });
    expect(text).not.toContain('agtok_await_secret');
  });

  test('await_agent_window fails loudly for unknown agent ids', async () => {
    const result = await awaitAgentWindowTool.handler({
      agent_id: 'agent-missing',
      timeout_ms: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('No Interpreter agent window is registered for agent_id="agent-missing".');
  });
});
