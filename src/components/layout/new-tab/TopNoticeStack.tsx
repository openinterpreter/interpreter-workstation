import type { RefObject } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { browserControl, interviewInvite as interviewInviteIpc, topNotices as topNoticesIpc } from '@/ipc';
import type { BaseTiptapComposerRef } from '../../../../agent/components/composer/BaseTiptapComposer';
import type { TopNotice } from '../../../../shared/types/topNotices';
import { useLayoutActions } from '../../../hooks/useLayout';

import { InterviewInviteBanner, type InterviewInviteStatus } from './InterviewInviteBanner';
import { TopNoticeCard } from './TopNoticeCard';

const SHOW_INTERVIEW_INVITE_BANNER = false;

export function TopNoticeStack({
  composerRef,
}: {
  composerRef?: RefObject<BaseTiptapComposerRef | null>;
}) {
  const { openSettings } = useLayoutActions();
  const [topNotices, setTopNotices] = useState<TopNotice[]>([]);
  const [interviewInviteStatus, setInterviewInviteStatus] = useState<InterviewInviteStatus | null>(null);
  const [browserConnected, setBrowserConnected] = useState(false);
  const [browserControlReady, setBrowserControlReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadTopNotices = async () => {
      try {
        const status = await topNoticesIpc.list();
        if (!cancelled) {
          setTopNotices(status.notices);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('[TopNoticeStack] Failed to load top notices:', error);
        }
      }
    };

    void loadTopNotices();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadBrowserStatus = async () => {
      try {
        const status = await browserControl.getStatus();
        if (!cancelled) {
          setBrowserConnected(status.connectedBrowsers > 0);
          setBrowserControlReady(status.activeSessions > 0);
        }
      } catch {
        if (!cancelled) {
          setBrowserConnected(false);
          setBrowserControlReady(false);
        }
      }
    };

    void loadBrowserStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadInterviewInvite = async () => {
      try {
        const status = await interviewInviteIpc.getStatus();
        if (!cancelled) {
          setInterviewInviteStatus(status);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('[TopNoticeStack] Failed to load interview invite:', error);
        }
      }
    };

    void loadInterviewInvite();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleDismissTopNotice = useCallback(async (noticeId: string) => {
    try {
      await topNoticesIpc.dismiss(noticeId);
      setTopNotices((prev) => prev.filter((notice) => notice.id !== noticeId));
    } catch (error) {
      console.error('[TopNoticeStack] Failed to dismiss top notice:', error);
    }
  }, []);

  const handleDismissInterviewInvite = useCallback(async () => {
    try {
      await interviewInviteIpc.dismissCurrent();
      setInterviewInviteStatus((prev) => (prev ? { ...prev, show: false } : prev));
    } catch (error) {
      console.error('[TopNoticeStack] Failed to dismiss interview invite:', error);
    }
  }, []);

  const handleTryPrompt = useCallback((prompt: string) => {
    composerRef?.current?.setContent(prompt);
    composerRef?.current?.focus();
  }, [composerRef]);

  const handleOpenSettings = useCallback((section: string) => {
    openSettings(undefined, section);
  }, [openSettings]);

  const showInterviewInvite = SHOW_INTERVIEW_INVITE_BANNER && Boolean(interviewInviteStatus?.show);
  const showTopNotices = topNotices.length > 0;

  if (!showInterviewInvite && !showTopNotices) {
    return null;
  }

  return (
    <div className="space-y-3">
      {showInterviewInvite && interviewInviteStatus ? (
        <InterviewInviteBanner
          status={interviewInviteStatus}
          onDismiss={handleDismissInterviewInvite}
        />
      ) : null}
      {showTopNotices
        ? topNotices.map((notice) => (
          <TopNoticeCard
            key={notice.id}
            notice={notice}
            browserConnected={browserConnected}
            browserControlReady={browserControlReady}
            onTryPrompt={handleTryPrompt}
            onOpenSettings={handleOpenSettings}
            onDismiss={handleDismissTopNotice}
          />
        ))
        : null}
    </div>
  );
}
