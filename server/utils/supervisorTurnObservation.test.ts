import { describe, expect, it } from 'bun:test';
import { projectSupervisorTurn } from './supervisorTurnObservation';
import type { v2 } from '../handlers/codex-generated-types/index';

const id = '00000000-0000-4000-8000-000000000001';
const turn = (name: string, status: v2.Turn['status'], items: v2.Turn['items']) => ({
  id: name, status, items, startedAt: 1, completedAt: status === 'inProgress' ? null : 2,
  durationMs: null, error: null, itemsView: 'full' as const,
});
const thread = (turns: v2.Turn[]) => ({ id, turns, preview: 'private obsolete foreground wait',
  status: { type: 'active', activeFlags: [] } }) as v2.Thread;

describe('bounded saved native turn observation', () => {
  it('labels initial preview non-authoritative and last message historical during current turn', () => {
    const prior = turn('prior', 'completed', [{ type: 'agentMessage', id: 'message',
      text: 'private reasoning must not leave', phase: null, memoryCitation: null,
      delivery: null, questions: null }]);
    const current = turn('current', 'inProgress', [{ type: 'commandExecution', id: 'exec',
      status: 'inProgress', processId: 'native-process', exitCode: null,
      command: 'private command must not leave', aggregatedOutput: 'private output must not leave' } as never]);
    const result = projectSupervisorTurn(thread([prior, current]), id);
    expect(result.turn).toEqual({ id: 'current', status: 'inProgress', startedAt: 1, completedAt: null });
    expect(result.latestMessage).toEqual({ turnId: 'prior', relation: 'historical' });
    expect(result.preview).toEqual({ relation: 'initial-thread-historical-non-authoritative' });
    expect(result.command).toEqual({ itemId: 'exec', status: 'inProgress', exitCode: null,
      processId: 'native-process', observation: 'saved-command-item-not-os-process-custody' });
    expect(JSON.stringify(result)).not.toMatch(/private|foreground wait/);
  });
  it('denies cross-thread reads and does not turn an empty saved history into command liveness', () => {
    expect(() => projectSupervisorTurn(thread([]), '00000000-0000-4000-8000-000000000002')).toThrow();
    expect(projectSupervisorTurn(thread([]), id)).toEqual({ threadId: id, turn: null,
      latestMessage: null, command: null,
      modelPhase: { available: false, category: 'native_model_phase_unavailable' },
      observation: 'saved-native-thread-only' });
  });
  it('returns typed unavailability when a native turn omits full items', () => {
    const partial = { ...turn('current', 'inProgress', []), itemsView: 'summary' as const };
    const result = projectSupervisorTurn(thread([turn('prior', 'completed', [
      { type: 'agentMessage', id: 'old', text: 'private', phase: null, memoryCitation: null,
        delivery: null, questions: null },
    ]), partial]), id);
    expect(result.latestMessage).toEqual({ relation: 'unavailable' });
    expect(result.command).toEqual({ observation: 'saved-items-unavailable' });
    expect(result.turn?.status).toBe('inProgress');
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
