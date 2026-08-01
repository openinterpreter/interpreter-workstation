import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { TOP_NOTICE_DISMISS_BUTTON_ID } from '../../../../shared/element-ids';
import type { TopNotice } from '../../../../shared/types/topNotices';
import { TopNoticeCard } from './TopNoticeCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const baseNotice: TopNotice = {
  id: 'whats-new',
  kind: 'release',
  version: '2026-04-29-browser-desktop-docs-v2',
  labelKey: 'topNotices.whatsNew.label',
  dismissLabelKey: 'topNotices.whatsNew.dismiss',
  titleKey: 'topNotices.whatsNew.release.title',
  subtitleKey: 'topNotices.whatsNew.release.subtitle',
  items: [
    {
      id: 'documents',
      titleKey: 'topNotices.whatsNew.release.documents.title',
      bodyKey: 'topNotices.whatsNew.release.documents.body',
    },
  ],
};

describe('TopNoticeCard', () => {
  test('renders written release notes when no YouTube video is configured', () => {
    render(
      <TopNoticeCard
        notice={baseNotice}
        browserConnected={false}
        browserControlReady={false}
        onTryPrompt={() => {}}
        onOpenSettings={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByText('topNotices.whatsNew.release.title')).toBeVisible();
    expect(screen.getByText('topNotices.whatsNew.release.documents.title')).toBeVisible();
    expect(screen.queryByText(/topNotices\.whatsNew\.release\.documents\.prompt/)).not.toBeInTheDocument();
    expect(screen.queryByTitle('topNotices.whatsNew.release.title')).not.toBeInTheDocument();
  });

  test('embeds a YouTube video when a video id is configured', () => {
    render(
      <TopNoticeCard
        notice={{ ...baseNotice, youtubeVideoId: 'abc123' }}
        browserConnected={false}
        browserControlReady={false}
        onTryPrompt={() => {}}
        onOpenSettings={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByTitle('topNotices.whatsNew.release.title')).toHaveAttribute(
      'src',
      expect.stringContaining('youtube-nocookie.com/embed/abc123'),
    );
  });

  test('dismisses by notice id', () => {
    const onDismiss = vi.fn();
    render(
      <TopNoticeCard
        notice={baseNotice}
        browserConnected={false}
        browserControlReady={false}
        onTryPrompt={() => {}}
        onOpenSettings={() => {}}
        onDismiss={onDismiss}
      />,
    );

    screen.getByTestId(TOP_NOTICE_DISMISS_BUTTON_ID('whats-new')).click();

    expect(onDismiss).toHaveBeenCalledWith('whats-new');
  });

  test('does not show a try action for an informational item', () => {
    render(
      <TopNoticeCard
        notice={baseNotice}
        browserConnected={false}
        browserControlReady={false}
        onTryPrompt={() => {}}
        onOpenSettings={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: 'topNotices.whatsNew.actions.try' })).not.toBeInTheDocument();
  });

  test('tries the sample prompt when an item has one', () => {
    const onTryPrompt = vi.fn();
    render(
      <TopNoticeCard
        notice={{
          ...baseNotice,
          items: [
            {
              id: 'desktop',
              titleKey: 'topNotices.whatsNew.release.desktop.title',
              bodyKey: 'topNotices.whatsNew.release.desktop.body',
              promptKey: 'topNotices.whatsNew.release.desktop.prompt',
            },
          ],
        }}
        browserConnected={false}
        browserControlReady={false}
        onTryPrompt={onTryPrompt}
        onOpenSettings={() => {}}
        onDismiss={() => {}}
      />,
    );

    screen.getByRole('button', { name: 'topNotices.whatsNew.actions.try' }).click();

    expect(onTryPrompt).toHaveBeenCalledWith('topNotices.whatsNew.release.desktop.prompt');
  });

  test('opens browser settings instead of trying when browser is not connected', () => {
    const onOpenSettings = vi.fn();
    render(
      <TopNoticeCard
        notice={{
          ...baseNotice,
          items: [
            {
              id: 'browser',
              titleKey: 'topNotices.whatsNew.release.browser.title',
              bodyKey: 'topNotices.whatsNew.release.browser.body',
              promptKey: 'topNotices.whatsNew.release.browser.prompt',
              settingsSection: 'browser',
              requiresBrowserConnection: true,
            },
          ],
        }}
        browserConnected={false}
        browserControlReady={false}
        onTryPrompt={() => {}}
        onOpenSettings={onOpenSettings}
        onDismiss={() => {}}
      />,
    );

    screen.getByRole('button', { name: 'topNotices.whatsNew.actions.install' }).click();

    expect(onOpenSettings).toHaveBeenCalledWith('browser');
  });

  test('explains browser-control access when extension is connected but browser control is not ready', async () => {
    render(
      <TopNoticeCard
        notice={{
          ...baseNotice,
          items: [
            {
              id: 'browser',
              titleKey: 'topNotices.whatsNew.release.browser.title',
              bodyKey: 'topNotices.whatsNew.release.browser.body',
              promptKey: 'topNotices.whatsNew.release.browser.prompt',
              settingsSection: 'browser',
              requiresBrowserConnection: true,
            },
          ],
        }}
        browserConnected={true}
        browserControlReady={false}
        onTryPrompt={() => {}}
        onOpenSettings={() => {}}
        onDismiss={() => {}}
      />,
    );

    screen.getByRole('button', { name: 'topNotices.whatsNew.actions.openBrowserControl' }).click();

    expect(await screen.findByText('topNotices.whatsNew.browserAccess.title')).toBeVisible();
  });
});
