import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { OpenRouterModelCatalogResult } from '../../shared/types/provider';
import {
  HOSTED_MODEL_PICKER_REFRESH_BUTTON_ID,
  HOSTED_MODEL_PICKER_SEARCH_INPUT_ID,
} from '../../shared/element-ids';
import { HostedModelPicker } from './HostedModelPicker';
import en from '../../shared/locales/en.json';

const catalog: OpenRouterModelCatalogResult = {
  fetchedAt: Date.now(),
  stale: false,
  models: [
    {
      id: 'openai/gpt-5.4-mini',
      name: 'GPT-5.4-mini',
      provider: 'openai',
      description: 'Fast OpenAI model',
      contextLength: 400_000,
    },
    {
      id: 'anthropic/claude-opus-4.6',
      name: 'Claude Opus 4.6',
      provider: 'anthropic',
      description: 'Expensive reasoning model',
      contextLength: 200_000,
    },
    {
      id: 'ai21/jamba-1.6-large',
      name: 'Jamba 1.6 Large',
      provider: 'ai21',
      description: 'Suppressed in the default browse list',
      contextLength: 256_000,
    },
  ],
};

describe('HostedModelPicker', () => {
  test('surfaces recommended models, hides suppressed defaults, and reports selection', async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();

    render(
      <HostedModelPicker
        label="Model"
        modelId="interpreter-smart"
        catalog={catalog}
        loading={false}
        defaultExpanded
        onModelChange={onModelChange}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getAllByRole('button', { name: /GPT-5\.4-mini/i })[0]).toBeVisible();
    expect(screen.getAllByText('Expensive').length).toBeGreaterThan(0);
    expect(screen.queryByText('Jamba 1.6 Large')).not.toBeInTheDocument();

    await user.type(screen.getByTestId(HOSTED_MODEL_PICKER_SEARCH_INPUT_ID), 'ai21');

    await waitFor(() => {
      expect(screen.getByText('Jamba 1.6 Large')).toBeVisible();
    });

    await user.click(screen.getByText('Jamba 1.6 Large'));

    expect(onModelChange).toHaveBeenLastCalledWith('ai21/jamba-1.6-large', 'Jamba 1.6 Large');
  });

  test('shows an empty state when the search has no matches', async () => {
    const user = userEvent.setup();

    render(
      <HostedModelPicker
        label="Model"
        modelId="interpreter-smart"
        catalog={catalog}
        loading={false}
        defaultExpanded
        onModelChange={() => {}}
        onRefresh={() => {}}
      />,
    );

    await user.type(screen.getByTestId(HOSTED_MODEL_PICKER_SEARCH_INPUT_ID), 'does-not-exist');

    await waitFor(() => {
      expect(screen.getByText(en['settings.profiles.provider.hosted.emptyState'])).toBeVisible();
    });
  });

  test('surfaces a load error in the browse list and retries via refresh', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(
      <HostedModelPicker
        label="Model"
        modelId="interpreter-smart"
        catalog={null}
        loading={false}
        error="network down"
        defaultExpanded
        onModelChange={() => {}}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText("Couldn't load models. Refresh to retry.")).toBeVisible();

    await user.click(screen.getByTestId(HOSTED_MODEL_PICKER_REFRESH_BUTTON_ID));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
