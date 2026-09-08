import { Router, type Request, type Response } from 'express';
import {
  extractNotificationThreadId,
  extractNotificationTurnId,
  getCodexService,
} from '../../src/lib/codex/service';
import { enrichThreadWithReasoning } from '../../src/lib/codex/enrich-thread-reasoning';
import { mapNotificationToUiEvents } from '../../src/lib/codex/event-mapper';
import {
  paginateThreadTurns,
  parseThreadHistoryLimit,
} from '../utils/threadHistoryPagination';
import {
  buildPublicThreadSnapshot,
  applyPublicThreadUiEvents,
  matchesPublicThreadToken,
} from '../utils/publicThreadSnapshot';
import {
  readPublicThreadCache,
  writePublicThreadCache,
  type CachedPublicThreadSnapshot,
} from '../utils/publicThreadCache';
import { resolvePublicThreadId } from '../utils/publicThreadConfig';

const router = Router();
async function loadPublicThreadState(threadId: string): Promise<CachedPublicThreadSnapshot> {
  const service = getCodexService();
  let thread = await service.readThread(threadId);
  thread = enrichThreadWithReasoning(thread);
  const goal = await service.getThreadGoal(threadId);
  return {
    snapshot: buildPublicThreadSnapshot({
      thread,
      goal,
      title: process.env.INTERPRETER_PUBLIC_THREAD_TITLE?.trim() || thread.name || 'Live agent',
      nextCursor: null,
      hasMore: false,
      publicWorkspaceRoot: process.env.INTERPRETER_PUBLIC_WORKSPACE_ROOT?.trim(),
    }),
    refreshedAt: Date.now(),
  };
}

let cachedPublicThreadState: CachedPublicThreadSnapshot | null = null;
let publicThreadRefresh: Promise<CachedPublicThreadSnapshot> | null = null;
let publicThreadSubscription: { threadId: string; unsubscribe: () => void } | null = null;
let publicThreadCacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
let publicThreadCacheWriteChain = Promise.resolve();
let lastRefreshErrorLogAt = 0;

function schedulePublicThreadCacheWrite(): void {
  if (publicThreadCacheWriteTimer) return;
  publicThreadCacheWriteTimer = setTimeout(() => {
    publicThreadCacheWriteTimer = null;
    const state = cachedPublicThreadState;
    if (!state) return;
    publicThreadCacheWriteChain = publicThreadCacheWriteChain
      .then(() => writePublicThreadCache(
        process.env.INTERPRETER_PUBLIC_THREAD_CACHE_FILE?.trim(),
        state,
      ))
      .catch(reportBackgroundRefreshFailure);
  }, 200);
}

function ensurePublicThreadSubscription(threadId: string): void {
  if (publicThreadSubscription?.threadId === threadId) return;
  publicThreadSubscription?.unsubscribe();
  const service = getCodexService();
  publicThreadSubscription = {
    threadId,
    unsubscribe: service.subscribeNotifications((notification) => {
      if (extractNotificationThreadId(notification) !== threadId) return;
      const current = cachedPublicThreadState;
      if (!current || current.snapshot.threadId !== threadId) return;
      const nextSnapshot = applyPublicThreadUiEvents({
        snapshot: current.snapshot,
        events: mapNotificationToUiEvents(notification),
        turnId: extractNotificationTurnId(notification),
        publicWorkspaceRoot: process.env.INTERPRETER_PUBLIC_WORKSPACE_ROOT?.trim(),
      });
      if (nextSnapshot === current.snapshot) return;
      cachedPublicThreadState = { snapshot: nextSnapshot, refreshedAt: Date.now() };
      schedulePublicThreadCacheWrite();
    }),
  };
}

function refreshPublicThreadState(threadId: string): Promise<CachedPublicThreadSnapshot> {
  if (cachedPublicThreadState?.snapshot.threadId !== threadId) {
    cachedPublicThreadState = null;
  }
  if (publicThreadRefresh) return publicThreadRefresh;

  publicThreadRefresh = loadPublicThreadState(threadId)
    .then((state) => {
      cachedPublicThreadState = state;
      ensurePublicThreadSubscription(threadId);
      void writePublicThreadCache(
        process.env.INTERPRETER_PUBLIC_THREAD_CACHE_FILE?.trim(),
        state,
      ).catch(reportBackgroundRefreshFailure);
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
    let state = cachedPublicThreadState?.snapshot.threadId === threadId
      ? cachedPublicThreadState
      : null;
    if (!state) {
      state = await readPublicThreadCache(
        process.env.INTERPRETER_PUBLIC_THREAD_CACHE_FILE?.trim(),
        threadId,
      );
      if (state) cachedPublicThreadState = state;
    }
    if (!state) {
      state = await refreshPublicThreadState(threadId);
    }
    // The same native OIX client emits every Goal turn notification. Advance
    // the durable projection from that event stream instead of continuously
    // reparsing the full thread, which can grow to multiple gigabytes.
    ensurePublicThreadSubscription(threadId);

    const fullSnapshot = state.snapshot;
    const limit = parseThreadHistoryLimit(req.query.limit) ?? 24;
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    // Paginate the public messages rather than raw Codex turns. A turn can be
    // intentionally hidden (for example the automatic restart continuation)
    // or expand into multiple visible messages. Turn-based cursors could
    // therefore advertise more history but return an empty page.
    const page = paginateThreadTurns(fullSnapshot.messages, { limit, before });
    const snapshot = {
      ...fullSnapshot,
      messages: page.turns,
      page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    };
    res.setHeader('Cache-Control', 'no-store');
    return res.json(snapshot);
  } catch (error) {
    console.error('[public-thread] snapshot failed', error instanceof Error ? error.message : error);
    return res.status(503).json({ error: 'Public thread snapshot is unavailable.' });
  }
});

export default router;
