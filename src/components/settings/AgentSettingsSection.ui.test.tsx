import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

const ipcMocks = vi.hoisted(() => ({
  getMaxSteps: vi.fn(async () => ({ maxSteps: 1000 })),
  getMaxSubagentDepth: vi.fn(async () => ({ maxSubagentDepth: 5 })),
  getAutoContinuationLimit: vi.fn(async () => ({ autoContinuationLimit: 10 })),
  getAutoApproveLowRiskMediaCards: vi.fn(async () => ({ enabled: false })),
  setAutoApproveLowRiskMediaCards: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/ipc', () => ({
  agentSettings: {
    getMaxSteps: ipcMocks.getMaxSteps,
    getMaxSubagentDepth: ipcMocks.getMaxSubagentDepth,
    getAutoContinuationLimit: ipcMocks.getAutoContinuationLimit,
    setMaxSteps: vi.fn(),
    setMaxSubagentDepth: vi.fn(),
    setAutoContinuationLimit: vi.fn(),
  },
  uiSettings: {
    getAutoApproveLowRiskMediaCards: ipcMocks.getAutoApproveLowRiskMediaCards,
    setAutoApproveLowRiskMediaCards: ipcMocks.setAutoApproveLowRiskMediaCards,
    onAutoApproveLowRiskMediaCardsChanged: () => () => {},
  },
}));

vi.mock('../../utils/telemetry', () => ({
  trackSettingChanged: vi.fn(),
}));

import { AgentSettingsSectionContent } from './AgentSettingsSection';

describe('AgentSettingsSectionContent', () => {
  test('edits low-risk media card auto-approval through the generated settings catalog', async () => {
    const user = userEvent.setup();

    render(<AgentSettingsSectionContent />);

    expect(await screen.findByText('Auto-approve low-risk media cards')).toBeInTheDocument();
    expect(screen.getByText('Let Interpreter continue without asking for low-risk generated image previews.')).toBeInTheDocument();

    const switches = screen.getAllByRole('switch');
    const mediaCardSwitch = switches[switches.length - 1]!;
    await user.click(mediaCardSwitch);

    await waitFor(() => {
      expect(ipcMocks.setAutoApproveLowRiskMediaCards).toHaveBeenCalledWith(true);
    });
  });
});
