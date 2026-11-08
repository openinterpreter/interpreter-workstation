import type { v2 } from '../handlers/codex-generated-types/index';

/** Read metadata and one turn shell only. Never hydrate rollout items here. */
export async function boundedSupervisorThread(
  threadId: string,
  read: (params: v2.ThreadReadParams) => Promise<v2.ThreadReadResponse>,
  turns: (params: v2.ThreadTurnsListParams) => Promise<v2.ThreadTurnsListResponse>,
): Promise<v2.Thread> {
  const { thread } = await read({ threadId, includeTurns: false });
  if (thread.id !== threadId || thread.turns.length !== 0) throw new Error('Invalid thread shell');
  const page = await turns({ threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  if (page.data.length > 1 || page.data.some(turn => turn.itemsView !== 'notLoaded' || turn.items.length)) {
    throw new Error('Invalid bounded turn page');
  }
  return { ...thread, turns: page.data };
}
