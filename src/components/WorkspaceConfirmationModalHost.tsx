import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { WorkspaceConfirmationRequestedEvent } from '../../electron/ipc/registry';
import { workspace } from '@/ipc';
import { Button } from './ui/button';
import { OnboardingModal } from './onboarding/components/OnboardingModal';

const WORKSPACE_CONFIRMATION_MODAL_STYLE: CSSProperties = {
  background: 'color-mix(in oklch, var(--oa-bg-app) 86%, var(--oa-bg-subtle) 14%)',
  border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 82%, transparent)',
  boxShadow: '0 28px 72px rgba(0, 0, 0, 0.24)',
  backdropFilter: 'blur(24px)',
};

export function WorkspaceConfirmationModalHost() {
  "use no memo";

  const [queue, setQueue] = useState<WorkspaceConfirmationRequestedEvent[]>([]);
  const [isResponding, setIsResponding] = useState(false);
  const activeRequest = queue[0] ?? null;

  useEffect(() => {
    return workspace.onConfirmationRequested((event: WorkspaceConfirmationRequestedEvent) => {
      console.log('[WorkspaceSwitch] modal-request-received', {
        requestId: event.requestId,
        workspacePath: event.workspacePath,
      });
      setQueue((currentQueue) => [...currentQueue, event]);
    });
  }, []);

  const dismissActiveRequest = useCallback(() => {
    setQueue((currentQueue) => currentQueue.slice(1));
  }, []);

  const handleRespond = useCallback(async (approved: boolean) => {
    if (!activeRequest || isResponding) {
      return;
    }

    setIsResponding(true);
    try {
      console.log('[WorkspaceSwitch] modal-responding', {
        requestId: activeRequest.requestId,
        approved,
        workspacePath: activeRequest.workspacePath,
      });
      await workspace.respondToConfirmation({
        requestId: activeRequest.requestId,
        approved,
      });
      dismissActiveRequest();
    } catch (error) {
      console.error('[WorkspaceConfirmationModalHost] Failed to resolve workspace confirmation:', error);
      dismissActiveRequest();
    } finally {
      setIsResponding(false);
    }
  }, [activeRequest, dismissActiveRequest, isResponding]);

  const permissionCopy = useMemo(() => {
    if (!activeRequest) {
      return null;
    }

    return (
      <div className="rounded-[20px] bg-[color-mix(in_oklch,var(--oa-bg-subtle)_72%,transparent)] p-4 sm:p-5">
        <p className="text-[13px] leading-5 text-[var(--oa-text-muted)]">
          {activeRequest.permissionNote}
        </p>
        <p className="mt-2 break-all text-[14px] font-medium leading-6 text-[var(--oa-text-strong)]">
          {activeRequest.workspacePath}
        </p>
        <p className="mt-3 text-[13px] leading-5 text-[var(--oa-text-muted)]">
          {activeRequest.backupNote}
        </p>
        {activeRequest.detailItems && activeRequest.detailItems.length > 0 ? (
          <div className="mt-4 rounded-[16px] bg-[color-mix(in_oklch,var(--oa-bg-app)_78%,transparent)] p-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--oa-text-faint)]">
              {activeRequest.detailItemsLabel ?? 'Affected files'}
            </p>
            <div className="mt-2 max-h-52 overflow-y-auto rounded-[12px] border border-[color:color-mix(in_oklch,var(--oa-border)_74%,transparent)] bg-[color-mix(in_oklch,var(--oa-bg-app)_92%,transparent)]">
              {activeRequest.detailItems.map((itemPath) => (
                <div
                  key={itemPath}
                  className="border-b border-[color:color-mix(in_oklch,var(--oa-border)_56%,transparent)] px-3 py-2 text-[13px] leading-5 text-[var(--oa-text-strong)] last:border-b-0"
                >
                  {itemPath}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }, [activeRequest]);

  const isNotice = activeRequest?.variant === 'notice';

  return (
    <OnboardingModal
      open={activeRequest !== null}
      onClose={() => {
        void handleRespond(false);
      }}
      panelClassName="max-w-[560px] rounded-[26px] p-6 sm:p-7"
      panelStyle={WORKSPACE_CONFIRMATION_MODAL_STYLE}
    >
      {activeRequest && (
        <div className="space-y-6 text-left">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <h2 className="text-[26px] font-semibold tracking-[-0.025em] text-[var(--oa-text-strong)]">
                {activeRequest.title}
              </h2>
              <p className="max-w-[32rem] text-[15px] leading-6 text-[var(--oa-text-muted)] text-pretty">
                {activeRequest.message}
              </p>
            </div>

            {permissionCopy}
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {!isNotice && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void handleRespond(false);
                }}
                disabled={isResponding}
                className="rounded-full px-4"
              >
                {activeRequest.cancelLabel}
              </Button>
            )}
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => {
                void handleRespond(!isNotice);
              }}
              disabled={isResponding}
              className="rounded-full px-4"
            >
              {activeRequest.confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </OnboardingModal>
  );
}
