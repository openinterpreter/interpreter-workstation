import { afterEach, describe, expect, test } from 'bun:test';
import express, { type Response } from 'express';
import request from 'supertest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCodexService, NativeCustodyPhaseError, ThreadNotFoundError,
  NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS,
  NATIVE_CUSTODY_GLOBAL_OPERATOR_DEADLINE_MS } from '../../src/lib/codex/service';
import { nativeSubmissionJournal } from '../utils/nativeSubmissionJournal';
import { THREAD_INPUT_SOURCE, WakeSources, type WakeEvent, type WakeNative }
  from '../utils/wakeSources';
import { useWakeSourcesForTest, wakeNative } from '../utils/wakeSourcesRuntime';
import agentRouter, { streamThreadInput, threadInputTiming } from './agent';

const app = express();
app.use(express.json());
app.use('/api/agent', agentRouter);
const id = '00000000-0000-4000-8000-000000000001';
const workspace = path.join(os.tmpdir(), 'thread-input-workspace');
const previous = process.env.WORKSTATION_WAKE_TOKEN;
afterEach(() => {
  if (previous === undefined) delete process.env.WORKSTATION_WAKE_TOKEN;
  else process.env.WORKSTATION_WAKE_TOKEN = previous;
});

/** A native thread fake. `start` makes its turn active; `busyTurn` starts
 * active. Without `receipts`, offers never appear in history. */
function threadNative(options: { busyTurn?: string; receipts?: boolean; start?: WakeNative['start'] } = {}) {
  let active = options.busyTurn;
  let starts = 0;
  const clientIds: string[] = [];
  const clientTurns: Array<{ clientId: string; turnId: string }> = [];
  const offered: string[] = [];
  const offer = (message: string, clientId: string | undefined, turnId: string) => {
    offered.push(message);
    if (options.receipts !== false && clientId) { clientIds.push(clientId); clientTurns.push({ clientId, turnId }); }
  };
  const native: WakeNative = {
    inspect: async () => ({ activeTurnId: active, messages: [], clientIds: [...clientIds], clientTurns: [...clientTurns] }),
    steer: async (_thread, turnId, message, clientId) => { offer(message, clientId, turnId); return turnId; },
    start: options.start ?? (async (_thread, message, clientId) => {
      const turnId = `turn-${++starts}`;
      active = turnId;
      offer(message, clientId, turnId);
      return turnId;
    }),
  };
  return { native, offered };
}

/** Serve the routes from an isolated wake instance on a temporary home; the
 * process instance is restored (uninitialized) afterwards. */
async function withThreadInput(native: WakeNative, run: (wake: WakeSources, root: string) => Promise<void>,
  options: { state?: { sources: unknown[]; events: unknown[] }; timing?: { intervalMs: number; followUpMs: number };
    shell?: (threadId: string) => Promise<unknown> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'thread-input-route-'));
  if (options.state) await writeFile(path.join(root, 'wake-sources.json'), JSON.stringify(options.state));
  const wake = new WakeSources(native, root, 30_000, options.timing ?? { intervalMs: 20, followUpMs: 0 });
  await wake.initialize();
  useWakeSourcesForTest(wake);
  const service = getCodexService();
  const readThreadShell = service.readThreadShell;
  service.readThreadShell = (options.shell ?? (async (threadId: string) => ({ id: threadId, cwd: workspace,
    status: 'idle', parentThreadId: null, ephemeral: false }))) as typeof service.readThreadShell;
  const wait = threadInputTiming.admissionWaitMs;
  try { await run(wake, root); }
  finally {
    useWakeSourcesForTest();
    service.readThreadShell = readThreadShell;
    threadInputTiming.admissionWaitMs = wait;
    await wake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function until(done: () => boolean, attempts = 300): Promise<void> {
  for (let i = 0; i < attempts && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10));
}

const input = (extra: Record<string, unknown> = {}) => ({ mode: 'headless', threadId: id,
  clientUserMessageId: 'client_1', message: 'new input', workspace, ...extra });

describe('programmatic input to an existing thread', () => {
  test('requires a client message ID and rejects settings that cannot apply to queued input', async () => {
    const fake = threadNative();
    await withThreadInput(fake.native, async (wake) => {
      for (const route of ['/api/agent/tasks/stream', '/api/agent/tasks']) {
        const missing = await request(app).post(route).send(input({ clientUserMessageId: undefined }));
        expect(missing.status).toBe(400);
        expect(missing.body.error).toContain('clientUserMessageId is required');
        expect((await request(app).post(route).send(input({ clientUserMessageId: 'bad id' }))).status).toBe(400);
        for (const [field, value] of Object.entries({ model: 'gpt-5.6-sol', reasoningEffort: 'low', modelConfig: {},
          runtimeConfig: {}, system: 'extra', timeoutMs: 1000, idleTimeoutMs: 0 })) {
          const response = await request(app).post(route).send(input({ [field]: value }));
          expect(response.status).toBe(400);
          expect(response.body.error).toContain(field);
        }
        expect((await request(app).post(route).send(input({ workspace: undefined }))).status).toBe(400);
      }
      expect(wake.list(id).events).toEqual([]);
      expect(fake.offered).toEqual([]);
    });
  });

  test('a message over the event limit, counting the sender line, is rejected before custody', async () => {
    await withThreadInput(threadNative().native, async (wake) => {
      const over = await request(app).post('/api/agent/tasks/stream').send(input({ message: 'x'.repeat(32_001) }));
      expect(over.status).toBe(400);
      expect(over.body.error).toContain('32000');
      const withSender = await request(app).post('/api/agent/tasks/stream').send(input({ message: 'x'.repeat(32_000),
        sender: { computer: 'peer-host' } }));
      expect(withSender.status).toBe(400);
      expect(wake.list(id).events).toEqual([]);
    });
  });

  test("the workspace must equal the thread's workspace, whether or not a tab is bound", async () => {
    await withThreadInput(threadNative().native, async (wake) => {
      for (const route of ['/api/agent/tasks/stream', '/api/agent/tasks']) {
        const response = await request(app).post(route).send(input({ workspace: path.join(os.tmpdir(), 'elsewhere') }));
        expect(response.status).toBe(400);
        expect(response.body.error).toContain('workspace');
      }
      expect(wake.list(id).events).toEqual([]);
    });
  });

  test('a missing thread is 404, an unreadable one 503, and nothing is retained', async () => {
    let failure: Error = new ThreadNotFoundError(id);
    await withThreadInput(threadNative().native, async (wake) => {
      const missing = await request(app).post('/api/agent/tasks').send(input());
      expect(missing.status).toBe(404);
      failure = new Error('Native thread read timed out');
      const unreadable = await request(app).post('/api/agent/tasks').send(input());
      expect(unreadable.status).toBe(503);
      expect(unreadable.body.error).not.toContain('not found');
      expect(wake.list(id).events).toEqual([]);
    }, { shell: async () => { throw failure; } });
  });

  test('several inputs to a busy thread are steered in order, and the stream reports the admission of its own', async () => {
    const fake = threadNative({ busyTurn: 'turn-busy' });
    await withThreadInput(fake.native, async (wake) => {
      for (const clientId of ['first_1', 'second_1']) {
        expect((await request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: clientId,
          message: `input ${clientId}` }))).status).toBe(202);
      }
      const response = await request(app).post('/api/agent/tasks/stream').send(input({
        sender: { computer: 'peer-host', thread: 'origin_1' } }));
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      const text = response.text;
      expect(text.indexOf('event: submission')).toBeLessThan(text.indexOf('event: admitted'));
      expect(text).toContain(`"clientUserMessageId":"client_1","status":"pending"`);
      expect(text).toContain('event: thread');
      // The turn holding the receipt; no status is claimed for it.
      expect(text).toContain(`event: turn\ndata: {"threadId":"${id}","turnId":"turn-busy"}\n`);
      expect(text).toContain(`event: admitted\ndata: {"threadId":"${id}","turnId":"turn-busy","clientUserMessageId":"client_1"}`);
      expect(text).not.toContain('event: error');
      expect(fake.offered).toEqual([
        `[Wake event ${THREAD_INPUT_SOURCE}/first_1]\ninput first_1`,
        `[Wake event ${THREAD_INPUT_SOURCE}/second_1]\ninput second_1`,
        `[Wake event ${THREAD_INPUT_SOURCE}/client_1]\n[Sender: peer-host thread origin_1]\nnew input`]);
      expect(wake.list(id).events.map(e => [e.eventId, e.status, e.turnId])).toEqual([
        ['first_1', 'admitted', 'turn-busy'], ['second_1', 'admitted', 'turn-busy'], ['client_1', 'admitted', 'turn-busy']]);
      expect(wake.list(id).events[2]).toMatchObject({ sender: { computer: 'peer-host', thread: 'origin_1' } });

      // A repeat of the same input replays the recorded state and never submits again.
      const repeated = await request(app).post('/api/agent/tasks/stream').send(input({
        sender: { computer: 'peer-host', thread: 'origin_1' } }));
      expect(repeated.status).toBe(200);
      expect(repeated.text).toContain(`"clientUserMessageId":"client_1","status":"admitted"`);
      expect(repeated.text).toContain(`"turnId":"turn-busy","clientUserMessageId":"client_1"`);
      // The same ID with other content is refused without revealing the stored input.
      for (const route of ['/api/agent/tasks/stream', '/api/agent/tasks']) {
        const changed = await request(app).post(route).send(input({ message: 'changed' }));
        expect(changed.status).toBe(409);
        expect(changed.body.error).toBe('Client ID already used for different input.');
        expect(JSON.stringify(changed.body)).not.toContain('new input');
      }
      expect(fake.offered).toHaveLength(3);
    });
  });

  test('thread input is ordered after an earlier input of a registered source on the same thread', async () => {
    const fake = threadNative({ busyTurn: 'turn-busy' });
    await withThreadInput(fake.native, async (wake) => {
      await wake.put({ id: 'daily', threadId: id, kind: 'schedule', message: 'scheduled input',
        at: new Date(Date.now() - 1_000).toISOString() });
      await wake.tick(); // creates and offers daily-1
      expect((await request(app).post('/api/agent/tasks').send(input())).status).toBe(202);
      for (let i = 0; i < 6; i++) await wake.tick();
      expect(fake.offered.map(message => message.split('\n')[0])).toEqual(['[Wake event daily/daily-1]',
        `[Wake event ${THREAD_INPUT_SOURCE}/client_1]`]);
    }, { timing: { intervalMs: 0, followUpMs: 0 } });
  });

  test('a pending thread input retained before a restart is delivered once after it', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const state = { sources: [], events: [{ threadId: id, sourceId: THREAD_INPUT_SOURCE, eventId: 'restart_1',
      message: 'input retained by the previous process', status: 'pending', createdAt: new Date().toISOString() }] };
    const fake = threadNative();
    await withThreadInput(fake.native, async (wake) => {
      expect((await wake.whenSettled(id, THREAD_INPUT_SOURCE, 'restart_1', 5_000))?.status).toBe('admitted');
      const custody = await request(app).get(`/api/agent/threads/${id}/submissions/restart_1/custody`)
        .set('Authorization', 'Bearer test-private-token');
      expect(custody.body).toEqual({ threadId: id, clientUserMessageId: 'restart_1', status: 'admitted', turnId: 'turn-1' });
      // The caller's retry after the restart answers from the record.
      const retried = await request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'restart_1',
        message: 'input retained by the previous process' }));
      expect(retried.body).toMatchObject({ status: 'admitted' });
      expect(fake.offered).toHaveLength(1);
    }, { state });
  });

  test('concurrent requests with one ID retain one input and answer both', async () => {
    const fake = threadNative();
    await withThreadInput(fake.native, async (wake) => {
      const [a, b] = await Promise.all([
        request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'same_1' })),
        request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'same_1' })),
      ]);
      expect([a.status, b.status]).toEqual([202, 202]);
      expect(a.body.clientUserMessageId).toBe('same_1');
      expect(b.body.clientUserMessageId).toBe('same_1');
      expect(wake.list(id).events.filter(e => e.eventId === 'same_1')).toHaveLength(1);
      expect((await wake.whenSettled(id, THREAD_INPUT_SOURCE, 'same_1', 5_000))?.status).toBe('admitted');
      expect(fake.offered).toHaveLength(1);
    });
  });

  test('a failed write answers 503 asking for a retry with the same ID, which then succeeds', async () => {
    const fake = threadNative();
    await withThreadInput(fake.native, async (wake, root) => {
      const write = (wake as any).writeState.bind(wake);
      let failing = true;
      (wake as any).writeState = async () => { if (failing) throw new Error('disk full'); return write(); };
      const failed = await request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'disk_1' }));
      expect(failed.status).toBe(503);
      expect(failed.body.error).toContain('same clientUserMessageId');
      await new Promise(resolve => setTimeout(resolve, 100)); // background passes offer nothing meanwhile
      expect(fake.offered).toEqual([]);
      failing = false;
      const retried = await request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'disk_1' }));
      expect(retried.status).toBe(202);
      const saved = JSON.parse(await readFile(path.join(root, 'wake-sources.json'), 'utf8')) as { events: WakeEvent[] };
      expect(saved.events.map(e => e.eventId)).toEqual(['disk_1']);
      expect((await wake.whenSettled(id, THREAD_INPUT_SOURCE, 'disk_1', 5_000))?.status).toBe('admitted');
      expect(fake.offered).toHaveLength(1);
    });
  });

  test('a repeat arriving while the first write is outstanding is not acknowledged from memory', async () => {
    const fake = threadNative();
    await withThreadInput(fake.native, async (wake) => {
      const write = (wake as any).writeState.bind(wake);
      let failing = false;
      let release!: () => void;
      let hold: Promise<void> | undefined = new Promise<void>(resolve => { release = resolve; });
      (wake as any).writeState = async () => {
        const held = hold; hold = undefined;
        if (held) await held;
        if (failing) throw new Error('disk full');
        return write();
      };
      const first = request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'held_1' }))
        .then(response => response);
      await until(() => wake.list(id).events.length === 1);
      let answered = false;
      const repeat = request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'held_1' }))
        .then(response => { answered = true; return response; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(answered).toBe(false);
      // The first write fails: the repeat is not told the input is stored.
      failing = true;
      release();
      expect((await first).status).toBe(503);
      expect((await repeat).status).toBe(503);
      expect(fake.offered).toEqual([]);
    }, { timing: { intervalMs: 0, followUpMs: 0 } });
  });

  test('stopping the queue ends an open stream with the input still queued', async () => {
    const fake = threadNative({ receipts: false });
    await withThreadInput(fake.native, async (wake) => {
      threadInputTiming.admissionWaitMs = 60_000;
      const streaming = request(app).post('/api/agent/tasks/stream').send(input({ clientUserMessageId: 'open_1' }))
        .then(response => response);
      await until(() => wake.list(id).events.some(e => e.eventId === 'open_1' && e.status === 'offered'));
      const started = Date.now();
      await wake.stop();
      const response = await streaming;
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(response.text).toContain(`event: queued\ndata: {"threadId":"${id}","clientUserMessageId":"open_1","status":"offered"}`);
    });
  });

  test('POST /tasks with a thread acknowledges custody with 202 and does not wait for the turn', async () => {
    const fake = threadNative();
    await withThreadInput(fake.native, async (wake) => {
      const response = await request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'queued_1' }));
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ threadId: id, clientUserMessageId: 'queued_1', status: 'pending' });
      expect((await wake.whenSettled(id, THREAD_INPUT_SOURCE, 'queued_1', 5_000))?.status).toBe('admitted');
      const repeated = await request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'queued_1' }));
      expect(repeated.status).toBe(202);
      expect(repeated.body.status).toBe('admitted');
      expect(fake.offered).toHaveLength(1);
    });
  });

  test('input not admitted within the wait is reported queued, without an error', async () => {
    const fake = threadNative({ receipts: false });
    await withThreadInput(fake.native, async (wake) => {
      threadInputTiming.admissionWaitMs = 300;
      const response = await request(app).post('/api/agent/tasks/stream').send(input({ clientUserMessageId: 'slow_1' }));
      expect(response.status).toBe(200);
      expect(response.text).toContain(`event: queued\ndata: {"threadId":"${id}","clientUserMessageId":"slow_1","status":"offered"}`);
      expect(response.text).not.toContain('event: error');
      expect(response.text).not.toContain('event: admitted');
      expect(wake.list(id).events[0]?.status).toBe('offered');
    });
  });

  test("the runtime's steer refusal, mapped by the production adapter, reaches the stream with the parent", async () => {
    const parent = '00000000-0000-4000-8000-000000000004';
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    // The production adapter over a service whose thread is busy and whose
    // runtime refuses direct input with its own message.
    const service = getCodexService();
    const saved = { scan: service.scanTurnsNewestFirst, steer: service.steer, start: service.startExistingThreadTurn };
    let steers = 0;
    service.scanTurnsNewestFirst = (async (_threadId: string, visit: (turn: any) => boolean) => {
      visit({ id: 'turn-busy', status: 'inProgress', items: [], itemsView: 'full', startedAt: null, completedAt: null });
    }) as typeof service.scanTurnsNewestFirst;
    service.steer = (async () => {
      steers++;
      throw new Error('direct app-server input is not allowed for multi-agent v2 sub-agents');
    }) as typeof service.steer;
    service.startExistingThreadTurn = (async () => { throw new Error('unexpected start'); }) as typeof service.startExistingThreadTurn;
    try { await withThreadInput(wakeNative, async (wake) => {
      const response = await request(app).post('/api/agent/tasks/stream').send(input({ clientUserMessageId: 'late_1' }));
      expect(response.status).toBe(200);
      expect(response.text).toContain('event: error');
      expect(response.text).toContain('"code":"subagent_direct_input_unsupported"');
      expect(response.text).toContain(`"threadId":"${id}"`);
      expect(response.text).toContain(`"parentThreadId":"${parent}"`);
      expect(response.text).toContain(`only takes work through its parent thread ${parent}`);
      expect(response.text).not.toContain('event: admitted');
      expect(wake.list(id).events[0]).toMatchObject({ status: 'refused', message: '' });
      const custody = await request(app).get(`/api/agent/threads/${id}/submissions/late_1/custody`)
        .set('Authorization', 'Bearer test-private-token');
      expect(custody.body).toEqual({ threadId: id, clientUserMessageId: 'late_1', status: 'refused',
        code: 'subagent_direct_input_unsupported', parentThreadId: parent });
      // A repeat reports the same refusal and submits nothing.
      const repeated = await request(app).post('/api/agent/tasks/stream').send(input({ clientUserMessageId: 'late_1' }));
      expect(repeated.text).toContain(`"parentThreadId":"${parent}"`);
      expect(steers).toBe(1);
    }, { shell: async (threadId: string) => ({ id: threadId, cwd: workspace, status: 'active',
      parentThreadId: parent, ephemeral: false }) }); }
    finally {
      service.scanTurnsNewestFirst = saved.scan;
      service.steer = saved.steer;
      service.startExistingThreadTurn = saved.start;
    }
  });

  test('the wake-event route cannot claim the thread input source', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const response = await request(app).post(`/api/agent/threads/${id}/wake-events`)
      .set('Authorization', 'Bearer test-private-token')
      .send({ sourceId: THREAD_INPUT_SOURCE, eventId: 'client_9', message: 'input' });
    expect(response.status).toBe(400);
  });

  test('the wake-event route refuses input for a cancelled source and retains nothing', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    await withThreadInput(threadNative().native, async (wake) => {
      await wake.put({ id: 'gone', threadId: id, kind: 'schedule', message: 'unused',
        at: new Date(Date.now() + 10_000_000).toISOString() });
      await wake.cancel(id, 'gone');
      const response = await request(app).post(`/api/agent/threads/${id}/wake-events`)
        .set('Authorization', 'Bearer test-private-token')
        .send({ sourceId: 'gone', eventId: 'late_1', message: 'input' });
      expect(response.status).toBe(400);
      expect(wake.list(id).events).toEqual([]);
      // A source without a record still takes input.
      const other = await request(app).post(`/api/agent/threads/${id}/wake-events`)
        .set('Authorization', 'Bearer test-private-token')
        .send({ sourceId: 'producer', eventId: 'late_2', message: 'input' });
      expect(other.status).toBe(202);
    }, { timing: { intervalMs: 0, followUpMs: 0 } });
  });

  test('a repeat of a stored client ID is answered from the stored input while the thread cannot be read', async () => {
    let down = false;
    const fake = threadNative({ busyTurn: 'turn-busy' });
    await withThreadInput(fake.native, async (wake) => {
      expect((await request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'down_1' }))).status).toBe(202);
      expect((await wake.whenSettled(id, THREAD_INPUT_SOURCE, 'down_1', 5_000))?.status).toBe('admitted');
      down = true; // the runtime cannot be reached any more
      const repeated = await request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'down_1' }));
      expect(repeated.status).toBe(202);
      expect(repeated.body).toEqual({ threadId: id, clientUserMessageId: 'down_1', status: 'admitted' });
      const streamed = await request(app).post('/api/agent/tasks/stream').send(input({ clientUserMessageId: 'down_1' }));
      expect(streamed.status).toBe(200);
      expect(streamed.text).toContain(`"clientUserMessageId":"down_1","status":"admitted"`);
      expect(streamed.text).toContain(`event: admitted\ndata: {"threadId":"${id}","turnId":"turn-busy","clientUserMessageId":"down_1"}`);
      // Other content under the same ID is a conflict, also without a thread read.
      const changed = await request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'down_1', message: 'other' }));
      expect(changed.status).toBe(409);
      // A new ID still needs the thread.
      expect((await request(app).post('/api/agent/tasks').send(input({ clientUserMessageId: 'down_2' }))).status).toBe(503);
      expect(fake.offered).toHaveLength(1);
    }, { shell: async (threadId: string) => {
      if (down) throw new Error('Native thread read timed out');
      return { id: threadId, cwd: workspace, status: 'active', parentThreadId: null, ephemeral: false };
    } });
  });

  test('a stream whose client disconnected during custody, or whose write fails, leaves no waiter behind', async () => {
    const fake = threadNative({ receipts: false });
    await withThreadInput(fake.native, async (wake) => {
      threadInputTiming.admissionWaitMs = 60_000;
      const event = await wake.ingest(id, THREAD_INPUT_SOURCE, 'gone_1', 'input');
      const written: string[] = [];
      const response = {
        destroyed: true, writableEnded: false,
        setHeader() {}, flushHeaders() {}, end() {}, on() {},
        write(chunk: string) { written.push(chunk); return true; },
      };
      // 'close' fired before the stream began: nothing is written and nothing waits.
      const disconnected = streamThreadInput(response as unknown as Response, event);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(wake.waiterCount()).toBe(0);
      await disconnected;
      expect(written).toEqual([]);
      // A write that fails ends the observation the same way.
      const failing = { ...response, destroyed: false, write() { throw new Error('socket closed'); } };
      const broken = streamThreadInput(failing as unknown as Response, event);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(wake.waiterCount()).toBe(0);
      await broken;
    }, { timing: { intervalMs: 0, followUpMs: 0 } });
  });

  test('submission custody reports each wake event status and turn, never the message', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const createdAt = '2026-11-20T00:00:00.000Z';
    const event = (eventId: string, status: WakeEvent['status'], extra: Partial<WakeEvent> = {}): WakeEvent =>
      ({ threadId: id, sourceId: THREAD_INPUT_SOURCE, eventId, message: 'private body', status, createdAt, ...extra });
    const state = { sources: [], events: [
      event('s_pending', 'pending'),
      event('s_offered', 'offered', { offeredAt: createdAt, turnId: 'turn-5' }),
      event('s_admitted', 'admitted', { message: '', turnId: 'turn-6' }),
      event('s_held', 'held', { error: 'Operator-held ambiguous native offer; not admitted or replayed' }),
      { ...event('s_other', 'pending'), sourceId: 'other-source' },
    ] };
    await withThreadInput(threadNative().native, async () => {
      const read = (clientId: string) => request(app).get(`/api/agent/threads/${id}/submissions/${clientId}/custody`)
        .set('Authorization', 'Bearer test-private-token');
      const expected: Record<string, Record<string, unknown>> = {
        s_pending: { status: 'pending' },
        // An offer whose turn is saved has been accepted by the runtime.
        s_offered: { status: 'offered', turnId: 'turn-5', accepted: true },
        s_admitted: { status: 'admitted', turnId: 'turn-6' },
        s_held: { status: 'held' },
      };
      for (const [clientId, fields] of Object.entries(expected)) {
        const result = await read(clientId);
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ threadId: id, clientUserMessageId: clientId, ...fields });
        expect(JSON.stringify(result.body)).not.toContain('private body');
      }
      expect((await read('s_other')).status).toBe(404);
      expect((await read('unknown_1')).status).toBe(404);
    }, { state, timing: { intervalMs: 0, followUpMs: 0 } });
  });
});

describe('native custody diagnostic authentication', () => {
  test('active steer reserves its stable client ID before native submission and rejects repeat', async () => {
    const service = getCodexService();
    const begin = nativeSubmissionJournal.begin;
    const advance = nativeSubmissionJournal.advance;
    const steer = service.steer;
    let claims = 0;
    let submissions = 0;
    nativeSubmissionJournal.begin = async () => ++claims === 1 ? ({ requestId: 'request_2',
      threadId: id, clientUserMessageId: 'steer_1', phase: 'received', turnId: null,
      at: '2026-11-12T00:00:00Z' }) : null;
    nativeSubmissionJournal.advance = async () => ({} as any);
    service.steer = async () => { submissions++; return 'turn_1'; };
    try {
      const body = { threadId: id, turnId: 'turn_1', message: 'new steer',
        clientUserMessageId: 'steer_1', attachments: [], skills: [] };
      expect((await request(app).post('/api/agent/chat/steer').send(body)).status).toBe(200);
      const repeated = await request(app).post('/api/agent/chat/steer').send(body);
      expect(repeated.status).toBe(409);
      expect(repeated.body.code).toBe('submission_already_recorded');
      expect(submissions).toBe(1);
    } finally {
      nativeSubmissionJournal.begin = begin;
      nativeSubmissionJournal.advance = advance;
      service.steer = steer;
    }
  });
  test('global native operator route rejects missing bearer and emits only fixed failure metadata', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const route = '/api/agent/custody/native-global';
    expect((await request(app).get(route)).status).toBe(401);
    const service = getCodexService();
    const original = service.readGlobalNativeCustody;
    const originalInfo = console.info;
    const events: string[] = [];
    let deadline: number | undefined;
    service.readGlobalNativeCustody = async (value) => {
      deadline = value;
      throw new NativeCustodyPhaseError('verify_queue_read', 'deadline');
    };
    console.info = (value) => { events.push(String(value)); };
    try {
      const result = await request(app).get(route).set('Authorization', 'Bearer test-private-token');
      expect(result.status).toBe(503);
      expect(deadline).toBe(NATIVE_CUSTODY_GLOBAL_OPERATOR_DEADLINE_MS);
      expect(result.body).toMatchObject({ phase: 'verify_queue_read', category: 'deadline',
        custodyVerified: false });
      expect(result.body.inspectionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(events.map((event) => JSON.parse(event).phase)).toEqual(['request', 'verify_queue_read']);
      expect(events.join(' ')).not.toContain('test-private-token');
    } finally {
      service.readGlobalNativeCustody = original;
      console.info = originalInfo;
    }
  });
  test('submission receipt route requires exact thread, client ID and operator bearer', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const route = `/api/agent/threads/${id}/submissions/owned_1/custody`;
    expect((await request(app).get(route)).status).toBe(401);
    expect((await request(app).get(`/api/agent/threads/${id}/submissions/bad%20id/custody`)
      .set('Authorization', 'Bearer test-private-token')).status).toBe(400);
    // The thread ID alphabet is the one input to a thread is accepted with.
    expect((await request(app).get('/api/agent/threads/bad.thread/submissions/owned_1/custody')
      .set('Authorization', 'Bearer test-private-token')).status).toBe(400);
    // Without a configured token the read is never open, whatever is sent.
    delete process.env.WORKSTATION_WAKE_TOKEN;
    expect((await request(app).get(route).set('Authorization', 'Bearer test-private-token')).status).toBe(401);
    expect((await request(app).get(route).set('Authorization', 'Bearer ')).status).toBe(401);
  });
  test('rejects absent bearer and invalid thread without invoking the native client', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const denied = await request(app).get(`/api/agent/threads/${id}/native-custody`);
    expect(denied.status).toBe(401);
    const malformed = await request(app)
      .get('/api/agent/threads/not-an-id/native-custody')
      .set('Authorization', 'Bearer test-private-token');
    expect(malformed.status).toBe(400);
  });

  test('rejects absent configured secret even with caller bearer', async () => {
    delete process.env.WORKSTATION_WAKE_TOKEN;
    const denied = await request(app)
      .get(`/api/agent/threads/${id}/native-custody`)
      .set('Authorization', 'Bearer test-private-token');
    expect(denied.status).toBe(401);
  });

  test('returns only fixed phase metadata on a bounded native failure', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const service = getCodexService();
    const original = service.readNativeCustody;
    const originalInfo = console.info;
    const events: string[] = [];
    let observedDeadline: number | undefined;
    service.readNativeCustody = async (_thread, deadline) => {
      observedDeadline = deadline;
      throw new NativeCustodyPhaseError('thread_read', 'deadline');
    };
    console.info = (value) => { events.push(String(value)); };
    try {
      const result = await request(app).get(`/api/agent/threads/${id}/native-custody`)
        .set('Authorization', 'Bearer test-private-token');
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ phase: 'thread_read', category: 'deadline',
        custodyVerified: false });
      expect(result.body.inspectionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(observedDeadline).toBe(NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS);
      expect(events.map((event) => JSON.parse(event).phase)).toEqual(['request', 'thread_read']);
      expect(events.join(' ')).not.toContain('test-private-token');
    } finally {
      service.readNativeCustody = original;
      console.info = originalInfo;
    }
  });

  test('exact turn receipt requires bearer and both exact native IDs', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const turn = '00000000-0000-4000-8000-000000000002';
    const url = `/api/agent/threads/${id}/native-turn-receipt/${turn}`;
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(`/api/agent/threads/${id}/native-turn-receipt/nope`)
      .set('Authorization', 'Bearer test-private-token')).status).toBe(400);
    expect((await request(app).get(`/api/agent/threads/nope/native-turn-receipt/${turn}`)
      .set('Authorization', 'Bearer test-private-token')).status).toBe(400);
  });

  test('exact turn receipt reports only a fixed deadline phase, never private native output', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const service = getCodexService();
    const original = service.readNativeTurnReceipt;
    const originalInfo = console.info;
    const events: string[] = [];
    let observedDeadline: number | undefined;
    service.readNativeTurnReceipt = async (_thread, _turn, deadline) => {
      observedDeadline = deadline;
      throw new NativeCustodyPhaseError('thread_read', 'deadline');
    };
    console.info = (value) => { events.push(String(value)); };
    try {
      const result = await request(app)
        .get(`/api/agent/threads/${id}/native-turn-receipt/00000000-0000-4000-8000-000000000002`)
        .set('Authorization', 'Bearer test-private-token');
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ phase: 'thread_read', category: 'deadline', custodyVerified: false });
      expect(result.body.inspectionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(observedDeadline).toBe(NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS);
      expect(events.map((event) => JSON.parse(event).phase)).toEqual(['request', 'thread_read']);
      expect(events.join(' ')).not.toContain('test-private-token');
    } finally {
      service.readNativeTurnReceipt = original;
      console.info = originalInfo;
    }
  });

  test('ambiguous offer disposition requires the private bearer and an exact no-replay confirmation', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const route = `/api/agent/threads/${id}/wake-events/source/event/hold`;
    expect((await request(app).post(route).send({ turnId: 'turn-1', confirmedNoReplay: true })).status).toBe(401);
    expect((await request(app).post(route).set('Authorization', 'Bearer test-private-token')
      .send({ turnId: 'turn-1' })).status).toBe(400);
    expect((await request(app).post(route).set('Authorization', 'Bearer test-private-token')
      .send({ confirmedNoReplay: true })).status).toBe(400);
  });
  test('historical hold requires private bearer, exact native snapshot, and explicit no-replay decision', async () => {
    process.env.WORKSTATION_WAKE_TOKEN = 'test-private-token';
    const route = `/api/agent/threads/${id}/wake-events/source/event/hold-historical`;
    const body = { expectedClientId: 'wake_123', expectedLatestTurnId: 'latest',
      decisionRef: 'operator-ticket-1', confirmedNoReplay: true };
    expect((await request(app).post(route).send(body)).status).toBe(401);
    expect((await request(app).post(route).set('Authorization', 'Bearer test-private-token')
      .send({ ...body, confirmedNoReplay: false })).status).toBe(400);
    expect((await request(app).post(route).set('Authorization', 'Bearer test-private-token')
      .send({ expectedLatestTurnId: 'latest', confirmedNoReplay: true })).status).toBe(400);
  });
});
