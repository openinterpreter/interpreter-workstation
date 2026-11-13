import { Router } from "express";
import { agentTabManager } from "../agentTabManager";
import { getCurrentWindowSessionKey, getWindowSessionByKey } from "../utils/windowSessions";
import { answerBrowserTabCapture, listBrowserTabCaptures, stopBrowserTabCapture } from "../utils/browserExtensionRelay";
import { readSimpleInterfaceAsset } from "../handlers/simpleAssets";
import {
  readSimpleAppUiState,
  readSimpleAppState,
  recordSimpleAppRuntimeError,
  resolveSimpleAppFile,
  updateSimpleAppState,
  writeSimpleAppState,
  writeSimpleAppUiState,
} from "../handlers/simpleApp";
import {
  promoteSimpleProjectApp,
  readSimpleProjectAppStatus,
} from "../handlers/simpleProjectRuntime";
import {
  createSimpleProject,
  getActiveSimpleProject,
  listSimpleProjects,
  openSimpleProject,
} from "../simpleProjects";
import {
  clearSimplePresentation,
  readSimplePresentation,
} from "../simplePresentation";

const router = Router();

async function canUseTabCapture(req: { header(name: string): string | undefined }): Promise<boolean> {
  const token = req.header('X-Interpreter-Caller-Token');
  if (token) {
    const binding = agentTabManager.getBindingForCallerToken(token);
    if (!binding?.agentId.startsWith('simple-project:')) return false;
    return binding.workspacePath === (await getActiveSimpleProject()).path;
  }
  const sessionKey = getCurrentWindowSessionKey();
  return Boolean(sessionKey && getWindowSessionByKey(sessionKey));
}

router.get('/app/tab-captures', async (req, res) => {
  if (!await canUseTabCapture(req)) return res.status(403).json({ error: 'Interpreter project access required.' });
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ captures: await listBrowserTabCaptures() });
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : 'Tab capture is unavailable.' });
  }
});

router.post('/app/tab-captures/:captureId/answer', async (req, res) => {
  if (!await canUseTabCapture(req)) return res.status(403).json({ error: 'Interpreter project access required.' });
  const answerSdp = req.body?.answerSdp;
  if (typeof answerSdp !== 'string' || answerSdp.length < 20 || answerSdp.length > 200_000) {
    return res.status(400).json({ error: 'Invalid tab-capture answer.' });
  }
  try {
    const success = await answerBrowserTabCapture(req.params.captureId, answerSdp);
    return success ? res.json({ success: true }) : res.status(404).json({ error: 'Tab capture not found.' });
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : 'Tab capture is unavailable.' });
  }
});

router.post('/app/tab-captures/:captureId/stop', async (req, res) => {
  if (!await canUseTabCapture(req)) return res.status(403).json({ error: 'Interpreter project access required.' });
  try {
    const success = await stopBrowserTabCapture(req.params.captureId);
    return success ? res.json({ success: true }) : res.status(404).json({ error: 'Tab capture not found.' });
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : 'Tab capture is unavailable.' });
  }
});

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
    res.json(await readSimpleProjectAppStatus());
  } catch (error) {
    const { status, message } = errorResponse(error);
    res.status(status).json({ error: message });
  }
});

router.post("/promote", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const host = req.get("host");
    if (!host) throw new Error("The Workstation host is unavailable.");
    res.json(await promoteSimpleProjectApp(`${req.protocol}://${host}`));
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
          if (!url.pathname.startsWith('/api/simple-interface/assets/')) continue;
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
    bindProjectAsset(document.documentElement);
    const pending = new Map();
    let sequence = 0;
    const request = (type, payload = {}) => new Promise((resolve, reject) => {
      const id = String(++sequence);
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ protocol, type, id, ...payload }, '*');
    });
    const listeners = new Map();
    const emit = (name, detail) => (listeners.get(name) || []).forEach((listener) => listener(detail));
    const refreshPublicAssets = (revision) => {
      if (!Number.isSafeInteger(revision) || revision < 0) return;
      document.querySelectorAll('img[src], source[src], video[poster]').forEach((element) => {
        const attribute = element.matches('video[poster]') ? 'poster' : 'src';
        const current = element.getAttribute(attribute);
        if (!current) return;
        try {
          const url = new URL(current, window.location.href);
          if (url.origin !== window.location.origin || url.pathname.startsWith('/_next/')) return;
          url.searchParams.set('__interpreter_asset_revision', String(revision));
          element.setAttribute(attribute, url.pathname + url.search + url.hash);
        } catch {}
      });
    };
    listeners.set('project-assets-changed', new Set([(detail) => refreshPublicAssets(detail?.revision)]));
    const connectTabCapture = async (video, captureId) => {
      if (!(video instanceof HTMLVideoElement)) throw new Error('Pass a video element to browser.captures.connect().');
      const captures = await request('tab-captures-list');
      const capture = captures.find((item) => item.captureId === captureId);
      if (!capture) throw new Error('The selected Chrome tab is no longer being shared.');
      const peer = new RTCPeerConnection({ iceServers: [] });
      peer.ontrack = (event) => {
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
        video.muted = true;
        void video.play().catch(() => {});
        if (event.track.kind === 'video') event.track.addEventListener('ended', () => {
          if (video.srcObject) video.srcObject = null;
          peer.close();
        }, { once: true });
      };
      try {
        await peer.setRemoteDescription({ type: 'offer', sdp: capture.offerSdp });
        await peer.setLocalDescription(await peer.createAnswer());
        if (peer.iceGatheringState !== 'complete') {
          await new Promise((resolve) => {
            const timeout = setTimeout(done, 5000);
            function done() { clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', check); resolve(); }
            function check() { if (peer.iceGatheringState === 'complete') done(); }
            peer.addEventListener('icegatheringstatechange', check);
          });
        }
        await request('tab-capture-answer', { captureId, answerSdp: peer.localDescription?.sdp });
      } catch (error) {
        peer.close();
        throw error;
      }
      return { stop: async () => {
        peer.close();
        video.srcObject = null;
        await request('tab-capture-stop', { captureId });
      } };
    };
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
      browser: Object.freeze({
        captures: Object.freeze({
          list: () => request('tab-captures-list'),
          connect: connectTabCapture,
          stop: (captureId) => request('tab-capture-stop', { captureId }),
        }),
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
          report('The interface did not mount. Its project dev server may be unavailable.');
          return;
        }
        window.parent.postMessage({ protocol, type: 'ready' }, '*');
      }));
    });
  })();`);
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
    const { bytes, mime } = await readSimpleInterfaceAsset(req.params.name);
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
