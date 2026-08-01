// Cross-platform window enumeration + frontmost-by-pid tracking for the world
// overlay. macOS uses the Swift `window-tracker` CLI; Windows calls into the
// `interpreter-window-pin` native addon directly. The TS surface is identical.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { getInterpreterOverlayNativeHelperPath } from './native-helper-paths.js';

export interface WindowInfo {
  pid: number;
  cgWindowId: number;
  ownerName: string;
  title: string;
  appBundlePath?: string | null;
  bounds: { x: number; y: number; width: number; height: number };
}

interface WinAddon {
  platform: string;
  windowAtPoint: (x: number, y: number, opts?: { excludePids?: number[] }) => null | {
    hwnd: number;
    pid: number;
    owner: string;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
  };
  frontmostByPid: (pid: number) => null | {
    hwnd: number;
    pid: number;
    owner: string;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
  };
  windowBoundsByHwnd: (hwnd: number) => null | {
    hwnd: number;
    pid: number;
    owner: string;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
  };
  WindowWatcher: new (
    pid: number,
    intervalMs: number,
    onEvent: (event: { kind: 'update' | 'gone'; hwnd?: number; pid?: number; bounds?: WindowInfo['bounds'] }) => void,
  ) => { stop(): void };
}

let cachedWinAddon: WinAddon | null | undefined;
function loadWinAddon(): WinAddon | null {
  if (cachedWinAddon !== undefined) return cachedWinAddon;
  if (process.platform !== 'win32') {
    cachedWinAddon = null;
    return null;
  }
  const candidates = [
    path.join(__dirname, '..', 'interpreter-overlay', 'native', 'window_pin.node'),
    path.join(__dirname, '..', '..', 'interpreter-overlay', 'native', 'window_pin.node'),
    path.join(process.resourcesPath ?? '', 'interpreter-overlay', 'native', 'window_pin.node'),
  ];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const mod = require(candidate) as WinAddon;
      if (mod && mod.platform === 'win32') {
        cachedWinAddon = mod;
        return mod;
      }
    } catch {
      // try next
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const mod = require('interpreter-window-pin') as WinAddon;
    if (mod && mod.platform === 'win32') {
      cachedWinAddon = mod;
      return mod;
    }
  } catch {}
  cachedWinAddon = null;
  return null;
}

function physicalToDipBounds(
  bounds: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  if (process.platform !== 'win32') return bounds;
  // Convert Win32 physical-pixel bounds back to Electron DIPs so the rest of
  // the overlay (scope frame, action bounds, marker positions) stays in the
  // same coordinate system as macOS. Electron's screen module exposes the
  // current per-monitor DPI conversion.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { screen } = require('electron') as typeof import('electron');
  const topLeft = screen.screenToDipPoint({ x: bounds.x, y: bounds.y });
  const bottomRight = screen.screenToDipPoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
  return {
    x: Math.round(topLeft.x),
    y: Math.round(topLeft.y),
    width: Math.round(bottomRight.x - topLeft.x),
    height: Math.round(bottomRight.y - topLeft.y),
  };
}

function dipToScreen(x: number, y: number): { x: number; y: number } {
  if (process.platform !== 'win32') return { x, y };
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { screen } = require('electron') as typeof import('electron');
  const p = screen.dipToScreenPoint({ x, y });
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function uniquePointAttempts(points: Array<{ source: string; x: number; y: number }>): Array<{ source: string; x: number; y: number }> {
  const seen = new Set<string>();
  const unique: Array<{ source: string; x: number; y: number }> = [];
  for (const point of points) {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ source: point.source, x, y });
  }
  return unique;
}

function fromAddonWindow(w: NonNullable<ReturnType<WinAddon['windowAtPoint']>>): WindowInfo {
  return {
    pid: w.pid,
    cgWindowId: w.hwnd, // on Windows, identifier slot carries the HWND
    ownerName: w.owner,
    title: w.title,
    bounds: physicalToDipBounds(w.bounds),
  };
}

// -- macOS Swift CLI fallback ------------------------------------------------

function macBinaryPath(): string {
  return getInterpreterOverlayNativeHelperPath('window-tracker');
}

function parseLine(line: string): WindowInfo | 'gone' | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed === 'gone' || trimmed === 'none') return 'gone';
  if (!trimmed.startsWith('ok ')) return null;
  const intMatch = (key: string) => {
    const m = trimmed.match(new RegExp(`(?:^|\\s)${key}=(-?\\d+)`));
    return m ? parseInt(m[1], 10) : NaN;
  };
  const pid = intMatch('pid');
  const cgWindowId = intMatch('cgWindowId');
  const x = intMatch('x');
  const y = intMatch('y');
  const w = intMatch('w');
  const h = intMatch('h');
  if ([pid, cgWindowId, x, y, w, h].some(Number.isNaN)) return null;
  let ownerName = '';
  let title = '';
  let appBundlePath: string | null = null;
  const ownerIdx = trimmed.indexOf(' owner=');
  if (ownerIdx >= 0) {
    const tail = trimmed.slice(ownerIdx + ' owner='.length);
    const titleIdx = tail.indexOf(' title=');
    if (titleIdx >= 0) {
      ownerName = tail.slice(0, titleIdx);
      title = tail.slice(titleIdx + ' title='.length);
    } else {
      ownerName = tail;
    }
  }
  const bundleIdx = title.indexOf(' appBundle=');
  if (bundleIdx >= 0) {
    appBundlePath = title.slice(bundleIdx + ' appBundle='.length).trim() || null;
    title = title.slice(0, bundleIdx);
  }
  return { pid, cgWindowId, ownerName, title, appBundlePath, bounds: { x, y, width: w, height: h } };
}

function macRunOnce(args: string[], timeoutMs = 1500, excludedPid?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      macBinaryPath(),
      args,
      {
        timeout: timeoutMs,
        encoding: 'utf-8',
        env: {
          ...process.env,
          INTERPRETER_OVERLAY_EXCLUDED_PID: excludedPid != null ? String(excludedPid) : (process.env.INTERPRETER_OVERLAY_EXCLUDED_PID ?? ''),
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = [
            'code' in err && err.code != null ? `code=${String(err.code)}` : null,
            'signal' in err && err.signal ? `signal=${String(err.signal)}` : null,
            String(stderr ?? '').trim() ? `stderr=${String(stderr).trim()}` : null,
          ].filter(Boolean).join(' ');
          reject(detail ? new Error(`${err.message.trim()} (${detail})`) : err);
          return;
        }
        resolve(String(stdout ?? '').trim());
      },
    );
  });
}

// -- Public surface ----------------------------------------------------------

export async function windowAtPoint(x: number, y: number): Promise<WindowInfo | null> {
  if (process.platform === 'darwin') {
    try {
      const output = await macRunOnce(['at', String(Math.round(x)), String(Math.round(y))], 1500, process.pid);
      const parsed = parseLine(output);
      return parsed && parsed !== 'gone' ? parsed : null;
    } catch (err) {
      console.error('[WindowTracker] windowAtPoint(mac) failed:', err);
      return null;
    }
  }
  if (process.platform === 'win32') {
    const addon = loadWinAddon();
    if (!addon) return null;
    try {
      const phys = dipToScreen(x, y);
      const attempts = uniquePointAttempts([
        { source: 'electron-dipToScreen', x: phys.x, y: phys.y },
        // Parallels can expose a Retina-sized capture surface while the native
        // window API still expects logical desktop coordinates.
        { source: 'raw-dip', x, y },
      ]);
      for (const attempt of attempts) {
        const w = addon.windowAtPoint(attempt.x, attempt.y, { excludePids: [process.pid] });
        if (w) {
          if (attempt.source !== 'electron-dipToScreen') {
            console.log('[WindowTracker] windowAtPoint(win) used fallback coordinates', {
              requested: { x: Math.round(x), y: Math.round(y) },
              firstAttempt: phys,
              fallback: attempt,
              owner: w.owner,
              title: w.title,
              bounds: w.bounds,
            });
          }
          return fromAddonWindow(w);
        }
      }
      console.log('[WindowTracker] windowAtPoint(win) found no window', {
        requested: { x: Math.round(x), y: Math.round(y) },
        attempts,
      });
      return null;
    } catch (err) {
      console.error('[WindowTracker] windowAtPoint(win) failed:', err);
      return null;
    }
  }
  return null;
}

export async function windowBoundsByCgId(cgWindowId: number): Promise<WindowInfo | null> {
  if (process.platform === 'darwin') {
    try {
      const output = await macRunOnce(['bounds', String(cgWindowId)], 1500);
      const parsed = parseLine(output);
      return parsed && parsed !== 'gone' ? parsed : null;
    } catch (err) {
      console.error('[WindowTracker] windowBoundsByCgId(mac) failed:', err);
      return null;
    }
  }
  if (process.platform === 'win32') {
    const addon = loadWinAddon();
    if (!addon) return null;
    try {
      const w = addon.windowBoundsByHwnd(cgWindowId);
      return w ? fromAddonWindow(w) : null;
    } catch (err) {
      console.error('[WindowTracker] windowBoundsByCgId(win) failed:', err);
      return null;
    }
  }
  return null;
}

export async function frontmostWindowByPid(pid: number): Promise<WindowInfo | null> {
  if (process.platform === 'darwin') {
    try {
      const output = await macRunOnce(['frontmost', String(pid)], 1500);
      const parsed = parseLine(output);
      return parsed && parsed !== 'gone' ? parsed : null;
    } catch (err) {
      console.error('[WindowTracker] frontmostWindowByPid(mac) failed:', err);
      return null;
    }
  }
  if (process.platform === 'win32') {
    const addon = loadWinAddon();
    if (!addon) return null;
    try {
      const w = addon.frontmostByPid(pid);
      return w ? fromAddonWindow(w) : null;
    } catch (err) {
      console.error('[WindowTracker] frontmostWindowByPid(win) failed:', err);
      return null;
    }
  }
  return null;
}

export async function activeWindow(): Promise<WindowInfo | null> {
  if (process.platform === 'darwin') {
    // One bounded retry: a transient spawn failure here costs the user the
    // automatic active-app target box for the whole overlay open. The timeout
    // is generous because this call is async and off the open critical path —
    // under heavy system load a late target box still beats no box.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const output = await macRunOnce(['active'], 4000, process.pid);
        const parsed = parseLine(output);
        return parsed && parsed !== 'gone' ? parsed : null;
      } catch (err) {
        console.error(`[WindowTracker] activeWindow(mac) failed (attempt ${attempt}/2):`, err);
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
    }
    return null;
  }
  return null;
}

export type WatcherEvent =
  | { type: 'update'; window: WindowInfo }
  | { type: 'gone' }
  | { type: 'error'; error: Error };

export interface FrontmostWatcher {
  stop(): void;
}

export function watchFrontmostByPid(
  pid: number,
  onEvent: (event: WatcherEvent) => void,
  intervalMs = 33,
): FrontmostWatcher {
  if (process.platform === 'darwin') {
    let stopped = false;
    let child: ChildProcessWithoutNullStreams | null = null;
    let buffer = '';
    try {
      child = spawn(macBinaryPath(), ['watch', String(pid), String(intervalMs)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err) {
      onEvent({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      return { stop() {} };
    }
    const proc = child;
    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const parsed = parseLine(line);
        if (parsed === null) continue;
        if (parsed === 'gone') onEvent({ type: 'gone' });
        else onEvent({ type: 'update', window: parsed });
      }
    });
    proc.on('error', (err) => {
      if (!stopped) onEvent({ type: 'error', error: err });
    });
    proc.on('exit', () => {
      if (!stopped) onEvent({ type: 'gone' });
    });
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        try { proc.stdin?.end(); } catch {}
        try { proc.kill('SIGTERM'); } catch {}
      },
    };
  }

  if (process.platform === 'win32') {
    const addon = loadWinAddon();
    if (!addon) {
      return { stop() {} };
    }
    let watcher: { stop(): void } | null = null;
    try {
      watcher = new addon.WindowWatcher(pid, intervalMs, (event) => {
        if (event.kind === 'gone') {
          onEvent({ type: 'gone' });
          return;
        }
        if (event.kind === 'update' && event.bounds && typeof event.hwnd === 'number') {
          onEvent({
            type: 'update',
            window: {
              pid,
              cgWindowId: event.hwnd,
              ownerName: '',
              title: '',
              bounds: physicalToDipBounds(event.bounds),
            },
          });
        }
      });
    } catch (err) {
      onEvent({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      return { stop() {} };
    }
    return {
      stop() { watcher?.stop(); },
    };
  }

  return { stop() {} };
}
