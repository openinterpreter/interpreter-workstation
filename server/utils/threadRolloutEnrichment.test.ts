import { afterEach, beforeEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { v2 } from '../handlers/codex-generated-types/index';
import {
  ROLLOUT_TAIL_BYTE_BUDGET,
  ROLLOUT_TAIL_CHUNK_BYTES,
  enrichThreadTurnsFromRollout,
} from './threadRolloutEnrichment';

function makeThread(turns: v2.Turn[], path: string | null = null): v2.Thread {
  return {
    id: 'thr_test',
    preview: 'test thread',
    modelProvider: 'openai',
    createdAt: 1700000000,
    updatedAt: 1700000000,
    status: { type: 'idle' },
    path,
    cwd: '/tmp',
    cliVersion: '1.0.0',
    source: 'appServer',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns,
  } as v2.Thread;
}

function makeTurn(items: v2.ThreadItem[], id = 'turn_1'): v2.Turn {
  return { id, items, status: 'completed', error: null } as v2.Turn;
}

const context = (turnId: string) => ({
  timestamp: 't', type: 'turn_context',
  payload: { turn_id: turnId, cwd: '/tmp', approval_policy: 'on-failure', sandbox_policy: 'none', model: 'gpt-4', summary: 'auto' },
});
const reasoningLine = (text: string, summary: string[] = []) => ({
  timestamp: 't', type: 'response_item',
  payload: { type: 'reasoning', summary: summary.map((s) => ({ type: 'summary_text', text: s })), content: [{ type: 'reasoning_text', text }], encrypted_content: null },
});
const assistantLine = (text: string) => ({
  timestamp: 't', type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});
const userLine = (text: string) => ({
  timestamp: 't', type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});
const agentMessage = (id: string, text: string): v2.ThreadItem => (
  { type: 'agentMessage', id, text, phase: 'final_answer' } as v2.ThreadItem
);
const jsRepl = (id: string, output: string): v2.ThreadItem => ({
  type: 'commandExecution',
  id,
  command: 'js_repl',
  cwd: '/workspace',
  processId: null,
  status: 'completed',
  commandActions: [],
  aggregatedOutput: output,
  exitCode: 0,
  durationMs: 10,
} as v2.ThreadItem);

type SourceItem = v2.ThreadItem & { sourceInput?: string; sourceToolName?: string };

describe('enrichThreadTurnsFromRollout', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rollout-enrich-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  function writeRollout(lines: Array<object | string>, trailing = ''): string {
    const p = join(tmpDir, 'rollout.jsonl');
    const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
    writeFileSync(p, `${body}\n${trailing}`);
    return p;
  }

  // Ported regression cases.

  test('should_return_unchanged_when_path_is_null', async () => {
    const thread = makeThread([makeTurn([agentMessage('item_1', 'Hello')])]);
    const result = await enrichThreadTurnsFromRollout(thread);
    assert.equal(result.thread, thread);
    assert.equal(result.status, 'unavailable');
  });

  test('should_attach_custom_tool_input_to_matching_commandExecution_without_reasoning', async () => {
    const rolloutPath = writeRollout([
      context('turn_1'),
      userLine('Open the page'),
      { timestamp: 't2', type: 'response_item', payload: { type: 'custom_tool_call', name: 'js_repl', call_id: 'cmd_1', input: 'await page.goto("https://example.com");' } },
      { timestamp: 't3', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'cmd_1', output: { type: 'text', text: 'ok' } } },
      assistantLine('Done'),
    ]);
    const thread = makeThread([
      makeTurn([jsRepl('cmd_1', 'ok'), agentMessage('item_2', 'Done')], 'turn_1'),
    ], rolloutPath);

    const { thread: result } = await enrichThreadTurnsFromRollout(thread);
    const tool = result.turns[0]!.items[0] as SourceItem;
    assert.equal(result.turns[0]!.items.length, 2);
    assert.equal(tool.type, 'commandExecution');
    assert.equal(tool.sourceToolName, 'js_repl');
    assert.equal(tool.sourceInput, 'await page.goto("https://example.com");');
  });

  test('should_attach_custom_tool_input_even_when_thread_already_contains_native_reasoning', async () => {
    const rolloutPath = writeRollout([
      context('turn_1'),
      { timestamp: 't1', type: 'response_item', payload: { type: 'custom_tool_call', name: 'js_repl', call_id: 'cmd_1', input: 'await page.locator("button").click();' } },
      { timestamp: 't2', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'cmd_1', output: { type: 'text', text: 'clicked' } } },
      assistantLine('Done'),
    ]);
    const thread = makeThread([
      makeTurn([
        { type: 'reasoning', id: 'native_reasoning_1', summary: ['thinking'], content: ['clicking the button'] },
        jsRepl('cmd_1', 'clicked'),
        agentMessage('item_2', 'Done'),
      ], 'turn_1'),
    ], rolloutPath);

    const { thread: result } = await enrichThreadTurnsFromRollout(thread);
    const tool = result.turns[0]!.items[1] as SourceItem;
    assert.equal(result.turns[0]!.items[0]!.type, 'reasoning');
    assert.equal(tool.type, 'commandExecution');
    assert.equal(tool.sourceToolName, 'js_repl');
    assert.equal(tool.sourceInput, 'await page.locator("button").click();');
  });

  test('should_inject_reasoning_before_corresponding_agent_message', async () => {
    const rolloutPath = writeRollout([
      context('turn_1'),
      reasoningLine('deep thoughts', ['Thinking about it']),
      assistantLine('Hello'),
    ]);
    const thread = makeThread([makeTurn([agentMessage('item_1', 'Hello')], 'turn_1')], rolloutPath);

    const { thread: result } = await enrichThreadTurnsFromRollout(thread);
    assert.equal(result.turns[0]!.items.length, 2);
    const reasoning = result.turns[0]!.items[0]!;
    assert.equal(reasoning.type, 'reasoning');
    if (reasoning.type === 'reasoning') {
      assert.deepEqual(reasoning.summary, ['Thinking about it']);
      assert.deepEqual(reasoning.content, ['deep thoughts']);
    }
    assert.equal(result.turns[0]!.items[1]!.type, 'agentMessage');
  });

  test('should_not_duplicate_reasoning_when_thread_already_contains_native_reasoning', async () => {
    const rolloutPath = writeRollout([
      context('turn_1'),
      reasoningLine('deep thoughts', ['Thinking about it']),
      assistantLine('Hello'),
    ]);
    const thread = makeThread([
      makeTurn([
        { type: 'reasoning', id: 'native_reasoning_1', summary: ['Thinking about it'], content: ['deep thoughts'] },
        agentMessage('item_1', 'Hello'),
      ], 'turn_1'),
    ], rolloutPath);

    const { thread: result } = await enrichThreadTurnsFromRollout(thread);
    assert.deepEqual(result.turns[0]!.items, thread.turns[0]!.items);
  });

  test('should_append_trailing_reasoning_after_last_agent_message', async () => {
    const rolloutPath = writeRollout([
      context('turn_1'),
      assistantLine('Hello'),
      reasoningLine('afterthought'),
    ]);
    const thread = makeThread([makeTurn([agentMessage('item_1', 'Hello')], 'turn_1')], rolloutPath);

    const { thread: result } = await enrichThreadTurnsFromRollout(thread);
    assert.equal(result.turns[0]!.items.length, 2);
    assert.equal(result.turns[0]!.items[0]!.type, 'agentMessage');
    assert.equal(result.turns[0]!.items[1]!.type, 'reasoning');
  });

  test('should_handle_multi_turn_with_reasoning_in_each', async () => {
    const rolloutPath = writeRollout([
      context('turn_1'),
      userLine('Q1'),
      reasoningLine('thought 1', ['Think 1']),
      assistantLine('Reply 1'),
      context('turn_2'),
      userLine('Q2'),
      reasoningLine('thought 2', ['Think 2']),
      assistantLine('Reply 2'),
    ]);
    const thread = makeThread([
      makeTurn([
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Q1', text_elements: [] }] },
        agentMessage('a1', 'Reply 1'),
      ], 'turn_1'),
      makeTurn([
        { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'Q2', text_elements: [] }] },
        agentMessage('a2', 'Reply 2'),
      ], 'turn_2'),
    ], rolloutPath);

    const { thread: result } = await enrichThreadTurnsFromRollout(thread);
    assert.equal(result.turns[0]!.items.length, 3);
    assert.equal(result.turns[0]!.items[1]!.type, 'reasoning');
    assert.equal(result.turns[1]!.items.length, 3);
    assert.equal(result.turns[1]!.items[1]!.type, 'reasoning');
  });

  test('should_only_enrich_turns_that_still_lack_reasoning', async () => {
    const rolloutPath = writeRollout([
      context('turn_1'),
      userLine('Q1'),
      reasoningLine('already there', ['Native']),
      assistantLine('Reply 1'),
      context('turn_2'),
      userLine('Q2'),
      reasoningLine('missing from thread', ['Injected']),
      assistantLine('Reply 2'),
    ]);
    const thread = makeThread([
      makeTurn([
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Q1', text_elements: [] }] },
        { type: 'reasoning', id: 'native_reasoning_1', summary: ['Native'], content: ['already there'] },
        agentMessage('a1', 'Reply 1'),
      ], 'turn_1'),
      makeTurn([
        { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'Q2', text_elements: [] }] },
        agentMessage('a2', 'Reply 2'),
      ], 'turn_2'),
    ], rolloutPath);

    const { thread: result } = await enrichThreadTurnsFromRollout(thread);
    assert.deepEqual(result.turns[0]!.items, thread.turns[0]!.items);
    assert.equal(result.turns[1]!.items.length, 3);
    const injected = result.turns[1]!.items[1]!;
    assert.equal(injected.type, 'reasoning');
    if (injected.type === 'reasoning') assert.deepEqual(injected.summary, ['Injected']);
  });

  test('should_interleave_reasoning_with_tool_calls_in_correct_order', async () => {
    const rolloutPath = writeRollout([
      context('turn_1'),
      userLine('Do it'),
      { timestamp: 't2', type: 'response_item', payload: { type: 'function_call', name: 'write_file', arguments: '{}', call_id: 'call_1' } },
      reasoningLine('Now I need to read it back'),
      { timestamp: 't4', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: { type: 'text', text: 'ok' } } },
      { timestamp: 't5', type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: '{}', call_id: 'call_2' } },
      reasoningLine('Let me continue'),
      { timestamp: 't7', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_2', output: { type: 'text', text: 'content' } } },
      assistantLine('Done'),
    ]);
    const thread = makeThread([
      makeTurn([
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Do it', text_elements: [] }] },
        { type: 'mcpToolCall', id: 'tc1', server: 'fs', tool: 'write_file', status: 'completed', arguments: {}, result: null, error: null, durationMs: 10 } as v2.ThreadItem,
        { type: 'mcpToolCall', id: 'tc2', server: 'fs', tool: 'read_file', status: 'completed', arguments: {}, result: null, error: null, durationMs: 10 } as v2.ThreadItem,
        agentMessage('a1', 'Done'),
      ], 'turn_1'),
    ], rolloutPath);

    const { thread: result } = await enrichThreadTurnsFromRollout(thread);
    assert.deepEqual(result.turns[0]!.items.map((item) => item.type), [
      'userMessage', 'mcpToolCall', 'reasoning', 'mcpToolCall', 'reasoning', 'agentMessage',
    ]);
  });

  test('should_skip_reasoning_with_whitespace_only_content', async () => {
    const rolloutPath = writeRollout([
      context('turn_1'),
      reasoningLine('\n\n'),
      reasoningLine('real thought'),
      assistantLine('Reply'),
    ]);
    const thread = makeThread([makeTurn([agentMessage('item_1', 'Reply')], 'turn_1')], rolloutPath);

    const { thread: result } = await enrichThreadTurnsFromRollout(thread);
    assert.equal(result.turns[0]!.items.length, 2);
    const reasoning = result.turns[0]!.items[0]!;
    assert.equal(reasoning.type, 'reasoning');
    if (reasoning.type === 'reasoning') assert.deepEqual(reasoning.content, ['real thought']);
  });

  test('keeps reasoning from both sides of a mid-turn compaction', async () => {
    const rolloutPath = writeRollout([
      context('turn_1'),
      reasoningLine('before compaction'),
      { timestamp: 't', type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: '{}', call_id: 'call_1' } },
      context('turn_1'),
      reasoningLine('after compaction'),
      assistantLine('Done'),
    ]);
    const thread = makeThread([
      makeTurn([
        { type: 'mcpToolCall', id: 'tc1', server: 'fs', tool: 'read_file', status: 'completed', arguments: {}, result: null, error: null, durationMs: 10 } as v2.ThreadItem,
        agentMessage('a1', 'Done'),
      ], 'turn_1'),
    ], rolloutPath);

    const { thread: result } = await enrichThreadTurnsFromRollout(thread);
    const items = result.turns[0]!.items;
    assert.deepEqual(items.map((item) => item.type), ['reasoning', 'mcpToolCall', 'reasoning', 'agentMessage']);
    if (items[0]!.type === 'reasoning') assert.deepEqual(items[0]!.content, ['before compaction']);
    if (items[2]!.type === 'reasoning') assert.deepEqual(items[2]!.content, ['after compaction']);
  });

  // Bounded reading.

  test('reads only the tail needed for a page at the end of a large history', async () => {
    const filler = 'x'.repeat(2000);
    const lines: object[] = [];
    for (let index = 0; index < 4000; index += 1) {
      lines.push(context(`old_${index}`), userLine(filler), reasoningLine('old thought'), assistantLine('old reply'));
    }
    lines.push(
      context('page_1'),
      { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', name: 'js_repl', call_id: 'cmd_1', input: 'await page.reload();' } },
      context('page_2'),
      reasoningLine('page thought'),
      assistantLine('Reply'),
    );
    const rolloutPath = writeRollout(lines);
    const fileSize = statSync(rolloutPath).size;
    assert.ok(fileSize > 8 * 1024 * 1024);

    const thread = makeThread([
      makeTurn([jsRepl('cmd_1', 'ok')], 'page_1'),
      makeTurn([agentMessage('a2', 'Reply')], 'page_2'),
    ], rolloutPath);

    const result = await enrichThreadTurnsFromRollout(thread);
    assert.equal(result.status, 'enriched');
    assert.equal(result.fileSize, fileSize);
    assert.ok(result.bytesRead <= ROLLOUT_TAIL_CHUNK_BYTES, `read ${result.bytesRead} bytes`);
    assert.ok(result.bytesRead < fileSize / 10);
    assert.equal((result.thread.turns[0]!.items[0] as SourceItem).sourceInput, 'await page.reload();');
    assert.deepEqual(result.thread.turns[1]!.items.map((item) => item.type), ['reasoning', 'agentMessage']);
  });

  test('returns the page unchanged when the byte budget runs out first', async () => {
    const filler = 'y'.repeat(2000);
    const lines: object[] = [context('turn_old'), reasoningLine('too far back'), assistantLine('Old')];
    for (let index = 0; index < 200; index += 1) {
      lines.push(context(`newer_${index}`), userLine(filler), assistantLine('newer'));
    }
    const rolloutPath = writeRollout(lines);
    const thread = makeThread([makeTurn([agentMessage('a1', 'Old')], 'turn_old')], rolloutPath);

    const result = await enrichThreadTurnsFromRollout(thread, { byteBudget: 64 * 1024, chunkBytes: 16 * 1024 });
    assert.equal(result.status, 'budget');
    assert.equal(result.thread, thread);
    assert.ok(result.bytesRead <= 64 * 1024);
    assert.ok(ROLLOUT_TAIL_BYTE_BUDGET >= 32 * 1024 * 1024);
  });

  test('partial mode enriches only the newest turns read in full within the budget', async () => {
    const filler = 'z'.repeat(2000);
    const lines: object[] = [context('turn_old'), reasoningLine('too far back'), assistantLine('Old')];
    const turns: v2.Turn[] = [makeTurn([agentMessage('a_old', 'Old')], 'turn_old')];
    for (let index = 0; index < 200; index += 1) {
      lines.push(context(`mid_${index}`), userLine(filler), assistantLine('mid'));
      turns.push(makeTurn([agentMessage(`a_mid_${index}`, 'mid')], `mid_${index}`));
    }
    lines.push(context('turn_new'), reasoningLine('recent thought'), assistantLine('New'));
    turns.push(makeTurn([agentMessage('a_new', 'New')], 'turn_new'));
    const rolloutPath = writeRollout(lines);
    const thread = makeThread(turns, rolloutPath);

    const result = await enrichThreadTurnsFromRollout(thread, {
      byteBudget: 64 * 1024, chunkBytes: 16 * 1024, partial: true,
    });
    assert.equal(result.status, 'budget');
    assert.deepEqual(result.thread.turns[result.thread.turns.length - 1]!.items.map((item) => item.type), ['reasoning', 'agentMessage']);
    assert.deepEqual(result.thread.turns[0]!.items, thread.turns[0]!.items);
  });

  test('handles lines spanning chunks, a partial trailing line and non-JSON lines', async () => {
    const rolloutPath = writeRollout([
      'not json at all',
      context('turn_1'),
      { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', name: 'js_repl', call_id: 'cmd_1', input: `await page.fill("#q", "${'é'.repeat(300)}");` } },
      '{"broken":',
      reasoningLine('chunked thought'),
      assistantLine('Done'),
    ], '{"timestamp":"t","type":"response_item","payload":{"type":"reas');
    for (const chunkBytes of [1, 7, 64, 4096]) {
      const thread = makeThread([
        makeTurn([jsRepl('cmd_1', 'ok'), agentMessage('a1', 'Done')], 'turn_1'),
      ], rolloutPath);
      const result = await enrichThreadTurnsFromRollout(thread, { chunkBytes });
      assert.equal(result.status, 'enriched', `chunk ${chunkBytes}`);
      const items = result.thread.turns[0]!.items;
      assert.deepEqual(items.map((item) => item.type), ['commandExecution', 'reasoning', 'agentMessage'], `chunk ${chunkBytes}`);
      assert.equal((items[0] as SourceItem).sourceInput, `await page.fill("#q", "${'é'.repeat(300)}");`);
    }
  });

  test('returns the page unchanged when the saved history is missing', async () => {
    const thread = makeThread([makeTurn([agentMessage('a1', 'Hi')], 'turn_1')], join(tmpDir, 'missing.jsonl'));
    const result = await enrichThreadTurnsFromRollout(thread);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.thread, thread);
  });

  test('does not open the file when no turn can gain anything', async () => {
    const thread = makeThread([
      makeTurn([
        { type: 'reasoning', id: 'r1', summary: [], content: ['native'] },
        agentMessage('a1', 'Hi'),
      ], 'turn_1'),
    ], join(tmpDir, 'missing.jsonl'));
    const result = await enrichThreadTurnsFromRollout(thread);
    assert.equal(result.status, 'skipped');
    assert.equal(result.bytesRead, 0);
  });

  test('is asynchronous and uses no synchronous file API', async () => {
    const thread = makeThread([makeTurn([agentMessage('a1', 'Hi')])]);
    const pending = enrichThreadTurnsFromRollout(thread);
    assert.ok(pending instanceof Promise);
    await pending;
    const source = readFileSync(new URL('./threadRolloutEnrichment.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Sync\s*\(/);
    assert.doesNotMatch(source, /from ['"](node:)?fs['"]/);
  });
});
