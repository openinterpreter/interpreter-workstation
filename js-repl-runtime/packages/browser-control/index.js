const DEFAULT_ENDPOINT = "http://127.0.0.1:19988";
const EXTENSION_URL_PREFIX = "chrome-extension://";
const DEFAULT_SCREENSHOT_TYPE = "png";
const SESSION_PREFIXES_WITH_TARGET_SUFFIX = ["install:", "browser:", "connection:"];

// NOTE(victor): Workstation browser context exposes tab ids as
// <session-key>:<target-id>, but the relay CDP endpoint accepts the browser
// session key only. Normalize against live /extensions/status first so stale or
// ambiguous ids fail at the relay, while known target-suffixed ids connect with
// the stable session key. Keep this package dependency-free because it is copied
// into the bundled js_repl runtime.

function isLivePageTarget(target) {
  return target?.type === "page" && target.url && !target.url.startsWith(EXTENSION_URL_PREFIX);
}

function asObject(value) {
  return value && typeof value === "object" ? value : null;
}

function asSessionId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pageTargetId(page) {
  return typeof page?.targetId === "function" ? asSessionId(page.targetId()) : "";
}

function chromeTabRefParts(tabRef) {
  const value = asSessionId(tabRef);
  const marker = ":chrome-tab:";
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex <= 0) {
    return null;
  }
  const prefix = value.slice(0, markerIndex);
  const chromeTabId = Number(value.slice(markerIndex + marker.length));
  if (!Number.isInteger(chromeTabId) || chromeTabId < 1) {
    return null;
  }
  return { prefix, chromeTabId };
}

function browserSelectionFromStatus(candidate, sessions = []) {
  const requestedSessionId = asSessionId(candidate);
  if (!requestedSessionId || !Array.isArray(sessions)) {
    return null;
  }

  const requestedChromeTab = chromeTabRefParts(requestedSessionId);

  for (const rawSession of sessions) {
    const session = asObject(rawSession);
    if (!session) {
      continue;
    }

    const extensionId = asSessionId(session.extensionId);
    const sessionKey = asSessionId(session.stableKey) || extensionId;
    if (!sessionKey) {
      continue;
    }

    if (requestedSessionId === sessionKey || requestedSessionId === extensionId) {
      return { sessionId: sessionKey };
    }

    const targets = Array.isArray(session.targets) ? session.targets : [];
    for (const rawTarget of targets) {
      const target = asObject(rawTarget);
      if (!target) {
        continue;
      }
      const targetId = asSessionId(target.targetId);
      if (!targetId) {
        continue;
      }
      if (
        requestedSessionId === targetId
        || requestedSessionId === `${sessionKey}:${targetId}`
        || (extensionId && requestedSessionId === `${extensionId}:${targetId}`)
      ) {
        return { sessionId: sessionKey, targetId, url: asSessionId(target.url) || undefined };
      }
    }

    if (requestedChromeTab && (requestedChromeTab.prefix === sessionKey || requestedChromeTab.prefix === extensionId)) {
      const windows = Array.isArray(session.browserTabs?.windows) ? session.browserTabs.windows : [];
      for (const rawWindow of windows) {
        const tabs = Array.isArray(asObject(rawWindow)?.tabs) ? rawWindow.tabs : [];
        for (const rawTab of tabs) {
          const tab = asObject(rawTab);
          if (!tab || tab.chromeTabId !== requestedChromeTab.chromeTabId) {
            continue;
          }
          const targetId = asSessionId(tab.targetId);
          return {
            sessionId: sessionKey,
            targetId: targetId || undefined,
            chromeTabId: requestedChromeTab.chromeTabId,
            url: asSessionId(tab.url) || undefined,
          };
        }
      }
    }
  }

  return null;
}

function browserSessionIdFromStatus(candidate, sessions = []) {
  return browserSelectionFromStatus(candidate, sessions)?.sessionId ?? null;
}

function stripKnownTargetSuffix(sessionId) {
  const lastColon = sessionId.lastIndexOf(":");
  if (lastColon <= 0) {
    return sessionId;
  }

  const sessionPrefix = sessionId.slice(0, lastColon);
  return SESSION_PREFIXES_WITH_TARGET_SUFFIX.some((knownPrefix) => sessionPrefix.startsWith(knownPrefix))
    ? sessionPrefix
    : sessionId;
}

function fallbackBrowserSelection(candidate) {
  const sessionId = asSessionId(candidate);
  if (!sessionId) {
    return null;
  }
  const strippedSessionId = stripKnownTargetSuffix(sessionId);
  return { sessionId: strippedSessionId };
}

function findRequestedPage(pages, selection) {
  const targetId = asSessionId(selection?.targetId);
  if (targetId) {
    return pages.find((page) => pageTargetId(page) === targetId) ?? null;
  }

  const url = asSessionId(selection?.url);
  if (url) {
    return pages.find((page) => page.url() === url) ?? null;
  }

  return null;
}

function createImage(bytes, mimeType) {
  return {
    toBase64() {
      return Buffer.from(bytes).toString("base64");
    },
    toDataURL() {
      return `data:${mimeType};base64,${this.toBase64()}`;
    },
  };
}

function normalizeTimeout(options = {}) {
  const { timeoutMs, ...rest } = options ?? {};
  return timeoutMs == null ? rest : { ...rest, timeout: timeoutMs };
}

function normalizeLoadStateOptions(options = {}) {
  return {
    timeout: options.timeoutMs,
  };
}

function normalizeScreenshotOptions(options = {}) {
  return {
    ...options,
    type: options.type ?? DEFAULT_SCREENSHOT_TYPE,
  };
}

function mapMouseButton(button) {
  if (button === 2) return "middle";
  if (button === 3) return "right";
  return "left";
}

async function withKeyboardModifiers(page, modifiers = [], action) {
  const keys = modifiers.map((key) => key === "ControlOrMeta" ? process.platform === "darwin" ? "Meta" : "Control" : key);
  for (const key of keys) {
    await page.keyboard.down(key);
  }
  try {
    return await action();
  } finally {
    for (const key of keys.reverse()) {
      await page.keyboard.up(key);
    }
  }
}

function toKeyboardShortcut(keys = []) {
  return keys
    .map((key) => key === "ControlOrMeta" ? process.platform === "darwin" ? "Meta" : "Control" : key)
    .join("+");
}

class InterpreterTab {
  constructor(runtime, page) {
    this.runtime = runtime;
    this.page = page;
    this.id = runtime.idForPage(page);
    this.playwright = createPlaywrightApi(this);
    this.cua = createCuaApi(this);
    this.dev = createDevApi(this);
    this.clipboard = createClipboardApi(this);
  }

  async goto(url) {
    await this.page.goto(url);
  }

  async reload() {
    await this.page.reload();
  }

  async back() {
    await this.page.goBack();
  }

  async forward() {
    await this.page.goForward();
  }

  async close() {
    await this.page.close();
  }

  async title() {
    return await this.page.title();
  }

  async url() {
    return this.page.url();
  }
}

function createPlaywrightApi(tab) {
  const page = tab.page;
  return {
    async domSnapshot() {
      return await page.locator("body").ariaSnapshot();
    },
    async expectNavigation(action, options = {}) {
      const navigation = page.waitForURL(options.url ?? "**", normalizeTimeout({
        timeoutMs: options.timeoutMs,
        waitUntil: options.waitUntil,
      }));
      const result = await action();
      await navigation;
      return result;
    },
    frameLocator(frameSelector) {
      return page.frameLocator(frameSelector);
    },
    getByLabel(text, options = {}) {
      return page.getByLabel(text, options);
    },
    getByPlaceholder(text, options = {}) {
      return page.getByPlaceholder(text, options);
    },
    getByRole(role, options = {}) {
      return page.getByRole(role, options);
    },
    getByTestId(testId) {
      return page.getByTestId(testId);
    },
    getByText(text, options = {}) {
      return page.getByText(text, options);
    },
    locator(selector) {
      return page.locator(selector);
    },
    async screenshot(options = {}) {
      const normalized = normalizeScreenshotOptions(options);
      const bytes = await page.screenshot(normalized);
      return createImage(bytes, `image/${normalized.type}`);
    },
    async waitForLoadState(options = {}) {
      await page.waitForLoadState(options.state ?? "load", normalizeLoadStateOptions(options));
    },
    async waitForTimeout(timeoutMs) {
      await page.waitForTimeout(timeoutMs);
    },
    async waitForURL(url, options = {}) {
      await page.waitForURL(url, normalizeTimeout(options));
    },
  };
}

function createCuaApi(tab) {
  const page = tab.page;
  return {
    async click(options) {
      await withKeyboardModifiers(page, options.keypress, async () => {
        await page.mouse.click(options.x, options.y, { button: mapMouseButton(options.button) });
      });
    },
    async double_click(options) {
      await withKeyboardModifiers(page, options.keypress, async () => {
        await page.mouse.dblclick(options.x, options.y);
      });
    },
    async drag(options) {
      const [firstPoint, ...rest] = options.path ?? [];
      if (!firstPoint) {
        throw new Error("drag requires at least one path point.");
      }
      await withKeyboardModifiers(page, options.keys, async () => {
        await page.mouse.move(firstPoint.x, firstPoint.y);
        await page.mouse.down();
        for (const point of rest) {
          await page.mouse.move(point.x, point.y);
        }
        await page.mouse.up();
      });
    },
    async get_visible_screenshot() {
      const bytes = await page.screenshot({ type: DEFAULT_SCREENSHOT_TYPE, fullPage: false });
      return createImage(bytes, `image/${DEFAULT_SCREENSHOT_TYPE}`);
    },
    async keypress(options) {
      await page.keyboard.press(toKeyboardShortcut(options.keys));
    },
    async move(options) {
      await withKeyboardModifiers(page, options.keys, async () => {
        await page.mouse.move(options.x, options.y);
      });
    },
    async scroll(options) {
      await withKeyboardModifiers(page, options.keypress, async () => {
        await page.mouse.move(options.x, options.y);
        await page.mouse.wheel(options.scrollX ?? 0, options.scrollY ?? 0);
      });
    },
    async type(options) {
      await page.keyboard.type(options.text);
    },
  };
}

function createDevApi(tab) {
  tab.runtime.attachPage(tab.page);
  return {
    async logs(options = {}) {
      return tab.runtime.logsForPage(tab.page, options);
    },
  };
}

function createClipboardApi(tab) {
  const page = tab.page;
  return {
    async readText() {
      return await page.evaluate(() => navigator.clipboard.readText());
    },
    async writeText(text) {
      await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    },
    async read() {
      return await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        return await Promise.all(items.map(async (item) => ({
          presentationStyle: item.presentationStyle,
          entries: await Promise.all(item.types.map(async (mimeType) => {
            const blob = await item.getType(mimeType);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return { mimeType, base64: btoa(binary) };
          })),
        })));
      });
    },
    async write(items) {
      await page.evaluate(async (clipboardItems) => {
        const nextItems = clipboardItems.map((item) => new ClipboardItem(
          Object.fromEntries(item.entries.map((entry) => {
            if (entry.text != null) {
              return [entry.mimeType, new Blob([entry.text], { type: entry.mimeType })];
            }
            const binary = atob(entry.base64 ?? "");
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
              bytes[index] = binary.charCodeAt(index);
            }
            return [entry.mimeType, new Blob([bytes], { type: entry.mimeType })];
          })),
          { presentationStyle: item.presentationStyle },
        ));
        await navigator.clipboard.write(nextItems);
      }, items);
    },
  };
}

class BrowserControlRuntime {
  constructor({ globals, endpoint, sessionId }) {
    this.globals = globals;
    this.endpoint = endpoint;
    this.selectedBrowserSessionId = sessionId;
    this.selectedBrowserTargetId = asSessionId(globals.selectedBrowserTargetId);
    this.selectedBrowserTabUrl = "";
    this.pageIds = new WeakMap();
    this.pagesById = new Map();
    this.nextPageId = 1;
    this.consoleLogs = new WeakMap();
    this.attachedPages = new WeakSet();
    this.sessionName = undefined;
  }

  async importChromium() {
    if (!this.chromium) {
      const playwrightModule = await import("playwright-core");
      this.playwright = playwrightModule.default ?? playwrightModule;
      this.chromium = this.playwright.chromium ?? playwrightModule.chromium;
      this.globals.playwright = this.playwright;
      this.globals.chromium = this.chromium;
    }
    return this.chromium;
  }

  async status() {
    const response = await fetch(`${this.endpoint}/extensions/status`);
    if (!response.ok) {
      throw new Error(`Failed to read extension status: ${response.status}`);
    }
    return await response.json();
  }

  async claimBrowserTab(selection) {
    const chromeTabId = selection?.chromeTabId;
    const sessionId = asSessionId(selection?.sessionId);
    if (!Number.isInteger(chromeTabId) || chromeTabId < 1 || !sessionId) {
      return;
    }

    const response = await fetch(`${this.endpoint}/extension/claim-tab`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extensionId: sessionId,
        chromeTabId,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success !== true) {
      throw new Error(payload?.error || `Failed to claim browser tab: ${response.status}`);
    }
  }

  async resolveBrowserSessionId() {
    const requestedSessionId = asSessionId(
      this.globals.selectedBrowserSessionId || this.selectedBrowserSessionId
    );
    if (requestedSessionId) {
      let sessions = [];
      try {
        sessions = (await this.status())?.extensions ?? [];
      } catch {
        sessions = [];
      }
      let resolvedSelection = browserSelectionFromStatus(requestedSessionId, sessions)
        || fallbackBrowserSelection(requestedSessionId);
      if (resolvedSelection.chromeTabId && !resolvedSelection.targetId) {
        await this.claimBrowserTab(resolvedSelection);
        const refreshedSessions = (await this.status())?.extensions ?? [];
        resolvedSelection = browserSelectionFromStatus(requestedSessionId, refreshedSessions)
          || resolvedSelection;
      }
      this.selectedBrowserSessionId = resolvedSelection.sessionId;
      this.selectedBrowserTargetId = asSessionId(resolvedSelection.targetId);
      this.selectedBrowserTabUrl = asSessionId(resolvedSelection.url);
      this.globals.selectedBrowserSessionId = this.selectedBrowserSessionId;
      this.globals.selectedBrowserTargetId = this.selectedBrowserTargetId || undefined;
      return this.selectedBrowserSessionId;
    }

    const sessions = (await this.status())?.extensions ?? [];
    const liveSessions = sessions.filter((session) =>
      (session.targets ?? []).some(isLivePageTarget)
    );

    if (liveSessions.length === 1) {
      this.selectedBrowserSessionId = liveSessions[0].stableKey || liveSessions[0].extensionId;
      return this.selectedBrowserSessionId;
    }

    if (sessions.length === 1) {
      this.selectedBrowserSessionId = sessions[0].stableKey || sessions[0].extensionId;
      return this.selectedBrowserSessionId;
    }

    throw new Error(
      `Expected exactly one connected browser session. Found ${sessions.length}. Set globalThis.selectedBrowserSessionId to the requested stableKey first.`
    );
  }

  async ensureBrowser() {
    if (!this.browser?.isConnected?.()) {
      const chromium = await this.importChromium();
      const browserSessionId = await this.resolveBrowserSessionId();
      const params = new URLSearchParams({ extensionId: browserSessionId });
      const wsEndpoint = `ws://127.0.0.1:19988/cdp/${crypto.randomUUID()}?${params.toString()}`;
      this.browser = await chromium.connectOverCDP(wsEndpoint);
    }
    return this.browser;
  }

  async ensureContext() {
    const browser = await this.ensureBrowser();
    this.context = browser.contexts()[0];
    if (!this.context) {
      throw new Error("Connected to Interpreter browser control but no browser contexts are available.");
    }
    return this.context;
  }

  async ensurePage() {
    const context = await this.ensureContext();
    const pages = context.pages();
    const requestedPage = findRequestedPage(pages, {
      targetId: this.selectedBrowserTargetId,
      url: this.selectedBrowserTabUrl,
    });
    if ((this.selectedBrowserTargetId || this.selectedBrowserTabUrl) && !requestedPage) {
      throw new Error(
        "Connected to Interpreter browser control, but the requested tab is not controllable through Playwright. Allow browser control for that page and click the Interpreter Chrome Extension on the tab before running Playwright against it."
      );
    }
    const page = requestedPage ?? pages.find((candidate) => !candidate.url().startsWith(EXTENSION_URL_PREFIX)) ?? pages[0];
    if (!page) {
      throw new Error(
        "Connected to Interpreter browser control but no pages are available. Make sure Interpreter can already see a live browser tab, and check whether Settings > Browser is restricting which shared pages are allowed."
      );
    }
    this.globals.page = page;
    this.attachPage(page);
    return page;
  }

  idForPage(page) {
    let id = this.pageIds.get(page);
    if (!id) {
      id = `page-${this.nextPageId}`;
      this.nextPageId += 1;
      this.pageIds.set(page, id);
    }
    this.pagesById.set(id, page);
    return id;
  }

  tabForPage(page) {
    return new InterpreterTab(this, page);
  }

  async tabs() {
    const context = await this.ensureContext();
    return context.pages()
      .filter((page) => !page.url().startsWith(EXTENSION_URL_PREFIX))
      .map((page) => {
        this.attachPage(page);
        return this.tabForPage(page);
      });
  }

  async selectedTab() {
    const page = await this.ensurePage();
    return this.tabForPage(page);
  }

  async newTab() {
    const context = await this.ensureContext();
    const page = await context.newPage();
    this.globals.page = page;
    this.attachPage(page);
    return this.tabForPage(page);
  }

  async getTab(id) {
    await this.tabs();
    const page = this.pagesById.get(id);
    if (!page) {
      throw new Error(`No browser tab found for id: ${id}`);
    }
    return this.tabForPage(page);
  }

  attachPage(page) {
    if (this.attachedPages.has(page)) {
      return;
    }
    this.attachedPages.add(page);
    this.consoleLogs.set(page, []);
    page.on("console", (message) => {
      const logs = this.consoleLogs.get(page);
      if (!logs) return;
      logs.push({
        level: message.type(),
        message: message.text(),
        timestamp: new Date().toISOString(),
        url: message.location().url,
      });
      if (logs.length > 500) {
        logs.splice(0, logs.length - 500);
      }
    });
  }

  logsForPage(page, options = {}) {
    const logs = [...(this.consoleLogs.get(page) ?? [])];
    const levels = new Set(options.levels ?? []);
    const filtered = logs.filter((entry) => {
      if (levels.size > 0 && !levels.has(entry.level)) {
        return false;
      }
      if (options.filter && !entry.message.includes(options.filter)) {
        return false;
      }
      return true;
    });
    return filtered.slice(-(options.limit ?? filtered.length));
  }

  installGlobals() {
    const runtime = this;
    const browserApi = {
      tabs: {
        async get(id) {
          return await runtime.getTab(id);
        },
        async list() {
          return await Promise.all((await runtime.tabs()).map(async (tab) => ({
            id: tab.id,
            title: await tab.title().catch(() => undefined),
            url: await tab.url().catch(() => undefined),
          })));
        },
        async new() {
          return await runtime.newTab();
        },
        async selected() {
          return await runtime.selectedTab();
        },
      },
      user: {
        async openTabs() {
          return await browserApi.tabs.list();
        },
      },
      async nameSession(name) {
        runtime.sessionName = name;
      },
    };

    this.globals.agent = {
      ...(this.globals.agent ?? {}),
      browser: browserApi,
    };
    this.globals.browserControl = {
      ...(this.globals.browserControl ?? {}),
      status: runtime.status.bind(runtime),
      ensurePage: runtime.ensurePage.bind(runtime),
      disconnectHandles() {
        runtime.globals.page = undefined;
        runtime.context = undefined;
        runtime.browser = undefined;
      },
    };
    this.globals.ensurePage = runtime.ensurePage.bind(runtime);
    this.globals.display ??= async (value) => {
      if (value && typeof value.toDataURL === "function" && this.globals.interpreter?.emitImage) {
        await this.globals.interpreter.emitImage(value.toDataURL());
        return;
      }
      this.globals.console?.log?.(value);
    };

    return browserApi;
  }
}

export async function setupInterpreterBrowserControl(options = {}) {
  const globals = options.globals ?? globalThis;
  const existing = globals.__interpreterBrowserControlRuntime;
  if (existing) {
    if (options.endpoint) {
      existing.endpoint = options.endpoint;
    }
    if (options.sessionId) {
      existing.selectedBrowserSessionId = options.sessionId;
    }
    existing.installGlobals();
    return existing;
  }

  const runtime = new BrowserControlRuntime({
    globals,
    endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    sessionId: options.sessionId ?? globals.selectedBrowserSessionId,
  });
  globals.__interpreterBrowserControlRuntime = runtime;
  await runtime.importChromium();
  runtime.installGlobals();
  return runtime;
}
