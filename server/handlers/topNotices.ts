import * as configStore from '../configStore';
import type { TopNotice } from '../../shared/types/topNotices';

const WHATS_NEW_NOTICE_ID = 'whats-new';
const WHATS_NEW_NOTICE_VERSION = '2026-06-22-main-window-start';
// Paste a YouTube video ID here when this release has one. The notice still
// renders written notes when no video is available.
const WHATS_NEW_YOUTUBE_VIDEO_ID = '';

const TOP_NOTICES: TopNotice[] = [
  {
    id: WHATS_NEW_NOTICE_ID,
    kind: 'release',
    version: WHATS_NEW_NOTICE_VERSION,
    labelKey: 'topNotices.whatsNew.label',
    dismissLabelKey: 'topNotices.whatsNew.dismiss',
    titleKey: 'topNotices.whatsNew.release.title',
    subtitleKey: 'topNotices.whatsNew.release.subtitle',
    footerKey: 'topNotices.whatsNew.release.footer',
    items: [
      {
        id: 'shortcut',
        titleKey: 'topNotices.whatsNew.release.shortcut.title',
        bodyKey: 'topNotices.whatsNew.release.shortcut.body',
      },
      {
        id: 'documents',
        titleKey: 'topNotices.whatsNew.release.documents.title',
        bodyKey: 'topNotices.whatsNew.release.documents.body',
      },
      {
        id: 'desktop',
        titleKey: 'topNotices.whatsNew.release.desktop.title',
        bodyKey: 'topNotices.whatsNew.release.desktop.body',
        promptKey: 'topNotices.whatsNew.release.desktop.prompt',
      },
      {
        id: 'browser',
        titleKey: 'topNotices.whatsNew.release.browser.title',
        bodyKey: 'topNotices.whatsNew.release.browser.body',
        promptKey: 'topNotices.whatsNew.release.browser.prompt',
        settingsSection: 'browser',
        requiresBrowserConnection: true,
      },
      {
        id: 'record-skill',
        titleKey: 'topNotices.whatsNew.release.recordSkill.title',
        bodyKey: 'topNotices.whatsNew.release.recordSkill.body',
        promptKey: 'topNotices.whatsNew.release.recordSkill.prompt',
      },
    ],
    youtubeVideoId: WHATS_NEW_YOUTUBE_VIDEO_ID || undefined,
  },
];

export async function listTopNotices(): Promise<{ notices: TopNotice[] }> {
  const notices = await Promise.all(
    TOP_NOTICES.map(async (notice) => {
      const dismissedVersion = await configStore.getDismissedTopNoticeVersion(notice.id);
      return dismissedVersion === notice.version ? null : notice;
    }),
  );

  return {
    notices: notices.filter((notice): notice is TopNotice => notice !== null),
  };
}

export async function dismissTopNotice(noticeId: string): Promise<{
  success: boolean;
  dismissedVersion: string;
}> {
  const notice = TOP_NOTICES.find((candidate) => candidate.id === noticeId);
  if (!notice) {
    throw new Error(`Unknown top notice: ${noticeId}`);
  }

  await configStore.setDismissedTopNoticeVersion(notice.id, notice.version);
  return {
    success: true,
    dismissedVersion: notice.version,
  };
}
