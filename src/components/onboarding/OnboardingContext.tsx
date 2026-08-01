/**
 * OnboardingContext
 *
 * Central state management for the new Typeform-style onboarding flow.
 * Provides current step, navigation direction, detection results, and
 * user choices to all onboarding screens and components.
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

// ============================================================================
// Types
// ============================================================================

export type OnboardingBucket = 'non-developer' | 'developer' | 'developer-local-ai';

export interface DetectionResults {
  /** Primary persona bucket */
  bucket: OnboardingBucket;
  /** Sub-categories derived from detected tools (e.g. 'frontend-dev', '3d-artist') */
  subCategories: string[];
  /** Detected API key providers (e.g. 'openai-key', 'anthropic-key') */
  detectedProviders: string[];
  /** Detected tools of interest (e.g. 'ollama', 'claude-cli', 'vscode') */
  detectedTools: string[];
  /** Whether detection had high enough confidence to skip the bucket question */
  isConfident: boolean;
  /** Raw detected command names, for vision screen personalization */
  detectedCommands: string[];
  /** Raw detected config directories */
  detectedConfigDirs: string[];
  /** Raw detected macOS applications */
  detectedApps: string[];
}

export interface UserChoices {
  name: string;
  telemetryEnabled: boolean | null;
  bucket: OnboardingBucket | null;
  email: string;
}

export type NavigationDirection = 'forward' | 'backward';

export interface FooterConfig {
  step: number;
  continueLabel?: string;
  continueAction?: () => void;
  continueDisabled?: boolean;
  continueDisabledTooltip?: string;
  continueHotkeyEnabled?: boolean;
  continueLoading?: boolean;
  hideContinue?: boolean;
  continuePlacement?: 'right' | 'center';
}

export interface OnboardingContextValue {
  /** Current step index (0-based) */
  currentStep: number;
  /** Total number of steps (may vary based on skipped screens) */
  totalSteps: number;
  /** Direction of current transition (for animation) */
  direction: NavigationDirection;
  /** Results from silent environment detection */
  detectionResults: DetectionResults | null;
  /** Whether environment detection has completed */
  isDetectionComplete: boolean;
  /** User choices collected during onboarding */
  userChoices: UserChoices;
  /** Whether onboarding is complete */
  isComplete: boolean;

  /** Navigate to a specific step */
  goToStep: (step: number) => void;
  /** Go to the next step */
  goForward: () => void;
  /** Go to the previous step */
  goBack: () => void;
  /** Set detection results */
  setDetectionResults: (results: DetectionResults) => void;
  /** Update user choices (partial) */
  updateUserChoices: (choices: Partial<UserChoices>) => void;
  /** Mark onboarding as complete */
  completeOnboarding: () => void;
  /** Set the list of active step indices (to handle skippable steps) */
  setActiveSteps: (steps: number[]) => void;
  /** Footer button configuration (set by individual screens) */
  footerConfig: FooterConfig | null;
  /** Update footer button configuration */
  setFooterConfig: (config: FooterConfig | null) => void;
}

// ============================================================================
// Default values
// ============================================================================

const DEFAULT_USER_CHOICES: UserChoices = {
  name: '',
  telemetryEnabled: null,
  bucket: null,
  email: '',
};

// ============================================================================
// Context
// ============================================================================

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface OnboardingProviderProps {
  children: React.ReactNode;
  /** Total number of screens in the onboarding flow */
  totalSteps?: number;
  /** Called when onboarding completes */
  onComplete?: () => void;
}

export function OnboardingProvider({
  children,
  totalSteps: initialTotalSteps = 11,
  onComplete,
}: OnboardingProviderProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [direction, setDirection] = useState<NavigationDirection>('forward');
  const [detectionResults, setDetectionResultsState] = useState<DetectionResults | null>(null);
  const [isDetectionComplete, setIsDetectionComplete] = useState(false);
  const [userChoices, setUserChoices] = useState<UserChoices>(DEFAULT_USER_CHOICES);
  const [isComplete, setIsComplete] = useState(false);
  // Active steps: all steps by default; can be narrowed to skip screens
  const [activeSteps, setActiveStepsState] = useState<number[]>(
    () => Array.from({ length: initialTotalSteps }, (_, i) => i)
  );
  const [footerConfig, setFooterConfigState] = useState<FooterConfig | null>(null);

  const totalSteps = activeSteps.length;

  // Map from active-step index to actual step number
  const activeStepIndex = useMemo(() => {
    const idx = activeSteps.indexOf(currentStep);
    return idx >= 0 ? idx : 0;
  }, [activeSteps, currentStep]);

  const goToStep = useCallback((step: number) => {
    setDirection(step > currentStep ? 'forward' : 'backward');
    setCurrentStep(step);
    setFooterConfigState(null);
  }, [currentStep]);

  const goForward = useCallback(() => {
    const currentIdx = activeSteps.indexOf(currentStep);
    if (currentIdx === -1) {
      const nextStep = activeSteps.find(step => step > currentStep);
      if (nextStep !== undefined) {
        setDirection('forward');
        setCurrentStep(nextStep);
        setFooterConfigState(null);
      }
      return;
    }
    if (currentIdx < activeSteps.length - 1) {
      const nextStep = activeSteps[currentIdx + 1];
      setDirection('forward');
      setCurrentStep(nextStep);
      setFooterConfigState(null);
    }
  }, [activeSteps, currentStep]);

  const goBack = useCallback(() => {
    const currentIdx = activeSteps.indexOf(currentStep);
    if (currentIdx === -1) {
      const previousSteps = activeSteps.filter(step => step < currentStep);
      const prevStep = previousSteps[previousSteps.length - 1];
      if (prevStep !== undefined) {
        setDirection('backward');
        setCurrentStep(prevStep);
        setFooterConfigState(null);
      }
      return;
    }
    if (currentIdx > 0) {
      const prevStep = activeSteps[currentIdx - 1];
      setDirection('backward');
      setCurrentStep(prevStep);
      setFooterConfigState(null);
    }
  }, [activeSteps, currentStep]);

  const setDetectionResults = useCallback((results: DetectionResults) => {
    setDetectionResultsState(results);
    setIsDetectionComplete(true);
  }, []);

  const updateUserChoices = useCallback((choices: Partial<UserChoices>) => {
    setUserChoices(prev => ({
      ...prev,
      ...choices,
    }));
  }, []);

  const completeOnboarding = useCallback(() => {
    setIsComplete(true);
    onComplete?.();
  }, [onComplete]);

  const setActiveSteps = useCallback((steps: number[]) => {
    const uniqueSortedSteps = Array.from(new Set(steps)).sort((a, b) => a - b);
    if (uniqueSortedSteps.length === 0) return;

    setActiveStepsState(uniqueSortedSteps);

    if (!uniqueSortedSteps.includes(currentStep)) {
      const nextStep = uniqueSortedSteps.find(step => step > currentStep);
      const fallbackStep = uniqueSortedSteps[uniqueSortedSteps.length - 1];
      const targetStep = nextStep ?? fallbackStep;
      if (targetStep !== undefined) {
        setDirection(targetStep > currentStep ? 'forward' : 'backward');
        setCurrentStep(targetStep);
      }
    }
  }, [currentStep]);

  const setFooterConfig = useCallback((config: FooterConfig | null) => {
    setFooterConfigState((previousConfig) => {
      if (config === null) {
        return previousConfig?.step === currentStep ? null : previousConfig;
      }

      if (config.step !== currentStep) {
        return previousConfig;
      }

      return config;
    });
  }, [currentStep]);

  const value = useMemo<OnboardingContextValue>(() => ({
    currentStep,
    totalSteps,
    direction,
    detectionResults,
    isDetectionComplete,
    userChoices,
    isComplete,
    goToStep,
    goForward,
    goBack,
    setDetectionResults,
    updateUserChoices,
    completeOnboarding,
    setActiveSteps,
    footerConfig,
    setFooterConfig,
  }), [
    currentStep,
    totalSteps,
    direction,
    detectionResults,
    isDetectionComplete,
    userChoices,
    isComplete,
    goToStep,
    goForward,
    goBack,
    setDetectionResults,
    updateUserChoices,
    completeOnboarding,
    setActiveSteps,
    footerConfig,
    setFooterConfig,
  ]);

  // Expose activeStepIndex for progress bar calculation
  // We pass it through context as a derived value
  const contextWithProgress = useMemo(() => ({
    ...value,
    // Override totalSteps and currentStep to be the active-step-based values
    // so consumers (like ProgressBar) can use currentStep/totalSteps directly
    _activeStepIndex: activeStepIndex,
  }), [value, activeStepIndex]);

  return (
    <OnboardingContext.Provider value={contextWithProgress}>
      {children}
    </OnboardingContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

export function useOnboarding(): OnboardingContextValue & { _activeStepIndex: number } {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within an OnboardingProvider');
  }
  return context as OnboardingContextValue & { _activeStepIndex: number };
}
