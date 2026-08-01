import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_INPUT_STATE,
  reduceInputTransition,
  type InputEffect,
  type InputStateSnapshot,
  type InputTransition,
} from './input';

function applyTransitions(
  transitions: InputTransition[],
): { effects: InputEffect[]; state: InputStateSnapshot } {
  let state = { ...DEFAULT_INPUT_STATE };
  const effects: InputEffect[] = [];

  for (const transition of transitions) {
    const result = reduceInputTransition(state, transition);
    state = result.nextState;
    effects.push(...result.effects);
  }

  return { effects, state };
}

describe('input transition reducer', () => {
  test('emits ctrl-space down when control is pressed before space', () => {
    const { effects, state } = applyTransitions(['CTRL_DOWN', 'SPACE_DOWN']);

    expect(effects).toEqual(['ctrl-down', 'ctrl-space-down']);
    expect(state).toEqual({
      ctrlHeld: true,
      shiftHeld: false,
      spaceHeld: true,
      ctrlSpaceHeld: true,
    });
  });

  test('emits ctrl-space down when space is pressed before control', () => {
    const { effects, state } = applyTransitions(['SPACE_DOWN', 'CTRL_DOWN']);

    expect(effects).toEqual(['ctrl-down', 'ctrl-space-down']);
    expect(state).toEqual({
      ctrlHeld: true,
      shiftHeld: false,
      spaceHeld: true,
      ctrlSpaceHeld: true,
    });
  });

  test('emits ctrl-space up when space is released while control stays held', () => {
    const { effects, state } = applyTransitions(['CTRL_DOWN', 'SPACE_DOWN', 'SPACE_UP']);

    expect(effects).toEqual(['ctrl-down', 'ctrl-space-down', 'ctrl-space-up']);
    expect(state).toEqual({
      ctrlHeld: true,
      shiftHeld: false,
      spaceHeld: false,
      ctrlSpaceHeld: false,
    });
  });

  test('emits ctrl-space up when control is released while space stays held', () => {
    const { effects, state } = applyTransitions(['SPACE_DOWN', 'CTRL_DOWN', 'CTRL_UP']);

    expect(effects).toEqual(['ctrl-down', 'ctrl-space-down', 'ctrl-up', 'ctrl-space-up']);
    expect(state).toEqual({
      ctrlHeld: false,
      shiftHeld: false,
      spaceHeld: true,
      ctrlSpaceHeld: false,
    });
  });

  test('does not emit duplicate ctrl-space events for repeated keydown signals', () => {
    const { effects, state } = applyTransitions([
      'CTRL_DOWN',
      'SPACE_DOWN',
      'SPACE_DOWN',
      'CTRL_DOWN',
    ]);

    expect(effects).toEqual(['ctrl-down', 'ctrl-space-down']);
    expect(state).toEqual({
      ctrlHeld: true,
      shiftHeld: false,
      spaceHeld: true,
      ctrlSpaceHeld: true,
    });
  });
});
