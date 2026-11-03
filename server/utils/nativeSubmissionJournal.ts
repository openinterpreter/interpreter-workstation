import { createHash, randomUUID } from 'node:crypto';
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
const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAX_RECEIPT_BYTES = 16_384;

/** An immutable, exclusive per-ID claim and bounded event tail. Two servers
 * cannot claim the same native ID; uncertain claims are never recycled.
 * Only disk exhaustion denies a new ID, before native admission. */
export class NativeSubmissionJournal {
  private readonly directory: string;
  constructor(root = getInterpreterAppDataDir()) {
    this.directory = path.join(root, 'native-submission-receipts');
  }

  private filename(threadId: string, clientUserMessageId: string): string {
    if (!THREAD_ID.test(threadId) || !SUBMISSION_ID.test(clientUserMessageId)) {
      throw new Error('Exact saved native thread and client ID required');
    }
    return path.join(this.directory, createHash('sha256').update(JSON.stringify([threadId, clientUserMessageId]))
      .digest('hex') + '.jsonl');
  }

  private async read(threadId: string, clientUserMessageId: string): Promise<Entry[] | null> {
    let file;
    try { file = await open(this.filename(threadId, clientUserMessageId), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_RECEIPT_BYTES) {
        throw new Error('Invalid submission receipt');
      }
      const raw = await file.readFile('utf8');
      const lines = raw.trimEnd() ? raw.trimEnd().split('\n') : [];
      if (!lines.length || lines.length > 16) throw new Error('Incomplete submission receipt');
      const entries = lines.map(line => JSON.parse(line) as Entry);
      for (const entry of entries) {
        if (entry.threadId !== threadId || entry.clientUserMessageId !== clientUserMessageId ||
            !SUBMISSION_ID.test(entry.requestId) ||
            !['received', 'turn_started', 'terminal_success', 'terminal_failure', 'terminal_no_turn'].includes(entry.phase) ||
            (entry.turnId !== null && !SUBMISSION_ID.test(entry.turnId))) {
          throw new Error('Invalid submission receipt');
        }
      }
      if (entries[0].phase !== 'received' || entries.some(entry => entry.requestId !== entries[0].requestId)) {
        throw new Error('Invalid submission receipt claim');
      }
      return entries;
    } finally { await file.close(); }
  }

  async begin(threadId: string, clientUserMessageId = `task_${randomUUID().replace(/-/g, '')}`) {
    const filename = this.filename(threadId, clientUserMessageId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(filename,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    }
    const entry: Entry = { requestId: randomUUID(), threadId, clientUserMessageId,
      phase: 'received', turnId: null, at: new Date().toISOString() };
    try {
      await file.writeFile(`${JSON.stringify(entry)}\n`);
      await file.sync();
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await file.close(); }
    return entry;
  }

  async advance(entry: Entry, phase: Exclude<SubmissionPhase, 'received'>, turnId: string | null) {
    if (turnId !== null && !SUBMISSION_ID.test(turnId)) throw new Error('Invalid native turn ID');
    const filename = this.filename(entry.threadId, entry.clientUserMessageId);
    const prior = await this.read(entry.threadId, entry.clientUserMessageId);
    if (!prior?.length || prior[0].requestId !== entry.requestId) throw new Error('Submission claim changed');
    const file = await open(filename, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_RECEIPT_BYTES - 1024) {
        throw new Error('Submission receipt bound exceeded');
      }
      await file.writeFile(`${JSON.stringify({ ...entry, phase, turnId, at: new Date().toISOString() })}\n`);
      await file.sync();
    } finally { await file.close(); }
  }

  async lookup(threadId: string, clientUserMessageId: string) {
    const entries = await this.read(threadId, clientUserMessageId);
    return entries ? entries[entries.length - 1] : null;
  }
}

export const nativeSubmissionJournal = new NativeSubmissionJournal();
