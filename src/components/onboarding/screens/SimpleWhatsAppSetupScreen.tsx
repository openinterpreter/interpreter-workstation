import { useCallback, useEffect, useRef, useState } from 'react';
import { getAppServerOrigin, isBrowserDevMode } from '@/ipc';
import { InboxSetupWhatsApp } from '../../InboxSetupWhatsApp';
import { OnboardingHeading, OnboardingScreenShell, OnboardingSection } from '../components/OnboardingScreenShell';
import { useOnboarding } from '../OnboardingContext';

/** Optional channel step; the first typed message creates the durable thread. */
export function SimpleWhatsAppSetupScreen({ onFinish }: { onFinish: () => Promise<boolean> }) {
  const { currentStep, setFooterConfig } = useOnboarding();
  const stepRef = useRef(currentStep);
  const [connected, setConnected] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const origin = isBrowserDevMode() ? '' : await getAppServerOrigin();
    const response = await fetch(`${origin}/api/servers/whatsapp/setup/status`, { credentials: 'include' });
    if (!response.ok) throw new Error('Could not check WhatsApp. You can continue and connect later.');
    const payload = await response.json() as { configured?: boolean; connectionState?: string };
    setConnected(payload.configured === true && (!payload.connectionState || payload.connectionState === 'connected'));
  }, []);

  useEffect(() => {
    let mounted = true;
    void refresh().catch((cause) => {
      if (mounted) setError(cause instanceof Error ? cause.message : 'Could not check WhatsApp. Connect later in Settings.');
    });
    return () => { mounted = false; };
  }, [refresh]);

  const finish = useCallback(async () => {
    if (pending) return;
    setPending(true); setError(null);
    try { await onFinish(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not finish setup. Try again.'); }
    finally { setPending(false); }
  }, [onFinish, pending]);

  useEffect(() => {
    setFooterConfig({ step: stepRef.current, continueLabel: connected ? 'Start in Simple' : 'Skip for now',
      continueAction: () => { void finish(); }, continueDisabled: pending, continueLoading: pending });
  }, [connected, finish, pending, setFooterConfig]);

  return (
    <OnboardingScreenShell size="medium" align="center" contentClassName="max-w-[560px]">
      <div className="space-y-6">
        <OnboardingHeading title="Connect WhatsApp" description="Optional. Pair your account now or do it later in Settings. After your first message creates the conversation, bind WhatsApp there so self-chat messages wake that same thread." />
        <OnboardingSection tone="muted" padding="md" className="rounded-[20px]">
          <p role="status" className="text-ui-sm text-[var(--oa-text-strong)]">
            {connected ? 'WhatsApp is connected. Bind it to your conversation in Settings after your first message.' : 'WhatsApp is not connected. You can start using Interpreter now.'}
          </p>
          {!connected && !pairing && <button type="button" onClick={() => setPairing(true)}
            className="mt-4 rounded-full border border-[var(--oa-border)] px-4 py-2 text-ui-sm font-medium">Pair WhatsApp</button>}
          {pairing && <div className="mt-4 overflow-hidden rounded-[18px] border border-[var(--oa-border)]">
            <InboxSetupWhatsApp onConnected={() => { setPairing(false); void refresh(); }} onCancel={() => setPairing(false)} />
          </div>}
          {error && <p role="alert" className="mt-3 text-ui-sm text-destructive">{error}</p>}
        </OnboardingSection>
      </div>
    </OnboardingScreenShell>
  );
}
