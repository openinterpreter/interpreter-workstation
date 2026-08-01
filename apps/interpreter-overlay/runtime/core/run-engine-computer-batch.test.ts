import { describe, expect, it } from 'bun:test';
import { RunEngine } from './run-engine.js';
import type { ToolExecutionResult } from '../../shared/ports.js';

describe('RunEngine computer_batch review flow', () => {
  it('does not send an eager initial screenshot to the overlay agent in AX mode', async () => {
    let capturedInitialImageCapture: unknown = 'unset';
    const fakeAgentRun = {
      onBatchPreview: () => {},
      onToolCall: () => {},
      onDone: () => {},
      cancel: () => {},
    };
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        conversationId: 'conversation-1',
        currentScreenshotId: 'run-1/batch-0',
      },
      currentAgentRun: null,
      abortController: null,
      initialScreenOcrText: '<window><input id="name" /></window>',
      latestStructuredSnapshot: {
        formattedText: '<window><input id="name" /></window>',
        elements: [],
      },
      debugInitialUserText: null,
      awaitCurrentScreenshotBase64: async () => {
        throw new Error('AX mode should not eagerly capture a screenshot for run.start');
      },
      agent: {
        start: async (
          _conversationId: string,
          _userText: string,
          _abortSignal: AbortSignal,
          options?: { initialImageCapture?: unknown },
        ) => {
          capturedInitialImageCapture = options?.initialImageCapture;
          return fakeAgentRun;
        },
      },
      updateUI: () => {},
    };

    await (RunEngine.prototype as any).endRecording.call(fakeEngine, 'Fill this form.');

    expect(capturedInitialImageCapture).toBeUndefined();
  });

  it('stages batch actions for review instead of auto-executing them', async () => {
    const updateReasons: string[] = [];
    let resolvedResult: ToolExecutionResult | null = null;
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        actions: [],
        toolCallCount: 0,
      },
      pendingComputerBatch: null,
      ids: {
        uuid: () => 'action-1',
      },
      config: {
        autoAccept: false,
      },
      sessionAutoAccept: false,
      acceptAllThroughSeq: null,
      nextActionSeq: (RunEngine.prototype as any).nextActionSeq,
      getActionBySeq(seq: number) {
        return this.currentRun.actions.find((action: { seq: number }) => action.seq === seq) ?? null;
      },
      sortCurrentActions() {
        this.currentRun.actions.sort((left: { seq: number }, right: { seq: number }) => left.seq - right.seq);
      },
      applyVisionTypingAnchors() {},
      enrichPreviewActions: async () => {},
      updateUI(_executing = false, _anchorAction = null, reason = 'updateUI') {
        updateReasons.push(reason);
      },
      shouldAutoAcceptActions: (RunEngine.prototype as any).shouldAutoAcceptActions,
      batchControlPolicyAllowsAutoAccept: (RunEngine.prototype as any).batchControlPolicyAllowsAutoAccept,
      maybeFinalizePendingComputerBatch(trigger: string) {
        return (RunEngine.prototype as any).maybeFinalizePendingComputerBatch.call(this, trigger);
      },
      validateAndPrepareScrollAction: () => null,
      validateAndPrepareClickAction: () => null,
      validateAndPrepareHotkeyAction: () => null,
    };

    await (RunEngine.prototype as any).handleComputerBatchTool.call(
      fakeEngine,
      11,
      {
        actions: [
          {
            seq: 1,
            tool: {
              name: 'type',
              params: {
                element_id: 'name',
                element_description: 'Full Name',
                text: 'Jordan Lee',
              },
            },
          },
        ],
      },
      (result: ToolExecutionResult) => {
        resolvedResult = result;
      },
    );

    expect(fakeEngine.currentRun.actions).toHaveLength(1);
    expect(fakeEngine.currentRun.actions[0]?.decision).toBeUndefined();
    expect(fakeEngine.pendingComputerBatch).toEqual(expect.objectContaining({
      toolSeq: 11,
      previewBatchId: 'computer-batch-11',
      actionSeqs: [1],
    }));
    expect(updateReasons.at(-1)).toBe('computer-batch-staged');
    expect(resolvedResult).toBeNull();
  });

  function makePolicyGateFakeEngine(input: {
    controlPolicyMode: 'ask' | 'all';
    onResolveAppName: (appName: string) => void;
    onAutoAcceptLoop: () => void;
    updateReasons: string[];
  }) {
    return {
      currentRun: {
        id: 'run-1',
        actions: [] as Array<Record<string, unknown>>,
        toolCallCount: 0,
      },
      pendingComputerBatch: null,
      ids: {
        uuid: () => 'action-1',
      },
      config: {
        autoAccept: false,
        resolveControlPolicyMode: async (appName: string) => {
          input.onResolveAppName(appName);
          return input.controlPolicyMode;
        },
      },
      activeTargetIdentity: {
        app: { name: 'Google Chrome', pid: 4242, bundlePath: null },
      },
      sessionAutoAccept: false,
      acceptAllThroughSeq: null as number | null,
      nextActionSeq: (RunEngine.prototype as any).nextActionSeq,
      getActionBySeq(seq: number) {
        return this.currentRun.actions.find((action: { seq: number }) => action.seq === seq) ?? null;
      },
      sortCurrentActions() {
        this.currentRun.actions.sort((left: { seq: number }, right: { seq: number }) => left.seq - right.seq);
      },
      applyVisionTypingAnchors() {},
      enrichPreviewActions: async () => {},
      updateUI(_executing = false, _anchorAction = null, reason = 'updateUI') {
        input.updateReasons.push(reason);
      },
      shouldAutoAcceptActions: (RunEngine.prototype as any).shouldAutoAcceptActions,
      batchControlPolicyAllowsAutoAccept: (RunEngine.prototype as any).batchControlPolicyAllowsAutoAccept,
      prepareAcceptAllVisibleGroup: (RunEngine.prototype as any).prepareAcceptAllVisibleGroup,
      getActiveAction: (RunEngine.prototype as any).getActiveAction,
      getGhosts: () => [],
      actionNeedsEnrichmentBeforeReview: () => false,
      autoAcceptLoop: () => {
        input.onAutoAcceptLoop();
      },
      maybeFinalizePendingComputerBatch(trigger: string) {
        return (RunEngine.prototype as any).maybeFinalizePendingComputerBatch.call(this, trigger);
      },
      validateAndPrepareScrollAction: () => null,
      validateAndPrepareClickAction: () => null,
      validateAndPrepareHotkeyAction: () => null,
    };
  }

  const policyGateBatchParams = {
    actions: [
      {
        seq: 1,
        tool: {
          name: 'type',
          params: {
            element_id: 'name',
            element_description: 'Full Name',
            text: 'Jordan Lee',
          },
        },
      },
    ],
  };

  it('auto-accepts a staged batch without user acceptance when control policy is all', async () => {
    const updateReasons: string[] = [];
    const resolvedAppNames: string[] = [];
    let loopStarted = false;
    const fakeEngine = makePolicyGateFakeEngine({
      controlPolicyMode: 'all',
      onResolveAppName: (appName) => resolvedAppNames.push(appName),
      onAutoAcceptLoop: () => {
        loopStarted = true;
      },
      updateReasons,
    });

    await (RunEngine.prototype as any).handleComputerBatchTool.call(
      fakeEngine,
      11,
      policyGateBatchParams,
      () => {},
    );

    // The trace still stages and renders for review; only the acceptance gate
    // opens from the settings grant instead of a Ctrl press.
    expect(updateReasons.at(-1)).toBe('computer-batch-staged');
    expect(fakeEngine.pendingComputerBatch).toEqual(expect.objectContaining({
      previewBatchId: 'computer-batch-11',
    }));
    expect(resolvedAppNames).toEqual(['Google Chrome']);
    expect(fakeEngine.acceptAllThroughSeq).toBe(1);
    expect(loopStarted).toBe(true);
  });

  it('keeps waiting for user acceptance when control policy is ask', async () => {
    const updateReasons: string[] = [];
    let loopStarted = false;
    const fakeEngine = makePolicyGateFakeEngine({
      controlPolicyMode: 'ask',
      onResolveAppName: () => {},
      onAutoAcceptLoop: () => {
        loopStarted = true;
      },
      updateReasons,
    });

    await (RunEngine.prototype as any).handleComputerBatchTool.call(
      fakeEngine,
      11,
      policyGateBatchParams,
      () => {},
    );

    expect(updateReasons.at(-1)).toBe('computer-batch-staged');
    expect(fakeEngine.pendingComputerBatch).toEqual(expect.objectContaining({
      previewBatchId: 'computer-batch-11',
    }));
    expect(fakeEngine.acceptAllThroughSeq).toBeNull();
    expect(loopStarted).toBe(false);
    expect(fakeEngine.currentRun.actions[0]?.decision).toBeUndefined();
  });

  it('supersedes stale preview-only actions when the batch stages so review can activate', async () => {
    let uuidCounter = 0;
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        actions: [
          {
            id: 'preview-1',
            seq: 0,
            tool: 'type',
            params: { element_id: 'name', element_description: 'Full Name', text: 'Jordan Lee' },
            previewBatchId: 'agent-preview:0:0',
            dispatched: false,
          },
          {
            id: 'preview-2',
            seq: 1,
            tool: 'click',
            params: { element_id: 'submit', element_description: 'Submit' },
            previewBatchId: 'agent-preview:0:0',
            dispatched: false,
          },
        ],
        toolCallCount: 0,
      },
      pendingComputerBatch: null,
      ids: {
        uuid: () => `staged-${++uuidCounter}`,
      },
      config: {
        autoAccept: false,
      },
      sessionAutoAccept: false,
      acceptAllThroughSeq: null,
      nextActionSeq: (RunEngine.prototype as any).nextActionSeq,
      getActionBySeq(seq: number) {
        return this.currentRun.actions.find((action: { seq: number }) => action.seq === seq) ?? null;
      },
      sortCurrentActions() {
        this.currentRun.actions.sort((left: { seq: number }, right: { seq: number }) => left.seq - right.seq);
      },
      applyVisionTypingAnchors() {},
      enrichPreviewActions: async () => {},
      updateUI() {},
      shouldAutoAcceptActions: (RunEngine.prototype as any).shouldAutoAcceptActions,
      batchControlPolicyAllowsAutoAccept: (RunEngine.prototype as any).batchControlPolicyAllowsAutoAccept,
      maybeFinalizePendingComputerBatch(trigger: string) {
        return (RunEngine.prototype as any).maybeFinalizePendingComputerBatch.call(this, trigger);
      },
      validateAndPrepareScrollAction: () => null,
      validateAndPrepareClickAction: () => null,
      validateAndPrepareHotkeyAction: () => null,
      actionNeedsEnrichmentBeforeReview: () => false,
      getActiveAction(this: unknown) {
        return (RunEngine.prototype as any).getActiveAction.call(this);
      },
    };

    await (RunEngine.prototype as any).handleComputerBatchTool.call(
      fakeEngine,
      7,
      {
        actions: [
          {
            seq: 0,
            tool: {
              name: 'type',
              params: { element_id: 'name', element_description: 'Full Name', text: 'Jordan Lee' },
            },
          },
          {
            seq: 1,
            tool: {
              name: 'click',
              params: { element_id: 'submit', element_description: 'Submit' },
            },
          },
        ],
      },
      () => {},
    );

    const previewActions = fakeEngine.currentRun.actions.filter(
      (action: { id: string }) => action.id.startsWith('preview-'),
    ) as Array<{ decision?: string }>;
    expect(previewActions).toHaveLength(2);
    for (const previewAction of previewActions) {
      expect(previewAction.decision).toBe('system_cancelled');
    }

    // Review must surface the first staged batch action instead of stalling on
    // the undispatched preview ghosts.
    const active = fakeEngine.getActiveAction() as { id?: string; dispatched?: boolean } | null;
    expect(active?.id).toBe('staged-1');
    expect(active?.dispatched).toBe(true);
  });

  it('allocates fresh action seqs for later attached computer batches', async () => {
    let uuidCounter = 0;
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        actions: [
          {
            id: 'old-action-1',
            seq: 1,
            tool: 'click',
            params: {
              element_id: 'old',
              element_description: 'Old',
            },
            decision: 'approved',
          },
          {
            id: 'old-action-2',
            seq: 2,
            tool: 'click',
            params: {
              element_id: 'old-2',
              element_description: 'Old 2',
            },
            decision: 'approved',
          },
        ],
        toolCallCount: 1,
      },
      pendingComputerBatch: null,
      ids: {
        uuid: () => `new-action-${++uuidCounter}`,
      },
      config: {
        autoAccept: false,
      },
      sessionAutoAccept: false,
      acceptAllThroughSeq: null,
      nextActionSeq: (RunEngine.prototype as any).nextActionSeq,
      sortCurrentActions: (RunEngine.prototype as any).sortCurrentActions,
      applyVisionTypingAnchors() {},
      enrichPreviewActions: async () => {},
      updateUI() {},
      shouldAutoAcceptActions: (RunEngine.prototype as any).shouldAutoAcceptActions,
      batchControlPolicyAllowsAutoAccept: (RunEngine.prototype as any).batchControlPolicyAllowsAutoAccept,
      maybeFinalizePendingComputerBatch(trigger: string) {
        return (RunEngine.prototype as any).maybeFinalizePendingComputerBatch.call(this, trigger);
      },
      validateAndPrepareScrollAction: () => null,
      validateAndPrepareClickAction: () => null,
      validateAndPrepareHotkeyAction: () => null,
    };

    await (RunEngine.prototype as any).handleComputerBatchTool.call(
      fakeEngine,
      2,
      {
        actions: [
          {
            seq: 1,
            tool: {
              name: 'type',
              params: {
                text: 'crane',
              },
            },
          },
        ],
      },
      () => {},
    );

    expect(fakeEngine.currentRun.actions).toHaveLength(3);
    expect(fakeEngine.currentRun.actions[2]).toEqual(expect.objectContaining({
      seq: 3,
      tool: 'type',
      previewBatchId: 'computer-batch-2',
    }));
    expect(fakeEngine.currentRun.actions[2]?.decision).toBeUndefined();
    expect(fakeEngine.pendingComputerBatch).toEqual(expect.objectContaining({
      actionSeqs: [3],
      actionIds: [fakeEngine.currentRun.actions[2]?.id],
    }));
  });

  it('system-cancels a dispatched batch action with a stale element id instead of hanging', async () => {
    const action = {
      id: 'stale-action',
      seq: 1,
      tool: 'click',
      dispatched: true,
      params: {
        element_id: 'old-backspace-key',
      },
    };
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        currentScreenshotId: 'run-1/batch-1',
      },
      formFieldStore: new Map(),
      activeViewport: { x: 0, y: 0, width: 400, height: 300 },
      getActionElementTarget: (RunEngine.prototype as any).getActionElementTarget,
      tryPreviewEnrichAction: (RunEngine.prototype as any).tryPreviewEnrichAction,
    };

    await (RunEngine.prototype as any).tryPreviewEnrichAction.call(fakeEngine, action, null);

    expect(action.decision).toBe('system_cancelled');
    expect(action.error).toContain('old-backspace-key');
  });

  it('does not keep the previous working anchor visible while a new batch is pending preview', () => {
    let sentState: any = null;
    const previousAnchor = {
      id: 'old-action',
      seq: 1,
      tool: 'click',
      params: {},
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.2, y_max: 0.2 },
    };
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        actions: [
          {
            id: 'new-action',
            seq: 2,
            tool: 'click',
            params: { element_id: 'missing' },
            dispatched: true,
            previewBatchId: 'computer-batch-2',
          },
        ],
      },
      pendingComputerBatch: {
        previewBatchId: 'computer-batch-2',
      },
      workingAnchorAction: previousAnchor,
      currentAgentRun: null,
      attachedToolSessionActive: true,
      isProcessingApproval: false,
      computerBatchExecuting: false,
      acceptAllThroughSeq: null,
      sessionAutoAccept: false,
      ctrlPressed: false,
      shiftPressed: false,
      config: { autoAccept: false },
      getActiveAction: (RunEngine.prototype as any).getActiveAction,
      getGhosts: (RunEngine.prototype as any).getGhosts,
      getPreviewPlan: (RunEngine.prototype as any).getPreviewPlan,
      actionNeedsEnrichmentBeforeReview: (RunEngine.prototype as any).actionNeedsEnrichmentBeforeReview,
      actionIsReviewableWithoutBBox: (RunEngine.prototype as any).actionIsReviewableWithoutBBox,
      typeActionUsesFocusedControl: (RunEngine.prototype as any).typeActionUsesFocusedControl,
      getExecutingLabel: (RunEngine.prototype as any).getExecutingLabel,
      maybeFinalizePendingTerminalResult() {},
      logUiTiming() {},
      ui: {
        set(state: any) {
          sentState = state;
        },
      },
    };

    (RunEngine.prototype as any).updateUI.call(fakeEngine, false, null, 'pending-preview');

    expect(sentState.active).toBeNull();
    expect(fakeEngine.workingAnchorAction).toBeNull();
  });

  it('keeps the current working anchor visible while a reviewed computer batch action executes', () => {
    let sentState: any = null;
    const currentAnchor = {
      id: 'current-action',
      seq: 1,
      tool: 'click',
      params: {},
      bbox: { x_min: 0.1, y_min: 0.1, x_max: 0.2, y_max: 0.2 },
      previewBatchId: 'computer-batch-2',
      decision: 'approved',
    };
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        actions: [currentAnchor],
      },
      pendingComputerBatch: {
        previewBatchId: 'computer-batch-2',
      },
      workingAnchorAction: currentAnchor,
      currentAgentRun: null,
      attachedToolSessionActive: true,
      isProcessingApproval: true,
      computerBatchExecuting: true,
      acceptAllThroughSeq: null,
      sessionAutoAccept: false,
      ctrlPressed: false,
      shiftPressed: false,
      config: { autoAccept: false },
      getActiveAction: (RunEngine.prototype as any).getActiveAction,
      getGhosts: (RunEngine.prototype as any).getGhosts,
      getPreviewPlan: (RunEngine.prototype as any).getPreviewPlan,
      actionNeedsEnrichmentBeforeReview: (RunEngine.prototype as any).actionNeedsEnrichmentBeforeReview,
      actionIsReviewableWithoutBBox: (RunEngine.prototype as any).actionIsReviewableWithoutBBox,
      typeActionUsesFocusedControl: (RunEngine.prototype as any).typeActionUsesFocusedControl,
      getExecutingLabel: (RunEngine.prototype as any).getExecutingLabel,
      maybeFinalizePendingTerminalResult() {},
      logUiTiming() {},
      ui: {
        set(state: any) {
          sentState = state;
        },
      },
    };

    (RunEngine.prototype as any).updateUI.call(fakeEngine, true, currentAnchor, 'approval-start');

    expect(sentState.active).toBe(currentAnchor);
    expect(sentState.executing).toBe(true);
    expect(sentState.pill).toEqual({ kind: 'loading', label: 'Clicking...' });
  });

  it('replaces an unapproved pending computer batch with a newer proposal', () => {
    const updateReasons: string[] = [];
    let resolvedResult: ToolExecutionResult | null = null;
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        actions: [{
          id: 'action-1',
          seq: 1,
          tool: 'type',
          params: {
            element_id: 'name',
            element_description: 'Full Name',
            text: 'Jordan Lee',
          },
          previewBatchId: 'computer-batch-11',
          dispatched: true,
        }],
      },
      pendingComputerBatch: {
        toolSeq: 11,
        previewBatchId: 'computer-batch-11',
        actionSeqs: [1],
        actionIds: ['action-1'],
        startedAt: Date.now(),
        resolve: (result: ToolExecutionResult) => {
          resolvedResult = result;
        },
        actionTimings: [],
      },
      computerBatchExecuting: false,
      acceptAllThroughSeq: 1,
      queuedApprovalAfterProcessing: true,
      toolResolvers: new Map(),
      resolveToolText(seq: number, text: string) {
        this.toolResolvers.set(seq, text);
      },
      updateUI(_executing = false, _anchorAction = null, reason = 'updateUI') {
        updateReasons.push(reason);
      },
    };

    const replaced = (RunEngine.prototype as any).replacePendingComputerBatchForNewProposal.call(fakeEngine);

    expect(replaced).toBe(true);
    expect(fakeEngine.pendingComputerBatch).toBeNull();
    expect(fakeEngine.currentRun.actions).toHaveLength(0);
    expect(fakeEngine.acceptAllThroughSeq).toBeNull();
    expect(fakeEngine.queuedApprovalAfterProcessing).toBe(false);
    expect(updateReasons.at(-1)).toBe('computer-batch-replaced');
    expect(fakeEngine.toolResolvers.get(1)).toBe('Replaced by a newer computer_batch proposal.');
    expect(resolvedResult).toEqual(expect.objectContaining({
      kind: 'text',
      text: 'Replaced by a newer computer_batch proposal.',
    }));
  });

  it('resolves only after the reviewed batch actions are decided', async () => {
    let resolvedResult: ToolExecutionResult | null = null;
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        actions: [{
          id: 'action-1',
          seq: 1,
          tool: 'type',
          params: {
            element_id: 'name',
            element_description: 'Full Name',
            text: 'Jordan Lee',
          },
          previewBatchId: 'computer-batch-11',
          dispatched: true,
        }],
      },
      pendingComputerBatch: {
        toolSeq: 11,
        previewBatchId: 'computer-batch-11',
        actionSeqs: [1],
        startedAt: Date.now() - 25,
        resolve: (result: ToolExecutionResult) => {
          resolvedResult = result;
        },
        actionTimings: [],
      },
      computerBatchExecuting: false,
      workingAnchorAction: {
        id: 'action-1',
        seq: 1,
        tool: 'type',
        params: {},
      },
      getActionBySeq(seq: number) {
        return this.currentRun.actions.find((action: { seq: number }) => action.seq === seq) ?? null;
      },
      captureStructuredRefreshSnapshot: async () => ({
        formattedText: '<window><input name="Full Name">Jordan Lee</input></window>',
        elements: [],
      }),
      captureStructuredRefreshSnapshotWithTimeout(timeoutMs: number) {
        return (RunEngine.prototype as any).captureStructuredRefreshSnapshotWithTimeout.call(this, timeoutMs);
      },
    };

    await (RunEngine.prototype as any).maybeFinalizePendingComputerBatch.call(fakeEngine, 'pre-approval');
    expect(resolvedResult).toBeNull();

    fakeEngine.currentRun.actions[0].decision = 'approved';
    await (RunEngine.prototype as any).maybeFinalizePendingComputerBatch.call(fakeEngine, 'post-approval');

    expect(fakeEngine.pendingComputerBatch).toBeNull();
    expect(fakeEngine.workingAnchorAction).toBeNull();
    expect(resolvedResult).toEqual(expect.objectContaining({
      kind: 'structured-screen',
      snapshot: expect.objectContaining({
        formattedText: '<window><input name="Full Name">Jordan Lee</input></window>',
      }),
    }));
  });

  it('accepts the whole computer batch even when only part of it is currently visible', () => {
    const fakeEngine = {
      acceptAllThroughSeq: null,
      currentRun: {
        id: 'run-1',
        actions: [
          {
            id: 'action-1',
            seq: 1,
            tool: 'type',
            params: {},
            previewBatchId: 'computer-batch-11',
            dispatched: true,
            bbox: { x: 10, y: 10, width: 100, height: 20 },
          },
          {
            id: 'action-2',
            seq: 2,
            tool: 'type',
            params: {},
            previewBatchId: 'computer-batch-11',
            dispatched: true,
          },
          {
            id: 'action-3',
            seq: 3,
            tool: 'click',
            params: {},
            previewBatchId: 'computer-batch-11',
            dispatched: true,
          },
        ],
      },
      pendingComputerBatch: {
        toolSeq: 11,
        previewBatchId: 'computer-batch-11',
        actionSeqs: [1, 2, 3],
        actionIds: ['action-1', 'action-2', 'action-3'],
        startedAt: Date.now(),
        resolve: () => {},
        actionTimings: [],
      },
      getActiveAction() {
        return this.currentRun.actions[0];
      },
      getGhosts() {
        return [];
      },
      getActionBySeq(seq: number) {
        return this.currentRun.actions.find((action: { seq: number }) => action.seq === seq) ?? null;
      },
    };

    (RunEngine.prototype as any).prepareAcceptAllVisibleGroup.call(fakeEngine);

    expect(fakeEngine.acceptAllThroughSeq).toBe(3);
  });

  it('rejects computer batches that contain an invalid hotkey action', async () => {
    const updateReasons: string[] = [];
    let resolvedResult: ToolExecutionResult | null = null;
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        actions: [],
        toolCallCount: 0,
      },
      pendingComputerBatch: null,
      ids: {
        uuid: () => 'action-1',
      },
      config: {
        autoAccept: false,
      },
      sessionAutoAccept: false,
      acceptAllThroughSeq: null,
      nextActionSeq: (RunEngine.prototype as any).nextActionSeq,
      getActionBySeq(seq: number) {
        return this.currentRun.actions.find((action: { seq: number }) => action.seq === seq) ?? null;
      },
      sortCurrentActions() {
        this.currentRun.actions.sort((left: { seq: number }, right: { seq: number }) => left.seq - right.seq);
      },
      applyVisionTypingAnchors() {},
      enrichPreviewActions: async () => {},
      updateUI(_executing = false, _anchorAction = null, reason = 'updateUI') {
        updateReasons.push(reason);
      },
      shouldAutoAcceptActions: (RunEngine.prototype as any).shouldAutoAcceptActions,
      cancelComputerBatchValidationFailure(batchActions: Array<{ decision?: string; error?: string }>, action: { decision?: string; error?: string }, errorMessage: string) {
        batchActions.forEach((entry) => {
          entry.decision = 'system_cancelled';
          entry.error = errorMessage;
        });
        action.decision = 'system_cancelled';
        action.error = errorMessage;
      },
      validateAndPrepareScrollAction: () => null,
      validateAndPrepareClickAction: () => null,
      validateAndPrepareHotkeyAction: () => 'hotkey action requires a non-empty hotkey string',
    };

    await (RunEngine.prototype as any).handleComputerBatchTool.call(
      fakeEngine,
      12,
      {
        actions: [
          {
            seq: 1,
            tool: {
              name: 'hotkey',
              params: {},
            },
          },
        ],
      },
      (result: ToolExecutionResult) => {
        resolvedResult = result;
      },
    );

    // The rejection is marked as an error so bridge layers report an explicit
    // invalid-action status instead of a completed batch.
    expect(resolvedResult).toEqual({
      kind: 'text',
      text: 'hotkey action requires a non-empty hotkey string',
      isError: true,
    });
    expect(updateReasons.at(-1)).toBe('computer-batch-hotkey-invalid');
    expect(fakeEngine.pendingComputerBatch).toBeNull();
    expect(fakeEngine.currentRun.actions[0]).toEqual(expect.objectContaining({
      decision: 'system_cancelled',
      error: 'hotkey action requires a non-empty hotkey string',
    }));
  });

  it('does not trust an element id when the description names a different control', () => {
    const fakeEngine = Object.assign(Object.create(RunEngine.prototype), {
      activeViewport: { x: 0, y: 0, width: 800, height: 600 },
      resolveTypingTarget: (field: any) => field,
      normalizeDescription: (value: string | undefined) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      descriptionMatchesObservedLabel: (
        RunEngine.prototype as any
      ).descriptionMatchesObservedLabel,
      isGenericControlDescription: (label: string) => (
        RunEngine.prototype as any
      ).isGenericControlDescription.call({}, label),
      getScopedElementBBox: (field: any) => field.bbox,
      toScopedRelativeBBox: (bbox: any) => bbox,
    });
    const action = {
      seq: 7,
      tool: 'click',
      params: {
        element_id: 'routine-radio',
        element_description: 'UW approval',
      },
    };

    const applied = (RunEngine.prototype as any).tryApplyInstantMatch.call(fakeEngine, {
      action,
      field: {
        id: 'routine-radio',
        role: 'AXRadioButton',
        label: 'Routine',
        bbox: { x: 10, y: 10, width: 16, height: 16 },
      },
      query: 'UW approval',
      samplingScreenshotBase64: null,
      detectStart: Date.now(),
      elementId: 'routine-radio',
    });

    expect(applied).toBe(false);
    expect(action).not.toHaveProperty('bbox');
  });

  it('system-cancels an element-id action whose description conflicts with the observed label', async () => {
    const fakeEngine = Object.assign(Object.create(RunEngine.prototype), {
      currentRun: {
        id: 'run-1',
        actions: [],
      },
      activeViewport: { x: 0, y: 0, width: 800, height: 600 },
      formFieldStore: new Map([
        ['dscr-exception', {
          id: 'dscr-exception',
          role: 'AXCheckBox',
          label: 'DSCR below policy',
          value: '0',
          bbox: { x: 20, y: 20, width: 16, height: 16 },
        }],
      ]),
    });
    const action = {
      id: 'action-22',
      seq: 22,
      tool: 'click',
      params: {
        element_id: 'dscr-exception',
        element_description: 'DSRC below policy',
      },
      dispatched: true,
    };

    await (RunEngine.prototype as any).tryPreviewEnrichAction.call(fakeEngine, action, null);

    expect(action).toEqual(expect.objectContaining({
      decision: 'system_cancelled',
    }));
    expect(String((action as { error?: string }).error)).toContain('does not match element_description "DSRC below policy"');
    expect(action).not.toHaveProperty('bbox');
  });

  it('accepts a more specific description when the exact observed label is still present', () => {
    const fakeEngine = Object.assign(Object.create(RunEngine.prototype), {
      activeViewport: { x: 0, y: 0, width: 800, height: 600 },
      resolveTypingTarget: (field: any) => field,
      normalizeDescription: (value: string | undefined) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      descriptionMatchesObservedLabel: (
        RunEngine.prototype as any
      ).descriptionMatchesObservedLabel,
      isGenericControlDescription: (label: string) => (
        RunEngine.prototype as any
      ).isGenericControlDescription.call({}, label),
      getScopedElementBBox: (field: any) => field.bbox,
      toScopedRelativeBBox: (bbox: any) => bbox,
    });
    const action = {
      seq: 10,
      tool: 'type',
      params: {
        element_id: 'ordering-provider-npi',
        element_description: 'Ordering Provider NPI',
        text: '1558362891',
      },
    };

    const applied = (RunEngine.prototype as any).tryApplyInstantMatch.call(fakeEngine, {
      action,
      field: {
        id: 'ordering-provider-npi',
        role: 'AXTextField',
        label: 'NPI',
        bbox: { x: 20, y: 40, width: 300, height: 36 },
      },
      query: 'Ordering Provider NPI',
      samplingScreenshotBase64: null,
      detectStart: Date.now(),
      elementId: 'ordering-provider-npi',
    });

    expect(applied).toBe(true);
    expect(action).toHaveProperty('bbox', { x: 20, y: 40, width: 300, height: 36 });
  });

  it('accepts native CUA raw labels by their observed semantic text', () => {
    const fakeEngine = Object.assign(Object.create(RunEngine.prototype), {
      activeViewport: { x: 0, y: 0, width: 800, height: 600 },
      resolveTypingTarget: (field: any) => field,
      normalizeDescription: (value: string | undefined) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      descriptionMatchesObservedLabel: (
        RunEngine.prototype as any
      ).descriptionMatchesObservedLabel,
      isGenericControlDescription: (label: string) => (
        RunEngine.prototype as any
      ).isGenericControlDescription.call({}, label),
      getScopedElementBBox: (field: any) => field.bbox,
      toScopedRelativeBBox: (bbox: any) => bbox,
    });

    const cases = [
      {
        elementDescription: 'First Name',
        field: {
          id: 'element_index:1',
          role: 'AXTextField',
          label: '- [1] AXTextField (First Name) bounds={x=181, y=442, width=252, height=34, coordinate_space=screen_points} actions=[AXShowMenu, AXConfirm]',
          bbox: { x: 181, y: 442, width: 252, height: 34 },
        },
      },
      {
        elementDescription: 'AXTextField First Name',
        field: {
          id: 'element_index:1',
          role: 'AXTextField',
          label: '- [1] AXTextField (First Name) bounds={x=181, y=442, width=252, height=34, coordinate_space=screen_points} actions=[AXShowMenu, AXConfirm]',
          bbox: { x: 181, y: 442, width: 252, height: 34 },
        },
      },
      {
        elementDescription: 'Priority dropdown',
        field: {
          id: 'element_index:6',
          role: 'AXPopUpButton',
          label: '- [6] AXPopUpButton = "Standard" (Priority) bounds={x=781, y=516, width=252, height=34, coordinate_space=screen_points} actions=[AXShowMenu]',
          bbox: { x: 781, y: 516, width: 252, height: 34 },
        },
      },
      {
        elementDescription: '* Endorsement Type',
        field: {
          id: 'element_index:70',
          role: 'AXPopUpButton',
          label: '- [70] AXPopUpButton "* Endorsement Type" = "Select" bounds={x=609, y=484, width=342, height=28, coordinate_space=screen_points} actions=[AXScrollToVisible, AXShowMenu]',
          bbox: { x: 609, y: 484, width: 342, height: 28 },
        },
      },
      {
        elementDescription: 'Data migration checkbox',
        field: {
          id: 'element_index:10',
          role: 'AXCheckBox',
          label: '- [10] AXCheckBox "Data migration" bounds={x=431, y=680, width=182, height=26, coordinate_space=screen_points}',
          bbox: { x: 431, y: 680, width: 182, height: 26 },
        },
      },
      {
        elementDescription: 'Submit Intake button',
        field: {
          id: 'element_index:14',
          role: 'AXButton',
          label: '- [14] AXButton "Submit Intake" bounds={x=879, y=920, width=182, height=44, coordinate_space=screen_points}',
          bbox: { x: 879, y: 920, width: 182, height: 44 },
        },
      },
    ];

    for (const { elementDescription, field } of cases) {
      const action = {
        seq: 10,
        tool: 'type',
        params: {
          element_id: field.id,
          element_description: elementDescription,
          text: 'Nora',
        },
      };

      const applied = (RunEngine.prototype as any).tryApplyInstantMatch.call(fakeEngine, {
        action,
        field,
        query: elementDescription,
        samplingScreenshotBase64: null,
        detectStart: Date.now(),
        elementId: field.id,
      });

      expect(applied).toBe(true);
      expect(action).toHaveProperty('bbox', field.bbox);
    }
  });

  it('treats native CUA raw labels without semantic text as generic exact refs', () => {
    const fakeEngine = Object.assign(Object.create(RunEngine.prototype), {
      activeViewport: { x: 0, y: 0, width: 800, height: 600 },
      resolveTypingTarget: (field: any) => field,
      normalizeDescription: (value: string | undefined) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      descriptionMatchesObservedLabel: (
        RunEngine.prototype as any
      ).descriptionMatchesObservedLabel,
      isGenericControlDescription: (label: string) => (
        RunEngine.prototype as any
      ).isGenericControlDescription.call({}, label),
      getScopedElementBBox: (field: any) => field.bbox,
      toScopedRelativeBBox: (bbox: any) => bbox,
    });
    const action = {
      seq: 11,
      tool: 'type',
      params: {
        element_id: 'element_index:13',
        element_description: 'Intake Notes text area',
        text: 'Needs onboarding checklist',
      },
    };

    const applied = (RunEngine.prototype as any).tryApplyInstantMatch.call(fakeEngine, {
      action,
      field: {
        id: 'element_index:13',
        role: 'AXTextArea',
        label: '- [13] AXTextArea bounds={x=183, y=758, width=876, height=130, coordinate_space=screen_points} actions=[AXShowMenu]',
        bbox: { x: 183, y: 758, width: 876, height: 130 },
      },
      query: 'Intake Notes text area',
      samplingScreenshotBase64: null,
      detectStart: Date.now(),
      elementId: 'element_index:13',
    });

    expect(applied).toBe(true);
    expect(action).toHaveProperty('bbox', { x: 183, y: 758, width: 876, height: 130 });
  });

  it('trusts an exact element id when the runtime has no observed label to compare', () => {
    const fakeEngine = Object.assign(Object.create(RunEngine.prototype), {
      activeViewport: { x: 0, y: 0, width: 800, height: 600 },
      resolveTypingTarget: (field: any) => field,
      normalizeDescription: (value: string | undefined) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      descriptionMatchesObservedLabel: (
        RunEngine.prototype as any
      ).descriptionMatchesObservedLabel,
      isGenericControlDescription: (label: string) => (
        RunEngine.prototype as any
      ).isGenericControlDescription.call({}, label),
      getScopedElementBBox: (field: any) => field.bbox,
      toScopedRelativeBBox: (bbox: any) => bbox,
    });
    const action = {
      seq: 10,
      tool: 'type',
      params: {
        element_id: 'notes-entry',
        element_description: 'Intake Notes',
        text: 'Needs follow-up',
      },
    };

    const applied = (RunEngine.prototype as any).tryApplyInstantMatch.call(fakeEngine, {
      action,
      field: {
        id: 'notes-entry',
        role: 'AXTextArea',
        label: '',
        groupLabel: '',
        bbox: { x: 20, y: 40, width: 300, height: 100 },
      },
      query: 'Intake Notes',
      samplingScreenshotBase64: null,
      detectStart: Date.now(),
      elementId: 'notes-entry',
    });

    expect(applied).toBe(true);
    expect(action).toHaveProperty('bbox', { x: 20, y: 40, width: 300, height: 100 });
  });

  it('does not treat generic native control names as semantic label conflicts', () => {
    const fakeEngine = Object.assign(Object.create(RunEngine.prototype), {
      activeViewport: { x: 0, y: 0, width: 800, height: 600 },
      resolveTypingTarget: (field: any) => field,
      normalizeDescription: (value: string | undefined) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      descriptionMatchesObservedLabel: (
        RunEngine.prototype as any
      ).descriptionMatchesObservedLabel,
      isGenericControlDescription: (label: string) => (
        RunEngine.prototype as any
      ).isGenericControlDescription.call({}, label),
      getScopedElementBBox: (field: any) => field.bbox,
      toScopedRelativeBBox: (bbox: any) => bbox,
    });
    const action = {
      seq: 10,
      tool: 'type',
      params: {
        element_id: 'notes-entry',
        element_description: 'Intake Notes',
        text: 'Needs follow-up',
      },
    };

    const applied = (RunEngine.prototype as any).tryApplyInstantMatch.call(fakeEngine, {
      action,
      field: {
        id: 'notes-entry',
        role: 'AXTextArea',
        label: 'text entry area',
        groupLabel: '',
        bbox: { x: 20, y: 40, width: 300, height: 100 },
      },
      query: 'Intake Notes',
      samplingScreenshotBase64: null,
      detectStart: Date.now(),
      elementId: 'notes-entry',
    });

    expect(applied).toBe(true);
    expect(action).toHaveProperty('bbox', { x: 20, y: 40, width: 300, height: 100 });
  });

  it('targets the leading indicator for wide native checkbox rows', () => {
    const point = (RunEngine.prototype as any).getDefaultInteractionPoint.call(
      {},
      {
        id: 'billable',
        role: 'AXCheckBox',
        label: 'Client billable',
        bbox: { x: 431, y: 413, width: 232, height: 26 },
      },
      { x: 431, y: 413, width: 232, height: 26 },
    );

    expect(point).toEqual({ x: 444, y: 426 });
  });

  it('does not skip an earlier batch action while it is still awaiting enrichment', () => {
    const fakeEngine = {
      currentRun: {
        actions: [
          {
            id: 'type-not-ready',
            seq: 10,
            tool: 'type',
            dispatched: true,
            params: {
              element_id: 'notes',
              element_description: 'Notes',
              text: 'Needs follow-up',
            },
          },
          {
            id: 'submit-ready',
            seq: 11,
            tool: 'click',
            dispatched: true,
            params: {
              element_id: 'submit',
              element_description: 'Submit',
            },
            bbox: { x: 0.7, y: 0.8, width: 0.1, height: 0.05 },
          },
        ],
      },
      actionNeedsEnrichmentBeforeReview: (action: { bbox?: unknown }) => !action.bbox,
    };

    const active = (RunEngine.prototype as any).getActiveAction.call(fakeEngine);

    expect(active).toBeNull();
  });

  it('allows targetless type actions for the currently focused control', () => {
    const fakeEngine = {
      typeActionUsesFocusedControl: (RunEngine.prototype as any).typeActionUsesFocusedControl,
      actionIsReviewableWithoutBBox: (RunEngine.prototype as any).actionIsReviewableWithoutBBox,
    };
    const needsEnrichment = (RunEngine.prototype as any).actionNeedsEnrichmentBeforeReview.call(
      fakeEngine,
      {
        id: 'focused-type',
        seq: 1,
        tool: 'type',
        dispatched: true,
        params: {
          text: 'typed into focused control',
        },
      },
    );

    expect(needsEnrichment).toBe(false);
  });

  it('enables auto-accept for the active overlay session', () => {
    let loopStarted = false;
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        actions: [{
          id: 'action-1',
          seq: 1,
          tool: 'click',
          params: { element_id: 'submit', element_description: 'Submit' },
        }],
      },
      config: {
        autoAccept: false,
      },
      sessionAutoAccept: false,
      acceptAllThroughSeq: null,
      isProcessingApproval: false,
      getActiveAction() {
        return this.currentRun.actions[0] ?? null;
      },
      pendingComputerBatch: null,
      prepareAcceptAllVisibleGroup: (RunEngine.prototype as any).prepareAcceptAllVisibleGroup,
      getGhosts: () => [],
      autoAcceptLoop: () => {
        loopStarted = true;
      },
    };

    (RunEngine.prototype as any).handleAcceptAllForSessionRequest.call(fakeEngine);

    expect(fakeEngine.sessionAutoAccept).toBe(true);
    expect(fakeEngine.acceptAllThroughSeq).toBe(1);
    expect(loopStarted).toBe(true);
    expect((RunEngine.prototype as any).shouldAutoAcceptActions.call(fakeEngine)).toBe(true);
  });

  it('routes attached overlay tool calls through the shared dispatcher', async () => {
    const dispatched: Array<{ tool: { name: string }; seq: number }> = [];
    const fakeEngine = {
      currentRun: {
        id: 'run-1',
        actions: [],
        toolCallCount: 0,
      },
      attachedToolSessionActive: true,
      dispatchToolCall(
        tool: { name: string },
        seq: number,
        resolve: (result: ToolExecutionResult) => void,
      ) {
        dispatched.push({ tool, seq });
        resolve({
          kind: 'text',
          text: 'computer_batch completed successfully',
        });
      },
    };

    const result = await (RunEngine.prototype as any).runAttachedToolCall.call(fakeEngine, {
      name: 'computer_batch',
      params: {
        actions: [{
          seq: 1,
          tool: {
            name: 'type',
            params: {
              element_id: 'name',
              element_description: 'Full Name',
              text: 'Jordan Lee',
            },
          },
        }],
      },
    });

    expect(result).toEqual({
      success: true,
      result: {
        kind: 'text',
        text: 'computer_batch completed successfully',
      },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.tool.name).toBe('computer_batch');
    expect(dispatched[0]?.seq).toBe(1);
  });
});
