import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { getInterpreterAppDataDir } from '../configStore';
import { nextCivilDaily } from './civilSchedule';

// A wake source belongs to an ordinary conversation. These records only keep
// custody until the native transcript contains the input; they do not track
// completion or outbound delivery.
export type WakeSource = {
  id: string;
  threadId: string;
  kind: 'schedule' | 'command';
  message?: string;
  at?: string;
  everyMs?: number;
  dailyAt?: string;
  timeZone?: string;
  argv?: string[];
  status: 'waiting' | 'running' | 'delivered' | 'error' | 'cancelled';
  nextAt?: string;
  error?: string;
  sequence: number;
};
export type WakeEvent = {
  threadId: string;
  sourceId: string;
  eventId: string;
  message: string;
  status: 'pending' | 'offered' | 'admitted';
  createdAt: string;
  offeredAt?: string;
  turnId?: string;
  nextAttemptAt?: string;
  error?: string;
};
type State = { sources: WakeSource[]; events: WakeEvent[] };
const EMPTY: State = { sources: [], events: [] };
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const MAX_MESSAGE = 32_000;
const MAX_STDOUT = 64_000;
const MIN_INTERVAL = 60_000;
// Leave room for a hyphen and the full decimal safe-integer sequence.
const MAX_SCHEDULE_ID = 143;
const COMMAND_REARM_MS = 30_000;
const marker = (source: string, id: string) => `[Wake event ${source}/${id}]`;
export const wakeInput = (event: WakeEvent) => `${marker(event.sourceId, event.eventId)}\n${event.message}`;
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/usage|quota|credit|billing|limit/.test(message)) return 'Usage limit reached; operator action required';
  if (/oauth|token|credential|authentication|unauthoriz|login/.test(message)) return 'Authentication unavailable; operator action required';
  if (/overload|capacity|unavailable|timeout|disconnect/.test(message)) return 'Runtime temporarily unavailable';
  if (/command exited/.test(message)) return 'Command exited nonzero or exceeded limits';
  return 'Wake source failed; check local service diagnostics';
}
export function wakeTokenValid(actual: string | undefined, supplied: string | undefined): boolean {
  if (!actual || !supplied) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface WakeNative {
  inspect(threadId: string): Promise<{ activeTurnId?: string; messages: string[] }>;
  steer(threadId: string, turnId: string, message: string): Promise<string>;
  start(threadId: string, message: string): Promise<string>;
}

/** One owner per application process; all transitions use an atomic, mode-0600 replace. */
export class WakeSources {
  private state: State = structuredClone(EMPTY);
  private chain = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = new Set<string>();
  private commands = new Map<string, ReturnType<typeof spawn>>();
  private commandTasks = new Set<Promise<void>>();
  private ticking = false;
  private stopping = false;
  private tickFinished?: Promise<void>;
  private finishTick?: () => void;
  private readonly file: string;
  private readonly lock: string;
  private readonly owner = randomUUID();

  constructor(private readonly native: WakeNative, root = getInterpreterAppDataDir()) {
    this.file = path.join(root, 'wake-sources.json');
    this.lock = `${this.file}.owner`;
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await this.claimOwner();
    try {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as State;
      if (!Array.isArray(raw.sources) || !Array.isArray(raw.events)) throw new Error('Invalid wake source state');
      this.state = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A native receipt is permanent for deduplication, but the original
    // message body is not needed once admitted. Migrate older state as well.
    for (const event of this.state.events) {
      if (event.status === 'admitted') {
        event.message = '';
        delete event.error;
        delete event.offeredAt;
        delete event.nextAttemptAt;
      }
    }
    // Never launch a second command when it has an unadmitted output event.
    for (const source of this.state.sources) {
      if (source.status === 'running') {
        source.status = 'waiting';
        source.nextAt = new Date(Date.now() + COMMAND_REARM_MS).toISOString();
      }
      // Older command sources stopped permanently on a transient World or
      // scanner error. Keep the diagnostic visible, but recover on a bounded
      // timer after a restart without creating a second consumer.
      if (source.kind === 'command' && source.status === 'error' && !source.nextAt) {
        source.nextAt = new Date(Date.now() + 300_000).toISOString();
      }
      if (source.kind === 'schedule' && source.status === 'waiting') {
        // Reconcile state written by an older, two-write schedule transition.
        // A persisted event is authoritative even when its sequence did not
        // make it into the source record before a crash.
        const latest = this.state.events.filter(e => e.threadId === source.threadId &&
          e.sourceId === source.id && e.eventId.startsWith(`${source.id}-`))
          .map(e => ({ event: e, sequence: Number(e.eventId.slice(source.id.length + 1)) }))
          .filter(e => Number.isSafeInteger(e.sequence) && e.sequence > source.sequence)
          .sort((a, b) => b.sequence - a.sequence)[0];
        if (latest) {
          source.sequence = latest.sequence;
          if (latest.event.status !== 'admitted') source.nextAt = undefined;
          else if (source.dailyAt && source.timeZone) source.nextAt = nextCivilDaily(Date.now(), source.timeZone, source.dailyAt);
          else if (source.everyMs) source.nextAt = new Date(Date.now() + source.everyMs).toISOString();
          else { source.status = 'delivered'; source.nextAt = undefined; }
        }
      }
    }
    await this.save();
    this.timer = setInterval(() => { void this.tick().catch(console.error); }, 2000);
    this.timer.unref?.();
    } catch (error) { await this.stop(); throw error; }
  }

  private async claimOwner(): Promise<void> {
    try {
      await mkdir(this.lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A stopped application may leave a stale PID. A recovery lock keeps
      // simultaneous starters from deleting one another's ownership record.
      const recovery = `${this.lock}.recovery`;
      await mkdir(recovery, { mode: 0o700 });
      try {
        const prior = JSON.parse(await readFile(path.join(this.lock, 'owner.json'), 'utf8')) as { pid: number; owner: string };
        if (!Number.isInteger(prior.pid) || typeof prior.owner !== 'string') throw new Error('Invalid wake owner');
        try { process.kill(prior.pid, 0); throw new Error('Another Workstation owns wake dispatch'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
        await rm(this.lock, { recursive: true });
        await mkdir(this.lock, { mode: 0o700 });
      } finally { await rm(recovery, { recursive: true, force: true }); }
    }
    const handle = await open(path.join(this.lock, 'owner.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, owner: this.owner })); await handle.sync(); }
    finally { await handle.close(); }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const child of this.commands.values()) child.kill('SIGKILL');
    await Promise.allSettled([...this.commandTasks]);
    // Do not release the single-owner lock while an admission RPC or durable
    // transition is still in flight. A successor must never race this owner.
    await this.tickFinished;
    await this.chain;
    try {
      const current = JSON.parse(await readFile(path.join(this.lock, 'owner.json'), 'utf8')) as { owner: string };
      if (current.owner === this.owner) await rm(this.lock, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  list(threadId: string): { sources: WakeSource[]; events: WakeEvent[] } {
    return structuredClone({
      sources: this.state.sources.filter(s => s.threadId === threadId),
      events: this.state.events.filter(e => e.threadId === threadId),
    });
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(this.state)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, this.file);
    const directory = await open(path.dirname(this.file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  async put(source: Omit<WakeSource, 'status' | 'sequence' | 'nextAt' | 'error'>): Promise<WakeSource> {
    if (this.stopping) throw new Error('Wake admission is draining for restart');
    if (!ID.test(source.threadId) || !ID.test(source.id)) throw new Error('Invalid thread or source ID');
    if (source.kind !== 'schedule' && source.kind !== 'command') throw new Error('Unknown wake source kind');
    if (Object.keys(source).some(key => !['id', 'threadId', 'kind', 'message', 'at', 'everyMs', 'dailyAt', 'timeZone', 'argv'].includes(key))) {
      throw new Error('Unknown wake source field');
    }
    const civil = source.kind === 'schedule' && (source.dailyAt !== undefined || source.timeZone !== undefined);
    if (source.kind === 'schedule') {
      if (source.id.length > MAX_SCHEDULE_ID) throw new Error('Schedule ID is too long');
      if (!source.message?.trim() || source.message.length > MAX_MESSAGE ||
          (civil && (typeof source.dailyAt !== 'string' || typeof source.timeZone !== 'string' ||
            source.at !== undefined || source.everyMs !== undefined)) ||
          (!civil && (!source.at || !Number.isFinite(Date.parse(source.at)))) ||
          (source.everyMs !== undefined && (!Number.isInteger(source.everyMs) || source.everyMs < MIN_INTERVAL))) {
        throw new Error('Schedule needs a message and a valid one-time, interval, or civil daily time');
      }
      if (civil) nextCivilDaily(Date.now(), source.timeZone!, source.dailyAt!);
    } else if (source.dailyAt !== undefined || source.timeZone !== undefined || source.at !== undefined ||
      source.everyMs !== undefined || source.message !== undefined ||
      !Array.isArray(source.argv) || !source.argv.length || source.argv.length > 32 ||
      source.argv.some(arg => typeof arg !== 'string' || !arg || arg.length > 4096) ||
      !path.isAbsolute(source.argv[0])) {
      throw new Error('Command requires an absolute executable and bounded arguments');
    }
    return this.exclusive(async () => {
      const old = this.state.sources.find(s => s.id === source.id && s.threadId === source.threadId);
      if (old?.status === 'running') throw new Error('Wait for the running command before changing it');
      if (old && this.state.events.some(e => e.sourceId === old.id && e.threadId === old.threadId && e.status !== 'admitted')) {
        throw new Error('Cannot change a source while its input awaits native admission');
      }
      if (old) this.state.sources.splice(this.state.sources.indexOf(old), 1);
      if (!old && this.state.sources.filter(s => s.threadId === source.threadId && s.status !== 'cancelled').length >= 32) {
        throw new Error('Thread wake source limit reached');
      }
      const result: WakeSource = { ...source, sequence: old?.sequence ?? 0, status: 'waiting',
        nextAt: civil && source.kind === 'schedule'
          ? nextCivilDaily(Date.now(), source.timeZone!, source.dailyAt!)
          : source.at ?? new Date().toISOString() };
      this.state.sources.push(result);
      await this.save();
      return structuredClone(result);
    });
  }

  async cancel(threadId: string, id: string): Promise<void> {
    if (this.stopping) throw new Error('Wake admission is draining for restart');
    await this.exclusive(async () => {
      const source = this.state.sources.find(s => s.threadId === threadId && s.id === id);
      if (!source) throw new Error('Source not found');
      source.status = 'cancelled';
      this.commands.get(`${threadId}:${id}`)?.kill('SIGKILL');
      // Offered input may already be in the native turn; never retract or replay it.
      this.state.events = this.state.events.filter(e => e.sourceId !== id || e.threadId !== threadId || e.status !== 'pending');
      await this.save();
    });
  }

  async ingest(threadId: string, sourceId: string, eventId: string, message: string): Promise<WakeEvent> {
    if (this.stopping) throw new Error('Wake admission is draining for restart');
    if (![threadId, sourceId, eventId].every(x => ID.test(x)) || !message.trim() || message.length > MAX_MESSAGE) {
      throw new Error('Invalid wake event');
    }
    return this.exclusive(async () => {
      const existing = this.state.events.find(e => e.threadId === threadId && e.sourceId === sourceId && e.eventId === eventId);
      if (existing) return structuredClone(existing);
      // Keep stable IDs as compact admission receipts indefinitely. Bound only
      // inputs still awaiting admission, so a long-running thread cannot hit
      // a permanent lifetime event ceiling.
      if (this.state.events.filter(e => e.threadId === threadId && e.status !== 'admitted').length >= 10_000) {
        throw new Error('Thread pending wake event limit reached; operator action required');
      }
      const event: WakeEvent = { threadId, sourceId, eventId, message, status: 'pending', createdAt: new Date().toISOString() };
      this.state.events.push(event);
      await this.save();
      return structuredClone(event);
    });
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    this.tickFinished = new Promise<void>(resolve => { this.finishTick = resolve; });
    try {
    for (const source of this.state.sources) {
      if (this.stopping) break;
      if (!(source.status === 'waiting' || (source.kind === 'command' && source.status === 'error')) ||
          !source.nextAt || Date.parse(source.nextAt) > now ||
          this.state.events.some(e => e.threadId === source.threadId && e.sourceId === source.id && e.status !== 'admitted')) continue;
      if (source.kind === 'schedule') {
        await this.exclusive(async () => {
          // Commit event custody and its sequence in the same atomic replace.
          if (source.status !== 'waiting' || !source.nextAt || Date.parse(source.nextAt) > now) return;
          if (!Number.isSafeInteger(source.sequence + 1)) throw new Error('Schedule sequence limit reached');
          const sequence = source.sequence + 1;
          const eventId = `${source.id}-${sequence}`;
          if (!ID.test(eventId)) {
            source.status = 'error'; source.error = 'Schedule ID is too long';
            await this.save(); return;
          }
          const existing = this.state.events.find(e => e.threadId === source.threadId &&
            e.sourceId === source.id && e.eventId === eventId);
          if (!existing) {
            if (this.state.events.filter(e => e.threadId === source.threadId && e.status !== 'admitted').length >= 10_000) {
              source.status = 'error'; source.error = 'Thread pending wake event limit reached';
              await this.save(); return;
            }
            this.state.events.push({ threadId: source.threadId, sourceId: source.id, eventId,
              message: source.message!, status: 'pending', createdAt: new Date(now).toISOString() });
          }
          source.sequence = sequence;
          source.nextAt = existing?.status === 'admitted'
            ? source.dailyAt && source.timeZone ? nextCivilDaily(now, source.timeZone, source.dailyAt)
              : source.everyMs ? new Date(now + source.everyMs).toISOString() : undefined
            : undefined;
          if (existing?.status === 'admitted' && !source.everyMs && !source.dailyAt) source.status = 'delivered';
          await this.save();
        });
      } else if (!this.inFlight.has(`${source.threadId}:${source.id}`)) {
        const task = this.runCommand(source);
        this.commandTasks.add(task);
        void task.finally(() => this.commandTasks.delete(task));
      }
    }
    // An ambiguous RPC result is never automatically resubmitted while its
    // original turn is still running. The marker in native history is the receipt.
    const seenThreads = new Set<string>();
    for (const event of this.state.events.filter(e => e.status !== 'admitted')) {
      if (this.stopping) break;
      // Preserve durable per-thread input order. An ambiguous offered event or
      // a backoff must fence later inputs on that thread, not let them overtake
      // the missing native receipt. Other threads can continue independently.
      if (seenThreads.has(event.threadId)) continue;
      seenThreads.add(event.threadId);
      if (this.inFlight.has(`${event.threadId}:${event.eventId}`)) continue;
      this.inFlight.add(`${event.threadId}:${event.eventId}`);
      try { await this.deliver(event, now); }
      finally { this.inFlight.delete(`${event.threadId}:${event.eventId}`); }
    }
    } finally {
      this.ticking = false;
      this.finishTick?.();
      this.finishTick = undefined;
      this.tickFinished = undefined;
    }
  }

  private async deliver(event: WakeEvent, now: number): Promise<void> {
    if (event.nextAttemptAt && Date.parse(event.nextAttemptAt) > now) return;
    try {
      const source = this.state.sources.find(s => s.id === event.sourceId && s.threadId === event.threadId);
      if (source?.status === 'cancelled' && event.status === 'pending') return;
      const state = await this.native.inspect(event.threadId);
      if (state.messages.some(message => message === wakeInput(event) || message.startsWith(`${wakeInput(event)}\n`))) {
        await this.exclusive(async () => {
          event.status = 'admitted';
          event.message = '';
          delete event.error;
          delete event.offeredAt;
          delete event.nextAttemptAt;
          const source = this.state.sources.find(s => s.id === event.sourceId && s.threadId === event.threadId);
          if (source && source.status !== 'cancelled') {
            delete source.error;
            source.status = 'delivered';
            if (source.kind === 'schedule' && source.dailyAt && source.timeZone) {
              source.nextAt = nextCivilDaily(now, source.timeZone, source.dailyAt);
              source.status = 'waiting';
            } else if (source.kind === 'schedule' && source.everyMs) {
              source.nextAt = new Date(now + source.everyMs).toISOString();
              source.status = 'waiting';
            } else if (source.kind === 'command') {
              source.nextAt = new Date(now + COMMAND_REARM_MS).toISOString();
              source.status = 'waiting';
            }
          }
          await this.save();
        });
        return;
      }
      // An offered RPC is ambiguous even after a process crash: elapsed time
      // alone cannot prove the native service rejected it. Never submit it a
      // second time without an explicit native receipt or operator action.
      if (event.status === 'offered') return;
      if (source?.status === 'cancelled' && event.status === 'pending') return;
      // Mark intent before the RPC: a crash between RPC and response must be
      // reconciled against native history, rather than immediately retried.
      await this.exclusive(async () => { event.status = 'offered'; event.offeredAt = new Date(now).toISOString(); await this.save(); });
      const turnId = state.activeTurnId
        ? await this.native.steer(event.threadId, state.activeTurnId, wakeInput(event))
        : await this.native.start(event.threadId, wakeInput(event));
      await this.exclusive(async () => { event.turnId = turnId; await this.save(); });
    } catch (error) {
      const explanation = safeError(error);
      // The native steer endpoint explicitly rejected this input before
      // admission: the inspected turn ended between inspect and steer. Unlike
      // a timeout/disconnect, this is not an ambiguous accepted RPC; retry by
      // inspecting the SAME thread, which can now be idle.
      if (event.status === 'offered' && error instanceof Error && error.message === 'no active turn to steer') {
        event.status = 'pending';
        delete event.offeredAt;
      }
      const source = this.state.sources.find(s => s.id === event.sourceId && s.threadId === event.threadId);
      if (source && source.status !== 'cancelled') {
        source.status = 'error';
        source.error = explanation;
      }
      event.error = explanation;
      event.nextAttemptAt = new Date(now + (/operator action/.test(explanation) ? 300_000 : 60_000)).toISOString();
      await this.exclusive(async () => { await this.save(); });
      // Do not hammer auth, allowance, or transport errors. Explicit intervention
      // or restart can reconcile the retained event.
    }
  }

  private async runCommand(source: WakeSource): Promise<void> {
    const key = `${source.threadId}:${source.id}`;
    this.inFlight.add(key);
    try {
      await this.exclusive(async () => { source.status = 'running'; await this.save(); });
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(source.argv![0], source.argv!.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
        this.commands.set(key, child);
        const chunks: Buffer[] = [];
        let size = 0;
        const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_STDOUT) child.kill('SIGKILL');
          else chunks.push(chunk);
        });
        child.on('error', reject);
        child.on('close', code => { this.commands.delete(key); clearTimeout(timeout); code === 0 && size <= MAX_STDOUT ? resolve(Buffer.concat(chunks, size).toString('utf8')) : reject(new Error(`Command exited ${code ?? 'after timeout or output limit'}`)); });
      });
      if (source.status === 'cancelled') return;
      const output = JSON.parse(stdout) as { id?: string; message?: string; status?: string };
      if (output.status === 'waiting') {
        await this.exclusive(async () => {
          if (source.status !== 'cancelled') {
            source.status = 'waiting';
            delete source.error;
            source.nextAt = new Date(Date.now() + COMMAND_REARM_MS).toISOString();
          }
          await this.save();
        });
        return;
      }
      if (!output.id || !output.message) throw new Error('Command must output JSON with stable id and message');
      await this.ingest(source.threadId, source.id, output.id, output.message);
      await this.exclusive(async () => {
        if (source.status !== 'cancelled') { source.status = 'waiting'; delete source.error; source.nextAt = undefined; }
        await this.save();
      });
    } catch (error) {
      await this.exclusive(async () => {
        if (source.status === 'cancelled') return;
        source.status = 'error';
        source.error = safeError(error);
        source.nextAt = new Date(Date.now() + (/operator action/.test(source.error) ? 300_000 : 60_000)).toISOString();
        await this.save();
      });
    } finally { this.commands.delete(key); this.inFlight.delete(key); }
  }
}
