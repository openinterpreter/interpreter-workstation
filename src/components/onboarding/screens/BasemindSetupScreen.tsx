import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Check, AlertCircle, Loader2, SkipForward } from 'lucide-react';
import { basemind } from '../../../ipc';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';
import { Button } from '../../ui/button';
import { useOnboarding } from '../OnboardingContext';

const STAGES = ['embeddings', 'reranker', 'nerModel'] as const;
type Stage = typeof STAGES[number];

interface StageConfig {
  label: string;
  description: string;
  size: string;
  model: string;
  requiresAvx2: boolean;
}

const STAGE_CONFIG: Record<Stage, StageConfig> = {
  embeddings: {
    label: 'Smart search',
    description: 'Helps the app understand what your code and documents mean, so you can search by concept instead of exact words.',
    size: '113 MB',
    model: 'bge-base-en-v1.5',
    requiresAvx2: false,
  },
  reranker: {
    label: 'Better results',
    description: 'Reorders search results by relevance, so the most useful answers appear first.',
    size: '1.1 GB',
    model: 'bge-reranker-v2-m3',
    requiresAvx2: true,
  },
  nerModel: {
    label: 'Privacy protection',
    description: 'Detects names, emails, and personal info in documents so it can be automatically redacted.',
    size: '673 MB',
    model: 'gliner_small-v2.5',
    requiresAvx2: true,
  },
};

interface StageState {
  status: 'pending' | 'downloading' | 'done' | 'error' | 'skipped';
  progress: number;
  error?: string;
  skipReason?: string;
}

const MAX_RETRIES = 2;

export interface BasemindSetupScreenProps {
  onNext: () => void;
}

export function BasemindSetupScreen({ onNext }: BasemindSetupScreenProps) {
  const { t } = useTranslation();
  const { updateUserChoices } = useOnboarding();
  const [stageStates, setStageStates] = useState<Record<Stage, StageState>>({
    embeddings: { status: 'pending', progress: 0 },
    reranker: { status: 'pending', progress: 0 },
    nerModel: { status: 'pending', progress: 0 },
  });
  const [currentStage, setCurrentStage] = useState<Stage | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSkipped, setIsSkipped] = useState(false);
  const [cpuFeatures, setCpuFeatures] = useState<{ arch: string; avx2: boolean } | null>(null);

  useEffect(() => {
    basemind.cpuFeatures().then(setCpuFeatures).catch(() => {
      setCpuFeatures({ arch: 'unknown', avx2: false });
    });
  }, []);

  const isCompatible = useCallback((stage: Stage): boolean => {
    const config = STAGE_CONFIG[stage];
    if (!config.requiresAvx2) return true;
    if (!cpuFeatures) return true;
    if (cpuFeatures.arch === 'aarch64') return true;
    if (cpuFeatures.arch === 'x86_64') return cpuFeatures.avx2;
    return true;
  }, [cpuFeatures]);

  const runDownload = useCallback(async (onlyStage: Stage | null = null) => {
    setIsDownloading(true);
    for (const stage of STAGES) {
      if (onlyStage !== null && stage !== onlyStage) continue;

      if (!isCompatible(stage)) {
        setStageStates(prev => ({
          ...prev,
          [stage]: { status: 'skipped', progress: 100, skipReason: 'CPU incompatible' },
        }));
        continue;
      }

      setCurrentStage(stage);
      setStageStates(prev => ({
        ...prev,
        [stage]: { ...prev[stage], status: 'downloading' },
      }));

      let retries = 0;
      let success = false;
      while (retries <= MAX_RETRIES && !success) {
        try {
          const result = await basemind.download();
          const stageResult = result.stages.find((s: { stage: string; success: boolean; skipped?: boolean; error?: string }) => s.stage === stage);
          if (stageResult?.skipped) {
            setStageStates(prev => ({
              ...prev,
              [stage]: { status: 'skipped', progress: 100, skipReason: stageResult.skipReason ?? 'Skipped' },
            }));
            success = true;
          } else if (stageResult?.success) {
            setStageStates(prev => ({
              ...prev,
              [stage]: { status: 'done', progress: 100 },
            }));
            success = true;
          } else {
            throw new Error(stageResult?.error ?? 'Download failed');
          }
        } catch (err) {
          retries++;
          if (retries > MAX_RETRIES) {
            setStageStates(prev => ({
              ...prev,
              [stage]: {
                status: 'error',
                progress: prev[stage].progress,
                error: err instanceof Error ? err.message : String(err),
              },
            }));
          }
        }
      }
    }
    setIsDownloading(false);
    setCurrentStage(null);
  }, [isCompatible]);

  const handleSkipIncompatible = useCallback(() => {
    setIsSkipped(true);
    runDownload();
  }, [runDownload]);

  const handleSkipAll = useCallback(() => {
    setIsSkipped(true);
    updateUserChoices({ basemindSetupComplete: true });
    onNext();
  }, [onNext, updateUserChoices]);

  const handleContinue = useCallback(() => {
    updateUserChoices({ basemindSetupComplete: true });
    onNext();
  }, [onNext, updateUserChoices]);

  const allHandled = Object.values(stageStates).every(
    s => s.status === 'done' || s.status === 'skipped' || s.status === 'error',
  );
  const hasError = Object.values(stageStates).some(s => s.status === 'error');
  const hasIncompatible = STAGES.some(s => !isCompatible(s));

  useEffect(() => {
    if (allHandled && !isSkipped) {
      updateUserChoices({ basemindSetupComplete: true });
    }
  }, [allHandled, isSkipped, updateUserChoices]);

  return (
    <OnboardingScreenShell size="form">
      <OnboardingHeading
        title={t('onboarding.basemind.title', 'Setting up your workspace')}
        description={t('onboarding.basemind.description', 'These models help your workspace understand and organize your documents. They run locally on your computer \u2014 nothing is sent to the cloud.')}
        align="left"
      />

      <div className="mt-6 space-y-3">
        {STAGES.map((stage) => {
          const state = stageStates[stage];
          const config = STAGE_CONFIG[stage];
          const compatible = isCompatible(stage);
          const isActive = currentStage === stage;

          return (
            <div
              key={stage}
              className="flex items-start gap-3 rounded-[10px] border px-4 py-3"
              style={{
                borderColor: state.status === 'done'
                  ? 'var(--oa-border)'
                  : state.status === 'error'
                    ? 'var(--destructive, #ef4444)'
                    : state.status === 'skipped'
                      ? 'color-mix(in srgb, var(--oa-border) 60%, transparent)'
                      : 'var(--oa-border)',
                background: state.status === 'done'
                  ? 'color-mix(in srgb, var(--oa-bg-app) 60%, transparent)'
                  : 'var(--oa-bg-app)',
                opacity: state.status === 'skipped' ? 0.7 : 1,
              }}
            >
              <div className="flex size-6 shrink-0 items-center justify-center mt-0.5">
                {state.status === 'done' ? (
                  <Check className="size-4 text-emerald-500" />
                ) : state.status === 'skipped' ? (
                  <SkipForward className="size-4 text-muted-foreground" />
                ) : state.status === 'error' ? (
                  <AlertCircle className="size-4 text-destructive" />
                ) : state.status === 'downloading' || isActive ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <Download className="size-4 text-muted-foreground" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-ui-sm font-medium text-foreground">{config.label}</p>
                  <span className="text-ui-xs text-muted-foreground">{config.size}</span>
                  {!compatible && state.status === 'pending' && (
                    <span className="text-ui-xs text-amber-600 dark:text-amber-400">May not work on this CPU</span>
                  )}
                </div>
                <p className="text-ui-xs text-muted-foreground mt-0.5">{config.description}</p>
                <p className="text-ui-xs text-muted-foreground/60 mt-0.5 font-mono">{config.model}</p>

                {state.status === 'downloading' && (
                  <div className="mt-2 h-1 w-full rounded-full bg-black/10 dark:bg-white/10">
                    <div
                      className="h-1 rounded-full bg-foreground/60 transition-all duration-300"
                      style={{ width: `${state.progress}%` }}
                    />
                  </div>
                )}
                {state.status === 'error' && state.error && (
                  <p className="mt-1 text-ui-xs text-destructive">{state.error}</p>
                )}
                {state.status === 'skipped' && state.skipReason && (
                  <p className="mt-1 text-ui-xs text-muted-foreground">{state.skipReason}</p>
                )}
              </div>

              {state.status === 'error' && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => runDownload(stage)}
                  className="shrink-0 mt-0.5"
                >
                  {t('basemind.download.retry')}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex items-center gap-3">
        {allHandled ? (
          <Button variant="default" onClick={handleContinue}>
            {t('onboarding.basemind.continue', 'Continue')}
          </Button>
        ) : hasError && !isDownloading ? (
          <>
            <Button variant="ghost" onClick={handleSkipAll}>
              {t('basemind.download.skip')}
            </Button>
            <Button variant="default" onClick={() => runDownload()}>
              {t('basemind.download.retry')}
            </Button>
          </>
        ) : isDownloading ? (
          <Button variant="ghost" onClick={handleSkipAll} disabled>
            {t('basemind.download.cancel', 'Cancel')}
          </Button>
        ) : (
          <>
            {hasIncompatible && (
              <Button variant="ghost" onClick={handleSkipIncompatible}>
                {t('onboarding.basemind.skipIncompatible', 'Skip incompatible')}
              </Button>
            )}
            <Button variant="default" onClick={() => runDownload()}>
              <Download className="size-4 mr-1.5" />
              {t('onboarding.basemind.startDownload', 'Download & Continue')}
            </Button>
          </>
        )}
      </div>
    </OnboardingScreenShell>
  );
}
