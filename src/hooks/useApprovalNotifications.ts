/**
 * Hook that sends desktop notifications when approvals are created.
 * Suppresses notifications when the window is focused AND the active tab is the requesting agent.
 * Handles notification clicks to navigate to the agent tab and highlight the approval.
 *
 * Uses Electron Notification (via IPC) when in Electron, falls back to
 * Web Notifications API in browser/dev mode.
 */

import { useEffect, useRef } from 'react';
import { approvals as approvalsIpc, desktopNotification } from '@/ipc';
import type { ApprovalCreatedEvent } from '../../electron/ipc/registry';
import type { DesktopNotificationClickedEvent } from '../../electron/ipc/registry';
import { resolveApprovalOwnerAgentId } from './usePendingApprovalsByAgent';
import { useToast } from '@/contexts/ToastContext';

const isElectron = !!window.electron;

function navigateToApproval(agentId?: string, approvalId?: string) {
  if (agentId) {
    const layoutCtx = (window as any).__layoutContext;
    if (layoutCtx?.setActiveTab) {
      layoutCtx.setActiveTab(agentId);
    }
  }
  if (approvalId) {
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('highlight-approval', {
        detail: { approvalId },
      }));
    }, 200);
  }
}

function showWebNotification(title: string, body: string, agentId?: string, approvalId?: string) {
  if (!('Notification' in window)) return;

  const send = () => {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      navigateToApproval(agentId, approvalId);
    };
  };

  if (Notification.permission === 'granted') {
    send();
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') send();
    });
  }
}

export function useApprovalNotifications() {
  // Track which approval IDs we've already notified about
  const notifiedIds = useRef(new Set<string>());
  const { showToast } = useToast();

  useEffect(() => {
    // Listen for new approvals
    const unsubCreated = approvalsIpc.onCreated((event: ApprovalCreatedEvent) => {
      const approval = event.approval;
      const layoutCtx = (window as any).__layoutContext;
      const layoutState = layoutCtx?.getState?.();
      const ownerAgentId = layoutState?.tabs
        ? resolveApprovalOwnerAgentId(approval, layoutState.tabs)
        : approval.agentId;

      // Avoid duplicate notifications
      if (notifiedIds.current.has(approval.id)) return;
      notifiedIds.current.add(approval.id);

      // Clean up old IDs periodically
      if (notifiedIds.current.size > 100) {
        const arr = Array.from(notifiedIds.current);
        notifiedIds.current = new Set(arr.slice(-50));
      }

      if (!ownerAgentId) {
        console.error('[Approvals] Failed to resolve owner agent for approval', {
          approvalId: approval.id,
          toolName: approval.toolName,
          serverId: approval.serverId,
          toolCallId: approval.toolCallId ?? null,
          threadId: typeof approval.context?.threadId === 'string' ? approval.context.threadId : null,
        });
        showToast('Interpreter hit an approval routing error. This request was not attached to an agent thread.', 'error', 8000);
        return;
      }

      // Suppression: if window is focused AND the active tab is this agent, skip
      if (document.hasFocus() && ownerAgentId) {
        if (layoutState) {
          const activePaneId = layoutState.activePaneId;
          if (activePaneId) {
            const findPane = (node: any): any => {
              if (node.tabIds) return node.id === activePaneId ? node : null;
              for (const child of node.children || []) {
                const found = findPane(child);
                if (found) return found;
              }
              return null;
            };
            const activePane = findPane(layoutState.tree);
            if (activePane?.activeTabId === ownerAgentId) return;
          }
        }
      }

      // Build notification content
      const isQuestion = !approval.isSimpleApproval;
      const title = isQuestion ? 'Question from agent' : 'Approval needed';
      const body = isQuestion
        ? (approval.questions?.[0]?.question || approval.toolName)
        : `${approval.toolName} requires approval`;

      if (isElectron) {
        // Electron: use native notification via IPC
        desktopNotification.show({
          title,
          body,
          agentId: ownerAgentId,
          approvalId: approval.id,
        }).catch(() => {});
      } else {
        // Browser/dev: use Web Notifications API
        showWebNotification(title, body, ownerAgentId, approval.id);
      }
    });

    // Listen for Electron notification clicks → navigate to agent + highlight
    let unsubClicked: (() => void) | undefined;
    if (isElectron) {
      unsubClicked = desktopNotification.onClicked((event: DesktopNotificationClickedEvent) => {
        navigateToApproval(event.agentId, event.approvalId);
      });
    }

    return () => {
      unsubCreated();
      unsubClicked?.();
    };
  }, [showToast]);
}
