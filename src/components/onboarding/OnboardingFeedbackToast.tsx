import { useMemo, useRef } from 'react';
import { FeedbackPopover } from '../FeedbackPopover';
import { useLowerLeftNotice } from '../../contexts/LowerLeftNoticesContext';

interface OnboardingFeedbackToastProps {
  visible: boolean;
  openRequested?: boolean;
  side?: 'left' | 'right';
  onClose?: () => void;
}

export function OnboardingFeedbackToast({ visible, openRequested = false, side = 'left', onClose }: OnboardingFeedbackToastProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const content = useMemo(() => !visible ? null : (
      <div className="w-fit max-w-full">
        <FeedbackPopover
          iconOnly
          openRequested={openRequested}
          onOpenChange={(open) => { if (!open) onCloseRef.current?.(); }}
          className="size-12 min-w-0 shrink-0 justify-center gap-0 rounded-full border border-foreground/[0.09] bg-[color-mix(in_srgb,var(--oa-composer-surface,var(--background))_82%,transparent)] p-0 text-center leading-none shadow-[0_14px_38px_rgba(0,0,0,.18)] backdrop-blur-[28px] transition-[background-color,border-color,transform] duration-150 hover:bg-[color-mix(in_srgb,var(--oa-composer-surface,var(--background))_92%,var(--foreground)_8%)] active:scale-[0.96] [&_svg]:size-4"
        />
      </div>
    ), [openRequested, visible]);

  useLowerLeftNotice('onboarding-feedback', content, side);

  return null;
}
