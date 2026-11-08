import { createHash } from 'node:crypto';
import type { v2 } from '../../../server/handlers/codex-generated-types/index';
import type { ThreadGoalRevision } from './goal-revision';

/** The experimental OIX managed-document RPC owns the file; Workstation never writes it. */
export type ThreadGoalDocument = {
  path: string;
  sha256: string;
  byteLength: number;
  missionRevision: number;
};

export type ThreadGoalDocumentSetParams = {
  threadId: string;
  document: string;
  status?: v2.ThreadGoalStatus | null;
  expectedMissionRevision?: number | null;
  expectedGoalId?: string;
  expectedStatus?: v2.ThreadGoalStatus;
  expectedLifecycleRevision?: number;
};

export type ThreadGoalDocumentSetResponse = {
  goal: v2.ThreadGoal;
  document: ThreadGoalDocument;
  revision?: unknown;
};

/** Experimental OIX thread/goal/document/create at tested tree 22d6ff263964.
 * Creation after COMPLETE is one native transaction, not a null-only insert. */
export type ThreadGoalDocumentCreateParams = {
  threadId: string;
  creationId: string;
  objective: string;
  document: string;
  status: 'active';
  expectedGoalId: string;
  expectedStatus: 'complete';
  expectedMissionRevision: number;
  expectedLifecycleRevision: number;
};

export type ThreadGoalDocumentCreateResponse = {
  creationId: string;
  goal: v2.ThreadGoal;
  document: ThreadGoalDocument;
  previousRevision: ThreadGoalRevision;
  revision: ThreadGoalRevision;
  replayed: boolean;
};

export type ThreadGoalDocumentGetResponse = {
  goal: v2.ThreadGoal | null;
  document: ThreadGoalDocument | null;
  content: string | null;
};

const digest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const MAX_DOCUMENT_BYTES = 1_048_576;
const threadIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** An unacknowledged write may have taken effect; never blindly submit it again. */
export class ManagedGoalDocumentError extends Error {
  constructor(readonly category: 'read_unavailable' | 'create_unavailable' |
    'stale_predecessor' | 'update_unconfirmed') {
    super(category === 'read_unavailable'
      ? 'Managed Goal document read unavailable.'
      : category === 'create_unavailable'
        ? 'Native managed Goal creation is unavailable.'
        : category === 'stale_predecessor'
          ? 'Completed predecessor changed; reread before a distinct creation.'
          : 'Managed Goal document update unconfirmed; reread before retry.');
    this.name = 'ManagedGoalDocumentError';
  }
}

export function validateGoalDocumentInput(input: ThreadGoalDocumentSetParams): void {
  if (typeof input.threadId !== 'string' || !threadIdPattern.test(input.threadId) ||
      typeof input.document !== 'string' || !input.document.trim() ||
      Buffer.byteLength(input.document, 'utf8') > MAX_DOCUMENT_BYTES ||
      input.expectedMissionRevision !== undefined && input.expectedMissionRevision !== null &&
      (!Number.isSafeInteger(input.expectedMissionRevision) || input.expectedMissionRevision < 1)) {
    throw new Error('Invalid managed Goal document or mission revision.');
  }
}

export function verifyGoalDocument(
  threadId: string,
  document: ThreadGoalDocument | null,
  content: string | null,
): void {
  if (!threadIdPattern.test(threadId)) throw new Error('Invalid managed Goal thread.');
  if (document === null && content === null) return;
  if (!document || typeof content !== 'string' || !content.trim() ||
      Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES ||
      !Number.isSafeInteger(document.byteLength) || document.byteLength !== Buffer.byteLength(content, 'utf8') ||
      !Number.isSafeInteger(document.missionRevision) || document.missionRevision < 1 ||
      typeof document.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(document.sha256) ||
      document.sha256 !== digest(content) ||
      ![
        `managed-goals/${threadId}/mission-${document.missionRevision}-${document.sha256}.md`,
        `managed-goals\\${threadId}\\mission-${document.missionRevision}-${document.sha256}.md`,
      ].includes(document.path)) {
    throw new Error('Managed Goal document receipt unavailable.');
  }
}
