import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { TOP_NOTICE_DISMISS_BUTTON_ID, TOP_NOTICE_ID } from '../../../../shared/element-ids';
import type { TopNotice, TopNoticeItem } from '../../../../shared/types/topNotices';

function getYouTubeEmbedUrl(videoId: string): string {
  const url = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
  url.searchParams.set('rel', '0');
  url.searchParams.set('modestbranding', '1');
  return url.toString();
}

function getPrimaryActionKey(
  item: TopNoticeItem,
  browserConnected: boolean,
  browserControlReady: boolean,
): string | null {
  if (item.requiresBrowserConnection && !browserConnected) {
    return 'topNotices.whatsNew.actions.install';
  }

  if (item.requiresBrowserConnection && !browserControlReady) {
    return 'topNotices.whatsNew.actions.openBrowserControl';
  }

  if (!item.promptKey) {
    return null;
  }

  return 'topNotices.whatsNew.actions.try';
}

export function TopNoticeCard({
  notice,
  browserConnected,
  browserControlReady,
  onTryPrompt,
  onOpenSettings,
  onDismiss,
}: {
  notice: TopNotice;
  browserConnected: boolean;
  browserControlReady: boolean;
  onTryPrompt: (prompt: string) => void;
  onOpenSettings: (section: string) => void;
  onDismiss: (noticeId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const videoId = notice.youtubeVideoId?.trim();
  const [browserAccessDialogOpen, setBrowserAccessDialogOpen] = useState(false);

  return (
    <>
      <section className="mx-auto mb-6 w-full max-w-[640px]" data-testid={TOP_NOTICE_ID(notice.id)}>
        <div
          className="overflow-hidden rounded-[8px]"
          style={{
            border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 82%, transparent)',
            background: 'color-mix(in oklch, var(--background) 95%, var(--oa-bg-subtle) 5%)',
            boxShadow: '0 18px 44px -34px rgba(0, 0, 0, 0.24)',
          }}
        >
        {videoId ? (
          <div
            className="relative aspect-video"
            style={{
              borderBottom: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 78%, transparent)',
            }}
          >
            <iframe
              className="h-full w-full"
              src={getYouTubeEmbedUrl(videoId)}
              title={t(notice.titleKey)}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        ) : null}

        <div className="relative px-4 py-4 sm:px-5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute right-3 top-3 text-muted-foreground/70 hover:text-foreground"
            onClick={() => {
              void onDismiss(notice.id);
            }}
            aria-label={t(notice.dismissLabelKey)}
            data-testid={TOP_NOTICE_DISMISS_BUTTON_ID(notice.id)}
          >
            <X className="size-3.5" />
          </Button>

          <div className="pr-8">
            <div className="text-ui-sm font-medium text-muted-foreground">
              {t(notice.labelKey)}
            </div>
            <h2 className="mt-1 text-ui-base font-semibold leading-5 text-[var(--oa-text-strong)]">
              {t(notice.titleKey)}
            </h2>
            <p className="mt-1 text-ui-sm leading-5 text-muted-foreground">
              {t(notice.subtitleKey)}
            </p>
          </div>

          <div className="mt-4 divide-y divide-black/[0.055] dark:divide-white/[0.07]">
            {notice.items.map((item) => {
              const prompt = item.promptKey ? t(item.promptKey) : null;
              const shouldOpenSettings = item.requiresBrowserConnection && !browserConnected;
              const shouldExplainBrowserAccess = item.requiresBrowserConnection
                && browserConnected
                && !browserControlReady;
              const primaryActionKey = getPrimaryActionKey(
                item,
                browserConnected,
                browserControlReady,
              );
              return (
                <div
                  key={item.id}
                  className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-start"
                  data-testid={`top-notice-item-${item.id}`}
                >
                  <div className="min-w-0">
                    <div className="text-ui-sm font-medium leading-4 text-[var(--oa-text-strong)]">
                      {t(item.titleKey)}
                    </div>
                    <p className="mt-1 text-ui-sm leading-5 text-muted-foreground">
                      {t(item.bodyKey)}
                    </p>
                  </div>
                  {primaryActionKey ? (
                    <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid={`top-notice-item-${item.id}-primary`}
                        onClick={() => {
                          if (shouldOpenSettings && item.settingsSection) {
                            onOpenSettings(item.settingsSection);
                            return;
                          }

                          if (shouldExplainBrowserAccess) {
                            setBrowserAccessDialogOpen(true);
                            return;
                          }

                          if (prompt) {
                            onTryPrompt(prompt);
                          }
                        }}
                      >
                        {t(primaryActionKey)}
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {notice.footerKey ? (
            <p className="mt-4 text-ui-xs leading-5 text-muted-foreground/55">
              {t(notice.footerKey)}
            </p>
          ) : null}
        </div>
        </div>
      </section>

      <AlertDialog open={browserAccessDialogOpen} onOpenChange={setBrowserAccessDialogOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('topNotices.whatsNew.browserAccess.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('topNotices.whatsNew.browserAccess.body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction size="sm">
              {t('topNotices.whatsNew.browserAccess.done')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
