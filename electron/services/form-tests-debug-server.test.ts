import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import { FormTestsDebugServer } from '../../apps/interpreter-overlay/electron/form-tests-debug-server';
import { agentTabManager } from '../../server/agentTabManager';
import { overlaySessionManager } from '../../server/overlaySessionManager';
import {
  registerWindowSession,
  unregisterWindowSession,
} from '../../server/utils/windowSessions';

function createOverlayServiceMock() {
  return {
    startProgrammaticRun: async () => {},
    captureContext: async () => ({
      formattedText: '',
      elementCount: 0,
      elements: [],
    }),
    getOverlayState: () => ({
      mode: 'idle',
      action: null,
      ghosts: [],
      pill: { kind: 'hidden' },
      inputReady: false,
      ctrlPressed: false,
      screenshot: null,
      transcript: '',
      isRecording: false,
      amplitude: 0,
      scopeBounds: null,
      selectableElements: [],
    }),
    getDebugStatus: () => ({
      started: true,
      runtimeActive: true,
      authenticated: true,
      run: {
        id: 7,
        status: 'completed',
        reason: 'completed',
        finalText: 'done',
        startedAt: 100,
        finishedAt: 200,
      },
      lastWorkspaceAgentLaunch: null,
    }),
    getTrayState: () => ({
      enabled: true,
      accelerator: 'Control+Space',
      runningAgents: [],
    }),
    getAgentDebugContext: () => ({
      initialUserText: null,
      latestStructuredText: null,
      latestStructuredSnapshot: null,
      finalText: null,
      runStatus: 'idle',
      runReason: null,
      automationDebugTrace: [],
      transcriptDebugTrace: [],
    }),
    simulateEscape: async () => {},
    removeInputOverlayContextItemForDebug: () => {},
  };
}

function sendCommandRequest(
  port: number,
  command: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  const body = JSON.stringify({ command });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/command',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk.toString();
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: responseBody });
        });
      },
    );

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

describe('FormTestsDebugServer', () => {
  afterEach(() => {
    overlaySessionManager.setDriver(null);
    overlaySessionManager.clearAll();
    agentTabManager.clearAll();
    unregisterWindowSession(321);
  });

  test('pressEscape delegates to overlayService.simulateEscape', async () => {
    let escapeCount = 0;
    const server = new FormTestsDebugServer({
      port: 0,
      debugAuthToken: 'test-token',
      overlayService: {
        ...createOverlayServiceMock(),
        simulateEscape: async () => {
          escapeCount += 1;
        },
      } as any,
    });

    const result = await (server as any).handleCommand({ command: 'pressEscape' });

    expect(result).toEqual({ success: true });
    expect(escapeCount).toBe(1);
  });

  test('removeInputOverlayContextItem delegates only in form-tests mode', async () => {
    const previousFormTestsMode = process.env.FORM_TESTS_MODE;
    let removedId: string | null = null;
    const server = new FormTestsDebugServer({
      port: 0,
      debugAuthToken: 'test-token',
      overlayService: {
        ...createOverlayServiceMock(),
        removeInputOverlayContextItemForDebug: (id: string) => {
          removedId = id;
        },
      } as any,
    });

    try {
      process.env.FORM_TESTS_MODE = 'true';
      const result = await (server as any).handleCommand({
        command: 'removeInputOverlayContextItem',
        params: { id: 'overlay-region-target-1' },
      });

      expect(result).toEqual({ success: true });
      expect(removedId).toBe('overlay-region-target-1');

      process.env.FORM_TESTS_MODE = 'false';
      await expect((server as any).handleCommand({
        command: 'removeInputOverlayContextItem',
        params: { id: 'overlay-region-target-2' },
      })).rejects.toThrow('removeInputOverlayContextItem is only available in form tests mode');
    } finally {
      if (previousFormTestsMode === undefined) {
        delete process.env.FORM_TESTS_MODE;
      } else {
        process.env.FORM_TESTS_MODE = previousFormTestsMode;
      }
    }
  });

  test('setOnboardingAiSetupForDebug is form-tests only', async () => {
    const previousFormTestsMode = process.env.FORM_TESTS_MODE;
    const server = new FormTestsDebugServer({
      port: 0,
      debugAuthToken: 'test-token',
      overlayService: createOverlayServiceMock() as any,
    });

    try {
      process.env.FORM_TESTS_MODE = 'false';
      await expect((server as any).handleCommand({
        command: 'setOnboardingAiSetupForDebug',
      })).rejects.toThrow('setOnboardingAiSetupForDebug is only available in form tests mode');
    } finally {
      if (previousFormTestsMode === undefined) {
        delete process.env.FORM_TESTS_MODE;
      } else {
        process.env.FORM_TESTS_MODE = previousFormTestsMode;
      }
    }
  });

  test('getDebugStatus delegates to overlayService.getDebugStatus', async () => {
    const overlayService = createOverlayServiceMock();
    const server = new FormTestsDebugServer({
      port: 0,
      debugAuthToken: 'test-token',
      overlayService: overlayService as any,
    });

    const result = await (server as any).handleCommand({ command: 'getDebugStatus' });

    expect(result).toEqual({
      success: true,
      debugStatus: overlayService.getDebugStatus(),
    });
  });

  test('isAuthorizedRequest requires matching debug token header', () => {
    const server = new FormTestsDebugServer({
      port: 0,
      debugAuthToken: 'expected-token',
      overlayService: createOverlayServiceMock() as any,
    });

    const authorized = (server as any).isAuthorizedRequest({
      headers: {
        'x-interpreter-debug-token': 'expected-token',
      },
    });
    const unauthorized = (server as any).isAuthorizedRequest({
      headers: {
        'x-interpreter-debug-token': 'wrong-token',
      },
    });

    expect(authorized).toBe(true);
    expect(unauthorized).toBe(false);
  });

  test('constructor rejects empty debug auth token', () => {
    expect(
      () => new FormTestsDebugServer({
        port: 0,
        debugAuthToken: '',
        overlayService: createOverlayServiceMock() as any,
      }),
    ).toThrow('requires a non-empty debugAuthToken');
  });

  test('HTTP /command rejects requests without debug auth token', async () => {
    const server = new FormTestsDebugServer({
      port: 0,
      debugAuthToken: 'expected-token',
      overlayService: createOverlayServiceMock() as any,
    });
    await server.start();
    const port = ((server as any).server as http.Server).address();
    const listenPort = typeof port === 'object' && port ? port.port : 0;

    try {
      const response = await sendCommandRequest(listenPort, 'getDebugStatus');
      expect(response.statusCode).toBe(401);
      expect(response.body).toContain('Unauthorized');
    } finally {
      await server.stop();
    }
  });

  test('HTTP /command accepts requests with valid debug auth token', async () => {
    const server = new FormTestsDebugServer({
      port: 0,
      debugAuthToken: 'expected-token',
      overlayService: createOverlayServiceMock() as any,
    });
    await server.start();
    const port = ((server as any).server as http.Server).address();
    const listenPort = typeof port === 'object' && port ? port.port : 0;

    try {
      const response = await sendCommandRequest(listenPort, 'getDebugStatus', {
        'x-interpreter-debug-token': 'expected-token',
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"success":true');
    } finally {
      await server.stop();
    }
  });

  test('getWorkspaceAgentLaunchDiagnostics returns launched agent binding and overlay session snapshot', async () => {
    registerWindowSession({
      sessionKey: 'window-session-1',
      windowId: 321,
      workspacePath: '/tmp/overlay-workspace',
    });

    overlaySessionManager.createSession({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      workspacePath: '/tmp/overlay-workspace',
      windowSessionKey: 'window-session-1',
      displayId: 'display-1',
      scopeBoundsDIP: { x: 10, y: 20, width: 300, height: 180 },
      initialContext: {
        formattedText: '<button id="1">Save</button>',
        elementCount: 1,
        elements: [],
        screenshotBase64: 'abc123',
        captureBoundsDIP: { x: 10, y: 20, width: 300, height: 180 },
      },
    });

    agentTabManager.registerAgentRuntime({
      agentId: 'overlay-agent-1',
      callerToken: 'overlay-caller-1',
      windowSessionKey: 'window-session-1',
      workspacePath: '/tmp/overlay-workspace',
      allowedToolNames: ['builtin-interpreter-overlay__overlay_read_context'],
      toolProfileId: 'profile-overlay-test',
    });

    const server = new FormTestsDebugServer({
      port: 0,
      debugAuthToken: 'test-token',
      overlayService: {
        ...createOverlayServiceMock(),
        getDebugStatus: () => ({
          ...createOverlayServiceMock().getDebugStatus(),
          lastWorkspaceAgentLaunch: {
            agentId: 'overlay-agent-1',
            callerToken: 'overlay-caller-1',
            overlaySessionId: 'overlay-session-test',
            profileId: 'profile-overlay-test',
            workspacePath: '/tmp/overlay-workspace',
            targetWindowSessionKey: 'window-session-1',
            targetWindowId: 321,
            scopeBoundsDIP: { x: 10, y: 20, width: 300, height: 180 },
            startupAttachmentCount: 1,
            initialElementCount: 1,
            hasInitialScreenshot: true,
            launchedAt: 123,
          },
        }),
      } as any,
    });

    const result = await (server as any).handleCommand({ command: 'getWorkspaceAgentLaunchDiagnostics' });

    const overlaySession = result.diagnostics.overlaySession;
    const windowSession = result.diagnostics.windowSessions[0];

    expect(overlaySession).not.toBeNull();
    expect(windowSession).toBeDefined();
    expect(typeof overlaySession.id).toBe('string');
    expect(overlaySession.id.startsWith('overlay-session-')).toBe(true);
    expect(Number.isFinite(overlaySession.createdAt)).toBe(true);
    expect(Number.isFinite(overlaySession.updatedAt)).toBe(true);
    expect(Number.isFinite(windowSession.createdAt)).toBe(true);

    expect(result).toMatchObject({
      success: true,
      diagnostics: {
        lastWorkspaceAgentLaunch: {
          agentId: 'overlay-agent-1',
          callerToken: 'overlay-caller-1',
          overlaySessionId: 'overlay-session-test',
          profileId: 'profile-overlay-test',
          workspacePath: '/tmp/overlay-workspace',
          targetWindowSessionKey: 'window-session-1',
          targetWindowId: 321,
          scopeBoundsDIP: { x: 10, y: 20, width: 300, height: 180 },
          startupAttachmentCount: 1,
          initialElementCount: 1,
          hasInitialScreenshot: true,
          launchedAt: 123,
        },
        overlaySession: {
          agentId: 'overlay-agent-1',
          callerToken: 'overlay-caller-1',
          workspacePath: '/tmp/overlay-workspace',
          windowSessionKey: 'window-session-1',
          displayId: 'display-1',
          scopeBoundsDIP: { x: 10, y: 20, width: 300, height: 180 },
          status: 'active',
          initialElementCount: 1,
          latestElementCount: 1,
          initialCaptureBoundsDIP: { x: 10, y: 20, width: 300, height: 180 },
          latestCaptureBoundsDIP: { x: 10, y: 20, width: 300, height: 180 },
          hasInitialScreenshot: true,
          hasLatestScreenshot: true,
          initialScreenshotPath: null,
          latestScreenshotPath: null,
        },
        agentBinding: {
          agentId: 'overlay-agent-1',
          callerToken: 'overlay-caller-1',
          windowSessionKey: 'window-session-1',
          workspacePath: '/tmp/overlay-workspace',
          allowedToolNames: ['builtin-interpreter-overlay__overlay_read_context'],
          modelConfig: undefined,
          toolProfileId: 'profile-overlay-test',
        },
        pendingAgentRequests: [],
        windowSessions: [{
          sessionKey: 'window-session-1',
          windowId: 321,
          workspacePath: '/tmp/overlay-workspace',
        }],
        targetWindowState: {
          windowId: 321,
          exists: false,
          visible: false,
          focused: false,
          minimized: false,
          title: '',
          bounds: null,
        },
      },
    });
  });
});
