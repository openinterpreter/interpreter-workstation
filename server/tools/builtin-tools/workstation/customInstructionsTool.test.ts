import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearConfigCache, getCustomInstructions, setConfigOverride } from '../../../configStore';
import { interpreterServerDefinition } from './index';
import {
  customInstructionsGetTool,
  customInstructionsSetTool,
} from './customInstructionsTool';

function textFromResult(result: Awaited<ReturnType<typeof customInstructionsGetTool.handler>>): string {
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return String(first?.text ?? '');
}

describe('custom instructions tools', () => {
  beforeEach(() => {
    clearConfigCache();
    setConfigOverride({ agents: {} } as any);
  });

  afterEach(() => {
    clearConfigCache();
  });

  test('are exposed through the Interpreter builtin server', () => {
    expect(interpreterServerDefinition.tools.map((tool) => tool.name)).toContain('interpreter_custom_instructions_get');
    expect(interpreterServerDefinition.tools.map((tool) => tool.name)).toContain('interpreter_custom_instructions_set');
  });

  test('reads missing custom instructions as null', async () => {
    const result = await customInstructionsGetTool.handler({});

    expect(result.isError).toBe(false);
    expect(JSON.parse(textFromResult(result))).toEqual({ customInstructions: null });
  });

  test('sets trimmed custom instructions and clears with empty text', async () => {
    const saved = await customInstructionsSetTool.handler({
      instructions: '  Prefer short answers.  ',
    });

    expect(saved.isError).toBe(false);
    expect(JSON.parse(textFromResult(saved))).toEqual({
      success: true,
      customInstructions: 'Prefer short answers.',
    });
    expect(await getCustomInstructions()).toBe('Prefer short answers.');

    const cleared = await customInstructionsSetTool.handler({ instructions: '   ' });
    expect(cleared.isError).toBe(false);
    expect(JSON.parse(textFromResult(cleared))).toEqual({
      success: true,
      customInstructions: null,
    });
    expect(await getCustomInstructions()).toBeNull();
  });

  test('fails loudly when instructions is not a string', async () => {
    const result = await customInstructionsSetTool.handler({ instructions: 123 });

    expect(result.isError).toBe(true);
    expect(textFromResult(result)).toBe('instructions must be a string');
  });
});
