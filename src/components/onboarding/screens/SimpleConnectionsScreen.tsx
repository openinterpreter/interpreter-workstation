import { useEffect, useRef } from 'react';
import { SimpleConnectionsSettings } from '../../simple/SimpleConnectionsSettings';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

export function SimpleConnectionsScreen({ onNext }: { onNext: () => void }) {
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);

  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      continueLabel: 'Continue',
      continueAction: onNext,
    });
  }, [onNext, setFooterConfig]);

  return (
    <OnboardingScreenShell size="medium" align="top" className="overflow-auto py-6" contentClassName="max-w-[640px]">
      <div className="space-y-6">
        <OnboardingHeading
          title="Talk to Interpreter"
          description="GPT Live is optional. Spoken requests join the same durable Simple conversation as your typed messages; you can set it up later in Settings."
        />
        <SimpleConnectionsSettings />
      </div>
    </OnboardingScreenShell>
  );
}
