import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import {
  API_BASE_URL_PICKER_EDIT_INPUT_ID,
  API_BASE_URL_PICKER_OPTION_ITEM_ID,
  API_BASE_URL_PICKER_POPOVER_ID,
  API_BASE_URL_PICKER_TRIGGER_ID,
} from '../../shared/element-ids';
import { ResponsesApiBaseUrlPicker } from './ResponsesApiBaseUrlPicker';

function Harness({
  onChange,
  selectedBaseURLId,
  onSelectedBaseURLIdChange,
}: {
  onChange: (value: string) => void;
  selectedBaseURLId?: string;
  onSelectedBaseURLIdChange?: (value: string) => void;
}) {
  const [baseURL, setBaseURL] = useState('https://api.openai.com/v1');

  return (
    <ResponsesApiBaseUrlPicker
      label="Base URL"
      baseURL={baseURL}
      selectedBaseURLId={selectedBaseURLId}
      onBaseURLChange={(nextValue) => {
        onChange(nextValue);
        setBaseURL(nextValue);
      }}
      onSelectedBaseURLIdChange={onSelectedBaseURLIdChange}
    />
  );
}

describe('ResponsesApiBaseUrlPicker', () => {
  test('allows direct base URL edits', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Harness onChange={onChange} />);

    const input = screen.getByTestId(API_BASE_URL_PICKER_EDIT_INPUT_ID);
    await user.clear(input);
    await user.type(input, 'https://llm.example.internal/v1');

    await waitFor(() => {
      expect(screen.getByTestId(API_BASE_URL_PICKER_EDIT_INPUT_ID)).toHaveValue('https://llm.example.internal/v1');
    });

    expect(onChange).toHaveBeenLastCalledWith('https://llm.example.internal/v1');
  });

  test('can keep a known base URL selected as a custom endpoint', async () => {
    const onChange = vi.fn();
    const onSelectedBaseURLIdChange = vi.fn();

    render(
      <Harness
        onChange={onChange}
        selectedBaseURLId="custom"
        onSelectedBaseURLIdChange={onSelectedBaseURLIdChange}
      />,
    );

    expect(screen.getByTestId(API_BASE_URL_PICKER_TRIGGER_ID)).toHaveTextContent('Custom endpoint');
    expect(screen.getByTestId(API_BASE_URL_PICKER_EDIT_INPUT_ID)).toHaveValue('https://api.openai.com/v1');
  });

  test('applies a preset base URL from the provider list', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onSelectedBaseURLIdChange = vi.fn();

    render(<Harness onChange={onChange} onSelectedBaseURLIdChange={onSelectedBaseURLIdChange} />);

    await user.click(screen.getByTestId(API_BASE_URL_PICKER_TRIGGER_ID));
    await screen.findByTestId(API_BASE_URL_PICKER_POPOVER_ID);

    const groqOption = document.querySelector(
      `[data-testid="${API_BASE_URL_PICKER_OPTION_ITEM_ID}"][data-base-url-id="groq"]`,
    );

    expect(groqOption).not.toBeNull();
    await user.click(groqOption as HTMLElement);

    await waitFor(() => {
      expect(screen.getByTestId(API_BASE_URL_PICKER_EDIT_INPUT_ID)).toHaveValue('https://api.groq.com/openai/v1');
    });

    expect(onChange).toHaveBeenLastCalledWith('https://api.groq.com/openai/v1');
    expect(onSelectedBaseURLIdChange).toHaveBeenLastCalledWith('groq');
  });
});
