import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeSubmissionJournal } from './nativeSubmissionJournal';

const thread = '00000000-0000-4000-8000-000000000001';
describe('forward native submission journal', () => {
  test('records before acknowledgement, survives restart, rejects concurrent and restarted duplicates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-receipt-'));
    try {
      const journal = new NativeSubmissionJournal(root);
      const [first, duplicate] = await Promise.all([
        journal.begin(thread, 'owner_input_1'), journal.begin(thread, 'owner_input_1'),
      ]);
      expect([first, duplicate].filter(Boolean)).toHaveLength(1);
      const received = first ?? duplicate!;
      expect((await new NativeSubmissionJournal(root).lookup(thread, 'owner_input_1'))?.phase).toBe('received');
      expect(await new NativeSubmissionJournal(root).begin(thread, 'owner_input_1')).toBeNull();
      await journal.advance(received!, 'turn_started', 'turn_1');
      await journal.advance(received!, 'terminal_failure', 'turn_1');
      expect((await new NativeSubmissionJournal(root).lookup(thread, 'owner_input_1'))).toMatchObject({
        phase: 'terminal_failure', turnId: 'turn_1', requestId: received!.requestId,
      });
      const bytes = await readFile(path.join(root, 'native-submission-receipts.jsonl'), 'utf8');
      expect(bytes).not.toMatch(/PRIVATE|message|output|token/);
      expect((await new NativeSubmissionJournal(root).lookup(thread, 'different_input'))).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('does not turn an invalid persisted row into verified custody or admit a duplicate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-receipt-'));
    try {
      const journal = new NativeSubmissionJournal(root);
      await journal.begin(thread, 'owned_2');
      await expect(journal.begin(thread, 'owned_2')).resolves.toBeNull();
      await expect(journal.begin('wrong', 'owned_3')).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
