import { useEffect, useState } from 'react';
import { getWindowSessionKey } from '../ipc';
import { useLayout } from '../hooks/useLayout';
import { buildApprovalQueueItems, filterWindowCliApprovals } from '../lib/approvals/approvalQueue';
import { getApprovalsSnapshot, refreshApprovals, subscribeApprovals } from '../stores/approvalsStore';
import { Approvals } from './Approvals';

/** Keep window-owned CLI permissions visible without attaching them to a
 * different conversation. The existing approval responder remains the sole
 * disposition path; this component never grants a permission automatically. */
export function UnboundCliApprovals() {
  const { state } = useLayout();
  const windowSessionKey = getWindowSessionKey();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const sync = () => setPending(filterWindowCliApprovals(
      buildApprovalQueueItems(getApprovalsSnapshot(), state.tabs), windowSessionKey,
    ).length > 0);
    sync();
    void refreshApprovals().catch(() => setPending(false));
    return subscribeApprovals(sync);
  }, [state.tabs, windowSessionKey]);

  if (!pending || !windowSessionKey) return null;
  return <section aria-label="Interpreter CLI approvals" className="fixed bottom-4 right-4 z-[100] max-h-[65vh] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border bg-background p-4 shadow-lg">
    <h2 className="mb-2 text-ui-sm font-medium">Interpreter CLI permission needed</h2>
    <Approvals unboundCliWindowSessionKey={windowSessionKey} />
  </section>;
}
