import { Page, Locator, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { getTestRunDir } from './test-recorder';
import { sel } from './selectors';
import { fileURLToPath } from 'url';
import { resolveInterpreterConfigFile } from '../shared/interpreterConfigPaths';
import { createDefaultOnboardingState } from '../shared/types/onboardingState';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolveInterpreterConfigFile();

/**
 * Paths for test workspace
 * - FIXTURES_DIR: Clean template files (committed to git)
 * - WORKING_DIR: Where tests actually run (gitignored, gets modified)
 */
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'workspace-template');
const WORKING_DIR = path.join(__dirname, 'test-workspace');
const NETWORK_IDLE_SETTLE_TIMEOUT_MS = 3000;

// Track if workspace has been initialized this test run
let workspaceInitialized = false;

/**
 * Copy a directory recursively
 */
function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Get the test workspace path.
 * Copies fixtures to working directory once per test run.
 * Returns the path to tests/test-workspace/ (the working directory).
 */
export function getTestWorkspace(): string {
  if (!workspaceInitialized) {
    // Remove existing working directory and copy fresh fixtures
    if (fs.existsSync(WORKING_DIR)) {
      fs.rmSync(WORKING_DIR, { recursive: true, force: true });
    }
    copyDirSync(FIXTURES_DIR, WORKING_DIR);
    workspaceInitialized = true;
    console.log(`  ✓ Initialized test workspace from fixtures`);
  }
  return WORKING_DIR;
}

export function getPerTestLogPath(testTitle: string): string {
  const sanitizedTitle = testTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return path.join(getTestRunDir(), 'logs', `${sanitizedTitle}.log`);
}

export function getAgentEventsLogPath(testTitle: string): string {
  return getPerTestLogPath(testTitle).replace(/\.log$/, '.agent-events.jsonl');
}

export function readJsonlFile(logPath: string): Array<Record<string, any>> {
  if (!fs.existsSync(logPath)) {
    return [];
  }

  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

export async function waitForJsonlMatchCount(
  logPath: string,
  predicate: (event: Record<string, any>) => boolean,
  minimumCount: number,
  timeoutMs: number = 30000,
): Promise<Array<Record<string, any>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = readJsonlFile(logPath);
    const matches = events.filter(predicate);
    if (matches.length >= minimumCount) {
      return matches;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${minimumCount} matching events in ${logPath}`);
}

/**
 * Internal helper to run an operation with error checking paused.
 * This prevents transient errors during reload from failing tests.
 */
async function withErrorPause<T>(
  page: Page,
  operation: () => Promise<T>,
  stabilizationDelayMs: number = 500
): Promise<T> {
  const control = (page as any).__testErrorControl;
  if (control) {
    control.pauseErrorChecking();
  }
  try {
    const result = await operation();
    if (stabilizationDelayMs > 0) {
      await waitForUiStability(page);
    }
    return result;
  } finally {
    if (control) {
      control.resumeErrorChecking();
    }
  }
}

async function waitForAnimationFrames(page: Page, count: number = 2): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    await new Promise<void>((resolve) => {
      let remaining = frameCount;
      const tick = () => {
        remaining -= 1;
        if (remaining <= 0) {
          resolve();
          return;
        }
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    });
  }, count);
}

export async function waitForUiStability(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await waitForAnimationFrames(page, 2);
}

export async function waitForPageLoadSignals(
  page: Pick<Page, 'waitForLoadState'>,
  options: {
    networkIdleTimeoutMs?: number;
  } = {},
): Promise<void> {
  const networkIdleTimeoutMs = options.networkIdleTimeoutMs ?? NETWORK_IDLE_SETTLE_TIMEOUT_MS;
  const domContentLoadedPromise = page.waitForLoadState('domcontentloaded');
  const networkIdlePromise = page
    .waitForLoadState('networkidle', { timeout: networkIdleTimeoutMs })
    .catch((error) => {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return;
      }
      throw error;
    });

  await Promise.all([domContentLoadedPromise, networkIdlePromise]);
}

export async function reloadAndWaitForPageLoadSignals(
  page: Pick<Page, 'reload' | 'waitForLoadState'>,
  options: {
    networkIdleTimeoutMs?: number;
  } = {},
): Promise<void> {
  const domContentLoadedPromise = waitForPageLoadSignals(page, options);
  await Promise.all([
    domContentLoadedPromise,
    page.reload({ waitUntil: 'commit' }),
  ]);
}

async function loadPersistedModelConfig() {
  const { loadModelConfigState } = await import('../server/modelConfigTomlStore');
  return loadModelConfigState();
}

async function savePersistedModelConfig(state: {
  profiles: Array<Record<string, unknown>>;
  providers: Record<string, Record<string, unknown>>;
  defaultProfileId: string | null;
  fastProfileId: string | null;
}) {
  const { saveModelConfigState } = await import('../server/modelConfigTomlStore');
  await saveModelConfigState(state as any);
}

/**
 * Clear user config file to reset to default state
 * For Electron app, we need to clear the config file directly
 *
 * IMPORTANT: Preserves auth tokens so tests don't require re-login.
 * Auth tokens in config file are used for:
 * - CI bootstrapping (pre-populate before tests)
 * - Cross-instance auth sharing (main app → test app)
 *
 * If page is provided, clears localStorage layout state and reloads
 */
export async function clearUserConfig(page?: Page) {
  try {
    const configPath = CONFIG_PATH;

    if (fs.existsSync(configPath)) {
      // Read existing config to preserve auth tokens
      let existingConfig: any = {};
      let lastParseError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          lastParseError = null;
          break;
        } catch (e) {
          lastParseError = e;
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }

      if (lastParseError) {
        throw new Error(`Could not parse config at ${configPath}`);
      }

      const onboardingState = existingConfig.onboardingState?.completed === true
        ? existingConfig.onboardingState
        : {
            ...createDefaultOnboardingState(),
            completed: true,
            completedStepIds: ['test-bootstrap'],
          };

      // Clear config but preserve auth tokens, theme, and onboarding state for test bootstrapping.
      // userName, onboardingState, and defaultProfileId must be preserved — without them
      // the app shows the "Welcome to Interpreter" onboarding screen instead of the main UI.
      fs.writeFileSync(configPath, JSON.stringify({
        agents: {},
        mcpServers: {},
        builtinTools: {},
        // Preserve auth tokens so tests can bootstrap from config file
        authToken: existingConfig.authToken,
        refreshToken: existingConfig.refreshToken,
        // Preserve theme so window doesn't flash wrong colors
        theme: existingConfig.theme,
        // Preserve onboarding state so tests don't get stuck on welcome screen
        userName: existingConfig.userName,
        onboardingState,
      }, null, 2));
      const existingModelConfig = await loadPersistedModelConfig().catch(() => null);
      if (existingModelConfig) {
        await savePersistedModelConfig({
          profiles: existingModelConfig.profiles as unknown as Array<Record<string, unknown>>,
          providers: existingModelConfig.providers as unknown as Record<string, Record<string, unknown>>,
          defaultProfileId: existingModelConfig.defaultProfileId,
          fastProfileId: null,
        });
      }
      console.log('  ✓ Cleared config file (preserved auth tokens + theme + onboarding + model config)');
    } else {
      console.log('  ✓ No config file to clear');
    }

    // If page provided, clear localStorage layout state and reload
    if (page) {
      await resetLayoutStateForTest(page);
      // Reload - AuthContext will reinitialize (tries localStorage first, then config file)
      // Wrap in error pause to ignore transient errors during reload
      await withErrorPause(page, async () => {
        await reloadAndWaitForPageLoadSignals(page);
      }, 1000);
      console.log('  ✓ Reloaded page with cleared state');
    }
  } catch (err) {
    console.log('  ⚠ Failed to clear config:', err);
  }
}

export async function resetLayoutStateForTest(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return document.readyState === 'complete' || document.readyState === 'interactive';
  }, null, { timeout: 10000 });

  await page.evaluate(() => {
    const api = (window as any).windowingAPI;
    const sessionKey = (window as any).electron?.getWindowSessionKey?.() ?? 'window-browser';
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('workstation.layout.v6.')) {
        localStorage.removeItem(key);
      }
    }
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('workstation.layout.bootstrap.v1.')) {
        sessionStorage.removeItem(key);
      }
    }

    if (api) {
      api.resetLayout();
      const state = api.getLayoutState();
      if (state) {
        localStorage.setItem(`workstation.layout.v6.${sessionKey}`, JSON.stringify(state));
      }
    }

    localStorage.removeItem('workstation.layout.v4');
    localStorage.removeItem('workstation.layout');
    localStorage.removeItem('workstation.layout.v2');
    localStorage.removeItem('workstation.layout.v3');
  });
}

/**
 * Take a screenshot with a descriptive name
 * Saves to the current test run directory
 */
export async function takeScreenshot(page: Page, name: string) {
  const runDir = getTestRunDir();
  const screenshotsDir = path.join(runDir, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const screenshotPath = path.join(screenshotsDir, `${name}.png`);
  try {
    // Take screenshot with short timeout - page might be unstable during streaming
    await page.screenshot({
      path: screenshotPath,
      timeout: 2000
    });
    console.log(`  ✓ Screenshot saved: ${name}.png`);
  } catch (e) {
    // Screenshot failed (page unstable, streaming active, etc.) - not critical
    console.log(`  ⚠ Screenshot skipped: ${name}.png (page busy)`);
  }
}

/**
 * Setup console and error logging for a page
 */
export function setupPageLogging(page: Page, prefix = 'Electron') {
  page.on('console', msg => console.log(`[${prefix}]`, msg.text()));
  page.on('pageerror', error => console.error(`[${prefix} Error]`, error));
}

/**
 * Wait for Electron app to be ready
 * Checks for the default empty-agent state as a readiness indicator
 */
export async function waitForAppReady(
  page: Page,
  options: {
    timeoutMs?: number;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 10000;
  await withErrorPause(page, async () => {
    await waitForPageLoadSignals(page);

    await waitForUiStability(page);

    // Check if the app is ready by looking for the new agent button
    // If not visible after timeout, it's likely an auth issue
    try {
      await page.waitForFunction(({ emptyStateSelector, composerSelector, editorSurfaceSelector, explorerSidebarSelector, persistentLayerSelector }) => {
        const candidates = [
          ...document.querySelectorAll<HTMLElement>(emptyStateSelector),
          ...document.querySelectorAll<HTMLElement>(composerSelector),
          ...document.querySelectorAll<HTMLElement>(editorSurfaceSelector),
          ...document.querySelectorAll<HTMLElement>(explorerSidebarSelector),
          ...document.querySelectorAll<HTMLElement>(persistentLayerSelector),
        ];

        return candidates.some((element) => {
          if (!element.isConnected) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0
          );
        });
      }, {
        emptyStateSelector: sel('agentEmptyStatePage'),
        composerSelector: sel('mainComposerInput'),
        editorSurfaceSelector: sel.editorAgentSurfaceAny(),
        explorerSidebarSelector: sel('explorerSidebar'),
        persistentLayerSelector: sel('persistentLayer'),
      }, { timeout: timeoutMs });
    } catch {
      const readinessDiagnostics = await page.evaluate(({ selectors }) => {
        return {
          href: window.location.href,
          title: document.title,
          bodyText: document.body.innerText.slice(0, 500),
          rootHtml: document.getElementById('root')?.innerHTML.slice(0, 500) ?? null,
          markers: selectors.map((selector) => {
            const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
            return {
            selector,
            count: elements.length,
            samples: elements.slice(0, 3).map((element) => {
              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return {
                connected: element.isConnected,
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                offsetParent: element.offsetParent !== null,
                width: rect.width,
                height: rect.height,
                text: element.innerText.slice(0, 120),
              };
            }),
            };
          }),
        };
      }, {
        selectors: [
          sel('agentEmptyStatePage'),
          sel('mainComposerInput'),
          sel.editorAgentSurfaceAny(),
          sel('explorerSidebar'),
          sel('persistentLayer'),
        ],
      }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      console.log('[waitForAppReady] Readiness markers:', JSON.stringify(readinessDiagnostics));

      // Check if we're on the sign-in screen
      const signInVisible = await page.locator(sel('authSignIn')).isVisible().catch(() => false);
      if (signInVisible) {
        throw new Error(
          'App not ready: Sign-in screen detected. Please log into the app first, then re-run tests. ' +
          'Tests read auth tokens from ~/.interpreter/config.json'
        );
      }
      throw new Error(
        `App not ready: empty agent state not visible after ${Math.round(timeoutMs / 1000)}s. ` +
        'This usually means the app is not signed in yet. Log into the app, then re-run tests. ' +
        `Readiness markers: ${JSON.stringify(readinessDiagnostics)}`
      );
    }
  }, 1000);
}

/**
 * Clear layout state from localStorage and reload to apply
 */
export async function clearLayoutState(page: Page) {
  try {
    await resetLayoutStateForTest(page);
    // Reload the page to ensure the cleared state is used
    // Wrap in error pause to ignore transient errors during reload
    await withErrorPause(page, async () => {
      await reloadAndWaitForPageLoadSignals(page);
    }, 1000);
  } catch (err) {
    console.error('Failed to clear layout state:', err);
  }
}

/**
 * Setup test auth by reading tokens from config file and updating server JWT
 * Fixes the issue where AuthContext can't run properly in test isolation
 */
export async function setupTestAuth(page: Page) {
  try {
    const configPath = CONFIG_PATH;

    if (!fs.existsSync(configPath)) {
      console.log('  ⚠ No config file found, skipping auth setup');
      return;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    if (!config.authToken || !config.refreshToken) {
      console.log('  ⚠ No auth tokens in config file, skipping auth setup');
      return;
    }

    // Call the /api/auth/update-jwt endpoint to set server JWT
    await page.evaluate(async ({ accessToken, refreshToken }) => {
      try {
        const response = await (window as any).electron.apiRequest({
          method: 'POST',
          path: '/api/auth/update-jwt',
          body: {
            access_token: accessToken,
            refresh_token: refreshToken,
          },
        });
        console.log('[Test Auth] Server JWT updated:', response);
      } catch (error) {
        console.error('[Test Auth] Failed to update server JWT:', error);
        throw error;
      }
    }, { accessToken: config.authToken, refreshToken: config.refreshToken });

    console.log('  ✓ Test auth setup complete');
  } catch (err) {
    console.log('  ⚠ Failed to setup test auth:', err);
    throw err;
  }
}

/**
 * Get the server port from the page's electron API
 */
export async function getServerPort(page: Page): Promise<number> {
  const port = await page.evaluate(async () => {
    return await (window as any).electron.getServerPort();
  });
  return port;
}

/**
 * Set the workspace through Electron's session-aware API bridge
 */
export async function setWorkspace(page: Page, workspacePath: string): Promise<void> {
  const response = await page.evaluate(
    async ({ workspacePath }: { workspacePath: string }) => {
      return await (window as typeof window & {
        electron: {
          apiRequest: (request: {
            method: string;
            path: string;
            body?: unknown;
          }) => Promise<{ ok: boolean; status: number; data: unknown }>;
        };
      }).electron.apiRequest({
        method: 'POST',
        path: '/api/workspace',
        body: { path: workspacePath },
      });
    },
    { workspacePath }
  );

  if (!response.ok) {
    throw new Error(`Failed to set workspace: ${response.status} ${JSON.stringify(response.data)}`);
  }

  console.log(`  ✓ Workspace set to: ${workspacePath}`);
}

/**
 * Set workspace with retry logic through Electron's session-aware API bridge.
 * Use this when the server may not be ready immediately (e.g., after app restart).
 */
export async function setWorkspaceWithRetry(
  page: Page,
  workspacePath: string,
  maxRetries: number = 15
): Promise<void> {
  const result = await page.evaluate(
    async ({ workspacePath, maxRetries }) => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          const response = await (window as typeof window & {
            electron: {
              apiRequest: (request: {
                method: string;
                path: string;
                body?: unknown;
              }) => Promise<{ ok: boolean }>;
            };
          }).electron.apiRequest({
            method: 'POST',
            path: '/api/workspace',
            body: { path: workspacePath },
          });
          if (response.ok) {
            return { success: true };
          }
        } catch (e) {
          console.log(`Server not ready, retrying... (${i + 1}/${maxRetries})`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      return { success: false };
    },
    { workspacePath, maxRetries }
  );

  if (!result.success) {
    throw new Error(`Failed to set workspace after ${maxRetries} retries`);
  }

  console.log(`  ✓ Workspace set to: ${workspacePath}`);
}

/**
 * Make an API call through Electron's session-aware API bridge.
 * ALWAYS use this instead of hardcoding localhost:5177.
 *
 * @param page - Playwright page
 * @param method - HTTP method
 * @param path - API path (e.g., '/api/profiles/default')
 * @param body - Optional request body
 * @returns Response with ok, status, and parsed data
 */
export async function apiCall(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      return await (window as typeof window & {
        electron: {
          apiRequest: (request: {
            method: string;
            path: string;
            body?: unknown;
          }) => Promise<{ ok: boolean; status: number; data: unknown }>;
        };
      }).electron.apiRequest({
        method,
        path,
        body,
      });
    },
    { method, path, body }
  );
}

async function rendererFetchApiCall(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const electron = (window as typeof window & {
        electron: {
          getServerPort: () => Promise<number>;
          getWindowSessionKey?: () => string | null;
        };
      }).electron;
      const port = await electron.getServerPort();
      const url = new URL(`http://127.0.0.1:${port}${path}`);
      const windowSessionKey = electron.getWindowSessionKey?.();
      if (windowSessionKey) {
        url.searchParams.set('windowSessionKey', windowSessionKey);
      }

      const response = await fetch(url.toString(), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });

      const raw = await response.text();
      let data: unknown = null;
      if (raw.length > 0) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
      }

      return { ok: response.ok, status: response.status, data };
    },
    { method, path, body },
  );
}

async function removeProfileFromPersistedModelConfig(profileId: string): Promise<void> {
  const config = await loadPersistedModelConfig().catch(() => null);
  if (!config) {
    return;
  }

  await savePersistedModelConfig({
    profiles: config.profiles
      .filter((profile: { id: string }) => profile.id !== profileId) as unknown as Array<Record<string, unknown>>,
    providers: config.providers as unknown as Record<string, Record<string, unknown>>,
    defaultProfileId: config.defaultProfileId === profileId ? null : config.defaultProfileId,
    fastProfileId: config.fastProfileId === profileId ? null : config.fastProfileId,
  });
}

/**
 * Delete a profile created during a test.
 * Missing profiles are ignored so cleanup can run safely in finally blocks.
 */
export async function deleteProfile(page: Page, profileId: string): Promise<void> {
  const response = await apiCall(page, 'DELETE', `/api/profiles/${profileId}`);
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete profile ${profileId}: ${response.status} ${JSON.stringify(response.data)}`);
  }
  await removeProfileFromPersistedModelConfig(profileId);
}

/**
 * Wait for agent response completion while checking for UI errors.
 *
 * CRITICAL: Tests must use this to catch "Something went wrong" errors
 * that might appear during streaming. Without this, tests may appear to
 * pass while the UI is showing an error state.
 *
 * @param page - Playwright page
 * @param typingIndicator - Locator for the typing indicator element
 * @param thread - Locator for the thread container (to check for error messages)
 * @param timeoutMs - Maximum time to wait for response completion (default: 120000ms)
 */
export async function waitForResponseWithErrorCheck(
  page: Page,
  typingIndicator: Locator,
  thread: Locator,
  timeoutMs: number = 120000,
  startTimeoutMs: number = 30000,
): Promise<void> {
  const initialThreadText = await thread.innerText().catch(() => '');
  const initialMessageCount = await thread.locator('[data-message-id]').count().catch(() => 0);
  const initialToolCallCount = await thread.locator('[data-testid^="tool-call-"]').count().catch(() => 0);

  // First wait for typing to start (or error)
  const startResult = await Promise.race([
    typingIndicator.waitFor({ state: 'visible', timeout: startTimeoutMs }).then(() => 'started'),
    thread.locator('text=Something went wrong').waitFor({ state: 'visible', timeout: startTimeoutMs }).then(() => 'error'),
    page.waitForFunction(
      ({ threadSelector, initialText, initialMessages, initialToolCalls }) => {
        const threadEl = document.querySelector(threadSelector);
        if (!threadEl) return false;

        const nextText = threadEl.textContent ?? '';
        const nextMessageCount = threadEl.querySelectorAll('[data-message-id]').length;
        const nextToolCallCount = threadEl.querySelectorAll('[data-testid^="tool-call-"]').length;

        return (
          nextText !== initialText ||
          nextMessageCount > initialMessages ||
          nextToolCallCount > initialToolCalls
        );
      },
      {
        threadSelector: sel.activeAgentThread(),
        initialText: initialThreadText,
        initialMessages: initialMessageCount,
        initialToolCalls: initialToolCallCount,
      },
      { timeout: startTimeoutMs }
    ).then(() => 'started'),
    page.waitForTimeout(startTimeoutMs).then(() => 'timeout')
  ]);

  if (startResult === 'error') {
    throw new Error('UI showed "Something went wrong" - stream validation likely failed');
  }
  if (startResult === 'timeout') {
    throw new Error(`No response started within ${Math.round(startTimeoutMs / 1000)} seconds`);
  }

  const deadline = Date.now() + timeoutMs;

  const canReadThreadViaApi = (threadId: string): boolean => {
    const normalizedThreadId = threadId.startsWith('urn:uuid:')
      ? threadId.slice('urn:uuid:'.length)
      : threadId;
    return /^[0-9a-f-]+$/i.test(normalizedThreadId);
  };

  const getThreadCompletionState = async (): Promise<'no-thread' | 'in-progress' | 'completed'> => {
    const threadId = await getActiveCodexThreadId(page);
    if (!threadId) {
      return 'no-thread';
    }
    if (!canReadThreadViaApi(threadId)) {
      return 'no-thread';
    }

    // Read through renderer fetch so Playwright HTTP route mocks on thread/read
    // apply during E2E tests that stub the chat stream and thread history.
    const threadResponse = await rendererFetchApiCall(
      page,
      'GET',
      `/api/agent/threads/${encodeURIComponent(threadId)}`,
    );
    if (threadResponse.status === 404) {
      return 'in-progress';
    }
    if (!threadResponse.ok) {
      throw new Error(`Failed to read thread ${threadId}: ${threadResponse.status}`);
    }

    const turns = ((threadResponse.data as {
      thread?: { turns?: Array<{ status?: string }> };
    }).thread?.turns ?? []);
    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
    if (!lastTurn?.status || lastTurn.status === 'inProgress') {
      return 'in-progress';
    }
    return 'completed';
  };

  // Wait for the thread to settle after activity, even if the spinner never became visible.
  let endResult: 'completed' | 'error' | 'timeout' = 'timeout';
  while (Date.now() < deadline) {
    const errorVisible = await thread.locator('text=Something went wrong').isVisible().catch(() => false);
    if (errorVisible) {
      endResult = 'error';
      break;
    }

    const threadState = await getThreadCompletionState();
    if (threadState === 'completed') {
      endResult = 'completed';
      break;
    }

    if (threadState === 'no-thread') {
      const settledByQuietUi = await page.evaluate(
        ({ threadSelector, typingSelector, quietMs, initialText, initialMessages, initialToolCalls }) => {
          const threadEl = document.querySelector(threadSelector);
          if (!threadEl) return false;

          const nextText = threadEl.textContent ?? '';
          const nextMessageCount = threadEl.querySelectorAll('[data-message-id]').length;
          const nextToolCallCount = threadEl.querySelectorAll('[data-testid^="tool-call-"]').length;
          const hasActivity = (
            nextText !== initialText ||
            nextMessageCount > initialMessages ||
            nextToolCallCount > initialToolCalls
          );
          if (!hasActivity) return false;

          const typingEl = document.querySelector(typingSelector) as HTMLElement | null;
          const typingVisible = Boolean(
            typingEl &&
            typingEl.offsetParent !== null &&
            getComputedStyle(typingEl).visibility !== 'hidden' &&
            getComputedStyle(typingEl).display !== 'none'
          );

          const stateKey = '__workstationResponseWaitState';
          const state = ((window as typeof window & {
            __workstationResponseWaitState?: Record<string, { signature: string; since: number }>;
          })[stateKey] ??= {});
          const signature = JSON.stringify({
            nextText,
            nextMessageCount,
            nextToolCallCount,
            typingVisible,
          });
          const previous = state[threadSelector];
          const now = Date.now();

          if (!previous || previous.signature !== signature) {
            state[threadSelector] = { signature, since: now };
            return false;
          }

          return !typingVisible && now - previous.since >= quietMs;
        },
        {
          threadSelector: sel.activeAgentThread(),
          typingSelector: sel('typingIndicator'),
          quietMs: 1500,
          initialText: initialThreadText,
          initialMessages: initialMessageCount,
          initialToolCalls: initialToolCallCount,
        },
      );
      if (settledByQuietUi) {
        endResult = 'completed';
        break;
      }
    }

    await page.waitForTimeout(500);
  }

  if (endResult === 'error') {
    throw new Error('UI showed "Something went wrong" during response - stream validation failed');
  }
  if (endResult === 'timeout') {
    throw new Error(`Response did not complete within ${timeoutMs}ms`);
  }
}

export async function getActiveCodexThreadId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const layout = (window as any).__layoutContext?.getState?.() as {
      tree?: {
        kind: 'pane' | 'split';
        id?: string;
        activeTabId?: string;
        children?: unknown[];
      };
      activePaneId?: string | null;
      tabs?: Record<string, {
        type?: string;
        agent?: { session?: { codexThreadId?: string } };
      }>;
    };
    if (!layout?.tree || !layout.tabs) {
      return null;
    }

    const findPane = (node: {
      kind: 'pane' | 'split';
      id?: string;
      activeTabId?: string;
      children?: unknown[];
    } | null | undefined): { activeTabId?: string } | null => {
      if (!node) return null;
      if (node.kind === 'pane') {
        return node.id === layout.activePaneId ? node : null;
      }
      if (!Array.isArray(node.children)) {
        return null;
      }
      for (const child of node.children) {
        const match = findPane(child as {
          kind: 'pane' | 'split';
          id?: string;
          activeTabId?: string;
          children?: unknown[];
        });
        if (match) {
          return match;
        }
      }
      return null;
    };

    const activeThread = document.querySelector('[data-testid^="agent-thread-"][data-active="true"]');
    const activeAgentId = activeThread?.getAttribute('data-agent-id') ?? findPane(layout.tree)?.activeTabId;
    if (!activeAgentId) {
      return null;
    }

    const activeTab = layout.tabs[activeAgentId];
    if (activeTab?.type !== 'agent') {
      return null;
    }

    const threadId = activeTab.agent?.session?.codexThreadId;
    return typeof threadId === 'string' ? threadId : null;
  });
}

/**
 * Wait for file tree to load with at least minItems tree items
 * Uses 'attached' state because react-arborist uses virtualization
 */
export async function waitForFileTreeLoaded(page: Page, minItems = 1): Promise<void> {
  await page.waitForSelector(sel.treeItem(), { state: 'attached', timeout: 10000 });
  await page.waitForFunction(
    (min) => document.querySelectorAll('[role="treeitem"]').length >= min,
    minItems,
    { timeout: 10000 }
  );
}

/**
 * Wait for a specific tree item by name and return its locator
 * Scrolls the virtualized tree until the item is rendered, then returns it.
 */
export async function waitForTreeItem(page: Page, name: string): Promise<Locator> {
  const isDetachedLocatorError = (error: unknown): boolean => (
    error instanceof Error
    && /not attached to the DOM|Element is not attached/i.test(error.message)
  );

  const selector = sel.treeItemByName(name);
  const treeSelector = sel('fileTree');
  const tree = page.locator(treeSelector);

  await tree.waitFor({ state: 'visible', timeout: 10000 });
  await tree.evaluate((element) => {
    const root = element as HTMLElement;
    const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
    let target = root;
    let bestRange = root.scrollHeight - root.clientHeight;

    for (const candidate of candidates) {
      const style = window.getComputedStyle(candidate);
      const scrollRange = candidate.scrollHeight - candidate.clientHeight;
      const canScrollY = (style.overflowY === 'auto' || style.overflowY === 'scroll') && scrollRange > 0;
      if (canScrollY && scrollRange > bestRange) {
        target = candidate;
        bestRange = scrollRange;
      }
    }

    target.scrollTop = 0;
  });

  for (let attempt = 0; attempt < 40; attempt++) {
    const item = page.locator(selector).first();
    if (await item.count()) {
      try {
        await item.scrollIntoViewIfNeeded();
        return item;
      } catch (error) {
        if (!isDetachedLocatorError(error)) {
          throw error;
        }
      }
    }

    const advanced = await tree.evaluate((element) => {
      const root = element as HTMLElement;
      const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
      let container = root;
      let bestRange = root.scrollHeight - root.clientHeight;

      for (const candidate of candidates) {
        const style = window.getComputedStyle(candidate);
        const scrollRange = candidate.scrollHeight - candidate.clientHeight;
        const canScrollY = (style.overflowY === 'auto' || style.overflowY === 'scroll') && scrollRange > 0;
        if (canScrollY && scrollRange > bestRange) {
          container = candidate;
          bestRange = scrollRange;
        }
      }

      const maxScrollTop = container.scrollHeight - container.clientHeight;
      if (maxScrollTop <= 0) return false;

      const step = Math.max(Math.floor(container.clientHeight * 0.8), 48);
      const nextScrollTop = Math.min(maxScrollTop, container.scrollTop + step);
      if (nextScrollTop === container.scrollTop) return false;

      container.scrollTop = nextScrollTop;
      return true;
    });

    if (!advanced) break;
    await page.waitForTimeout(75);
  }

  await page.waitForSelector(selector, { state: 'attached', timeout: 1000 });
  for (let attempt = 0; attempt < 5; attempt++) {
    const item = page.locator(selector).first();
    try {
      await item.scrollIntoViewIfNeeded();
      return item;
    } catch (error) {
      if (!isDetachedLocatorError(error) || attempt === 4) {
        throw error;
      }
      await page.waitForTimeout(50);
    }
  }

  throw new Error(`Failed to stabilize tree item "${name}"`);
}

/**
 * Expand a folder by name if it's not already expanded.
 * Uses clickTreeItem to work around the Playwright/Electron boundingBox() bug.
 */
export async function expandFolder(page: Page, name: string): Promise<void> {
  const folder = await waitForTreeItem(page, name);
  const isExpanded = await folder.getAttribute('aria-expanded');
  if (isExpanded !== 'true') {
    await clickTreeItem(page, folder);
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
  }
}

/**
 * Collapse a folder by name if it's not already collapsed.
 * Uses clickTreeItem to work around the Playwright/Electron boundingBox() bug.
 */
export async function collapseFolder(page: Page, name: string): Promise<void> {
  const folder = await waitForTreeItem(page, name);
  const isExpanded = await folder.getAttribute('aria-expanded');
  if (isExpanded === 'true') {
    await clickTreeItem(page, folder);
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
  }
}

/**
 * Get the count of visible tree items
 */
export async function getTreeItemCount(page: Page): Promise<number> {
  return page.locator('[role="treeitem"]').count();
}

// =============================================================================
// DRAG AND DROP HELPERS FOR FILE TREE TESTING
// =============================================================================

/**
 * Simulate HTML5 drag events on a tree item.
 * Dispatches dragstart, dragover, drop, and dragend events.
 */
export async function simulateTreeDragAndDrop(
  page: Page,
  source: Locator,
  target: Locator,
  options: { skipDrop?: boolean } = {}
): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();

  if (!sourceBox || !targetBox) {
    throw new Error('Could not get bounding boxes for drag and drop');
  }

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;

  // NOTE(victor): Wait for drag listeners to be attached. The useDragHook useEffect sets
  // element.draggable = true at the same time it attaches event listeners. Without this wait,
  // there's a race condition where synthetic events are dispatched before listeners are ready.
  await page.waitForFunction(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const treeItem = el?.closest('[role="treeitem"]');
      return treeItem && (treeItem as HTMLElement).draggable === true;
    },
    { x: sourceX, y: sourceY },
    { timeout: 5000 }
  );

  await page.evaluate(
    ({ sourceX, sourceY, targetX, targetY, skipDrop }) => {
      const getPathFilename = (filePath: string): string => {
        const normalizedPath = filePath.split('\\').join('/');
        const lastSeparatorIndex = normalizedPath.lastIndexOf('/');
        return lastSeparatorIndex >= 0 ? normalizedPath.slice(lastSeparatorIndex + 1) : normalizedPath;
      };

      const sourceEl = document.elementFromPoint(sourceX, sourceY);
      const targetEl = document.elementFromPoint(targetX, targetY);

      if (!sourceEl || !targetEl) {
        throw new Error('Could not find elements at coordinates');
      }

      // Find the treeitem element (might be the element itself or a parent)
      const sourceTreeItem = sourceEl.closest('[role="treeitem"]') || sourceEl;
      const targetTreeItem = targetEl.closest('[role="treeitem"]') || targetEl;

      // Extract drag data from data-path attribute
      const sourcePath = sourceTreeItem.getAttribute('data-path');
      const sourceName = sourcePath ? getPathFilename(sourcePath) : 'unknown';
      const isDirectory = sourceTreeItem.getAttribute('aria-expanded') !== null;

      const dragData = {
        type: 'file',
        sourceContext: 'explorer',
        filePath: sourcePath,
        fileName: sourceName,
        isDirectory,
      };

      const dataTransfer = new DataTransfer();
      dataTransfer.setData('application/json', JSON.stringify(dragData));

      // Dispatch dragstart on source
      sourceTreeItem.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        clientX: sourceX,
        clientY: sourceY,
        dataTransfer,
      }));

      // Dispatch dragenter on target (triggers folder auto-expand timer)
      targetTreeItem.dispatchEvent(new DragEvent('dragenter', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));

      // Dispatch dragover on target
      targetTreeItem.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));

      if (!skipDrop) {
        // Dispatch drop on target
        targetTreeItem.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: targetX,
          clientY: targetY,
          dataTransfer,
        }));
      }

      // Dispatch dragleave to clean up
      targetTreeItem.dispatchEvent(new DragEvent('dragleave', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));

      // Dispatch dragend on source
      sourceTreeItem.dispatchEvent(new DragEvent('dragend', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));
    },
    { sourceX, sourceY, targetX, targetY, skipDrop: options.skipDrop }
  );
}

/**
 * Simulate drag hover over a folder for a specified duration.
 * Used to test folder auto-expand on drag hover (600ms timer in ExplorerNode).
 */
export async function simulateDragHoverOverFolder(
  page: Page,
  source: Locator,
  targetFolder: Locator,
  hoverDurationMs: number
): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await targetFolder.boundingBox();

  if (!sourceBox || !targetBox) {
    throw new Error('Could not get bounding boxes for drag hover');
  }

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;

  // NOTE(victor): Wait for drag listeners - same race condition fix as simulateTreeDragAndDrop
  await page.waitForFunction(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const treeItem = el?.closest('[role="treeitem"]');
      return treeItem && (treeItem as HTMLElement).draggable === true;
    },
    { x: sourceX, y: sourceY },
    { timeout: 5000 }
  );

  // Start dragging
  await page.evaluate(
    ({ sourceX, sourceY, targetX, targetY }) => {
      const getPathFilename = (filePath: string): string => {
        const normalizedPath = filePath.split('\\').join('/');
        const lastSeparatorIndex = normalizedPath.lastIndexOf('/');
        return lastSeparatorIndex >= 0 ? normalizedPath.slice(lastSeparatorIndex + 1) : normalizedPath;
      };

      const sourceEl = document.elementFromPoint(sourceX, sourceY);
      const targetEl = document.elementFromPoint(targetX, targetY);

      if (!sourceEl || !targetEl) {
        throw new Error('Could not find elements at coordinates');
      }

      const sourceTreeItem = sourceEl.closest('[role="treeitem"]') || sourceEl;
      const targetTreeItem = targetEl.closest('[role="treeitem"]') || targetEl;

      const sourcePath = sourceTreeItem.getAttribute('data-path');
      const sourceName = sourcePath ? getPathFilename(sourcePath) : 'unknown';
      const isDirectory = sourceTreeItem.getAttribute('aria-expanded') !== null;

      const dragData = {
        type: 'file',
        sourceContext: 'explorer',
        filePath: sourcePath,
        fileName: sourceName,
        isDirectory,
      };

      const dataTransfer = new DataTransfer();
      dataTransfer.setData('application/json', JSON.stringify(dragData));

      // Start drag
      sourceTreeItem.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        clientX: sourceX,
        clientY: sourceY,
        dataTransfer,
      }));

      // Enter target folder (triggers 600ms auto-expand timer)
      targetTreeItem.dispatchEvent(new DragEvent('dragenter', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));

      // Store dataTransfer for cleanup
      (window as any).__testDragData = { dataTransfer, sourceTreeItem, targetTreeItem, sourceX, sourceY, targetX, targetY };
    },
    { sourceX, sourceY, targetX, targetY }
  );

  // Wait for the specified hover duration
  await page.waitForTimeout(hoverDurationMs);

  // Clean up drag state
  await page.evaluate(() => {
    const data = (window as any).__testDragData;
    if (data) {
      const { dataTransfer, sourceTreeItem, targetTreeItem, targetX, targetY } = data;

      // Leave target
      targetTreeItem.dispatchEvent(new DragEvent('dragleave', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));

      // End drag
      sourceTreeItem.dispatchEvent(new DragEvent('dragend', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));

      delete (window as any).__testDragData;
    }
  });
}

/**
 * Simulate dropping a tab onto a folder in the file tree.
 * Creates proper drag data from tab attributes and drops onto target folder.
 */
export async function simulateTabDropOnFolder(
  page: Page,
  tabLocator: Locator,
  targetFolder: Locator
): Promise<void> {
  const tabBox = await tabLocator.boundingBox();
  const targetBox = await targetFolder.boundingBox();

  if (!tabBox || !targetBox) {
    throw new Error('Could not get bounding boxes for tab drop');
  }

  const sourceX = tabBox.x + tabBox.width / 2;
  const sourceY = tabBox.y + tabBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;

  // Extract tab data from attributes
  const tabData = await tabLocator.evaluate(el => ({
    path: el.getAttribute('data-tab-path'),
    label: el.getAttribute('data-tab-label'),
    type: el.getAttribute('data-tab-type'),
  }));

  if (!tabData.path || tabData.type !== 'file') {
    throw new Error('Tab is not a file tab or missing path');
  }

  // NOTE(victor): Wait for drop listeners on target - same race condition fix
  await page.waitForFunction(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const treeItem = el?.closest('[role="treeitem"]');
      return treeItem && (treeItem as HTMLElement).draggable === true;
    },
    { x: targetX, y: targetY },
    { timeout: 5000 }
  );

  await page.evaluate(
    ({ sourceX, sourceY, targetX, targetY, tabData }) => {
      const sourceEl = document.elementFromPoint(sourceX, sourceY);
      const targetEl = document.elementFromPoint(targetX, targetY);

      if (!sourceEl || !targetEl) {
        throw new Error('Could not find elements at coordinates');
      }

      const targetTreeItem = targetEl.closest('[role="treeitem"]') || targetEl;

      const dragData = {
        type: 'file',
        sourceContext: 'tabs',
        filePath: tabData.path,
        fileName: tabData.label,
        isDirectory: false,
      };

      const dataTransfer = new DataTransfer();
      dataTransfer.setData('application/json', JSON.stringify(dragData));

      // Dispatch dragstart on tab
      sourceEl.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        clientX: sourceX,
        clientY: sourceY,
        dataTransfer,
      }));

      // Dispatch dragenter on folder
      targetTreeItem.dispatchEvent(new DragEvent('dragenter', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));

      // Dispatch dragover on folder
      targetTreeItem.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));

      // Dispatch drop on folder
      targetTreeItem.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));

      // Dispatch dragend
      sourceEl.dispatchEvent(new DragEvent('dragend', {
        bubbles: true,
        cancelable: true,
        clientX: targetX,
        clientY: targetY,
        dataTransfer,
      }));
    },
    { sourceX, sourceY, targetX, targetY, tabData }
  );
}

/**
 * Click a tree item using a real mouse click.
 * Playwright's locator.click() hangs because boundingBox() returns null
 * for react-arborist nodes in Electron. We dispatch mouse events via
 * evaluate so that element lookup + click happen atomically in the same
 * JS frame, avoiding coordinate drift from tree re-renders.
 */
export async function clickTreeItem(_page: Page, locator: Locator) {
  const dataPath = await locator.getAttribute('data-path');
  if (!dataPath) throw new Error('Tree item has no data-path attribute');
  // NOTE(victor): The outer treeitem wrapper and the inner FileSystemProxy both carry
  // the same data-path. The actual file-open onClick is attached to the inner proxy,
  // so target a descendant first instead of dispatching on the inert wrapper.
  const clicked = await locator.evaluate((rootEl, dp: string) => {
    const root = rootEl as HTMLElement;
    const target = (root.querySelector(`[data-path="${dp}"]`) as HTMLElement | null) ?? root;
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    const opts: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    };
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }, dataPath);
  if (!clicked) throw new Error(`Tree item not found in DOM: ${dataPath}`);
}

/**
 * Get the computed background color of an element.
 * Useful for testing selection/active states.
 */
export async function getBackgroundColor(locator: Locator): Promise<string> {
  return locator.evaluate(el => {
    const style = window.getComputedStyle(el);
    return style.backgroundColor;
  });
}

/**
 * Check if an element has any background color set (not transparent).
 */
export async function hasBackgroundColor(locator: Locator): Promise<boolean> {
  const color = await getBackgroundColor(locator);
  return color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent';
}

/**
 * Call a tool via the IPC abstraction.
 * In Electron this uses the real preload `servers.callTool` IPC path.
 * Browser-dev mode falls back to the HTTP IPC bridge.
 *
 * @param page - Playwright page
 * @param serverId - Tool server ID (e.g., 'builtin-filesystem', 'builtin-pdf')
 * @param toolName - Tool name (e.g., 'read_file', 'create_pdf')
 * @param args - Tool arguments
 * @returns Tool result with content array
 */
export async function callTool(
  page: Page,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return page.evaluate(
    async ({ serverId: nextServerId, toolName: nextToolName, args: nextArgs }) => {
      const electronServers = (window as any).electron?.servers;
      if (electronServers?.callTool) {
        return electronServers.callTool(nextServerId, nextToolName, nextArgs);
      }

      const port = await (window as any).electron.getServerPort();
      const res = await fetch(`http://localhost:${port}/api/ipc/servers/callTool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([nextServerId, nextToolName, nextArgs]),
      });

      const payload = await res.json().catch(() => ({ error: 'Unknown error' }));
      if (!res.ok) {
        const message =
          (typeof payload?.error === 'string' && payload.error) ||
          (typeof payload?.content?.[0]?.text === 'string' && payload.content[0].text) ||
          `HTTP ${res.status}`;
        throw new Error(message);
      }

      return payload;
    },
    { serverId, toolName, args },
  );
}

/**
 * Detect whether HTTP tool execution is intentionally disabled by hardening flags.
 * Uses a Node-side fetch to avoid triggering renderer console-error guards.
 */
export async function isHttpToolExecutionDisabled(page: Page): Promise<boolean> {
  const port = await getServerPort(page);
  const res = await fetch(`http://localhost:${port}/api/ipc/servers/callTool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([]),
  });

  if (res.status !== 403) return false;

  const payload = await res.json().catch(() => ({}));
  const message =
    (typeof payload?.error === 'string' && payload.error) ||
    (typeof payload?.content?.[0]?.text === 'string' && payload.content[0].text) ||
    '';

  return message.includes('Tool execution over HTTP is disabled');
}

/**
 * List all tool servers via the IPC abstraction.
 * Uses /api/ipc/servers/list instead of /api/servers
 */
export async function listToolServers(page: Page): Promise<{ servers: any[] }> {
  const port = await getServerPort(page);
  const result = await page.evaluate(
    async ({ port }) => {
      const res = await fetch(`http://localhost:${port}/api/ipc/servers/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([]),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    { port }
  );
  return result;
}
