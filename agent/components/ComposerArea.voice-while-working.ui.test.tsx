import { render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ComposerArea } from './ComposerArea';
import type { ComposerVoiceAdapter } from './composerVoiceAdapter';
import { MAIN_COMPOSER_SEND_BUTTON_ID, MAIN_COMPOSER_VOICE_BUTTON_ID } from '../../shared/element-ids';

// The composer reads its workspace, sandbox mode, speech settings and skill
// list from the bridge when it mounts. The test environment has no bridge, so
// answer those reads with inert values and keep every other export real.
// Plain functions (not vi.fn) survive the suite-wide mockReset.
vi.mock('../../src/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ipc')>()),
  workspace: {
    get: async () => ({ workspace: null }),
    onChanged: () => () => {},
  },
  nativeTools: {
    getSandboxMode: async () => ({ mode: 'workspace-write' }),
  },
  stt: {
    getSettings: async () => ({
      settings: (await import('../../shared/types/stt')).DEFAULT_STT_SETTINGS,
    }),
    onSettingsChanged: () => () => {},
  },
  skills: {
    list: async () => ({
      success: true,
      data: {
        project: { rootPath: '/workspace/.skills', skills: [] },
        global: { rootPath: '/skills', skills: [] },
      },
    }),
    onChanged: () => () => {},
  },
}));

// The editor may open bridge event streams the test environment lacks.
vi.stubGlobal('EventSource', class {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
});

vi.mock('../../src/hooks/useLayout', () => {
  const layout = { state: { tabs: {} } };
  const actions = { openFile: () => {}, openFolder: () => {}, openBrowser: () => {} };
  return { useLayout: () => layout, useLayoutActions: () => actions };
});

vi.mock('../../src/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: () => {} }),
}));

const VOICE_OVERRIDE_LABEL = 'Start live voice';
const STOP_TITLE = 'Stop';

function renderComposer({
  isStreaming,
  withOverride,
  withAdapter = false,
}: {
  isStreaming: boolean;
  withOverride: boolean;
  withAdapter?: boolean;
}) {
  return render(
    <ComposerArea
      isTerminal={false}
      agentId="agent-voice-while-working"
      messageCount={1}
      isStreaming={isStreaming}
      voiceAdapter={withAdapter ? ({} as ComposerVoiceAdapter) : undefined}
      onAgentSend={() => {}}
      showSuggestionChips={false}
      showQueuedMessages={false}
      showResizeHandle={false}
      voiceButtonOverride={withOverride ? (
        <button type="button" aria-label={VOICE_OVERRIDE_LABEL}>voice</button>
      ) : undefined}
    />,
  );
}

// Let the mount-time bridge reads resolve so their state updates land inside
// the test rather than after it.
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ComposerArea voice override while a turn runs', () => {
  test('does not offer native voice when the embedder omits the adapter', async () => {
    renderComposer({ isStreaming: false, withOverride: false });
    await settle();
    expect(screen.queryByTestId(MAIN_COMPOSER_VOICE_BUTTON_ID)).not.toBeInTheDocument();
    expect(screen.getByTestId(MAIN_COMPOSER_SEND_BUTTON_ID)).toBeDisabled();
  });

  test('retains the desktop voice affordance when its adapter is supplied', async () => {
    renderComposer({ isStreaming: false, withOverride: false, withAdapter: true });
    await settle();
    expect(screen.getByTestId(MAIN_COMPOSER_VOICE_BUTTON_ID)).toBeInTheDocument();
  });

  test('keeps the replacement voice control beside the stop control while streaming with an empty composer', async () => {
    renderComposer({ isStreaming: true, withOverride: true });

    const wrapper = await screen.findByTestId('composer-voice-while-working');
    await settle();

    const voice = screen.getByRole('button', { name: VOICE_OVERRIDE_LABEL });
    const stop = screen.getByTestId(MAIN_COMPOSER_SEND_BUTTON_ID);

    expect(voice).toBeInTheDocument();
    expect(stop).toBeInTheDocument();
    expect(stop).toHaveAttribute('data-help-title', STOP_TITLE);
    expect(stop).toBeEnabled();

    expect(wrapper).toContainElement(voice);
    expect(wrapper).toContainElement(stop);
    expect(within(wrapper).getByRole('button', { name: VOICE_OVERRIDE_LABEL })).toBe(voice);

    // The replacement takes the place of the built-in transcription control.
    expect(screen.queryByTestId(MAIN_COMPOSER_VOICE_BUTTON_ID)).not.toBeInTheDocument();
  });

  test('shows only the replacement voice control when idle with an empty composer', async () => {
    renderComposer({ isStreaming: false, withOverride: true });

    expect(await screen.findByRole('button', { name: VOICE_OVERRIDE_LABEL })).toBeInTheDocument();
    await settle();

    expect(screen.queryByTestId('composer-voice-while-working')).not.toBeInTheDocument();
    expect(screen.queryByTestId(MAIN_COMPOSER_SEND_BUTTON_ID)).not.toBeInTheDocument();
    expect(screen.queryByTestId(MAIN_COMPOSER_VOICE_BUTTON_ID)).not.toBeInTheDocument();
  });

  test('shows the stop control without the wrapper when no replacement voice control is supplied', async () => {
    renderComposer({ isStreaming: true, withOverride: false });

    const stop = await screen.findByTestId(MAIN_COMPOSER_SEND_BUTTON_ID);
    await settle();

    expect(stop).toHaveAttribute('data-help-title', STOP_TITLE);
    expect(stop).toBeEnabled();
    expect(screen.queryByTestId('composer-voice-while-working')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: VOICE_OVERRIDE_LABEL })).not.toBeInTheDocument();
  });
});
