/**
 * useLiveToolCall — subscribe a card to per-item streaming snapshots.
 *
 * Given an initial ToolCallInfo (the value committed by the parent),
 * returns the most recent per-item snapshot from the live store if one
 * exists, otherwise returns the initial value unchanged.
 *
 * The point: a tool-call card calls this once and re-renders only when
 * ITS specific id ticks, not when the parent re-renders for unrelated
 * reasons. See `src/stores/liveItemsStore.ts`.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  getLiveToolCall,
  subscribeLiveToolCall,
} from '@/stores/liveItemsStore';
import type { ToolCallInfo } from './use-chat';

export function useLiveToolCall(initial: ToolCallInfo): ToolCallInfo {
  const itemId = initial.id;

  const subscribe = useCallback(
    (listener: () => void) => subscribeLiveToolCall(itemId, listener),
    [itemId],
  );
  const getSnapshot = useCallback(() => getLiveToolCall(itemId), [itemId]);

  const live = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return live ?? initial;
}
