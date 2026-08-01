import { describe, expect, it } from 'bun:test';
import {
  getScopedScrollForHotkey,
  isScopedFocusedControlHotkeyAllowed,
  isCoordinateScrollEnabledForMode,
  RunEngine,
  shouldUseStructuredScreenshotBoundary,
} from '../apps/interpreter-overlay/runtime/core/run-engine.js';
import type {
  AgentPort,
  AgentRun,
  AutomationPort,
  CapturePort,
  InputPort,
  ToolExecutionResult,
  UIPort,
  VisionPort,
} from '../apps/interpreter-overlay/shared/ports.js';
import type { DisplayInfo, Run, UIState } from '../apps/interpreter-overlay/shared/types.js';

const DISPLAY: DisplayInfo = {
  id: 'display-1',
  scaleFactor: 2,
  boundsDIP: { x: 0, y: 0, width: 1440, height: 900 },
};

function createRun(id: string): Run {
  return {
    id,
    startedAt: 0,
    monitorId: DISPLAY.id,
    actions: [],
    conversationId: `conversation-${id}`,
    currentScreenshotId: `run-${id}/batch-0`,
    toolCallCount: 0,
  };
}

function createTestEngine() {
  let nextId = 0;

  const fakeAgentRun: AgentRun = {
    onBatchPreview: () => {},
    onToolCall: () => {},
    onDone: () => {},
    abort: () => {},
  };

  const vision: VisionPort = {
    cache: async () => {},
    detect: async () => ({ text: 'unused' }),
    query: async () => ({ text: 'unused' }),
  };

  const capture: CapturePort = {
    getActiveDisplay: () => DISPLAY,
    getDisplayById: () => DISPLAY,
    captureDisplay: async () => ({ base64: '', display: DISPLAY }),
    captureActiveDisplay: async () => ({ base64: '', display: DISPLAY }),
    captureDisplayStrip: async () => ({ base64: '', display: DISPLAY }),
    captureActiveDisplayStrip: async () => ({ base64: '', display: DISPLAY }),
  };

  const agent: AgentPort = {
    start: async () => fakeAgentRun,
  };

  const auto: AutomationPort = {
    click: async () => {},
    typeAt: async () => {},
    typeFocused: async () => {},
    setFocusedText: async () => true,
    pressHotkey: async () => {},
    scroll: async () => {},
  };

  const uiStates: UIState[] = [];
  const ui: UIPort = {
    set: (state) => {
      uiStates.push(state);
    },
    blur: () => {},
    onAccept: () => {},
    onAcceptAll: () => {},
    onAcceptAllSession: () => {},
    onReject: () => {},
  };

  const input: InputPort = {
    onCtrlDown: () => {},
    onCtrlUp: () => {},
    onCtrlSpaceDown: () => {},
    onCtrlSpaceUp: () => {},
    onEsc: () => {},
  };

  const engine = new RunEngine({
    vision,
    capture,
    agent,
    auto,
    ui,
    input,
    clock: { now: () => 1000 },
    ids: { uuid: () => `test-id-${++nextId}` },
    config: {
      MAX_TOOL_CALLS_PER_RUN: 10,
      conversationAppendMs: 1000,
    },
  });

  return {
    engine,
    engineAny: engine as any,
    fakeAgentRun,
    uiStates,
  };
}

describe('RunEngine computer_batch validation', () => {
  it('uses image screenshot boundaries in vision mode even when text_only is omitted', () => {
    expect(shouldUseStructuredScreenshotBoundary(undefined, 'vision')).toBe(false);
    expect(shouldUseStructuredScreenshotBoundary(true, 'vision')).toBe(false);
  });

  it('preserves text-only screenshot boundaries for AX mode by default', () => {
    expect(shouldUseStructuredScreenshotBoundary(undefined, 'ax')).toBe(true);
    expect(shouldUseStructuredScreenshotBoundary(true, 'ax')).toBe(true);
    expect(shouldUseStructuredScreenshotBoundary(false, 'ax')).toBe(false);
  });

  it('enables coordinate scrolls by default for vision mode', () => {
    expect(isCoordinateScrollEnabledForMode('vision', {})).toBe(true);
    expect(isCoordinateScrollEnabledForMode('ax', {})).toBe(false);
    expect(isCoordinateScrollEnabledForMode('ax', {
      INTERPRETER_OVERLAY_ENABLE_COORDINATE_SCROLL: '1',
    })).toBe(true);
  });

  it('maps page navigation hotkeys to scoped scrolls', () => {
    expect(getScopedScrollForHotkey('PAGEDOWN')).toEqual({ direction: 'down', amount: 10 });
    expect(getScopedScrollForHotkey('Page Up')).toEqual({ direction: 'up', amount: 10 });
    expect(getScopedScrollForHotkey('tab')).toBeNull();
  });

  it('allows focused-control editing hotkeys inside scoped vision runs', () => {
    expect(isScopedFocusedControlHotkeyAllowed('cmd+a')).toBe(true);
    expect(isScopedFocusedControlHotkeyAllowed('ctrl+v')).toBe(true);
    expect(isScopedFocusedControlHotkeyAllowed('tab')).toBe(true);
    expect(isScopedFocusedControlHotkeyAllowed('enter')).toBe(true);
  });

  it('cancels earlier staged actions when a later action fails validation', async () => {
    const { engineAny } = createTestEngine();
    engineAny.currentRun = createRun('validation-failure');

    let resolved: ToolExecutionResult | null = null;
    await engineAny.handleComputerBatchTool(
      1,
      {
        actions: [
          {
            seq: 1,
            tool: { name: 'click', params: { element_description: 'Save button' } },
          },
          {
            seq: 2,
            tool: { name: 'click', params: { x: 0.4 } },
          },
        ],
      },
      (result: ToolExecutionResult) => {
        resolved = result;
      },
    );

    expect(resolved).toEqual({
      kind: 'text',
      text: 'click action requires both x and y when targeting a coordinate',
      isError: true,
    });

    expect(engineAny.currentRun.actions).toHaveLength(2);
    expect(engineAny.currentRun.actions[0]).toMatchObject({
      seq: 1,
      dispatched: true,
      decision: 'system_cancelled',
      error: 'Skipped because another action in the same computer batch failed validation: click action requires both x and y when targeting a coordinate',
    });
    expect(engineAny.currentRun.actions[1]).toMatchObject({
      seq: 2,
      dispatched: true,
      decision: 'system_cancelled',
      error: 'click action requires both x and y when targeting a coordinate',
    });
  });

  it('allows pending terminal results to finalize after batch validation failure', async () => {
    const { engineAny, fakeAgentRun } = createTestEngine();
    engineAny.currentRun = createRun('terminal-finalize');
    engineAny.currentAgentRun = fakeAgentRun;
    engineAny.pendingTerminalResult = {
      agentRun: fakeAgentRun,
      result: {
        status: 'completed',
        finalText: 'completed',
        reason: null,
      },
    };

    await engineAny.handleComputerBatchTool(
      1,
      {
        actions: [
          {
            seq: 1,
            tool: { name: 'click', params: { element_description: 'Save button' } },
          },
          {
            seq: 2,
            tool: { name: 'click', params: { x: 0.4 } },
          },
        ],
      },
      () => {},
    );

    expect(engineAny.pendingTerminalResult).toBeNull();
    expect(engineAny.currentRun).toBeNull();
    expect(engineAny.currentAgentRun).toBeNull();
  });
});
