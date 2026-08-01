import { afterEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  overlaySessionManager,
  setOverlayComputerBatchRecaptureTimeoutMsForTest,
  type OverlaySessionDriver,
} from './overlaySessionManager';
import { OverlayInvalidBatchActionError } from '../apps/interpreter-overlay/shared/tool-results';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../apps/interpreter-overlay/shared/target-identity';
import type { OverlayRegionContextItem } from '../apps/interpreter-overlay/shared/ipc';

afterEach(() => {
  overlaySessionManager.setDriver(null);
  overlaySessionManager.clearAll();
});

describe('overlaySessionManager', () => {
  const targetIdentity = buildOverlayTargetIdentity({
    kind: 'screen-region',
    bounds: { x: 20, y: 30, width: 240, height: 160 },
    display: {
      id: 'display-1',
      boundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 2,
    },
    targetWindowSessionKey: 'window-session-1',
    generation: 1,
    now: 1000,
  });
  const currentSelectionContext = buildCurrentSelectionContext({
    targetIdentity,
    selectableRefs: [{
      id: '1',
      role: 'button',
      label: 'Save',
      bounds: { x: 40, y: 60, width: 80, height: 32 },
    }],
  });

  const initialContext = {
    agentMode: 'ax' as const,
    formattedText: '<button id="1">Save</button>',
    elementCount: 1,
    elements: [],
    screenshotBase64: 'abc123',
    captureBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
    targetIdentity,
    currentSelectionContext,
  };
  const targetContext: OverlayRegionContextItem = {
    id: 'target-context-1',
    kind: 'region',
    role: 'target',
    label: 'Selected app',
    scopeKind: 'screen-region',
    bounds: { x: 20, y: 30, width: 240, height: 160 },
    displayId: 'display-1',
    targetWindowSessionKey: 'window-session-1',
    targetIdentity,
    snapshot: currentSelectionContext,
    previewText: null,
    previewImageDataUrl: null,
  };

  function createDriver(recordBatch: () => void): OverlaySessionDriver {
    return {
      captureContext: async (session) => session.latestContext,
      computerBatch: async () => {
        recordBatch();
        return undefined;
      },
      click: async () => undefined,
      type: async () => undefined,
      hotkey: async () => undefined,
      scroll: async () => undefined,
      showDrawings: async () => undefined,
      clearDrawings: async () => undefined,
      detach: async () => undefined,
      complete: async () => undefined,
    };
  }

  test('returns a compact debug snapshot for an active agent session', () => {
    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      initialContext,
    });

    const snapshot = overlaySessionManager.getDebugSnapshotForAgent('overlay-agent-1');
    assert.ok(snapshot);
    assert.match(snapshot.id, /^overlay-session-/);
    assert.equal(typeof snapshot.createdAt, 'number');
    assert.equal(typeof snapshot.updatedAt, 'number');
    assert.deepEqual(snapshot, {
      id: snapshot.id,
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      status: 'active',
      targetContextId: null,
      initialElementCount: 1,
      latestElementCount: 1,
      initialCaptureBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      latestCaptureBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      initialTargetIdentityId: 'overlay-target-1',
      latestTargetIdentityId: 'overlay-target-1',
      initialCurrentSelectionId: 'selected-context-1',
      latestCurrentSelectionId: 'selected-context-1',
      initialCurrentSelectionGeneration: 1,
      latestCurrentSelectionGeneration: 1,
      hasInitialScreenshot: true,
      hasLatestScreenshot: true,
      initialScreenshotPath: null,
      latestScreenshotPath: null,
    });
  });

  test('returns null debug snapshots when the agent has no active overlay session', () => {
    assert.equal(overlaySessionManager.getDebugSnapshotForAgent('missing-agent'), null);
    assert.deepEqual(overlaySessionManager.getDebugSnapshots(), []);
  });

  test('computer_batch returns the touched-window diff of observed before/after state, index and bounds free', async () => {
    const afterSelectionContext = buildCurrentSelectionContext({
      targetIdentity,
      selectableRefs: [{
        id: 'element_index:9',
        role: 'AXTextField',
        label: '- [9] AXTextField "Full name" = "Ada Lovelace" bounds={x=40, y=60, width=80, height=32, coordinate_space=screen_points} [actions=[press]]',
        bounds: { x: 40, y: 60, width: 80, height: 32 },
      }],
    });
    overlaySessionManager.setDriver({
      ...createDriver(() => undefined),
      captureContext: async () => ({
        ...initialContext,
        formattedText: '<button id="1">Saved</button>',
        currentSelectionContext: afterSelectionContext,
      }),
    });
    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      initialContext: {
        ...initialContext,
        currentSelectionContext: buildCurrentSelectionContext({
          targetIdentity,
          selectableRefs: [{
            id: 'element_index:7',
            role: 'AXTextField',
            label: '- [7] AXTextField "Full name" bounds={x=40, y=60, width=80, height=32, coordinate_space=screen_points} [actions=[press]]',
            bounds: { x: 40, y: 60, width: 80, height: 32 },
          }],
        }),
      },
    });

    const outcome = await overlaySessionManager.computerBatch('overlay-agent-1', {
      actions: [{ seq: 1, tool: { name: 'hotkey', params: { hotkey: 'Enter' } } }],
    });

    assert.equal(outcome.touchedWindowDiff.changed, true);
    const refsWindow = outcome.touchedWindowDiff.windows.find(
      (window) => window.window === '(selected target refs)',
    );
    assert.ok(refsWindow);
    // Element index and bounds churn is excluded; the observed value change
    // is reported raw.
    assert.deepEqual(refsWindow.removedLines, [
      'ref role="AXTextField" label="AXTextField \\"Full name\\" [actions=[press]]"',
    ]);
    assert.deepEqual(refsWindow.addedLines, [
      'ref role="AXTextField" label="AXTextField \\"Full name\\" = \\"Ada Lovelace\\" [actions=[press]]"',
    ]);
  });

  test('allows element_id computer batches when the ref is in the current selected context', async () => {
    let batchCount = 0;
    overlaySessionManager.setDriver(createDriver(() => {
      batchCount += 1;
    }));
    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      initialContext,
    });

    await overlaySessionManager.computerBatch('overlay-agent-1', {
      actions: [{
        seq: 1,
        tool: {
          name: 'click',
          params: {
            element_id: '1',
          },
        },
      }],
    });

    assert.equal(batchCount, 1);
  });

  test('rejects readContext and screenshot while computer_batch is executing', async () => {
    let captureCount = 0;
    let releaseBatch!: () => void;
    const batchStarted = new Promise<void>((resolve) => {
      overlaySessionManager.setDriver({
        ...createDriver(() => undefined),
        captureContext: async () => {
          captureCount += 1;
          return {
            ...initialContext,
            elementCount: 0,
            formattedText: '',
          };
        },
        computerBatch: async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseBatch = release;
          });
          return undefined;
        },
      });
    });
    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      initialContext,
    });

    const batchPromise = overlaySessionManager.computerBatch('overlay-agent-1', {
      actions: [{
        seq: 1,
        tool: {
          name: 'click',
          params: {
            element_id: '1',
          },
        },
      }],
    });
    await batchStarted;

    await assert.rejects(
      overlaySessionManager.readContext('overlay-agent-1'),
      /Computer Use action batch is still in progress/,
    );
    await assert.rejects(
      overlaySessionManager.screenshot('overlay-agent-1'),
      /Computer Use action batch is still in progress/,
    );
    assert.equal(captureCount, 0);
    releaseBatch();
    await batchPromise;
    assert.equal(captureCount, 1);
  });

  test('keeps the attached target context available to refresh captures', async () => {
    const seenTargetContextIds: Array<string | null> = [];
    overlaySessionManager.setDriver({
      ...createDriver(() => undefined),
      captureContext: async (session) => {
        seenTargetContextIds.push(session.targetContext?.id ?? null);
        return session.latestContext;
      },
    });
    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      initialContext,
      targetContext,
    });

    const context = await overlaySessionManager.readContext('overlay-agent-1');

    assert.equal(context.elementCount, 1);
    assert.deepEqual(seenTargetContextIds, ['target-context-1']);
    assert.equal(
      overlaySessionManager.getDebugSnapshotForAgent('overlay-agent-1')?.targetContextId,
      'target-context-1',
    );
  });

  test('delegates visual-only drawings without refreshing context', async () => {
    const calls: string[] = [];
    overlaySessionManager.setDriver({
      ...createDriver(() => {
        calls.push('computerBatch');
      }),
      captureContext: async (session) => {
        calls.push('captureContext');
        return session.latestContext;
      },
      showDrawings: async (_session, request) => {
        calls.push(`show:${request.annotations.length}`);
      },
      clearDrawings: async () => {
        calls.push('clear');
      },
    });
    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      initialContext,
    });

    await overlaySessionManager.showDrawings('overlay-agent-1', {
      annotations: [{
        label: 'Target',
        bounds: { x: 40, y: 60, width: 80, height: 32 },
      }],
    });
    await overlaySessionManager.clearDrawings('overlay-agent-1');

    assert.deepEqual(calls, ['show:1', 'clear']);
  });

  test('refreshes the current selected context after computer batches and rejects refs that disappeared', async () => {
    const nextTargetIdentity = buildOverlayTargetIdentity({
      kind: 'screen-region',
      bounds: { x: 20, y: 30, width: 240, height: 160 },
      display: {
        id: 'display-1',
        boundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
        scaleFactor: 2,
      },
      targetWindowSessionKey: 'window-session-1',
      generation: 2,
      now: 2000,
    });
    const nextCurrentSelectionContext = buildCurrentSelectionContext({
      targetIdentity: nextTargetIdentity,
      selectableRefCount: 1,
    });
    let batchCount = 0;
    overlaySessionManager.setDriver({
      ...createDriver(() => {
        batchCount += 1;
      }),
      captureContext: async () => ({
        ...initialContext,
        targetIdentity: nextTargetIdentity,
        currentSelectionContext: nextCurrentSelectionContext,
      }),
    });
    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      initialContext,
    });

    await overlaySessionManager.computerBatch('overlay-agent-1', {
      actions: [{
        seq: 1,
        tool: {
          name: 'click',
          params: {
            element_id: '1',
          },
        },
      }],
    });

    assert.equal(
      overlaySessionManager.getDebugSnapshotForAgent('overlay-agent-1')?.latestCurrentSelectionGeneration,
      2,
    );
    await assert.rejects(
      overlaySessionManager.computerBatch('overlay-agent-1', {
        actions: [{
          seq: 2,
          tool: {
            name: 'click',
            params: {
              element_id: '1',
            },
          },
        }],
      }),
      /is not present in the current selected context/,
    );
    assert.equal(batchCount, 1);
  });

  test('rejects element_id values that are not in the current snapshot', async () => {
    let batchCount = 0;
    overlaySessionManager.setDriver(createDriver(() => {
      batchCount += 1;
    }));
    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      initialContext,
    });

    await assert.rejects(
      overlaySessionManager.computerBatch('overlay-agent-1', {
        actions: [{
          seq: 1,
          tool: {
            name: 'click',
            params: {
              element_id: 'missing-element',
            },
          },
        }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof OverlayInvalidBatchActionError);
        assert.match(error.message, /is not present in the current selected context/);
        return true;
      },
    );
    assert.equal(batchCount, 0);
  });

  test('fails the post-batch recapture loudly when it exceeds the hard timeout', async () => {
    setOverlayComputerBatchRecaptureTimeoutMsForTest(50);
    try {
      let batchCount = 0;
      overlaySessionManager.setDriver({
        ...createDriver(() => {
          batchCount += 1;
        }),
        captureContext: async () => await new Promise(() => {
          // Never settles: simulates a wedged post-batch get_ui_elements read.
        }),
      });
      overlaySessionManager.createSession({
        agentId: 'overlay-agent-1',
        callerToken: 'overlay-caller-1',
        workspacePath: '/tmp/overlay-workspace',
        windowSessionKey: 'window-session-1',
        displayId: 'display-1',
        scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
        initialContext,
      });

      const startedAt = Date.now();
      await assert.rejects(
        overlaySessionManager.computerBatch('overlay-agent-1', {
          actions: [{ seq: 1, tool: { name: 'hotkey', params: { hotkey: 'Enter' } } }],
        }),
        /post-batch context recapture did not complete within 50ms/,
      );
      assert.ok(Date.now() - startedAt < 5_000);
      assert.equal(batchCount, 1);
    } finally {
      setOverlayComputerBatchRecaptureTimeoutMsForTest(null);
    }
  });

  test('validates direct element_id overlay actions against the current selected context', async () => {
    let clickCount = 0;
    overlaySessionManager.setDriver({
      ...createDriver(() => undefined),
      click: async () => {
        clickCount += 1;
      },
    });
    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 20, y: 30, width: 240, height: 160 },
      initialContext,
    });

    await assert.rejects(
      overlaySessionManager.click('overlay-agent-1', {
        element_id: 'missing-element',
      }),
      /is not present in the current selected context/,
    );
    await overlaySessionManager.click('overlay-agent-1', {
      element_id: '1',
    });

    assert.equal(clickCount, 1);
  });

  test('temporarily aliases a delegated hidden agent to an active overlay session', () => {
    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: null,
      initialContext: {
        agentMode: 'ax',
        formattedText: 'Selected app context',
        elementCount: 0,
        elements: [],
      },
    });

    overlaySessionManager.attachAgentToExistingSession('overlay-agent-1', 'hidden-agent-1');

    assert.equal(
      overlaySessionManager.getDebugSnapshotForAgent('hidden-agent-1')?.id,
      overlaySessionManager.getDebugSnapshotForAgent('overlay-agent-1')?.id,
    );

    overlaySessionManager.releaseDelegatedAgentSession('hidden-agent-1');

    assert.equal(overlaySessionManager.getDebugSnapshotForAgent('overlay-agent-1')?.status, 'active');
    assert.equal(overlaySessionManager.getDebugSnapshotForAgent('hidden-agent-1'), null);
  });
});
