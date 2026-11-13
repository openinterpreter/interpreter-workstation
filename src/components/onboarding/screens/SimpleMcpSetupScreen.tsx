import { useEffect, useRef } from 'react';
import type { SimpleMcpSummary } from '../simpleSetupDiscovery';
import { OnboardingHeading, OnboardingScreenShell, OnboardingSection } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

export function SimpleMcpSetupScreen({ summary, onNext }: { summary: SimpleMcpSummary; onNext: () => void }) {
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  useEffect(() => {
    setFooterConfig({ step: stepRef.current, continueLabel: 'Continue', continueAction: onNext });
  }, [onNext, setFooterConfig]);

  return (
    <OnboardingScreenShell size="medium" align="center" contentClassName="max-w-[520px]">
      <div className="space-y-6">
        <OnboardingHeading title="Your existing connections" description="Interpreter found MCP connections on this computer. Configured connections are available; you can manage or import detected connections later in Settings." />
        <OnboardingSection tone="muted" padding="md" className="rounded-[20px] space-y-3">
          {summary.configured.length > 0 ? <p className="text-ui-sm">Configured: {summary.configured.join(', ')}</p> : null}
          {summary.discovered.length > 0 ? <p className="text-ui-sm">Detected: {summary.discovered.join(', ')}</p> : null}
        </OnboardingSection>
      </div>
    </OnboardingScreenShell>
  );
}
