import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ThreadArtifactReceipts } from '../../../utils/threadArtifactReceipts';
import { createThreadArtifactForCaller } from './threadArtifactTool';

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
});
