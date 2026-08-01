import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChoiceButton } from '../components/ChoiceButton';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Bucket = 'non-developer' | 'developer' | 'developer-local-ai';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface BucketScreenProps {
  /** Called when the user picks a bucket. Auto-advances. */
  onNext: (bucket: Bucket) => void | Promise<void>;
}

export function BucketScreen({ onNext }: BucketScreenProps) {
  "use no memo";

  const { t } = useTranslation();
  const [selectedBucket, setSelectedBucket] = useState<Bucket | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Keyboard shortcuts: A / B / C
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isSubmitting) return;
      switch (e.key.toLowerCase()) {
        case 'a':
          handleSelect('non-developer');
          break;
        case 'b':
          handleSelect('developer');
          break;
        case 'c':
          handleSelect('developer-local-ai');
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isSubmitting],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleSelect = async (bucket: Bucket) => {
    if (isSubmitting) return;
    setSelectedBucket(bucket);
    setIsSubmitting(true);
    try {
      // Auto-advance on selection (Typeform pattern)
      await onNext(bucket);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <OnboardingScreenShell size="form">
      <div className="space-y-5">
        <OnboardingHeading title={t('onboarding.bucket.title')} />

        <div className="space-y-3">
          <ChoiceButton
            letterKey="A"
            label={t('onboarding.bucket.nonDevLabel')}
            description={t('onboarding.bucket.nonDevDescription')}
            isSelected={selectedBucket === 'non-developer'}
            onClick={() => handleSelect('non-developer')}
            disabled={isSubmitting}
          />
          <ChoiceButton
            letterKey="B"
            label={t('onboarding.bucket.devLabel')}
            description={t('onboarding.bucket.devDescription')}
            isSelected={selectedBucket === 'developer'}
            onClick={() => handleSelect('developer')}
            disabled={isSubmitting}
          />
          <ChoiceButton
            letterKey="C"
            label={t('onboarding.bucket.devLocalLabel')}
            description={t('onboarding.bucket.devLocalDescription')}
            isSelected={selectedBucket === 'developer-local-ai'}
            onClick={() => handleSelect('developer-local-ai')}
            disabled={isSubmitting}
          />
        </div>
      </div>
    </OnboardingScreenShell>
  );
}
