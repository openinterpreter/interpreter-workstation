import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildComputerUseInteractiveElementsSummaryForTest,
  callComputerUseToolForTest,
  classifyCuaDriverServeStartupOutputForTest,
  clearComputerUseTargetCacheForTest,
  computerUseToolContractForTest,
  enrichListWindowsResponseWithTargetIdentityForTest,
  filterProtectedDesktopTargetsFromTextForTest,
  formatComputerUseTreeMarkdownForModelForTest,
  isProtectedDesktopAutomationTarget,
  macAgentActivityForTool,
  macCuaDriverActivityExecOptionsForTest,
  macComputerUseScreenshotPathForTest,
  macComputerUseTreeHasWindowContentForTest,
  macToolMayRequireForegroundFocusForTest,
  parseComputerUseUiElementsForTest,
  resolveMacSelectOptionFromElementsForTest,
  requireWindowTargetIdentityForBoundsForTest,
  requestApprovalForTest,
  setBrowserAccessPolicyProviderForCuaDriverTest,
  setBrowserControlStatusProviderForCuaDriverTest,
  setCuaAccessPolicyProviderForCuaDriverTest,
  setWindowsCuaDriverToolProviderForTest,
  shutdownCuaDriverProcesses,
  withMacCuaDriverProcessLockForTest,
} from './tools';
import type { BrowserControlStatus } from '../../../../shared/types/browserControl';
import type { BrowserAccessPolicy, BrowserAccessPolicyMode, BrowserAccessProfilePolicy } from '../../../../shared/browserAccessPolicy';
import { approvalManager } from '../../../approvalManager';

function windowsToolResponse(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: true, data }),
    }],
  };
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', {
    value: platform,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
  }
}

function emptyBrowserControlStatus(): BrowserControlStatus {
  return {
    relay: {
      phase: 'idle',
      version: null,
      runtimeDir: null,
      relayLogPath: null,
      relayCdpLogPath: null,
      ownsRelayProcess: false,
      lastError: null,
      reachable: false,
      endpoint: 'http://127.0.0.1:19988',
    },
    connections: [],
    profiles: [],
    connectedBrowsers: 0,
    activeSessions: 0,
  };
}

function browserReadPolicy(
  readMode: BrowserAccessPolicyMode,
  profilePolicies: BrowserAccessProfilePolicy[] = [],
): BrowserAccessPolicy {
  return {
    permissions: {
      read: { mode: readMode, allowedPatterns: [] },
      write: { mode: 'ask', allowedPatterns: [] },
      action: { mode: 'ask', allowedPatterns: [] },
    },
    profilePolicies,
  };
}

function chromeBrowserControlStatus(
  tabs: Array<{ profileId: string; url: string; title: string }>,
): BrowserControlStatus {
  const empty = emptyBrowserControlStatus();
  return {
    ...empty,
    relay: { ...empty.relay, phase: 'ready', reachable: true },
    connections: tabs.map((tab, index) => ({
      extensionId: `extension-${index}`,
      stableKey: tab.profileId,
      profileId: tab.profileId,
      browserName: 'Chrome',
      version: '1.2.3',
      activeSessions: 1,
      focusedWindowId: 700 + index,
      activeTabRef: `${tab.profileId}:chrome-tab:${index}`,
      focusedWindow: null,
      activeTab: null,
      targets: [],
      browserWindows: [{
        windowId: 700 + index,
        focused: index === 0,
        type: 'normal',
        state: 'normal',
        tabs: [{
          tabRef: `${tab.profileId}:chrome-tab:${index}`,
          chromeTabId: 90 + index,
          windowId: 700 + index,
          index: 0,
          active: true,
          highlighted: true,
          pinned: false,
          title: tab.title,
          url: tab.url,
          status: 'complete',
          controlState: 'observable',
        }],
      }],
    })),
    profiles: [],
    connectedBrowsers: tabs.length,
    activeSessions: tabs.length,
  };
}

describe('Computer Use tool contract', () => {
  test('exposes the MCP-shaped app-scoped tool surface', () => {
    const contract = computerUseToolContractForTest();
    expect(contract.map((tool) => tool.name)).toEqual([
      'list_apps',
      'list_windows',
      'launch_app',
      'get_app_state',
      'get_ui_elements',
      'click',
      'drag',
      'press_key',
      'scroll',
      'select_option',
      'set_value',
      'close_window',
      'focus_window',
      'maximize_window',
      'minimize_window',
      'restore_window',
      'set_window_bounds',
      'type_text',
      'perform_secondary_action',
    ]);
    expect(contract.map((tool) => tool.description)).toEqual([
      'List the apps on this computer. Returns the set of apps that are currently running, as well as any that have been used in the last 14 days, including details on usage frequency.',
      'List top-level app windows with normalized target_identity objects, titles, and bounds.',
      'Launch an app so it can be targeted by Computer Use.',
      "Start an app use session if needed, then get the state of the app's key window and return a screenshot and accessibility tree. This must be called once per assistant turn before interacting with the app.",
      'Get snapshot-scoped UI element refs and observed screen-point bounding boxes for an app, optionally filtered to a region.',
      'Click an element by index or pixel coordinates from screenshot.',
      'Drag from one point to another using pixel coordinates.',
      'Press a key or key-combination on the keyboard, including modifier and navigation keys.',
      'Scroll an element in a direction by a number of pages.',
      'Select an option in a dropdown, pop-up button, combo box, or select-like control.',
      'Set the value of a settable accessibility element.',
      'Request-close a top-level app window selected by target_identity from list_windows.',
      'Reveal and focus a top-level app window selected by target_identity from list_windows.',
      'Zoom or maximize a top-level app window selected by target_identity from list_windows.',
      'Minimize a top-level app window selected by target_identity from list_windows.',
      'Restore a minimized top-level app window selected by target_identity from list_windows.',
      'Move and resize a top-level app window selected by target_identity from list_windows.',
      'Type literal text using keyboard input.',
      'Invoke a secondary accessibility action exposed by an element.',
    ]);
  });

  test('keeps app-scoped schemas rather than raw backend target schemas', () => {
    const contract = new Map(computerUseToolContractForTest().map((tool) => [tool.name, tool.inputSchema]));
    expect(contract.get('list_windows')?.required).toBeUndefined();
    expect(contract.get('get_app_state')?.required).toEqual(['app']);
    expect(contract.get('get_ui_elements')?.required).toEqual(['app']);
    expect(contract.get('click')?.required).toEqual(['app']);
    expect((contract.get('click')?.properties as Record<string, unknown>).target_identity).toEqual({ type: 'object' });
    expect(contract.get('scroll')?.required).toEqual(['app', 'direction']);
    expect((contract.get('scroll')?.properties as Record<string, unknown>).target_identity).toEqual({ type: 'object' });
    expect((contract.get('scroll')?.properties as Record<string, unknown>).pages).toEqual({
      type: 'number',
      minimum: 1,
      maximum: 5,
    });
    expect(contract.get('select_option')?.required).toEqual(['app', 'element_index', 'option']);
    expect((contract.get('select_option')?.properties as Record<string, unknown>).target_identity).toEqual({ type: 'object' });
    expect(contract.get('set_value')?.required).toEqual(['app', 'element_index', 'value']);
    expect((contract.get('set_value')?.properties as Record<string, unknown>).target_identity).toEqual({ type: 'object' });
    expect((contract.get('type_text')?.properties as Record<string, unknown>).element_index).toEqual({ type: 'string' });
    expect((contract.get('type_text')?.properties as Record<string, unknown>).target_identity).toEqual({ type: 'object' });
    expect(contract.get('focus_window')?.required).toEqual(['target_identity']);
    expect((contract.get('focus_window')?.properties as Record<string, unknown>).target_identity).toMatchObject({
      type: 'object',
      description: 'The target_identity object returned by list_windows for the window to focus.',
    });
    expect(contract.get('minimize_window')?.required).toEqual(['target_identity']);
    expect((contract.get('minimize_window')?.properties as Record<string, unknown>).target_identity).toMatchObject({
      type: 'object',
      description: 'The target_identity object returned by list_windows for the window to minimize.',
    });
    expect(contract.get('restore_window')?.required).toEqual(['target_identity']);
    expect((contract.get('restore_window')?.properties as Record<string, unknown>).target_identity).toMatchObject({
      type: 'object',
      description: 'The target_identity object returned by list_windows for the window to restore.',
    });
    expect(contract.get('maximize_window')?.required).toEqual(['target_identity']);
    expect((contract.get('maximize_window')?.properties as Record<string, unknown>).target_identity).toMatchObject({
      type: 'object',
      description: 'The target_identity object returned by list_windows for the window to maximize.',
    });
    expect(contract.get('close_window')?.required).toEqual(['target_identity']);
    expect((contract.get('close_window')?.properties as Record<string, unknown>).target_identity).toMatchObject({
      type: 'object',
      description: 'The target_identity object returned by list_windows for the window to close.',
    });
    expect(contract.get('set_window_bounds')?.required).toEqual(['target_identity', 'x', 'y', 'width', 'height']);
    expect((contract.get('set_window_bounds')?.properties as Record<string, unknown>).target_identity).toMatchObject({
      type: 'object',
      description: 'The target_identity object returned by list_windows for the window to move.',
    });
    expect(contract.has('get_window_state')).toBe(false);
  });

  test('adds normalized target identity to list_windows output', async () => {
    setBrowserControlStatusProviderForCuaDriverTest(async () => emptyBrowserControlStatus());
    const response = await enrichListWindowsResponseWithTargetIdentityForTest({
      content: [{
        type: 'text',
        text: JSON.stringify([{
          owner: 'TextEdit',
          name: 'Notes',
          pid: 1234,
          window_id: 55,
          bounds: { x: 10, y: 20, width: 800, height: 600 },
        }]),
      }],
    }, 'darwin', 5000);
    setBrowserControlStatusProviderForCuaDriverTest(null);

    const windows = JSON.parse(response.content?.[0]?.text ?? '[]');
    expect(windows[0].target_identity).toEqual({
      kind: 'app-window',
      platform: 'darwin',
      coordinate_space: 'screen-dip',
      observed_at: 5000,
      app: {
        name: 'TextEdit',
        pid: 1234,
      },
      window: {
        native_window_id: 55,
        title: 'Notes',
      },
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      ref_invalidation: {
        rules: [
          'target_identity_mismatch',
          'pid_mismatch',
          'native_window_id_mismatch',
          'window_closed',
        ],
      },
    });
  });

  test('includes browser-control tab state on browser app windows', async () => {
    setBrowserAccessPolicyProviderForCuaDriverTest(async () => browserReadPolicy('ask'));
    setBrowserControlStatusProviderForCuaDriverTest(async () => ({
      ...emptyBrowserControlStatus(),
      relay: {
        ...emptyBrowserControlStatus().relay,
        phase: 'ready',
        reachable: true,
      },
      connections: [{
        extensionId: 'extension-1',
        stableKey: 'install:work',
        profileId: 'install:work',
        browserName: 'Chrome',
        version: '1.2.3',
        activeSessions: 1,
        focusedWindowId: 701,
        activeTabRef: 'install:work:chrome-tab:91',
        focusedWindow: null,
        activeTab: null,
        targets: [],
        browserWindows: [{
          windowId: 701,
          focused: true,
          type: 'normal',
          state: 'normal',
          tabs: [{
            tabRef: 'install:work:chrome-tab:91',
            chromeTabId: 91,
            windowId: 701,
            index: 0,
            active: true,
            highlighted: true,
            pinned: false,
            title: 'Docs',
            url: 'https://docs.example.test/',
            status: 'complete',
            controlState: 'observable',
            controlStateDetail: 'connecting',
          }],
        }],
      }],
      profiles: [{
        profileId: 'local:work',
        policyProfileId: 'install:work',
        browserName: 'Chrome',
        browserChannel: 'stable',
        profileName: 'Work',
        profilePath: '/Users/test/Library/Application Support/Google/Chrome/Profile 1',
        userDataDir: '/Users/test/Library/Application Support/Google/Chrome',
        extensionId: 'extension-1',
        stableKey: 'install:work',
        connectionState: 'connected',
        activeSessions: 1,
        windowCount: 1,
        tabCount: 1,
      }],
      connectedBrowsers: 1,
      activeSessions: 1,
    }));

    const response = await enrichListWindowsResponseWithTargetIdentityForTest({
      content: [{
        type: 'text',
        text: JSON.stringify([{
          owner: 'Google Chrome',
          name: 'Docs',
          pid: 1234,
          window_id: 55,
          bounds: { x: 10, y: 20, width: 800, height: 600 },
        }]),
      }],
    }, 'darwin', 5000);
    setBrowserControlStatusProviderForCuaDriverTest(null);
    setBrowserAccessPolicyProviderForCuaDriverTest(null);

    const windows = JSON.parse(response.content?.[0]?.text ?? '[]');
    expect(windows[0].browser_control).toEqual({
      source: 'interpreter-browser-control',
      correlation: 'browser_app_window',
      windows: [{
        browser_profile_id: 'install:work',
        browser_profile_policy_id: 'install:work',
        browser_profile_name: 'Work',
        browser_profile_path: '/Users/test/Library/Application Support/Google/Chrome/Profile 1',
        extension_stable_key: 'install:work',
        browser_name: 'Chrome',
        browser_window_id: 701,
        focused: true,
        state: 'normal',
        type: 'normal',
        active_tab_ref: 'install:work:chrome-tab:91',
        tabs: [{
          tab_ref: 'install:work:chrome-tab:91',
          chrome_tab_id: 91,
          index: 0,
          active: true,
          highlighted: true,
          pinned: false,
          title: 'Docs',
          url: 'https://docs.example.test/',
          status: 'complete',
          control_state: 'observable',
          control_state_detail: 'connecting',
          target_id: null,
        }],
      }],
    });
  });

  test('extracts native window ids from normalized target identity for bounds changes', () => {
    expect(requireWindowTargetIdentityForBoundsForTest({
      target_identity: {
        kind: 'app-window',
        app: { pid: 1234 },
        window: { native_window_id: 55 },
      },
    })).toEqual({ pid: 1234, windowId: 55 });

    expect(requireWindowTargetIdentityForBoundsForTest({
      target_identity: {
        kind: 'app-window',
        app: { pid: 1234 },
        window: { native_window_id: 'hwnd-1' },
      },
    })).toEqual({ pid: 1234, windowId: 'hwnd-1' });

    expect(() => requireWindowTargetIdentityForBoundsForTest({
      pid: 1234,
      window_id: 55,
    })).toThrow('Missing required object field target_identity.');
  });
});

describe('macAgentActivityForTool', () => {
  test('describes typed text and exact values as typing activity', () => {
    expect(macAgentActivityForTool('type_text', { text: 'hello' })).toEqual({
      kind: 'typing',
      text: 'hello',
    });
    expect(macAgentActivityForTool('set_value', { value: 'Ada Lovelace' })).toEqual({
      kind: 'typing',
      text: 'Ada Lovelace',
    });
  });

  test('describes keys and hotkeys separately', () => {
    expect(macAgentActivityForTool('press_key', { key: 'Return' })).toEqual({
      kind: 'key',
      text: 'Return',
    });
    expect(macAgentActivityForTool('hotkey', { keys: ['cmd', 's'] })).toEqual({
      kind: 'hotkey',
      text: 'cmd+s',
    });
  });

  test('bounds activity target lookups so visual feedback cannot block tool execution', () => {
    expect(macCuaDriverActivityExecOptionsForTest()).toEqual({
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5_000,
    });
  });
});

describe('macOS Computer Use wrapper behavior', () => {
  test('rejects concurrent driver calls instead of queuing stale desktop actions', async () => {
    const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-driver-lock-test-'));
    const lockDir = path.join(lockRoot, 'driver.lock');
    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withMacCuaDriverProcessLockForTest(lockDir, async () => {
      events.push('first-start');
      releaseFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 40));
      events.push('first-end');
    });
    await firstEntered;
    await expect(withMacCuaDriverProcessLockForTest(lockDir, async () => {
      events.push('second-start');
      events.push('second-end');
    })).rejects.toThrow('Another Computer Use action is already in progress.');
    await first;

    expect(events).toEqual([
      'first-start',
      'first-end',
    ]);
    fs.rmSync(lockRoot, { recursive: true, force: true });
  });

  test('clears stale process locks when the owner pid is gone', async () => {
    const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-driver-stale-lock-test-'));
    const lockDir = path.join(lockRoot, 'driver.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), JSON.stringify({ pid: 999_999_999 }));
    const events: string[] = [];

    await withMacCuaDriverProcessLockForTest(lockDir, async () => {
      events.push('acquired');
    });

    expect(events).toEqual(['acquired']);
    expect(fs.existsSync(lockDir)).toBe(false);
    fs.rmSync(lockRoot, { recursive: true, force: true });
  });

  test('summarizes actionable indexed controls before the full accessibility tree', () => {
    const summary = buildComputerUseInteractiveElementsSummaryForTest([
      'application Chromium',
      '\t0 menu bar',
      '\t1 button Browser toolbar',
      '\t42 HTML content Insurance form',
      '\t\t41 static text Policy Information',
      '\t\t43 text field Policy Number AXValue=""',
      '\t\t44 pop up button Coverage Type AXValue="Select"',
      '\t\t45 check box I agree AXValue=0',
      '\t\t46 button Submit',
      '\t\t47 group Decorative wrapper',
      '\t\t- [48] AXTextField [value="Ada"] bounds={x=120, y=240, width=280, height=32, coordinate_space=screen_points} [actions=[set_value]]',
    ].join('\n'));

    expect(summary).toEqual([
      '41 static text Policy Information',
      '43 text field Policy Number AXValue=""',
      '44 pop up button Coverage Type AXValue="Select"',
      '45 check box I agree AXValue=0',
      '46 button Submit',
      '- [48] AXTextField [value="Ada"] bounds={x=120, y=240, width=280, height=32, coordinate_space=screen_points} [actions=[set_value]]',
      '1 button Browser toolbar',
    ]);
  });

  test('keeps nearby raw text with controls when labels and fields are split across tree lines', () => {
    const summary = buildComputerUseInteractiveElementsSummaryForTest([
      'application Chromium',
      '\t0 menu bar',
      '\t42 HTML content Insurance form',
      '\t\t43 static text Policy Number',
      '\t\t44 text field AXValue=""',
      '\t\t45 static text Endorsement Type',
      '\t\t46 pop up button AXValue="Select"',
      '\t\t47 static text Required Documents',
      '\t\t48 check box Broker letter AXValue=0',
    ].join('\n'));

    expect(summary).toEqual([
      '43 static text Policy Number',
      '44 text field AXValue=""',
      '45 static text Endorsement Type',
      '46 pop up button AXValue="Select"',
      '47 static text Required Documents',
      '48 check box Broker letter AXValue=0',
    ]);
  });

  test('extracts bounded UI refs and filters them by screen-point region', () => {
    const markdown = [
      'application Chromium',
      '\t- [2] AXCheckBox "Broker letter" bounds={x=100, y=120, width=180, height=22, coordinate_space=screen_points} [actions=[AXPress]]',
      '\t- [3] AXTextField bounds={x=120, y=150, width=300, height=32, coordinate_space=screen_points} [actions=[set_value]]',
      '\t- [4] AXButton "Submit" bounds={x=520, y=650, width=92, height=36, coordinate_space=screen_points} [actions=[AXPress]]',
      '\t- [5] AXButton "No bounds" [actions=[AXPress]]',
    ].join('\n');

    expect(parseComputerUseUiElementsForTest(markdown, null)).toEqual([
      {
        elementIndex: 2,
        role: 'AXCheckBox',
        bounds: { x: 100, y: 120, width: 180, height: 22 },
        rawLine: '- [2] AXCheckBox "Broker letter" bounds={x=100, y=120, width=180, height=22, coordinate_space=screen_points} [actions=[AXPress]]',
      },
      {
        elementIndex: 3,
        role: 'AXTextField',
        bounds: { x: 120, y: 150, width: 300, height: 32 },
        rawLine: '- [3] AXTextField bounds={x=120, y=150, width=300, height=32, coordinate_space=screen_points} [actions=[set_value]]',
      },
      {
        elementIndex: 4,
        role: 'AXButton',
        bounds: { x: 520, y: 650, width: 92, height: 36 },
        rawLine: '- [4] AXButton "Submit" bounds={x=520, y=650, width=92, height=36, coordinate_space=screen_points} [actions=[AXPress]]',
      },
    ]);

    expect(parseComputerUseUiElementsForTest(markdown, {
      x: 110,
      y: 140,
      width: 330,
      height: 80,
    }).map((element) => element.elementIndex)).toEqual([2, 3]);
  });

  test('bounds the duplicated full accessibility tree in app-state output', () => {
    const longTree = `${'0 application Chromium\n'}${'x'.repeat(13_000)}`;
    const formatted = formatComputerUseTreeMarkdownForModelForTest(longTree);

    expect(formatted?.length).toBeLessThan(longTree.length);
    expect(formatted).toContain('0 application Chromium');
    expect(formatted).toContain('accessibility tree truncated after 12000 chars');
    expect(formatted).toContain('use <interactive_elements> above');
  });

  test('resolves spoken option text to the exact visible popup option', () => {
    // Observed shape from a live Chromium select popup: the materialized
    // options are AXMenuItem descendants of the popup element.
    const elements = [
      { element_index: 50, role: 'AXPopUpButton', label: 'Line of Business' },
      { element_index: 51, parent_index: 50, role: 'AXMenu' },
      { element_index: 52, parent_index: 51, role: 'AXMenuItem', label: 'Select' },
      { element_index: 53, parent_index: 51, role: 'AXMenuItem', label: 'Business owners policy' },
      { element_index: 54, parent_index: 51, role: 'AXMenuItem', label: 'General liability' },
      // Menu-bar items are AXMenuItems too but not popup descendants.
      { element_index: 200, role: 'AXMenuItem', label: 'About Chromium' },
    ];

    expect(resolveMacSelectOptionFromElementsForTest(elements, 50, 'Businessowners Policy')).toEqual({
      optionText: 'Business owners policy',
      options: ['Select', 'Business owners policy', 'General liability'],
    });
    expect(resolveMacSelectOptionFromElementsForTest(elements, 50, 'business owners policy').optionText)
      .toBe('Business owners policy');
    expect(resolveMacSelectOptionFromElementsForTest(elements, 50, 'Not present').optionText).toBeNull();
    expect(resolveMacSelectOptionFromElementsForTest(elements, 50, 'About Chromium').optionText).toBeNull();
  });

  test('select_option acts only through set_value; no menu-item press or typeahead fallback', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'tools.ts'), 'utf8');
    const start = source.indexOf("if (toolName === 'select_option')");
    const end = source.indexOf("\n  if (toolName === 'scroll')", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const appScopedSelectOption = source.slice(start, end);

    // The transient menu is closed with Escape, never confirmed with Return:
    // a stray Return can submit a real form.
    expect(appScopedSelectOption).toContain("key: 'escape'");
    expect(appScopedSelectOption).not.toContain("key: 'return'");
    expect(appScopedSelectOption).not.toContain('pressSelectOptionTypeahead');
    expect(appScopedSelectOption).not.toContain("action: 'press'");
    expect(appScopedSelectOption).not.toContain("action: 'pick'");
  });

  test('requests foreground approval only for native mouse-style actions', () => {
    expect(macToolMayRequireForegroundFocusForTest('click', { element_index: 12 })).toBe(false);
    expect(macToolMayRequireForegroundFocusForTest('click', { element_index: 12, action: 'press' })).toBe(false);
    expect(macToolMayRequireForegroundFocusForTest('click', { element_index: 12, action: 'mouse' })).toBe(true);
    expect(macToolMayRequireForegroundFocusForTest('click', { x: 10, y: 20 })).toBe(true);
    expect(macToolMayRequireForegroundFocusForTest('drag', {})).toBe(true);
    expect(macToolMayRequireForegroundFocusForTest('type_text', {})).toBe(false);
    expect(macToolMayRequireForegroundFocusForTest('press_key', {})).toBe(false);
  });

  test('applies native Computer Use app policy before approval prompts', async () => {
    await withPlatform('darwin', async () => {
      setCuaAccessPolicyProviderForCuaDriverTest(async () => ({
        permissions: {
          inspect: { mode: 'deny' },
          control: { mode: 'ask' },
        },
        appPolicies: [{
          appId: 'TextEdit',
          displayName: 'TextEdit',
          permissions: {
            inspect: { mode: 'all' },
            control: { mode: 'deny' },
          },
        }],
      }));

      try {
        await expect(requestApprovalForTest('get_app_state', { bundle_id: 'TextEdit' })).resolves.toBeUndefined();
        await expect(requestApprovalForTest('get_ui_elements', { app: 'TextEdit' })).resolves.toBeUndefined();
        await expect(requestApprovalForTest('click', { bundle_id: 'TextEdit' })).rejects.toThrow(
          'Computer Use control access to "TextEdit" is denied by Settings > Permissions.',
        );
        await expect(requestApprovalForTest('get_app_state', { bundle_id: 'Slack' })).rejects.toThrow(
          'Computer Use inspect access to "Slack" is denied by Settings > Permissions.',
        );
      } finally {
        setCuaAccessPolicyProviderForCuaDriverTest(null);
      }
    });
  });

  test('does not ask twice for reviewed overlay control actions but still honors Settings deny', async () => {
    await withPlatform('darwin', async () => {
      setCuaAccessPolicyProviderForCuaDriverTest(async () => ({
        permissions: {
          inspect: { mode: 'ask' },
          control: { mode: 'ask' },
        },
        appPolicies: [{
          appId: 'DeniedApp',
          displayName: 'DeniedApp',
          permissions: {
            inspect: { mode: 'ask' },
            control: { mode: 'deny' },
          },
        }],
      }));

      try {
        await expect(requestApprovalForTest(
          'set_value',
          { bundle_id: 'TextEdit' },
          { overlayReviewedAction: true },
        )).resolves.toBeUndefined();
        await expect(requestApprovalForTest(
          'set_value',
          { bundle_id: 'DeniedApp' },
          { overlayReviewedAction: true },
        )).rejects.toThrow(
          'Computer Use control access to "DeniedApp" is denied by Settings > Permissions.',
        );
      } finally {
        setCuaAccessPolicyProviderForCuaDriverTest(null);
      }
    });
  });

  test('applies native Computer Use policy through the Windows app-scoped tool path before foreground approval', async () => {
    const previousAutoApprove = approvalManager.isAutoApproveEnabled();
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const windowRecord = {
      app_name: 'Notepad',
      title: 'Untitled - Notepad',
      pid: 4321,
      window_id: 'hwnd-1',
      is_focused: false,
      bounds: { x: 100, y: 120, width: 500, height: 360 },
    };

    approvalManager.setAutoApprove(true);
    setCuaAccessPolicyProviderForCuaDriverTest(async () => ({
      permissions: {
        inspect: { mode: 'all' },
        control: { mode: 'all' },
      },
      appPolicies: [{
        appId: 'Notepad',
        displayName: 'Notepad',
        permissions: {
          inspect: { mode: 'all' },
          control: { mode: 'deny' },
        },
      }],
    }));
    setWindowsCuaDriverToolProviderForTest(async (toolName, args) => {
      calls.push({ toolName, args });
      if (toolName === 'list_windows') {
        return windowsToolResponse([windowRecord]);
      }
      if (toolName === 'get_window_state') {
        return windowsToolResponse({
          app: 'Notepad',
          title: 'Untitled - Notepad',
          pid: 4321,
          window_id: 'hwnd-1',
          bounds: windowRecord.bounds,
          tree_markdown: 'application Notepad\n\t1 button FOCUSED',
        });
      }
      if (toolName === 'screenshot') {
        return windowsToolResponse({ png_base64: '' });
      }
      if (toolName === 'drag') {
        return windowsToolResponse({ action: 'drag' });
      }
      throw new Error(`Unexpected Windows CUA tool ${toolName}`);
    });
    clearComputerUseTargetCacheForTest();

    try {
      await withPlatform('win32', async () => {
        await callComputerUseToolForTest('get_app_state', { app: 'Notepad' }, { agentId: 'policy-windows' });
        await expect(callComputerUseToolForTest('drag', {
          app: 'Notepad',
          from_x: 20,
          from_y: 20,
          to_x: 40,
          to_y: 40,
        }, { agentId: 'policy-windows' })).rejects.toThrow(
          'Computer Use control access to "Notepad" is denied by Settings > Permissions.',
        );
      });
      expect(calls.map((call) => call.toolName)).not.toContain('drag');
    } finally {
      clearComputerUseTargetCacheForTest();
      setWindowsCuaDriverToolProviderForTest(null);
      setCuaAccessPolicyProviderForCuaDriverTest(null);
      approvalManager.setAutoApprove(previousAutoApprove);
    }
  });

  test('uses explicit target_identity for Windows action tools without cached app state', async () => {
    const previousAutoApprove = approvalManager.isAutoApproveEnabled();
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const windowRecord = {
      app_name: 'Notepad',
      title: 'Untitled - Notepad',
      pid: 4321,
      window_id: 'hwnd-1',
      is_focused: true,
      bounds: { x: 100, y: 120, width: 500, height: 360 },
    };

    approvalManager.setAutoApprove(true);
    setCuaAccessPolicyProviderForCuaDriverTest(async () => ({
      permissions: {
        inspect: { mode: 'all' },
        control: { mode: 'all' },
      },
      appPolicies: [],
    }));
    setWindowsCuaDriverToolProviderForTest(async (toolName, args) => {
      calls.push({ toolName, args });
      if (toolName === 'list_windows') {
        return windowsToolResponse([windowRecord]);
      }
      if (toolName === 'click') {
        return windowsToolResponse({ action: 'click' });
      }
      throw new Error(`Unexpected Windows CUA tool ${toolName}`);
    });
    clearComputerUseTargetCacheForTest();

    try {
      await withPlatform('win32', async () => {
        await expect(callComputerUseToolForTest('click', {
          app: 'Notepad',
          element_index: '7',
          target_identity: {
            kind: 'app-window',
            app: { name: 'Notepad', pid: 4321 },
            window: { native_window_id: 'hwnd-1', title: 'Untitled - Notepad' },
            bounds: windowRecord.bounds,
          },
        }, { agentId: 'explicit-target-windows' })).resolves.toEqual(windowsToolResponse({ action: 'click' }));
      });
      expect(calls).toContainEqual({
        toolName: 'click',
        args: {
          pid: 4321,
          window_id: 'hwnd-1',
          element_index: 7,
        },
      });
      expect(calls.map((call) => call.toolName)).not.toContain('get_window_state');
    } finally {
      clearComputerUseTargetCacheForTest();
      setWindowsCuaDriverToolProviderForTest(null);
      setCuaAccessPolicyProviderForCuaDriverTest(null);
      approvalManager.setAutoApprove(previousAutoApprove);
    }
  });

  test('uses explicit element_index for Windows type_text without cached app state', async () => {
    const previousAutoApprove = approvalManager.isAutoApproveEnabled();
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const windowRecord = {
      app_name: 'Notepad',
      title: 'Untitled - Notepad',
      pid: 4321,
      window_id: 'hwnd-1',
      is_focused: true,
      bounds: { x: 100, y: 120, width: 500, height: 360 },
    };

    approvalManager.setAutoApprove(true);
    setCuaAccessPolicyProviderForCuaDriverTest(async () => ({
      permissions: {
        inspect: { mode: 'all' },
        control: { mode: 'all' },
      },
      appPolicies: [],
    }));
    setWindowsCuaDriverToolProviderForTest(async (toolName, args) => {
      calls.push({ toolName, args });
      if (toolName === 'list_windows') {
        return windowsToolResponse([windowRecord]);
      }
      if (toolName === 'type_text_chars') {
        return windowsToolResponse({ action: 'uia_append_value', value: 'Ada', element_index: 7 });
      }
      throw new Error(`Unexpected Windows CUA tool ${toolName}`);
    });
    clearComputerUseTargetCacheForTest();

    try {
      await withPlatform('win32', async () => {
        await expect(callComputerUseToolForTest('type_text', {
          app: 'Notepad',
          element_index: '7',
          text: 'Ada',
          target_identity: {
            kind: 'app-window',
            app: { name: 'Notepad', pid: 4321 },
            window: { native_window_id: 'hwnd-1', title: 'Untitled - Notepad' },
            bounds: windowRecord.bounds,
          },
        }, { agentId: 'explicit-target-windows-type' })).resolves.toEqual(windowsToolResponse({
          action: 'uia_append_value',
          value: 'Ada',
          element_index: 7,
        }));
      });
      expect(calls).toContainEqual({
        toolName: 'type_text_chars',
        args: {
          pid: 4321,
          window_id: 'hwnd-1',
          element_index: 7,
          text: 'Ada',
        },
      });
      expect(calls.map((call) => call.toolName)).not.toContain('get_window_state');
    } finally {
      clearComputerUseTargetCacheForTest();
      setWindowsCuaDriverToolProviderForTest(null);
      setCuaAccessPolicyProviderForCuaDriverTest(null);
      approvalManager.setAutoApprove(previousAutoApprove);
    }
  });

  test('moves Windows windows through set_window_bounds target identity', async () => {
    const previousAutoApprove = approvalManager.isAutoApproveEnabled();
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const movedBounds = { x: 210, y: 140, width: 640, height: 420 };

    approvalManager.setAutoApprove(true);
    setCuaAccessPolicyProviderForCuaDriverTest(async () => ({
      permissions: {
        inspect: { mode: 'all' },
        control: { mode: 'all' },
      },
      appPolicies: [],
    }));
    setWindowsCuaDriverToolProviderForTest(async (toolName, args) => {
      calls.push({ toolName, args });
      if (toolName === 'list_windows') {
        return windowsToolResponse([{
          app_name: 'Notepad',
          title: 'Untitled - Notepad',
          pid: 4321,
          window_id: 'hwnd-1',
          is_focused: true,
          bounds: movedBounds,
        }]);
      }
      if (toolName === 'set_window_bounds') {
        return windowsToolResponse({
          action: 'set_window_bounds',
          pid: 4321,
          window_id: 'hwnd-1',
          bounds: movedBounds,
        });
      }
      throw new Error(`Unexpected Windows CUA tool ${toolName}`);
    });

    try {
      await withPlatform('win32', async () => {
        await expect(callComputerUseToolForTest('set_window_bounds', {
          target_identity: {
            kind: 'app-window',
            app: { name: 'Notepad', pid: 4321 },
            window: { native_window_id: 'hwnd-1', title: 'Untitled - Notepad' },
          },
          x: 210,
          y: 140,
          width: 640,
          height: 420,
        }, { agentId: 'windows-window-bounds' })).resolves.toEqual(windowsToolResponse({
          action: 'set_window_bounds',
          pid: 4321,
          window_id: 'hwnd-1',
          bounds: movedBounds,
        }));
      });
      expect(calls).toEqual([
        {
          toolName: 'list_windows',
          args: {},
        },
        {
          toolName: 'set_window_bounds',
          args: {
            pid: 4321,
            window_id: 'hwnd-1',
            x: 210,
            y: 140,
            width: 640,
            height: 420,
          },
        },
      ]);
    } finally {
      setWindowsCuaDriverToolProviderForTest(null);
      setCuaAccessPolicyProviderForCuaDriverTest(null);
      approvalManager.setAutoApprove(previousAutoApprove);
    }
  });

  test('focuses Windows windows through focus_window target identity', async () => {
    const previousAutoApprove = approvalManager.isAutoApproveEnabled();
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const focusedBounds = { x: 210, y: 140, width: 640, height: 420 };

    approvalManager.setAutoApprove(true);
    setCuaAccessPolicyProviderForCuaDriverTest(async () => ({
      permissions: {
        inspect: { mode: 'all' },
        control: { mode: 'all' },
      },
      appPolicies: [],
    }));
    setWindowsCuaDriverToolProviderForTest(async (toolName, args) => {
      calls.push({ toolName, args });
      if (toolName === 'list_windows') {
        return windowsToolResponse([{
          app_name: 'Notepad',
          title: 'Untitled - Notepad',
          pid: 1234,
          window_id: 'hwnd-1',
          is_focused: false,
          bounds: focusedBounds,
        }]);
      }
      if (toolName === 'focus_window') {
        return windowsToolResponse({
          action: 'focus_window',
          pid: 1234,
          window_id: 'hwnd-1',
          title: 'Untitled - Notepad',
          is_focused: true,
          bounds: focusedBounds,
        });
      }
      throw new Error(`unexpected ${toolName}`);
    });

    try {
      await withPlatform('win32', async () => {
        await expect(callComputerUseToolForTest('focus_window', {
          target_identity: {
            kind: 'app-window',
            app: { pid: 1234, name: 'Notepad' },
            window: { native_window_id: 'hwnd-1', title: 'Untitled - Notepad' },
          },
        }, { agentId: 'windows-window-focus' })).resolves.toEqual(windowsToolResponse({
          action: 'focus_window',
          pid: 1234,
          window_id: 'hwnd-1',
          title: 'Untitled - Notepad',
          is_focused: true,
          bounds: focusedBounds,
        }));
      });
      expect(calls).toEqual([
        {
          toolName: 'list_windows',
          args: {},
        },
        {
          toolName: 'focus_window',
          args: {
            pid: 1234,
            window_id: 'hwnd-1',
          },
        },
      ]);
    } finally {
      setWindowsCuaDriverToolProviderForTest(null);
      setCuaAccessPolicyProviderForCuaDriverTest(null);
      approvalManager.setAutoApprove(previousAutoApprove);
    }
  });

  test('closes Windows windows through close_window target identity', async () => {
    const previousAutoApprove = approvalManager.isAutoApproveEnabled();
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

    approvalManager.setAutoApprove(true);
    setCuaAccessPolicyProviderForCuaDriverTest(async () => ({
      permissions: {
        inspect: { mode: 'all' },
        control: { mode: 'all' },
      },
      appPolicies: [],
    }));
    setWindowsCuaDriverToolProviderForTest(async (toolName, args) => {
      calls.push({ toolName, args });
      if (toolName === 'list_windows') {
        return windowsToolResponse([{
          app_name: 'Notepad',
          title: 'Untitled - Notepad',
          pid: 1234,
          window_id: 'hwnd-1',
          is_focused: false,
          bounds: { x: 210, y: 140, width: 640, height: 420 },
        }]);
      }
      if (toolName === 'close_window') {
        return windowsToolResponse({
          action: 'close_window',
          pid: 1234,
          window_id: 'hwnd-1',
          title: 'Untitled - Notepad',
          closed: true,
        });
      }
      throw new Error(`unexpected ${toolName}`);
    });

    try {
      await withPlatform('win32', async () => {
        await expect(callComputerUseToolForTest('close_window', {
          target_identity: {
            kind: 'app-window',
            app: { pid: 1234, name: 'Notepad' },
            window: { native_window_id: 'hwnd-1', title: 'Untitled - Notepad' },
          },
        }, { agentId: 'windows-window-close' })).resolves.toEqual(windowsToolResponse({
          action: 'close_window',
          pid: 1234,
          window_id: 'hwnd-1',
          title: 'Untitled - Notepad',
          closed: true,
        }));
      });
      expect(calls).toEqual([
        {
          toolName: 'list_windows',
          args: {},
        },
        {
          toolName: 'close_window',
          args: {
            pid: 1234,
            window_id: 'hwnd-1',
          },
        },
      ]);
    } finally {
      setWindowsCuaDriverToolProviderForTest(null);
      setCuaAccessPolicyProviderForCuaDriverTest(null);
      approvalManager.setAutoApprove(previousAutoApprove);
    }
  });

  test('forwards window lifecycle tools through target identity', async () => {
    const previousAutoApprove = approvalManager.isAutoApproveEnabled();
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const bounds = { x: 210, y: 140, width: 640, height: 420 };

    approvalManager.setAutoApprove(true);
    setCuaAccessPolicyProviderForCuaDriverTest(async () => ({
      permissions: {
        inspect: { mode: 'all' },
        control: { mode: 'all' },
      },
      appPolicies: [],
    }));
    setWindowsCuaDriverToolProviderForTest(async (toolName, args) => {
      calls.push({ toolName, args });
      if (toolName === 'list_windows') {
        return windowsToolResponse([{
          app_name: 'Notepad',
          title: 'Untitled - Notepad',
          pid: 1234,
          window_id: 'hwnd-1',
          is_focused: false,
          bounds,
        }]);
      }
      if (toolName === 'minimize_window' || toolName === 'restore_window' || toolName === 'maximize_window') {
        return windowsToolResponse({
          action: toolName,
          pid: 1234,
          window_id: 'hwnd-1',
          bounds,
        });
      }
      throw new Error(`unexpected ${toolName}`);
    });

    try {
      await withPlatform('win32', async () => {
        for (const toolName of ['minimize_window', 'restore_window', 'maximize_window']) {
          await expect(callComputerUseToolForTest(toolName, {
            target_identity: {
              kind: 'app-window',
              app: { pid: 1234, name: 'Notepad' },
              window: { native_window_id: 'hwnd-1', title: 'Untitled - Notepad' },
            },
          }, { agentId: `windows-${toolName}` })).resolves.toEqual(windowsToolResponse({
            action: toolName,
            pid: 1234,
            window_id: 'hwnd-1',
            bounds,
          }));
        }
      });
      expect(calls).toEqual([
        { toolName: 'list_windows', args: {} },
        { toolName: 'minimize_window', args: { pid: 1234, window_id: 'hwnd-1' } },
        { toolName: 'list_windows', args: {} },
        { toolName: 'restore_window', args: { pid: 1234, window_id: 'hwnd-1' } },
        { toolName: 'list_windows', args: {} },
        { toolName: 'maximize_window', args: { pid: 1234, window_id: 'hwnd-1' } },
      ]);
    } finally {
      setWindowsCuaDriverToolProviderForTest(null);
      setCuaAccessPolicyProviderForCuaDriverTest(null);
      approvalManager.setAutoApprove(previousAutoApprove);
    }
  });

  test('stores macOS app-state screenshots as the same JPEG capture used by get_window_state', () => {
    expect(macComputerUseScreenshotPathForTest('TextEdit')).toEndWith('.jpg');
  });

  test('distinguishes full app windows from menu-bar-only AX snapshots', () => {
    expect(macComputerUseTreeHasWindowContentForTest([
      'application Codex',
      '\t0 menu bar',
      '\t16 standard window Subrole: AXStandardWindow Codex',
      '\t\t17 container Role: group',
      '\t\t\t23 HTML content Codex',
    ].join('\n'))).toBe(true);

    expect(macComputerUseTreeHasWindowContentForTest([
      'application Codex',
      '\t0 menu bar',
      '\tmenu bar',
      '\t\t15 menu bar item Role: status menu',
    ].join('\n'))).toBe(false);
  });
});

describe('browser access policy denial parity for native Computer Use reads', () => {
  const cuaAllowAllPolicy = {
    permissions: {
      inspect: { mode: 'all' as const },
      control: { mode: 'all' as const },
    },
    appPolicies: [],
  };
  const chromeBounds = { x: 0, y: 0, width: 1200, height: 800 };
  const chromeTargetIdentity = {
    kind: 'app-window',
    app: { name: 'Google Chrome', pid: 4321 },
    window: { native_window_id: 'hwnd-9', title: 'Docs' },
    bounds: chromeBounds,
  };

  function chromeWindowsDriverMock(calls: string[]): (toolName: string, args: Record<string, unknown>) => Promise<{ content: [{ type: 'text'; text: string }] }> {
    return async (toolName) => {
      calls.push(toolName);
      if (toolName === 'list_windows') {
        return windowsToolResponse([{
          app_name: 'Google Chrome',
          title: 'Docs',
          pid: 4321,
          window_id: 'hwnd-9',
          is_focused: true,
          bounds: chromeBounds,
        }]);
      }
      if (toolName === 'get_window_state') {
        return windowsToolResponse({
          app: 'Google Chrome',
          title: 'Docs',
          pid: 4321,
          window_id: 'hwnd-9',
          bounds: chromeBounds,
          tree_markdown: 'application Google Chrome\n\t1 button FOCUSED',
        });
      }
      if (toolName === 'screenshot') {
        return windowsToolResponse({ png_base64: '' });
      }
      throw new Error(`Unexpected Windows CUA tool ${toolName}`);
    };
  }

  function resetProviders(): void {
    clearComputerUseTargetCacheForTest();
    setWindowsCuaDriverToolProviderForTest(null);
    setBrowserControlStatusProviderForCuaDriverTest(null);
    setBrowserAccessPolicyProviderForCuaDriverTest(null);
    setCuaAccessPolicyProviderForCuaDriverTest(null);
  }

  test('refuses native get_app_state on a browser whose active tab is deny-mode without invoking the driver', async () => {
    const calls: string[] = [];
    setBrowserControlStatusProviderForCuaDriverTest(async () => chromeBrowserControlStatus([
      { profileId: 'install:work', url: 'https://denied.example.test/secret/path?token=abc', title: 'Denied Docs' },
    ]));
    setBrowserAccessPolicyProviderForCuaDriverTest(async () => browserReadPolicy('deny'));
    setCuaAccessPolicyProviderForCuaDriverTest(async () => cuaAllowAllPolicy);
    setWindowsCuaDriverToolProviderForTest(chromeWindowsDriverMock(calls));
    clearComputerUseTargetCacheForTest();

    try {
      await withPlatform('win32', async () => {
        await expect(callComputerUseToolForTest('get_app_state', {
          app: 'Google Chrome',
          target_identity: chromeTargetIdentity,
        }, { agentId: 'browser-policy-deny' })).rejects.toThrow(
          /^Interpreter browser settings blocked this request\. Browser read access is denied for https:\/\/denied\.example\.test\.$/,
        );
      });
      expect(calls).toEqual([]);
    } finally {
      resetProviders();
    }
  });

  test('allows native get_app_state when the browser read policy is ask or all', async () => {
    for (const mode of ['ask', 'all'] as const) {
      const calls: string[] = [];
      setBrowserControlStatusProviderForCuaDriverTest(async () => chromeBrowserControlStatus([
        { profileId: 'install:work', url: 'https://docs.example.test/', title: 'Docs' },
      ]));
      setBrowserAccessPolicyProviderForCuaDriverTest(async () => browserReadPolicy(mode));
      setCuaAccessPolicyProviderForCuaDriverTest(async () => cuaAllowAllPolicy);
      setWindowsCuaDriverToolProviderForTest(chromeWindowsDriverMock(calls));
      clearComputerUseTargetCacheForTest();

      try {
        await withPlatform('win32', async () => {
          const response = await callComputerUseToolForTest('get_app_state', {
            app: 'Google Chrome',
            target_identity: chromeTargetIdentity,
          }, { agentId: `browser-policy-${mode}` });
          expect(response.isError).toBeUndefined();
        });
        expect(calls).toContain('get_window_state');
        expect(calls).toContain('screenshot');
      } finally {
        resetProviders();
      }
    }
  });

  test('leaves non-browser apps unaffected by a deny-mode browser read policy', async () => {
    const calls: string[] = [];
    setBrowserControlStatusProviderForCuaDriverTest(async () => chromeBrowserControlStatus([
      { profileId: 'install:work', url: 'https://denied.example.test/', title: 'Denied Docs' },
    ]));
    setBrowserAccessPolicyProviderForCuaDriverTest(async () => browserReadPolicy('deny'));
    setCuaAccessPolicyProviderForCuaDriverTest(async () => cuaAllowAllPolicy);
    setWindowsCuaDriverToolProviderForTest(async (toolName) => {
      calls.push(toolName);
      if (toolName === 'list_windows') {
        return windowsToolResponse([{
          app_name: 'Notepad',
          title: 'Untitled - Notepad',
          pid: 8765,
          window_id: 'hwnd-2',
          is_focused: true,
          bounds: { x: 100, y: 120, width: 500, height: 360 },
        }]);
      }
      if (toolName === 'get_window_state') {
        return windowsToolResponse({
          app: 'Notepad',
          title: 'Untitled - Notepad',
          pid: 8765,
          window_id: 'hwnd-2',
          bounds: { x: 100, y: 120, width: 500, height: 360 },
          tree_markdown: 'application Notepad\n\t1 button FOCUSED',
        });
      }
      if (toolName === 'screenshot') {
        return windowsToolResponse({ png_base64: '' });
      }
      throw new Error(`Unexpected Windows CUA tool ${toolName}`);
    });
    clearComputerUseTargetCacheForTest();

    try {
      await withPlatform('win32', async () => {
        const response = await callComputerUseToolForTest('get_app_state', {
          app: 'Notepad',
          target_identity: {
            kind: 'app-window',
            app: { name: 'Notepad', pid: 8765 },
            window: { native_window_id: 'hwnd-2', title: 'Untitled - Notepad' },
          },
        }, { agentId: 'browser-policy-non-browser' });
        expect(response.isError).toBeUndefined();
      });
      expect(calls).toContain('get_window_state');
    } finally {
      resetProviders();
    }
  });

  test('masks deny-mode browser windows in list_windows browser-control enrichment', async () => {
    setBrowserControlStatusProviderForCuaDriverTest(async () => chromeBrowserControlStatus([
      { profileId: 'install:denied', url: 'https://denied.example.test/dash', title: 'Denied Dash' },
      { profileId: 'install:allowed', url: 'https://allowed.example.test/', title: 'Allowed' },
    ]));
    setBrowserAccessPolicyProviderForCuaDriverTest(async () => browserReadPolicy('ask', [{
      profileId: 'install:denied',
      permissions: {
        read: { mode: 'deny', allowedPatterns: [] },
        write: { mode: 'ask', allowedPatterns: [] },
        action: { mode: 'ask', allowedPatterns: [] },
      },
    }]));

    try {
      const response = await enrichListWindowsResponseWithTargetIdentityForTest({
        content: [{
          type: 'text',
          text: JSON.stringify([{
            owner: 'Google Chrome',
            name: 'Docs',
            pid: 1234,
            window_id: 55,
            bounds: { x: 10, y: 20, width: 800, height: 600 },
          }]),
        }],
      }, 'darwin', 5000);

      const text = response.content?.[0]?.text ?? '';
      expect(text).not.toContain('denied.example.test');
      expect(text).not.toContain('Denied Dash');
      const controlWindows = JSON.parse(text)[0].browser_control.windows as Array<Record<string, unknown>>;
      const denied = controlWindows.find((window) => window.browser_profile_policy_id === 'install:denied');
      const allowed = controlWindows.find((window) => window.browser_profile_policy_id === 'install:allowed');
      expect(denied?.tabs).toBe('Interpreter browser settings blocked this request. Tab titles and URLs are hidden for this browser window.');
      expect(denied?.active_tab_ref).toBeNull();
      expect(allowed?.tabs).toEqual([expect.objectContaining({
        title: 'Allowed',
        url: 'https://allowed.example.test/',
      })]);
    } finally {
      resetProviders();
    }
  });

  test('allows native browser reads when the extension relay reports no connections', async () => {
    const calls: string[] = [];
    setBrowserControlStatusProviderForCuaDriverTest(async () => emptyBrowserControlStatus());
    setBrowserAccessPolicyProviderForCuaDriverTest(async () => browserReadPolicy('deny'));
    setCuaAccessPolicyProviderForCuaDriverTest(async () => cuaAllowAllPolicy);
    setWindowsCuaDriverToolProviderForTest(chromeWindowsDriverMock(calls));
    clearComputerUseTargetCacheForTest();

    try {
      await withPlatform('win32', async () => {
        const response = await callComputerUseToolForTest('get_app_state', {
          app: 'Google Chrome',
          target_identity: chromeTargetIdentity,
        }, { agentId: 'browser-policy-disconnected' });
        expect(response.isError).toBeUndefined();
      });
      expect(calls).toContain('get_window_state');
    } finally {
      resetProviders();
    }
  });
});

describe('classifyCuaDriverServeStartupOutput', () => {
  test('recognizes direct daemon startup', () => {
    expect(
      classifyCuaDriverServeStartupOutputForTest('Cua Driver daemon listening on /tmp/cua-driver.sock\n'),
    ).toBe('started');
  });

  test('recognizes an already-running daemon', () => {
    expect(
      classifyCuaDriverServeStartupOutputForTest(
        'Cua Driver daemon is already running on /tmp/cua-driver.sock (pid 123). Run `cua-driver stop` first.',
      ),
    ).toBe('already-running');
  });

  test('keeps unrelated startup text pending until the daemon is actually reachable', () => {
    expect(
      classifyCuaDriverServeStartupOutputForTest(
        'cua-driver: starting embedded daemon…',
      ),
    ).toBe('pending');
  });
});

describe('Computer Use daemon shutdown', () => {
  test('is safe when no daemon process has been started', async () => {
    await expect(shutdownCuaDriverProcesses()).resolves.toBeUndefined();
  });
});

describe('Interpreter self-automation guard', () => {
  test('blocks targeted GUI automation against protected app pids', () => {
    const protectedPids = new Set([1234]);
    expect(isProtectedDesktopAutomationTarget('get_window_state', { pid: 1234 }, protectedPids)).toBe(true);
    expect(isProtectedDesktopAutomationTarget('click', { pid: 1234, element_index: 1 }, protectedPids)).toBe(true);
    expect(isProtectedDesktopAutomationTarget('type_text_chars', { pid: 1234, text: 'hello' }, protectedPids)).toBe(true);
    expect(isProtectedDesktopAutomationTarget('set_window_bounds', {
      target_identity: {
        kind: 'app-window',
        app: { pid: 1234 },
        window: { native_window_id: 55 },
      },
    }, protectedPids)).toBe(true);
    expect(isProtectedDesktopAutomationTarget('focus_window', {
      target_identity: {
        kind: 'app-window',
        app: { pid: 1234 },
        window: { native_window_id: 55 },
      },
    }, protectedPids)).toBe(true);
    expect(isProtectedDesktopAutomationTarget('close_window', {
      target_identity: {
        kind: 'app-window',
        app: { pid: 1234 },
        window: { native_window_id: 55 },
      },
    }, protectedPids)).toBe(true);
    expect(isProtectedDesktopAutomationTarget('minimize_window', {
      target_identity: {
        kind: 'app-window',
        app: { pid: 1234 },
        window: { native_window_id: 55 },
      },
    }, protectedPids)).toBe(true);
    expect(isProtectedDesktopAutomationTarget('restore_window', {
      target_identity: {
        kind: 'app-window',
        app: { pid: 1234 },
        window: { native_window_id: 55 },
      },
    }, protectedPids)).toBe(true);
    expect(isProtectedDesktopAutomationTarget('maximize_window', {
      target_identity: {
        kind: 'app-window',
        app: { pid: 1234 },
        window: { native_window_id: 55 },
      },
    }, protectedPids)).toBe(true);
    expect(isProtectedDesktopAutomationTarget('list_windows', { pid: 1234 }, protectedPids)).toBe(false);
    expect(isProtectedDesktopAutomationTarget('click', { pid: 5678, element_index: 1 }, protectedPids)).toBe(false);
  });

  test('blocks replay trajectories that target protected app pids', () => {
    const protectedPids = new Set([1234]);
    expect(isProtectedDesktopAutomationTarget('replay_trajectory', {
      events: [
        { tool: 'click', args: { pid: 5678, element_index: 1 } },
        { tool: 'press_key', args: { pid: 1234, key: 'Enter' } },
      ],
    }, protectedPids)).toBe(true);
  });

  test('removes protected app windows from discovery output', () => {
    const protectedPids = new Set([1234]);
    const filtered = filterProtectedDesktopTargetsFromTextForTest(JSON.stringify({
      ok: true,
      data: [
        { pid: 1234, title: 'Interpreter' },
        { pid: 5678, title: 'Calculator' },
      ],
    }), protectedPids);

    expect(JSON.parse(filtered)).toEqual({
      ok: true,
      data: [
        { pid: 5678, title: 'Calculator' },
      ],
    });
  });
});
