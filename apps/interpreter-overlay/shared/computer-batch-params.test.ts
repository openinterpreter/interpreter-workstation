import { describe, expect, test } from 'bun:test';

import { parseComputerBatchParams, parseComputerBatchParamsJson } from './computer-batch-params';

describe('computer_batch params parser', () => {
  test('accepts canonical seq/tool actions', () => {
    expect(parseComputerBatchParams({
      actions: [
        {
          seq: 1,
          tool: {
            name: 'type',
            params: {
              element_id: 'name-field',
              element_description: 'Name',
              text: 'Ada Lovelace',
              clear_first: true,
            },
          },
        },
        {
          seq: 2,
          tool: {
            name: 'hotkey',
            params: {
              hotkey: 'Enter',
            },
          },
        },
      ],
    })).toEqual({
      actions: [
        {
          seq: 1,
          tool: {
            name: 'type',
            params: {
              element_id: 'name-field',
              element_description: 'Name',
              text: 'Ada Lovelace',
              clear_first: true,
            },
          },
        },
        {
          seq: 2,
          tool: {
            name: 'hotkey',
            params: {
              hotkey: 'Enter',
            },
          },
        },
      ],
    });
  });

  test('rejects overlay snapshot metadata keys on actions', () => {
    expect(() => parseComputerBatchParams({
      actions: [
        {
          seq: 1,
          tool: {
            name: 'click',
            params: {
              element_id: 'name-field',
              selected_context_snapshot_id: 'selected-context-1',
            },
          },
        },
      ],
    })).toThrow('computer_batch actions[0].tool.params has unknown key "selected_context_snapshot_id".');
  });

  test('rejects flat legacy action objects', () => {
    expect(() => parseComputerBatchParams({
      actions: [
        {
          seq: 1,
          type: 'type',
          element_id: 'name-field',
          text: 'Ada Lovelace',
        },
      ],
    })).toThrow('computer_batch actions[0] has unknown key "type".');
  });

  test('requires unique numeric seq values', () => {
    expect(() => parseComputerBatchParams({
      actions: [
        { seq: 1, tool: { name: 'click', params: {} } },
        { seq: 1, tool: { name: 'click', params: {} } },
      ],
    })).toThrow('computer_batch actions[1].seq must be unique.');
  });

  test('rejects missing required tool params', () => {
    expect(() => parseComputerBatchParams({
      actions: [
        { seq: 1, tool: { name: 'type', params: {} } },
      ],
    })).toThrow('computer_batch actions[0].tool.params.text must be a string.');

    expect(() => parseComputerBatchParamsJson(JSON.stringify({
      actions: [
        { seq: 1, tool: { name: 'scroll', params: { direction: 'diagonal' } } },
      ],
    }))).toThrow('computer_batch actions[0].tool.params.direction must be up, down, left, or right.');
  });
});
