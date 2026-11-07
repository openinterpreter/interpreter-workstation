import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CodexService, type CodexClient } from './service';
import { validateGoalDocumentInput, verifyGoalDocument } from './goal-document';

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
      .getThreadGoalDocument(threadId), /unavailable/);
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
    await assert.rejects(new CodexService(client).getThreadGoalDocument(threadId), /unavailable/);
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
      document: `${documentText}\nnew section`, expectedMissionRevision: 1 }), /revision conflict/);
    assert.equal((await service.getThreadGoalDocument(threadId)).content, documentText);
    assert.equal(reads, 2);
  });
});
