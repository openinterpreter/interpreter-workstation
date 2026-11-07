import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CodexService, type CodexClient } from './service';
import { ManagedGoalDocumentError, validateGoalDocumentInput, verifyGoalDocument } from './goal-document';

const threadId = '00000000-0000-4000-8000-000000000077';
const documentText = `# Mission\n${'bounded task detail\n'.repeat(300)}`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const metadata = (text = documentText, missionRevision = 1) => ({
  path: `managed-goals/${threadId}/mission-${missionRevision}-${sha256(text)}.md`,
  sha256: sha256(text), byteLength: Buffer.byteLength(text), missionRevision,
});
const goal = { threadId, objective: 'Read managed mission document', status: 'active' as const,
  tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };

describe('Workstation consumer for OIX-owned managed Goal documents', () => {
  test('accepts a >4,000-character mission and verifies the native write receipt', async () => {
    assert.ok(documentText.length > 4_000);
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalDocumentSet: async (input: unknown) => {
      calls += 1;
      assert.deepEqual(input, { threadId, document: documentText, status: 'active' });
      return { goal, document: metadata() };
    } } as unknown as CodexClient;
    const result = await new CodexService(client).setThreadGoalDocument({ threadId,
      document: documentText, status: 'active' });
    assert.equal(result.document.missionRevision, 1);
    assert.equal(calls, 1);
  });

  test('passes the existing-file mission revision CAS and validates readback bytes', async () => {
    const edited = `${documentText}\n# An edit retained across continuation`;
    let revision: number | null | undefined;
    const client = { subscribe: () => () => {},
      threadGoalDocumentSet: async (input: { expectedMissionRevision?: number | null }) => {
        revision = input.expectedMissionRevision;
        return { goal, document: metadata(edited, 2) };
      },
      threadGoalDocumentGet: async () => ({ goal, document: metadata(edited, 2), content: edited }),
    } as unknown as CodexClient;
    const service = new CodexService(client);
    assert.equal((await service.setThreadGoalDocument({ threadId, document: edited,
      expectedMissionRevision: 1 })).document.missionRevision, 2);
    assert.equal(revision, 1);
    assert.equal((await service.getThreadGoalDocument(threadId)).content, edited);
  });

  test('denies invalid input before native mutation and unsupported native capability', async () => {
    let calls = 0;
    const service = new CodexService({ subscribe: () => () => {},
      threadGoalDocumentSet: async () => { calls++; throw new Error('should not be called'); },
    } as unknown as CodexClient);
    for (const input of [
      { threadId: 'wrong', document: documentText },
      { threadId, document: ' ' },
      { threadId, document: 'x'.repeat(1_048_577) },
      { threadId, document: documentText, expectedMissionRevision: 0 },
    ]) {
      await assert.rejects(service.setThreadGoalDocument(input));
    }
    assert.equal(calls, 0);
    assert.throws(() => validateGoalDocumentInput({ threadId, document: documentText,
      expectedMissionRevision: Number.MAX_SAFE_INTEGER + 1 }));
    await assert.rejects(new CodexService({ subscribe: () => () => {} } as unknown as CodexClient)
      .getThreadGoalDocument(threadId), { category: 'read_unavailable' });
  });

  test('denies forged path, cross-thread owner, digest, bytes and missing content', async () => {
    for (const forged of [
      { ...metadata(), path: `managed-goals/${threadId}/../secrets.md` },
      { ...metadata(), path: metadata().path.replace(threadId, '00000000-0000-4000-8000-000000000078') },
      { ...metadata(), sha256: 'f'.repeat(64) },
      { ...metadata(), byteLength: metadata().byteLength + 1 },
      { ...metadata(), missionRevision: 2 },
    ]) assert.throws(() => verifyGoalDocument(threadId, forged, documentText));
    assert.throws(() => verifyGoalDocument(threadId, metadata(), null));
    const client = { subscribe: () => () => {}, threadGoalDocumentGet: async () => ({
      goal: { ...goal, threadId: '00000000-0000-4000-8000-000000000078' },
      document: metadata(), content: documentText,
    }) } as unknown as CodexClient;
    await assert.rejects(new CodexService(client).getThreadGoalDocument(threadId),
      { category: 'read_unavailable' });
    client.threadGoalDocumentGet = async () => ({ goal, document: null, content: null });
    await assert.rejects(new CodexService(client).getThreadGoalDocument(threadId),
      { category: 'read_unavailable' });
    client.threadGoalDocumentGet = async () => ({ goal: null, document: null, content: null });
    assert.deepEqual(await new CodexService(client).getThreadGoalDocument(threadId),
      { goal: null, document: null, content: null });
  });

  test('failed native revision update cannot be represented as a successful or emptied mission', async () => {
    let reads = 0;
    const client = { subscribe: () => () => {},
      threadGoalDocumentGet: async () => { reads++; return { goal,
        document: metadata(), content: documentText }; },
      threadGoalDocumentSet: async () => { throw new Error('revision conflict'); },
    } as unknown as CodexClient;
    const service = new CodexService(client);
    assert.equal((await service.getThreadGoalDocument(threadId)).content, documentText);
    await assert.rejects(service.setThreadGoalDocument({ threadId,
      document: `${documentText}\nnew section`, expectedMissionRevision: 1 }),
    (error: unknown) => error instanceof ManagedGoalDocumentError &&
      error.category === 'update_unconfirmed' && !error.message.includes('revision conflict'));
    assert.equal((await service.getThreadGoalDocument(threadId)).content, documentText);
    assert.equal(reads, 2);
  });

  test('lost write response never converts an ambiguous native mutation into a retry', async () => {
    const edited = `${documentText}\nActually stored before transport failure`;
    let current = documentText;
    let writes = 0;
    const client = { subscribe: () => () => {},
      threadGoalDocumentGet: async () => ({ goal, document: metadata(current, current === edited ? 2 : 1),
        content: current }),
      threadGoalDocumentSet: async () => { writes++; current = edited;
        throw new Error('PRIVATE native transport failure'); },
    } as unknown as CodexClient;
    const service = new CodexService(client);
    await assert.rejects(service.setThreadGoalDocument({ threadId, document: edited,
      expectedMissionRevision: 1 }), { category: 'update_unconfirmed' });
    const readback = await service.getThreadGoalDocument(threadId);
    assert.equal(readback.document?.missionRevision, 2);
    assert.equal(readback.content, edited);
    assert.equal(writes, 1);
  });

  test('denies a contradictory revision or requested status in an acknowledged write receipt', async () => {
    let writes = 0;
    const client = { subscribe: () => () => {}, threadGoalDocumentSet: async () => {
      writes++;
      return { goal, document: metadata(documentText, 9) };
    } } as unknown as CodexClient;
    const service = new CodexService(client);
    await assert.rejects(service.setThreadGoalDocument({ threadId, document: documentText,
      expectedMissionRevision: 1 }), { category: 'update_unconfirmed' });
    client.threadGoalDocumentSet = async () => {
      writes++;
      return { goal: { ...goal, status: 'active' }, document: metadata(documentText, 2) };
    };
    await assert.rejects(service.setThreadGoalDocument({ threadId, document: documentText,
      expectedMissionRevision: 1, status: 'paused' }), { category: 'update_unconfirmed' });
    assert.equal(writes, 2);
  });
});
