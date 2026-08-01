import { describe, expect, test } from 'bun:test';
import type { MenuItemConstructorOptions } from 'electron';
import { buildInterpreterTrayMenuTemplate } from './trayMenu';

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return item.submenu as MenuItemConstructorOptions[];
}

describe('buildInterpreterTrayMenuTemplate', () => {
  test('lists running agents with reveal and stop actions', () => {
    const calls: string[] = [];
    const menu = buildInterpreterTrayMenuTemplate({
      state: {
        overlayEnabled: true,
        accelerator: 'Control+Space',
        runningAgents: [{
          agentId: 'agent-1',
          label: 'Form agent',
          latestAction: 'Reading fields',
        }],
      },
      translate: (key) => key,
      showMainWindow: () => calls.push('show-main'),
      showOverlay: () => calls.push('show-overlay'),
      revealAgent: (agentId) => calls.push(`reveal:${agentId}`),
      stopAgent: (agentId) => calls.push(`stop:${agentId}`),
      quit: () => calls.push('quit'),
    });

    const runningAgentsItem = menu.find((item) => item.label === 'Running agents');
    expect(runningAgentsItem).toBeTruthy();
    const [agentItem] = submenu(runningAgentsItem!);
    expect(agentItem?.label).toBe('Form agent - Reading fields');

    const [revealItem, stopItem] = submenu(agentItem!);
    revealItem?.click?.({} as never, {} as never, {} as never);
    stopItem?.click?.({} as never, {} as never, {} as never);

    expect(calls).toEqual(['reveal:agent-1', 'stop:agent-1']);
  });

  test('omits the agent submenu when no agents are running', () => {
    const menu = buildInterpreterTrayMenuTemplate({
      state: {
        overlayEnabled: false,
        accelerator: null,
        runningAgents: [],
      },
      translate: (key) => key,
      showMainWindow: () => {},
      showOverlay: () => {},
      revealAgent: () => {},
      stopAgent: () => {},
      quit: () => {},
    });

    expect(menu.some((item) => item.label === 'Running agents')).toBe(false);
    expect(menu.some((item) => item.label === 'Show Overlay')).toBe(false);
  });
});
