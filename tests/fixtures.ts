import { test as base, ElectronApplication, Page } from '@playwright/test';
import { addCoverageReport } from 'monocart-reporter';
import path from 'path';
import fs from 'fs';
import { recordTest, getTestRunDir } from './test-recorder';
import { ElectronInstanceManager } from './electron-instance';
import { reloadAndWaitForPageLoadSignals, setupTestAuth, resetLayoutStateForTest, waitForAppReady, waitForUiStability } from './helpers';
import { setupFileMocks, clearFileMocks } from './mocks/fileMocks';
import { buildTestBootstrapProfile } from '../shared/testBootstrapProfile';
import { normalizeCoverageEntries } from './coverage-urls';
import { createDefaultOnboardingState } from '../shared/types/onboardingState';

/**
 * Test data fixtures for E2E tests
 */

// UI text/labels
export const UI_TEXT = {
  settingsButton: 'Settings',
  addToolsButton: '+ Add Tools',
  toolsSection: 'Tools',
};

// Timeouts (in milliseconds)
export const TIMEOUTS = {
  short: 5000,      // 5 seconds
  medium: 15000,    // 15 seconds
  long: 30000,      // 30 seconds
};

// A clean Windows runner can spend roughly 40 seconds creating the first main
// renderer and another 60-75 seconds starting OIX for the first time. Keep the
// individual window, request, and readiness deadlines below; this larger budget
// only lets those independently bounded setup stages complete cumulatively.
const PAGE_FIXTURE_TIMEOUT_MS = (
  process.platform === 'win32'
  && Boolean(process.env.CI || process.env.GITHUB_ACTIONS)
) ? 180000 : 120000;

/**
 * Pause error checking during test setup operations (like changing workspace).
 * Call resumeErrorChecking() after the operation completes and the app stabilizes.
 */
export function pauseErrorChecking(page: Page): void {
  const control = (page as any).__testErrorControl;
  if (control) {
    control.pauseErrorChecking();
  }
}

/**
 * Resume error checking after a setup operation completes.
 */
export function resumeErrorChecking(page: Page): void {
  const control = (page as any).__testErrorControl;
  if (control) {
    control.resumeErrorChecking();
  }
}

/**
 * Run a setup operation with error checking paused.
 * Errors that occur during the operation are ignored.
 * After the operation and stabilization delay, error checking resumes.
 */
export async function withSetupPhase<T>(
  page: Page,
  operation: () => Promise<T>,
  stabilizationDelayMs: number = 500
): Promise<T> {
  pauseErrorChecking(page);
  try {
    const result = await operation();
    if (stabilizationDelayMs > 0) {
      await waitForUiStability(page);
    }
    return result;
  } finally {
    resumeErrorChecking(page);
  }
}

// Electron test fixture with app and page
// electronApp uses 'worker' scope so tests can opt into the shared app instance,
// but it must stay lazy. Voice specs set launch env in file-level beforeAll hooks,
// so auto-starting here would launch once with the wrong signature and force a
// relaunch inside the page fixture.
// page uses 'test' scope so each test gets a fresh page

export const test = base.extend<{}, { electronApp: ElectronApplication }>({
  electronApp: [async ({}, use) => {
    // Get or create the shared Electron instance
    const electronApp = await ElectronInstanceManager.getInstance();

    // Use the app (no cleanup - handled by global teardown)
    await use(electronApp);
  }, { scope: 'worker', timeout: 600000 }],

  page: [async ({}, use, testInfo) => {
    // === UNIFIED LOGGING SETUP - MUST BE FIRST ===
    // Redirect backend logs to per-test log file BEFORE anything else
    const testName = testInfo.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const testRunDir = getTestRunDir();
    const logFilePath = path.join(testRunDir, 'logs', `${testName}.log`);

    // Create log stream for this test
    const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
    const logToFile = (prefix: string, text: string) => {
      const timestamp = new Date().toISOString();
      logStream.write(`[${timestamp}] [${prefix}] ${text}\n`);
    };

    // Print log paths immediately
    console.log(`📝 Test log: ${logFilePath}`);
    console.log(`📝 Agent log: ${logFilePath.replace(/\.log$/, '.agent.log')}`);
    console.log(`📝 Agent events: ${logFilePath.replace(/\.log$/, '.agent-events.jsonl')}`);
    logToFile(
      'TEST',
      `begin title=${JSON.stringify(testInfo.title)} file=${JSON.stringify(`${testInfo.file}:${testInfo.line}`)} log=${JSON.stringify(logFilePath)} agentLog=${JSON.stringify(logFilePath.replace(/\.log$/, '.agent.log'))} agentEvents=${JSON.stringify(logFilePath.replace(/\.log$/, '.agent-events.jsonl'))}`,
    );

    // Redirect backend logs NOW, before any app interaction
    let electronApp: any = null;
    let backendRedirected = false;
    try {
      electronApp = await ElectronInstanceManager.getInstance();
      await electronApp.evaluate((_electron: any, logPath: string) => {
        (global as any).__testLogging?.setLogFile(logPath);
        (global as any).__agentLogging?.setLogFile(logPath);
      }, logFilePath);
      backendRedirected = true;
      logToFile(
        'LOGGER',
        `redirected backendLog=${JSON.stringify(logFilePath)} agentLog=${JSON.stringify(logFilePath.replace(/\.log$/, '.agent.log'))} agentEvents=${JSON.stringify(logFilePath.replace(/\.log$/, '.agent-events.jsonl'))}`,
      );
    } catch (err) {
      logToFile('LOGGER', `Failed to redirect backend logs: ${err}`);
    }

    // Helper function to check if error indicates app crash
    const isCrashError = (err: any): boolean => {
      const errMsg = err?.message || '';
      return errMsg.includes('Application exited') ||
             errMsg.includes('Target closed') ||
             errMsg.includes('frame was detached') ||
             errMsg.includes('ERR_ABORTED') ||
             errMsg.includes('closed');
    };

    async function isMainAppWindow(page: Page): Promise<boolean> {
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 1000 });
        const pageUrl = page.url();
        if (
          pageUrl.includes('/apps/interpreter-overlay/renderer/')
          || pageUrl.endsWith('/overlay.html')
          || pageUrl.endsWith('/world.html')
        ) {
          return false;
        }
        const isAppRendererUrl = pageUrl.includes('/dist/index.html')
          || /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(pageUrl);
        if (!isAppRendererUrl) {
          return false;
        }
        return await page.evaluate(() => {
          return Boolean(
            document.getElementById('root')
            && (window as typeof window & {
              electron?: {
                getServerPort?: () => Promise<number>;
              };
            }).electron?.getServerPort,
          );
        });
      } catch {
        return false;
      }
    }

    // Helper to get the actual workstation renderer window.
    // The app also creates hidden utility windows, so firstWindow() is not reliable.
    const getWorkingPage = async (): Promise<Page> => {
      const app = await ElectronInstanceManager.getInstance();
      // Voice-enabled Electron relaunches can spend tens of seconds rebuilding
      // startup state before the main renderer appears.
      const deadline = Date.now() + 60000;

      while (Date.now() < deadline) {
        const pages = app.windows();
        for (const page of pages) {
          if (await isMainAppWindow(page)) {
            return page;
          }
        }

        try {
          const nextWindow = await app.waitForEvent('window', { timeout: 1000 });
          if (await isMainAppWindow(nextWindow)) {
            return nextWindow;
          }
        } catch {
          // Keep polling existing windows until the deadline expires.
        }
      }

      throw new Error('Timed out waiting for the main workstation renderer window');
    };

    // Track console errors - only fail AFTER setup completes
    const consoleErrors: string[] = [];
    let setupComplete = false;
    let errorHandler: ((msg: any) => void) | null = null;

    // Setup console handler - stores reference so we can remove it later
    // NOTE: This handler is ONLY for tracking errors to fail tests, NOT for logging
    // Renderer logs go to the unified log file via preload IPC -> main.ts
    const setupConsoleHandler = (p: Page) => {
      // Create the handler function
      errorHandler = (msg: any) => {
        const text = msg.text();
        const type = msg.type();
        const location = msg.location?.();
        const source = location?.url
          ? ` [source: ${location.url}${Number.isInteger(location.lineNumber) ? `:${location.lineNumber + 1}` : ''}]`
          : '';
        const diagnostic = `${text}${source}`;
        // DO NOT console.log here - it would duplicate logs captured by preload IPC

        // Collect console errors
        if (type === 'error') {
          // NOTE(victor): Skip auth-related noise -- CI has no valid Supabase
          // tokens so background refresh returns 400 / fails to fetch.
          // Also skip Sentry SDK errors -- it can't establish IPC in e2e tests.
          if (
            text.includes('Failed to fetch') ||
            text.includes('Invalid Refresh Token') ||
            text.includes('AuthApiError') ||
            text.includes('Sentry SDK failed') ||
            text.includes('Registration failed with InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state.') ||
            text.includes('net::ERR_UNKNOWN_URL_SCHEME') ||
            text.includes('net::ERR_INCOMPLETE_CHUNKED_ENCODING') ||
            text.includes('LocalFileGetSaved being called too frequently') ||
            text.includes('Potential permissions policy violation: autoplay is not allowed') ||
            text.includes('Potential permissions policy violation: camera is not allowed') ||
            text.includes('Potential permissions policy violation: microphone is not allowed') ||
            text.includes('Potential permissions policy violation: fullscreen is not allowed') ||
            text.includes('Potential permissions policy violation: display-capture is not allowed')
          ) return;

          consoleErrors.push(diagnostic);
          // Only fail test immediately if setup is complete
          // During setup, transient network errors are expected (reload, etc.)
          if (setupComplete) {
            throw new Error(`Console error detected: ${diagnostic}`);
          }
        }
      };
      p.on('console', errorHandler);

      // Expose control functions on the page for tests to use during their beforeEach
      // This allows tests to temporarily pause error checking during workspace changes, etc.
      (p as any).__testErrorControl = {
        pauseErrorChecking: () => {
          setupComplete = false;
        },
        resumeErrorChecking: () => {
          setupComplete = true;
        },
      };
    };

    // Full setup function - returns true if successful, false if app crashed
    const doSetup = async (p: Page): Promise<{ success: boolean; crashed: boolean }> => {
      try {
        // Reset the live layout before reload so the old renderer cannot flush
        // stale tabs back into storage during pagehide.
        await resetLayoutStateForTest(p);
        console.log('  ✓ Reset layout state');

        // Setup test auth BEFORE reload to ensure server JWT is set
        await setupTestAuth(p);

        // Complete onboarding: set user name + default profile
        // Without both, the app shows the "Welcome to Interpreter" screen
        // instead of the main UI with the agent composer.
        const port = await p.evaluate(async () => {
          return await (window as any).electron.getServerPort();
        });
        const bootstrapProfile = buildTestBootstrapProfile();
        const completedOnboardingState = {
          ...createDefaultOnboardingState(),
          completed: true,
          completedStepIds: ['test-bootstrap'],
        };
        await p.evaluate(async ({ port, bootstrapProfile, completedOnboardingState }: { port: number; bootstrapProfile: any; completedOnboardingState: any }) => {
          const request = async (path: string, init?: RequestInit): Promise<any> => {
            const controller = new AbortController();
            // A first OIX app-server initialization can take roughly 60-75s on
            // a cold Windows runner. Bound every bootstrap request so a broken
            // server still fails, while allowing a healthy cold start to finish.
            const timeoutMs = 90_000;
            const timeoutId = window.setTimeout(
              () => controller.abort(new Error(`${path} timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
            let response: Response;
            try {
              response = await fetch(`http://localhost:${port}${path}`, {
                ...init,
                signal: controller.signal,
              });
            } finally {
              window.clearTimeout(timeoutId);
            }
            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`${path} failed: ${response.status} ${errorText}`);
            }
            return response.json().catch(() => null);
          };

          const waitForPersistedProfile = async (expectedProfileId: string): Promise<string> => {
            const deadline = Date.now() + 5000;

            while (Date.now() < deadline) {
              const profileList = await request('/api/profiles');
              const persistedProfile = profileList?.profiles?.find(
                (profile: { id?: string } | null | undefined) => profile?.id === expectedProfileId,
              );

              if (persistedProfile?.id) {
                return persistedProfile.id;
              }

              await new Promise((resolve) => setTimeout(resolve, 100));
            }

            throw new Error(`Profile ${expectedProfileId} was created but never became readable`);
          };

          // Set user name (required for onboarding)
          await request('/api/ipc/userName/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(['TestUser']),
          });

          // Ensure there is at least one profile, then set it as default
          const profileList = await request('/api/profiles');
          let profileId =
            (profileList?.defaultProfileId as string | null | undefined) ??
            (profileList?.profiles?.[0]?.id as string | undefined);

          if (!profileId) {
            const createdProfileId = bootstrapProfile.id;
            await request('/api/profiles', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(bootstrapProfile),
            });

            profileId = await waitForPersistedProfile(createdProfileId);
          }

          if (profileList?.defaultProfileId !== profileId) {
            await request('/api/profiles/default', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ profileId }),
            });
          }

          // Match the real onboarding completion order: model/profile writes
          // finish first, then the durable completion marker is written last.
          // Writing this earlier allowed a cold Windows profile bootstrap to
          // replace it with an older config snapshot and reopen onboarding.
          await request('/api/ipc/onboardingState/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([completedOnboardingState]),
          });

          const persistedOnboarding = await request('/api/ipc/onboardingState/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([]),
          });
          if (persistedOnboarding?.state?.completed !== true) {
            throw new Error('Onboarding completion state did not persist');
          }
        }, { port, bootstrapProfile, completedOnboardingState });

        // Reload to ensure fresh state
        await reloadAndWaitForPageLoadSignals(p);
        await waitForUiStability(p);
        // The very first shared-app launch on macOS CI can take longer to reveal
        // the main shell after auth/profile bootstrap than individual tests allow.
        // Warm the renderer once here so smoke specs don't fail on cold-start only.
        await waitForAppReady(p, { timeoutMs: 20000 });
        return { success: true, crashed: false };
      } catch (err: any) {
        const crashed = isCrashError(err);
        if (crashed) {
          console.log('  ⚠ App crashed during setup operation');
          return { success: false, crashed };
        }
        // NOTE(victor): Must return here, not throw. The retry loop below
        // handles both crash and non-crash failures. PR #946 (4832a809)
        // accidentally changed this from a return to a throw, which made
        // non-crash errors (e.g. waitForAppReady timeout) bypass the retry
        // loop entirely. Restoring the original behavior from 5aa22d88.
        console.log('  ⚠ Setup error (non-crash):', (err as Error).message?.slice(0, 200));
        return { success: false, crashed: false };
      }
    };

    // Try to get page and setup with retry on crash OR non-crash failures.
    // Previously only crashes were retried; non-crash errors (e.g. waitForAppReady
    // timeout after shell-permission tests leave the app slow to recover) threw
    // immediately, causing flaky CI failures. Now both paths retry once with a
    // fresh reload, giving the app a second chance to stabilize.
    let page!: Page; // Definite assignment - will be set or throw on final failure
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      // Get working page (handles dead instances)
      try {
        page = await getWorkingPage();
        setupConsoleHandler(page);
      } catch (err: any) {
        if (isCrashError(err)) {
          console.log(`  🔄 App was dead on attempt ${attempt}, invalidating...`);
          ElectronInstanceManager.invalidate();
          consoleErrors.length = 0;
          if (attempt < 2) continue;
          lastError = err;
          break;
        }
        throw err; // Non-crash error, fail immediately
      }

      // Try setup
      const result = await doSetup(page);
      if (result.success) {
        break;
      }

      if (attempt < 2) {
        if (result.crashed) {
          console.log(`  🔄 App crashed during setup (attempt ${attempt}), getting fresh instance...`);
          ElectronInstanceManager.invalidate();
        } else {
          console.log(`  🔄 Setup failed (attempt ${attempt}), retrying...`);
        }
        consoleErrors.length = 0;
        continue;
      }

      lastError = new Error(
        result.crashed ? 'App crashed during setup after retries' : 'App setup failed after retries',
      );
      break;
    }

    if (lastError) {
      throw lastError;
    }

    // Setup complete - now start failing on console errors
    setupComplete = true;

    // Auto-enable file mocks in CI environment
    const isCI = process.env.CI || process.env.GITHUB_ACTIONS;
    if (isCI) {
      await setupFileMocks(page, { simulateUIUpdate: true });
      logToFile('TEST', 'File operation mocks enabled (CI mode)');
    }

    // Check if any errors occurred during setup that we should report
    if (consoleErrors.length > 0) {
      console.log(`  ⚠ ${consoleErrors.length} console errors during setup (not failing test):`);
      consoleErrors.forEach(e => console.log(`    - ${e.substring(0, 100)}...`));
      logToFile(
        'SETUP_WARN',
        `consoleErrors=${consoleErrors.length} sample=${JSON.stringify(consoleErrors[0]?.slice(0, 300) ?? '')}`,
      );
      consoleErrors.length = 0; // Clear for test phase
    }

    // Start coverage collection BEFORE test runs
    await Promise.all([
      page.coverage.startJSCoverage({
        resetOnNavigation: false,
        reportAnonymousScripts: true,
      }),
      page.coverage.startCSSCoverage({
        resetOnNavigation: false,
      })
    ]);

    // Start video recording
    const recorder = await recordTest(page, testName);

    // NOTE: Renderer console logs are captured via preload.ts IPC -> main.ts -> log file
    // Do NOT add a page.on('console') handler here - it would duplicate logs

    logToFile('TEST', `Starting test: ${testInfo.title}`);
    logToFile('TEST', `File: ${testInfo.file}:${testInfo.line}`);

    // Use the page (run the test)
    await use(page);

    // Test finished -- stop failing on console errors during teardown.
    // The Electron app may close between tests, producing transient network
    // errors (ERR_INCOMPLETE_CHUNKED_ENCODING, chat "network error", etc.)
    // that are not application bugs.
    setupComplete = false;

    // Stop video recording
    await recorder.stop();

    // Clear file mocks if they were set up
    if (isCI) {
      await clearFileMocks(page);
    }

    // Log test result and any errors
    if (testInfo.error) {
      logToFile('TEST_ERROR', `Test FAILED: ${testInfo.title}`);
      logToFile('TEST_ERROR', `Error: ${testInfo.error.message}`);
      if (testInfo.error.stack) {
        logToFile('TEST_ERROR', `Stack: ${testInfo.error.stack}`);
      }
    } else {
      logToFile('TEST', `Test PASSED: ${testInfo.title}`);
    }

    // Finalize log file
    logToFile('TEST', `Test completed: ${testInfo.title}`);
    logToFile(
      'TEST',
      `end status=${testInfo.status} durationMs=${testInfo.duration} retry=${testInfo.retry} attachments=${testInfo.attachments.length} hasError=${testInfo.error ? 'true' : 'false'}`,
    );

    // Reset backend logging to session.log (before next test)
    if (backendRedirected) {
      try {
        await electronApp.evaluate(() => {
          (global as any).__testLogging?.resetLogFile();
          (global as any).__agentLogging?.resetLogFile();
        });
        logToFile('LOGGER', 'Backend logs reset to session.log');
      } catch {
        // Ignore if __testLogging not available
      }
    }

    // Remove error handler (important - prevents stale handler affecting next test)
    if (errorHandler) {
      page.off('console', errorHandler);
    }
    logStream.end();
    console.log(`✅ Log saved: ${testName}.log`);

    // Stop coverage and add to report AFTER test completes
    try {
      const [jsCoverage, cssCoverage] = await Promise.all([
        page.coverage.stopJSCoverage(),
        page.coverage.stopCSSCoverage()
      ]);

      const coverageList = normalizeCoverageEntries([...jsCoverage, ...cssCoverage]);

      // Add coverage to monocart report
      await addCoverageReport(coverageList, testInfo);
    } catch (error) {
      console.error('Error collecting coverage:', error);
    }

    // DON'T close the page - keep it open for next tests to reuse
    // Cleanup happens when Electron instance closes
  }, { scope: 'test', timeout: PAGE_FIXTURE_TIMEOUT_MS }],
});

export { expect } from '@playwright/test';
export type { Page } from '@playwright/test';
