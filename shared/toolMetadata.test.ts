import { describe, test, expect } from 'bun:test';
import { isSubagentTool, getToolDisplay, TOOL_DISPLAY, DEFAULT_DISPLAY, SUBAGENT_TOOLS } from './toolMetadata';

describe('isSubagentTool', () => {
  test('returns false for read_multiple_files', () => {
    expect(isSubagentTool('read_multiple_files')).toBe(false);
  });

  test('returns false for read_word', () => {
    expect(isSubagentTool('read_word')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isSubagentTool('')).toBe(false);
  });

  test('returns false for unknown tool', () => {
    expect(isSubagentTool('nonexistent_tool')).toBe(false);
  });
});

describe('getToolDisplay', () => {
  test('returns display info for read_file', () => {
    const display = getToolDisplay('read_file');
    expect(display).toBeDefined();
    expect(display!.category).toBe('explore');
    expect(display!.verb.active).toBe('Reading');
    expect(display!.verb.past).toBe('Read');
  });

  test('returns display info for write_file', () => {
    const display = getToolDisplay('write_file');
    expect(display).toBeDefined();
    expect(display!.category).toBe('edit');
    expect(display!.verb.active).toBe('Writing');
    expect(display!.verb.past).toBe('Wrote');
  });

  test('returns display info for navigate', () => {
    const display = getToolDisplay('navigate');
    expect(display).toBeDefined();
    expect(display!.category).toBe('browse');
  });

  test('returns display info for nylas_send_message', () => {
    const display = getToolDisplay('nylas_send_message');
    expect(display).toBeDefined();
    expect(display!.category).toBe('email');
    expect(display!.verb.active).toBe('Sending');
    expect(display!.verb.past).toBe('Sent');
  });

  test('returns undefined for unknown tool', () => {
    expect(getToolDisplay('totally_unknown_tool')).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(getToolDisplay('')).toBeUndefined();
  });
});

describe('SUBAGENT_TOOLS', () => {
  test('is empty when no builtin tool uses the subagent UI', () => {
    expect(SUBAGENT_TOOLS).toHaveLength(0);
  });
});

describe('DEFAULT_DISPLAY', () => {
  test('has category other and Processing verb', () => {
    expect(DEFAULT_DISPLAY.category).toBe('other');
    expect(DEFAULT_DISPLAY.verb.active).toBe('Processing');
    expect(DEFAULT_DISPLAY.verb.past).toBe('Processed');
  });
});
