const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

export type ThreadHistoryPage<T> = {
  turns: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export function parseThreadHistoryLimit(value: unknown): number | null {
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Number(raw), 1), MAX_PAGE_SIZE);
}

/** A history cursor is opaque. Only its size and printable characters are
 * checked here; the runtime decides whether it names a page. */
export function isThreadHistoryCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 1024
    && !/[\x00-\x1f\x7f]/.test(value);
}

export function paginateThreadTurns<T extends { id: string }>(
  turns: readonly T[],
  options: { limit: number; before?: string },
): ThreadHistoryPage<T> {
  const beforeIndex = options.before
    ? turns.findIndex((turn) => turn.id === options.before)
    : turns.length;
  const end = beforeIndex >= 0 ? beforeIndex : turns.length;
  const start = Math.max(0, end - options.limit);
  const page = turns.slice(start, end);

  return {
    turns: page,
    nextCursor: start > 0 && page[0] ? page[0].id : null,
    hasMore: start > 0,
  };
}
