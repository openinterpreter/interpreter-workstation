import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

const ipcMocks = vi.hoisted(() => ({
  themeGet: vi.fn(async () => ({ theme: 'system' as const })),
  backgroundOpacityGet: vi.fn(async () => ({ opacity: 0 })),
  zoomFactorGet: vi.fn(async () => ({ zoomFactor: 1 })),
  zoomFactorSet: vi.fn(async () => ({ success: true })),
  primaryColorGet: vi.fn(async () => ({ color: 'gray' })),
  showSelect: vi.fn(async () => '125'),
  uiSettingGet: vi.fn(async () => ({ enabled: false })),
}));

vi.mock('@/ipc', () => ({
  theme: {
    get: ipcMocks.themeGet,
    set: vi.fn(),
    onChanged: () => () => {},
  },
  backgroundOpacity: {
    get: ipcMocks.backgroundOpacityGet,
    set: vi.fn(),
    onChanged: () => () => {},
  },
  zoomFactor: {
    get: ipcMocks.zoomFactorGet,
    set: ipcMocks.zoomFactorSet,
    onChanged: () => () => {},
  },
  primaryColor: {
    get: ipcMocks.primaryColorGet,
    set: vi.fn(),
    onChanged: () => () => {},
  },
  uiSettings: {
    getShowHelpPanelPreview: ipcMocks.uiSettingGet,
    setShowHelpPanelPreview: vi.fn(),
    onShowHelpPanelPreviewChanged: () => () => {},
  },
  showSelect: ipcMocks.showSelect,
}));

import { StyleSectionContent } from './StyleSection';

describe('StyleSectionContent', () => {
  test('loads and saves interface zoom from Style settings', async () => {
    const user = userEvent.setup();

    render(<StyleSectionContent />);

    await waitFor(() => {
      expect(screen.getByText('Interface zoom')).toBeVisible();
    });

    const zoomTrigger = screen.getByRole('button', { name: '100%' });
    await user.click(zoomTrigger);

    await waitFor(() => {
      expect(ipcMocks.showSelect).toHaveBeenCalled();
      expect(ipcMocks.zoomFactorSet).toHaveBeenCalledWith(1.25);
    });
  });
});
