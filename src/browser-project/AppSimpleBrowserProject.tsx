import { OnboardingOverlay } from '../components/onboarding/OnboardingOverlay';
import { SimpleBrowserProject, type SimpleBrowserProjectProps } from './SimpleBrowserProject';

const renderAppOnboarding = (onComplete: () => void) => (
  <OnboardingOverlay simpleMode onComplete={onComplete} />
);

/** The desktop app explicitly supplies its established onboarding screen. */
export function AppSimpleBrowserProject(props: SimpleBrowserProjectProps) {
  return <SimpleBrowserProject {...props} renderOnboarding={renderAppOnboarding} />;
}
