import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { createDefaultOnboardingState } from '../../../../shared/types/onboardingState';
import { OnboardingProvider, useOnboarding } from '../OnboardingContext';

const apiMocks = vi.hoisted(() => ({
  getOnboardingState: vi.fn(async (): Promise<{ state: unknown }> => ({
    state: {
      version: 1,
      completed: false,
      completedStepIds: [] as string[],
      interviewDraft: '',
      interviewResult: null,
      extensionDecisions: {},
      importedToolSummary: {
        generatedAt: null,
        sources: [] as string[],
        summary: '',
      },
    },
  })),
}));

const i18nMocks = vi.hoisted(() => {
  const labels: Record<string, string> = {
    'onboarding.aiSetup.title': 'Tell Interpreter how you use AI',
    'onboarding.aiSetup.description': 'This creates a reviewable working-preferences draft. You can edit or ignore it later in Settings.',
    'onboarding.aiSetup.modelsLabel': 'Which models do you use now?',
    'onboarding.aiSetup.modelsPlaceholder': 'Example: GPT-5 for coding, Claude for writing, local Ollama models for private files',
    'onboarding.aiSetup.useLabel': 'How do you use AI today?',
    'onboarding.aiSetup.usePlaceholder': 'Example: coding, research, form filling, editing long documents',
    'onboarding.aiSetup.setupLabel': 'What is your current AI setup?',
    'onboarding.aiSetup.setupPlaceholder': 'Example: ChatGPT desktop, Claude Code, Ollama running locally, API keys in my shell',
    'onboarding.aiSetup.voiceButton': 'Start voice interview',
    'onboarding.aiSetup.voiceButtonActive': 'Voice interview running',
    'onboarding.nav.continue': 'Continue',
  };

  return {
    t: (key: string) => labels[key] ?? key,
  };
});

const ipcMocks = vi.hoisted(() => {
  type CompletionEvent = {
    modelsUsed: string;
    aiUseToday: string;
    currentSetup: string;
  };
  const listeners = new Set<(event: CompletionEvent) => void>();
  return {
    startWindowVoiceMode: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
    onOnboardingVoiceInterviewCompleted: vi.fn((callback: (event: CompletionEvent) => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    }),
    emitOnboardingVoiceInterviewCompleted: (event: CompletionEvent) => {
      for (const listener of Array.from(listeners)) {
        listener(event);
      }
    },
    clearListeners: () => listeners.clear(),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: i18nMocks.t,
  }),
}));

vi.mock('../../../api', () => ({
  getOnboardingState: apiMocks.getOnboardingState,
}));

vi.mock('@/ipc', () => ({
  interpreterOverlay: {
    startWindowVoiceMode: ipcMocks.startWindowVoiceMode,
    onOnboardingVoiceInterviewCompleted: ipcMocks.onOnboardingVoiceInterviewCompleted,
  },
}));

import { AiSetupScreen } from './AiSetupScreen';

function ContinueHarness() {
  const { footerConfig } = useOnboarding();

  return (
    <button
      type="button"
      disabled={!footerConfig?.continueAction || footerConfig.continueDisabled || footerConfig.continueLoading}
      onClick={() => footerConfig?.continueAction?.()}
    >
      Continue
    </button>
  );
}

function renderAiSetupScreen(onComplete = vi.fn(async () => {})) {
  render(
    <OnboardingProvider totalSteps={20}>
      <AiSetupScreen onComplete={onComplete} />
      <ContinueHarness />
    </OnboardingProvider>,
  );

  return { onComplete };
}

describe('AiSetupScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMocks.clearListeners();
    ipcMocks.startWindowVoiceMode.mockResolvedValue({ success: true });
    apiMocks.getOnboardingState.mockResolvedValue({
      state: createDefaultOnboardingState() as unknown,
    });
  });

  test('prefills saved interview draft answers and submits through footer config', async () => {
    const savedState = createDefaultOnboardingState();
    savedState.interviewDraft = [
      'Models used now:',
      'GPT-5, Claude',
      '',
      'How I use AI today:',
      'coding and research',
      '',
      'Current AI setup:',
      'ChatGPT desktop and local Ollama',
    ].join('\n');
    apiMocks.getOnboardingState.mockResolvedValueOnce({ state: savedState as unknown });
    const { onComplete } = renderAiSetupScreen();

    const modelsField = await screen.findByLabelText('Which models do you use now?');
    await waitFor(() => {
      expect(modelsField).toHaveValue('GPT-5, Claude');
    });
    expect(screen.getByLabelText('How do you use AI today?')).toHaveValue('coding and research');
    expect(screen.getByLabelText('What is your current AI setup?')).toHaveValue('ChatGPT desktop and local Ollama');

    fireEvent.change(modelsField, {
      target: { value: 'GPT-5, Claude, Ollama' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith({
        modelsUsed: 'GPT-5, Claude, Ollama',
        aiUseToday: 'coding and research',
        currentSetup: 'ChatGPT desktop and local Ollama',
      });
    });
  });

  test('starts onboarding voice interview and fills completed answers for review', async () => {
    renderAiSetupScreen();

    fireEvent.click(screen.getByRole('button', { name: 'Start voice interview' }));

    await waitFor(() => {
      expect(ipcMocks.startWindowVoiceMode).toHaveBeenCalledWith({
        sessionKind: 'onboarding_voice_interview',
      });
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Voice interview running' })).toBeDisabled();
    });

    act(() => {
      ipcMocks.emitOnboardingVoiceInterviewCompleted({
        modelsUsed: 'GPT-5 and Claude',
        aiUseToday: 'coding and research',
        currentSetup: 'ChatGPT desktop and API keys',
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Which models do you use now?')).toHaveValue('GPT-5 and Claude');
    });
    expect(screen.getByLabelText('How do you use AI today?')).toHaveValue('coding and research');
    expect(screen.getByLabelText('What is your current AI setup?')).toHaveValue('ChatGPT desktop and API keys');
  });

  test('retries while the overlay service is still starting', async () => {
    ipcMocks.startWindowVoiceMode
      .mockResolvedValueOnce({
        success: false,
        error: 'Interpreter Overlay is not ready.',
      })
      .mockResolvedValueOnce({ success: true });
    renderAiSetupScreen();

    fireEvent.click(screen.getByRole('button', { name: 'Start voice interview' }));

    await waitFor(() => {
      expect(ipcMocks.startWindowVoiceMode).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Voice interview running' })).toBeDisabled();
    });
  });
});
