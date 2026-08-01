import { beforeEach, describe, expect, test } from 'bun:test';
import {
  addAgentPendingInput,
  clearAgentPendingInputs,
  findAgentPendingInputBySubmittedText,
  getAgentPendingInputs,
  isAgentPendingInputSteerLocked,
  normalizeAgentPendingInputSubmittedText,
  removeAgentPendingInput,
  resetAgentPendingInputStoreForTests,
  type AgentPendingInput,
} from './agentPendingInputStore';

function makePendingInput(overrides: Partial<AgentPendingInput> = {}): AgentPendingInput {
  return {
    id: 'pending-1',
    agentId: 'agent-1',
    draftText: 'draft',
    previewText: 'preview',
    messageText: 'message',
    afterNextToolState: null,
    submittedText: null,
    workspacePath: null,
    contextSnapshot: null,
    stage: 'endOfTurn',
    createdAt: 1,
    ...overrides,
  };
}

describe('agentPendingInputStore', () => {
  beforeEach(() => {
    resetAgentPendingInputStoreForTests();
  });

  test('returns a stable empty snapshot for missing agents', () => {
    const firstSnapshot = getAgentPendingInputs('missing-agent');
    const secondSnapshot = getAgentPendingInputs('missing-agent');

    expect(firstSnapshot).toBe(secondSnapshot);
    expect(firstSnapshot).toEqual([]);
  });

  test('returns the same empty snapshot after an agent queue is drained', () => {
    const emptySnapshot = getAgentPendingInputs('agent-1');
    addAgentPendingInput(makePendingInput());
    removeAgentPendingInput('agent-1', 'pending-1');

    expect(getAgentPendingInputs('agent-1')).toBe(emptySnapshot);
  });

  test('returns a stable empty snapshot when agent id is absent', () => {
    const firstSnapshot = getAgentPendingInputs(undefined);
    const secondSnapshot = getAgentPendingInputs(null);

    expect(firstSnapshot).toBe(secondSnapshot);
    expect(firstSnapshot).toEqual([]);
  });

  test('matches submitted text after normalization', () => {
    addAgentPendingInput(makePendingInput({
      stage: 'afterNextTool',
      afterNextToolState: 'submitted',
      submittedText: normalizeAgentPendingInputSubmittedText(
        '  skill:[Shell](id=shell&label=Shell&name=shell&path=%2Ftmp%2Fshell) help me  ',
      ),
    }));

    const matched = findAgentPendingInputBySubmittedText(
      'agent-1',
      'skill:[shell](id=shell&label=shell&name=shell&path=%2Ftmp%2Fshell) help me',
      ['afterNextTool'],
    );

    expect(matched?.id).toBe('pending-1');
  });

  test('clears pending inputs for one agent without affecting others', () => {
    addAgentPendingInput(makePendingInput());
    addAgentPendingInput(makePendingInput({
      id: 'pending-2',
      agentId: 'agent-2',
    }));

    clearAgentPendingInputs('agent-1');

    expect(getAgentPendingInputs('agent-1')).toEqual([]);
    expect(getAgentPendingInputs('agent-2')).toHaveLength(1);
  });

  test('treats in-flight and submitted steers as locked', () => {
    expect(isAgentPendingInputSteerLocked(makePendingInput({
      stage: 'afterNextTool',
      afterNextToolState: 'local',
    }))).toBe(false);

    expect(isAgentPendingInputSteerLocked(makePendingInput({
      stage: 'afterNextTool',
      afterNextToolState: 'submitting',
    }))).toBe(true);

    expect(isAgentPendingInputSteerLocked(makePendingInput({
      stage: 'afterNextTool',
      afterNextToolState: 'submitted',
    }))).toBe(true);

    expect(isAgentPendingInputSteerLocked(makePendingInput({
      stage: 'endOfTurn',
      afterNextToolState: 'submitted',
    }))).toBe(false);
  });
});
