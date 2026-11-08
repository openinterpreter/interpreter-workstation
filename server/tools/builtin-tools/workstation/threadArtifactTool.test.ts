import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ThreadArtifactReceipts } from '../../../utils/threadArtifactReceipts';
import { createThreadArtifactForCaller, readThreadArtifactForCaller } from './threadArtifactTool';

describe('normal native caller private artifact', () => {
  test('verified exact owner succeeds; other, delegated, stale, unbound denied without mutation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'thread-tool-'));
    try {
      const store = new ThreadArtifactReceipts(path.join(root, 'receipts'));
      const threadId = randomUUID();
      const context = { threadId, verifiedCallerThreadId: threadId, workspace: root };
      const content = 'full owned mission';
      const args = { content, receiptId: 'mission-r1', sha256: createHash('sha256').update(content).digest('hex') };
      const denied = [
        { ...context, verifiedCallerThreadId: randomUUID() },
        { ...context, isSubagent: true },
        { ...context, toolCallPath: ['delegated'] },
        { threadId, workspace: root },
      ];
      for (const scope of denied) {
        const result = await createThreadArtifactForCaller(args, scope, store);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('caller_unavailable');
      }
      const created = await createThreadArtifactForCaller(args, context, store);
      expect(created.isError).toBeUndefined();
      expect(JSON.parse(created.content[0].text)).toMatchObject({ created: true, receiptId: args.receiptId });
      const same = await createThreadArtifactForCaller(args, context, store);
      expect(JSON.parse(same.content[0].text)).toMatchObject({ created: false });
      const conflict = await createThreadArtifactForCaller({ ...args, content: 'different', sha256: createHash('sha256').update('different').digest('hex') }, context, store);
      expect(conflict.content[0].text).toContain('artifact_conflict');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('large UTF-8 mission readback survives a new store and denies other callers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'thread-tool-'));
    try {
      const receipts = path.join(root, 'receipts');
      const store = new ThreadArtifactReceipts(receipts);
      const threadId = randomUUID();
      const context = { threadId, verifiedCallerThreadId: threadId, workspace: root };
      const content = 'Mission revision — '+ 'long section\n'.repeat(500);
      const receiptId = 'mission-revision-2';
      const sha256 = createHash('sha256').update(content).digest('hex');
      expect((await createThreadArtifactForCaller({ receiptId, sha256, content }, context, store)).isError).toBeUndefined();
      const restarted = new ThreadArtifactReceipts(receipts);
      const read = await readThreadArtifactForCaller({ receiptId }, context, restarted);
      expect(JSON.parse(read.content[0].text)).toMatchObject({ available: true, content, sha256 });
      for (const denied of [{ ...context, verifiedCallerThreadId: randomUUID() },
        { ...context, isSubagent: true }, { ...context, toolCallPath: ['delegated'] }]) {
        const result = await readThreadArtifactForCaller({ receiptId }, denied, restarted);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).not.toContain(content);
      }
      expect((await readThreadArtifactForCaller({ receiptId: '../escape' }, context, restarted)).isError).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
