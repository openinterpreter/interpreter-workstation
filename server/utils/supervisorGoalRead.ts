import { verifyGoalDocument } from '../../src/lib/codex/goal-document';
import { verifyThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import { getCodexService } from '../../src/lib/codex/service';

type Reader = Pick<ReturnType<typeof getCodexService>,
  'getThreadGoalWithRevision' | 'getThreadGoalDocument'>;

/** Bind complete managed mission bytes to the same native Goal revision on
 * either side of the document read. A deadline does not cancel the native RPC. */
export async function readStableSupervisorGoal(reader: Reader, threadId: string,
  maxWaitMs = 3_000) {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 3_000) {
    throw Error('Goal read unavailable.');
  }
  const first = await reader.getThreadGoalWithRevision(threadId, maxWaitMs);
  verifyThreadGoalRevision(first.goal, first.revision, threadId);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let document: Awaited<ReturnType<Reader['getThreadGoalDocument']>>;
  try {
    document = await Promise.race([
      reader.getThreadGoalDocument(threadId),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(Error('Goal read unavailable.')), maxWaitMs);
      }),
    ]);
  } finally { if (deadline) clearTimeout(deadline); }
  const last = await reader.getThreadGoalWithRevision(threadId, maxWaitMs);
  verifyThreadGoalRevision(last.goal, last.revision, threadId);
  if (JSON.stringify(first) !== JSON.stringify(last) ||
      JSON.stringify(first.goal) !== JSON.stringify(document.goal) ||
      (first.goal === null) !== (document.document === null) ||
      (first.goal !== null && document.document?.missionRevision !== first.revision?.missionRevision)) {
    throw Error('Goal read unavailable.');
  }
  verifyGoalDocument(threadId, document.document, document.content);
  return { ...first, document: document.document ? {
    content: document.content!, sha256: document.document.sha256,
    byteLength: document.document.byteLength,
    missionRevision: document.document.missionRevision,
  } : null };
}
