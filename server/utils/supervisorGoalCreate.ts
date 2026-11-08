import { getCodexService } from '../../src/lib/codex/service';
import { readStableSupervisorGoal } from './supervisorGoalRead';

type Service = Pick<ReturnType<typeof getCodexService>,
  'getThreadGoalWithRevision' | 'getThreadGoalDocument' | 'setThreadGoalDocument'>;

export class SupervisorGoalCreateError extends Error {
  constructor(readonly category: 'invalid_document' | 'goal_exists' |
    'read_unavailable' | 'mutation_unconfirmed') { super(category); }
}

/** Native must enforce unique initial Goal insertion. A lost acknowledgement is
 * unknown; neither this service nor the supervisor ever reissues the create. */
export async function createSupervisorGoal(service: Service, threadId: string,
  document: unknown, maxWaitMs = 3_000) {
  if (typeof document !== 'string' || !document.trim() ||
      Buffer.byteLength(document, 'utf8') > 1_048_576) {
    throw new SupervisorGoalCreateError('invalid_document');
  }
  let presence: Awaited<ReturnType<Service['getThreadGoalWithRevision']>>;
  try { presence = await service.getThreadGoalWithRevision(threadId, maxWaitMs); }
  catch { throw new SupervisorGoalCreateError('read_unavailable'); }
  if (presence.goal !== null) throw new SupervisorGoalCreateError('goal_exists');
  if (presence.revision !== null) throw new SupervisorGoalCreateError('read_unavailable');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const created = await Promise.race([
      service.setThreadGoalDocument({ threadId, document, status: 'active' }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(Error('unconfirmed')), maxWaitMs);
      }),
    ]);
    const confirmed = await readStableSupervisorGoal(service, threadId, maxWaitMs);
    if (!confirmed.goal || confirmed.goal.status !== 'active' ||
        confirmed.document?.content !== document ||
        confirmed.document.sha256 !== created.document.sha256 ||
        confirmed.document.missionRevision !== created.document.missionRevision) {
      throw Error('unconfirmed');
    }
    return confirmed;
  } catch { throw new SupervisorGoalCreateError('mutation_unconfirmed'); }
  finally { if (timeout) clearTimeout(timeout); }
}
