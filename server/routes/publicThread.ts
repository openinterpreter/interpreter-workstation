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

const router = Router();

function bearerToken(request: Request): string | undefined {
  const authorization = request.header('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
}

router.get('/snapshot', async (req: Request, res: Response) => {
  const threadId = process.env.INTERPRETER_PUBLIC_THREAD_ID?.trim();
  const expectedToken = process.env.INTERPRETER_PUBLIC_THREAD_TOKEN?.trim();
  if (!threadId || !expectedToken) {
    return res.status(503).json({ error: 'Public thread viewing is not configured.' });
  }
  if (!matchesPublicThreadToken(bearerToken(req), expectedToken)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    let thread = await getCodexService().readThread(threadId);
    thread = enrichThreadWithReasoning(thread);
    const limit = parseThreadHistoryLimit(req.query.limit) ?? 24;
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const page = paginateThreadTurns(thread.turns, { limit, before });
    const pagedThread = { ...thread, turns: page.turns };
    const goal = await getCodexService().getThreadGoal(threadId);
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
