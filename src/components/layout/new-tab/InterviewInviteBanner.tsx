import { ArrowUpRight, Clock3, Video, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { openExternal } from '@/ipc';
import {
  INTERVIEW_INVITE_BANNER_ID,
  INTERVIEW_INVITE_DISMISS_BUTTON_ID,
  INTERVIEW_INVITE_SCHEDULE_BUTTON_ID,
} from '../../../../shared/element-ids';

export interface InterviewInviteStatus {
  currentVersion: string;
  show: boolean;
  bookingUrl: string;
}

export function InterviewInviteBanner({
  status,
  onDismiss,
}: {
  status: InterviewInviteStatus;
  onDismiss: () => void | Promise<void>;
}) {
  const { t } = useTranslation();

  if (!status.show) {
    return null;
  }

  return (
    <motion.div
      layout
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto w-full max-w-[520px]"
    >
      <motion.div
        layout
        className="oa-interactive-surface relative overflow-hidden rounded-[18px] px-4 py-4"
        style={{
          '--oa-surface-bg-current':
            'color-mix(in srgb, var(--oa-composer-surface, var(--oa-bg-input, var(--background))) 96%, var(--oa-bg-app, var(--background)) 4%)',
          '--oa-surface-shadow-current':
            '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 18px rgba(15, 23, 42, 0.04)',
        }}
        data-testid={INTERVIEW_INVITE_BANNER_ID}
      >
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-[15px] font-medium leading-5 text-[var(--oa-text-strong)]">
            {t('interviewInvite.banner.title')}
          </h2>

          <button
            type="button"
            className="oa-hover-chip mt-[-2px] flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--oa-text-muted)] transition-colors hover:text-[var(--oa-text)]"
            style={{ border: 'var(--border-width) solid transparent' }}
            onClick={() => {
              void onDismiss();
            }}
            aria-label={t('interviewInvite.banner.dismiss')}
            data-testid={INTERVIEW_INVITE_DISMISS_BUTTON_ID}
          >
            <X className="size-3.5" />
          </button>
        </div>

        <p className="mt-1.5 text-[13px] leading-5 text-[var(--oa-text-muted)]">
          {t('interviewInvite.banner.body')}
        </p>

        <div
          className="mt-3 flex flex-col gap-2.5 pt-3 sm:flex-row sm:items-center sm:justify-between"
          style={{
            borderTop: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 72%, transparent)',
          }}
        >
          <div className="flex flex-wrap items-center gap-2.5 text-[12px] text-[var(--oa-text-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-3.25" />
              {t('interviewInvite.banner.metaDuration')}
            </span>
            <span
              aria-hidden="true"
              className="size-1 rounded-full"
              style={{ background: 'color-mix(in oklch, var(--oa-text-muted) 55%, transparent)' }}
            />
            <span className="inline-flex items-center gap-1.5">
              <Video className="size-3.25" />
              {t('interviewInvite.banner.metaFormat')}
            </span>
          </div>

          <Button
            size="sm"
            className="h-8 rounded-full px-4 text-ui-sm font-medium sm:self-end"
            style={{
              backgroundColor: '#111111',
              color: '#ffffff',
              boxShadow: '0 1px 2px rgba(15, 23, 42, 0.08)',
            }}
            onClick={() => {
              void openExternal(status.bookingUrl);
            }}
            data-testid={INTERVIEW_INVITE_SCHEDULE_BUTTON_ID}
          >
            {t('interviewInvite.banner.cta')}
            <ArrowUpRight className="size-3.5" />
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
