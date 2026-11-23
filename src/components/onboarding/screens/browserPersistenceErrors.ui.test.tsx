import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { OnboardingProvider } from '../OnboardingContext';
import { NameScreen } from './NameScreen';
import { PrivacyScreen } from './PrivacyScreen';

test('a failed name write stays on the name screen and shows a retryable error', async () => {
  const onNext = vi.fn(async () => { throw new Error('Storage denied'); });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(<OnboardingProvider totalSteps={4}><NameScreen onNext={onNext} /></OnboardingProvider>);
    fireEvent.change(screen.getByPlaceholderText('Enter your name'), { target: { value: 'A name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your name');
    expect(screen.getByRole('button', { name: 'Start' })).not.toBeDisabled();
    expect(onNext).toHaveBeenCalledOnce();
  } finally { log.mockRestore(); }
});

test('a failed privacy write stays on the privacy screen and shows a retryable error', async () => {
  const onNext = vi.fn(async () => { throw new Error('Storage denied'); });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(<OnboardingProvider totalSteps={4}><PrivacyScreen onNext={onNext} /></OnboardingProvider>);
    fireEvent.click(screen.getByText('Keep everything private'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save your privacy choice'));
    expect(onNext).toHaveBeenCalledOnce();
  } finally { log.mockRestore(); }
});
