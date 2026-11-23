import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { NativeSubmissionJournal, parseSubmissionSender, senderHeader, submissionTerminalPhase }
  from './nativeSubmissionJournal';

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
      await expect(journal.advance(received!, 'turn_started', 'turn_1')).rejects.toThrow('transition');
      await expect(journal.advance(received!, 'terminal_success', 'turn_other')).rejects.toThrow('transition');
      await journal.advance(received!, 'terminal_failure', 'turn_1');
      await expect(journal.advance(received!, 'terminal_success', 'turn_1')).rejects.toThrow('transition');
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
  test('records an optional sender on the claim and keeps sender-less receipts readable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-receipt-sender-'));
    try {
      const journal = new NativeSubmissionJournal(root);
      const sender = { computer: 'peer-host', thread: 'origin_1' };
      const claimed = await journal.begin(thread, 'handoff_1', sender);
      expect(claimed).toMatchObject({ phase: 'received', sender });
      await journal.advance(claimed!, 'turn_started', 'turn_1');
      expect(await new NativeSubmissionJournal(root).lookup(thread, 'handoff_1'))
        .toMatchObject({ phase: 'turn_started', turnId: 'turn_1', sender });
      const plain = await journal.begin(thread, 'plain_1');
      expect(plain).not.toHaveProperty('sender');
      expect(await journal.lookup(thread, 'plain_1')).not.toHaveProperty('sender');
      await expect(journal.begin(thread, 'bad_1', { computer: 'Bad Host' })).rejects.toThrow('sender');
      expect(await journal.lookup(thread, 'bad_1')).toBeNull();
      expect(senderHeader(sender)).toBe('[Sender: peer-host thread origin_1]');
      expect(senderHeader({ computer: 'peer-host' })).toBe('[Sender: peer-host]');
      expect(parseSubmissionSender({ computer: 'peer-host', thread: 'origin_1', more: 1 })).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('records a sub-agent refusal as its own terminal phase and keeps older receipts readable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-receipt-refused-'));
    const parent = '00000000-0000-4000-8000-000000000002';
    try {
      const journal = new NativeSubmissionJournal(root);
      const claimed = await journal.begin(thread, 'refused_1', { computer: 'peer-host' });
      await expect(journal.advance(claimed!, 'terminal_refused', null)).rejects.toThrow('refusal');
      await expect(journal.advance(claimed!, 'terminal_no_turn', null,
        { reason: 'subagent_direct_input_unsupported' })).rejects.toThrow('refusal');
      await expect(journal.advance(claimed!, 'terminal_refused', 'turn_1',
        { reason: 'subagent_direct_input_unsupported' })).rejects.toThrow('transition');
      await journal.advance(claimed!, 'terminal_refused', null,
        { reason: 'subagent_direct_input_unsupported', parentThreadId: parent });
      expect(await new NativeSubmissionJournal(root).lookup(thread, 'refused_1')).toMatchObject({
        phase: 'terminal_refused', turnId: null, reason: 'subagent_direct_input_unsupported',
        parentThreadId: parent, sender: { computer: 'peer-host' },
      });
      await expect(journal.advance(claimed!, 'terminal_no_turn', null)).rejects.toThrow('transition');
      const unknownParent = await journal.begin(thread, 'refused_2');
      await journal.advance(unknownParent!, 'terminal_refused', null,
        { reason: 'subagent_direct_input_unsupported', parentThreadId: null });
      expect(await journal.lookup(thread, 'refused_2')).not.toHaveProperty('parentThreadId');

      // A receipt written before the refusal phase existed still parses unchanged.
      const older = await journal.begin(thread, 'older_1');
      await journal.advance(older!, 'terminal_no_turn', null);
      const files = await readdir(path.join(root, 'native-submission-receipts'));
      for (const file of files) {
        const text = await readFile(path.join(root, 'native-submission-receipts', file), 'utf8');
        if (!text.includes('older_1')) continue;
        expect(text).not.toContain('reason');
        expect(text).not.toContain('parentThreadId');
      }
      expect(await journal.lookup(thread, 'older_1')).toMatchObject({ phase: 'terminal_no_turn', turnId: null });
      expect(await journal.lookup(thread, 'older_1')).not.toHaveProperty('reason');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('rejects a refusal reason on any other phase or an unknown reason', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-receipt-refused-'));
    try {
      const journal = new NativeSubmissionJournal(root);
      await journal.begin(thread, 'forged_1');
      const [filename] = await readdir(path.join(root, 'native-submission-receipts'));
      const claim = path.join(root, 'native-submission-receipts', filename);
      const received = JSON.parse((await readFile(claim, 'utf8')).trim());
      await writeFile(claim, `${JSON.stringify({ ...received, phase: 'terminal_refused', reason: 'other' })}\n`,
        { flag: 'a' });
      await expect(journal.lookup(thread, 'forged_1')).rejects.toThrow('Invalid submission receipt');
      await journal.begin(thread, 'forged_2');
      const second = (await readdir(path.join(root, 'native-submission-receipts'))).find(name => name !== filename)!;
      const secondClaim = path.join(root, 'native-submission-receipts', second);
      const secondReceived = JSON.parse((await readFile(secondClaim, 'utf8')).trim());
      await writeFile(secondClaim, `${JSON.stringify({ ...secondReceived, phase: 'terminal_no_turn',
        reason: 'subagent_direct_input_unsupported' })}\n`, { flag: 'a' });
      await expect(journal.lookup(thread, 'forged_2')).rejects.toThrow('Invalid submission receipt');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('does not turn an invalid persisted row into verified custody or admit a duplicate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-receipt-'));
    try {
      const journal = new NativeSubmissionJournal(root);
      await journal.begin(thread, 'owned_2');
      await expect(journal.begin(thread, 'owned_2')).resolves.toBeNull();
      await expect(journal.begin('wrong', 'owned_3')).rejects.toThrow();
      const [filename] = await readdir(path.join(root, 'native-submission-receipts'));
      const claim = path.join(root, 'native-submission-receipts', filename);
      const received = JSON.parse((await readFile(claim, 'utf8')).trim());
      await writeFile(claim, `${JSON.stringify({ ...received, phase: 'terminal_success', turnId: 'turn_1' })}\n` +
        `${JSON.stringify({ ...received, phase: 'terminal_failure', turnId: 'turn_1' })}\n`, { flag: 'a' });
      await expect(journal.lookup(thread, 'owned_2')).rejects.toThrow('transition');
      await expect(journal.begin(thread, 'owned_2')).resolves.toBeNull();
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
