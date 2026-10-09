import { useCallback, useEffect, useRef, useState } from 'react';
import { browserControl, openExternal } from '../../../ipc';
import { OnboardingHeading, OnboardingScreenShell, OnboardingSection } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

const CHROME_EXTENSION_INSTALL_URL = 'https://chromewebstore.google.com/detail/interpreter-chrome-extens/bboaaphdpllilofamfpommlbafpellnb';
const CHROME_STATUS_TIMEOUT_MS = 5_000;

export function SimpleBrowserSetupScreen({ onNext, discoveryReady }: { onNext: () => void; discoveryReady: boolean }) {
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const mounted = useRef(false);
  const latestRequest = useRef(0);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    setConnected(null);
    setError(false);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([
        browserControl.getStatus(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Chrome status timed out')), CHROME_STATUS_TIMEOUT_MS);
        }),
      ]);
      if (!mounted.current || request !== latestRequest.current) return;
      setConnected(status.connectedBrowsers > 0 || status.profiles.some((profile) => profile.connectionState === 'connected'));
      setError(false);
    } catch {
      if (mounted.current && request === latestRequest.current) setError(true);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = browserControl.onChanged?.(() => { void refresh(); });
    return () => {
      mounted.current = false;
      latestRequest.current++;
      unsubscribe?.();
    };
  }, [refresh]);

  useEffect(() => {
    setFooterConfig({
      step: stepRef.current,
      continueLabel: 'Continue',
      continueAction: onNext,
      continueDisabled: !discoveryReady,
    });
  }, [discoveryReady, onNext, setFooterConfig]);

  return (
    <OnboardingScreenShell size="medium" align="center" contentClassName="max-w-[520px]">
      <div className="space-y-6">
        <OnboardingHeading title="Connect Interpreter to Chrome" description="Install the Chrome extension, then connect a browser tab when you need it. Browser access is requested per task; you can skip this and set it up later." />
        <OnboardingSection tone="muted" padding="md" className="rounded-[20px]">
          <p role="status" className="text-ui-sm text-[var(--oa-text-strong)]">
            {error ? 'Could not check Chrome connection. You can try again or continue.' : connected === null ? 'Checking Chrome connection…' : connected ? 'Chrome is connected.' : 'Chrome is not connected yet.'}
          </p>
          <div className="mt-4 flex gap-3">
            <button type="button" onClick={() => void openExternal(CHROME_EXTENSION_INSTALL_URL)} className="rounded-full border border-[var(--oa-border)] px-4 py-2 text-ui-sm font-medium">Get the Chrome extension</button>
            <button type="button" onClick={() => void refresh()} className="rounded-full border border-[var(--oa-border)] px-4 py-2 text-ui-sm">Check again</button>
          </div>
        </OnboardingSection>
      </div>
    </OnboardingScreenShell>
  );
}
