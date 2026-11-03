import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { getInterpreterAppDataDir } from '../configStore';

export const SUBMISSION_ID = /^[A-Za-z0-9_-]{1,160}$/;
export type SubmissionPhase = 'received' | 'turn_started' | 'terminal_success' |
  'terminal_failure' | 'terminal_no_turn';
export const submissionTerminalPhase = (completed: boolean, observedTurn: boolean):
  'terminal_success' | 'terminal_failure' | 'terminal_no_turn' =>
  !observedTurn ? 'terminal_no_turn' : completed ? 'terminal_success' : 'terminal_failure';
type Entry = { requestId: string; threadId: string; clientUserMessageId: string;
  phase: SubmissionPhase; turnId: string | null; at: string };

/** Append-only, content-free, forward-only receipts. An unacknowledged request
 * remains inspectable after a process restart, never automatically resubmitted. */
export class NativeSubmissionJournal {
  private readonly file: string;
  private serial = Promise.resolve();
  constructor(root = getInterpreterAppDataDir()) {
    this.file = path.join(root, 'native-submission-receipts.jsonl');
  }

  private async entries(): Promise<Entry[]> {
    let raw: string;
    try {
      const file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 4_194_304 || (stat.mode & 0o077) !== 0) {
          throw new Error('Submission journal inspection bound exceeded');
        }
        raw = await file.readFile('utf8');
      } finally { await file.close(); }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(raw) > 4_194_304) throw new Error('Submission journal inspection bound exceeded');
    const lines = raw.trimEnd() ? raw.trimEnd().split('\n') : [];
    if (lines.length > 20_000) throw new Error('Submission journal inspection bound exceeded');
    return lines.map(line => {
      const entry = JSON.parse(line) as Entry;
      if (!SUBMISSION_ID.test(entry.requestId) || !SUBMISSION_ID.test(entry.clientUserMessageId) ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.threadId) ||
          !['received', 'turn_started', 'terminal_success', 'terminal_failure', 'terminal_no_turn'].includes(entry.phase) ||
          (entry.turnId !== null && !SUBMISSION_ID.test(entry.turnId))) {
        throw new Error('Invalid submission journal');
      }
      return entry;
    });
  }

  private async append(entry: Entry): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const file = await open(this.file,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Invalid submission journal permissions');
      await file.writeFile(`${JSON.stringify(entry)}\n`);
      await file.sync();
    } finally { await file.close(); }
  }

  private synchronized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  begin(threadId: string, clientUserMessageId = `task_${randomUUID().replace(/-/g, '')}`) {
    return this.synchronized(async () => {
      if (!SUBMISSION_ID.test(clientUserMessageId)) throw new Error('Invalid native client ID');
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId)) {
        throw new Error('Exact saved native thread required');
      }
      const existing = (await this.entries()).find(entry => entry.threadId === threadId &&
        entry.clientUserMessageId === clientUserMessageId);
      if (existing) return null; // No duplicate admission on retry or restart.
      const entry: Entry = { requestId: randomUUID(), threadId, clientUserMessageId,
        phase: 'received', turnId: null, at: new Date().toISOString() };
      await this.append(entry);
      return entry;
    });
  }

  advance(entry: Entry, phase: Exclude<SubmissionPhase, 'received'>, turnId: string | null) {
    return this.synchronized(async () => {
      if (turnId !== null && !SUBMISSION_ID.test(turnId)) throw new Error('Invalid native turn ID');
      await this.append({ ...entry, phase, turnId, at: new Date().toISOString() });
    });
  }

  lookup(threadId: string, clientUserMessageId: string) {
    return this.synchronized(async () => {
      const entries = (await this.entries()).filter(entry => entry.threadId === threadId &&
        entry.clientUserMessageId === clientUserMessageId);
      return entries[entries.length - 1] ?? null;
    });
  }
}

export const nativeSubmissionJournal = new NativeSubmissionJournal();
