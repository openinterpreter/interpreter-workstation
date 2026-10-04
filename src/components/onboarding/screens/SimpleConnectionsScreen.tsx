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
          title="Talk or message from anywhere"
          description="These are optional. GPT Live delegates spoken requests to your durable Simple conversation; WhatsApp self-chat messages use that same conversation and reply on the channel they came from."
        />
        <SimpleConnectionsSettings />
      </div>
    </OnboardingScreenShell>
  );
}
