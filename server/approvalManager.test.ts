import { beforeEach, describe, expect, test } from 'bun:test';
import { approvalManager } from './approvalManager';
import { agentTabManager } from './agentTabManager';
import { clearPendingToolCalls, rememberToolCallMetadata } from './utils/codexMcpBridge';
import { setConfigOverride } from './configStore';

describe('approvalManager tool-call thread correlation', () => {
  beforeEach(() => {
    approvalManager.setAutoApprove(false);
    approvalManager.clearAll();
    agentTabManager.clearAll();
    clearPendingToolCalls();
    setConfigOverride({ agents: {} } as any);
  });

  test('should_attach_thread_id_from_tool_call_metadata_to_new_approvals', async () => {
    rememberToolCallMetadata('call_approval_1', { threadId: 'thr-approval-1' });

    const pending = approvalManager.createApproval(
      'test_approval',
      'builtin-test-approval',
      { message: 'Needs approval' },
      0,
      'call_approval_1',
    );

    const [request] = approvalManager.getApprovals();
    expect(request?.toolCallId).toBe('call_approval_1');
    expect(request?.context?.threadId).toBe('thr-approval-1');

    approvalManager.approve(request!.id);
    await expect(pending).resolves.toBe(true);
  });

  test('should_not_auto_approve_simple_test_approvals_when_auto_approve_mode_is_enabled', async () => {
    approvalManager.setAutoApprove(true);

    const pending = approvalManager.createApproval(
      'test_approval',
      'builtin-test-approval',
      { message: 'Needs approval' },
      0,
    );

    const [request] = approvalManager.getApprovals();
    expect(request?.toolName).toBe('test_approval');
    expect(request?.isSimpleApproval).toBe(true);

    approvalManager.approve(request!.id);
    await expect(pending).resolves.toBe(true);
  });

  test('should_capture_agent_permission_owner_snapshot_on_new_approvals', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-owner',
      callerToken: 'caller-owner',
      threadId: 'thread-owner',
      windowSessionKey: 'window-owner',
      workspacePath: '/workspace-owner',
      allowedToolNames: ['builtin-cua-driver/list_windows', 'builtin-cua-driver/list_windows'],
      toolProfileId: 'profile-owner',
    });

    const pending = approvalManager.createApproval(
      'cua_driver:inspect:Calculator',
      'builtin-cua-driver',
      { message: 'Inspect Calculator' },
      0,
      'call_owner',
      'agent-owner',
    );

    const [request] = approvalManager.getApprovals();
    expect(request?.owner?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(request?.owner).toEqual({
      approvalOwnerKind: 'normal-agent',
      capturedAt: expect.any(Number),
      displayName: 'Interpreter agent (profile-owner)',
      color: request?.owner?.color,
      identity: {
        agentId: 'agent-owner',
        threadId: 'thread-owner',
        windowSessionKey: 'window-owner',
        workspacePath: '/workspace-owner',
        allowedToolNames: ['builtin-cua-driver/list_windows'],
        toolProfileId: 'profile-owner',
      },
    });
    expect(JSON.stringify(request)).not.toContain('caller-owner');

    approvalManager.approve(request!.id);
    await expect(pending).resolves.toBe(true);
  });

  test('should_capture_cli_owner_snapshot_without_agent_binding', async () => {
    const pending = approvalManager.createApproval(
      'test_approval',
      'builtin-test-approval',
      { message: 'Needs approval' },
      0,
    );

    const [request] = approvalManager.getApprovals();
    expect(request?.owner?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(request?.owner).toEqual({
      approvalOwnerKind: 'cli',
      capturedAt: expect.any(Number),
      displayName: 'Interpreter CLI',
      color: request?.owner?.color,
      identity: {
        agentId: null,
        windowSessionKey: null,
        workspacePath: null,
      },
    });

    approvalManager.approve(request!.id);
    await expect(pending).resolves.toBe(true);
  });

  test('should_queue_normal_overlay_and_hidden_permissions_through_the_same_request_model', async () => {
    const overlayParentOwner = {
      approvalOwnerKind: 'overlay-agent' as const,
      agentId: 'overlay-agent-unified',
      threadId: 'thread-overlay-unified',
      windowSessionKey: 'window-unified',
      workspacePath: '/workspace-unified',
      toolProfileId: 'profile-overlay-unified',
    };
    agentTabManager.bindThread({
      agentId: 'agent-unified-normal',
      callerToken: 'caller-unified-normal',
      threadId: 'thread-normal-unified',
      windowSessionKey: 'window-unified',
      workspacePath: '/workspace-unified',
      allowedToolNames: ['builtin-cua-driver/list_windows'],
      toolProfileId: 'profile-normal-unified',
    });
    agentTabManager.bindThread({
      ...overlayParentOwner,
      callerToken: 'caller-unified-overlay',
    });
    agentTabManager.bindThread({
      agentId: 'codex-agent-unified-hidden',
      callerToken: 'caller-unified-hidden',
      threadId: 'thread-hidden-unified',
      windowSessionKey: 'window-unified',
      workspacePath: '/workspace-unified',
      allowedToolNames: ['builtin-cua-driver/list_windows'],
      toolProfileId: 'profile-hidden-unified',
      parentOwner: overlayParentOwner,
    });

    const normal = approvalManager.createApproval(
      'cua_driver:inspect:Finder',
      'builtin-cua-driver',
      { message: 'Normal agent inspect request' },
      0,
      'call_unified_normal',
      'agent-unified-normal',
    );
    const overlay = approvalManager.createApproval(
      'cua_driver:inspect:OverlayTarget',
      'builtin-cua-driver',
      { message: 'Overlay inspect request' },
      0,
      'call_unified_overlay',
      overlayParentOwner.agentId,
    );
    const hidden = approvalManager.createApproval(
      'cua_driver:inspect:HiddenTarget',
      'builtin-cua-driver',
      { message: 'Hidden agent inspect request' },
      0,
      'call_unified_hidden',
      'codex-agent-unified-hidden',
    );

    const requests = approvalManager.getApprovals();
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.serverId)).toEqual([
      'builtin-cua-driver',
      'builtin-cua-driver',
      'builtin-cua-driver',
    ]);
    expect(requests.every((request) => request.isSimpleApproval)).toBe(true);
    expect(requests.every((request) => (
      request.questions[0]?.options.map((option) => option.value).join(',') === 'approve,deny'
    ))).toBe(true);

    const byAgentId = new Map(requests.map((request) => [request.agentId, request]));
    expect(byAgentId.get('agent-unified-normal')?.owner?.approvalOwnerKind).toBe('normal-agent');
    expect(byAgentId.get(overlayParentOwner.agentId)?.owner?.approvalOwnerKind).toBe('overlay-agent');
    expect(byAgentId.get('codex-agent-unified-hidden')?.owner?.approvalOwnerKind).toBe('hidden-agent');
    expect(byAgentId.get('codex-agent-unified-hidden')?.owner?.identity.parentOwner).toEqual(overlayParentOwner);
    expect(byAgentId.get(overlayParentOwner.agentId)?.owner?.displayName).toBe('Interpreter Overlay');

    const overlayProjection = approvalManager.getApprovalsForOverlayAgents({
      agentIds: [overlayParentOwner.agentId, 'codex-agent-unified-hidden'],
    });
    expect(overlayProjection.map((request) => request.id)).toEqual([
      byAgentId.get(overlayParentOwner.agentId)?.id,
      byAgentId.get('codex-agent-unified-hidden')?.id,
    ]);

    expect(JSON.stringify(requests)).not.toContain('caller-unified-normal');
    expect(JSON.stringify(requests)).not.toContain('caller-unified-overlay');
    expect(JSON.stringify(requests)).not.toContain('caller-unified-hidden');

    for (const request of requests) {
      approvalManager.approve(request.id);
    }
    await expect(Promise.all([normal, overlay, hidden])).resolves.toEqual([true, true, true]);
  });

  test('should_keep_owner_color_stable_for_the_same_permission_owner', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-color-owner',
      callerToken: 'caller-color-owner',
      threadId: 'thread-color-owner',
      windowSessionKey: 'window-color-owner',
      workspacePath: '/workspace-color-owner',
      toolProfileId: 'profile-color-owner',
    });

    const first = approvalManager.createApproval(
      'test_approval',
      'builtin-test-approval',
      { message: 'Needs approval' },
      0,
      'call_color_first',
      'agent-color-owner',
    );
    const second = approvalManager.createApproval(
      'test_approval',
      'builtin-test-approval',
      { message: 'Needs approval again' },
      0,
      'call_color_second',
      'agent-color-owner',
    );

    const [firstRequest, secondRequest] = approvalManager.getApprovals();
    expect(firstRequest?.owner?.color).toBe(secondRequest?.owner?.color);

    approvalManager.approve(firstRequest!.id);
    approvalManager.approve(secondRequest!.id);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  test('should_replace_same_owner_same_tool_pending_question_with_matching_replacement_key', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-replacement-owner',
      callerToken: 'caller-replacement-owner',
      threadId: 'thread-replacement-owner',
      windowSessionKey: 'window-replacement-owner',
      workspacePath: '/workspace-replacement-owner',
      toolProfileId: 'profile-replacement-owner',
    });

    const first = approvalManager.createQuestion(
      'permission_card:calendar_event',
      'builtin-permission-cards',
      [
        {
          question: 'Create the calendar event?',
          options: [
            { label: 'Create', value: 'create' },
            { label: 'Cancel', value: 'cancel' },
          ],
        },
      ],
      { message: 'Create a calendar event for Tuesday.' },
      0,
      'call_replacement_first',
      false,
      'agent-replacement-owner',
      'calendar-event-draft',
    );

    const [firstRequest] = approvalManager.getApprovals();
    expect(firstRequest?.replacementKey).toBe('calendar-event-draft');
    expect(firstRequest?.context?.message).toBe('Create a calendar event for Tuesday.');

    const second = approvalManager.createQuestion(
      'permission_card:calendar_event',
      'builtin-permission-cards',
      [
        {
          question: 'Create the updated calendar event?',
          options: [
            { label: 'Create', value: 'create' },
            { label: 'Cancel', value: 'cancel' },
          ],
        },
      ],
      { message: 'Create a calendar event for Tuesday at 4 PM.' },
      0,
      'call_replacement_second',
      false,
      'agent-replacement-owner',
      'calendar-event-draft',
    );

    const [secondRequest] = approvalManager.getApprovals();
    expect(approvalManager.getApprovals()).toHaveLength(1);
    expect(secondRequest?.id).not.toBe(firstRequest?.id);
    expect(secondRequest?.replacementKey).toBe('calendar-event-draft');
    expect(secondRequest?.context?.message).toBe('Create a calendar event for Tuesday at 4 PM.');
    await expect(first).resolves.toEqual({
      answers: {},
      superseded: true,
      supersededBy: secondRequest?.id,
    });

    approvalManager.respond(secondRequest!.id, { answers: { '0': 'create' } });
    await expect(second).resolves.toEqual({ answers: { '0': 'create' } });
  });

  test('should_auto_approve_low_risk_image_generation_cards_when_setting_is_enabled', async () => {
    setConfigOverride({
      agents: {},
      autoApproveLowRiskMediaCards: true,
    } as any);

    const pending = approvalManager.createApproval(
      'media_ai:generate_image',
      'builtin-media-ai',
      {
        message: 'Generate a mossy grass texture.',
        permissionCard: {
          version: 1,
          intent: 'image-generation',
          risk: 'low',
          blocks: [
            { type: 'text', text: 'Generate a mossy grass texture.' },
          ],
        },
      },
      0,
      'call_low_risk_media_card',
      'agent-media-card',
    );

    expect(approvalManager.getApprovals()).toHaveLength(0);
    await expect(pending).resolves.toBe(true);
  });

  test('should_queue_low_risk_image_generation_cards_when_setting_is_disabled', async () => {
    const pending = approvalManager.createApproval(
      'media_ai:generate_image',
      'builtin-media-ai',
      {
        message: 'Generate a mossy grass texture.',
        permissionCard: {
          version: 1,
          intent: 'image-generation',
          risk: 'low',
          blocks: [
            { type: 'text', text: 'Generate a mossy grass texture.' },
          ],
        },
      },
      0,
      'call_low_risk_media_card_disabled',
      'agent-media-card',
    );

    const [request] = approvalManager.getApprovals();
    expect(request?.toolName).toBe('media_ai:generate_image');

    approvalManager.approve(request!.id);
    await expect(pending).resolves.toBe(true);
  });

  test('should_not_auto_approve_media_cards_without_explicit_low_risk_image_intent', async () => {
    setConfigOverride({
      agents: {},
      autoApproveLowRiskMediaCards: true,
    } as any);

    const pending = approvalManager.createApproval(
      'media_ai:generate_image',
      'builtin-media-ai',
      {
        message: 'Generate a high-risk image.',
        permissionCard: {
          version: 1,
          intent: 'image-generation',
          risk: 'high',
          blocks: [
            { type: 'text', text: 'Generate a high-risk image.' },
          ],
        },
      },
      0,
      'call_high_risk_media_card',
      'agent-media-card',
    );

    const [request] = approvalManager.getApprovals();
    expect(request?.context?.permissionCard?.risk).toBe('high');

    approvalManager.deny(request!.id);
    await expect(pending).resolves.toBe(false);
  });

  test('should_not_replace_matching_replacement_key_from_a_different_agent', async () => {
    agentTabManager.bindThread({
      agentId: 'agent-replacement-one',
      callerToken: 'caller-replacement-one',
      threadId: 'thread-replacement-one',
      windowSessionKey: 'window-replacement',
      workspacePath: '/workspace-replacement',
      toolProfileId: 'profile-replacement',
    });
    agentTabManager.bindThread({
      agentId: 'agent-replacement-two',
      callerToken: 'caller-replacement-two',
      threadId: 'thread-replacement-two',
      windowSessionKey: 'window-replacement',
      workspacePath: '/workspace-replacement',
      toolProfileId: 'profile-replacement',
    });

    const first = approvalManager.createQuestion(
      'permission_card:calendar_event',
      'builtin-permission-cards',
      [{
        question: 'Create the event?',
        options: [
          { label: 'Create', value: 'create' },
          { label: 'Cancel', value: 'cancel' },
        ],
      }],
      { message: 'Agent one event.' },
      0,
      'call_replacement_agent_one',
      false,
      'agent-replacement-one',
      'calendar-event-draft',
    );
    const second = approvalManager.createQuestion(
      'permission_card:calendar_event',
      'builtin-permission-cards',
      [{
        question: 'Create the event?',
        options: [
          { label: 'Create', value: 'create' },
          { label: 'Cancel', value: 'cancel' },
        ],
      }],
      { message: 'Agent two event.' },
      0,
      'call_replacement_agent_two',
      false,
      'agent-replacement-two',
      'calendar-event-draft',
    );

    const requests = approvalManager.getApprovals();
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.agentId)).toEqual([
      'agent-replacement-one',
      'agent-replacement-two',
    ]);

    approvalManager.respond(requests[0]!.id, { answers: { '0': 'create' } });
    approvalManager.respond(requests[1]!.id, { answers: { '0': 'create' } });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { answers: { '0': 'create' } },
      { answers: { '0': 'create' } },
    ]);
  });

  test('should_include_parent_owner_on_delegated_agent_approvals', async () => {
    agentTabManager.bindThread({
      agentId: 'codex-agent-hidden',
      callerToken: 'caller-hidden',
      threadId: 'thread-hidden',
      windowSessionKey: 'window-hidden',
      workspacePath: '/workspace-hidden',
      toolProfileId: 'profile-hidden',
      parentOwner: {
        approvalOwnerKind: 'overlay-agent',
        agentId: 'overlay-agent-parent',
        threadId: 'thread-parent',
        windowSessionKey: 'window-parent',
        workspacePath: '/workspace-parent',
        toolProfileId: 'profile-parent',
      },
    });

    const pending = approvalManager.createApproval(
      'cua_driver:control:Calculator',
      'builtin-cua-driver',
      { message: 'Control Calculator' },
      0,
      'call_hidden_parent',
      'codex-agent-hidden',
    );

    const [request] = approvalManager.getApprovals();
    expect(request?.owner?.approvalOwnerKind).toBe('hidden-agent');
    expect(request?.owner?.identity.parentOwner).toEqual({
      approvalOwnerKind: 'overlay-agent',
      agentId: 'overlay-agent-parent',
      threadId: 'thread-parent',
      windowSessionKey: 'window-parent',
      workspacePath: '/workspace-parent',
      toolProfileId: 'profile-parent',
    });
    expect(JSON.stringify(request)).not.toContain('caller-hidden');

    approvalManager.approve(request!.id);
    await expect(pending).resolves.toBe(true);
  });

  test('should_capture_extension_backed_action_owner_snapshot', async () => {
    agentTabManager.bindThread({
      agentId: 'extension-action-chrome-tab',
      callerToken: 'caller-extension-action',
      threadId: 'thread-extension-action',
      windowSessionKey: 'window-extension-action',
      workspacePath: '/workspace-extension-action',
      allowedToolNames: ['builtin-browser-control/read_tab'],
      toolProfileId: 'chrome-profile',
    });

    const pending = approvalManager.createApproval(
      'browser_control:read:tab',
      'builtin-browser-control',
      { message: 'Read the current Chrome tab' },
      0,
      'call_extension_action',
      'extension-action-chrome-tab',
    );

    const [request] = approvalManager.getApprovals();
    expect(request?.owner?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(request?.owner).toEqual({
      approvalOwnerKind: 'extension-action',
      capturedAt: expect.any(Number),
      displayName: 'Interpreter extension (chrome-profile)',
      color: request?.owner?.color,
      identity: {
        agentId: 'extension-action-chrome-tab',
        threadId: 'thread-extension-action',
        windowSessionKey: 'window-extension-action',
        workspacePath: '/workspace-extension-action',
        allowedToolNames: ['builtin-browser-control/read_tab'],
        toolProfileId: 'chrome-profile',
      },
    });
    expect(JSON.stringify(request)).not.toContain('caller-extension-action');

    approvalManager.approve(request!.id);
    await expect(pending).resolves.toBe(true);
  });

  test('should_apply_session_approval_to_matching_pending_requests', async () => {
    const first = approvalManager.createSessionAwareApproval(
      'cua_driver:inspect:Calculator',
      'builtin-cua-driver',
      { message: 'Inspect Calculator' },
      'Interpreter can inspect Calculator.',
      0,
      'call_first',
      'agent_approval',
    );
    const second = approvalManager.createSessionAwareApproval(
      'cua_driver:inspect:Calculator',
      'builtin-cua-driver',
      { message: 'Inspect Calculator again' },
      'Interpreter can inspect Calculator.',
      0,
      'call_second',
      'agent_approval',
    );

    const [request] = approvalManager.getApprovals();
    expect(approvalManager.getApprovals()).toHaveLength(2);

    const response = approvalManager.respond(request!.id, {
      answers: { '0': 'approve' },
      approvalMode: 'session',
    });

    expect(response).toEqual({ success: true });
    expect(approvalManager.getApprovals()).toHaveLength(0);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { approved: true, mode: 'session' },
      { approved: true, mode: 'session' },
    ]);
  });

  test('should_apply_hidden_agent_session_approval_to_parent_owner', async () => {
    const parentOwner = {
      approvalOwnerKind: 'overlay-agent' as const,
      agentId: 'overlay-agent-session-parent',
      threadId: 'thread-session-parent',
      windowSessionKey: 'window-session-parent',
      workspacePath: '/workspace-session-parent',
      toolProfileId: 'profile-session-parent',
    };
    agentTabManager.bindThread({
      agentId: parentOwner.agentId,
      callerToken: 'caller-session-parent',
      threadId: parentOwner.threadId,
      windowSessionKey: parentOwner.windowSessionKey,
      workspacePath: parentOwner.workspacePath,
      toolProfileId: parentOwner.toolProfileId,
    });
    agentTabManager.bindThread({
      agentId: 'codex-agent-session-hidden',
      callerToken: 'caller-session-hidden',
      threadId: 'thread-session-hidden',
      windowSessionKey: 'window-session-hidden',
      workspacePath: '/workspace-session-hidden',
      toolProfileId: 'profile-session-hidden',
      parentOwner,
    });

    const hiddenApproval = approvalManager.createSessionAwareApproval(
      'cua_driver:control:Calculator',
      'builtin-cua-driver',
      { message: 'Control Calculator from hidden agent' },
      'Interpreter can control Calculator.',
      0,
      'call_hidden_session',
      'codex-agent-session-hidden',
    );
    const [hiddenRequest] = approvalManager.getApprovals();
    approvalManager.respond(hiddenRequest!.id, {
      answers: { '0': 'approve' },
      approvalMode: 'session',
    });

    const parentApproval = approvalManager.createSessionAwareApproval(
      'cua_driver:control:Calculator',
      'builtin-cua-driver',
      { message: 'Control Calculator from parent overlay' },
      'Interpreter can control Calculator.',
      0,
      'call_parent_session',
      parentOwner.agentId,
    );

    expect(approvalManager.getApprovals()).toHaveLength(0);
    await expect(hiddenApproval).resolves.toEqual({ approved: true, mode: 'session' });
    await expect(parentApproval).resolves.toEqual({ approved: true, mode: 'session' });
  });

  test('should_use_session_approval_for_next_matching_request_immediately', async () => {
    const first = approvalManager.createSessionAwareApproval(
      'cua_driver:discover:list_windows',
      'builtin-cua-driver',
      { message: 'List windows' },
      'Interpreter can list windows.',
      0,
      'call_first',
      'agent_approval',
    );

    const [request] = approvalManager.getApprovals();
    approvalManager.respond(request!.id, {
      answers: { '0': 'approve' },
      approvalMode: 'session',
    });

    const next = approvalManager.createSessionAwareApproval(
      'cua_driver:discover:list_windows',
      'builtin-cua-driver',
      { message: 'List windows again' },
      'Interpreter can list windows.',
      0,
      'call_second',
      'agent_approval',
    );

    expect(approvalManager.getApprovals()).toHaveLength(0);
    await expect(first).resolves.toEqual({ approved: true, mode: 'session' });
    await expect(next).resolves.toEqual({ approved: true, mode: 'session' });
  });

  test('should_not_apply_session_approval_after_owner_workspace_changes', async () => {
    agentTabManager.bindThread({
      agentId: 'agent_workspace_scope',
      callerToken: 'caller_workspace_scope',
      threadId: 'thread-workspace-a',
      workspacePath: '/workspace-a',
    });
    const first = approvalManager.createSessionAwareApproval(
      'cua_driver:inspect:Calculator',
      'builtin-cua-driver',
      { message: 'Inspect Calculator' },
      'Interpreter can inspect Calculator.',
      0,
      'call_workspace_a',
      'agent_workspace_scope',
    );

    const [firstRequest] = approvalManager.getApprovals();
    approvalManager.respond(firstRequest!.id, {
      answers: { '0': 'approve' },
      approvalMode: 'session',
    });
    await expect(first).resolves.toEqual({ approved: true, mode: 'session' });

    agentTabManager.bindThread({
      agentId: 'agent_workspace_scope',
      callerToken: 'caller_workspace_scope',
      threadId: 'thread-workspace-b',
      workspacePath: '/workspace-b',
    });
    const second = approvalManager.createSessionAwareApproval(
      'cua_driver:inspect:Calculator',
      'builtin-cua-driver',
      { message: 'Inspect Calculator in other workspace' },
      'Interpreter can inspect Calculator.',
      0,
      'call_workspace_b',
      'agent_workspace_scope',
    );

    const [secondRequest] = approvalManager.getApprovals();
    expect(secondRequest?.owner?.identity.workspacePath).toBe('/workspace-b');
    approvalManager.approve(secondRequest!.id);
    await expect(second).resolves.toEqual({ approved: true, mode: 'once' });
  });

  test('should_not_apply_session_approval_to_other_agents', async () => {
    const first = approvalManager.createSessionAwareApproval(
      'cua_driver:control:Calculator',
      'builtin-cua-driver',
      { message: 'Control Calculator' },
      'Interpreter can control Calculator.',
      0,
      'call_first',
      'agent_one',
    );
    const second = approvalManager.createSessionAwareApproval(
      'cua_driver:control:Calculator',
      'builtin-cua-driver',
      { message: 'Control Calculator' },
      'Interpreter can control Calculator.',
      0,
      'call_second',
      'agent_two',
    );

    const [request] = approvalManager.getApprovals();
    approvalManager.respond(request!.id, {
      answers: { '0': 'approve' },
      approvalMode: 'session',
    });

    expect(approvalManager.getApprovals()).toHaveLength(1);
    approvalManager.approve(approvalManager.getApprovals()[0]!.id);

    await expect(first).resolves.toEqual({ approved: true, mode: 'session' });
    await expect(second).resolves.toEqual({ approved: true, mode: 'once' });
  });
});
