import type { v2 } from '../handlers/codex-generated-types/index';

const TERMINAL = new Set<v2.TurnStatus>(['completed', 'failed', 'interrupted']);

/** Prove that an exact saved owner and the latest turn are terminal. Ambiguity
 * retains the caller guard; no native input, queue, or process is modified. */
export async function nativeTerminalOwnerObserved(
  threadId: string,
  ownerTurnId: string,
  readMetadata: () => Promise<v2.ThreadReadResponse>,
  readTurns: (params: v2.ThreadTurnsListParams) => Promise<v2.ThreadTurnsListResponse>,
): Promise<boolean> {
  const metadata = await readMetadata();
  if (metadata.thread.id !== threadId || metadata.thread.status.type !== 'idle' ||
      metadata.thread.turns.length !== 0) return false;
  let cursor: string | null = null;
  const seen = new Set<string>();
  const seenTurns = new Set<string>();
  let latestTurnId: string | null = null;
  for (let pageIndex = 0; pageIndex < 32; pageIndex++) {
    const page = await readTurns({ threadId, limit: 32, sortDirection: 'desc',
      itemsView: 'notLoaded', cursor });
    if (page.data.length === 0 || page.data.length > 32 || page.data.some(turn =>
      turn.itemsView !== 'notLoaded' || turn.items.length || !turn.id)) return false;
    for (const turn of page.data) {
      if (seenTurns.has(turn.id)) return false;
      seenTurns.add(turn.id);
    }
    if (pageIndex === 0) {
      const newest = page.data[0];
      latestTurnId = newest.id;
      if (!TERMINAL.has(newest.status)) return false;
    }
    const owned = page.data.find(turn => turn.id === ownerTurnId);
    if (owned) {
      if (!TERMINAL.has(owned.status)) return false;
      const after = await readMetadata();
      if (after.thread.id !== threadId || after.thread.status.type !== 'idle' ||
          after.thread.turns.length !== 0) return false;
      const latest = await readTurns({ threadId, limit: 1, sortDirection: 'desc',
        itemsView: 'notLoaded' });
      return latest.data.length === 1 && latest.data[0].id === latestTurnId &&
        latest.data[0].itemsView === 'notLoaded' && latest.data[0].items.length === 0 &&
        TERMINAL.has(latest.data[0].status);
    }
    if (page.nextCursor === null) return false;
    if (typeof page.nextCursor !== 'string' || page.nextCursor.length > 2048 ||
        seen.has(page.nextCursor)) return false;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return false;
}
