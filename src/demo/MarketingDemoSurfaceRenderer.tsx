import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { OnboardingProvider } from '../components/onboarding/OnboardingContext';
import { ModelPackReviewScreen } from '../components/onboarding/screens/ModelPackReviewScreen';
import type { ModelPackReviewState } from '../components/onboarding/screens/ModelSetupScreen';
import { ToolAddonsScreen } from '../components/onboarding/screens/ToolAddonsScreen';
import { WorkspaceChoiceScreen } from '../components/onboarding/screens/WorkspaceChoiceScreen';
import type { Profile } from '../../shared/types/profile';
import { getOnboardingModelPack, type OnboardingModelPack } from '../../shared/types/modelDefaults';
import type { MarketingDemoSurface } from './marketingDemo';

interface MarketingDemoSurfaceRendererProps {
  surface: MarketingDemoSurface;
}

function toOnboardingProfiles(pack: OnboardingModelPack): Profile[] {
  return pack.profiles.map((profileTemplate) => ({
    id: profileTemplate.id,
    name: profileTemplate.name,
    provider: profileTemplate.provider,
    providerId: profileTemplate.providerId,
    modelId: profileTemplate.modelId,
    baseURL: profileTemplate.baseURL,
    codexProfileId: profileTemplate.codexProfileId,
    helpDescription: profileTemplate.helpDescription,
    isBuiltin: false,
  }));
}

function DemoSurfaceShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-screen w-full overflow-y-auto bg-[var(--oa-bg-app)] text-foreground">
      {children}
    </div>
  );
}

function InterpreterManagedReviewSurface() {
  const { t } = useTranslation();
  const reviewState = useMemo<ModelPackReviewState>(() => {
    const hostedPack = getOnboardingModelPack('hosted');
    return {
      packId: 'hosted',
      title: t('onboarding.modelSetup.interpreterManagedTitle'),
      subtitle: t('onboarding.modelSetup.chooseModelsSubtitle'),
      profiles: toOnboardingProfiles(hostedPack),
      defaultProfileId: hostedPack.defaultProfileId,
      fastProfileId: 'onboarding:interpreter-fast',
      errorMessage: 'Interpreter could not be configured.',
    };
  }, [t]);

  return (
    <ModelPackReviewScreen
      reviewState={reviewState}
      onReviewComplete={() => {}}
    />
  );
}

export function MarketingDemoSurfaceRenderer({
  surface,
}: MarketingDemoSurfaceRendererProps) {
  return (
    <OnboardingProvider totalSteps={1}>
      <DemoSurfaceShell>
        {surface === 'onboarding-interpreter-managed-review' ? <InterpreterManagedReviewSurface /> : null}
        {surface === 'onboarding-tool-addons' ? (
          <ToolAddonsScreen
            onNext={() => {}}
            bucket="developer"
          />
        ) : null}
        {surface === 'onboarding-workspace-choice' ? (
          <WorkspaceChoiceScreen
            onFinish={() => {}}
            align="center"
          />
        ) : null}
      </DemoSurfaceShell>
    </OnboardingProvider>
  );
}
