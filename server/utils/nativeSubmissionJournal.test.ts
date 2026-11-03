import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { NativeSubmissionJournal, submissionTerminalPhase } from './nativeSubmissionJournal';

const thread = '00000000-0000-4000-8000-000000000001';
describe('forward native submission journal', () => {
  test('a successful wrapper without a native turn is never an admitted terminal success', () => {
    expect(submissionTerminalPhase(true, false)).toBe('terminal_no_turn');
    expect(submissionTerminalPhase(false, false)).toBe('terminal_no_turn');
    expect(submissionTerminalPhase(false, true)).toBe('terminal_failure');
    expect(submissionTerminalPhase(true, true)).toBe('terminal_success');
  });
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
      const files = await readdir(path.join(root, 'native-submission-receipts'));
      expect(files).toHaveLength(1);
      const bytes = await readFile(path.join(root, 'native-submission-receipts', files[0]), 'utf8');
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
  test('exclusive claim survives two competing processes and one abnormal receipt does not exhaust other IDs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-receipt-process-'));
    try {
      const module = path.join(import.meta.dir, 'nativeSubmissionJournal.ts');
      const script = `import { NativeSubmissionJournal } from ${JSON.stringify(module)};\n` +
        `const result = await new NativeSubmissionJournal(process.argv[1]).begin(${JSON.stringify(thread)}, 'process_race');\n` +
        `process.stdout.write(result ? 'won' : 'duplicate');`;
      const run = () => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script, root], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; let error = '';
        child.stdout.on('data', chunk => { output += String(chunk); });
        child.stderr.on('data', chunk => { error += String(chunk); });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error)));
      });
      expect((await Promise.all([run(), run()])).sort()).toEqual(['duplicate', 'won']);
      const journal = new NativeSubmissionJournal(root);
      const [filename] = await readdir(path.join(root, 'native-submission-receipts'));
      const claim = path.join(root, 'native-submission-receipts', filename);
      await writeFile(claim, 'x'.repeat(16_385), { flag: 'a' });
      await expect(journal.lookup(thread, 'process_race')).rejects.toThrow();
      expect(await journal.begin(thread, 'process_race')).toBeNull();
      expect((await journal.begin(thread, 'next_unique_input'))?.phase).toBe('received');
      expect((await journal.lookup(thread, 'next_unique_input'))?.phase).toBe('received');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
