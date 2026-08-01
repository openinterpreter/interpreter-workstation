import { useEffect, useMemo, useRef, useState } from 'react';
import { denyApproval, respondApproval } from '../api';
import { APPROVALS_LIST_ID } from '../../shared/element-ids';
import { runtime as runtimeIpc, settings as settingsIpc } from '@/ipc';
import { trackApprovalShown, trackApprovalResolved } from '../utils/telemetry';
import type { QuestionRequest } from '../../electron/ipc/registry';
import type { QuestionResponse, QuestionResult } from '../../shared/types/approval';
import { AlertTriangle } from 'lucide-react';
import { useLayout } from '../hooks/useLayout';
import { useAgentActivityMap } from '../hooks/useAgentActivityMap';
import { getApprovalsSnapshot, refreshApprovals, subscribeApprovals } from '../stores/approvalsStore';
import { buildApprovalQueueItems, filterApprovalQueueItems } from '../lib/approvals/approvalQueue';
import { useToast } from '../contexts/ToastContext';
import { ApprovalQueueCard } from './approvals/ApprovalQueueCard';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from './ui/alert-dialog';

type ApprovalMode = 'once' | 'session';

type PendingRuntimeRestartApproval = {
  id: string;
  mode: ApprovalMode;
  runningConversationCount: number;
};

function isRuntimeRestartApproval(approval: QuestionRequest | undefined): boolean {
  return approval?.context?.runtimeRestart === true;
}

function useRelativeTime() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

export function Approvals({
  ownerAgentId,
}: {
  ownerAgentId?: string;
}) {
  const { state } = useLayout();
  const { showToast, dismissToast } = useToast();
  const agentActivityMap = useAgentActivityMap();
  const [approvals, setApprovals] = useState<QuestionRequest[]>(() => getApprovalsSnapshot());
  const [loading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questionSettings, setQuestionSettings] = useState({ enabled: true, seconds: 15 });
  const [pendingRuntimeRestartApproval, setPendingRuntimeRestartApproval] = useState<PendingRuntimeRestartApproval | null>(null);
  // Track when each approval first appeared on screen so we can report the
  // duration-to-resolve once the user approves/denies/answers.
  const approvalShownAtRef = useRef<Map<string, number>>(new Map());
  const runtimeRestartToastIdRef = useRef<string | null>(null);
  const runningConversationCount = useMemo(
    () => Array.from(agentActivityMap.values()).filter((activity) => activity.isRunning).length,
    [agentActivityMap],
  );
  useRelativeTime();

  useEffect(() => {
    const seen = approvalShownAtRef.current;
    const now = Date.now();
    for (const approval of approvals) {
      if (!seen.has(approval.id)) {
        seen.set(approval.id, now);
        trackApprovalShown({
          approvalId: approval.id,
          toolName: approval.toolName,
          serverId: approval.serverId,
          kind: approval.isSimpleApproval ? 'simple' : 'question',
        });
      }
    }
    // Drop entries for approvals that disappeared (resolved elsewhere).
    const live = new Set(approvals.map((approval) => approval.id));
    for (const id of Array.from(seen.keys())) {
      if (!live.has(id)) seen.delete(id);
    }
  }, [approvals]);

  useEffect(() => {
    const syncApprovals = () => {
      setApprovals(getApprovalsSnapshot());
      setError(null);
    };

    syncApprovals();

    refreshApprovals().catch((err) => {
      console.error('[Approvals] Failed to load approvals:', err);
      setError(err.message);
    });

    const unsubscribe = subscribeApprovals(syncApprovals);

    settingsIpc.get().then((config: any) => {
      setQuestionSettings({
        enabled: config.questionAutoTimeoutEnabled ?? true,
        seconds: config.questionAutoTimeoutSeconds ?? 15,
      });
    }).catch(() => {});

    return unsubscribe;
  }, []);

  useEffect(() => {
    return runtimeIpc.onRestarted(() => {
      const toastId = runtimeRestartToastIdRef.current;
      if (!toastId) {
        return;
      }

      dismissToast(toastId);
      runtimeRestartToastIdRef.current = null;
      showToast('Interpreter restarted. New changes have taken effect.', 'success', 5000);
    });
  }, [dismissToast, showToast]);

  async function approveNow(
    id: string,
    mode: ApprovalMode,
    approval?: QuestionRequest,
    extraAnswers?: QuestionResponse,
  ) {
    // NOTE(approval-flow): This panel resolves server-owned approvals; it never
    // owns the queue. `respondApproval()` goes through IPC/HTTP back to
    // `ApprovalManager.respond()`, which releases the waiting runtime/tool
    // promise.
    const request = approval ?? approvals.find(a => a.id === id);
    const isRuntimeRestart = isRuntimeRestartApproval(request);
    let restartToastId: string | null = null;

    try {
      const shownAt = approvalShownAtRef.current.get(id);
      trackApprovalResolved({
        approvalId: id,
        toolName: request?.toolName,
        serverId: request?.serverId,
        action: mode === 'session' ? 'approve_session' : 'approve_once',
        durationMs: shownAt ? Date.now() - shownAt : 0,
      });
      approvalShownAtRef.current.delete(id);

      if (isRuntimeRestart) {
        restartToastId = showToast('Interpreter is restarting the agent...', 'info');
        runtimeRestartToastIdRef.current = restartToastId;
      }

      const response = await respondApproval(id, {
        answers: { '0': 'approve', ...(extraAnswers ?? {}) },
        approvalMode: mode,
      });
      if (!response.success) {
        throw new Error(response.error ?? 'Approval was already resolved.');
      }
    } catch (err: any) {
      console.error('Failed to approve:', err);
      if (restartToastId) {
        dismissToast(restartToastId);
        if (runtimeRestartToastIdRef.current === restartToastId) {
          runtimeRestartToastIdRef.current = null;
        }
      }
      if (isRuntimeRestart) {
        showToast('Interpreter could not restart. Try again.', 'error', 8000);
      }
      setError(err.message);
    }
  }

  async function handleApprove(id: string, mode: ApprovalMode = 'once', extraAnswers?: QuestionResponse) {
    const approval = approvals.find(a => a.id === id);
    if (isRuntimeRestartApproval(approval) && runningConversationCount > 0) {
      setPendingRuntimeRestartApproval({ id, mode, runningConversationCount });
      return;
    }

    await approveNow(id, mode, approval, extraAnswers);
  }

  function confirmPendingRuntimeRestart() {
    if (!pendingRuntimeRestartApproval) return;
    const pending = pendingRuntimeRestartApproval;
    setPendingRuntimeRestartApproval(null);
    void approveNow(pending.id, pending.mode);
  }

  async function handleDeny(id: string) {
    try {
      const approval = approvals.find(a => a.id === id);
      const shownAt = approvalShownAtRef.current.get(id);
      trackApprovalResolved({
        approvalId: id,
        toolName: approval?.toolName,
        serverId: approval?.serverId,
        action: 'deny',
        durationMs: shownAt ? Date.now() - shownAt : 0,
      });
      approvalShownAtRef.current.delete(id);
      await denyApproval(id);
    } catch (err: any) {
      console.error('Failed to deny:', err);
      setError(err.message);
    }
  }

  async function handleQuestionRespond(requestId: string, result: QuestionResult) {
    try {
      const approval = approvals.find(a => a.id === requestId);
      const shownAt = approvalShownAtRef.current.get(requestId);
      trackApprovalResolved({
        approvalId: requestId,
        toolName: approval?.toolName,
        serverId: approval?.serverId,
        action: 'question_answered',
        durationMs: shownAt ? Date.now() - shownAt : 0,
      });
      approvalShownAtRef.current.delete(requestId);
      const response = await respondApproval(requestId, result);
      if (!response.success) {
        console.log('[Approvals] Already resolved:', response.error);
      }
    } catch (err: any) {
      console.error('Failed to respond:', err);
      setError(err.message);
    }
  }

  if (loading) {
    return (
      <div className="px-1 py-3 text-ui-sm text-muted-foreground">
        Loading approvals...
      </div>
    );
  }

  const approvalQueueItems = useMemo(
    () => buildApprovalQueueItems(approvals, state.tabs),
    [approvals, state.tabs],
  );
  const visibleItems = useMemo(
    () => filterApprovalQueueItems(approvalQueueItems, ownerAgentId),
    [approvalQueueItems, ownerAgentId],
  );
  const visibleApprovals = visibleItems.map((item) => item.approval);
  const isEmpty = visibleApprovals.length === 0;

  return (
    <>
      <div className="flex h-full flex-col">
        {error && (
          <div className="mb-3 py-1 text-ui-sm text-destructive">
            <div className="font-medium">Approval error</div>
            <div className="mt-1 text-destructive/80">{error}</div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto" data-testid={APPROVALS_LIST_ID}>
          {isEmpty ? (
            <div className="flex items-center justify-center py-3 text-muted-foreground text-ui-xs">
              Tool approvals appear here when a command needs confirmation.
            </div>
          ) : (
            <div className="space-y-3 px-1 py-1">
              {visibleItems.map((item) => (
                <ApprovalQueueCard
                  key={item.approval.id}
                  item={item}
                  pendingCount={visibleApprovals.length}
                  questionSettings={questionSettings}
                  onDeny={handleDeny}
                  onApprove={(id, mode, _approval, extraAnswers) => {
                    void handleApprove(id, mode, extraAnswers);
                  }}
                  onQuestionRespond={(id, result) => {
                    void handleQuestionRespond(id, result);
                  }}
                  onRevealAgent={(targetAgentId, approval) => {
                    const layoutCtx = (window as any).__layoutContext;
                    if (layoutCtx?.setActiveTab) {
                      layoutCtx.setActiveTab(targetAgentId);
                    }
                    setTimeout(() => {
                      window.dispatchEvent(new CustomEvent('highlight-approval', {
                        detail: { approvalId: approval.id, toolCallId: approval.toolCallId },
                      }));
                    }, 100);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={pendingRuntimeRestartApproval !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRuntimeRestartApproval(null);
          }
        }}
      >
        <AlertDialogContent
          size="default"
          className="gap-0 overflow-hidden p-0"
        >
          <AlertDialogHeader
            className="gap-4 px-6 pb-5 pt-6 sm:px-7 sm:pb-6 sm:pt-7"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--oa-bg-subtle) 22%, transparent) 0%, transparent 72%)",
            }}
          >
            <AlertDialogMedia className="bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
              <AlertTriangle />
            </AlertDialogMedia>
            <AlertDialogTitle>Restart Interpreter?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRuntimeRestartApproval
                ? `${pendingRuntimeRestartApproval.runningConversationCount} conversation${pendingRuntimeRestartApproval.runningConversationCount === 1 ? ' is' : 's are'} still running. Restarting will stop ${pendingRuntimeRestartApproval.runningConversationCount === 1 ? 'that conversation' : 'those conversations'} for every agent.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="px-6 pb-5 sm:px-7 sm:pb-6">
            <AlertDialogCancel className="sm:min-w-[9rem]">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmPendingRuntimeRestart}
              className="sm:min-w-[10rem]"
            >
              Restart now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
