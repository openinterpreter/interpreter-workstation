import { describe, expect, test } from 'bun:test';

import type { BuiltinToolDefinition } from '../../../server/tools/builtinTools';
import { OverlayInvalidBatchActionError } from '../shared/tool-results';
import {
  executeAdvancedVoiceComputerBatchToolCall,
  parseAdvancedVoiceComputerBatchArguments,
} from './advanced-voice-interpreter-tool';

const listWindowsTool = {
  name: 'list_windows',
  description: 'List windows.',
  inputSchema: {
    type: 'object',
    properties: {
      pid: { type: 'number' },
    },
  },
  handler: async () => ({ content: [] }),
} as BuiltinToolDefinition;

describe('advanced voice computer_batch bridge', () => {
  test('parses batched JSON object arguments for realtime-compatible Interpreter tools', () => {
    expect(parseAdvancedVoiceComputerBatchArguments(JSON.stringify({
      actions: [{
        seq: 1,
        server_id: 'builtin-cua-driver',
        tool_name: 'list_windows',
        arguments: { pid: 123 },
      }],
    }))).toEqual({
      actions: [{
        kind: 'interpreter_tool',
        seq: 1,
        serverId: 'builtin-cua-driver',
        toolName: 'list_windows',
        args: { pid: 123 },
      }],
      corrections: [],
    });
  });

  test('wraps a single loose tool call into a one-action batch with a correction note', () => {
    const parsed = parseAdvancedVoiceComputerBatchArguments(JSON.stringify({
      seq: 1,
      server_id: 'builtin-cua-driver',
      tool_name: 'list_windows',
      arguments: { pid: 123 },
    }));

    expect(parsed.actions).toEqual([{
      kind: 'interpreter_tool',
      seq: 1,
      serverId: 'builtin-cua-driver',
      toolName: 'list_windows',
      args: { pid: 123 },
    }]);
    expect(parsed.corrections.join('\n')).toContain('Wrapped a single tool call object into actions[]');
  });

  test('rejects non-canonical aliases and duplicate sequence numbers', () => {
    expect(() => parseAdvancedVoiceComputerBatchArguments(JSON.stringify({
      actions: [{
        seq: 1,
        server_id: 'builtin-cua-driver',
        tool_name: 'list_windows',
        arguments: {},
      }],
      surprise: true,
    }))).toThrow('computer_batch arguments has unknown key "surprise".');

    expect(() => parseAdvancedVoiceComputerBatchArguments(JSON.stringify({
      actions: [{
        seq: 1,
        serverId: 'builtin-cua-driver',
        toolName: 'list_windows',
        arguments: {},
      }],
    }))).toThrow('computer_batch actions[0] has unknown key "serverId".');

    expect(() => parseAdvancedVoiceComputerBatchArguments(JSON.stringify({
      actions: [
        { seq: 2, server_id: 'builtin-cua-driver', tool_name: 'list_windows', arguments: {} },
        { seq: 2, tool: { name: 'click', params: { element_id: 'ref-submit' } } },
      ],
    }))).toThrow('computer_batch actions[1].seq must be unique.');
  });

  test('parses overlay-namespaced drawing calls as batch entries', () => {
    expect(parseAdvancedVoiceComputerBatchArguments(JSON.stringify({
      actions: [{
        seq: 2,
        server_id: 'builtin-interpreter-overlay',
        tool_name: 'overlay_show_drawings',
        arguments: {
          annotations: [{ x: 10, y: 20, width: 100, height: 40, label: 'Thinking' }],
        },
      }],
    })).actions[0]).toEqual({
      kind: 'interpreter_tool',
      seq: 2,
      serverId: 'builtin-interpreter-overlay',
      toolName: 'overlay_show_drawings',
      args: {
        annotations: [{ x: 10, y: 20, width: 100, height: 40, label: 'Thinking' }],
      },
    });
  });

  test('parses selected-target atomic actions for attached form control', () => {
    expect(parseAdvancedVoiceComputerBatchArguments(JSON.stringify({
      actions: [{
        seq: 3,
        tool: {
          name: 'type',
          params: {
            element_id: 'ref-policy-number',
            text: 'BOP-884201',
            clear_first: true,
          },
        },
      }],
    })).actions[0]).toEqual({
      kind: 'selected_target_action',
      seq: 3,
      tool: {
        name: 'type',
        params: {
          element_id: 'ref-policy-number',
          text: 'BOP-884201',
          clear_first: true,
        },
      },
    });
  });

  test('strictly validates selected-target action params before execution', () => {
    expect(() => parseAdvancedVoiceComputerBatchArguments(JSON.stringify({
      actions: [{
        seq: 1,
        tool: {
          name: 'type',
          params: { element_id: 'ref-name', text: 42 },
        },
      }],
    }))).toThrow('computer_batch actions[0].tool.params.text must be a string.');

    expect(() => parseAdvancedVoiceComputerBatchArguments(JSON.stringify({
      actions: [{
        seq: 2,
        tool: {
          name: 'hotkey',
          params: { hotkey: ['cmd', 'a'] },
        },
      }],
    }))).toThrow('computer_batch actions[0].tool.params.hotkey must be a string.');

    expect(() => parseAdvancedVoiceComputerBatchArguments(JSON.stringify({
      actions: [{
        seq: 3,
        tool: {
          name: 'click',
          params: { element_id: 'ref-submit', surprise: true },
        },
      }],
    }))).toThrow('computer_batch actions[0].tool.params has unknown key "surprise".');
  });

  test('calls allowed Interpreter tools through the provided ToolManager path', async () => {
    const calls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }> = [];
    const output = await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: JSON.stringify({
        actions: [{
          seq: 1,
          server_id: 'builtin-cua-driver',
          tool_name: 'list_windows',
          arguments: {},
        }],
      }),
      getBuiltinTool: () => listWindowsTool,
      callTool: async (serverId, toolName, args) => {
        calls.push({ serverId, toolName, args });
        return {
          content: [{ type: 'text', text: 'window 1' }],
        };
      },
    });

    expect(calls).toEqual([{
      serverId: 'builtin-cua-driver',
      toolName: 'list_windows',
      args: {},
    }]);
    expect(JSON.parse(output)).toEqual({
      status: 'completed',
      corrections: [],
      action_count: 1,
      results: [{
        seq: 1,
        tool: 'builtin-cua-driver/list_windows',
        result: {
          status: 'completed',
          text: 'window 1',
          image_count: 0,
          saved_to_path: null,
          image_paths: [],
        },
      }],
    });
  });

  test('rejects tools outside the realtime-compatible subset', async () => {
    const output = await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: JSON.stringify({
        actions: [{
          seq: 1,
          server_id: 'builtin-cells',
          tool_name: 'read_spreadsheet',
          arguments: {},
        }],
      }),
      getBuiltinTool: () => {
        throw new Error('should not resolve disallowed tools');
      },
      callTool: async () => {
        throw new Error('should not call disallowed tools');
      },
    });

    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('not_allowed');
    expect(parsed.tool).toBe('builtin-cells/read_spreadsheet');
    expect(parsed.allowed_tools).toContain('builtin-cua-driver/list_windows');
    expect(parsed.allowed_tools).not.toContain('builtin-cells/read_spreadsheet');
  });

  test('preflights the full batch before executing any action', async () => {
    const calls: string[] = [];
    const output = await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: JSON.stringify({
        actions: [
          { seq: 1, server_id: 'builtin-cua-driver', tool_name: 'list_windows', arguments: {} },
          { seq: 2, server_id: 'builtin-cells', tool_name: 'read_spreadsheet', arguments: {} },
        ],
      }),
      getBuiltinTool: () => listWindowsTool,
      callTool: async (serverId, toolName) => {
        calls.push(`${serverId}/${toolName}`);
        return { content: [{ type: 'text', text: 'unexpected' }] };
      },
    });

    expect(calls).toEqual([]);
    expect(JSON.parse(output)).toMatchObject({
      status: 'not_allowed',
      failed_action_seq: 2,
      tool: 'builtin-cells/read_spreadsheet',
    });
  });

  test('preflights selected-target support before executing earlier normal actions', async () => {
    const calls: string[] = [];
    const output = await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: JSON.stringify({
        actions: [
          { seq: 1, server_id: 'builtin-cua-driver', tool_name: 'list_windows', arguments: {} },
          {
            seq: 2,
            tool: {
              name: 'click',
              params: { element_id: 'field-1' },
            },
          },
        ],
      }),
      getBuiltinTool: () => listWindowsTool,
      callTool: async (serverId, toolName) => {
        calls.push(`${serverId}/${toolName}`);
        return { content: [{ type: 'text', text: 'unexpected' }] };
      },
    });

    expect(calls).toEqual([]);
    expect(JSON.parse(output)).toMatchObject({
      status: 'not_allowed',
      failed_action_seq: 2,
      tool: 'selected-target/click',
    });
  });

  test('preflights every normal action against its exact tool schema', async () => {
    let toolCalled = false;
    const output = await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: JSON.stringify({
        actions: [{
          seq: 7,
          server_id: 'builtin-cua-driver',
          tool_name: 'list_windows',
          arguments: { pid: 'not a number' },
        }],
      }),
      getBuiltinTool: () => listWindowsTool,
      callTool: async () => {
        toolCalled = true;
        return { content: [{ type: 'text', text: 'unexpected' }] };
      },
    });

    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('schema_or_execution_error');
    expect(parsed.failed_action_seq).toBe(7);
    expect(parsed.tool).toBe('builtin-cua-driver/list_windows');
    expect(parsed.error).toContain('must be number');
    expect(parsed.input_schema).toEqual(listWindowsTool.inputSchema);
    expect(parsed.instruction).toContain('Retry with arguments that exactly match input_schema');
    expect(parsed.instruction).toContain('No batch actions ran');
    expect(toolCalled).toBe(false);
  });

  test('maps a pre-execution batch rejection to an explicit invalid_action_target status', async () => {
    const output = await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: JSON.stringify({
        actions: [{
          seq: 3,
          tool: {
            name: 'hotkey',
            params: { hotkey: '' },
          },
        }],
      }),
      getBuiltinTool: () => {
        throw new Error('should not resolve ToolManager tools for selected target action');
      },
      callTool: async () => {
        throw new Error('should not call ToolManager for selected target action');
      },
      callSelectedTargetBatch: async () => {
        throw new OverlayInvalidBatchActionError('hotkey action requires a non-empty hotkey string');
      },
    });

    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('invalid_action_target');
    expect(parsed.failed_action_seq).toBe(3);
    expect(parsed.error).toBe('hotkey action requires a non-empty hotkey string');
    expect(parsed.instruction).toContain('rejected before execution; no actions ran');
  });

  test('executes selected-target atomic actions through the attached target callback', async () => {
    const selectedBatches: Array<unknown> = [];
    const output = await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: JSON.stringify({
        actions: [{
          seq: 4,
          tool: {
            name: 'click',
            params: { element_id: 'submit-button' },
          },
        }],
      }),
      getBuiltinTool: () => {
        throw new Error('should not resolve ToolManager tools for selected target action');
      },
      callTool: async () => {
        throw new Error('should not call ToolManager for selected target action');
      },
      callSelectedTargetBatch: async (params) => {
        selectedBatches.push(params);
        return {
          content: [{ type: 'text', text: 'selected target clicked' }],
        };
      },
    });

    expect(selectedBatches).toEqual([{
      actions: [{
        seq: 4,
        tool: {
          name: 'click',
          params: { element_id: 'submit-button' },
        },
      }],
    }]);
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('completed');
    expect(parsed.results[0]).toEqual({
      seq: 4,
      tool: 'selected-target/click',
      result: {
        status: 'completed',
        text: 'selected target clicked',
        image_count: 0,
        saved_to_path: null,
        image_paths: [],
      },
    });
  });

  test('groups consecutive selected-target actions into one reviewed batch call', async () => {
    const selectedBatches: Array<unknown> = [];
    const output = await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: JSON.stringify({
        actions: [
          { seq: 1, tool: { name: 'type', params: { element_id: 'ref:1', text: 'Ada Lovelace', clear_first: true } } },
          { seq: 2, tool: { name: 'type', params: { element_id: 'ref:2', text: 'Operations' } } },
          { seq: 3, tool: { name: 'click', params: { element_id: 'ref:3' } } },
          { seq: 4, tool: { name: 'click', params: { element_id: 'ref:4' } } },
        ],
      }),
      getBuiltinTool: () => {
        throw new Error('should not resolve ToolManager tools for selected target actions');
      },
      callTool: async () => {
        throw new Error('should not call ToolManager for selected target actions');
      },
      callSelectedTargetBatch: async (params) => {
        selectedBatches.push(params);
        return {
          content: [{ type: 'text', text: 'batch completed after review' }],
        };
      },
    });

    // One computer_batch proposal of selected-target actions stages exactly
    // one reviewed batch, not one review per action.
    expect(selectedBatches).toHaveLength(1);
    expect((selectedBatches[0] as { actions: unknown[] }).actions).toHaveLength(4);
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('completed');
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].tool).toBe('selected-target/batch[type,type,click,click]');
    expect(parsed.results[0].action_seqs).toEqual([1, 2, 3, 4]);
    expect(parsed.results[0].result.text).toBe('batch completed after review');
  });

  test('splits selected-target grouping around an interleaved interpreter tool action', async () => {
    const selectedBatches: Array<{ actions: unknown[] }> = [];
    const interpreterCalls: string[] = [];
    const output = await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: JSON.stringify({
        actions: [
          { seq: 1, tool: { name: 'type', params: { element_id: 'ref:1', text: 'Ada' } } },
          { seq: 2, server_id: 'builtin-cua-driver', tool_name: 'list_windows', arguments: {} },
          { seq: 3, tool: { name: 'click', params: { element_id: 'ref:2' } } },
        ],
      }),
      getBuiltinTool: () => listWindowsTool,
      callTool: async (serverId, toolName) => {
        interpreterCalls.push(`${serverId}/${toolName}`);
        return { content: [{ type: 'text', text: 'windows listed' }] };
      },
      callSelectedTargetBatch: async (params) => {
        selectedBatches.push(params as { actions: unknown[] });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    expect(selectedBatches).toHaveLength(2);
    expect(selectedBatches[0].actions).toHaveLength(1);
    expect(selectedBatches[1].actions).toHaveLength(1);
    expect(interpreterCalls).toEqual(['builtin-cua-driver/list_windows']);
    expect(JSON.parse(output).status).toBe('completed');
  });
});

describe('advanced voice computer_batch repair path', () => {
  const repairableRaw = '{"actions":[{"seq":1,"server_id":"builtin-cua-driver","tool_name":"list_windows","arguments":{"pid":123}}';

  test('executes repaired arguments after the repair model returns valid schema JSON', async () => {
    const calls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }> = [];
    const repairCalls: Array<{ raw: string; parseError: string }> = [];
    const output = JSON.parse(await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: repairableRaw,
      getBuiltinTool: () => listWindowsTool,
      callTool: async (serverId, toolName, args) => {
        calls.push({ serverId, toolName, args });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      repairArguments: async (raw, parseError) => {
        repairCalls.push({ raw, parseError });
        return JSON.stringify({
          actions: [{
            seq: 1,
            server_id: 'builtin-cua-driver',
            tool_name: 'list_windows',
            arguments: { pid: 123 },
          }],
        });
      },
    })) as { status: string; corrections: string[] };

    expect(output.status).toBe('completed');
    expect(calls).toEqual([{ serverId: 'builtin-cua-driver', toolName: 'list_windows', args: { pid: 123 } }]);
    expect(repairCalls).toHaveLength(1);
    expect(repairCalls[0].raw).toBe(repairableRaw);
    expect(output.corrections.join('\n')).toContain('repaired by the configured fast repair model');
  });

  test('fails loudly with the shape instruction when the repair model rejects', async () => {
    let toolCalled = false;
    const output = JSON.parse(await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: repairableRaw,
      getBuiltinTool: () => listWindowsTool,
      callTool: async () => {
        toolCalled = true;
        return { content: [] };
      },
      repairArguments: async () => null,
    })) as { status: string; repair: string; instruction: string };

    expect(output.status).toBe('invalid_arguments');
    expect(output.repair).toBe('rejected');
    expect(output.instruction).toContain('{ "actions": [...] }');
    expect(toolCalled).toBe(false);
  });

  test('never executes repaired arguments that are still schema-invalid', async () => {
    let toolCalled = false;
    const output = JSON.parse(await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: repairableRaw,
      getBuiltinTool: () => listWindowsTool,
      callTool: async () => {
        toolCalled = true;
        return { content: [] };
      },
      repairArguments: async () => '{"actions":[{"seq":1}]}',
    })) as { status: string; repair: string };

    expect(output.status).toBe('invalid_arguments');
    expect(output.repair).toContain('repaired arguments were still invalid');
    expect(toolCalled).toBe(false);
  });

  test('reports a repair-model failure without executing anything', async () => {
    let toolCalled = false;
    const output = JSON.parse(await executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: repairableRaw,
      getBuiltinTool: () => listWindowsTool,
      callTool: async () => {
        toolCalled = true;
        return { content: [] };
      },
      repairArguments: async () => {
        throw new Error('repair model unavailable');
      },
    })) as { status: string; repair: string };

    expect(output.status).toBe('invalid_arguments');
    expect(output.repair).toContain('repair model failed: repair model unavailable');
    expect(toolCalled).toBe(false);
  });

  test('still throws on malformed arguments when no repair path is provided', async () => {
    await expect(executeAdvancedVoiceComputerBatchToolCall({
      argumentsJson: repairableRaw,
      getBuiltinTool: () => listWindowsTool,
      callTool: async () => ({ content: [] }),
    })).rejects.toThrow();
  });
});
