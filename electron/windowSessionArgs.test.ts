import { describe, expect, it } from 'bun:test';
import type { LayoutState } from '../shared/types/layout';
import {
  buildWindowBootstrapLayoutArg,
  buildWindowSessionKeyArg,
  parseWindowBootstrapLayoutArg,
  parseWindowSessionKeyArg,
} from './windowSessionArgs';

describe('windowSessionArgs', () => {
  it('round-trips window session keys through command line arguments', () => {
    const argv = ['electron', '.', buildWindowSessionKeyArg('session-123')];
    expect(parseWindowSessionKeyArg(argv)).toBe('session-123');
  });

  it('round-trips bootstrap layout state through command line arguments', () => {
    const layout: LayoutState = {
      version: 6,
      tree: {
        kind: 'pane',
        id: 'root',
        tabIds: ['tab-1'],
        activeTabId: 'tab-1',
      },
      tabs: {
        'tab-1': {
          id: 'tab-1',
          type: 'settings',
          label: 'Settings',
        },
      },
      activePaneId: 'root',
      activeTabRegion: 'main',
      sidebarPane: null,
      sidebarWidth: 320,
      sidebarOpen: false,
      leftSidebar: {
        isOpen: false,
        width: 320,
        activeTab: 'explorer',
      },
      rightSidebar: {
        isOpen: false,
        width: 320,
      },
    };

    const arg = buildWindowBootstrapLayoutArg(layout);
    expect(arg).not.toBeNull();
    expect(parseWindowBootstrapLayoutArg(['electron', '.', arg!])).toEqual(layout);
  });

  it('returns null when no bootstrap layout argument is present', () => {
    expect(buildWindowBootstrapLayoutArg(null)).toBeNull();
    expect(parseWindowBootstrapLayoutArg(['electron', '.'])).toBeNull();
  });
});
