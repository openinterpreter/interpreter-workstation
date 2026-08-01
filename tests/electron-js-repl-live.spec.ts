import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type BrowserContext, type Page as BrowserPage, type TestInfo } from '@playwright/test';
import { test, expect, pauseErrorChecking, resumeErrorChecking } from './fixtures';
import {
  apiCall,
  deleteProfile,
  getAgentEventsLogPath,
  getTestWorkspace,
  setWorkspace,
  waitForJsonlMatchCount,
} from './helpers';
import { sel } from './selectors';

const LIVE_MODEL_ID = 'openai/gpt-5.4-mini';
const RELAY_BASE_URL = 'http://127.0.0.1:19988';
const EXPECTED_FORM_VALUES = {
  fullName: 'Avery Stone',
  email: 'avery.stone@example.com',
  notes: 'Please send the onboarding packet before Friday.',
};

function resolveStagedRelayDistDir(): string {
  return path.join(process.cwd(), 'resources', 'browser-extension-relay', 'dist');
}

async function loadBrowserLaunchHelpers(): Promise<{
  resolveBrowserExecutablePath: (options?: Record<string, unknown>) => string;
  shouldUseHeadlessByDefault: () => boolean;
  getBrowserLaunchArgs: (options: {
    extensionPath: string;
    userDataDir: string;
    headless: boolean;
  }) => string[];
}> {
  const relayDistDir = resolveStagedRelayDistDir();
  const [browserConfig, browserLaunch] = await Promise.all([
    import(pathToFileURL(path.join(relayDistDir, 'browser-config.js')).href),
    import(pathToFileURL(path.join(relayDistDir, 'browser-launch.js')).href),
  ]);

  return {
    resolveBrowserExecutablePath: browserConfig.resolveBrowserExecutablePath,
    shouldUseHeadlessByDefault: browserConfig.shouldUseHeadlessByDefault,
    getBrowserLaunchArgs: browserLaunch.getBrowserLaunchArgs,
  };
}

async function getExtensionServiceWorker(browserContext: BrowserContext) {
  let serviceWorkers = browserContext.serviceWorkers()
    .filter((worker) => worker.url().startsWith('chrome-extension://'));
  if (serviceWorkers.length === 0) {
    await browserContext.waitForEvent('serviceworker', {
      predicate: (worker) => worker.url().startsWith('chrome-extension://'),
    });
    serviceWorkers = browserContext.serviceWorkers()
      .filter((worker) => worker.url().startsWith('chrome-extension://'));
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    for (const worker of serviceWorkers) {
      const isReady = await worker.evaluate(() => {
        return typeof (globalThis as typeof globalThis & {
          toggleExtensionForActiveTab?: unknown;
        }).toggleExtensionForActiveTab === 'function';
      }).catch(() => false);
      if (isReady) {
        return worker;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    serviceWorkers = browserContext.serviceWorkers()
      .filter((worker) => worker.url().startsWith('chrome-extension://'));
  }

  throw new Error('Interpreter browser extension service worker did not expose toggleExtensionForActiveTab().');
}

async function waitForSharedChromiumSession(): Promise<string> {
  let lastStatus: unknown = null;
  await expect(async () => {
    const response = await fetch(`${RELAY_BASE_URL}/extensions/status`);
    expect(response.ok).toBe(true);
    const body = await response.json();
    lastStatus = body;
    const extensions = Array.isArray(body.extensions) ? body.extensions : [];
    const liveExtensions = extensions.filter((extension: Record<string, unknown>) =>
      Number(extension.activeTargets ?? 0) > 0
    );
    const selectedExtension = liveExtensions.find((extension: Record<string, unknown>) =>
      extension.browser === 'Chromium'
    ) ?? liveExtensions[0];
    expect(selectedExtension, JSON.stringify(lastStatus)).toBeTruthy();
    const browserSessionId = selectedExtension.stableKey ?? selectedExtension.extensionId;
    expect(typeof browserSessionId).toBe('string');
    expect(browserSessionId.length).toBeGreaterThan(0);
  }).toPass({ intervals: [250, 500, 1_000], timeout: 20_000 });

  const response = await fetch(`${RELAY_BASE_URL}/extensions/status`);
  const body = await response.json();
  const extensions = Array.isArray(body.extensions) ? body.extensions : [];
  const liveExtensions = extensions.filter((extension: Record<string, unknown>) =>
    Number(extension.activeTargets ?? 0) > 0
  );
  const selectedExtension = liveExtensions.find((extension: Record<string, unknown>) =>
    extension.browser === 'Chromium'
  ) ?? liveExtensions[0];
  return String(selectedExtension.stableKey ?? selectedExtension.extensionId);
}

async function launchSharedFormTab(testInfo: TestInfo): Promise<{
  browserContext: BrowserContext;
  formPage: BrowserPage;
  browserSessionId: string;
}> {
  const extensionPath = path.join(resolveStagedRelayDistDir(), 'extension');
  if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error(`Missing built extension manifest at ${extensionPath}`);
  }

  const browserProfileDir = path.join(testInfo.outputDir, 'browser-profile');
  fs.mkdirSync(browserProfileDir, { recursive: true });
  const {
    resolveBrowserExecutablePath,
    shouldUseHeadlessByDefault,
    getBrowserLaunchArgs,
  } = await loadBrowserLaunchHelpers();
  const headless = shouldUseHeadlessByDefault();
  const rawArgs = getBrowserLaunchArgs({
    extensionPath,
    userDataDir: browserProfileDir,
    headless,
  });
  const args = rawArgs.filter((arg) => {
    return !(
      arg.startsWith('--user-data-dir=') ||
      arg === '--profile-directory=Default' ||
      arg === 'about:blank' ||
      /^https?:\/\//i.test(arg)
    );
  });

  const browserContext = await chromium.launchPersistentContext(browserProfileDir, {
    executablePath: resolveBrowserExecutablePath({}),
    headless,
    args,
  });

  const [formPage, ...extraPages] = browserContext.pages().length > 0
    ? browserContext.pages()
    : [await browserContext.newPage()];
  await Promise.all(extraPages.map((extraPage) => extraPage.close().catch(() => {})));
  await formPage.setContent(`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Interpreter Browser Control Form</title>
      </head>
      <body>
        <main>
          <h1>Browser Control Form</h1>
          <form id="shared-form">
            <label>
              Full name
              <input name="fullName" autocomplete="name" required />
            </label>
            <label>
              Email
              <input name="email" type="email" autocomplete="email" required />
            </label>
            <label>
              Notes
              <textarea name="notes" required></textarea>
            </label>
            <button type="submit">Submit Form</button>
          </form>
          <p id="result" role="status"></p>
        </main>
        <script>
          window.__submitted = null;
          document.getElementById('shared-form').addEventListener('submit', (event) => {
            event.preventDefault();
            window.__submitted = Object.fromEntries(new FormData(event.currentTarget).entries());
            document.getElementById('result').textContent = 'Submitted';
          });
        </script>
      </body>
    </html>`, { waitUntil: 'domcontentloaded' });
  await formPage.bringToFront();

  const serviceWorker = await getExtensionServiceWorker(browserContext);
  const enableResult = await serviceWorker.evaluate(async () => {
    return await (globalThis as typeof globalThis & {
      toggleExtensionForActiveTab: () => Promise<{ isConnected?: boolean }>;
    }).toggleExtensionForActiveTab();
  });
  if (!enableResult?.isConnected) {
    throw new Error(`Interpreter browser extension failed to attach to the managed tab: ${JSON.stringify(enableResult)}`);
  }

  const browserSessionId = await waitForSharedChromiumSession();
  return { browserContext, formPage, browserSessionId };
}

test('live Electron app can fill an accessible Chromium form through browser-control js_repl', async ({ page }) => {
  test.setTimeout(300_000);

  const profileId = `test-live-js-repl-${Date.now()}`;
  const profileName = `Live js_repl ${profileId}`;
  let profileCreated = false;
  let browserContext: BrowserContext | null = null;

  try {
    await setWorkspace(page, getTestWorkspace());

    const createProfileResponse = await apiCall(page, 'POST', '/api/profiles', {
      id: profileId,
      name: profileName,
      modelId: LIVE_MODEL_ID,
      isBuiltin: false,
      provider: 'hosted',
      providerId: 'builtin:hosted',
    });
    expect(createProfileResponse.ok).toBe(true);
    profileCreated = true;

    const composer = page.locator(sel('mainComposerInput')).first();
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const sharedBrowser = await launchSharedFormTab(test.info());
    browserContext = sharedBrowser.browserContext;

    pauseErrorChecking(page);
    await page.locator(sel('agentSettingsButton')).click();
    const popover = page.locator(sel('settingsPopover'));
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await popover.locator(sel.profileCard(profileId)).click();
    await expect(popover).toBeHidden({ timeout: 5_000 });
    resumeErrorChecking(page);

    const prompt = [
      'Use $browser-control through the `interpreter-app tools builtin-js-repl js_repl` tool to fill and submit the accessible Chromium tab.',
      `Use browser session stable key ${JSON.stringify(sharedBrowser.browserSessionId)}.`,
      'Do not use raw node, direct HTTP requests, file inspection, or any shell commands other than the interpreter-app js_repl calls.',
      'Run browser automation against that browser tab, not against this Electron app UI.',
      `Set Full name to ${JSON.stringify(EXPECTED_FORM_VALUES.fullName)}.`,
      `Set Email to ${JSON.stringify(EXPECTED_FORM_VALUES.email)}.`,
      `Set Notes to ${JSON.stringify(EXPECTED_FORM_VALUES.notes)}.`,
      'Submit the form and wait until the page shows Submitted.',
      'After setupInterpreterBrowserControl succeeds, log BROWSER_CONTROL_RUNTIME_READY.',
      'In the js_repl console output, log BROWSER_FORM_SUBMITTED followed by the submitted form JSON.',
      'After the js_repl call completes, reply with exactly LIVE_JS_REPL_OK.',
    ].join(' ');

    await composer.click();
    await page.keyboard.type(prompt, { delay: 10 });
    await page.keyboard.press('Enter');

    const thread = page.locator(sel.activeAgentThread());
    await Promise.race([
      expect(thread.getByText('LIVE_JS_REPL_OK')).toBeVisible({ timeout: 240_000 }),
      thread.getByText('Something went wrong').waitFor({ state: 'visible', timeout: 240_000 }).then(() => {
        throw new Error('UI showed "Something went wrong" during live js_repl run');
      }),
    ]);

    await expect(async () => {
      const threadText = await thread.innerText();
      expect(threadText).not.toContain('Something went wrong');
      expect(threadText).toContain('LIVE_JS_REPL_OK');
    }).toPass({
      intervals: [500, 1_000, 2_000, 5_000],
      timeout: 60_000,
    });

    const agentEventsPath = getAgentEventsLogPath(test.info().title);
    await waitForJsonlMatchCount(
      agentEventsPath,
      (event) => {
        if (event.kind === 'transcript' && event.type === 'tool_call') {
          return event.toolName === 'js_repl';
        }
        const item = event.notification?.params?.item;
        return (
          event.method === 'item/completed'
          && item?.type === 'commandExecution'
          && item?.status === 'completed'
          && String(item?.command ?? '').includes('js_repl')
          && String(item?.aggregatedOutput ?? '').includes('BROWSER_FORM_SUBMITTED')
        );
      },
      1,
      180_000,
    );

    const agentEvents = fs.readFileSync(agentEventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const jsReplItems = agentEvents
      .map((event) => event.notification?.params?.item)
      .filter((item) => item?.type === 'commandExecution' && String(item.command ?? '').includes('js_repl'));
    const failedItems = jsReplItems.filter((item) => item.status === 'failed');
    if (failedItems.length > 0) {
      console.warn(`js_repl had ${failedItems.length} self-corrected failure(s):`,
        failedItems.map((item) => item.aggregatedOutput));
    }
    expect(jsReplItems.some((item) => item.status === 'completed')).toBe(true);
    const combinedJsReplOutput = jsReplItems
      .map((item) => String(item.aggregatedOutput ?? ''))
      .join('\n');
    expect(combinedJsReplOutput).toContain('BROWSER_CONTROL_RUNTIME_READY');
    expect(combinedJsReplOutput).toContain('BROWSER_FORM_SUBMITTED');

    await expect.poll(async () => {
      return await sharedBrowser.formPage.evaluate(() => {
        return (window as typeof window & {
          __submitted?: Record<string, string> | null;
        }).__submitted ?? null;
      });
    }, { timeout: 10_000 }).toEqual(EXPECTED_FORM_VALUES);
  } finally {
    await browserContext?.close().catch(() => {});
    if (profileCreated) {
      await deleteProfile(page, profileId).catch(() => {});
    }
  }
});
