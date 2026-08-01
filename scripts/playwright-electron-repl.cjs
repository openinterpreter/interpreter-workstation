const fs = require('node:fs');
const path = require('node:path');
const repl = require('node:repl');
const http = require('node:http');
const { execSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { prepareDevElectronBundle } = require('./prepare-dev-electron-bundle-v2.cjs');

const playwrightPackageDir = path.dirname(require.resolve('playwright/package.json'));
const playwrightCorePackageDir = path.dirname(
  require.resolve('playwright-core/package.json', { paths: [playwrightPackageDir] }),
);
const officialPlaywrightElectronLoaderPath = path.join(
  playwrightCorePackageDir,
  'lib',
  'server',
  'electron',
  'loader.js',
);

let electronApp = null;
let page = null;
let lastVideo = null;
const ELECTRON_ENTRY = process.env.PLAYWRIGHT_ELECTRON_ENTRY || '.';
const USE_BUILT_RENDERER = process.env.PLAYWRIGHT_ELECTRON_USE_BUILT_RENDERER === '1'
  || process.env.INTERPRETER_USE_BUILT_RENDERER === 'true';
const ELECTRON_NODE_ENV = process.env.PLAYWRIGHT_ELECTRON_NODE_ENV || (USE_BUILT_RENDERER ? 'production' : 'development');
const ELECTRON_DISPLAY = process.env.PLAYWRIGHT_ELECTRON_DISPLAY?.trim() || process.env.DISPLAY?.trim() || '';
const RECORD_VIDEO_DIR = process.env.PLAYWRIGHT_ELECTRON_RECORD_VIDEO_DIR?.trim() || '';
const RECORD_VIDEO_SIZE = process.env.PLAYWRIGHT_ELECTRON_RECORD_VIDEO_SIZE?.trim() || '';
const APP_WINDOW_TIMEOUT_MS = Number.parseInt(
  process.env.PLAYWRIGHT_ELECTRON_APP_WINDOW_TIMEOUT_MS?.trim() || '90000',
  10,
);
const ACCEPT_ABOUT_BLANK_FALLBACK = process.env.PLAYWRIGHT_ELECTRON_ACCEPT_ABOUT_BLANK_FALLBACK === '1';
const DEBUG_WINDOW_CANDIDATES = process.env.PLAYWRIGHT_ELECTRON_DEBUG_WINDOW_CANDIDATES === '1';
const BASE_VITE_PORT = 5173;
const MAX_VITE_PORT = 5193;

function getDefaultInterpreterAppSupportDir() {
  return path.join(require('node:os').homedir(), 'Library', 'Application Support', 'interpreter');
}

function parseRecordVideoSize(sizeValue) {
  if (!sizeValue) {
    return undefined;
  }

  const match = sizeValue.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid PLAYWRIGHT_ELECTRON_RECORD_VIDEO_SIZE: ${sizeValue}`);
  }

  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function resolveRecordVideoOptions() {
  if (!RECORD_VIDEO_DIR) {
    return undefined;
  }

  const dir = path.resolve(RECORD_VIDEO_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const size = parseRecordVideoSize(RECORD_VIDEO_SIZE);
  return size ? { dir, size } : { dir };
}

function buildElectronLaunchArgs() {
  const args = [ELECTRON_ENTRY, '--no-sandbox', '--disable-dev-shm-usage'];

  if (process.env.PLAYWRIGHT_ELECTRON_DISABLE_GPU === '1') {
    args.push('--disable-gpu');
  }

  if (process.env.PLAYWRIGHT_ELECTRON_DISABLE_SOFTWARE_RASTERIZER === '1') {
    args.push('--disable-software-rasterizer');
  }

  return args;
}

function probeVitePort(port) {
  return new Promise((resolve) => {
    const request = http.get(`http://localhost:${port}/@vite/client`, (response) => {
      const isViteClient = (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300;
      response.destroy();
      resolve(isViteClient);
    });

    request.on('error', () => resolve(false));
    request.end();
  });
}

async function resolveVitePort() {
  if (USE_BUILT_RENDERER) {
    return null;
  }

  const explicitPort = process.env.VITE_PORT?.trim();
  if (explicitPort) {
    return explicitPort;
  }

  for (let port = BASE_VITE_PORT; port <= MAX_VITE_PORT; port += 1) {
    if (await probeVitePort(port)) {
      return String(port);
    }
  }

  return null;
}

function isDevtoolsUrl(url) {
  return typeof url === 'string' && url.startsWith('devtools://');
}

function getWindowPriority(window) {
  if (!window) return -1;

  try {
    const url = window.url();
    if (!url || url === 'about:blank' || isDevtoolsUrl(url)) {
      return 0;
    }

    if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
      return 3;
    }

    if (url.startsWith('file://')) {
      return 2;
    }

    return 1;
  } catch {
    return 0;
  }
}

function getTrackedAppWindows() {
  if (!electronApp) {
    return [];
  }

  return electronApp.windows().filter((window) => {
    if (window.isClosed()) return false;

    try {
      return !isDevtoolsUrl(window.url());
    } catch {
      return true;
    }
  });
}

function scoreBrowserWindow(windowState) {
  if (!windowState) return -1;
  const area = Math.max(0, Number(windowState.bounds?.width || 0) * Number(windowState.bounds?.height || 0));
  return (windowState.visible ? 10_000_000 : 0) + (windowState.focused ? 1_000_000 : 0) + area;
}

async function readPageSnapshot(candidate) {
  try {
    return await candidate.evaluate(() => ({
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyTextLength: document.body?.innerText?.trim()?.length ?? 0,
      bodyTextSample: document.body?.innerText?.trim()?.slice(0, 200) ?? '',
    }));
  } catch {
    return null;
  }
}

async function inspectWindowCandidate(candidate) {
  let url = '';
  try {
    url = candidate.url();
  } catch {
    url = '';
  }

  let title = '';
  try {
    title = await candidate.title();
  } catch {
    title = '';
  }

  let loadStateReached = false;
  try {
    await candidate.waitForLoadState('domcontentloaded', { timeout: 1500 });
    loadStateReached = true;
  } catch {
    // Some Electron windows stay reported as about:blank even after the DOM is usable.
  }

  const snapshot = await readPageSnapshot(candidate);
  const hasUsableUrl = Boolean(url && url !== 'about:blank' && !isDevtoolsUrl(url));
  const isDomReady = snapshot && (snapshot.readyState === 'interactive' || snapshot.readyState === 'complete');
  const hasVisibleContent = Boolean(
    (snapshot?.bodyTextLength ?? 0) > 0
    || (snapshot?.title ?? '').trim()
    || title.trim(),
  );

  return {
    url,
    title,
    loadStateReached,
    snapshot,
    usable: hasUsableUrl || Boolean(isDomReady && hasVisibleContent),
  };
}

function selectBestFallbackWindow(candidates) {
  return candidates
    .filter((candidate) => !candidate.isClosed())
    .sort((left, right) => getWindowPriority(right) - getWindowPriority(left))[0] ?? null;
}

async function describeBrowserWindows() {
  if (!electronApp) {
    return [];
  }

  try {
    return await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map((window) => {
        let url = '';
        try {
          url = window.webContents.getURL();
        } catch {
          url = '';
        }
        return {
          url,
          visible: window.isVisible(),
          focused: window.isFocused(),
          minimized: window.isMinimized(),
          bounds: window.getBounds(),
          title: window.getTitle(),
        };
      }));
  } catch {
    return [];
  }
}

function pickBestBrowserWindowState(windowStates) {
  return [...windowStates]
    .sort((left, right) => scoreBrowserWindow(right) - scoreBrowserWindow(left))[0] ?? null;
}

function isProjectElectronCommand(command) {
  if (!command.includes(process.cwd())) {
    return false;
  }

  return (
    command.includes('playwright-core/lib/server/electron/loader.js')
    || command.includes('node scripts/dev-electron.cjs')
    || command.includes('Electron .')
  );
}

async function killStalePlaywrightElectronProcesses() {
  try {
    const output = execSync('ps -axo pid=,command=', { encoding: 'utf-8' });
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);

    const stalePids = lines
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        const pid = Number(match[1]);
        const command = match[2];
        const isPlaywrightElectron = isProjectElectronCommand(command);

        if (!isPlaywrightElectron || pid === process.pid) {
          return null;
        }

        return pid;
      })
      .filter((pid) => pid !== null);

    if (stalePids.length === 0) return;

    for (const pid of stalePids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process may already be gone.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 800));

    for (const pid of stalePids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  } catch (error) {
    console.warn('[playwright-electron-repl] Failed to cleanup stale Electron processes:', error);
  }
}

async function resolveActiveWindow() {
  if (!electronApp) {
    throw new Error('No Electron app is active');
  }

  const startedAt = Date.now();
  let fallbackWindow = null;
  while (Date.now() - startedAt < APP_WINDOW_TIMEOUT_MS) {
    const trackedWindows = getTrackedAppWindows()
      .sort((left, right) => getWindowPriority(right) - getWindowPriority(left));

    for (const trackedWindow of trackedWindows) {
      if (trackedWindow.isClosed()) continue;

      try {
        const candidate = await inspectWindowCandidate(trackedWindow);
        if (isDevtoolsUrl(candidate.url)) {
          continue;
        }

        fallbackWindow ??= trackedWindow;

        if (DEBUG_WINDOW_CANDIDATES) {
          console.log('[playwright-electron-repl] window candidate', {
            url: candidate.url,
            title: candidate.title,
            loadStateReached: candidate.loadStateReached,
            snapshot: candidate.snapshot,
          });
        }

        if (candidate.usable) {
          return trackedWindow;
        }
      } catch {
        // This handle went stale or was still initializing. Try the next candidate.
      }
    }

    try {
      const nextWindow = await electronApp.waitForEvent('window', { timeout: 1000 });
      if (!nextWindow.isClosed() && getWindowPriority(nextWindow) > 0) {
        return nextWindow;
      }
    } catch {
      // Poll until the visible app window is ready.
    }

    if (ACCEPT_ABOUT_BLANK_FALLBACK && fallbackWindow && Date.now() - startedAt >= 5000) {
      return fallbackWindow;
    }
  }

  throw new Error(`Timed out waiting for a visible Electron app window (${APP_WINDOW_TIMEOUT_MS}ms)`);
}

async function ensurePage() {
  if (page && !page.isClosed()) {
    try {
      if (!isDevtoolsUrl(page.url())) {
        const activeVideo = page.video();
        if (activeVideo) {
          lastVideo = activeVideo;
        }
        return page;
      }
    } catch {
      // Fall through and reacquire a stable app window.
    }
  }

  page = await resolveActiveWindow();

  try {
    await page.waitForLoadState('domcontentloaded');
  } catch {
    const candidate = await inspectWindowCandidate(page);
    if (!candidate.usable) {
      page = await resolveActiveWindow();
      const retried = await inspectWindowCandidate(page);
      if (!retried.usable) {
        await page.waitForLoadState('domcontentloaded');
      }
    }
  }

  page.setDefaultTimeout(5000);
  const activeVideo = page.video();
  if (activeVideo) {
    lastVideo = activeVideo;
  }
  return page;
}

async function launch() {
  if (electronApp) {
    return status();
  }

  await killStalePlaywrightElectronProcesses();
  const vitePort = await resolveVitePort();

  const launchOptions = {
    // On Linux/Xvfb, disabling both GPU and software rasterization can produce a blank white shell.
    args: buildElectronLaunchArgs(),
    env: {
      ...process.env,
      ...(ELECTRON_DISPLAY ? { DISPLAY: ELECTRON_DISPLAY } : {}),
      ...(vitePort ? { VITE_PORT: vitePort } : {}),
      ...(process.platform === 'darwin'
        ? {
            INTERPRETER_HOME: process.env.INTERPRETER_HOME?.trim() || getDefaultInterpreterAppSupportDir(),
            INTERPRETER_USER_DATA_DIR:
              process.env.INTERPRETER_USER_DATA_DIR?.trim() || getDefaultInterpreterAppSupportDir(),
          }
        : {}),
      NODE_ENV: ELECTRON_NODE_ENV,
      ...(USE_BUILT_RENDERER ? { INTERPRETER_USE_BUILT_RENDERER: 'true' } : {}),
      SHOW_WINDOW: process.env.SHOW_WINDOW || '1',
      PLAYWRIGHT_ELECTRON_REPL: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    timeout: 120000,
  };
  const recordVideo = resolveRecordVideoOptions();
  if (recordVideo) {
    launchOptions.recordVideo = recordVideo;
  }

  if (process.platform === 'darwin') {
    const projectRoot = process.cwd();
    launchOptions.executablePath = prepareDevElectronBundle({ projectRoot });
    launchOptions.args.unshift('-r', officialPlaywrightElectronLoaderPath);
  }

  electronApp = await electron.launch(launchOptions);

  page = await ensurePage();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await normalizeAppWindow();

  return status();
}

async function closeApp() {
  if (page && !page.isClosed()) {
    try {
      const activeVideo = page.video();
      if (activeVideo) {
        lastVideo = activeVideo;
      }
    } catch {
      // Ignore stale page state during shutdown.
    }
  }

  if (!electronApp) {
    return;
  }

  await electronApp.close();
  electronApp = null;
  page = null;
}

async function restartApp() {
  await closeApp();
  return launch();
}

async function getVideoHandle() {
  if (page && !page.isClosed()) {
    try {
      const activePage = await ensurePage();
      const activeVideo = activePage.video();
      if (activeVideo) {
        lastVideo = activeVideo;
      }
    } catch {
      // Preserve any previously captured video handle.
    }
  }

  return lastVideo;
}

async function normalizeAppWindow(options = {}) {
  if (!electronApp) {
    throw new Error('No Electron app is active');
  }

  const {
    maximize = true,
    minWidth = 1440,
    minHeight = 900,
  } = options;

  const windowState = await electronApp.evaluate(({ BrowserWindow, screen }, opts) => {
    const windows = BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .filter((window) => {
        try {
          return !window.webContents.getURL().startsWith('devtools://');
        } catch {
          return true;
        }
      });
    const appWindow = windows
      .sort((left, right) => {
        const score = (window) => {
          const bounds = window.getBounds();
          return (window.isVisible() ? 10_000_000 : 0)
            + (window.isFocused() ? 1_000_000 : 0)
            + (bounds.width * bounds.height);
        };
        return score(right) - score(left);
      })[0];

    if (!appWindow) {
      return null;
    }

    if (appWindow.isMinimized()) {
      appWindow.restore();
    }

    if (appWindow.webContents.isDevToolsOpened()) {
      appWindow.webContents.closeDevTools();
    }

    const display = screen.getDisplayMatching(appWindow.getBounds());
    const workArea = display.workArea;

    if (opts.maximize) {
      appWindow.setBounds(workArea);
      appWindow.maximize();
    } else {
      const nextWidth = Math.max(opts.minWidth, appWindow.getBounds().width);
      const nextHeight = Math.max(opts.minHeight, appWindow.getBounds().height);
      appWindow.setSize(nextWidth, nextHeight);
      appWindow.center();
    }

    appWindow.show();
    appWindow.focus();

    return {
      bounds: appWindow.getBounds(),
      contentBounds: appWindow.getContentBounds(),
      isMaximized: appWindow.isMaximized(),
      devToolsOpened: appWindow.webContents.isDevToolsOpened(),
      url: appWindow.webContents.getURL(),
    };
  }, { maximize, minWidth, minHeight });

  page = await ensurePage();
  await page.waitForTimeout(250);
  return windowState;
}

async function status() {
  if (!electronApp) {
    return {
      running: false,
      videoConfigured: Boolean(RECORD_VIDEO_DIR),
      recordVideoDir: RECORD_VIDEO_DIR ? path.resolve(RECORD_VIDEO_DIR) : null,
      recordVideoSize: RECORD_VIDEO_SIZE || null,
      display: ELECTRON_DISPLAY || null,
      appWindowTimeoutMs: APP_WINDOW_TIMEOUT_MS,
    };
  }

  let activePage = await ensurePage();
  if (activePage.isClosed()) {
    page = undefined;
    activePage = await ensurePage();
  }

  let title = '';
  let url = '';
  let snapshot = null;
  try {
    [title, url] = await Promise.all([
      activePage.title(),
      Promise.resolve(activePage.url()),
    ]);
    snapshot = await readPageSnapshot(activePage);
  } catch {
    page = undefined;
    activePage = await ensurePage();
    [title, url] = await Promise.all([
      activePage.title(),
      Promise.resolve(activePage.url()),
    ]);
    snapshot = await readPageSnapshot(activePage);
  }

  const browserWindows = await describeBrowserWindows();
  const windowState = pickBestBrowserWindowState(browserWindows);

  return {
    running: true,
    url,
    title,
    snapshot,
    isClosed: activePage.isClosed(),
    windowState,
    videoConfigured: Boolean(RECORD_VIDEO_DIR),
    recordVideoDir: RECORD_VIDEO_DIR ? path.resolve(RECORD_VIDEO_DIR) : null,
    recordVideoSize: RECORD_VIDEO_SIZE || null,
    display: ELECTRON_DISPLAY || null,
    appWindowTimeoutMs: APP_WINDOW_TIMEOUT_MS,
  };
}

async function shot(filePath = '/tmp/playwright-electron.png') {
  const activePage = await ensurePage();
  await activePage.screenshot({ path: filePath });
  return filePath;
}

async function click(selector) {
  const activePage = await ensurePage();
  await activePage.locator(selector).click();
}

async function bodyText() {
  const activePage = await ensurePage();
  return activePage.locator('body').innerText();
}

async function clickText(textValue, options = {}) {
  const activePage = await ensurePage();
  const {
    exact = false,
    nth = 0,
    timeout = 5000,
  } = options;

  await activePage.getByText(textValue, { exact }).nth(nth).click({ timeout });
}

async function clickTestId(testId, options = {}) {
  const activePage = await ensurePage();
  const { timeout = 5000 } = options;
  await activePage.getByTestId(testId).click({ timeout });
}

async function waitForText(textValue, options = {}) {
  const activePage = await ensurePage();
  const {
    exact = false,
    nth = 0,
    timeout = 5000,
  } = options;

  await activePage.getByText(textValue, { exact }).nth(nth).waitFor({
    state: 'visible',
    timeout,
  });
}

async function fill(selector, value) {
  const activePage = await ensurePage();
  await activePage.locator(selector).fill(value);
}

async function press(key) {
  const activePage = await ensurePage();
  await activePage.keyboard.press(key);
}

async function wait(ms) {
  const activePage = await ensurePage();
  await activePage.waitForTimeout(ms);
}

async function text(selector) {
  const activePage = await ensurePage();
  return activePage.locator(selector).innerText();
}

async function html() {
  const activePage = await ensurePage();
  return activePage.content();
}

async function saveVideo(filePath) {
  const video = await getVideoHandle();
  if (!video) {
    throw new Error('Electron launch is not recording video. Set PLAYWRIGHT_ELECTRON_RECORD_VIDEO_DIR before launch().');
  }

  if (electronApp) {
    await closeApp();
  }

  await video.saveAs(filePath);
  return filePath;
}

async function videoPath() {
  const video = await getVideoHandle();
  if (!video) {
    return null;
  }

  if (electronApp) {
    await closeApp();
  }

  return video.path();
}

function exposeContext(target) {
  Object.defineProperty(target, 'page', {
    configurable: true,
    enumerable: true,
    get: () => page,
  });

  Object.defineProperty(target, 'electronApp', {
    configurable: true,
    enumerable: true,
    get: () => electronApp,
  });

  Object.assign(target, {
    launch,
    closeApp,
    restartApp,
    normalizeAppWindow,
    status,
    shot,
    click,
    bodyText,
    clickText,
    clickTestId,
    fill,
    press,
    wait,
    waitForText,
    text,
    html,
    saveVideo,
    videoPath,
  });
}

(async () => {
  const initialStatus = await launch();
  console.log('Playwright Electron REPL ready');
  console.log(initialStatus);
  console.log(`Electron entry: ${ELECTRON_ENTRY}`);
  console.log(`NODE_ENV: ${ELECTRON_NODE_ENV}`);
  console.log(`Built renderer: ${USE_BUILT_RENDERER ? 'enabled' : 'disabled'}`);
  if (ELECTRON_DISPLAY) {
    console.log(`DISPLAY: ${ELECTRON_DISPLAY}`);
  }
  console.log(`App window timeout: ${APP_WINDOW_TIMEOUT_MS}ms`);
  if (RECORD_VIDEO_DIR) {
    console.log(`Video recording dir: ${path.resolve(RECORD_VIDEO_DIR)}`);
    if (RECORD_VIDEO_SIZE) {
      console.log(`Video recording size: ${RECORD_VIDEO_SIZE}`);
    }
  }
  console.log('Helpers: status(), normalizeAppWindow(opts), shot(path), bodyText(), click(selector), clickText(text, opts), clickTestId(id, opts), fill(selector, value), press(key), wait(ms), waitForText(text, opts), text(selector), html(), saveVideo(path), videoPath(), restartApp(), closeApp()');

  const server = repl.start({
    prompt: 'pw> ',
    useGlobal: false,
    ignoreUndefined: true,
  });

  exposeContext(server.context);

  server.on('exit', async () => {
    await closeApp();
    process.exit(0);
  });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
