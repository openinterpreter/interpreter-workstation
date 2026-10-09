import { Router } from "express";
import {
  importRandomDesktopImage,
  readSimpleInterfaceAsset,
} from "../handlers/simpleAssets";
import {
  promoteSimpleApp,
  readSimpleAppUiState,
  readSimpleAppRuntime,
  readSimpleAppState,
  readSimpleAppStatus,
  recordSimpleAppRuntimeError,
  resolveSimpleAppFile,
  updateSimpleAppState,
  writeSimpleAppState,
  writeSimpleAppUiState,
} from "../handlers/simpleApp";
import {
  createSimpleProject,
  listSimpleProjects,
  openSimpleProject,
} from "../simpleProjects";
import {
  clearSimplePresentation,
  readSimplePresentation,
} from "../simplePresentation";
import { runWithWindowSessionOverride } from "../utils/windowSessions";

const router = Router();

export function simpleAppAssetQuery(input: {
  revision: unknown;
  windowSessionKey?: unknown;
}): string {
  const params = new URLSearchParams({
    revision: String(input.revision ?? ""),
  });
  if (typeof input.windowSessionKey === "string" && input.windowSessionKey) {
    params.set("windowSessionKey", input.windowSessionKey);
  }
  return params.toString();
}

export function simpleAppReferrerSessionKey(
  referrer: string | undefined,
  expectedHost: string | undefined,
): string | null {
  if (!referrer || !expectedHost) return null;
  try {
    const url = new URL(referrer);
    if (url.host !== expectedHost) return null;
    if (!url.pathname.startsWith("/api/simple-interface/app/")) return null;
    return url.searchParams.get("windowSessionKey") || null;
  } catch {
    return null;
  }
}

async function refreshDesktopMenu(): Promise<void> {
  if (!process.versions.electron) return;
  const { buildApplicationMenu } = await import("../../electron/menu");
  await buildApplicationMenu();
}

function errorResponse(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? 404
      : /invalid|outdated|not present|exceeds|must be|not allowed|full/i.test(
            message,
          )
        ? 400
        : 500;
  return { status, message };
}

router.get("/", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await readSimpleAppStatus());
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.post("/promote", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await promoteSimpleApp());
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.get("/projects", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listSimpleProjects());
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.post("/projects/new", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const project = await createSimpleProject(req.body?.path, {
      activate: req.body?.activate !== false,
    });
    await refreshDesktopMenu();
    res.json(project);
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.post("/projects/open", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const project = await openSimpleProject(req.body?.path, {
      activate: req.body?.activate !== false,
    });
    await refreshDesktopMenu();
    res.json(project);
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.get("/presentation", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(readSimplePresentation());
});

router.post("/presentation/clear", (_req, res) => {
  clearSimplePresentation();
  res.json({ success: true });
});

router.post("/import-desktop-image", async (req, res) => {
  if (req.header("X-Interpreter-Simple-Workspace") !== "1") {
    res
      .status(403)
      .json({ error: "Simple workspace import header is required" });
    return;
  }
  try {
    const result = await importRandomDesktopImage();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ...result,
      url: `/api/simple-interface/assets/${encodeURIComponent(result.asset)}`,
    });
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.get("/app/index.html", async (req, res) => {
  try {
    const status = await readSimpleAppStatus();
    if (!status.ready || !status.revision)
      throw new Error("The interface has not compiled yet.");
    const assetQuery = simpleAppAssetQuery({
      revision: req.query.revision ?? status.revision,
      windowSessionKey: req.query.windowSessionKey,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors file: http://localhost:* http://127.0.0.1:*",
    );
    res.send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./app.css?${assetQuery}"></head><body><div id="root"></div><script src="./bridge.js?${assetQuery}"></script><script src="./app.js?${assetQuery}"></script></body></html>`,
    );
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).send(message);
  }
});

router.get("/app/bridge.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`(() => {
    const protocol = 'interpreter-interface-v1';
    const windowSessionKey = new URLSearchParams(window.location.search).get('windowSessionKey');
    const bindProjectAsset = (element) => {
      if (!windowSessionKey || !(element instanceof Element)) return;
      const candidates = element.matches('img[src], source[src], video[poster]')
        ? [element]
        : Array.from(element.querySelectorAll('img[src], source[src], video[poster]'));
      for (const candidate of candidates) {
        const attribute = candidate.matches('video[poster]') ? 'poster' : 'src';
        const raw = candidate.getAttribute(attribute);
        if (!raw) continue;
        try {
          const url = new URL(raw, window.location.href);
          if (url.origin !== window.location.origin || url.searchParams.has('windowSessionKey')) continue;
          url.searchParams.set('windowSessionKey', windowSessionKey);
          candidate.setAttribute(attribute, url.pathname + url.search + url.hash);
        } catch {}
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') bindProjectAsset(record.target);
        for (const node of record.addedNodes) bindProjectAsset(node);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'poster'] });
    const pending = new Map();
    let sequence = 0;
    const request = (type, payload = {}) => new Promise((resolve, reject) => {
      const id = String(++sequence);
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ protocol, type, id, ...payload }, '*');
    });
    const listeners = new Map();
    const emit = (name, detail) => (listeners.get(name) || []).forEach((listener) => listener(detail));
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.protocol !== protocol) return;
      if (data.type === 'host-event') { emit(data.name, data.detail); return; }
      if (data.type !== 'response' || !pending.has(data.id)) return;
      const task = pending.get(data.id); pending.delete(data.id);
      if (data.ok) task.resolve(data.value); else task.reject(new Error(data.error || 'Interpreter request failed'));
    });
    window.Interpreter = Object.freeze({
      sendMessage: (message) => request('send-message', { message }),
      agents: Object.freeze({ run: (value) => request('run-agent', { value }) }),
      state: Object.freeze({
        get: () => request('state-get'),
        set: (value) => request('state-set', { value }),
        update: (key, value) => request('state-update', { key, value }),
      }),
      files: Object.freeze({
        register: (view) => window.parent.postMessage({ protocol, type: 'host-view-register', view }, '*'),
        unregister: (id) => window.parent.postMessage({ protocol, type: 'host-view-unregister', id }, '*'),
        reveal: (path) => request('file-reveal', { path }),
        on: (name, listener) => {
          const group = listeners.get(name) || new Set(); group.add(listener); listeners.set(name, group);
          return () => group.delete(listener);
        },
      }),
    });
    const controlKey = (element) => element.dataset.interpreterStateKey || element.name || element.id || (() => {
      const controls = Array.from(document.querySelectorAll('input, textarea, select'));
      return element.tagName.toLowerCase() + ':' + controls.indexOf(element);
    })();
    const snapshotUi = () => {
      const controls = {};
      document.querySelectorAll('input, textarea, select').forEach((element) => {
        const key = controlKey(element);
        controls[key] = element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')
          ? { checked: element.checked }
          : {
              value: element.value,
              selectionStart: typeof element.selectionStart === 'number' ? element.selectionStart : null,
              selectionEnd: typeof element.selectionEnd === 'number' ? element.selectionEnd : null,
              selectionDirection: element.selectionDirection || null,
              scrollLeft: element.scrollLeft,
              scrollTop: element.scrollTop,
            };
      });
      return { controls, scroll: { x: window.scrollX, y: window.scrollY }, active: document.activeElement ? controlKey(document.activeElement) : null };
    };
    let saveTimer = 0;
    const saveUi = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void request('ui-state-set', { value: snapshotUi() }); }, 180);
    };
    const setNativeValue = (element, value) => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, value); else element.value = value;
    };
    const restoreUi = (snapshot) => {
      if (!snapshot || typeof snapshot !== 'object') return;
      document.querySelectorAll('input, textarea, select').forEach((element) => {
        const saved = snapshot.controls?.[controlKey(element)];
        if (!saved) return;
        if ('checked' in saved && element instanceof HTMLInputElement) element.checked = Boolean(saved.checked);
        if ('value' in saved) setNativeValue(element, String(saved.value ?? ''));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        if (typeof saved.selectionStart === 'number' && typeof saved.selectionEnd === 'number' && 'setSelectionRange' in element) {
          try { element.setSelectionRange(saved.selectionStart, saved.selectionEnd, saved.selectionDirection || undefined); } catch {}
        }
        element.scrollLeft = Number(saved.scrollLeft) || 0;
        element.scrollTop = Number(saved.scrollTop) || 0;
      });
      if (snapshot.scroll) window.scrollTo(Number(snapshot.scroll.x) || 0, Number(snapshot.scroll.y) || 0);
      const active = Array.from(document.querySelectorAll('input, textarea, select')).find((element) => controlKey(element) === snapshot.active);
      active?.focus({ preventScroll: true });
    };
    document.addEventListener('input', saveUi, true);
    document.addEventListener('change', saveUi, true);
    document.addEventListener('focusout', saveUi, true);
    window.addEventListener('scroll', saveUi, { passive: true });
    window.addEventListener('pagehide', () => { clearTimeout(saveTimer); void request('ui-state-set', { value: snapshotUi() }); });
    let selectionFrame = 0;
    const reportSelection = () => {
      cancelAnimationFrame(selectionFrame);
      selectionFrame = requestAnimationFrame(() => {
        const selection = window.getSelection();
        const text = selection && !selection.isCollapsed ? selection.toString().trim().slice(0, 10240) : '';
        const anchor = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
        const path = anchor?.closest('[data-interpreter-file-path]')?.getAttribute('data-interpreter-file-path') || null;
        window.parent.postMessage({ protocol, type: 'selection', text, path }, '*');
      });
    };
    document.addEventListener('selectionchange', reportSelection);
    document.addEventListener('dragover', (event) => { event.preventDefault(); document.documentElement.dataset.interpreterDragging = 'true'; });
    document.addEventListener('dragleave', (event) => { if (!event.relatedTarget) delete document.documentElement.dataset.interpreterDragging; });
    document.addEventListener('drop', (event) => {
      event.preventDefault(); delete document.documentElement.dataset.interpreterDragging;
      const files = Array.from(event.dataTransfer?.files || []);
      window.parent.postMessage({ protocol, type: 'files-dropped', files, point: { x: event.clientX, y: event.clientY } }, '*');
    });
    const report = (value) => window.parent.postMessage({ protocol, type: 'runtime-error', message: String(value && (value.stack || value.message) || value) }, '*');
    window.addEventListener('error', (event) => report(event.error || event.message));
    window.addEventListener('unhandledrejection', (event) => report(event.reason));
    document.addEventListener('click', () => window.parent.postMessage({ protocol, type: 'interaction' }, '*'), { capture: true });
    listeners.set('capture-ui-state', new Set([(detail) => {
      window.parent.postMessage({ protocol, type: 'ui-state-snapshot', token: detail?.token, value: snapshotUi() }, '*');
    }]));
    request('ui-state-get').then((snapshot) => requestAnimationFrame(() => requestAnimationFrame(() => restoreUi(snapshot)))).catch(() => {}).finally(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const root = document.getElementById('root');
        if (!root || root.childNodes.length === 0) {
          report('The compiled interface did not mount. Its runtime assets may be unavailable.');
          return;
        }
        window.parent.postMessage({ protocol, type: 'ready' }, '*');
      }));
    });
  })();`);
});

router.get("/app/app.js", async (_req, res) => {
  try {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(await readSimpleAppRuntime("app.js"));
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).send(message);
  }
});

router.get("/app/app.css", async (_req, res) => {
  try {
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(await readSimpleAppRuntime("app.css"));
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).send(message);
  }
});

router.get("/app/state", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await readSimpleAppState());
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.post("/app/state", async (req, res) => {
  try {
    res.json(await writeSimpleAppState(req.body));
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.post("/app/state/update", async (req, res) => {
  try {
    res.json(await updateSimpleAppState(req.body?.key, req.body?.value));
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.get("/app/ui-state", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await readSimpleAppUiState());
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.post("/app/ui-state", async (req, res) => {
  try {
    res.json(await writeSimpleAppUiState(req.body));
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.post("/app/resolve-path", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await resolveSimpleAppFile(req.body?.path));
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.post("/app/runtime-error", async (req, res) => {
  try {
    res.json(await recordSimpleAppRuntimeError(req.body?.message));
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.get("/assets/:name", async (req, res) => {
  try {
    // Interface-authored media URLs remain ordinary project-relative React
    // URLs. Browsers do not copy the document query onto those requests, so
    // recover the owning window session only from our same-host app referrer.
    const referrerSessionKey = simpleAppReferrerSessionKey(
      req.get("referer"),
      req.get("host"),
    );
    const { bytes, mime } = referrerSessionKey
      ? await runWithWindowSessionOverride(referrerSessionKey, () =>
          readSimpleInterfaceAsset(req.params.name),
        )
      : await readSimpleInterfaceAsset(req.params.name);
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.send(bytes);
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

export default router;
