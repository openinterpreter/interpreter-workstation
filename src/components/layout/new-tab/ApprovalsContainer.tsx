import { useState, useEffect } from 'react';
import { ApprovalPromptDock } from '../../../../agent/components/composer/ApprovalPromptDock';
import { getApprovalsSnapshot, refreshApprovals, subscribeApprovals } from '../../../stores/approvalsStore';
import { useLayout } from '../../../hooks/useLayout';
import { buildApprovalQueueItems, filterApprovalQueueItems } from '../../../lib/approvals/approvalQueue';

// Renders only when there are pending approvals.
export function ApprovalsContainer({
  ownerAgentId,
  className,
}: {
  ownerAgentId?: string;
  className?: string;
}) {
  const { state } = useLayout();
  const [hasApprovals, setHasApprovals] = useState(false);

  useEffect(() => {
    const syncApprovals = () => {
      const approvals = getApprovalsSnapshot();
      const items = buildApprovalQueueItems(approvals, state.tabs);
      setHasApprovals(filterApprovalQueueItems(items, ownerAgentId).length > 0);
    };

    syncApprovals();

    refreshApprovals().catch(() => {
      setHasApprovals(false);
    });

    const unsubscribe = subscribeApprovals(syncApprovals);

    return unsubscribe;
  }, [ownerAgentId, state.tabs]);

  if (!hasApprovals) {
    return null;
  }

  return (
    <div className={className}>
      <ApprovalPromptDock agentId={ownerAgentId} />
    </div>
  );
}
