import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Chrome, X } from 'lucide-react';
import { browserControl } from '@/ipc';
import { Button } from '@/components/ui/button';
import { useLowerLeftNotice } from '@/contexts/LowerLeftNoticesContext';
import { useToast } from '@/contexts/ToastContext';
import { useLayoutActions } from '@/hooks/useLayout';
import {
  getBrowserSplitOfferTarget,
  type BrowserSplitOfferTarget,
} from '@/utils/browserSplitOffer';

const NOTICE_ID = 'browser-split-offer';
const AUTO_DISMISS_MS = 10_000;

export function BrowserSplitOfferNotice() {
  "use no memo";

  const { showToast } = useToast();
  const { setLeftSidebarOpen, setRightSidebarOpen } = useLayoutActions();
  const [offer, setOffer] = useState<BrowserSplitOfferTarget | null>(null);
  const [isArranging, setIsArranging] = useState(false);
  const previousActiveSessionsRef = useRef<number | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await browserControl.getStatus();
      const nextOffer = getBrowserSplitOfferTarget(previousActiveSessionsRef.current, status);
      previousActiveSessionsRef.current = status.activeSessions;
      if (nextOffer) {
        setOffer(nextOffer);
      }
    } catch (error) {
      console.error('Failed to load browser control status for split offer:', error);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();

    if (!browserControl.onChanged) {
      return undefined;
    }

    return browserControl.onChanged((event) => {
      if (event.reason === 'status') {
        void refreshStatus();
      }
    });
  }, [refreshStatus]);

  useEffect(() => {
    if (!offer) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setOffer(null);
    }, AUTO_DISMISS_MS);

    return () => window.clearTimeout(timeoutId);
  }, [offer]);

  const handleDismiss = useCallback(() => {
    setOffer(null);
  }, []);

  const handleArrange = useCallback(async () => {
    if (!offer || isArranging) {
      return;
    }

    setIsArranging(true);
    setLeftSidebarOpen(false);
    setRightSidebarOpen(false);

    try {
      const result = await browserControl.arrangeSplit({
        extensionId: offer.extensionId,
        targetId: offer.targetId,
      });

      if (!result.success) {
        showToast(result.error || 'Could not rearrange windows.', 'error', 6000);
        return;
      }

      setOffer(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not rearrange windows.';
      showToast(message, 'error', 6000);
    } finally {
      setIsArranging(false);
    }
  }, [isArranging, offer, setLeftSidebarOpen, setRightSidebarOpen, showToast]);

  const content = useMemo(() => {
    if (!offer) {
      return null;
    }

    const browserLabel = offer.browserName || 'Browser';

    return (
      <div className="w-[320px] max-w-[calc(100vw-32px)]">
        <div
          className="overflow-hidden rounded-[8px] border border-[var(--oa-border)] bg-[var(--oa-bg)] text-[var(--oa-text)] shadow-[0_18px_48px_rgba(0,0,0,0.18)]"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-3 px-3.5 py-3.5">
            <div
              className="mt-0.5 grid h-9 w-12 shrink-0 grid-cols-[4fr_1fr] overflow-hidden rounded-[7px] border border-[var(--oa-border)] bg-[var(--oa-bg-subtle)]"
              aria-hidden="true"
            >
              <div className="flex items-center justify-center border-r border-[var(--oa-border)]">
                <Chrome className="size-4 text-[var(--oa-text)]" />
              </div>
              <div className="flex items-center justify-center">
                <AppWindow className="size-3 text-[var(--oa-text-muted)]" />
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <span className="block text-ui-sm font-medium text-[var(--oa-text-strong, var(--foreground))]">
                Shared browser tab connected
              </span>
              <span className="mt-0.5 block text-ui-xs leading-4 text-muted-foreground">
                Place {browserLabel} on the left and Interpreter on the right?
              </span>
              <div className="mt-3 flex items-center gap-2">
                <Button
                  onClick={handleArrange}
                  disabled={isArranging}
                  variant="default"
                  size="sm"
                  className="h-8 px-3"
                >
                  {isArranging ? 'Rearranging...' : 'Rearrange'}
                </Button>
              </div>
            </div>

            <Button
              onClick={handleDismiss}
              disabled={isArranging}
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 shrink-0 text-muted-foreground/60 hover:text-foreground"
              aria-label="Dismiss browser layout offer"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    );
  }, [handleArrange, handleDismiss, isArranging, offer]);

  useLowerLeftNotice(NOTICE_ID, content);

  return null;
}
