import { FeedbackPopover } from '../FeedbackPopover';
import { useLowerLeftNotice } from '../../contexts/LowerLeftNoticesContext';

interface OnboardingFeedbackToastProps {
  visible: boolean;
}

export function OnboardingFeedbackToast({ visible }: OnboardingFeedbackToastProps) {
  const content = !visible ? null : (
    <div className="w-fit max-w-full">
      <div className="inline-flex overflow-hidden rounded-[16px] border border-black/[0.06] bg-[var(--oa-surface-center)] p-2 shadow-[0_8px_30px_rgba(0,0,0,0.08)] dark:border-white/[0.08] dark:shadow-[0_10px_32px_rgba(0,0,0,0.4)]">
        <FeedbackPopover className="h-8 shrink-0 rounded-[10px] px-2.5 text-[12px]" />
      </div>
    </div>
  );

  useLowerLeftNotice('onboarding-feedback', content);

  return null;
}
