import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { boundNativeTerminalStatus, validateNativeTerminalRequest } from './native-terminal-status';
import { CodexService, type CodexClient, NativeCustodyPhaseError } from './service';

const owner = { threadId: '00000000-0000-4000-8000-000000000001', turnId: 'turn_1',
  itemId: 'item_1', nativeProcessId: 'native_1', terminalGeneration: 17, maxWaitMs: 50 };
const running = { phase: 'running' as const, outputBytes: 3, outputSha256: 'a'.repeat(64),
  outputCapReached: false, exitCode: null, terminalGeneration: 17, observationTimedOut: true };

describe('owner-bound OIX native terminal observation', () => {
  test('exact identifiers and bounded generation/wait are mandatory', () => {
    validateNativeTerminalRequest(owner);
    for (const bad of [{ ...owner, threadId: 'not-a-thread' }, { ...owner, nativeProcessId: 'private prose !' },
      { ...owner, terminalGeneration: 0 }, { ...owner, maxWaitMs: 1001 }, { ...owner, maxWaitMs: -1 }]) {
      assert.throws(() => validateNativeTerminalRequest(bad));
    }
  });

  test('running and exited retain one generation and bounded output; unknown or reused generation never asserts OS custody', () => {
    assert.deepEqual(boundNativeTerminalStatus(running, 17), running);
    const exited = { ...running, phase: 'exited', outputBytes: 9, outputSha256: 'b'.repeat(64),
      exitCode: 0, observationTimedOut: false };
    assert.deepEqual(boundNativeTerminalStatus(exited, 17), exited);
    assert.equal(boundNativeTerminalStatus(exited, 18).phase, 'unknown');
    assert.equal(boundNativeTerminalStatus({ ...running, phase: 'unknown', outputSha256: null,
      terminalGeneration: null }, 17).phase, 'unknown');
    assert.throws(() => boundNativeTerminalStatus({ ...running, command: 'PRIVATE COMMAND',
      outputSha256: 'not-a-digest' }, 17));
    assert.throws(() => boundNativeTerminalStatus({ ...running, phase: 'exited' }, 17));
  });

  test('late RPC remains alive after deadline, cannot become a success or trigger a second request', async () => {
    let resolve!: (value: typeof running) => void;
    let calls = 0;
    const client = { subscribe: () => () => {}, threadBackgroundTerminalsStatus: async () => {
      calls++; return new Promise<typeof running>((done) => { resolve = done; });
    } } as unknown as CodexClient;
    const phases: string[] = [];
    const service = new CodexService(client);
    await assert.rejects(service.readNativeTerminalStatus(owner, 5,
      (phase, status) => phases.push(`${phase}:${status}`)),
    (error: unknown) => error instanceof NativeCustodyPhaseError && error.phase === 'terminal_status' && error.category === 'deadline');
    resolve(running);
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(calls, 1);
    assert.deepEqual(phases, ['terminal_status:started', 'terminal_status:late_completed']);
  });

  test('unsupported native client fails closed without calling another native operation', async () => {
    const service = new CodexService({ subscribe: () => () => {} } as unknown as CodexClient);
    await assert.rejects(service.readNativeTerminalStatus(owner), { phase: 'terminal_status', category: 'native_unavailable' });
  });

  test('native list strips command, cwd and OS metadata and rejects missing .59 owner identity', async () => {
    const client = { subscribe: () => () => {}, threadBackgroundTerminalsList: async () => ({
      data: [{ itemId: owner.itemId, turnId: owner.turnId, nativeProcessId: owner.nativeProcessId,
        terminalGeneration: owner.terminalGeneration, command: 'PRIVATE COMMAND', cwd: '/private/work',
        osPid: 42 }], nextCursor: null,
    }) } as unknown as CodexClient;
    const result = await new CodexService(client).listNativeTerminalOwners(owner.threadId);
    assert.deepEqual(result, { data: [{ threadId: owner.threadId, turnId: owner.turnId,
      itemId: owner.itemId, nativeProcessId: owner.nativeProcessId,
      terminalGeneration: owner.terminalGeneration }], nextCursor: null });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private|osPid|command/);
    client.threadBackgroundTerminalsList = async () => ({ data: [{ itemId: owner.itemId,
      turnId: owner.turnId, nativeProcessId: null, terminalGeneration: 17 }], nextCursor: null });
    await assert.rejects(new CodexService(client).listNativeTerminalOwners(owner.threadId));
    client.threadBackgroundTerminalsList = async () => ({ data: [owner, owner], nextCursor: null });
    await assert.rejects(new CodexService(client).listNativeTerminalOwners(owner.threadId),
      { phase: 'terminal_status', category: 'native_unavailable' });
    client.threadBackgroundTerminalsList = async () => ({ data: [owner], nextCursor: 'cursor_1' });
    await assert.rejects(new CodexService(client).listNativeTerminalOwners(owner.threadId, 'cursor_1'),
      { phase: 'terminal_status', category: 'native_unavailable' });
  });
});
