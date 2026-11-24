import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SimpleShell } from '../components/simple/SimpleShell';
import { getOnboardingState, getProfiles } from '../api';
import { shouldShowOnboarding } from '../lib/onboardingGate';
import { profiles, restoreBrowserProjectNativeEvents } from '../ipc';
import { activateBrowserProjectBackend, BrowserProjectHostProvider,
  createBrowserProjectHost, type BrowserProjectBackend, type BrowserProjectSession } from './host';
import type { BrowserProjectFiles } from './workspace';
import type { ComposerVoiceAdapter } from '../../agent/components/composerVoiceAdapter';

export type SimpleBrowserProjectProps = {
  backend: BrowserProjectBackend;
  projectFiles: BrowserProjectFiles;
  canvas: ReactNode;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onLeaveFeedback: () => void;
  /** An embedder owns its onboarding. Without one, open the project directly. */
  renderOnboarding?: (onComplete: () => void) => ReactNode;
  voiceAdapter?: ComposerVoiceAdapter;
};

/** A project switch must never reuse another project's agent or opening promise. */
export function SimpleBrowserProject(props: SimpleBrowserProjectProps) {
  return <BrowserProjectInstance key={props.backend.projectId} {...props} />;
}

/** The normal onboarding overlay runs before any model or agent session exists. */
function BrowserProjectInstance({ backend, projectFiles, canvas, onOpenSettings,
  onCloseSettings, onLeaveFeedback, renderOnboarding, voiceAdapter }: SimpleBrowserProjectProps) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [phase, setPhase] = useState<'checking' | 'onboarding' | 'opening' | 'ready'>('checking');
  const [session, setSession] = useState<BrowserProjectSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const onboardingRendererRef = useRef(renderOnboarding);
  onboardingRendererRef.current = renderOnboarding;
  const activationRef = useRef<number | null>(null);
  const sessionRef = useRef<BrowserProjectSession | null>(null);
  const openingRef = useRef<{ modelId: string; promise: Promise<BrowserProjectSession> } | null>(null);
  const generationRef = useRef(0);
  const teardownRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disposeSession = () => {
    const current = sessionRef.current;
    sessionRef.current = null;
    current?.dispose();
    setSession(null);
  };

  // The first render shows only a status. Register before the overlay renders
  // or any of its effects access the browser host's capability-gated IPC.
  useLayoutEffect(() => {
    activationRef.current = activateBrowserProjectBackend(backendRef.current);
  }, [backend.projectId]);
  useEffect(() => {
    if (teardownRef.current) clearTimeout(teardownRef.current);
    let mounted = true;
    if (!onboardingRendererRef.current) setPhase('opening');
    else getOnboardingState().then(({ state }) => {
      if (mounted) setPhase(shouldShowOnboarding(state) ? 'onboarding' : 'opening');
    }).catch(reason => {
      console.error('[BrowserProject] Cannot read onboarding state', reason);
      if (mounted) setPhase('onboarding');
    });
    return () => {
      mounted = false;
      const activation = activationRef.current;
      // StrictMode's effect replay is not a real unmount. Delay disposal one
      // tick so its next setup can retain the same in-flight model opening.
      teardownRef.current = setTimeout(() => {
        generationRef.current++;
        const owned = sessionRef.current;
        disposeSession();
        const pending = openingRef.current;
        openingRef.current = null;
        void pending?.promise.then(opened => { if (opened !== owned) opened.dispose(); }, () => {});
        restoreBrowserProjectNativeEvents(backend.projectId, activation ?? undefined);
      }, 0);
    };
  }, [backend.projectId]);

  useEffect(() => {
    if (phase !== 'opening') return;
    let mounted = true;
    const generation = ++generationRef.current;
    getProfiles().then(async ({ profiles, defaultProfileId }) => {
      const model = profiles.find(profile => profile.id === defaultProfileId);
      if (!model?.modelId) throw new Error(tRef.current('onboarding.browserProject.selectModel'));
      const existing = openingRef.current;
      const pending = existing?.modelId === model.modelId ? existing.promise
        : backendRef.current.openSession(model.modelId);
      openingRef.current = { modelId: model.modelId, promise: pending };
      const opened = await pending;
      if (opened.projectId !== backend.projectId || opened.model.id !== model.modelId) {
        opened.dispose();
        throw new Error('Browser session identity mismatch');
      }
      if (mounted && generation === generationRef.current) {
        sessionRef.current = opened;
        setSession(opened);
        setPhase('ready');
      }
    }).catch(reason => {
      if (mounted && generation === generationRef.current) {
        openingRef.current = null;
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase('onboarding'); }
    });
    return () => { mounted = false; };
  }, [backend.projectId, phase]);

  useEffect(() => {
    const restart = () => {
      generationRef.current++;
      const owned = sessionRef.current;
      disposeSession();
      const pending = openingRef.current;
      openingRef.current = null;
      void pending?.promise.then(opened => { if (opened !== owned) opened.dispose(); }, () => {});
      activationRef.current = activateBrowserProjectBackend(backendRef.current);
      setError(null); setPhase(onboardingRendererRef.current ? 'onboarding' : 'opening');
    };
    window.addEventListener('settings:restart-onboarding', restart);
    return () => window.removeEventListener('settings:restart-onboarding', restart);
  }, []);

  useEffect(() => {
    if (phase !== 'ready') return;
    return profiles.onDefaultChanged(() => {
      void getProfiles().then(({ profiles: choices, defaultProfileId }) => {
        const selected = choices.find(profile => profile.id === defaultProfileId);
        if (!selected?.modelId || selected.modelId === sessionRef.current?.model.id) return;
        generationRef.current++;
        disposeSession();
        openingRef.current = null;
        activationRef.current = activateBrowserProjectBackend(backendRef.current);
        setPhase('opening');
      }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
    });
  }, [phase]);

  const host = useMemo(() => session
    ? createBrowserProjectHost(session, projectFiles, backend.downloadModel) : null,
  [session, projectFiles, backend.downloadModel]);

  if (phase === 'checking' || phase === 'opening') return <p role="status"
    className="p-6 text-ui-sm text-[var(--oa-text-muted)]">{t('onboarding.browserProject.opening')}</p>;
  if (phase === 'onboarding') return <div className="relative h-full">
    {renderOnboarding?.(() => { setError(null); setPhase('opening'); })}
    {error && <p role="alert" className="absolute bottom-6 left-1/2 z-[100] max-w-lg -translate-x-1/2 rounded-lg border border-[var(--oa-border)] bg-[var(--oa-bg-app)] p-3 text-[var(--oa-text-primary)] shadow-lg">{error}</p>}
  </div>;
  if (!host || !session) return <p role="alert" className="p-6 text-ui-sm text-[var(--oa-text-muted)]">
    {t('onboarding.browserProject.unavailable')}</p>;
  return <BrowserProjectHostProvider host={host} restoreOnUnmount={false}>
    <SimpleShell voiceAdapter={voiceAdapter} workspacePath={host.workspacePath} initialThreadId={session.threadId}
      onBindThread={threadId => {
        if (threadId !== session.threadId) throw new Error('Browser thread binding mismatch');
      }} settingsOpen={false} onOpenSettings={onOpenSettings}
      onCloseSettings={onCloseSettings} feedbackVisible={false}
      onFeedbackVisibilityChange={async () => { throw new Error('Browser feedback capability unavailable'); }}
      onLeaveFeedback={onLeaveFeedback} canvas={canvas} />
  </BrowserProjectHostProvider>;
}
