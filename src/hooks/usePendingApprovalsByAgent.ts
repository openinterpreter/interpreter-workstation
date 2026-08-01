/**
 * Hook that tracks pending approval counts per agent.
 * Subscribes to approval list changes and returns a Map<agentTabId, count>.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import type { QuestionRequest } from '../../electron/ipc/registry';
import { useLayout } from './useLayout';
import { playSound } from '@/utils/sounds';
import { getApprovalsSnapshot, refreshApprovals, subscribeApprovals } from '../stores/approvalsStore';
import {
  buildPendingApprovalsByAgent,
  resolveApprovalOwnerAgentId,
} from '../lib/approvals/approvalQueue';

export {
  buildPendingApprovalsByAgent,
  resolveApprovalOwnerAgentId,
};

export function usePendingApprovalsByAgent(): Map<string, number> {
  const { state } = useLayout();
  const [approvals, setApprovals] = useState<QuestionRequest[]>(() => getApprovalsSnapshot());
  const prevCountRef = useRef(0);

  useEffect(() => {
    const syncApprovals = () => {
      const nextApprovals = getApprovalsSnapshot();
      if (nextApprovals.length > prevCountRef.current) {
        playSound('agentNeedsAttention');
      }
      prevCountRef.current = nextApprovals.length;
      setApprovals(nextApprovals);
    };

    syncApprovals();

    refreshApprovals().catch(() => {});

    const unsubscribe = subscribeApprovals(syncApprovals);

    return unsubscribe;
  }, []);

  return useMemo(
    () => buildPendingApprovalsByAgent(approvals, state.tabs),
    [approvals, state.tabs],
  );
}
