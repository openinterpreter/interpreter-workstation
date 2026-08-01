import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getCustomInstructions: vi.fn(async () => ({
    customInstructions: '',
    onboardingCustomInstructionsDraft: '',
  })),
  setCustomInstructions: vi.fn(async (customInstructions: string) => ({
    success: true,
    customInstructions,
  })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'common.loading': 'Loading',
        'common.save': 'Save',
        'settings.general.customInstructionsLabel': 'Custom Instructions',
        'settings.general.customInstructionsDescription': 'Saved instructions inserted into Interpreter developer instructions on every turn.',
        'settings.general.customInstructionsPlaceholder': 'Example: Keep responses concise. Prefer numbered lists.',
        'settings.general.customInstructionsDraftTitle': 'Review onboarding draft',
        'settings.general.customInstructionsDraftDescription': 'Onboarding generated these working preferences. Review them, then apply the draft if you want to save it.',
        'settings.general.customInstructionsUseDraft': 'Use draft',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('../../api', () => ({
  getCustomInstructions: apiMocks.getCustomInstructions,
  setCustomInstructions: apiMocks.setCustomInstructions,
}));

vi.mock('../../utils/telemetry', () => ({
  trackSettingChanged: vi.fn(),
}));

import { CustomInstructionsSectionContent } from './CustomInstructionsSection';

describe('CustomInstructionsSectionContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getCustomInstructions.mockResolvedValue({
      customInstructions: '',
      onboardingCustomInstructionsDraft: '',
    });
    apiMocks.setCustomInstructions.mockImplementation(async (customInstructions: string) => ({
      success: true,
      customInstructions,
    }));
  });

  test('hides the onboarding draft review when no draft exists', async () => {
    render(<CustomInstructionsSectionContent />);

    expect(await screen.findByPlaceholderText('Example: Keep responses concise. Prefer numbered lists.')).toBeInTheDocument();
    expect(screen.queryByText('Review onboarding draft')).not.toBeInTheDocument();
  });

  test('lets the user review, apply, and save the onboarding draft explicitly', async () => {
    const user = userEvent.setup();
    const draft = [
      'Onboarding summary: Uses local models for coding.',
      'Working preference: ask before broad edits',
    ].join('\n');
    apiMocks.getCustomInstructions.mockResolvedValueOnce({
      customInstructions: 'Prefer short replies.',
      onboardingCustomInstructionsDraft: draft,
    });

    render(<CustomInstructionsSectionContent />);

    expect(await screen.findByText('Review onboarding draft')).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.tagName.toLowerCase() === 'pre' && element.textContent?.trim() === draft
    )).toBeInTheDocument();

    const editor = screen.getByPlaceholderText('Example: Keep responses concise. Prefer numbered lists.');
    expect(editor).toHaveValue('Prefer short replies.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Use draft' }));

    expect(editor).toHaveValue(draft);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiMocks.setCustomInstructions).toHaveBeenCalledWith(draft);
    });
  });
});
