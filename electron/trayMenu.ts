import type { MenuItemConstructorOptions } from 'electron';

export interface TrayRunningAgent {
  agentId: string;
  label: string;
  latestAction: string | null;
}

export interface InterpreterTrayMenuState {
  overlayEnabled: boolean;
  accelerator: string | null;
  runningAgents: TrayRunningAgent[];
}

function compactAgentLabel(agent: TrayRunningAgent): string {
  const base = agent.latestAction ? `${agent.label} - ${agent.latestAction}` : agent.label;
  return base.length > 84 ? `${base.slice(0, 81)}...` : base;
}

export function buildInterpreterTrayMenuTemplate(options: {
  state: InterpreterTrayMenuState;
  translate: (key: string) => string;
  showMainWindow: () => void;
  showOverlay: () => void;
  revealAgent: (agentId: string) => void;
  stopAgent: (agentId: string) => void;
  quit: () => void;
}): MenuItemConstructorOptions[] {
  const menuItems: MenuItemConstructorOptions[] = [
    {
      label: options.translate('tray.show'),
      click: options.showMainWindow,
    },
  ];

  if (options.state.overlayEnabled) {
    menuItems.push({
      label: 'Show Overlay',
      accelerator: options.state.accelerator ?? undefined,
      click: options.showOverlay,
    });
  }

  if (options.state.runningAgents.length > 0) {
    menuItems.push(
      { type: 'separator' },
      {
        label: 'Running agents',
        submenu: options.state.runningAgents.map((agent) => ({
          label: compactAgentLabel(agent),
          submenu: [
            {
              label: 'Reveal',
              click: () => options.revealAgent(agent.agentId),
            },
            {
              label: 'Stop',
              click: () => options.stopAgent(agent.agentId),
            },
          ],
        })),
      },
    );
  }

  menuItems.push(
    { type: 'separator' },
    {
      label: options.translate('tray.quit'),
      click: options.quit,
    },
  );

  return menuItems;
}
