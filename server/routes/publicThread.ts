import { Router, type Request, type Response } from 'express';
import { getCodexService } from '../../src/lib/codex/service';
import { enrichThreadWithReasoning } from '../../src/lib/codex/enrich-thread-reasoning';
import {
  paginateThreadTurns,
  parseThreadHistoryLimit,
} from '../utils/threadHistoryPagination';
import {
  buildPublicThreadSnapshot,
  matchesPublicThreadToken,
} from '../utils/publicThreadSnapshot';
import { resolvePublicThreadId } from '../utils/publicThreadConfig';

const router = Router();
const PUBLIC_THREAD_REFRESH_INTERVAL_MS = 1_000;

async function loadPublicThreadState(threadId: string) {
  const service = getCodexService();
  let thread = await service.readThread(threadId);
  thread = enrichThreadWithReasoning(thread);
  const goal = await service.getThreadGoal(threadId);
  return { threadId, thread, goal, refreshedAt: Date.now() };
}

type PublicThreadState = Awaited<ReturnType<typeof loadPublicThreadState>>;

let cachedPublicThreadState: PublicThreadState | null = null;
let publicThreadRefresh: Promise<PublicThreadState> | null = null;
let lastRefreshErrorLogAt = 0;

function refreshPublicThreadState(threadId: string): Promise<PublicThreadState> {
  if (cachedPublicThreadState?.threadId !== threadId) {
    cachedPublicThreadState = null;
  }
  if (publicThreadRefresh) return publicThreadRefresh;

  publicThreadRefresh = loadPublicThreadState(threadId)
    .then((state) => {
      cachedPublicThreadState = state;
      return state;
    })
    .finally(() => {
      publicThreadRefresh = null;
    });
  return publicThreadRefresh;
}

function reportBackgroundRefreshFailure(error: unknown): void {
  const now = Date.now();
  if (now - lastRefreshErrorLogAt < 30_000) return;
  lastRefreshErrorLogAt = now;
  console.error(
    '[public-thread] background refresh failed; serving the last durable snapshot',
    error instanceof Error ? error.message : error,
  );
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.header('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
}

router.get('/snapshot', async (req: Request, res: Response) => {
  const threadId = resolvePublicThreadId();
  const expectedToken = process.env.INTERPRETER_PUBLIC_THREAD_TOKEN?.trim();
  if (!threadId || !expectedToken) {
    return res.status(503).json({ error: 'Public thread viewing is not configured.' });
  }
  if (!matchesPublicThreadToken(bearerToken(req), expectedToken)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    let state = cachedPublicThreadState?.threadId === threadId
      ? cachedPublicThreadState
      : null;
    if (!state) {
      state = await refreshPublicThreadState(threadId);
    } else if (Date.now() - state.refreshedAt >= PUBLIC_THREAD_REFRESH_INTERVAL_MS) {
      // OIX may be occupied by a long tool operation in the active Goal turn.
      // Keep public reads instant from the last successful in-memory snapshot
      // while one shared refresh waits for the native runtime. The rollout on
      // disk remains the durable source of truth across service restarts.
      void refreshPublicThreadState(threadId).catch(reportBackgroundRefreshFailure);
    }

    const { thread, goal } = state;
    const limit = parseThreadHistoryLimit(req.query.limit) ?? 24;
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const page = paginateThreadTurns(thread.turns, { limit, before });
    const pagedThread = { ...thread, turns: page.turns };
    const snapshot = buildPublicThreadSnapshot({
      thread: pagedThread,
      goal,
      title: process.env.INTERPRETER_PUBLIC_THREAD_TITLE?.trim() || thread.name || 'Live agent',
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(snapshot);
  } catch (error) {
    console.error('[public-thread] snapshot failed', error instanceof Error ? error.message : error);
    return res.status(503).json({ error: 'Public thread snapshot is unavailable.' });
  }
});

export default router;
