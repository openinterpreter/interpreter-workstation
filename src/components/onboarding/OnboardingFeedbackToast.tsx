import { FeedbackPopover } from '../FeedbackPopover';
import { useLowerLeftNotice } from '../../contexts/LowerLeftNoticesContext';

interface OnboardingFeedbackToastProps {
  visible: boolean;
  side?: 'left' | 'right';
  onClose?: () => void;
}

export function OnboardingFeedbackToast({ visible, side = 'left', onClose }: OnboardingFeedbackToastProps) {
  const content = !visible ? null : (
    <div className="w-fit max-w-full">
      <div className="inline-flex overflow-hidden rounded-[17px] border border-black/[0.06] bg-[var(--oa-surface-center)] p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.08)] dark:border-white/[0.08] dark:shadow-[0_10px_32px_rgba(0,0,0,0.4)]">
        <FeedbackPopover onOpenChange={(open) => { if (!open) onClose?.(); }} className="h-9 min-w-[104px] shrink-0 justify-center rounded-[12px] px-3 text-center text-[12px] leading-none" />
      </div>
    </div>
  );

  useLowerLeftNotice('onboarding-feedback', content, side);

  return null;
}
