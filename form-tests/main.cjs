#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { mouse, keyboard, Key, Button, clipboard } = require('@nut-tree-fork/nut-js');
const { PNG } = require('pngjs');
const { buildGeneratedTests } = require('./generate-tests.cjs');
const {
  makeOverlayVisualProbeImages,
  probePixelStats,
  findProbeBounds,
  overlayProbeCoversTarget,
  assertOverlayProbeOccluded,
} = require('../tests/overlay-visual-probe.cjs');
const {
  buildMouseDragPath,
  computeBoundsCoverage,
  deriveAxFormRegion,
  deriveWindowFormRegion,
} = require('./scope-drag-region.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'test-output');
const TEST_WORKSPACE_DIR = path.join(REPO_ROOT, 'tests', 'test-workspace');
const CHROME_FORM_TEMPLATE_PATH = path.join(REPO_ROOT, 'apps/interpreter-overlay/electron/form-tests-chrome-surface.html');
const MANUAL_WORKBENCH_TEMPLATE_PATH = path.join(__dirname, 'manual-workbench.html');
const LOCAL_PYTHON_API_PORT = Number(process.env.PYTHON_API_PORT || 18000);
const LOCAL_DESKTOP_API_PORT = Number(process.env.DESKTOP_SERVER_PORT || 8080);
const LOCAL_API_HOST = process.env.FORM_TESTS_LOCAL_API_HOST?.trim() || '127.0.0.1';
const APP_DEBUG_PORT_START = 9877;
const APP_DEBUG_PORT_END = 9899;
const CHROME_FORM_SERVER_PORT_START = 9900;
const CHROME_FORM_SERVER_PORT_END = 9929;
const MANUAL_WORKBENCH_SERVER_PORT_START = 9930;
const MANUAL_WORKBENCH_SERVER_PORT_END = 9959;
const FORM_WINDOW_READY_TIMEOUT_MS = 30000;
const AGENT_TIMEOUT_MS = 45000;
const REAL_INTERACTION_WATCHDOG_MS = 180000;
const RUN_START_TIMEOUT_MS = 15000;
const LOCAL_API_TIMEOUT_MS = 90000;
const APP_START_TIMEOUT_MS = 60000;
const CLEANUP_TIMEOUT_MS = 20000;
const REVIEW_APPROVAL_WAIT_MS = 0;
const EMERGENCY_ABORT_CORNER_SIZE_PX = 24;
const EMERGENCY_ABORT_DWELL_MS = 0;
const GUI_INSPECT_SETTLE_MS = 24;
const GUI_INSPECT_CROP_PADDING_DIP = 50;
const GUI_INSPECT_INPUT_CROP_HEIGHT_DIP = 156;
const GUI_INSPECT_INPUT_CROP_MAX_WIDTH_DIP = 620;
const GUI_INSPECT_INPUT_CROP_MIN_WIDTH_DIP = 520;
const GUI_INSPECT_ATTACHED_PILL_GAP_DIP = 16;
const GUI_INSPECT_ATTACHED_REVIEW_PILL_WIDTH_DIP = 236;
const GUI_INSPECT_ATTACHED_LOADING_PILL_MIN_WIDTH_DIP = 112;
const GUI_INSPECT_ATTACHED_PILL_HEIGHT_DIP = 40;
const DRAG_SELECT_FORM_PADDING_DIP = 18;
const DRAG_SELECT_PATH_SEGMENTS = 7;
const DRAG_SELECT_PATH_INSET_DIP = 10;
const DRAG_SELECT_STEP_DELAY_MS = 48;
const DRAG_SELECT_HOLD_BEFORE_MS = 32;
const DRAG_SELECT_HOLD_PRESSED_MS = 140;
const DRAG_SELECT_HOLD_AFTER_MS = 90;
const DRAG_SELECT_CHAOS_OUTSET_DIP = 120;
const DRAG_SELECT_CHAOS_CORNER_MARGIN_DIP = EMERGENCY_ABORT_CORNER_SIZE_PX + 8;
const DRAG_SELECT_CHAOS_SETTLE_MS = 96;
const DRAG_SELECT_CHAOS_REOPEN_INTERVAL = 2;
const DRAG_SELECT_COVERAGE_THRESHOLD = 0.72;
const DRAG_SELECT_CHAOS_TIMING_PROFILES = [
  {
    name: 'baseline',
    holdBeforeMs: DRAG_SELECT_HOLD_BEFORE_MS,
    holdPressedMs: DRAG_SELECT_HOLD_PRESSED_MS,
    stepDelayMs: DRAG_SELECT_STEP_DELAY_MS,
    holdAfterMs: DRAG_SELECT_HOLD_AFTER_MS,
  },
  {
    name: 'post-press-dwell',
    holdBeforeMs: DRAG_SELECT_HOLD_BEFORE_MS,
    holdPressedMs: 820,
    stepDelayMs: DRAG_SELECT_STEP_DELAY_MS,
    holdAfterMs: DRAG_SELECT_HOLD_AFTER_MS,
  },
  {
    name: 'segmented-slow',
    holdBeforeMs: DRAG_SELECT_HOLD_BEFORE_MS,
    holdPressedMs: 160,
    stepDelayMs: 170,
    holdAfterMs: 160,
  },
  {
    name: 'release-dwell',
    holdBeforeMs: DRAG_SELECT_HOLD_BEFORE_MS,
    holdPressedMs: 120,
    stepDelayMs: 90,
    holdAfterMs: 900,
  },
  {
    name: 'heavy-dwell',
    holdBeforeMs: DRAG_SELECT_HOLD_BEFORE_MS,
    holdPressedMs: 520,
    stepDelayMs: 180,
    holdAfterMs: 520,
  },
];
const OVERLAY_PRESENTATION_TRANSITION_MIN_MS = 60;
const OVERLAY_PRESENTATION_TRANSITION_MAX_MS = Number(process.env.FORM_TESTS_OVERLAY_PRESENTATION_TRANSITION_MAX_MS || 180);
const OVERLAY_PRESENTATION_SYNC_TOLERANCE_MS = OVERLAY_PRESENTATION_TRANSITION_MAX_MS;
const OVERLAY_POST_SUBMIT_REOPEN_GUARD_MS = 4000;
const OVERLAY_POST_RUN_DISMISS_GUARD_MS = 4000;
const OVERLAY_VISUAL_BLANK_TOLERANCE_MS = 120;
const DEFAULT_FORM_TESTS_INTERPRETER_OVERLAY_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_FORM_TESTS_INTERPRETER_OVERLAY_LLM_BASE_URL = 'https://api.groq.com/openai';
const OVERLAY_PROFILE_SWITCH_SETTLE_MS = 180;
const OVERLAY_AGENT_ALLOWED_TOOL_NAMES = [
  'builtin-interpreter-overlay__overlay_read_context',
  'builtin-interpreter-overlay__overlay_screenshot',
  'builtin-interpreter-overlay__computer_batch',
  'builtin-interpreter-overlay__overlay_detach',
  'builtin-interpreter-overlay__overlay_complete',
];
let apiProcess = null;
let appProcess = null;
let appProcessExit = null;
let formSurfaceSession = null;
let chromeFormSurfaceController = null;
let manualWorkbenchServer = null;
let masterLogStream = null;
let appLogStream = null;
let masterLogPath = '';
let appLogPath = '';
let appDebugPort = APP_DEBUG_PORT_START;
let appDebugToken = '';
let apiWasAlreadyRunning = false;
let localApiShutdownRequested = false;
let cleanupPromise = null;
let emergencyAbortMonitor = null;
let shutdownSignalSent = false;
let emergencyAbortPromise = null;
let emergencyAbortRequested = false;
let emergencyAbortHotCornerSuspendDepth = 0;
const testResults = [];
const LOCAL_API_HEALTHCHECKS = [
  `http://${LOCAL_API_HOST}:${LOCAL_PYTHON_API_PORT}/healthcheck`,
  `http://${LOCAL_API_HOST}:${LOCAL_DESKTOP_API_PORT}/healthcheck`,
];
const LOCAL_API_KILL_COMMANDS = [
  ['pkill', ['-9', '-f', 'pnpm run dev:api']],
  ['pkill', ['-9', '-f', 'bun run --hot desktop_server/index.ts']],
  ['pkill', ['-9', '-f', `uv run --no-cache -- uvicorn app.main:app --host=0.0.0.0 --port=${LOCAL_PYTHON_API_PORT} --reload --env-file=.env`]],
  ['pkill', ['-9', '-f', `uvicorn app.main:app --host=0.0.0.0 --port=${LOCAL_PYTHON_API_PORT} --reload --env-file=.env`]],
];
const originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
};

keyboard.config.autoDelayMs = 10;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAppExit(details) {
  if (!details) {
    return 'unknown';
  }

  if (details.signal) {
    return `signal ${details.signal}`;
  }

  return `code ${details.code ?? 'null'}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function expandBounds(bounds, padding, maxWidth, maxHeight) {
  const x = clamp(Math.floor(bounds.x - padding), 0, Math.max(0, maxWidth - 1));
  const y = clamp(Math.floor(bounds.y - padding), 0, Math.max(0, maxHeight - 1));
  const right = clamp(Math.ceil(bounds.x + bounds.width + padding), x + 1, maxWidth);
  const bottom = clamp(Math.ceil(bounds.y + bounds.height + padding), y + 1, maxHeight);

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

function unionBounds(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);

  return {
    x,
    y,
    width: rightEdge - x,
    height: bottomEdge - y,
  };
}

function sameOverlayActionTarget(left, right) {
  if (!left || !right) {
    return false;
  }

  return (
    left.id === right.id
    || (
      left.type === right.type
      && left.description === right.description
      && Math.round(left.bounds.x) === Math.round(right.bounds.x)
      && Math.round(left.bounds.y) === Math.round(right.bounds.y)
      && Math.round(left.bounds.width) === Math.round(right.bounds.width)
      && Math.round(left.bounds.height) === Math.round(right.bounds.height)
      && String(left.text || '') === String(right.text || '')
    )
  );
}

function estimateAttachedPillBounds(actionBounds, overlayState, displayBoundsDIP) {
  if (!actionBounds || !overlayState?.pill || overlayState.action?.type === 'hotkey') {
    return null;
  }

  let estimatedWidth = 0;
  if (overlayState.pill.kind === 'review') {
    estimatedWidth = GUI_INSPECT_ATTACHED_REVIEW_PILL_WIDTH_DIP;
  } else if (overlayState.pill.kind === 'loading') {
    const label = String(overlayState.pill.label || 'Thinking...');
    estimatedWidth = Math.max(
      GUI_INSPECT_ATTACHED_LOADING_PILL_MIN_WIDTH_DIP,
      Math.round(22 + (label.length * 6.6)),
    );
  } else {
    return null;
  }

  const x = clamp(
    Math.round(actionBounds.x - GUI_INSPECT_ATTACHED_PILL_GAP_DIP - estimatedWidth),
    0,
    Math.max(0, displayBoundsDIP.width - estimatedWidth),
  );
  const y = clamp(
    Math.round(actionBounds.y + ((actionBounds.height - GUI_INSPECT_ATTACHED_PILL_HEIGHT_DIP) / 2)),
    0,
    Math.max(0, displayBoundsDIP.height - GUI_INSPECT_ATTACHED_PILL_HEIGHT_DIP),
  );

  return {
    x,
    y,
    width: estimatedWidth,
    height: GUI_INSPECT_ATTACHED_PILL_HEIGHT_DIP,
  };
}

function getGuiInspectInputCrop(displayBoundsDIP) {
  const width = clamp(
    Math.round(displayBoundsDIP.width * 0.56),
    Math.min(GUI_INSPECT_INPUT_CROP_MIN_WIDTH_DIP, displayBoundsDIP.width),
    Math.min(GUI_INSPECT_INPUT_CROP_MAX_WIDTH_DIP, displayBoundsDIP.width),
  );
  const height = Math.min(GUI_INSPECT_INPUT_CROP_HEIGHT_DIP, displayBoundsDIP.height);
  const x = clamp(Math.round((displayBoundsDIP.width - width) / 2), 0, Math.max(0, displayBoundsDIP.width - width));
  const y = clamp(displayBoundsDIP.height - height - 18, 0, Math.max(0, displayBoundsDIP.height - height));

  return { x, y, width, height };
}

function cropPngBuffer(buffer, rect) {
  const source = PNG.sync.read(buffer);
  const target = new PNG({ width: rect.width, height: rect.height });

  PNG.bitblt(source, target, rect.x, rect.y, rect.width, rect.height, 0, 0);
  return PNG.sync.write(target);
}

async function captureCompositedRegionPng(rectDip) {
  if (process.platform !== 'darwin') {
    throw new Error('GUI inspect compositor capture is only supported on macOS.');
  }

  const tempDir = fs.realpathSync(os.tmpdir());
  const captureRect = {
    x: Math.max(0, Math.floor(rectDip.x)),
    y: Math.max(0, Math.floor(rectDip.y)),
    width: Math.max(1, Math.ceil(rectDip.width)),
    height: Math.max(1, Math.ceil(rectDip.height)),
  };
  const tempPath = path.join(
    tempDir,
    `gui-inspect-composited-${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
  );

  try {
    const result = await runProcessExit('screencapture', [
      '-x',
      '-R',
      `${captureRect.x},${captureRect.y},${captureRect.width},${captureRect.height}`,
      tempPath,
    ]);
    if (result.code !== 0) {
      const message = result.stderr.trim() || 'Unknown screencapture failure';
      throw new Error(`Failed to capture compositor region: ${message}`);
    }
    await waitForCondition('GUI inspect compositor capture', 1000, async () => (
      fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0 ? true : null
    ));
    return fs.readFileSync(tempPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
}

async function captureCompositedPng(rectDip = null) {
  if (process.platform !== 'darwin') {
    throw new Error('Overlay visual probe compositor capture is only supported on macOS.');
  }
  if (rectDip) {
    return captureCompositedRegionPng(rectDip);
  }

  const tempDir = fs.realpathSync(os.tmpdir());
  const tempPath = path.join(
    tempDir,
    `overlay-visual-probe-${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
  );
  try {
    const result = await runProcessExit('screencapture', ['-x', tempPath]);
    if (result.code !== 0) {
      const message = result.stderr.trim() || 'Unknown screencapture failure';
      throw new Error(`Failed to capture compositor screenshot: ${message}`);
    }
    await waitForCondition('Overlay visual probe compositor screenshot', 1000, async () => (
      fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0 ? true : null
    ));
    return fs.readFileSync(tempPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
}

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function spawnPnpm(args, options) {
  return spawn(getPnpmCommand(), args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

async function findRunningInterpreterApps() {
  if (process.platform === 'win32') {
    const result = await runProcessExit('tasklist', ['/fo', 'csv', '/nh']);
    if (result.code !== 0) {
      throw new Error(`Failed to inspect running apps before form tests: ${result.stderr.trim()}`);
    }

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const columns = line.match(/("([^"]|"")*"|[^,]+)/g) || [];
        const imageName = columns[0]?.replace(/^"|"$/g, '').replace(/""/g, '"') || '';
        const pid = Number(columns[1]?.replace(/^"|"$/g, '') || 0);
        return { pid, command: imageName, args: imageName };
      })
      .filter((entry) => entry.pid > 0 && entry.pid !== process.pid && entry.pid !== process.ppid)
      .filter((entry) => /^Interpreter(?:\s+Internal)?\.exe$/i.test(entry.command));
  }

  const result = await runProcessExit('ps', ['-axo', 'pid=,comm=,args=']);
  if (result.code !== 0) {
    throw new Error(`Failed to inspect running apps before form tests: ${result.stderr.trim()}`);
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        command: match[2],
        args: match[3],
      };
    })
    .filter(Boolean)
    .filter((entry) => entry.pid !== process.pid && entry.pid !== process.ppid)
    .filter((entry) => {
      const commandName = path.basename(entry.command);
      if (/^Interpreter(?:\s+Internal)?$/i.test(commandName)) {
        return true;
      }
      if (process.platform === 'darwin') {
        return /\/Interpreter(?: [^/]*)?\.app\/Contents\/MacOS\//.test(entry.args);
      }
      return /\/interpreter(?:-internal)?(?:\s|$)/i.test(entry.command)
        || /\/Interpreter(?:-Internal)?(?:\s|$)/.test(entry.command);
    });
}

async function assertNoRunningInterpreterApp() {
  const runningApps = await findRunningInterpreterApps();
  if (runningApps.length === 0) {
    return;
  }

  const details = runningApps
    .map((entry) => `pid=${entry.pid} command=${entry.command}`)
    .join(', ');
  throw new Error(`Interpreter is already running (${details}). Ask the user if you can close their app.`);
}

function setupLogging() {
  ensureDir(OUTPUT_DIR);
  masterLogPath = path.join(OUTPUT_DIR, 'form-tests.log');
  appLogPath = path.join(OUTPUT_DIR, 'app.log');
  masterLogStream = fs.createWriteStream(masterLogPath, { flags: 'w' });
  appLogStream = fs.createWriteStream(appLogPath, { flags: 'w' });

  console.log = (...args) => {
    const message = args.join(' ');
    originalConsole.log(...args);
    if (masterLogStream && !masterLogStream.destroyed && masterLogStream.writable) {
      masterLogStream.write(`[LOG] ${message}\n`);
    }
  };

  console.error = (...args) => {
    const message = args.join(' ');
    originalConsole.error(...args);
    if (masterLogStream && !masterLogStream.destroyed && masterLogStream.writable) {
      masterLogStream.write(`[ERROR] ${message}\n`);
    }
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    skipBuild: false,
    continueOnFailure: false,
    testIds: null,
    timeoutMs: REAL_INTERACTION_WATCHDOG_MS,
    mode: 'real',
    manual: false,
    manualServer: false,
    guiInspect: false,
    overlayVisualProbe: false,
    guiInspectPauseMs: 0,
    dragSelectForm: false,
    dragSelectFormChaos: false,
    overlayLaunchSmoke: false,
    escOnReview: null,
    apiMode: 'local',
    reuseLocalApi: false,
    formSurface: 'electron',
    sourceContext: 'window',
    chromeProfile: 'temp',
    chromeLiveUrl: null,
    recordVideo: false,
    recordVideoSeconds: 180,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--manual') {
      options.manual = true;
    } else if (arg === '--manual-server') {
      options.manualServer = true;
    } else if (arg === '--continue-on-failure') {
      options.continueOnFailure = true;
    } else if (arg === '--test' && args[i + 1]) {
      options.testIds = args[++i].split(',').map((value) => value.trim()).filter(Boolean);
    } else if (arg === '--timeout-ms' && args[i + 1]) {
      options.timeoutMs = Number(args[++i]);
    } else if (arg === '--mode' && args[i + 1]) {
      options.mode = String(args[++i]).trim().toLowerCase();
    } else if (arg === '--gui-inspect') {
      options.guiInspect = true;
    } else if (arg === '--overlay-visual-probe') {
      options.overlayVisualProbe = true;
      options.dragSelectForm = true;
    } else if (arg === '--drag-select-form') {
      options.dragSelectForm = true;
    } else if (arg === '--chaos-drag-select-form') {
      options.dragSelectForm = true;
      options.dragSelectFormChaos = true;
    } else if (arg === '--overlay-launch-smoke') {
      options.overlayLaunchSmoke = true;
      options.dragSelectForm = true;
    } else if (arg === '--gui-inspect-pause-ms' && args[i + 1]) {
      options.guiInspectPauseMs = Number(args[++i]);
    } else if (arg === '--esc-on-review' && args[i + 1]) {
      options.escOnReview = Number(args[++i]);
    } else if (arg === '--server-api') {
      options.apiMode = 'server';
    } else if (arg === '--reuse-local-api') {
      options.reuseLocalApi = true;
    } else if (arg === '--chrome-form') {
      options.formSurface = 'chrome';
      options.sourceContext = 'paste';
    } else if (arg === '--safari-form') {
      options.formSurface = 'safari';
      options.sourceContext = 'paste';
    } else if (arg === '--chrome-live-url' && args[i + 1]) {
      options.formSurface = 'chrome-live';
      options.sourceContext = 'paste';
      options.chromeLiveUrl = String(args[++i]).trim();
    } else if (arg === '--form-surface' && args[i + 1]) {
      options.formSurface = String(args[++i]).trim().toLowerCase();
    } else if (arg === '--source-context' && args[i + 1]) {
      options.sourceContext = String(args[++i]).trim().toLowerCase();
    } else if (arg === '--chrome-profile' && args[i + 1]) {
      options.chromeProfile = String(args[++i]).trim().toLowerCase();
    } else if (arg === '--record-video') {
      options.recordVideo = true;
    } else if (arg === '--record-video-seconds' && args[i + 1]) {
      options.recordVideo = true;
      options.recordVideoSeconds = Number(args[++i]);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node form-tests/main.cjs [options]

Options:
  --skip-build           Reuse the existing dist-electron build. Dangerous after changing Electron or overlay source.
  --manual               Open the shared form-test surface for manual inspection/filling and do not run the agent or grading
  --manual-server        Start the standalone form workbench server and do not build or run the app
  --continue-on-failure  Run all tests even after a failure
  --test <id,id>         Run only specific test ids (for example: test-001,test-003)
  --timeout-ms <n>       Watchdog timeout per test (default: ${REAL_INTERACTION_WATCHDOG_MS})
  --mode <real|debug>    Run real keyboard-driven overlay flow or legacy debug flow (default: real)
  --gui-inspect          GUI inspection mode: captures before/after crops for every type review with minimal settle waits
  --overlay-visual-probe
                         Pixel-test the world overlay compositor: target QR covered by overlay QR, moves with target window, and occludes behind a foreground app
  --drag-select-form     Run the normal graded form test, but first use a real mouse drag to scope the overlay to an AX-derived form region
  --chaos-drag-select-form
                         Stress the scoped-form overlay flow: dismiss/reopen the overlay, perform multiple chaotic drags, then do the proper form scope drag
  --gui-inspect-pause-ms <n>
                         Extra pause after the first captured review, if desired (default: 0)
  --esc-on-review <n>    In real mode, press Esc instead of Ctrl on the nth review prompt
  --overlay-launch-smoke Run a launch smoke that keeps the real form UX (Ctrl+Space, drag scope, type, Enter) but asserts the new normal-agent overlay handoff after submit
  --server-api           Use the hosted server path instead of starting local new_api
  --reuse-local-api      Reuse an already-running local API instead of restarting it
  --chrome-form          Convenience mode: real Chrome form surface + pasted source prompt (real mode only)
  --safari-form          Convenience mode: real Safari form surface + pasted source prompt (real mode only)
  --chrome-live-url <u>  Use an already-open real Chrome tab URL as the destination form surface (real mode only)
  --form-surface <kind>  Form surface: electron | chrome | safari (default: electron)
  --source-context <kind>
                         Source context: window | paste (default: window)
  --chrome-profile <kind>
                         Chrome profile: normal | temp (default: normal)
  --record-video         Record the full display for each test with macOS ScreenCaptureKit/screencapture
  --record-video-seconds <n>
                         Maximum recording duration per test in seconds (default: 180)
  --help, -h             Show this help message
`);
}

function printSkipBuildWarning(stage) {
  const banner = '='.repeat(98);
  const stageLabel = stage === 'start' ? 'START' : 'END';
  console.log(banner);
  console.log(`!!! --skip-build WARNING (${stageLabel}) !!!`);
  console.log('This run is reusing the existing dist-electron bundle.');
  console.log('If you changed Electron, overlay, preload, or renderer code, do not trust this run.');
  console.log('Avoid this mistake: rebuild first with `pnpm run build:electron`, then rerun the form test.');
  console.log(banner);
}

function summarizeDocument(document) {
  if (Array.isArray(document?.summaryLines) && document.summaryLines.length > 0) {
    return [document.title, document.subtitle || '', '', ...document.summaryLines].filter(Boolean).join('\n');
  }

  const lines = [document?.title || 'Source Document'];
  if (document?.subtitle) {
    lines.push(document.subtitle);
  }
  for (const item of document?.meta || []) {
    lines.push(`${item.label}: ${item.value}`);
  }
  for (const section of document?.sections || []) {
    lines.push('');
    lines.push(`[${section.title}]`);
    for (const entry of section.items || []) {
      if (entry.type === 'fact') {
        lines.push(`${entry.label}: ${entry.value}`);
      } else if (entry.type === 'message') {
        lines.push(`${entry.speaker} (${entry.time})`);
        lines.push(entry.text);
      } else {
        lines.push(entry.text);
      }
    }
  }
  return lines.join('\n').trim();
}

function summarizePasteSource(document) {
  if (Array.isArray(document?.summaryLines) && document.summaryLines.length > 0) {
    return document.summaryLines
      .map((line) => String(line || '').trim())
      .filter(Boolean)
      .join('\n');
  }

  const lines = [];
  for (const item of document?.meta || []) {
    lines.push(`${item.label}: ${item.value}`);
  }
  for (const section of document?.sections || []) {
    for (const entry of section.items || []) {
      if (entry.type === 'fact') {
        lines.push(`${entry.label}: ${entry.value}`);
      }
    }
  }
  return lines.join('\n').trim();
}

function buildBenchmarkSystemAddendum(testConfig, options) {
  const completionInstruction = options.formSurface === 'chrome-live'
    ? 'Continue until every visible required field matches the source exactly. Do not activate any save, submit, place-order, or final confirmation control in this live-tab run.'
    : 'Continue until every visible required field matches the source exactly, then activate the visible save/submit control when appropriate.';
  const surfaceInstructions = options.formSurface === 'chrome' || options.formSurface === 'chrome-live'
    ? [
        'The destination form is inside the webpage content of the active browser tab.',
        'Do not use values from the browser UI such as the address bar, page URL, tab titles, toolbar buttons, or other surrounding app chrome unless the task explicitly asks for them.',
      ]
    : [
        'The destination form is in the selected screen region.',
        'Use the selected region as the working area. Do not rely on surrounding window titles, app chrome, or benchmark harness details as source data.',
      ];
  return [
    ...surfaceInstructions,
    'Match field meanings exactly. For example, first name is not a full name, and for radio/select/checkbox fields you should only choose explicit matches for that same source field.',
    'Autocomplete or address-lookup selections do not count as filling a separate apartment, suite, or unit field unless that dedicated field visibly contains the provided unit value.',
    'Do not invent missing values. Leave unsupported fields blank when the requested value is missing.',
    'Treat any visible prefilled values as editable defaults, not ground truth. If a visible field shows the wrong value, overwrite it to match the pasted source.',
    'If a previously observed field was blank or wrong and a later diff does not show that field changing, treat it as still blank or wrong.',
    'If the source already gives the exact value for a dropdown, combobox, radio group, or menu, keep interacting with that control until the control itself visibly shows that value. Do not ask for a vision screenshot just to inspect ordinary form options.',
    'Use atomic actions only.',
    completionInstruction,
    'If fields are wrong, keep correcting them.',
    'A success message or saved banner does not mean the task is complete if the same form is still visible with any provided field still blank or incorrect.',
    'If a field only exposes a live input while focused, focus it, type, commit it with Enter or by clicking another visible page element if needed, then reread the page before deciding the next action.',
  ].join('\n');
}

function buildRunnerPrompt(testConfig, options) {
  if (resolveEffectiveSourceContext(testConfig, options) === 'paste') {
    const sourceText = summarizePasteSource(testConfig?.info?.document);
    return [
      'Please fill this form with this information:',
      '',
      sourceText,
    ].filter(Boolean).join('\n').trim();
  }

  return testConfig.task.instruction;
}

function buildRunnerSystemAddendum(testConfig, options) {
  if (resolveEffectiveSourceContext(testConfig, options) !== 'paste') {
    return '';
  }

  return buildBenchmarkSystemAddendum(testConfig, options);
}

function resolveEffectiveFormSurface(testConfig, options) {
  if (options.formSurface !== 'electron') {
    return options.formSurface;
  }

  const family = String(testConfig?.form?.surface?.family || '').trim().toLowerCase();
  if (family === 'checkout-shipping-ax-trap') {
    return 'chrome';
  }

  return 'electron';
}

function resolveEffectiveSourceContext(testConfig, options) {
  if (typeof testConfig?.task?.sourceContext === 'string' && testConfig.task.sourceContext.trim()) {
    return testConfig.task.sourceContext.trim();
  }
  if (options.dragSelectForm) {
    return 'paste';
  }
  const family = String(testConfig?.form?.surface?.family || '').trim().toLowerCase();
  if (family === 'checkout-shipping-ax-trap') {
    return 'paste';
  }
  return options.sourceContext;
}

function shouldRunDragSelectFormFlow(testConfig, options) {
  return options.dragSelectForm || testConfig?.task?.overlaySelectionMode === 'drag-select-form';
}

function shouldRunOverlayLaunchSmoke(testConfig, options) {
  return options.overlayLaunchSmoke || testConfig?.task?.overlaySubmitMode === 'workspace-agent';
}

function getOverlayDetachExpectation(testConfig) {
  return typeof testConfig?.task?.overlayDetachExpectation === 'string'
    ? testConfig.task.overlayDetachExpectation.trim()
    : '';
}

function isLiveOverlayFillHandoff(testConfig, options) {
  return (
    shouldRunOverlayLaunchSmoke(testConfig, options)
    && getOverlayDetachExpectation(testConfig) === 'live-overlay-fill'
  ) || (
    process.platform === 'win32'
    && shouldRunDragSelectFormFlow(testConfig, options)
    && !shouldRunOverlayLaunchSmoke(testConfig, options)
  );
}

function resolveOverlayWorkspaceAgentProfileId(testConfig) {
  const explicitProfileId = typeof testConfig?.task?.overlayProfileId === 'string'
    ? testConfig.task.overlayProfileId.trim()
    : '';
  if (explicitProfileId) {
    return explicitProfileId;
  }

  const normalizedProfileLabel = normalizePickerLabel(testConfig?.task?.overlayProfileLabel);
  if (normalizedProfileLabel.includes('fast')) {
    return 'onboarding:interpreter-fast';
  }
  if (normalizedProfileLabel.includes('smart')) {
    return 'form-tests:interpreter-smart';
  }
  return 'form-tests:interpreter-smart';
}

function normalizeSourceFieldLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\boptional\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getInlineSourceFieldIds(testConfig) {
  const inlineFieldIds = new Set(Object.keys(testConfig?.task?.expectedValues || {}));
  const sourceLabels = new Set(
    (testConfig?.info?.document?.summaryLines || [])
      .map((line) => String(line).split(':', 1)[0] || '')
      .map((label) => normalizeSourceFieldLabel(label))
      .filter(Boolean),
  );

  for (const field of testConfig?.form?.fields || []) {
    if (sourceLabels.has(normalizeSourceFieldLabel(field.label))) {
      inlineFieldIds.add(field.id);
    }
  }

  return Array.from(inlineFieldIds);
}

function buildChromeSurfaceBenchmarkSession(testConfig, options = {}) {
  const includeSourceDocument = options.includeSourceDocument !== false;
  const family = String(testConfig?.form?.surface?.family || '').trim().toLowerCase();
  const shouldInlineSource = includeSourceDocument && family !== 'checkout-shipping-ax-trap';

  return {
    inlineSourceFieldIds: getInlineSourceFieldIds(testConfig),
    sourceDocument: shouldInlineSource ? (testConfig?.info?.document || null) : null,
    sourceSurface: shouldInlineSource ? (testConfig?.info?.surface || null) : null,
  };
}

function buildChromeSurfaceFormConfig(testConfig, options = {}) {
  return {
    ...(testConfig?.form || {}),
    benchmarkSession: buildChromeSurfaceBenchmarkSession(testConfig, options),
  };
}

function buildSourceDocumentLines(document) {
  if (!document) {
    return [];
  }

  if (Array.isArray(document.summaryLines) && document.summaryLines.length > 0) {
    return document.summaryLines.map((line) => String(line || '').trim()).filter(Boolean);
  }

  const lines = [];
  for (const item of document.meta || []) {
    if (!item || !item.label) {
      continue;
    }
    lines.push(`${item.label}: ${item.value || ''}`.trim());
  }

  for (const section of document.sections || []) {
    for (const entry of section.items || []) {
      if (!entry) {
        continue;
      }
      if (entry.type === 'fact') {
        lines.push(`${entry.label}: ${entry.value || ''}`.trim());
      } else if (entry.type === 'message') {
        lines.push(`${entry.speaker} (${entry.time}): ${entry.text}`.trim());
      } else if (entry.text) {
        lines.push(String(entry.text).trim());
      }
    }
  }

  return lines.filter(Boolean);
}

function createManualWorkbenchSessionId(testId) {
  return `manual-${testId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createManualWorkbenchSession(testConfig) {
  return {
    testId: testConfig.id,
    sessionId: createManualWorkbenchSessionId(testConfig.id),
    latestTaskState: null,
    latestPageDebugSnapshot: null,
    latestPageDebugEvents: [],
    latestPageErrors: [],
    stateRequestId: 0,
    latestReportedStateRequestId: 0,
    updatedAt: 0,
  };
}

function resetManualWorkbenchSession(session, testConfig) {
  session.sessionId = createManualWorkbenchSessionId(testConfig.id);
  session.latestTaskState = null;
  session.latestPageDebugSnapshot = null;
  session.latestPageDebugEvents = [];
  session.latestPageErrors = [];
  session.stateRequestId = 0;
  session.latestReportedStateRequestId = 0;
  session.updatedAt = 0;
  resetTestOutputDir(testConfig.id);
}

function countNonEmptyValues(values) {
  return Object.values(values || {}).filter((value) => !isEmptyValue(value)).length;
}

function buildManualWorkbenchEvaluation(testConfig, taskState) {
  if (!taskState) {
    return null;
  }

  return evaluateTask(testConfig, taskState);
}

function buildManualWorkbenchStatus(testConfig, session) {
  const taskState = session?.latestTaskState || null;
  const evaluation = taskState ? buildManualWorkbenchEvaluation(testConfig, taskState) : null;
  const formState = taskState?.form || {};
  const values = formState.values || {};

  return {
    testId: testConfig.id,
    sessionId: session?.sessionId || null,
    updatedAt: session?.updatedAt || 0,
    pageErrors: Array.isArray(session?.latestPageErrors) ? session.latestPageErrors.length : 0,
    hasState: Boolean(taskState),
    evaluation: evaluation
      ? {
        ...evaluation,
        passed: evaluation.incorrect === 0,
      }
      : null,
    form: {
      visibleFieldCount: Array.isArray(formState.visibleFieldIds) ? formState.visibleFieldIds.length : 0,
      visibleRequiredFieldCount: Array.isArray(formState.visibleRequiredFieldIds) ? formState.visibleRequiredFieldIds.length : 0,
      nonEmptyFieldCount: countNonEmptyValues(values),
      submitted: Boolean(formState.submitted),
    },
  };
}

function normalizeFormSurfaceSession(session) {
  const normalized = {
    kind: session.kind,
    async loadTest(nextTestConfig) {
      if (typeof session.loadTest === 'function') {
        return session.loadTest(nextTestConfig);
      }
    },
    async focus() {
      return session.focus();
    },
    async getTaskState() {
      return session.getTaskState();
    },
    async captureFormCrop(bounds, padding = GUI_INSPECT_CROP_PADDING_DIP) {
      if (typeof session.captureFormCrop !== 'function') {
        return null;
      }
      return session.captureFormCrop(bounds, padding);
    },
    async getWindowBounds() {
      if (typeof session.getWindowBounds !== 'function') {
        return null;
      }
      return session.getWindowBounds();
    },
    async isSubmittedAsync() {
      if (typeof session.isSubmittedAsync === 'function') {
        return session.isSubmittedAsync();
      }
      if (typeof session.isSubmitted === 'function') {
        return Boolean(session.isSubmitted());
      }
      return false;
    },
    async close() {
      return session.close();
    },
  };

  if (typeof session.setTargetVisualProbe === 'function') {
    normalized.setTargetVisualProbe = async (probe) => session.setTargetVisualProbe(probe);
  }

  return normalized;
}

function getElectronBinary() {
  return require('electron');
}

function captureChildLogs(prefix, stream, data, isError) {
  const message = data.toString();
  const lines = message.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (
      prefix === 'LocalAPI'
      && localApiShutdownRequested
      && (
        line.includes('ELIFECYCLE')
        || line.includes('Terminated: 15')
      )
    ) {
      continue;
    }

    const formatted = `[${prefix}] ${line}`;
    if (isError) {
      originalConsole.error(formatted);
    } else {
      originalConsole.log(formatted);
    }
    if (masterLogStream) {
      masterLogStream.write(`${isError ? '[ERROR]' : '[LOG]'} ${formatted}\n`);
    }
    if (stream) {
      stream.write(`${formatted}\n`);
    }
  }
}

function isHttpHealthy(url, parser) {
  return new Promise((resolve) => {
    const request = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }

        if (!parser) {
          resolve({});
          return;
        }

        try {
          resolve(parser(body));
        } catch {
          resolve(null);
        }
      });
    });

    request.on('error', () => resolve(null));
    request.setTimeout(1500, () => {
      request.destroy();
      resolve(null);
    });
  });
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

async function waitForCondition(label, timeoutMs, fn, pollIntervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) {
      return result;
    }
    await wait(pollIntervalMs);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function findAvailablePort(start, end) {
  for (let port = start; port <= end; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (available) {
      return port;
    }
  }
  throw new Error(`No available port between ${start} and ${end}`);
}

function getDefaultChromeUserDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error('LOCALAPPDATA is not set, so the default Chrome profile path cannot be resolved.');
    }
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }

  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.config', 'google-chrome');
  }

  throw new Error(`Chrome profile path is unsupported on platform: ${process.platform}`);
}

function getChromeUserDataDir(options) {
  if (options.chromeProfile === 'normal') {
    return {
      path: getDefaultChromeUserDataDir(),
      temporary: false,
    };
  }

  return {
    path: fs.mkdtempSync(path.join(os.tmpdir(), 'form-tests-chrome-')),
    temporary: true,
  };
}

async function waitForChildExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    wait(timeoutMs),
  ]);
}

async function waitForStreamFinish(stream) {
  if (!stream) {
    return;
  }

  await new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) {
      resolve();
      return;
    }

    stream.once('finish', resolve);
    stream.end();
  });
}

async function triggerEmergencyAbort(reason) {
  if (emergencyAbortPromise) {
    return emergencyAbortPromise;
  }

  emergencyAbortRequested = true;
  emergencyAbortPromise = (async () => {
    console.error(`[EmergencyAbort] ${reason}`);

    try {
      if (appProcess) {
        const child = appProcess;
        appProcess = null;
        await terminateChildProcess(child, 'MainApp', { force: true });
      }
      await cleanup({ emergency: true });
    } catch (error) {
      console.error(`[EmergencyAbort] Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      process.exit(130);
    }
  })();

  return emergencyAbortPromise;
}

function requestHarnessShutdown(signal = 'SIGINT') {
  if (shutdownSignalSent) {
    return;
  }

  shutdownSignalSent = true;
  void triggerEmergencyAbort(`Requested harness shutdown via ${signal}`);
}

async function withEmergencyAbortHotCornerSuspended(callback) {
  emergencyAbortHotCornerSuspendDepth += 1;
  try {
    return await callback();
  } finally {
    emergencyAbortHotCornerSuspendDepth = Math.max(0, emergencyAbortHotCornerSuspendDepth - 1);
  }
}

function startEmergencyAbortMonitor() {
  if (emergencyAbortMonitor) {
    emergencyAbortMonitor.stop();
  }

  let stopped = false;
  let sampleInFlight = false;
  let wasInHotCorner = null;
  let hotCornerEnteredAt = null;
  const interval = setInterval(async () => {
    if (stopped || sampleInFlight) {
      return;
    }

    sampleInFlight = true;
    try {
      const position = await mouse.getPosition();
      if (emergencyAbortHotCornerSuspendDepth > 0) {
        wasInHotCorner = false;
        hotCornerEnteredAt = null;
        return;
      }
      const isInHotCorner =
        position.x <= EMERGENCY_ABORT_CORNER_SIZE_PX
        && position.y <= EMERGENCY_ABORT_CORNER_SIZE_PX;

      if (wasInHotCorner === null) {
        wasInHotCorner = isInHotCorner;
        hotCornerEnteredAt = isInHotCorner ? Date.now() : null;
        return;
      }

      if (isInHotCorner && !wasInHotCorner) {
        hotCornerEnteredAt = Date.now();
      } else if (!isInHotCorner) {
        hotCornerEnteredAt = null;
      }

      if (isInHotCorner && hotCornerEnteredAt !== null) {
        const dwellMs = Date.now() - hotCornerEnteredAt;
        if (dwellMs >= EMERGENCY_ABORT_DWELL_MS) {
          console.error(
            `[EmergencyAbort] Mouse stayed in top-left hot corner for ${dwellMs}ms at (${Math.round(position.x)}, ${Math.round(position.y)}); shutting down form tests.`,
          );
          stop();
          void triggerEmergencyAbort(
            `Mouse stayed in top-left hot corner for ${dwellMs}ms at (${Math.round(position.x)}, ${Math.round(position.y)})`,
          );
        }
      }
      wasInHotCorner = isInHotCorner;
    } catch (error) {
      if (!stopped) {
        console.warn(`[EmergencyAbort] Failed to sample mouse position: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      sampleInFlight = false;
    }
  }, 50);

  interval.unref?.();

  function stop() {
    if (stopped) {
      return;
    }

    stopped = true;
    clearInterval(interval);
    if (emergencyAbortMonitor?.stop === stop) {
      emergencyAbortMonitor = null;
    }
  }

  emergencyAbortMonitor = { stop };
  return emergencyAbortMonitor;
}

async function areLocalApiProcessesHealthy() {
  const [python, desktop] = await Promise.all(
    LOCAL_API_HEALTHCHECKS.map((url) => isHttpHealthy(url)),
  );
  return {
    python: Boolean(python),
    desktop: Boolean(desktop),
  };
}

async function waitForLocalApiShutdown(label, timeoutMs = 15000) {
  await waitForCondition(label, timeoutMs, async () => {
    const { python, desktop } = await areLocalApiProcessesHealthy();
    return !python && !desktop ? true : null;
  });
}

async function forceKillListeningPort(port) {
  if (process.platform === 'win32') {
    return;
  }

  const result = await runProcessExit('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN']);
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`Failed to inspect TCP port ${port}: ${result.stderr.trim()}`);
  }

  const pids = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (pids.length === 0) {
    return;
  }

  const killResult = await runProcessExit('kill', ['-9', ...pids]);
  if (killResult.code !== 0) {
    throw new Error(`Failed to kill listener(s) on TCP port ${port}: ${killResult.stderr.trim()}`);
  }
}

async function terminateChildProcess(child, label, options = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (options.force) {
    child.kill('SIGKILL');
    await waitForChildExit(child, 1000);
    return;
  }

  child.kill('SIGTERM');
  await waitForChildExit(child, 5000);

  if (child.exitCode === null && child.signalCode === null) {
    console.warn(`[${label}] Child did not exit after SIGTERM, escalating to SIGKILL`);
    child.kill('SIGKILL');
    await waitForChildExit(child, 1000);
  }
}

async function startTestScreenRecording(testId, options) {
  if (!options.recordVideo) {
    return null;
  }
  if (process.platform !== 'darwin') {
    throw new Error('--record-video currently uses macOS screencapture and must run inside the macOS VM/session.');
  }

  const maxSeconds = Number.isFinite(options.recordVideoSeconds) && options.recordVideoSeconds > 0
    ? Math.ceil(options.recordVideoSeconds)
    : 180;
  const testOutputDir = createTestOutputDir(testId);
  const recordingPath = path.join(testOutputDir, 'recording.mp4');
  const logPath = path.join(testOutputDir, 'recording.log');
  const frameDir = path.join(testOutputDir, 'recording_frames');
  fs.rmSync(recordingPath, { force: true });
  fs.rmSync(logPath, { force: true });
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  const fps = Number.parseInt(process.env.FORM_TESTS_RECORD_VIDEO_FPS || '10', 10);
  const effectiveFps = Number.isFinite(fps) && fps > 0 ? fps : 10;
  const intervalSeconds = (1 / effectiveFps).toFixed(3);
  const script = [
    'set -e',
    'i=0',
    'started_at=$(date +%s)',
    'while true; do',
    '  now=$(date +%s)',
    '  if [ $((now - started_at)) -ge "$MAX_SECONDS" ]; then',
    '    break',
    '  fi',
    '  frame=$(printf "%s/frame_%06d.png" "$FRAME_DIR" "$i")',
    '  /usr/sbin/screencapture -x -D 1 "$frame" >/dev/null 2>&1 || true',
    '  i=$((i + 1))',
    '  sleep "$INTERVAL_SECONDS"',
    'done',
  ].join('\n');

  const child = spawn('zsh', ['-lc', script], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FRAME_DIR: frameDir,
      INTERVAL_SECONDS: intervalSeconds,
      MAX_SECONDS: String(maxSeconds),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (data) => logStream.write(data));
  child.once('error', (error) => {
    logStream.write(`recording-error: ${error.message}\n`);
  });

  await wait(1200);
  if (child.exitCode !== null || child.signalCode !== null) {
    logStream.end();
    await waitForStreamFinish(logStream);
    throw new Error(`Screen recording exited before test started. See ${logPath}`);
  }

  console.log(`[Recording] Started full-display Tahoe image-sequence recording for ${testId}: ${recordingPath}`);
  return {
    path: recordingPath,
    logPath,
    frameDir,
    fps: effectiveFps,
    child,
    logStream,
  };
}

async function stopTestScreenRecording(recording) {
  if (!recording) {
    return;
  }

  if (recording.child.exitCode === null && recording.child.signalCode === null) {
    recording.child.kill('SIGTERM');
    await waitForChildExit(recording.child, 10000);
    if (recording.child.exitCode === null && recording.child.signalCode === null) {
      console.warn(`[Recording] image-sequence recorder did not stop after SIGTERM; forcing stop for ${recording.path}`);
      recording.child.kill('SIGKILL');
      await waitForChildExit(recording.child, 1000);
    }
  }

  recording.logStream.end();
  await waitForStreamFinish(recording.logStream);
  const frameCount = fs.existsSync(recording.frameDir)
    ? fs.readdirSync(recording.frameDir).filter((name) => name.endsWith('.png')).length
    : 0;
  if (frameCount === 0) {
    throw new Error(`Screen recording did not capture any frames in ${recording.frameDir}. See ${recording.logPath}`);
  }

  const encode = await runProcessExit('ffmpeg', [
    '-y',
    '-framerate',
    String(recording.fps),
    '-i',
    path.join(recording.frameDir, 'frame_%06d.png'),
    '-vf',
    'fps=30',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    recording.path,
  ]);
  if (encode.code !== 0) {
    fs.appendFileSync(recording.logPath, `\nffmpeg failed:\n${encode.stderr}\n${encode.stdout}\n`);
    throw new Error(`Failed to encode screen recording: ${recording.logPath}`);
  }

  if (!fs.existsSync(recording.path) || fs.statSync(recording.path).size === 0) {
    throw new Error(`Screen recording did not produce a usable file: ${recording.path}. See ${recording.logPath}`);
  }

  const probe = await runProcessExit('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate,avg_frame_rate,nb_frames',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1',
    recording.path,
  ]);
  if (probe.code === 0) {
    const probePath = recording.path.replace(/\.(mov|mp4)$/i, '.ffprobe.txt');
    fs.writeFileSync(probePath, probe.stdout);
    console.log(`[Recording] Saved ${recording.path}`);
    console.log(`[Recording] ffprobe:\n${probe.stdout.trim()}`);
  } else {
    console.warn(`[Recording] ffprobe failed for ${recording.path}: ${probe.stderr.trim()}`);
  }
}

async function stopManagedLocalApi() {
  if (apiWasAlreadyRunning) {
    return;
  }

  localApiShutdownRequested = true;
  const child = apiProcess;
  apiProcess = null;
  await terminateChildProcess(child, 'LocalAPI');

  if (process.platform === 'win32') {
    return;
  }

  for (const [command, args] of LOCAL_API_KILL_COMMANDS) {
    const result = await runProcessExit(command, args);
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`Failed to stop local API process (${command} ${args.join(' ')}): ${result.stderr.trim()}`);
    }
  }

  await forceKillListeningPort(LOCAL_PYTHON_API_PORT);
  await forceKillListeningPort(LOCAL_DESKTOP_API_PORT);

  await waitForLocalApiShutdown('Managed local API shutdown');
}

function cleanupTemporaryDirectory(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (error) {
    console.warn(`[Chrome Form] Failed to remove temporary profile directory ${dirPath}: ${error.message}`);
  }
}

async function readJsonRequestBody(req) {
  const body = await new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body exceeded 1MB.'));
      }
    });
    req.once('end', () => resolve(raw));
    req.once('error', reject);
  });

  return JSON.parse(body || '{}');
}

async function buildApp() {
  console.log('[Build] Running pnpm run build');
  await new Promise((resolve, reject) => {
    const child = spawnPnpm(['run', 'build'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        INTERPRETER_OVERLAY_DEBUG_BUILD: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => captureChildLogs('Build', masterLogStream, data, false));
    child.stderr.on('data', (data) => captureChildLogs('Build', masterLogStream, data, true));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Build exited with code ${code}`));
    });
  });
}

function runProcessExit(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_ROOT,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function activateChromeTabByUrl(targetUrl) {
  if (process.platform !== 'darwin') {
    return;
  }

  const escapedTargetUrl = escapeAppleScriptString(targetUrl);
  const scriptLines = [
    'set matched to false',
    `set targetUrl to "${escapedTargetUrl}"`,
    'tell application "Google Chrome"',
    '  activate',
    '  repeat with windowIndex from 1 to count of windows',
    '    set currentWindow to window windowIndex',
    '    repeat with tabIndex from 1 to count of tabs of currentWindow',
    '      set currentTab to tab tabIndex of currentWindow',
    '      if (URL of currentTab starts with targetUrl) then',
    '        set active tab index of currentWindow to tabIndex',
    '        set index of currentWindow to 1',
    '        set matched to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if matched then',
    '      exit repeat',
    '    end if',
    '  end repeat',
    'end tell',
    'if matched is false then error "Chrome form tab not found"',
  ];

  const args = scriptLines.flatMap((line) => ['-e', line]);
  const result = await runProcessExit('osascript', args);
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to activate Chrome form tab: ${message}`);
  }
}

async function openChromeWindowByUrl(targetUrl, bounds = null) {
  if (process.platform !== 'darwin') {
    return;
  }

  const escapedTargetUrl = escapeAppleScriptString(targetUrl);
  const windowBounds = await resolveBrowserWindowBounds(bounds);
  const scriptLines = [
    `set targetUrl to "${escapedTargetUrl}"`,
    'tell application "Google Chrome"',
    '  activate',
    '  make new window',
    '  set URL of active tab of front window to targetUrl',
    '  set index of front window to 1',
    'end tell',
  ];
  if (windowBounds) {
    scriptLines.splice(
      scriptLines.length - 1,
      0,
      `tell application "Google Chrome" to set bounds of front window to {${windowBounds.x}, ${windowBounds.y}, ${windowBounds.x + windowBounds.width}, ${windowBounds.y + windowBounds.height}}`,
    );
  }
  scriptLines.push('delay 0.2');
  scriptLines.push('tell application "Google Chrome" to return URL of active tab of front window');

  const args = scriptLines.flatMap((line) => ['-e', line]);
  const result = await runProcessExit('osascript', args);
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to open Chrome form tab: ${message}`);
  }
  const activeUrl = result.stdout.trim();
  if (!activeUrl.startsWith(targetUrl)) {
    throw new Error(`Chrome opened the wrong active URL. expected=${targetUrl} actual=${activeUrl || '""'}`);
  }
}

async function openUrlInChrome(targetUrl) {
  if (process.platform === 'darwin') {
    const result = await runProcessExit('open', ['-a', 'Google Chrome', targetUrl]);
    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || 'Unknown open(1) error';
      throw new Error(`Failed to open Chrome workbench URL: ${message}`);
    }
    await waitForChromeTabByUrl(targetUrl, 15000);
    await activateChromeTabByUrl(targetUrl);
    return;
  }

  const chromeBinary = getChromeBinaryPath();
  const child = spawn(chromeBinary, [targetUrl], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'ignore',
    detached: true,
  });

  await new Promise((resolve, reject) => {
    let settled = false;

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    child.once('spawn', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    });
  });

  child.unref();
}

async function closeChromeTabByUrl(targetUrl) {
  if (process.platform !== 'darwin') {
    return;
  }

  const escapedTargetUrl = escapeAppleScriptString(targetUrl);
  const scriptLines = [
    'set closedTab to false',
    `set targetUrl to "${escapedTargetUrl}"`,
    'tell application "Google Chrome"',
    '  repeat with windowIndex from 1 to count of windows',
    '    set currentWindow to window windowIndex',
    '    repeat with tabIndex from (count of tabs of currentWindow) to 1 by -1',
    '      set currentTab to tab tabIndex of currentWindow',
    '      if (URL of currentTab starts with targetUrl) then',
    '        close currentTab',
    '        set closedTab to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if closedTab then',
    '      exit repeat',
    '    end if',
    '  end repeat',
    'end tell',
  ];

  const args = scriptLines.flatMap((line) => ['-e', line]);
  const result = await runProcessExit('osascript', args);
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to close Chrome form tab: ${message}`);
  }
}

async function hasChromeTabWithUrl(targetUrl) {
  if (process.platform !== 'darwin') {
    return true;
  }

  const escapedTargetUrl = escapeAppleScriptString(targetUrl);
  const scriptLines = [
    'set matched to false',
    `set targetUrl to "${escapedTargetUrl}"`,
    'tell application "Google Chrome"',
    '  repeat with currentWindow in windows',
    '    repeat with currentTab in tabs of currentWindow',
    '      if (URL of currentTab starts with targetUrl) then',
    '        set matched to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if matched then exit repeat',
    '  end repeat',
    'end tell',
    'if matched then return "FOUND"',
    'return "MISSING"',
  ];

  const args = scriptLines.flatMap((line) => ['-e', line]);
  const result = await runProcessExit('osascript', args);
  if (result.code !== 0) {
    return false;
  }
  return result.stdout.trim() === 'FOUND';
}

async function waitForChromeTabByUrl(targetUrl, timeoutMs = 15000) {
  await waitForCondition('Chrome form tab', timeoutMs, async () => (
    await hasChromeTabWithUrl(targetUrl) ? true : null
  ));
}

async function getActiveChromeTabUrl() {
  if (process.platform !== 'darwin') {
    return null;
  }

  const scriptLines = [
    'tell application "Google Chrome"',
    '  if (count of windows) is 0 then return ""',
    '  return URL of active tab of front window',
    'end tell',
  ];
  const args = scriptLines.flatMap((line) => ['-e', line]);
  const result = await runProcessExit('osascript', args);
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to inspect active Chrome tab: ${message}`);
  }
  return result.stdout.trim();
}

async function waitForActiveChromeTabByUrl(targetUrl, timeoutMs = 15000) {
  await waitForCondition('Active Chrome form tab', timeoutMs, async () => {
    const activeUrl = await getActiveChromeTabUrl();
    if (activeUrl && activeUrl.startsWith(targetUrl)) {
      return activeUrl;
    }
    return null;
  });
}

async function getPrimaryDesktopBounds() {
  if (process.platform !== 'darwin') {
    return null;
  }

  const explicitBounds = String(process.env.FORM_TESTS_BROWSER_DISPLAY_BOUNDS || '').trim();
  if (explicitBounds) {
    const values = explicitBounds.split(',').map((value) => Number(value.trim()));
    if (values.length === 4 && values.every((value) => Number.isFinite(value))) {
      const [x, y, width, height] = values;
      if (width > 0 && height > 0) {
        return { x, y, width, height };
      }
    }
    throw new Error(`Invalid FORM_TESTS_BROWSER_DISPLAY_BOUNDS value: ${explicitBounds}`);
  }

  const scriptLines = [
    'tell application "Finder"',
    '  set b to bounds of window of desktop',
    '  return (item 1 of b as string) & "," & (item 2 of b as string) & "," & (item 3 of b as string) & "," & (item 4 of b as string)',
    'end tell',
  ];
  const result = await runProcessExit('osascript', scriptLines.flatMap((line) => ['-e', line]));
  if (result.code !== 0) {
    return getPrimaryDesktopBoundsFromScreenshot();
  }

  const values = result.stdout.trim().split(',').map((value) => Number(value.trim()));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return getPrimaryDesktopBoundsFromScreenshot();
  }

  const [left, top, right, bottom] = values;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

async function getPrimaryDesktopBoundsFromScreenshot() {
  const screenshotPath = path.join(os.tmpdir(), `interpreter-form-display-${process.pid}-${Date.now()}.png`);
  try {
    const captureResult = await runProcessExit('screencapture', ['-x', screenshotPath]);
    if (captureResult.code !== 0 || !fs.existsSync(screenshotPath)) {
      return null;
    }

    const png = PNG.sync.read(fs.readFileSync(screenshotPath));
    const explicitScale = Number(process.env.FORM_TESTS_BROWSER_DISPLAY_SCALE || 0);
    const scale = Number.isFinite(explicitScale) && explicitScale > 0
      ? explicitScale
      : (png.width > 2000 && png.height > 1200 ? 2 : 1);
    return {
      x: 0,
      y: 0,
      width: Math.round(png.width / scale),
      height: Math.round(png.height / scale),
    };
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(screenshotPath, { force: true });
    } catch {}
  }
}

async function resolveBrowserWindowBounds(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    return null;
  }

  const desktopBounds = await getPrimaryDesktopBounds();
  const minWidth = 900;
  const minHeight = 720;
  const requestedWidth = Math.max(minWidth, Math.round(bounds.width));
  const requestedHeight = Math.max(minHeight, Math.round(bounds.height));
  if (!desktopBounds) {
    return {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: requestedWidth,
      height: requestedHeight,
    };
  }

  const margin = 24;
  const maxWidth = Math.max(480, Math.round(desktopBounds.width - (margin * 2)));
  const maxHeight = Math.max(420, Math.round(desktopBounds.height - desktopBounds.y - margin));
  const width = Math.min(requestedWidth, maxWidth);
  const height = Math.min(requestedHeight, maxHeight);
  const minX = Math.round(desktopBounds.x + margin);
  const minY = Math.round(Math.max(desktopBounds.y + margin, 30));
  const maxX = Math.round(desktopBounds.x + desktopBounds.width - width - margin);
  const maxY = Math.round(desktopBounds.y + desktopBounds.height - height - margin);

  return {
    x: clamp(Math.round(bounds.x), minX, Math.max(minX, maxX)),
    y: clamp(Math.round(bounds.y), minY, Math.max(minY, maxY)),
    width,
    height,
  };
}

async function getActiveChromeWindowBounds() {
  if (process.platform !== 'darwin') {
    return null;
  }

  const scriptLines = [
    'tell application "Google Chrome"',
    '  if (count of windows) is 0 then return ""',
    '  set b to bounds of front window',
    '  return (item 1 of b as string) & "," & (item 2 of b as string) & "," & (item 3 of b as string) & "," & (item 4 of b as string)',
    'end tell',
  ];
  const args = scriptLines.flatMap((line) => ['-e', line]);
  const result = await runProcessExit('osascript', args);
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to inspect Chrome window bounds: ${message}`);
  }

  const values = result.stdout.trim().split(',').map((value) => Number(value.trim()));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const [left, top, right, bottom] = values;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

async function setActiveChromeWindowBounds(bounds) {
  if (process.platform !== 'darwin') {
    return;
  }
  const x = Math.round(bounds.x);
  const y = Math.round(bounds.y);
  const right = Math.round(bounds.x + bounds.width);
  const bottom = Math.round(bounds.y + bounds.height);
  const scriptLines = [
    'tell application "Google Chrome"',
    '  if (count of windows) is 0 then error "No Chrome windows"',
    `  set bounds of front window to {${x}, ${y}, ${right}, ${bottom}}`,
    'end tell',
  ];
  const result = await runProcessExit('osascript', scriptLines.flatMap((line) => ['-e', line]));
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to set Chrome window bounds: ${message}`);
  }
}

async function activateSafariTabByUrl(targetUrl) {
  if (process.platform !== 'darwin') {
    return;
  }

  const escapedTargetUrl = escapeAppleScriptString(targetUrl);
  const scriptLines = [
    'set matched to false',
    `set targetUrl to "${escapedTargetUrl}"`,
    'tell application "Safari"',
    '  activate',
    '  repeat with currentWindow in windows',
    '    repeat with tabIndex from 1 to count of tabs of currentWindow',
    '      set currentTab to tab tabIndex of currentWindow',
    '      if (URL of currentTab starts with targetUrl) then',
    '        set current tab of currentWindow to currentTab',
    '        set index of currentWindow to 1',
    '        set matched to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if matched then exit repeat',
    '  end repeat',
    'end tell',
    'if matched is false then error "Safari form tab not found"',
  ];

  const result = await runProcessExit('osascript', scriptLines.flatMap((line) => ['-e', line]));
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to activate Safari form tab: ${message}`);
  }
}

async function openSafariWindowByUrl(targetUrl, bounds = null) {
  if (process.platform !== 'darwin') {
    return;
  }

  const escapedTargetUrl = escapeAppleScriptString(targetUrl);
  const windowBounds = await resolveBrowserWindowBounds(bounds);
  const scriptLines = [
    `set targetUrl to "${escapedTargetUrl}"`,
    'tell application "Safari"',
    '  activate',
    '  make new document with properties {URL:targetUrl}',
    '  set index of front window to 1',
    'end tell',
  ];
  if (windowBounds) {
    scriptLines.splice(
      scriptLines.length - 1,
      0,
      `tell application "Safari" to set bounds of front window to {${windowBounds.x}, ${windowBounds.y}, ${windowBounds.x + windowBounds.width}, ${windowBounds.y + windowBounds.height}}`,
    );
  }
  scriptLines.push('delay 0.5');
  scriptLines.push('tell application "Safari" to return URL of current tab of front window');

  const result = await runProcessExit('osascript', scriptLines.flatMap((line) => ['-e', line]));
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to open Safari form tab: ${message}`);
  }
  const activeUrl = result.stdout.trim();
  if (!activeUrl.startsWith(targetUrl)) {
    throw new Error(`Safari opened the wrong active URL. expected=${targetUrl} actual=${activeUrl || '""'}`);
  }
}

async function hasSafariTabWithUrl(targetUrl) {
  if (process.platform !== 'darwin') {
    return true;
  }

  const escapedTargetUrl = escapeAppleScriptString(targetUrl);
  const scriptLines = [
    'set matched to false',
    `set targetUrl to "${escapedTargetUrl}"`,
    'tell application "Safari"',
    '  repeat with currentWindow in windows',
    '    repeat with currentTab in tabs of currentWindow',
    '      if (URL of currentTab starts with targetUrl) then',
    '        set matched to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if matched then exit repeat',
    '  end repeat',
    'end tell',
    'if matched then return "FOUND"',
    'return "MISSING"',
  ];

  const result = await runProcessExit('osascript', scriptLines.flatMap((line) => ['-e', line]));
  if (result.code !== 0) {
    return false;
  }
  return result.stdout.trim() === 'FOUND';
}

async function waitForSafariTabByUrl(targetUrl, timeoutMs = 15000) {
  await waitForCondition('Safari form tab', timeoutMs, async () => (
    await hasSafariTabWithUrl(targetUrl) ? true : null
  ));
}

async function getActiveSafariTabUrl() {
  if (process.platform !== 'darwin') {
    return null;
  }

  const scriptLines = [
    'tell application "Safari"',
    '  if (count of windows) is 0 then return ""',
    '  return URL of current tab of front window',
    'end tell',
  ];
  const result = await runProcessExit('osascript', scriptLines.flatMap((line) => ['-e', line]));
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to inspect active Safari tab: ${message}`);
  }
  return result.stdout.trim();
}

async function waitForActiveSafariTabByUrl(targetUrl, timeoutMs = 15000) {
  await waitForCondition('Active Safari form tab', timeoutMs, async () => {
    const activeUrl = await getActiveSafariTabUrl();
    if (activeUrl && activeUrl.startsWith(targetUrl)) {
      return activeUrl;
    }
    return null;
  });
}

async function getActiveSafariWindowBounds() {
  if (process.platform !== 'darwin') {
    return null;
  }

  const scriptLines = [
    'tell application "Safari"',
    '  if (count of windows) is 0 then return ""',
    '  set b to bounds of front window',
    '  return (item 1 of b as string) & "," & (item 2 of b as string) & "," & (item 3 of b as string) & "," & (item 4 of b as string)',
    'end tell',
  ];
  const result = await runProcessExit('osascript', scriptLines.flatMap((line) => ['-e', line]));
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to inspect Safari window bounds: ${message}`);
  }
  const values = result.stdout.trim().split(',').map((value) => Number(value.trim()));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const [left, top, right, bottom] = values;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

async function setActiveSafariWindowBounds(bounds) {
  if (process.platform !== 'darwin') {
    return;
  }
  const x = Math.round(bounds.x);
  const y = Math.round(bounds.y);
  const right = Math.round(bounds.x + bounds.width);
  const bottom = Math.round(bounds.y + bounds.height);
  const scriptLines = [
    'tell application "Safari"',
    '  if (count of windows) is 0 then error "No Safari windows"',
    `  set bounds of front window to {${x}, ${y}, ${right}, ${bottom}}`,
    'end tell',
  ];
  const result = await runProcessExit('osascript', scriptLines.flatMap((line) => ['-e', line]));
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to set Safari window bounds: ${message}`);
  }
}

async function closeSafariTabByUrl(targetUrl) {
  if (process.platform !== 'darwin') {
    return;
  }

  const escapedTargetUrl = escapeAppleScriptString(targetUrl);
  const scriptLines = [
    'set closedTab to false',
    `set targetUrl to "${escapedTargetUrl}"`,
    'tell application "Safari"',
    '  repeat with currentWindow in windows',
    '    repeat with currentTab in tabs of currentWindow',
    '      if (URL of currentTab starts with targetUrl) then',
    '        close currentTab',
    '        set closedTab to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if closedTab then exit repeat',
    '  end repeat',
    'end tell',
  ];

  const result = await runProcessExit('osascript', scriptLines.flatMap((line) => ['-e', line]));
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to close Safari form tab: ${message}`);
  }
}

async function killProcessesContainingArg(fragment) {
  if (process.platform === 'win32') {
    return;
  }

  const result = await runProcessExit('ps', ['-ax', '-o', 'pid=,args=']);
  if (result.code !== 0) {
    throw new Error(`Failed to inspect running processes: ${result.stderr.trim()}`);
  }

  const pids = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        args: match[2],
      };
    })
    .filter(Boolean)
    .filter((entry) => entry.args.includes(fragment))
    .map((entry) => String(entry.pid));

  if (pids.length === 0) {
    return;
  }

  const killResult = await runProcessExit('kill', ['-9', ...pids]);
  if (killResult.code !== 0) {
    throw new Error(`Failed to kill processes matching "${fragment}": ${killResult.stderr.trim()}`);
  }
}

async function stopExistingLocalApiIfNeeded(options) {
  const { python: pythonHealthy, desktop: desktopHealthy } = await areLocalApiProcessesHealthy();

  if (!pythonHealthy && !desktopHealthy) {
    return;
  }

  if (options.reuseLocalApi) {
    apiWasAlreadyRunning = true;
    console.log('[LocalAPI] Reusing existing local API processes');
    return;
  }

  console.log('[LocalAPI] Restarting existing local API processes for a clean test run');

  if (process.platform === 'win32') {
    throw new Error('Existing local API detected. Windows form tests currently require stopping the existing local API manually or using --reuse-local-api.');
  }

  await stopManagedLocalApi();
}

async function ensureLocalApi(options) {
  if (options.apiMode === 'server') {
    console.log('[API] Using hosted server path; skipping local API startup');
    apiWasAlreadyRunning = false;
    localApiShutdownRequested = false;
    return;
  }

  if (!isLoopbackHost(LOCAL_API_HOST)) {
    apiWasAlreadyRunning = true;
    localApiShutdownRequested = false;
    console.log(`[LocalAPI] Using external local API host ${LOCAL_API_HOST}`);
    await waitForCondition('External local API readiness', LOCAL_API_TIMEOUT_MS, async () => {
      const { python, desktop } = await areLocalApiProcessesHealthy();
      return python && desktop ? true : null;
    });
    return;
  }

  await stopExistingLocalApiIfNeeded(options);
  localApiShutdownRequested = false;

  const { python: pythonHealthy, desktop: desktopHealthy } = await areLocalApiProcessesHealthy();

  if (pythonHealthy && desktopHealthy) {
    apiWasAlreadyRunning = true;
    console.log('[LocalAPI] Reusing existing local API processes');
    return;
  }

  console.log('[LocalAPI] Starting pnpm run dev:api');
  const overlayEnv = getFormTestsOverlayEnv(options);
  apiProcess = spawnPnpm(['run', 'dev:api'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...overlayEnv,
      FORM_TESTS_MODE: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  apiProcess.stdout.on('data', (data) => captureChildLogs('LocalAPI', masterLogStream, data, false));
  apiProcess.stderr.on('data', (data) => captureChildLogs('LocalAPI', masterLogStream, data, true));
  apiProcess.once('error', (error) => {
    console.error('[LocalAPI] Failed to start:', error);
  });

  await waitForCondition('Local API readiness', LOCAL_API_TIMEOUT_MS, async () => {
    const python = await isHttpHealthy(`http://127.0.0.1:${LOCAL_PYTHON_API_PORT}/healthcheck`);
    const desktop = await isHttpHealthy(`http://127.0.0.1:${LOCAL_DESKTOP_API_PORT}/healthcheck`);
    return python && desktop ? true : null;
  });
}

function getFormTestsOverlayEnv(options = {}) {
  const guiInspect = options.guiInspect === true;
  const overlayEnv = {
    INTERPRETER_OVERLAY_AGENT_MODE:
      process.env.INTERPRETER_OVERLAY_AGENT_MODE?.trim().toLowerCase() === 'vision'
        ? 'vision'
        : 'ax',
    INTERPRETER_OVERLAY_MODEL:
      process.env.FORM_TESTS_INTERPRETER_OVERLAY_MODEL?.trim()
      || DEFAULT_FORM_TESTS_INTERPRETER_OVERLAY_MODEL,
    INTERPRETER_OVERLAY_LLM_BASE_URL:
      process.env.FORM_TESTS_INTERPRETER_OVERLAY_LLM_BASE_URL?.trim()
      || DEFAULT_FORM_TESTS_INTERPRETER_OVERLAY_LLM_BASE_URL,
    INTERPRETER_OVERLAY_DISABLE_VOICE_TIMER: 'true',
    ...(guiInspect ? {
      INTERPRETER_OVERLAY_ACTION_DEBUG_DIR: path.join(OUTPUT_DIR, 'automation-debug'),
    } : {}),
    FORM_TESTS_INCLUDE_ALL_AX_WINDOWS: 'true',
    FORM_TESTS_LIVE_TRANSCRIPT_PATH: path.join(OUTPUT_DIR, 'conversation-history.live.txt'),
    FORM_TESTS_LIVE_TRANSCRIPT_JSON_PATH: path.join(OUTPUT_DIR, 'conversation-history.live.json'),
    FORM_TESTS_LIVE_TRANSCRIPT_HTML_PATH: path.join(OUTPUT_DIR, 'conversation-history.live.html'),
  };

  if (options.apiMode === 'local' && !isLoopbackHost(LOCAL_API_HOST)) {
    overlayEnv.INTERPRETER_HOSTED_API_BASE_URL = `http://${LOCAL_API_HOST}:${LOCAL_PYTHON_API_PORT}`;
    overlayEnv.INTERPRETER_OVERLAY_SERVER_URL = `http://${LOCAL_API_HOST}:${LOCAL_DESKTOP_API_PORT}/v0/workstation/interpreter-overlay`;
  }

  const passthroughKeys = [
    'INTERPRETER_OVERLAY_ENABLE_COORDINATE_SCROLL',
    'INTERPRETER_OVERLAY_DISABLE_COORDINATE_SCROLL',
    'INTERPRETER_OVERLAY_ENABLE_VERIFIED_POINT',
    'INTERPRETER_OVERLAY_DISABLE_VERIFIED_POINT',
  ];

  passthroughKeys.forEach((key) => {
    if (typeof process.env[key] === 'string' && process.env[key].length > 0) {
      overlayEnv[key] = process.env[key];
    }
  });

  return overlayEnv;
}

async function startMainApp(options) {
  appDebugPort = await findAvailablePort(APP_DEBUG_PORT_START, APP_DEBUG_PORT_END);
  appDebugToken = crypto.randomUUID();
  const electronBinary = getElectronBinary();
  let startupExit = null;
  appProcessExit = null;
  const overlayEnv = getFormTestsOverlayEnv(options);
  const appEnv = {
    ...process.env,
    ...overlayEnv,
    NODE_ENV: 'test',
    FORM_TESTS_MODE: 'true',
    FORM_TESTS_INTERACTION_MODE: options.mode,
    FORM_TESTS_DEBUG_PORT: String(appDebugPort),
    INTERPRETER_OVERLAY_DEBUG_TOKEN: appDebugToken,
    INTERPRETER_OVERLAY_BENCHMARK_MODE: options.mode === 'debug' ? 'true' : 'false',
    LOG_FILE: appLogPath,
  };

  if (options.apiMode === 'local') {
    appEnv.USE_LOCAL_API = 'true';
  } else {
    delete appEnv.USE_LOCAL_API;
  }

  console.log(`[MainApp] Starting hidden benchmark app on debug port ${appDebugPort}`);
  appProcess = spawn(electronBinary, ['.'], {
    cwd: REPO_ROOT,
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  appProcess.stdout.on('data', (data) => captureChildLogs('MainApp', appLogStream, data, false));
  appProcess.stderr.on('data', (data) => captureChildLogs('MainApp', appLogStream, data, true));
  appProcess.once('error', (error) => {
    console.error('[MainApp] Failed to start:', error);
  });
  appProcess.once('exit', (code, signal) => {
    startupExit = { code, signal };
    appProcessExit = { code, signal };
    console.log(`[MainApp] Exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
  });

  await waitForCondition('Main app debug API', APP_START_TIMEOUT_MS, async () => {
    if (startupExit) {
      const details = startupExit.signal
        ? `signal ${startupExit.signal}`
        : `code ${startupExit.code ?? 'null'}`;
      const inferredReason = startupExit.code === 0 && startupExit.signal === null
        ? ' Another app instance may still be holding the single-instance lock.'
        : '';
      throw new Error(`Main app exited during startup with ${details}.${inferredReason}`);
    }

    const payload = await isHttpHealthy(`http://127.0.0.1:${appDebugPort}/health`, (body) => JSON.parse(body));
    if (!payload) {
      return null;
    }

    return payload.status === 'ok' ? payload : null;
  });

  await sendDebugCommand('setOverlaySettings', {
    enabled: true,
    menuBarEnabled: false,
  });

  await waitForCondition('Interpreter overlay runtime', APP_START_TIMEOUT_MS, async () => {
    if (startupExit) {
      const details = startupExit.signal
        ? `signal ${startupExit.signal}`
        : `code ${startupExit.code ?? 'null'}`;
      throw new Error(`Main app exited while waiting for runtime with ${details}.`);
    }

    const payload = await isHttpHealthy(`http://127.0.0.1:${appDebugPort}/health`, (body) => JSON.parse(body));
    if (!payload || !payload.runtimeActive) {
      return null;
    }

    return payload;
  });

  await waitForCondition('Interpreter overlay hotkey registration', APP_START_TIMEOUT_MS, async () => {
    if (startupExit) {
      const details = startupExit.signal
        ? `signal ${startupExit.signal}`
        : `code ${startupExit.code ?? 'null'}`;
      throw new Error(`Main app exited while waiting for hotkey registration with ${details}.`);
    }

    const trayState = await getTrayState();
    if (!trayState?.enabled || typeof trayState.accelerator !== 'string' || trayState.accelerator.length === 0) {
      return null;
    }

    return trayState;
  });
}

function sendDebugCommand(command, params = {}) {
  const attemptCommand = () => {
    if (appProcessExit) {
      return Promise.reject(new Error(`Main app exited with ${formatAppExit(appProcessExit)}`));
    }
    if (!appDebugToken) {
      return Promise.reject(new Error('Missing app debug token'));
    }

    const body = JSON.stringify({ command, params });
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port: appDebugPort,
          path: '/command',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-interpreter-debug-token': appDebugToken,
          },
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk) => {
            responseBody += chunk.toString();
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Debug command failed: ${res.statusCode} ${responseBody}`));
              return;
            }

            try {
              resolve(JSON.parse(responseBody));
            } catch (error) {
              reject(error);
            }
          });
        },
      );

      request.on('error', (error) => {
        if (appProcessExit) {
          reject(new Error(`Main app exited with ${formatAppExit(appProcessExit)}`));
          return;
        }
        reject(error);
      });
      request.setTimeout(AGENT_TIMEOUT_MS + 5000, () => {
        request.destroy(new Error('Debug command timed out'));
      });
      request.write(body);
      request.end();
    });
  };

  const isRetriableDebugCommandError = (error) => {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const code = typeof error.code === 'string' ? error.code : '';
    return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE';
  };

  return (async () => {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await attemptCommand();
      } catch (error) {
        if (
          attempt >= maxAttempts ||
          appProcessExit ||
          !isRetriableDebugCommandError(error)
        ) {
          throw error;
        }
        await wait(100 * attempt);
      }
    }

    throw new Error('Unreachable debug command retry state');
  })();
}

function assertFormSurfaceSession() {
  if (!formSurfaceSession) {
    throw new Error('Form surface is not running');
  }

  return formSurfaceSession;
}

async function focusFormSurface() {
  const session = assertFormSurfaceSession();
  await session.focus();
  await wait(120);
}

async function getFormSurfaceWindowBounds() {
  const session = assertFormSurfaceSession();
  if (typeof session.getWindowBounds !== 'function') {
    return null;
  }

  return session.getWindowBounds();
}

async function isFormSubmitted() {
  if (!formSurfaceSession) {
    return false;
  }

  if (typeof formSurfaceSession.isSubmittedAsync === 'function') {
    return formSurfaceSession.isSubmittedAsync();
  }

  if (typeof formSurfaceSession.isSubmitted === 'function') {
    return Boolean(formSurfaceSession.isSubmitted());
  }

  return false;
}

async function getOverlayState() {
  const payload = await sendDebugCommand('getOverlayState');
  return payload.overlayState;
}

async function getDebugStatus() {
  const payload = await sendDebugCommand('getDebugStatus');
  return payload.debugStatus;
}

async function getTrayState() {
  const payload = await sendDebugCommand('getTrayState');
  return payload.trayState;
}

async function getAgentDebugContext() {
  const payload = await sendDebugCommand('getAgentDebugContext');
  return payload.agentDebugContext;
}

async function getWorkspaceAgentLaunchDiagnostics(params = {}) {
  const payload = await sendDebugCommand('getWorkspaceAgentLaunchDiagnostics', params);
  return payload.diagnostics;
}

async function detachOverlaySession(agentId) {
  const params = typeof agentId === 'string' && agentId.trim()
    ? { agentId: agentId.trim() }
    : {};
  await sendDebugCommand('detachOverlaySession', params);
}

function summarizeOverlayWindows(debugStatus) {
  const windows = Array.isArray(debugStatus?.overlayWindows) ? debugStatus.overlayWindows : [];
  if (windows.length === 0) {
    return 'none';
  }

  return windows
    .map((window) => (
      `id=${window.id} visible=${window.visible} focused=${window.focused} bounds=${JSON.stringify(window.bounds)} url=${window.url || 'n/a'}`
    ))
    .join(' | ');
}

function boundsEqual(left, right) {
  return Boolean(
    left
    && right
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
  );
}

function validateOverlayWindows(debugStatus, options = {}) {
  const windows = Array.isArray(debugStatus?.overlayWindows) ? debugStatus.overlayWindows : [];
  const visibleWindowCount = windows.filter((window) => window.visible).length;
  const requireVisible = options.requireVisible !== false;
  const expectedBounds = options.expectedBounds ?? null;
  const expectedVisualHealthRecoveryCount = options.expectedVisualHealthRecoveryCount;
  const allowPinnedWorldOverlay = options.allowPinnedWorldOverlay === true;
  const worldWindows = windows.filter((window) => window.title === 'Interpreter World Overlay');
  const chromeWindows = windows.filter((window) => window.title === 'Interpreter Overlay');
  const hasExpectedPinnedWorldWindows = (
    allowPinnedWorldOverlay
    && windows.length === 2
    && worldWindows.length === 1
    && chromeWindows.length === 1
  );
  const issues = [];

  if (windows.length !== 1 && !hasExpectedPinnedWorldWindows) {
    issues.push(`expected 1 overlay window, got ${windows.length}`);
  }

  if (
    requireVisible
    && visibleWindowCount !== 1
    && !(hasExpectedPinnedWorldWindows && visibleWindowCount === 2)
  ) {
    issues.push(`expected 1 visible overlay window, got ${visibleWindowCount}`);
  }

  if (expectedBounds) {
    const windowsToCheck = hasExpectedPinnedWorldWindows ? worldWindows : windows;
    for (const window of windowsToCheck) {
      if (!boundsEqual(window.bounds, expectedBounds)) {
        issues.push(
          `overlay window ${window.id} bounds changed expected=${JSON.stringify(expectedBounds)} actual=${JSON.stringify(window.bounds)}`,
        );
      }
    }
  }

  if (
    Number.isFinite(expectedVisualHealthRecoveryCount)
    && Number(debugStatus?.visualHealthRecoveryCount ?? 0) !== expectedVisualHealthRecoveryCount
  ) {
    issues.push(
      `expected visual health recovery count=${expectedVisualHealthRecoveryCount},`
        + ` got ${Number(debugStatus?.visualHealthRecoveryCount ?? 0)}`,
    );
  }

  return {
    ok: issues.length === 0,
    issues,
    windowCount: windows.length,
    visibleWindowCount,
    windows,
  };
}

function createOverlayIntegritySnapshot(debugStatus, extra = {}) {
  const validation = validateOverlayWindows(debugStatus, extra);
  return {
    ...extra,
    overlayWindowCount: validation.windowCount,
    visibleOverlayWindowCount: validation.visibleWindowCount,
    overlayWindows: validation.windows,
    lastVisualHealth: debugStatus?.lastVisualHealth ?? null,
    visualHealthRecoveryCount: debugStatus?.visualHealthRecoveryCount ?? 0,
    lastVisualHealthRecoveryAt: debugStatus?.lastVisualHealthRecoveryAt ?? null,
    presentationTimings: debugStatus?.presentationTimings ?? null,
    progressiveBlur: debugStatus?.progressiveBlur ?? null,
    issues: validation.issues,
  };
}

function overlayWindowsLookCaptureSuppressed(debugStatus) {
  const windows = Array.isArray(debugStatus?.overlayWindows) ? debugStatus.overlayWindows : [];
  return windows.some((window) => (
    window?.visible
    && window?.bounds
    && Number(window.bounds.width) <= 5
    && Number(window.bounds.height) <= 5
  ));
}

async function assertOverlayIntegrity(label, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2000;
  const deadline = Date.now() + timeoutMs;
  let lastDebugStatus = null;
  let lastValidation = null;

  while (Date.now() < deadline) {
    const debugStatus = await getDebugStatus();
    lastDebugStatus = debugStatus;
    if (debugStatus?.overlayCaptureSuppressed || overlayWindowsLookCaptureSuppressed(debugStatus)) {
      await wait(40);
      continue;
    }

    const validation = validateOverlayWindows(debugStatus, options);
    lastValidation = validation;
    if (validation.ok) {
      return debugStatus;
    }

    await wait(40);
  }

  const validation = lastValidation ?? validateOverlayWindows(lastDebugStatus, options);
  throw new Error(`${label}: ${validation.issues.join('; ')} windows=${summarizeOverlayWindows(lastDebugStatus)}`);
}

async function waitForOverlayIntegrity(label, timeoutMs, options = {}) {
  return waitForCondition(label, timeoutMs, async () => {
    const debugStatus = await getDebugStatus();
    if (debugStatus?.overlayCaptureSuppressed || overlayWindowsLookCaptureSuppressed(debugStatus)) {
      return null;
    }
    return validateOverlayWindows(debugStatus, options).ok ? debugStatus : null;
  }, 40);
}

async function waitForOverlayState(label, timeoutMs, predicate) {
  return waitForCondition(label, timeoutMs, async () => {
    const overlayState = await getOverlayState();
    return predicate(overlayState) ? overlayState : null;
  }, 40);
}

async function waitForOverlayInputReady(label, timeoutMs = RUN_START_TIMEOUT_MS) {
  return waitForOverlayState(
    label,
    timeoutMs,
    (overlayState) => overlayState.mode === 'input' && overlayState.inputReady === true,
  );
}

async function waitForOverlayPresentationOpenMetrics(label, timeoutMs = RUN_START_TIMEOUT_MS) {
  return waitForCondition(label, timeoutMs, async () => {
    const debugStatus = await getDebugStatus();
    const timings = debugStatus?.presentationTimings ?? null;
    if (!timings || timings.openRequestedAt === null || timings.reactVisibleAt === null || timings.inputReadyAt === null) {
      return null;
    }
    if (timings.blurShowCommandAt !== null && timings.blurShownAt === null) {
      return null;
    }
    if (
      typeof timings.reactVisibleAt === 'number'
      && typeof timings.blurShownAt === 'number'
      && timings.blurShownAt < timings.reactVisibleAt
    ) {
      throw new Error(
        `${label}: progressive blur appeared before React overlay became visible.`
          + ` timings=${formatOverlayPresentationTimings(debugStatus)}`,
      );
    }
    if (
      typeof timings.durationsMs?.blurShowCommandToShown === 'number'
      && (
        timings.durationsMs.blurShowCommandToShown < OVERLAY_PRESENTATION_TRANSITION_MIN_MS
        || timings.durationsMs.blurShowCommandToShown > OVERLAY_PRESENTATION_TRANSITION_MAX_MS
      )
    ) {
      throw new Error(
        `${label}: progressive blur show transition was outside the expected motion window.`
          + ` timings=${formatOverlayPresentationTimings(debugStatus)}`,
      );
    }
    return debugStatus;
  }, 40);
}

async function waitForOverlayPresentationClosedMetrics(label, timeoutMs = RUN_START_TIMEOUT_MS) {
  return waitForCondition(label, timeoutMs, async () => {
    const debugStatus = await getDebugStatus();
    const timings = debugStatus?.presentationTimings ?? null;
    if (!timings || timings.closeRequestedAt === null || timings.reactHiddenAt === null) {
      return null;
    }
    if (timings.blurHideCommandAt !== null && timings.blurHiddenAt === null) {
      return null;
    }
    if (
      typeof timings.reactHiddenAt === 'number'
      && typeof timings.blurHiddenAt === 'number'
      && Math.abs(timings.blurHiddenAt - timings.reactHiddenAt) > OVERLAY_PRESENTATION_SYNC_TOLERANCE_MS
    ) {
      throw new Error(
        `${label}: progressive blur and React overlay did not finish closing together.`
          + ` timings=${formatOverlayPresentationTimings(debugStatus)}`,
      );
    }
    if (
      typeof timings.durationsMs?.blurHideCommandToHidden === 'number'
      && (
        timings.durationsMs.blurHideCommandToHidden < OVERLAY_PRESENTATION_TRANSITION_MIN_MS
        || timings.durationsMs.blurHideCommandToHidden > OVERLAY_PRESENTATION_TRANSITION_MAX_MS
      )
    ) {
      throw new Error(
        `${label}: progressive blur hide transition was outside the expected motion window.`
          + ` timings=${formatOverlayPresentationTimings(debugStatus)}`,
      );
    }
    return debugStatus;
  }, 40);
}

async function waitForOverlayInputDismissedAfterSubmit(label, timeoutMs = RUN_START_TIMEOUT_MS) {
  return waitForCondition(label, timeoutMs, async () => {
    const [debugStatus, overlayState] = await Promise.all([
      getDebugStatus(),
      getOverlayState(),
    ]);
    const timings = debugStatus?.presentationTimings ?? null;
    const visualHealth = debugStatus?.lastVisualHealth ?? null;
    if (!timings || timings.closeRequestedAt === null || timings.reactHiddenAt === null) {
      return null;
    }
    if (overlayState.mode === 'input') {
      return null;
    }
    if (visualHealth?.renderedMode === 'input') {
      return null;
    }
    if (overlayVisualHealthHasVisibleInputPrompt(visualHealth)) {
      return null;
    }
    return { debugStatus, overlayState };
  }, 40);
}

function overlayVisualHealthHasVisibleInputPrompt(health) {
  return Boolean(health?.hasVisibleInputControl);
}

function overlayExpectedBackdropVisible(debugStatus, overlayState) {
  if (overlayState.mode === 'idle') {
    return false;
  }

  const visualHealth = debugStatus?.lastVisualHealth ?? null;
  if (overlayVisualHealthHasVisibleInputPrompt(visualHealth)) {
    return true;
  }

  const allowBlankGraceDuringInput = overlayState.mode === 'input'
    || visualHealth?.renderedMode === 'input';
  if (!allowBlankGraceDuringInput) {
    return false;
  }

  if (
    !visualHealth
    || visualHealth.renderedMode === 'idle'
    || typeof debugStatus?.presentationTimings?.reactVisibleAt !== 'number'
    || typeof debugStatus?.lastVisualBlankSince !== 'number'
  ) {
    return false;
  }

  return Date.now() - debugStatus.lastVisualBlankSince < OVERLAY_VISUAL_BLANK_TOLERANCE_MS;
}

function overlayBackdropHideInFlight(debugStatus) {
  const timings = debugStatus?.presentationTimings ?? null;
  if (!timings || typeof timings.closeRequestedAt !== 'number' || typeof timings.blurHiddenAt === 'number') {
    return false;
  }

  return Date.now() - timings.closeRequestedAt <= OVERLAY_PRESENTATION_TRANSITION_MAX_MS;
}

function assertOverlayBackdropState(label, debugStatus, overlayState) {
  const progressiveBlur = debugStatus?.progressiveBlur ?? null;
  if (!progressiveBlur?.supported) {
    return;
  }

  const visualHealth = debugStatus?.lastVisualHealth ?? null;
  const expectedVisible = overlayExpectedBackdropVisible(debugStatus, overlayState);

  if (progressiveBlur.visible === expectedVisible) {
    return;
  }

  if (!expectedVisible && progressiveBlur.visible && overlayBackdropHideInFlight(debugStatus)) {
    return;
  }

  throw new Error(
    `${label}: overlay mode=${overlayState.mode} had wrong progressive blur visibility=${progressiveBlur.visible}.`
      + ` expectedVisible=${expectedVisible}`
      + ` hasVisibleInputPrompt=${overlayVisualHealthHasVisibleInputPrompt(visualHealth)}`
      + ` renderedMode=${visualHealth?.renderedMode ?? 'unknown'}`
      + ` handoffPending=${debugStatus?.progressiveBlurHandoffPending ?? 'unknown'}`
      + ` phase=${debugStatus?.presentationTimings?.phase ?? 'unknown'}`
      + ` timings=${formatOverlayPresentationTimings(debugStatus)}`,
  );
}

async function waitForOverlayBackdropSync(label, timeoutMs = RUN_START_TIMEOUT_MS) {
  return waitForCondition(label, timeoutMs, async () => {
    const [debugStatus, overlayState] = await Promise.all([
      getDebugStatus(),
      getOverlayState(),
    ]);
    const progressiveBlur = debugStatus?.progressiveBlur ?? null;
    if (debugStatus?.overlayCaptureSuppressed) {
      return null;
    }

    if (!progressiveBlur?.supported) {
      if (overlayState.mode === 'working' || overlayState.mode === 'review') {
        return { debugStatus, overlayState, healthy: true };
      }
      return null;
    }

    if (overlayState.mode !== 'working' && overlayState.mode !== 'review') {
      return null;
    }

    const visualHealth = debugStatus?.lastVisualHealth ?? null;
    const expectedVisible = overlayExpectedBackdropVisible(debugStatus, overlayState);

    if (progressiveBlur.visible !== expectedVisible) {
      if (!expectedVisible && progressiveBlur.visible && overlayBackdropHideInFlight(debugStatus)) {
        return null;
      }
      if (progressiveBlur.visible) {
        throw new Error(
          `${label}: progressive blur was visible without matching React overlay UI.`
            + ` renderedMode=${visualHealth?.renderedMode ?? 'unknown'}`
            + ` hasVisibleInputPrompt=${overlayVisualHealthHasVisibleInputPrompt(visualHealth)}`
            + ` timings=${formatOverlayPresentationTimings(debugStatus)}`,
        );
      }
      return null;
    }

    return { debugStatus, overlayState, hasVisibleInputPrompt: expectedVisible };
  }, 40);
}

async function waitForOverlayBackdropCleared(label, timeoutMs = RUN_START_TIMEOUT_MS) {
  return waitForCondition(label, timeoutMs, async () => {
    const [debugStatus, overlayState] = await Promise.all([
      getDebugStatus(),
      getOverlayState(),
    ]);
    const progressiveBlur = debugStatus?.progressiveBlur ?? null;
    if (!progressiveBlur?.supported) {
      return { debugStatus, overlayState };
    }

    if (overlayState.mode !== 'idle') {
      return null;
    }

    if (overlayVisualHealthHasVisibleInputPrompt(debugStatus?.lastVisualHealth ?? null)) {
      return null;
    }

    if (progressiveBlur.visible) {
      return null;
    }

    return { debugStatus, overlayState };
  }, 40);
}

function formatOverlayPresentationTimings(debugStatus) {
  const timings = debugStatus?.presentationTimings ?? null;
  if (!timings) {
    return 'presentation=missing';
  }

  const details = [
    `cycle=${timings.cycleId}`,
    `source=${timings.source ?? 'none'}`,
    `phase=${timings.phase}`,
  ];

  if (timings.closeReason) {
    details.push(`closeReason=${timings.closeReason}`);
  }

  for (const [key, value] of Object.entries(timings.durationsMs ?? {})) {
    if (typeof value === 'number') {
      details.push(`${key}=${value}`);
    }
  }

  return details.join(' ');
}

function countPresentPresentationTimingFields(timings) {
  if (!timings) {
    return -1;
  }

  let score = 0;
  for (const [key, value] of Object.entries(timings)) {
    if (key === 'durationsMs') {
      continue;
    }
    if (value !== null && value !== undefined) {
      score += 1;
    }
  }

  for (const value of Object.values(timings.durationsMs ?? {})) {
    if (typeof value === 'number') {
      score += 1;
    }
  }

  return score;
}

function buildPresentationTimingCycleRow(entry) {
  const timings = entry.presentationTimings;
  return {
    checkpointLabel: entry.label,
    cycleId: timings.cycleId,
    source: timings.source,
    phase: timings.phase,
    closeReason: timings.closeReason,
    openRequestedAt: timings.openRequestedAt,
    reactVisibleAt: timings.reactVisibleAt,
    inputReadyAt: timings.inputReadyAt,
    closeRequestedAt: timings.closeRequestedAt,
    reactHiddenAt: timings.reactHiddenAt,
    blurShowCommandAt: timings.blurShowCommandAt,
    blurShownAt: timings.blurShownAt,
    blurHideCommandAt: timings.blurHideCommandAt,
    blurHiddenAt: timings.blurHiddenAt,
    durationsMs: {
      ...timings.durationsMs,
    },
  };
}

function summarizeNumericSeries(values) {
  const numericValues = values.filter((value) => typeof value === 'number');
  if (numericValues.length === 0) {
    return null;
  }

  numericValues.sort((left, right) => left - right);
  const total = numericValues.reduce((sum, value) => sum + value, 0);
  return {
    count: numericValues.length,
    min: numericValues[0],
    max: numericValues[numericValues.length - 1],
    avg: Math.round(total / numericValues.length),
  };
}

function buildOverlayPresentationReport(checkpoints) {
  const bestCycleSnapshots = new Map();
  for (const entry of checkpoints) {
    const timings = entry.presentationTimings;
    if (!timings || typeof timings.cycleId !== 'number') {
      continue;
    }

    const previous = bestCycleSnapshots.get(timings.cycleId);
    if (!previous || countPresentPresentationTimingFields(timings) > countPresentPresentationTimingFields(previous.presentationTimings)) {
      bestCycleSnapshots.set(timings.cycleId, entry);
    }
  }

  const cycles = Array.from(bestCycleSnapshots.values())
    .sort((left, right) => left.presentationTimings.cycleId - right.presentationTimings.cycleId)
    .map(buildPresentationTimingCycleRow);

  const durationKeys = [
    'openToReactVisible',
    'openToInputReady',
    'openToBlurShown',
    'closeToReactHidden',
    'closeToBlurHidden',
    'blurShowCommandToShown',
    'blurHideCommandToHidden',
  ];

  const stats = Object.fromEntries(
    durationKeys.map((key) => [
      key,
      summarizeNumericSeries(cycles.map((cycle) => cycle.durationsMs?.[key] ?? null)),
    ]),
  );

  return {
    cycleCount: cycles.length,
    openCycleCount: cycles.filter((cycle) => typeof cycle.durationsMs?.openToReactVisible === 'number').length,
    closeCycleCount: cycles.filter((cycle) => typeof cycle.durationsMs?.closeToReactHidden === 'number').length,
    cycles,
    stats,
  };
}

function formatOverlayPresentationStats(report) {
  if (!report || !report.stats) {
    return 'presentation-summary=missing';
  }

  const details = [
    `cycles=${report.cycleCount}`,
    `openCycles=${report.openCycleCount}`,
    `closeCycles=${report.closeCycleCount}`,
  ];

  for (const [key, value] of Object.entries(report.stats)) {
    if (!value) {
      continue;
    }
    details.push(`${key}.avg=${value.avg}`);
    details.push(`${key}.min=${value.min}`);
    details.push(`${key}.max=${value.max}`);
  }

  return details.join(' ');
}

function isTerminalRunStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'start_failed';
}

function formatRunState(runState) {
  const details = [
    `id=${runState.id}`,
    `status=${runState.status}`,
  ];

  if (runState.reason) {
    details.push(`reason=${runState.reason}`);
  }
  if (runState.startedAt !== null) {
    details.push(`startedAt=${runState.startedAt}`);
  }
  if (runState.finishedAt !== null) {
    details.push(`finishedAt=${runState.finishedAt}`);
  }

  return details.join(' ');
}

async function pressCtrlSpace() {
  await keyboard.pressKey(Key.LeftControl);
  await keyboard.pressKey(Key.Space);
  await keyboard.releaseKey(Key.Space);
  await keyboard.releaseKey(Key.LeftControl);
}

async function pressEnter() {
  await keyboard.pressKey(Key.Enter);
  await keyboard.releaseKey(Key.Enter);
}

async function pressTab() {
  await keyboard.pressKey(Key.Tab);
  await keyboard.releaseKey(Key.Tab);
}

async function pressShiftTab() {
  await keyboard.pressKey(Key.LeftShift);
  await keyboard.pressKey(Key.Tab);
  await keyboard.releaseKey(Key.Tab);
  await keyboard.releaseKey(Key.LeftShift);
}

async function pressArrowDown() {
  await keyboard.pressKey(Key.Down);
  await keyboard.releaseKey(Key.Down);
}

async function clickOverlayBounds(bounds) {
  if (!bounds) {
    throw new Error('Missing overlay bounds for real UI click.');
  }

  await performMouseClick({
    x: Math.round(bounds.x + (bounds.width / 2)),
    y: Math.round(bounds.y + (bounds.height / 2)),
  });
  await wait(OVERLAY_PROFILE_SWITCH_SETTLE_MS);
}

async function pasteText(text, options = {}) {
  const previousClipboard = await getHarnessClipboardText();
  await setHarnessClipboardText(String(text));
  if (typeof options.afterClipboardReady === 'function') {
    await options.afterClipboardReady();
  }
  if (typeof options.pasteReadyClipboard === 'function') {
    await options.pasteReadyClipboard();
  } else {
    const modifierKey = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
    await keyboard.pressKey(modifierKey);
    await keyboard.pressKey(Key.V);
    await keyboard.releaseKey(Key.V);
    await keyboard.releaseKey(modifierKey);
  }
  await wait(250);
  await setHarnessClipboardText(previousClipboard);
}

function runPowerShellClipboardCommand(command, input = '') {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], {
    input,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `PowerShell clipboard command failed with code ${result.status}`);
  }
  return result.stdout ?? '';
}

async function getHarnessClipboardText() {
  if (process.platform !== 'win32') {
    return clipboard.getContent();
  }

  return runPowerShellClipboardCommand(
    'try { Get-Clipboard -Raw } catch { "" }',
  );
}

async function setHarnessClipboardText(text) {
  const safeText = text == null ? '' : String(text);
  if (process.platform !== 'win32') {
    await clipboard.setContent(safeText);
    return;
  }

  const result = spawnSync('clip.exe', [], {
    input: safeText,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `clip.exe failed with code ${result.status}`);
  }
}

async function typeOverlayPrompt(text) {
  const expectedText = String(text);
  const originalAutoDelayMs = keyboard.config.autoDelayMs;
  keyboard.config.autoDelayMs = 28;

  try {
    await focusOverlayEditor('Overlay editor focused before typing prompt');
    for (const character of Array.from(expectedText)) {
      if (character === '\r') {
        continue;
      }

      if (character === '\n') {
        await keyboard.pressKey(Key.LeftShift);
        await keyboard.pressKey(Key.Enter);
        await keyboard.releaseKey(Key.Enter);
        await keyboard.releaseKey(Key.LeftShift);
        await wait(18);
        continue;
      }

      await keyboard.type(character);
      await wait(18);
    }
  } finally {
    keyboard.config.autoDelayMs = originalAutoDelayMs;
  }

  await waitForCondition('Overlay prompt typed', 3000, async () => {
    const overlayState = await getOverlayState();
    if (overlayState.mode !== 'input') {
      return null;
    }
    return overlayState.transcript === expectedText ? true : null;
  }, 40);
}

async function pasteOverlayPrompt(text) {
  const expectedText = String(text);
  try {
    await waitForCondition('Overlay prompt pasted', 8000, async () => {
      const overlayState = await getOverlayState();
      if (overlayState.mode !== 'input') {
        return null;
      }
      if (overlayState.transcript === expectedText) {
        return true;
      }

      if (process.platform === 'win32') {
        await sendDebugCommand('setInputOverlayText', { text: expectedText });
        await wait(250);
        const nextOverlayState = await getOverlayState();
        return nextOverlayState.mode === 'input' && nextOverlayState.transcript === expectedText ? true : null;
      }

      if (overlayState.inputReady !== true) {
        return null;
      }

      await sendDebugCommand('focusInputOverlay');
      await wait(80);
      await focusOverlayEditor('Overlay editor focused before pasting prompt');
      await wait(80);

      const previousClipboard = await getHarnessClipboardText();
      await setHarnessClipboardText(expectedText);
      const modifierKey = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
      try {
        await keyboard.pressKey(modifierKey);
        await keyboard.pressKey(Key.A);
        await keyboard.releaseKey(Key.A);
        await keyboard.releaseKey(modifierKey);
        await wait(40);
        await keyboard.pressKey(modifierKey);
        await keyboard.pressKey(Key.V);
        await keyboard.releaseKey(Key.V);
        await keyboard.releaseKey(modifierKey);
      } finally {
        await setHarnessClipboardText(previousClipboard);
      }

      await wait(250);
      const nextOverlayState = await getOverlayState();
      return nextOverlayState.mode === 'input' && nextOverlayState.transcript === expectedText ? true : null;
    }, 40);
  } catch (error) {
    const overlayState = await getOverlayState();
    const actualText = overlayState?.transcript ?? '';
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; actualLength=${actualText.length}; expectedLength=${expectedText.length}; actualPreview=${JSON.stringify(actualText.slice(0, 160))}`,
    );
  }
}

async function focusOverlayEditor(label = 'Overlay editor focused') {
  await sendDebugCommand('focusInputOverlay');
  await wait(80);
  const editorHealth = await waitForCondition(label, 3000, async () => {
    const debugStatus = await getDebugStatus();
    const health = debugStatus?.lastVisualHealth ?? null;
    return health?.editorBounds ? health : null;
  }, 40);

  await clickOverlayBounds(editorHealth.editorBounds);
  await wait(80);
}

async function pressCtrlApproval() {
  await keyboard.pressKey(Key.LeftControl);
  await wait(140);
  await keyboard.releaseKey(Key.LeftControl);
  await wait(120);
}

async function pressAcceptAllApproval() {
  await keyboard.pressKey(Key.LeftShift);
  await wait(40);
  await keyboard.pressKey(Key.LeftControl);
  await wait(140);
  await keyboard.releaseKey(Key.LeftControl);
  await wait(40);
  await keyboard.releaseKey(Key.LeftShift);
  await wait(120);
}

async function pressEscape() {
  await sendDebugCommand('pressEscape');
  await wait(80);
}

function boundsCloseEnough(left, right, tolerancePx = 4) {
  if (!left || !right) {
    return false;
  }

  return (
    Math.abs(left.x - right.x) <= tolerancePx
    && Math.abs(left.y - right.y) <= tolerancePx
    && Math.abs(left.width - right.width) <= tolerancePx
    && Math.abs(left.height - right.height) <= tolerancePx
  );
}

function normalizePickerLabel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function selectOverlayAgentProfileThroughUi({ desiredLabel = null, desiredValue = null } = {}) {
  const triggerHealth = await waitForCondition('Overlay profile trigger ready', 3000, async () => {
    const debugStatus = await getDebugStatus();
    const health = debugStatus?.lastVisualHealth ?? null;
    return health?.profileTriggerBounds ? health : null;
  }, 40);

  if (desiredValue) {
    try {
      const desiredHealth = await waitForCondition('Overlay desired profile already applied', 1500, async () => {
        const debugStatus = await getDebugStatus();
        const health = debugStatus?.lastVisualHealth ?? null;
        if (!health?.editorBounds) {
          return null;
        }
        return health.selectedProfileId === desiredValue ? health : null;
      }, 40);
      await clickOverlayBounds(desiredHealth.editorBounds);
      return;
    } catch {
      // The settings-driven selection did not land yet; continue through the visible menu.
    }
  }

  if (desiredValue && triggerHealth.selectedProfileId === desiredValue) {
    const editorHealth = await waitForCondition('Overlay editor ready with desired profile', 3000, async () => {
      const debugStatus = await getDebugStatus();
      const health = debugStatus?.lastVisualHealth ?? null;
      if (!health?.editorBounds) {
        return null;
      }
      if (health.selectedProfileId !== desiredValue) {
        return null;
      }
      return health;
    }, 40);

    await clickOverlayBounds(editorHealth.editorBounds);
    return;
  }

  await clickOverlayBounds(triggerHealth.profileTriggerBounds);

  const targetProfile = await waitForCondition('Overlay profile options open or desired profile applied', 3000, async () => {
    const debugStatus = await getDebugStatus();
    const health = debugStatus?.lastVisualHealth ?? null;
    if (desiredValue && health?.selectedProfileId === desiredValue && health.editorBounds) {
      return {
        alreadySelected: true,
        editorBounds: health.editorBounds,
        selectedProfileId: health.selectedProfileId,
        option: {
          value: desiredValue,
          label: desiredLabel ?? desiredValue,
          bounds: health.profileTriggerBounds ?? health.editorBounds,
        },
      };
    }

    const optionBounds = Array.isArray(health?.profileOptionBounds) ? health.profileOptionBounds : [];
    const normalizedDesiredLabel = normalizePickerLabel(desiredLabel);
    const nextOption = optionBounds.find((option) => {
      if (desiredValue && option.value === desiredValue) {
        return true;
      }
      if (!desiredValue && option.value === 'overlay:form-filler') {
        return false;
      }
      if (!normalizedDesiredLabel) {
        return true;
      }
      return normalizePickerLabel(option.label).includes(normalizedDesiredLabel);
    });
    if (!nextOption) {
      return null;
    }

    return {
      alreadySelected: false,
      selectedProfileId: health?.selectedProfileId ?? null,
      option: nextOption,
    };
  }, 40);

  if (targetProfile.alreadySelected) {
    await clickOverlayBounds(targetProfile.editorBounds);
    return;
  }

  if (targetProfile.selectedProfileId === targetProfile.option.value) {
    await clickOverlayBounds(triggerHealth.profileTriggerBounds);
    const editorHealth = await waitForCondition('Overlay editor ready after profile menu close', 3000, async () => {
      const debugStatus = await getDebugStatus();
      const health = debugStatus?.lastVisualHealth ?? null;
      if (!health?.editorBounds) {
        return null;
      }
      if (health.selectedProfileId !== targetProfile.option.value) {
        return null;
      }
      return health;
    }, 40);

    await clickOverlayBounds(editorHealth.editorBounds);
    return;
  }

  await clickOverlayBounds(targetProfile.option.bounds);

  await waitForCondition('Overlay profile selection changed', 3000, async () => {
    const debugStatus = await getDebugStatus();
    const selectedProfileId = debugStatus?.lastVisualHealth?.selectedProfileId ?? null;
    return selectedProfileId === targetProfile.option.value ? true : null;
  }, 40);

  const editorHealth = await waitForCondition('Overlay editor ready after profile change', 3000, async () => {
    const debugStatus = await getDebugStatus();
    const health = debugStatus?.lastVisualHealth ?? null;
    if (!health?.editorBounds) {
      return null;
    }
    if (health.selectedProfileId !== targetProfile.option.value) {
      return null;
    }
    return health;
  }, 40);

  await clickOverlayBounds(editorHealth.editorBounds);
}

async function moveMouseAwayFromOverlayEmergencyStopHotCorner() {
  const position = await mouse.getPosition();
  if (
    position.x > EMERGENCY_ABORT_CORNER_SIZE_PX
    && position.y > EMERGENCY_ABORT_CORNER_SIZE_PX
  ) {
    return;
  }

  const formWindowBounds = await getFormSurfaceWindowBounds();
  const safePoint = formWindowBounds
    ? {
        x: Math.round(formWindowBounds.x + (formWindowBounds.width / 2)),
        y: Math.round(formWindowBounds.y + Math.min(formWindowBounds.height / 2, formWindowBounds.height - 64)),
      }
    : {
        x: EMERGENCY_ABORT_CORNER_SIZE_PX + 120,
        y: EMERGENCY_ABORT_CORNER_SIZE_PX + 120,
      };

  await mouse.setPosition(safePoint);
  await wait(80);
}

async function assertOverlayLaunchSmokeHandoff(testId, expectedScopeBounds) {
  const diagnostics = await waitForCondition(
    'Overlay workspace-agent handoff diagnostics',
    RUN_START_TIMEOUT_MS,
    async () => {
      const payload = await getWorkspaceAgentLaunchDiagnostics();
      if (!payload.lastWorkspaceAgentLaunch || !payload.agentBinding) {
        return null;
      }
      return payload;
    },
    80,
  );

  writeTaskArtifact(
    testId,
    'overlay-workspace-agent-launch.json',
    `${JSON.stringify(diagnostics, null, 2)}\n`,
  );

  const issues = [];
  const launch = diagnostics.lastWorkspaceAgentLaunch;
  const binding = diagnostics.agentBinding;
  const targetWindowState = diagnostics.targetWindowState;

  if (!launch || !binding) {
    throw new Error('Overlay launch smoke diagnostics were incomplete.');
  }

  if (launch.profileId === 'overlay:form-filler') {
    issues.push('overlay launch smoke never switched away from the legacy overlay form profile');
  }

  if (typeof launch.overlaySessionId !== 'string' || !launch.overlaySessionId.trim()) {
    issues.push(`workspace-agent launch failed to keep a live overlay session attached overlaySessionId=${JSON.stringify(launch.overlaySessionId ?? null)}`);
  }

  if (binding.agentId !== launch.agentId) {
    issues.push(`agent binding mismatch expected=${launch.agentId} actual=${binding.agentId}`);
  }

  if (binding.callerToken !== launch.callerToken) {
    issues.push('agent binding caller token did not match the launched agent');
  }

  if (binding.windowSessionKey !== launch.targetWindowSessionKey) {
    issues.push(
      `agent binding window session mismatch expected=${launch.targetWindowSessionKey} actual=${binding.windowSessionKey || 'null'}`,
    );
  }

  if (diagnostics.overlaySession && diagnostics.overlaySession.id !== launch.overlaySessionId) {
    issues.push(
      `overlay session mismatch expected=${launch.overlaySessionId} actual=${diagnostics.overlaySession.id}`,
    );
  }

  const bindingAllowedToolNames = Array.isArray(binding.allowedToolNames) ? binding.allowedToolNames : [];
  const missingOverlayTools = OVERLAY_AGENT_ALLOWED_TOOL_NAMES.filter((toolName) => !bindingAllowedToolNames.includes(toolName));
  if (missingOverlayTools.length > 0) {
    issues.push(`workspace-agent launch was missing granted overlay tools: ${missingOverlayTools.join(', ')}`);
  }

  if (!launch.hasInitialScreenshot) {
    issues.push(
      `overlay launch did not record the initial scoped screenshot hasInitialScreenshot=${launch.hasInitialScreenshot}`,
    );
  }

  if (typeof launch.initialScreenshotPath !== 'string' || launch.initialScreenshotPath.trim().length === 0) {
    issues.push(
      `overlay launch did not persist the initial scoped screenshot path=${JSON.stringify(launch.initialScreenshotPath ?? null)}`,
    );
  }

  if (!(launch.initialElementCount > 0) && !launch.hasInitialScreenshot) {
    issues.push(`overlay launch carried no initial AX elements count=${launch.initialElementCount}`);
  }

  if (expectedScopeBounds && !boundsCloseEnough(launch.scopeBoundsDIP, expectedScopeBounds)) {
    issues.push(
      `overlay launch scope bounds drifted expected=${JSON.stringify(expectedScopeBounds)} actual=${JSON.stringify(launch.scopeBoundsDIP)}`,
    );
  }

  if (!targetWindowState || !targetWindowState.exists) {
    issues.push('background workspace window did not exist after the overlay handoff');
  } else if (targetWindowState.focused) {
    issues.push('background workspace window stole focus during the overlay handoff');
  }

  if (issues.length > 0) {
    writeTaskArtifact(
      testId,
      'overlay-workspace-agent-launch-issues.txt',
      `${issues.join('\n')}\n`,
    );
    throw new Error(`Overlay launch smoke failed: ${issues.join(' | ')}`);
  }

  return diagnostics;
}

async function assertOverlayInputStayedClosedAfterSubmit(testId, options = {}) {
  const guardMs = Number.isFinite(options.guardMs) ? options.guardMs : OVERLAY_POST_SUBMIT_REOPEN_GUARD_MS;
  const expectedBounds = options.expectedBounds ?? null;
  const expectedCycleId = Number.isFinite(options.expectedCycleId) ? options.expectedCycleId : null;
  const requireVisibleWhenActive = options.requireVisibleWhenActive !== false;
  const deadline = Date.now() + guardMs;
  const checkpoints = [];
  let lastCheckpointSignature = null;
  let activeAffordanceMissingSince = null;
  let visibleInputControlSince = null;

  const pushCheckpoint = (debugStatus, overlayState) => {
    const checkpoint = {
      timestamp: Date.now(),
      overlayMode: overlayState.mode,
      inputReady: overlayState.inputReady,
      renderedMode: debugStatus?.lastVisualHealth?.renderedMode ?? null,
      pillKind: debugStatus?.lastVisualHealth?.pillKind ?? null,
      hasVisibleInputControl: overlayVisualHealthHasVisibleInputPrompt(debugStatus?.lastVisualHealth ?? null),
      presentationCycleId: debugStatus?.presentationTimings?.cycleId ?? null,
      ...createOverlayIntegritySnapshot(debugStatus, {
        expectedBounds,
        requireVisible: requireVisibleWhenActive && overlayState.mode !== 'idle',
        allowPinnedWorldOverlay: true,
      }),
    };
    const signature = JSON.stringify({
      overlayMode: checkpoint.overlayMode,
      inputReady: checkpoint.inputReady,
      renderedMode: checkpoint.renderedMode,
      pillKind: checkpoint.pillKind,
      hasVisibleInputControl: checkpoint.hasVisibleInputControl,
      presentationCycleId: checkpoint.presentationCycleId,
      issues: checkpoint.issues,
    });
    if (signature === lastCheckpointSignature && Date.now() < deadline) {
      return;
    }
    lastCheckpointSignature = signature;
    checkpoints.push(checkpoint);
  };

  try {
    while (Date.now() < deadline) {
      const [debugStatus, overlayState] = await Promise.all([
        getDebugStatus(),
        getOverlayState(),
      ]);
      const overlayWindows = Array.isArray(debugStatus?.overlayWindows) ? debugStatus.overlayWindows : [];
      const hasPinnedWorldWindow = overlayWindows.some((window) => window.title === 'Interpreter World Overlay' && window.visible);
      const expectedIntegrityBounds = hasPinnedWorldWindow
        ? (overlayState.scopeBounds ?? expectedBounds)
        : expectedBounds;

      pushCheckpoint(debugStatus, overlayState);

      if (debugStatus?.overlayCaptureSuppressed || overlayWindowsLookCaptureSuppressed(debugStatus)) {
        await wait(40);
        continue;
      }

      const validation = validateOverlayWindows(debugStatus, {
        expectedBounds: expectedIntegrityBounds,
        requireVisible: requireVisibleWhenActive && overlayState.mode !== 'idle',
        allowPinnedWorldOverlay: true,
      });
      if (!validation.ok) {
        throw new Error(
          `overlay window integrity regressed after submit: ${validation.issues.join('; ')}`
            + ` windows=${summarizeOverlayWindows(debugStatus)}`,
        );
      }

      const currentCycleId = Number(debugStatus?.presentationTimings?.cycleId ?? 0);
      if (expectedCycleId !== null && currentCycleId !== expectedCycleId) {
        throw new Error(
          `overlay presentation cycle changed after submit expected=${expectedCycleId} actual=${currentCycleId}`,
        );
      }

      if (overlayState.mode === 'input') {
        throw new Error('overlay input mode returned after submit');
      }

      const visualHealth = debugStatus?.lastVisualHealth ?? null;
      if (visualHealth?.renderedMode === 'input') {
        throw new Error('overlay renderer returned to input mode after submit');
      }

      if (overlayVisualHealthHasVisibleInputPrompt(visualHealth)) {
        visibleInputControlSince ??= Date.now();
        if (Date.now() - visibleInputControlSince >= OVERLAY_PRESENTATION_SYNC_TOLERANCE_MS) {
          throw new Error('overlay input control became visible again after submit');
        }
      } else {
        visibleInputControlSince = null;
      }

      if (
        (overlayState.mode === 'working' || overlayState.mode === 'review')
        && !visualHealth?.hasVisibleAffordance
      ) {
        activeAffordanceMissingSince ??= Date.now();
        if (Date.now() - activeAffordanceMissingSince >= 1000) {
          throw new Error('overlay showed no visible working affordance after submit');
        }
      } else {
        activeAffordanceMissingSince = null;
      }

      await wait(40);
    }
  } finally {
    writeTaskArtifact(
      testId,
      'overlay-post-submit-input-guard.json',
      `${JSON.stringify({
        expectedCycleId,
        guardMs,
        checkpoints,
      }, null, 2)}\n`,
    );
  }
}

async function assertOverlayRemainsDismissedAfterRun(testId, options = {}) {
  const guardMs = Number.isFinite(options.guardMs) ? options.guardMs : OVERLAY_POST_RUN_DISMISS_GUARD_MS;
  const deadline = Date.now() + guardMs;
  const checkpoints = [];
  let lastCheckpointSignature = null;

  const pushCheckpoint = (debugStatus, overlayState) => {
    const checkpoint = {
      timestamp: Date.now(),
      overlayMode: overlayState.mode,
      inputReady: overlayState.inputReady,
      renderedMode: debugStatus?.lastVisualHealth?.renderedMode ?? null,
      pillKind: debugStatus?.lastVisualHealth?.pillKind ?? null,
      hasVisibleInputControl: overlayVisualHealthHasVisibleInputPrompt(debugStatus?.lastVisualHealth ?? null),
      ...createOverlayIntegritySnapshot(debugStatus, {
        requireVisible: false,
      }),
    };
    const signature = JSON.stringify({
      overlayMode: checkpoint.overlayMode,
      inputReady: checkpoint.inputReady,
      renderedMode: checkpoint.renderedMode,
      pillKind: checkpoint.pillKind,
      hasVisibleInputControl: checkpoint.hasVisibleInputControl,
      issues: checkpoint.issues,
    });
    if (signature === lastCheckpointSignature && Date.now() < deadline) {
      return;
    }
    lastCheckpointSignature = signature;
    checkpoints.push(checkpoint);
  };

  try {
    while (Date.now() < deadline) {
      const [debugStatus, overlayState] = await Promise.all([
        getDebugStatus(),
        getOverlayState(),
      ]);

      pushCheckpoint(debugStatus, overlayState);

      const validation = validateOverlayWindows(debugStatus, { requireVisible: false });
      if (!validation.ok) {
        throw new Error(
          `overlay window integrity regressed after run completion: ${validation.issues.join('; ')}`
            + ` windows=${summarizeOverlayWindows(debugStatus)}`,
        );
      }

      if (overlayState.mode === 'input') {
        throw new Error(`overlay mode returned after run completion: ${overlayState.mode}`);
      }

      const visualHealth = debugStatus?.lastVisualHealth ?? null;
      if (visualHealth?.renderedMode === 'input') {
        throw new Error('overlay renderer returned to input mode after run completion');
      }

      if (overlayVisualHealthHasVisibleInputPrompt(visualHealth)) {
        throw new Error('overlay input control became visible again after run completion');
      }

      await wait(40);
    }
  } finally {
    writeTaskArtifact(
      testId,
      'overlay-post-run-dismiss-guard.json',
      `${JSON.stringify({
        guardMs,
        checkpoints,
      }, null, 2)}\n`,
    );
  }
}

function toLocalDisplayBounds(screenBounds, displayBounds) {
  if (!screenBounds || !displayBounds) {
    return null;
  }

  return {
    x: screenBounds.x - displayBounds.x,
    y: screenBounds.y - displayBounds.y,
    width: screenBounds.width,
    height: screenBounds.height,
  };
}

function clampPointToDisplayBounds(point, displayBounds) {
  return {
    x: clamp(
      Math.round(point.x),
      Math.round(displayBounds.x) + 2,
      Math.round(displayBounds.x + displayBounds.width) - 2,
    ),
    y: clamp(
      Math.round(point.y),
      Math.round(displayBounds.y) + 2,
      Math.round(displayBounds.y + displayBounds.height) - 2,
    ),
  };
}

function buildChaosDragPaths(targetRegion, formWindowBounds, displayBounds) {
  const insetX = Math.max(10, Math.min(28, Math.round(targetRegion.width * 0.12)));
  const insetY = Math.max(10, Math.min(28, Math.round(targetRegion.height * 0.12)));
  const left = targetRegion.x + insetX;
  const right = targetRegion.x + targetRegion.width - insetX;
  const top = targetRegion.y + insetY;
  const bottom = targetRegion.y + targetRegion.height - insetY;
  const centerX = targetRegion.x + (targetRegion.width / 2);
  const centerY = targetRegion.y + (targetRegion.height / 2);
  const outsideRight = Math.min(
    formWindowBounds.x + formWindowBounds.width + DRAG_SELECT_CHAOS_OUTSET_DIP,
    displayBounds.x + displayBounds.width - 6,
  );
  const outsideLeft = Math.max(
    formWindowBounds.x - DRAG_SELECT_CHAOS_OUTSET_DIP,
    displayBounds.x + 6,
  );
  const outsideTop = Math.max(
    formWindowBounds.y - Math.round(DRAG_SELECT_CHAOS_OUTSET_DIP * 0.6),
    displayBounds.y + 6,
  );
  const outsideBottom = Math.min(
    formWindowBounds.y + formWindowBounds.height + Math.round(DRAG_SELECT_CHAOS_OUTSET_DIP * 0.8),
    displayBounds.y + displayBounds.height - 6,
  );
  const displayLeft = displayBounds.x + DRAG_SELECT_CHAOS_CORNER_MARGIN_DIP;
  const displayRight = displayBounds.x + displayBounds.width - DRAG_SELECT_CHAOS_CORNER_MARGIN_DIP;
  const displayTop = displayBounds.y + DRAG_SELECT_CHAOS_CORNER_MARGIN_DIP;
  const displayBottom = displayBounds.y + displayBounds.height - DRAG_SELECT_CHAOS_CORNER_MARGIN_DIP;
  const displayOrigin = { x: displayLeft, y: displayTop };
  const upperBandY = Math.max(displayTop, formWindowBounds.y - 14);
  const lowerBandY = Math.min(displayBottom, formWindowBounds.y + formWindowBounds.height + 14);

  return [
    {
      name: 'right-whip-zigzag',
      path: [
        { x: left, y: top },
        { x: centerX, y: top + 16 },
        { x: outsideRight, y: centerY - 18 },
        { x: centerX + 22, y: centerY + 12 },
        { x: right, y: bottom },
      ],
    },
    {
      name: 'left-hook-zigzag',
      path: [
        { x: right, y: bottom },
        { x: centerX + 12, y: centerY + 18 },
        { x: outsideLeft, y: centerY + 4 },
        { x: centerX - 18, y: centerY - 20 },
        { x: left, y: top },
      ],
    },
    {
      name: 'fullscreen-corner-scrape',
      path: [
        { x: centerX, y: centerY },
        { x: displayRight, y: displayTop },
        { x: displayLeft, y: upperBandY },
        { x: displayLeft, y: displayBottom },
        { x: displayRight, y: lowerBandY },
        { x: displayRight, y: displayBottom },
        { x: centerX, y: centerY },
      ],
    },
    {
      name: 'display-safe-origin-scrape',
      path: [
        { x: centerX, y: centerY },
        displayOrigin,
        { x: displayLeft, y: displayBottom },
        { x: displayRight, y: displayTop },
        { x: displayRight, y: displayBottom },
        { x: centerX, y: centerY },
      ],
    },
    {
      name: 'window-edge-lariat',
      path: [
        { x: right, y: centerY - 10 },
        { x: outsideRight, y: upperBandY },
        { x: displayRight, y: centerY },
        { x: outsideRight, y: lowerBandY },
        { x: centerX, y: displayBottom },
        { x: outsideLeft, y: lowerBandY },
        { x: displayLeft, y: centerY + 10 },
        { x: outsideLeft, y: upperBandY },
        { x: centerX, y: displayTop },
        { x: left, y: centerY - 16 },
      ],
    },
    {
      name: 'perimeter-chaos-box',
      path: [
        { x: centerX, y: centerY },
        { x: right, y: top },
        { x: outsideRight, y: top + 10 },
        { x: displayRight, y: top + 6 },
        { x: right, y: bottom },
        { x: centerX, y: outsideBottom },
        { x: centerX, y: displayBottom },
        { x: left, y: bottom },
        { x: outsideLeft, y: centerY },
        { x: displayLeft, y: centerY },
        { x: left, y: top },
        { x: centerX, y: outsideTop },
        { x: centerX, y: displayTop },
        { x: centerX, y: centerY },
      ],
    },
  ].map((entry, index) => ({
    ...entry,
    timingProfile: DRAG_SELECT_CHAOS_TIMING_PROFILES[index % DRAG_SELECT_CHAOS_TIMING_PROFILES.length],
    path: entry.path.map((point) => clampPointToDisplayBounds(point, displayBounds)),
  }));
}

async function performMouseDrag(pathPoints, options = {}) {
  if (!Array.isArray(pathPoints) || pathPoints.length < 2) {
    throw new Error('Mouse drag requires at least two path points.');
  }

  const onStep = typeof options.onStep === 'function' ? options.onStep : null;
  const allowHotCorner = options.allowEmergencyAbortHotCorner === true;
  const holdBeforeMs = Number.isFinite(options.holdBeforeMs) ? options.holdBeforeMs : DRAG_SELECT_HOLD_BEFORE_MS;
  const holdPressedMs = Number.isFinite(options.holdPressedMs) ? options.holdPressedMs : DRAG_SELECT_HOLD_PRESSED_MS;
  const stepDelayMs = Number.isFinite(options.stepDelayMs) ? options.stepDelayMs : DRAG_SELECT_STEP_DELAY_MS;
  const holdAfterMs = Number.isFinite(options.holdAfterMs) ? options.holdAfterMs : DRAG_SELECT_HOLD_AFTER_MS;
  const originalPosition = await mouse.getPosition();
  let buttonPressed = false;

  const emitStep = async (phase, index, point) => {
    if (!onStep) {
      return;
    }
    await onStep({ phase, index, point: { ...point } });
  };

  const runDrag = async () => {
    try {
      await mouse.setPosition(pathPoints[0]);
      await emitStep('start', 0, pathPoints[0]);
      await wait(holdBeforeMs);
      await mouse.pressButton(Button.LEFT);
      buttonPressed = true;
      await emitStep('pressed', 0, pathPoints[0]);
      await wait(holdPressedMs);

      for (let index = 1; index < pathPoints.length; index += 1) {
        await mouse.setPosition(pathPoints[index]);
        await wait(stepDelayMs);
        await emitStep('move', index, pathPoints[index]);
      }

      await wait(holdAfterMs);
      await mouse.releaseButton(Button.LEFT);
      buttonPressed = false;
      await emitStep('released', pathPoints.length - 1, pathPoints[pathPoints.length - 1]);
    } finally {
      if (buttonPressed) {
        try {
          await mouse.releaseButton(Button.LEFT);
        } catch {}
      }
      try {
        await mouse.setPosition(originalPosition);
      } catch {}
    }
  };

  if (allowHotCorner) {
    await withEmergencyAbortHotCornerSuspended(runDrag);
    return;
  }

  await runDrag();
}

async function performMouseClick(point) {
  const originalPosition = await mouse.getPosition();
  let buttonPressed = false;

  try {
    await mouse.setPosition(point);
    await wait(24);
    await mouse.pressButton(Button.LEFT);
    buttonPressed = true;
    await wait(20);
    await mouse.releaseButton(Button.LEFT);
    buttonPressed = false;
    await wait(40);
  } finally {
    if (buttonPressed) {
      try {
        await mouse.releaseButton(Button.LEFT);
      } catch {}
    }
    try {
      await mouse.setPosition(originalPosition);
    } catch {}
  }
}

async function runChaosDragSelectPrelude(testConfig, context) {
  const chaosArtifact = {
    expectedOverlayBounds: context.displayBounds,
    drags: context.chaosPaths.map((entry) => ({
      name: entry.name,
      timingProfile: entry.timingProfile,
      path: entry.path,
    })),
    checkpoints: [],
  };

  const recordCheckpoint = (label, debugStatus, extra = {}) => {
    chaosArtifact.checkpoints.push({
      label,
      timestamp: Date.now(),
      ...createOverlayIntegritySnapshot(debugStatus, {
        expectedBounds: context.displayBounds,
        ...extra,
      }),
    });
  };

  const initialOpenDebugStatus = await waitForOverlayPresentationOpenMetrics('Overlay timing before chaos prelude');
  const expectedVisualHealthRecoveryCount = Number(initialOpenDebugStatus?.visualHealthRecoveryCount ?? 0);
  recordCheckpoint('initial-open', initialOpenDebugStatus, {
    expectedVisualHealthRecoveryCount,
  });

  await pressEscape();
  await waitForOverlayState(
    'Overlay dismissed during chaos prelude',
    3000,
    (overlayState) => overlayState.mode === 'idle',
  );
  recordCheckpoint(
    'dismissed',
    await waitForOverlayPresentationClosedMetrics('Overlay timing after dismissing chaos prelude', 2000),
    { requireVisible: false },
  );

  await focusFormSurface();
  await pressCtrlSpace();
  await waitForOverlayInputReady('Overlay reopened for chaos prelude');
  recordCheckpoint(
    'reopened',
    await waitForOverlayPresentationOpenMetrics('Overlay timing after reopening chaos prelude', 2000),
  );

  const reopenOverlayForChaos = async (label) => {
    await performMouseClick(context.dismissClickPoint);
    await waitForOverlayState(
      `Overlay dismissed during ${label}`,
      3000,
      (overlayState) => overlayState.mode === 'idle',
    );
    recordCheckpoint(
      `${label}:dismissed`,
      await waitForOverlayPresentationClosedMetrics(`Overlay timing after dismissing ${label}`, 2000),
      { requireVisible: false },
    );

    await focusFormSurface();
    await pressCtrlSpace();
    await waitForOverlayInputReady(`Overlay reopened for ${label}`);
    recordCheckpoint(
      `${label}:reopened`,
      await waitForOverlayPresentationOpenMetrics(`Overlay timing after reopening ${label}`, 2000),
    );

    const shouldExerciseEscape = Array.from(label).reduce(
      (sum, char) => sum + char.charCodeAt(0),
      testConfig.id.length,
    ) % 2 === 0;
    if (!shouldExerciseEscape) {
      return;
    }

    await pressEscape();
    await waitForOverlayState(
      `Overlay dismissed by escape during ${label}`,
      3000,
      (overlayState) => overlayState.mode === 'idle',
    );
    recordCheckpoint(
      `${label}:escape-dismissed`,
      await waitForOverlayPresentationClosedMetrics(`Overlay timing after escape during ${label}`, 2000),
      { requireVisible: false, dismissal: 'escape' },
    );

    await focusFormSurface();
    await pressCtrlSpace();
    await waitForOverlayInputReady(`Overlay reopened after escape during ${label}`);
    recordCheckpoint(
      `${label}:escape-reopened`,
      await waitForOverlayPresentationOpenMetrics(`Overlay timing after escape reopen during ${label}`, 2000),
      { dismissal: 'escape' },
    );
  };

  for (let index = 0; index < context.chaosPaths.length; index += 1) {
    const dragEntry = context.chaosPaths[index];
    await performMouseDrag(dragEntry.path, {
      holdBeforeMs: dragEntry.timingProfile?.holdBeforeMs,
      holdPressedMs: dragEntry.timingProfile?.holdPressedMs,
      stepDelayMs: dragEntry.timingProfile?.stepDelayMs,
      holdAfterMs: dragEntry.timingProfile?.holdAfterMs,
      onStep: async ({ phase, index, point }) => {
        recordCheckpoint(
          `${dragEntry.name}:${phase}:${index}`,
          await assertOverlayIntegrity(
            `Overlay integrity during chaos drag ${dragEntry.name} phase=${phase} step=${index}`,
            {
              expectedBounds: context.displayBounds,
              expectedVisualHealthRecoveryCount,
            },
          ),
          {
            dragName: dragEntry.name,
            dragTimingProfile: dragEntry.timingProfile,
            dragPhase: phase,
            dragStep: index,
            point,
          },
        );
      },
    });
    await wait(DRAG_SELECT_CHAOS_SETTLE_MS);
    await waitForOverlayState(
      `Overlay remained open after chaos drag ${dragEntry.name}`,
      2000,
      (overlayState) => overlayState.mode === 'input',
    );
    recordCheckpoint(
      `${dragEntry.name}:settled`,
      await waitForOverlayIntegrity(`Overlay integrity after chaos drag ${dragEntry.name}`, 2000, {
        expectedBounds: context.displayBounds,
        expectedVisualHealthRecoveryCount,
      }),
      {
        dragName: dragEntry.name,
        dragTimingProfile: dragEntry.timingProfile,
        dragPhase: 'settled',
      },
    );

    if ((index + 1) % DRAG_SELECT_CHAOS_REOPEN_INTERVAL === 0 && index < context.chaosPaths.length - 1) {
      await reopenOverlayForChaos(`chaos-reopen-${index + 1}`);
    }
  }

  await performMouseClick(context.dismissClickPoint);
  await waitForOverlayState(
    'Overlay dismissed after click-to-dismiss chaos check',
    3000,
    (overlayState) => overlayState.mode === 'idle',
  );
  recordCheckpoint(
    'click-dismissed',
    await waitForOverlayPresentationClosedMetrics('Overlay timing after click-to-dismiss chaos check', 2000),
    {
      requireVisible: false,
      point: context.dismissClickPoint,
      expectedVisualHealthRecoveryCount,
    },
  );

  await focusFormSurface();
  await pressCtrlSpace();
  await waitForOverlayInputReady('Overlay reopened after click-to-dismiss chaos check');
  recordCheckpoint(
    'click-dismissed:reopened',
    await waitForOverlayPresentationOpenMetrics('Overlay timing after click-to-dismiss reopen', 2000),
    {
      point: context.dismissClickPoint,
      expectedVisualHealthRecoveryCount,
    },
  );

  const presentationReport = buildOverlayPresentationReport(chaosArtifact.checkpoints);
  writeTaskArtifact(testConfig.id, 'overlay-presentation-summary.json', `${JSON.stringify(presentationReport, null, 2)}\n`);
  writeTaskArtifact(testConfig.id, 'drag-select-chaos-assertion.json', `${JSON.stringify(chaosArtifact, null, 2)}\n`);
}

async function runDragSelectFormFlow(testConfig, options) {
  const formWindowBounds = await getFormSurfaceWindowBounds();
  if (!formWindowBounds) {
    throw new Error('Drag-select form mode requires the electron form surface window bounds.');
  }

  const axContext = await sendDebugCommand('captureContext');
  let targetRegion = deriveAxFormRegion({
    elements: axContext.elements,
    windowBounds: formWindowBounds,
    padding: DRAG_SELECT_FORM_PADDING_DIP,
  });
  let targetRegionSource = 'ax';

  if (!targetRegion) {
    targetRegion = deriveWindowFormRegion({
      windowBounds: formWindowBounds,
      padding: DRAG_SELECT_FORM_PADDING_DIP,
    });
    targetRegionSource = 'window-bounds';
  }

  if (!targetRegion) {
    throw new Error('Could not derive a form drag region from AX elements inside the form window.');
  }

  const displayBounds = axContext.displayBoundsDIP;
  const expectedScopeBounds = toLocalDisplayBounds(targetRegion, displayBounds);
  if (!expectedScopeBounds) {
    throw new Error('Missing display bounds for drag-select comparison.');
  }
  const dismissClickPoint = clampPointToDisplayBounds({
    x: Math.max(displayBounds.x + 80, formWindowBounds.x - 84),
    y: Math.min(displayBounds.y + 120, formWindowBounds.y + 120),
  }, displayBounds);

  const chaosPaths = buildChaosDragPaths(targetRegion, formWindowBounds, displayBounds);
  const dragPath = buildMouseDragPath(targetRegion, {
    inset: DRAG_SELECT_PATH_INSET_DIP,
    segments: DRAG_SELECT_PATH_SEGMENTS,
  });
  if (dragPath.length < 2) {
    throw new Error('Computed drag path was empty.');
  }

  writeTaskArtifact(testConfig.id, 'drag-select-form-window-bounds.json', `${JSON.stringify(formWindowBounds, null, 2)}\n`);
  writeTaskArtifact(testConfig.id, 'drag-select-target-region.json', `${JSON.stringify({
    targetRegion,
    expectedScopeBounds,
    dismissClickPoint,
    dragPath,
    chaosPaths,
    axElementCount: axContext.elementCount,
    targetRegionSource,
  }, null, 2)}\n`);
  await captureNamedContextArtifact(testConfig.id, 'drag-select-before');
  await sendDebugCommand('focusInputOverlay');
  await wait(120);

  if (options.dragSelectFormChaos) {
    await runChaosDragSelectPrelude(testConfig, {
      displayBounds,
      chaosPaths,
      dismissClickPoint,
    });
  }

  await performMouseDrag(dragPath);

  const overlayState = await waitForOverlayState(
    'Overlay scope selected after drag',
    5000,
    (nextOverlayState) => (
      nextOverlayState.mode === 'input'
      && nextOverlayState.scopeBounds
      && nextOverlayState.scopeBounds.width > 10
      && nextOverlayState.scopeBounds.height > 10
    ),
  );
  const coverage = computeBoundsCoverage(expectedScopeBounds, overlayState.scopeBounds);

  const dragSelectAfterContext = await captureNamedContextArtifact(testConfig.id, 'drag-select-after');
  writeTaskArtifact(testConfig.id, 'drag-select-overlay-state.json', `${JSON.stringify(overlayState, null, 2)}\n`);
  writeTaskArtifact(testConfig.id, 'drag-select-assertion.json', `${JSON.stringify({
    expectedScopeBounds,
    actualScopeBounds: overlayState.scopeBounds,
    coverage,
    threshold: DRAG_SELECT_COVERAGE_THRESHOLD,
    overlayIntegrity: createOverlayIntegritySnapshot(
      await assertOverlayIntegrity('Overlay integrity after final drag-select assertion', {
        expectedBounds: displayBounds,
      }),
      { expectedBounds: displayBounds },
    ),
  }, null, 2)}\n`);

  if (coverage < DRAG_SELECT_COVERAGE_THRESHOLD) {
    throw new Error(
      `Overlay scope coverage ${coverage.toFixed(3)} was below threshold ${DRAG_SELECT_COVERAGE_THRESHOLD.toFixed(3)}. expected=${JSON.stringify(expectedScopeBounds)} actual=${JSON.stringify(overlayState.scopeBounds)}`,
    );
  }

  assertDragSelectionHasRealElements(dragSelectAfterContext.elements, overlayState.scopeBounds);

  await sendDebugCommand('focusInputOverlay');
  if (process.platform !== 'win32') {
    await waitForOverlayInputReady('Overlay input ready after drag-select', 5000);
    await waitForOverlayInputReady('Overlay input still ready after drag-select focus', 3000);
  } else {
    await wait(120);
  }

  return {
    coverage,
    expectedScopeBounds,
    actualScopeBounds: overlayState.scopeBounds,
    targetRegion,
    formWindowBounds,
  };
}

async function runRealInteractionFlow(testConfig, options) {
  await moveMouseAwayFromOverlayEmergencyStopHotCorner();
  const emergencyAbort = startEmergencyAbortMonitor();
  try {
    const baselineDebugStatus = await getDebugStatus();
    const systemAddendum = buildRunnerSystemAddendum(testConfig, options);
    const effectiveSourceContext = resolveEffectiveSourceContext(testConfig, options);
    await sendDebugCommand('setNextRunSystemAddendum', {
      systemAddendum,
    });
    await sendDebugCommand('setOverlaySettings', {
      preferredProfileId: resolveOverlayWorkspaceAgentProfileId(testConfig),
    });
    await focusFormSurface();
    await moveMouseAwayFromOverlayEmergencyStopHotCorner();
    await pressCtrlSpace();
    await waitForOverlayInputReady('Overlay ready input mode', Math.min(options.timeoutMs, RUN_START_TIMEOUT_MS));
    if (shouldRunOverlayLaunchSmoke(testConfig, options)) {
      await selectOverlayAgentProfileThroughUi({
        desiredValue: resolveOverlayWorkspaceAgentProfileId(testConfig),
        desiredLabel: testConfig?.task?.overlayProfileLabel || null,
      });
    }
    const initialOpenTimingStatus = await waitForOverlayPresentationOpenMetrics(
      'Overlay timing after opening',
      Math.min(options.timeoutMs, RUN_START_TIMEOUT_MS),
    );
    console.log(`[OverlayTiming] ${formatOverlayPresentationTimings(initialOpenTimingStatus)}`);
    const initialPresentationReport = buildOverlayPresentationReport([
      {
        label: 'initial-open',
        presentationTimings: initialOpenTimingStatus.presentationTimings,
      },
    ]);
    console.log(`[OverlayTiming][Summary] ${formatOverlayPresentationStats(initialPresentationReport)}`);
    writeTaskArtifact(testConfig.id, 'overlay-input-ready-timing.json', `${JSON.stringify({
      presentationTimings: initialOpenTimingStatus.presentationTimings,
      progressiveBlur: initialOpenTimingStatus.progressiveBlur,
    }, null, 2)}\n`);
    writeTaskArtifact(
      testConfig.id,
      'overlay-presentation-summary.json',
      `${JSON.stringify(initialPresentationReport, null, 2)}\n`,
    );
    if (shouldRunDragSelectFormFlow(testConfig, options)) {
      await runDragSelectFormFlow(testConfig, options);
    }
    if (options.guiInspect) {
      await wait(GUI_INSPECT_SETTLE_MS);
      const openInputOverlayState = await getOverlayState();
      if (openInputOverlayState.mode === 'input') {
        await captureInputArtifacts(testConfig.id, openInputOverlayState, 'open');
      }
    }
    if (testConfig?.task?.gradingMode === 'workspace-artifact') {
      const preSubmitDebugStatus = await getDebugStatus();
      const selectedWorkspaceValue = preSubmitDebugStatus?.lastVisualHealth?.selectedWorkspaceValue ?? null;
      const workspaceArtifactRoot = resolveWorkspaceArtifactBaseDir(testConfig, { selectedWorkspaceValue });
      cleanupExpectedWorkspaceArtifact(testConfig, { workspacePath: workspaceArtifactRoot });
      writeTaskArtifact(
        testConfig.id,
        'workspace-artifact-root.json',
        `${JSON.stringify({
          workspaceArtifactRoot,
          selectedWorkspaceValue,
        }, null, 2)}\n`,
      );
    }
    const runnerPrompt = buildRunnerPrompt(testConfig, options);
    if (effectiveSourceContext === 'paste') {
      await pasteOverlayPrompt(runnerPrompt);
    } else {
      await typeOverlayPrompt(runnerPrompt);
    }
    if (options.guiInspect) {
      await wait(GUI_INSPECT_SETTLE_MS);
      const inputOverlayState = await getOverlayState();
      if (inputOverlayState.mode === 'input') {
        await captureInputArtifacts(testConfig.id, inputOverlayState, 'typed');
      }
    }
    if (process.platform === 'win32' && !shouldRunOverlayLaunchSmoke(testConfig, options)) {
      await focusFormSurface();
      await sendDebugCommand('submitInputOverlay');
    } else {
      await focusOverlayEditor('Overlay editor focused before submit');
      await pressEnter();
    }
    const liveOverlayFillHandoff = isLiveOverlayFillHandoff(testConfig, options);
    const backdropSyncAfterSubmit = await waitForOverlayBackdropSync(
      'Overlay backdrop sync after submit',
      Math.min(options.timeoutMs, RUN_START_TIMEOUT_MS),
    );
    writeTaskArtifact(testConfig.id, 'overlay-active-backdrop-after-submit.json', `${JSON.stringify({
      overlayState: backdropSyncAfterSubmit.overlayState,
      lastVisualHealth: backdropSyncAfterSubmit.debugStatus.lastVisualHealth,
      progressiveBlur: backdropSyncAfterSubmit.debugStatus.progressiveBlur,
      progressiveBlurHandoffPending: backdropSyncAfterSubmit.debugStatus.progressiveBlurHandoffPending,
      presentationTimings: backdropSyncAfterSubmit.debugStatus.presentationTimings,
      hasVisibleInputPrompt: backdropSyncAfterSubmit.hasVisibleInputPrompt,
    }, null, 2)}\n`);
    if (options.overlayVisualProbe) {
      await runOverlayVisualProbeFlow(testConfig);
    }
    const postSubmitStatus = liveOverlayFillHandoff
      ? await waitForOverlayInputDismissedAfterSubmit(
        'Overlay input dismissed after live handoff submit',
        Math.min(options.timeoutMs, RUN_START_TIMEOUT_MS),
      )
      : await waitForOverlayPresentationClosedMetrics(
        'Overlay input closed after submit',
        Math.min(options.timeoutMs, RUN_START_TIMEOUT_MS),
      );
    writeTaskArtifact(testConfig.id, 'overlay-input-closed-after-submit.json', `${JSON.stringify({
      liveOverlayFillHandoff,
      overlayState: 'overlayState' in postSubmitStatus ? postSubmitStatus.overlayState : null,
      presentationTimings: postSubmitStatus.presentationTimings,
      progressiveBlur: postSubmitStatus.progressiveBlur,
      lastVisualHealth: postSubmitStatus.lastVisualHealth,
    }, null, 2)}\n`);
    const postSubmitOverlayWindows = Array.isArray(backdropSyncAfterSubmit.debugStatus?.overlayWindows)
      ? backdropSyncAfterSubmit.debugStatus.overlayWindows
      : [];
    const postSubmitExpectedWindowBounds = (
      postSubmitOverlayWindows.find((window) => window.title === 'Interpreter World Overlay')?.bounds
      ?? postSubmitOverlayWindows[0]?.bounds
      ?? null
    );
    if (!shouldRunOverlayLaunchSmoke(testConfig, options)) {
      await assertOverlayInputStayedClosedAfterSubmit(testConfig.id, {
        expectedBounds: postSubmitExpectedWindowBounds,
        expectedCycleId: postSubmitStatus?.presentationTimings?.cycleId ?? null,
        requireVisibleWhenActive: !liveOverlayFillHandoff,
      });
    }
    if (options.guiInspect) {
      if (shouldRunOverlayLaunchSmoke(testConfig, options)) {
        await captureNamedContextArtifact(testConfig.id, 'post-submit-backgrounded');
      } else {
        try {
          const thinkingOverlayState = await waitForOverlayState(
            'Overlay thinking mode',
            Math.min(options.timeoutMs, RUN_START_TIMEOUT_MS),
            (overlayState) => (
              overlayState.mode === 'working'
              && overlayState.action === null
              && Array.isArray(overlayState.ghosts)
              && overlayState.ghosts.length === 0
              && overlayState.pill.kind === 'loading'
            ),
          );
          await wait(120);
          await captureInputArtifacts(testConfig.id, thinkingOverlayState, 'thinking');
        } catch (error) {
          console.log(
            `[GUI Inspect] Skipped initial thinking capture: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    const runState = await waitForCondition('Overlay run start', RUN_START_TIMEOUT_MS, async () => {
      const debugStatus = await getDebugStatus();
      return debugStatus.run.id > baselineDebugStatus.run.id ? debugStatus.run : null;
    });
    if (shouldRunOverlayLaunchSmoke(testConfig, options)) {
      await assertOverlayLaunchSmokeHandoff(
        testConfig.id,
        backdropSyncAfterSubmit.overlayState.scopeBounds,
      );
    }

    const deadline = Date.now() + options.timeoutMs;
    let approvedActionId = null;
    let reviewCount = 0;
    let escTriggered = false;
    let pausedOnFirstTypeReview = false;
    let latestOverlayState = null;
    let latestRunState = runState;
    let backgroundAgentLaunched = false;

    while (Date.now() < deadline) {
      const debugStatus = await getDebugStatus();
      latestRunState = debugStatus.run;

      if (latestRunState.id !== runState.id) {
        throw new Error(
          `Overlay run changed unexpectedly. expected=${formatRunState(runState)} actual=${formatRunState(latestRunState)}`,
        );
      }

      if (isTerminalRunStatus(latestRunState.status)) {
        if (latestRunState.status === 'completed') {
          if (!liveOverlayFillHandoff) {
            await waitForOverlayBackdropCleared('Overlay backdrop cleared after run completion', 2000);
            return {
              reviewCount,
              runStatus: latestRunState.status,
              runReason: latestRunState.reason,
              finalText: latestRunState.finalText,
            };
          }
          backgroundAgentLaunched = true;
        } else if (latestRunState.status === 'cancelled' && escTriggered) {
          await waitForOverlayBackdropCleared('Overlay backdrop cleared after escape cancellation', 2000);
          return {
            abortedByEsc: true,
            reviewCount,
            runStatus: latestRunState.status,
            runReason: latestRunState.reason,
            finalText: latestRunState.finalText,
          };
        } else {
          const finalText = latestRunState.finalText ? ` finalText=${JSON.stringify(latestRunState.finalText)}` : '';
          throw new Error(
            `Overlay run ended with ${formatRunState(latestRunState)}${finalText}`,
          );
        }
      }

      const overlayState = await getOverlayState();
      latestOverlayState = overlayState;
      assertOverlayBackdropState('Overlay backdrop state during run', debugStatus, overlayState);

      if (backgroundAgentLaunched) {
        const progressiveBlur = debugStatus?.progressiveBlur ?? null;
        const inputVisible = overlayVisualHealthHasVisibleInputPrompt(debugStatus?.lastVisualHealth ?? null);
        const backdropCleared = overlayState.mode === 'idle'
          && !inputVisible
          && (!progressiveBlur?.supported || !progressiveBlur.visible);

        if (backdropCleared) {
          return {
            reviewCount,
            runStatus: latestRunState.status,
            runReason: latestRunState.reason,
            finalText: latestRunState.finalText,
          };
        }
      }

      if (overlayState.mode === 'review' && overlayState.action) {
        assertWorldPinnedReviewGeometry(overlayState);
        if (approvedActionId !== overlayState.action.id) {
          approvedActionId = overlayState.action.id;
          reviewCount += 1;
          const currentOverlayState = overlayState;
          if (
            options.guiInspect &&
            currentOverlayState.action.type === 'type'
          ) {
            await wait(GUI_INSPECT_SETTLE_MS);
            await captureReviewArtifacts(testConfig.id, reviewCount, currentOverlayState, 'review');
            if (!pausedOnFirstTypeReview && options.guiInspectPauseMs > 0) {
              await wait(options.guiInspectPauseMs);
            }
            pausedOnFirstTypeReview = true;
          }
          if (options.escOnReview !== null && reviewCount === options.escOnReview) {
            escTriggered = true;
            await pressEscape();
          } else {
            if (!options.guiInspect && Array.isArray(currentOverlayState.ghosts) && currentOverlayState.ghosts.length > 0) {
              await pressAcceptAllApproval();
            } else {
              await pressCtrlApproval();
            }
            if (options.guiInspect && currentOverlayState.action.type === 'type') {
              let executingOverlayState = null;
              try {
                executingOverlayState = await waitForOverlayState(
                  `Overlay executing review ${reviewCount}`,
                  4000,
                  (nextOverlayState) => (
                    nextOverlayState.mode === 'working'
                    && nextOverlayState.action !== null
                    && sameOverlayActionTarget(currentOverlayState.action, nextOverlayState.action)
                  ),
                );
                await wait(GUI_INSPECT_SETTLE_MS);
                await captureReviewArtifacts(testConfig.id, reviewCount, executingOverlayState, 'executing');
              } catch (error) {
                console.log(
                  `[GUI Inspect] Skipped executing capture for review ${reviewCount}: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              try {
                const attachedThinkingOverlayState = await waitForOverlayState(
                  `Overlay attached thinking ${reviewCount}`,
                  1200,
                  (nextOverlayState) => (
                    nextOverlayState.mode === 'working'
                    && nextOverlayState.action === null
                    && nextOverlayState.pill.kind === 'loading'
                  ),
                );
                await wait(GUI_INSPECT_SETTLE_MS);
                await captureReviewArtifacts(
                  testConfig.id,
                  reviewCount,
                  attachedThinkingOverlayState,
                  'thinking',
                  executingOverlayState?.action?.bounds ?? currentOverlayState.action?.bounds ?? null,
                );
              } catch (error) {
                console.log(
                  `[GUI Inspect] Skipped attached thinking capture for review ${reviewCount}: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          }
        }
        await wait(50);
        continue;
      }

      await wait(50);
    }

    throw new Error(
      `Real interaction watchdog timed out after ${options.timeoutMs}ms run=${formatRunState(latestRunState)} overlayMode=${latestOverlayState?.mode ?? 'unknown'} reviews=${reviewCount}`,
    );
  } finally {
    emergencyAbort.stop();
  }
}

async function loadTests(selectedIds) {
  const generatedTests = await buildGeneratedTests({ selectedIds });
  return generatedTests.map(({ testId, config }) => ({ id: testId, ...config }));
}

function getFieldNormalizationKind(fieldId) {
  const key = String(fieldId || '').toLowerCase();

  if (key.includes('phone')) {
    return 'phone';
  }

  if (key.includes('date')) {
    return 'date';
  }

  return 'default';
}

function normalizeScalarValue(fieldId, value) {
  const raw = String(value || '').trim();
  const kind = getFieldNormalizationKind(fieldId);

  if (raw === '') {
    return raw;
  }

  if (kind === 'phone' || kind === 'date') {
    return raw.replace(/\D+/g, '');
  }

  return raw
    .replace(/\s+/g, ' ')
    .replace(/([A-Za-z0-9)\]])[.,;:!?]+$/u, '$1');
}

function formatValue(value) {
  if (Array.isArray(value)) {
    return `[${value.join(', ')}]`;
  }

  return `"${String(value ?? '')}"`;
}

function isEmptyValue(value) {
  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return String(value ?? '').trim() === '';
}

function compareFieldValue(field, actualValue, expectedValue) {
  const fieldId = field.id;
  if (Array.isArray(expectedValue)) {
    const actualArray = Array.isArray(actualValue) ? [...actualValue].sort() : [];
    const allowedValues = Array.isArray(field.options) ? new Set(field.options) : null;
    const expectedArray = (allowedValues
      ? expectedValue.filter((value) => allowedValues.has(value))
      : [...expectedValue]
    ).sort();
    const passed = JSON.stringify(actualArray) === JSON.stringify(expectedArray);
    return {
      passed,
      detail: passed
        ? null
        : `${fieldId}: expected [${expectedArray.join(', ')}], got [${actualArray.join(', ')}]`,
    };
  }

  const actualString = String(actualValue || '');
  const expectedString = String(expectedValue || '');
  const normalizedActual = normalizeScalarValue(fieldId, actualString);
  const normalizedExpected = normalizeScalarValue(fieldId, expectedString);
  const passed = normalizedActual === normalizedExpected;

  return {
    passed,
    detail: passed
      ? null
      : `${fieldId}: expected "${expectedString}", got "${actualString}"`,
  };
}

function evaluateTask(testConfig, taskState) {
  const task = testConfig?.task;
  if (!task || task.gradingMode !== 'visible-intersection' || !task.expectedValues) {
    throw new Error('Test config is missing visible-intersection grading metadata');
  }

  const sourceState = taskState?.source || { visibleFieldIds: [] };
  const formState = taskState?.form || { values: {}, submitted: false, visibleFieldIds: [], visibleRequiredFieldIds: [], submitVisible: false };
  const actualValues = formState.values || {};
  const submitted = Boolean(formState.submitted);
  const visibleSourceFieldIds = new Set(sourceState.visibleFieldIds || []);
  const visibleFormFieldIds = new Set(formState.visibleFieldIds || []);
  const visibleRequiredFieldIds = new Set(formState.visibleRequiredFieldIds || []);
  let correct = 0;
  let incorrect = 0;
  const details = [];
  const fieldResults = new Map();

  for (const field of testConfig.form.fields) {
    if (!visibleFormFieldIds.has(field.id)) {
      continue;
    }

    if (visibleSourceFieldIds.has(field.id) && Object.prototype.hasOwnProperty.call(task.expectedValues, field.id)) {
      const comparison = compareFieldValue(field, actualValues[field.id], task.expectedValues[field.id]);
      fieldResults.set(field.id, {
        type: 'field-value',
        passed: comparison.passed,
      });

      if (comparison.passed) {
        correct += 1;
      } else {
        incorrect += 1;
        details.push(comparison.detail);
      }
      continue;
    }

    if (visibleSourceFieldIds.has(field.id)) {
      fieldResults.set(field.id, {
        type: 'field-source-only',
        passed: true,
      });
      correct += 1;
      continue;
    }

    const actualValue = actualValues[field.id];
    const passed = isEmptyValue(actualValue);
    fieldResults.set(field.id, {
      type: 'field-empty',
      passed,
    });

    if (passed) {
      correct += 1;
    } else {
      incorrect += 1;
      details.push(`${field.id}: expected empty, got ${formatValue(actualValue)}`);
    }
  }

  if (testConfig.form.hasSubmit) {
    const requiredVisible = Array.from(visibleRequiredFieldIds);
    const everyVisibleRequiredSatisfied = requiredVisible.every((fieldId) => {
      const fieldResult = fieldResults.get(fieldId);
      return Boolean(fieldResult?.passed);
    });
    const shouldSubmit = Boolean(formState.submitVisible)
      && Array.from(visibleFormFieldIds).length > 0
      && everyVisibleRequiredSatisfied;

    if (submitted === shouldSubmit) {
      correct += 1;
    } else {
      incorrect += 1;
      if (shouldSubmit) {
        details.push('Form should have been submitted once every visible required field with visible source data was completed.');
      } else {
        details.push('Form should not have been submitted because visible required data was still missing or unavailable.');
      }
    }
  }

  return {
    correct,
    incorrect,
    total: correct + incorrect,
    details,
    submitted,
  };
}

function resolveWorkspaceArtifactPath(relativePath, workspaceRoot = TEST_WORKSPACE_DIR) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Workspace artifact path must be a non-empty relative path.');
  }

  const baseDir = path.resolve(workspaceRoot || TEST_WORKSPACE_DIR);
  const resolvedPath = path.resolve(baseDir, relativePath);
  const workspaceRootWithSeparator = `${baseDir}${path.sep}`;
  if (resolvedPath !== baseDir && !resolvedPath.startsWith(workspaceRootWithSeparator)) {
    throw new Error(`Workspace artifact path escaped the test workspace: ${relativePath}`);
  }
  return resolvedPath;
}

function readOverlayLaunchDiagnostics(testId) {
  if (!testId) {
    return null;
  }

  const diagnosticsPath = path.join(createTestOutputDir(testId), 'overlay-workspace-agent-launch.json');
  if (!fs.existsSync(diagnosticsPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Failed to parse JSONL line ${index + 1} from ${filePath}: ${error.message}`);
      }
    });
}

function normalizeAgentToolName(toolName) {
  const trimmed = String(toolName || '').trim();
  if (!trimmed) {
    return '';
  }

  const separatorIndex = trimmed.lastIndexOf('__');
  if (separatorIndex >= 0) {
    return trimmed.slice(separatorIndex + 2);
  }

  return trimmed;
}

function detectOverlayCliToolName(command) {
  const normalizedCommand = String(command || '').replace(/\s+/g, ' ').trim();
  if (!normalizedCommand) {
    return '';
  }

  const match = normalizedCommand.match(/tools builtin-interpreter-overlay (overlay_[a-z_]+)/);
  return match ? match[1] : '';
}

function getAppAgentToolCalls() {
  const agentEventsPath = path.join(OUTPUT_DIR, 'app.agent-events.jsonl');
  const events = readJsonLines(agentEventsPath);
  return events
    .filter((event) => event?.kind === 'transcript' && event?.type === 'tool_call')
    .map((event, index) => {
      const rawInput = event.input ?? null;
      const normalizedToolName = normalizeAgentToolName(event.toolName);
      const overlayCliToolName = normalizedToolName === 'command_execution'
        ? detectOverlayCliToolName(rawInput?.command)
        : '';
      return {
        index,
        timestamp: event.timestamp ?? null,
        toolName: String(event.toolName || ''),
        normalizedToolName: overlayCliToolName || normalizedToolName,
        input: rawInput,
      };
    });
}

function assertOverlayAgentToolLifecycle(testConfig, options = {}) {
  const testId = testConfig?.id;
  const detachExpectation = typeof testConfig?.task?.overlayDetachExpectation === 'string'
    ? testConfig.task.overlayDetachExpectation.trim()
    : '';
  if (!testId || !detachExpectation) {
    return;
  }

  const toolCalls = getAppAgentToolCalls();
  writeTaskArtifact(testId, 'overlay-agent-tool-sequence.json', `${JSON.stringify({
    detachExpectation,
    toolCalls,
  }, null, 2)}\n`);

  const issues = [];
  const legacyPrimitiveOverlayCalls = toolCalls.filter((call) => (
    call.normalizedToolName === 'overlay_click'
    || call.normalizedToolName === 'overlay_type'
    || call.normalizedToolName === 'overlay_hotkey'
    || call.normalizedToolName === 'overlay_scroll'
  ));
  const overlayToolCalls = toolCalls.filter((call) => (
    call.normalizedToolName === 'computer_batch'
    || call.normalizedToolName.startsWith('overlay_')
  ));
  const overlayDetachIndex = toolCalls.findIndex((call) => (
    call.normalizedToolName === 'overlay_detach' || call.normalizedToolName === 'overlay_complete'
  ));
  const firstComputerBatchIndex = toolCalls.findIndex((call) => call.normalizedToolName === 'computer_batch');
  const firstCommandExecutionIndex = toolCalls.findIndex((call) => call.normalizedToolName === 'command_execution');
  const firstOverlayToolIndex = toolCalls.findIndex((call) => (
    call.normalizedToolName === 'computer_batch'
    || call.normalizedToolName.startsWith('overlay_')
  ));
  const firstInteractiveOverlayIndex = toolCalls.findIndex((call) => (
    call.normalizedToolName === 'overlay_read_context'
    || call.normalizedToolName === 'overlay_screenshot'
    || call.normalizedToolName === 'computer_batch'
  ));

  if (overlayToolCalls.length === 0) {
    issues.push('agent never used any overlay tools');
  }

  if (overlayDetachIndex < 0) {
    issues.push('agent never explicitly called overlay_detach or overlay_complete');
  }

  if (legacyPrimitiveOverlayCalls.length > 0) {
    issues.push(`agent regressed to legacy primitive overlay actions: ${legacyPrimitiveOverlayCalls.map((call) => call.normalizedToolName).join(', ')}`);
  }

  if (detachExpectation === 'detach-before-command') {
    if (overlayDetachIndex < 0) {
      issues.push('capture-only overlay task never explicitly detached before continuing');
    } else if (firstCommandExecutionIndex >= 0 && overlayDetachIndex > firstCommandExecutionIndex) {
      issues.push(
        `capture-only overlay task ran non-overlay command_execution before explicit detach detachIndex=${overlayDetachIndex} commandExecutionIndex=${firstCommandExecutionIndex}`,
      );
    }
  } else if (detachExpectation === 'live-overlay-fill') {
    if (firstInteractiveOverlayIndex < 0) {
      issues.push('live overlay fill task never used an interactive overlay tool before finishing');
    } else if (overlayDetachIndex >= 0 && overlayDetachIndex < firstInteractiveOverlayIndex) {
      issues.push(
        `live overlay fill task detached before doing any live overlay interaction detachIndex=${overlayDetachIndex} firstInteractiveOverlayIndex=${firstInteractiveOverlayIndex}`,
      );
    }
    if (firstComputerBatchIndex < 0) {
      issues.push('live overlay fill task never used computer_batch');
    } else if (overlayDetachIndex >= 0 && overlayDetachIndex < firstComputerBatchIndex) {
      issues.push(
        `live overlay fill task detached before computer_batch detachIndex=${overlayDetachIndex} firstComputerBatchIndex=${firstComputerBatchIndex}`,
      );
    }
    if (firstOverlayToolIndex >= 0 && firstOverlayToolIndex !== firstComputerBatchIndex) {
      issues.push(
        `live overlay fill task did not start with computer_batch firstOverlayToolIndex=${firstOverlayToolIndex} firstComputerBatchIndex=${firstComputerBatchIndex}`,
      );
    }
  } else {
    issues.push(`unknown overlayDetachExpectation=${detachExpectation}`);
  }

  if (issues.length > 0) {
    writeTaskArtifact(testId, 'overlay-agent-tool-sequence-issues.txt', `${issues.join('\n')}\n`);
    throw new Error(`Overlay agent tool lifecycle failed: ${issues.join(' | ')}`);
  }
}

function resolveWorkspacePathFromSelectionValue(selectedWorkspaceValue, windowSessions = []) {
  if (typeof selectedWorkspaceValue !== 'string' || !selectedWorkspaceValue.trim()) {
    return null;
  }

  if (selectedWorkspaceValue.startsWith('path:')) {
    const workspacePath = selectedWorkspaceValue.slice('path:'.length).trim();
    return workspacePath || null;
  }

  if (selectedWorkspaceValue.startsWith('window:')) {
    const sessionKey = selectedWorkspaceValue.slice('window:'.length).trim();
    if (!sessionKey) {
      return null;
    }
    const matchingSession = Array.isArray(windowSessions)
      ? windowSessions.find((session) => session?.sessionKey === sessionKey)
      : null;
    return matchingSession?.workspacePath ?? null;
  }

  return null;
}

function resolveWorkspaceArtifactBaseDir(testConfig, options = {}) {
  const launchDiagnostics = options.launchDiagnostics ?? readOverlayLaunchDiagnostics(testConfig?.id);
  const windowSessions = Array.isArray(launchDiagnostics?.windowSessions)
    ? launchDiagnostics.windowSessions
    : [];

  const candidates = [
    options.workspacePath,
    launchDiagnostics?.lastWorkspaceAgentLaunch?.workspacePath,
    launchDiagnostics?.overlaySession?.workspacePath,
    launchDiagnostics?.agentBinding?.workspacePath,
    resolveWorkspacePathFromSelectionValue(options.selectedWorkspaceValue ?? null, windowSessions),
    TEST_WORKSPACE_DIR,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return path.resolve(candidate);
    }
  }

  return path.resolve(TEST_WORKSPACE_DIR);
}

function cleanupExpectedWorkspaceArtifact(testConfig, options = {}) {
  const relativePath = testConfig?.task?.expectedArtifact?.relativePath;
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return;
  }

  const workspaceRoot = resolveWorkspaceArtifactBaseDir(testConfig, options);
  fs.rmSync(resolveWorkspaceArtifactPath(relativePath, workspaceRoot), { force: true });
}

function evaluateWorkspaceArtifactTask(testConfig, initialTaskState, taskState) {
  const task = testConfig?.task;
  const expectedArtifact = task?.expectedArtifact;
  if (!task || task.gradingMode !== 'workspace-artifact' || !expectedArtifact?.relativePath) {
    throw new Error('Test config is missing workspace-artifact grading metadata');
  }

  const details = [];
  let correct = 0;
  let incorrect = 0;
  const launchDiagnostics = readOverlayLaunchDiagnostics(testConfig?.id);
  const artifactWorkspaceRoot = resolveWorkspaceArtifactBaseDir(testConfig, { launchDiagnostics });
  const artifactPath = resolveWorkspaceArtifactPath(expectedArtifact.relativePath, artifactWorkspaceRoot);
  const artifactExists = fs.existsSync(artifactPath);
  const submitted = Boolean(taskState?.form?.submitted);

  if (artifactExists) {
    correct += 1;
  } else {
    incorrect += 1;
    details.push(`Expected saved form screenshot at ${expectedArtifact.relativePath}.`);
  }

  let artifactBuffer = null;
  if (artifactExists) {
    const artifactStat = fs.statSync(artifactPath);
    artifactBuffer = fs.readFileSync(artifactPath);
    const minBytes = Number(expectedArtifact.minBytes || 0);
    if (artifactStat.size >= minBytes) {
      correct += 1;
    } else {
      incorrect += 1;
      details.push(`Saved artifact was too small. expected at least ${minBytes} bytes, got ${artifactStat.size}.`);
    }

    const basename = path.basename(expectedArtifact.relativePath).toLowerCase();
    const filenameKeywords = Array.isArray(expectedArtifact.filenameKeywords) ? expectedArtifact.filenameKeywords : [];
    const missingKeywords = filenameKeywords.filter((keyword) => !basename.includes(String(keyword).toLowerCase()));
    if (missingKeywords.length === 0) {
      correct += 1;
    } else {
      incorrect += 1;
      details.push(`Saved filename was missing descriptive keywords: ${missingKeywords.join(', ')}.`);
    }
  }

  if (expectedArtifact.matchesInitialScreenshot) {
    if (!launchDiagnostics) {
      incorrect += 1;
      details.push('Overlay launch diagnostics were missing, so the saved file could not be compared to the original selected-region screenshot.');
    } else {
      const initialScreenshotPath = launchDiagnostics?.lastWorkspaceAgentLaunch?.initialScreenshotPath
        ?? launchDiagnostics?.overlaySession?.initialScreenshotPath;
      if (typeof initialScreenshotPath !== 'string' || !initialScreenshotPath.trim()) {
        incorrect += 1;
        details.push('Overlay launch diagnostics did not include the initial selected-region screenshot path.');
      } else if (!artifactBuffer) {
        incorrect += 1;
        details.push('Saved artifact was missing, so it could not be compared to the original selected-region screenshot.');
      } else if (!fs.existsSync(initialScreenshotPath)) {
        incorrect += 1;
        details.push(`Initial selected-region screenshot path no longer existed: ${initialScreenshotPath}`);
      } else {
        const initialBuffer = fs.readFileSync(initialScreenshotPath);
        if (Buffer.compare(initialBuffer, artifactBuffer) === 0) {
          correct += 1;
        } else {
          incorrect += 1;
          details.push('Saved artifact did not exactly match the original selected-region screenshot.');
        }
      }
    }
  }

  if (task.requireFormUnchanged) {
    const initialValues = initialTaskState?.form?.values || {};
    const actualValues = taskState?.form?.values || {};
    const changedFields = [];

    for (const field of testConfig.form.fields || []) {
      const fieldId = field.id;
      const initialValue = Object.prototype.hasOwnProperty.call(initialValues, fieldId) ? initialValues[fieldId] : '';
      const actualValue = Object.prototype.hasOwnProperty.call(actualValues, fieldId) ? actualValues[fieldId] : '';
      if (JSON.stringify(initialValue) !== JSON.stringify(actualValue)) {
        changedFields.push(`${fieldId}: expected ${formatValue(initialValue)}, got ${formatValue(actualValue)}`);
      }
    }

    if (changedFields.length === 0 && !submitted) {
      correct += 1;
    } else {
      incorrect += 1;
      if (submitted) {
        details.push('Form should not have been submitted for the screenshot-save task.');
      }
      details.push(...changedFields);
    }
  }

  return {
    correct,
    incorrect,
    total: correct + incorrect,
    details,
    submitted,
    savedArtifactPath: expectedArtifact.relativePath,
    artifactWorkspaceRoot,
  };
}

function createTestOutputDir(testId) {
  const testOutputDir = path.join(OUTPUT_DIR, testId);
  ensureDir(testOutputDir);
  return testOutputDir;
}

function resetTestOutputDir(testId) {
  const testOutputDir = path.join(OUTPUT_DIR, testId);
  fs.rmSync(testOutputDir, { recursive: true, force: true });
  ensureDir(testOutputDir);
  return testOutputDir;
}

function writeTaskArtifact(testId, filename, data) {
  const testOutputDir = createTestOutputDir(testId);
  fs.writeFileSync(path.join(testOutputDir, filename), data);
}

function writeLiveChromeSurfaceArtifacts(testId, taskState) {
  if (!testId || !taskState) {
    return;
  }
  writeTaskArtifact(testId, 'task-state.json', `${JSON.stringify(taskState, null, 2)}\n`);
  writeJsTraceArtifacts(testId, taskState);
}

function serializeScriptValue(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function renderChromeNoisePage(title, subtitle, items) {
  const itemMarkup = (items || [])
    .map((item) => `<li><strong>${item.title}</strong><span>${item.detail}</span></li>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light; font-family: "Aptos", "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, #f8fafc, #edf2f7); color: #172033; }
    main { padding: 28px; display: grid; gap: 18px; }
    .hero, .card { background: rgba(255,255,255,0.96); border: 1px solid rgba(15,23,42,0.10); border-radius: 18px; box-shadow: 0 12px 30px rgba(15,23,42,0.06); }
    .hero { padding: 22px; }
    .eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #5f6f86; font-weight: 700; }
    h1 { margin: 10px 0 6px; font-size: 28px; letter-spacing: -0.04em; }
    p { margin: 0; color: #5f6f86; line-height: 1.5; }
    ul { list-style: none; display: grid; gap: 12px; margin: 0; padding: 0; }
    li { display: flex; flex-direction: column; gap: 4px; padding: 16px 18px; border-bottom: 1px solid rgba(15,23,42,0.08); }
    li:last-child { border-bottom: none; }
    strong { font-size: 15px; }
    span { color: #5f6f86; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="eyebrow">Busy Context</div>
      <h1>${title}</h1>
      <p>${subtitle}</p>
    </section>
    <section class="card">
      <ul>${itemMarkup}</ul>
    </section>
  </main>
</body>
</html>`;
}

function renderChromeFormPage(bootstrapStateUrl, reportStateUrl) {
  const template = fs.readFileSync(CHROME_FORM_TEMPLATE_PATH, 'utf8');
  return template.replace('__FORM_TEST_CONFIG__', serializeScriptValue({
    bootstrapStateUrl,
    reportStateUrl,
  }));
}

function buildManualWorkbenchDescriptor(testConfig) {
  const infoSurface = testConfig?.info?.surface || {};
  const sourceDocument = testConfig?.info?.document || {};
  const imageAssetPath = typeof sourceDocument.imageAssetPath === 'string' ? sourceDocument.imageAssetPath : '';

  return {
    id: testConfig.id,
    name: testConfig.name,
    formTitle: testConfig?.form?.title || testConfig?.form?.surface?.pageTitle || 'Form',
    workflow: testConfig?.form?.workflow || testConfig?.form?.surface?.workspaceLabel || 'Form tests',
    formPath: `/form/${testConfig.id}`,
    statusPath: `/api/tests/${testConfig.id}/status`,
    resetPath: `/api/tests/${testConfig.id}/reset`,
    taskInstruction: testConfig?.task?.instruction || '',
    metadata: {
      complexity: testConfig?.metadata?.complexity || 'unknown',
      sourceType: testConfig?.metadata?.sourceType || 'unknown',
      fieldsWithData: Number(testConfig?.metadata?.fieldsWithData) || 0,
      totalFields: Number(testConfig?.metadata?.totalFields) || (testConfig?.form?.fields || []).length,
      formThemeMode: testConfig?.metadata?.formThemeMode || testConfig?.form?.surface?.themeMode || 'light',
      formAccent: testConfig?.metadata?.formAccent || testConfig?.form?.surface?.accent || 'teal',
    },
    source: {
      appName: infoSurface.productName || testConfig?.info?.title || 'Source',
      badge: infoSurface.workspaceLabel || testConfig?.info?.sourceType || 'Source',
      title: sourceDocument.title || testConfig?.info?.title || 'Source document',
      subtitle: sourceDocument.subtitle || '',
      lines: buildSourceDocumentLines(sourceDocument),
      referenceLabel: testConfig?.metadata?.sourceReferenceLabel || '',
      referenceUrl: testConfig?.metadata?.sourceReferenceUrl || '',
      imageUrl: imageAssetPath ? `/assets/${testConfig.id}/${path.basename(imageAssetPath)}` : null,
    },
  };
}

function renderManualWorkbenchPage(workbenchConfig) {
  const template = fs.readFileSync(MANUAL_WORKBENCH_TEMPLATE_PATH, 'utf8');
  return template.replace('__FORM_TESTS_WORKBENCH_CONFIG__', serializeScriptValue(workbenchConfig));
}

function writeManualWorkbenchEvaluationArtifact(testConfig, taskState) {
  if (!taskState) {
    return null;
  }

  const evaluation = buildManualWorkbenchEvaluation(testConfig, taskState);
  writeTaskArtifact(testConfig.id, 'evaluation.json', `${JSON.stringify(evaluation, null, 2)}\n`);
  return evaluation;
}

async function startManualWorkbenchServer(tests, initialTestId = null) {
  if (!Array.isArray(tests) || tests.length === 0) {
    throw new Error('Manual workbench server requires at least one selected test.');
  }

  if (manualWorkbenchServer) {
    throw new Error('Manual workbench server is already running.');
  }

  const serverPort = await findAvailablePort(MANUAL_WORKBENCH_SERVER_PORT_START, MANUAL_WORKBENCH_SERVER_PORT_END);
  const origin = `http://127.0.0.1:${serverPort}`;
  const testsById = new Map(tests.map((testConfig) => [testConfig.id, testConfig]));
  const sessionsById = new Map(tests.map((testConfig) => [testConfig.id, createManualWorkbenchSession(testConfig)]));
  const noStoreHeaders = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store',
  };

  function getSession(testId) {
    const testConfig = testsById.get(testId);
    const session = sessionsById.get(testId);
    if (!testConfig || !session) {
      return null;
    }
    return { testConfig, session };
  }

  function getSessionBySessionId(sessionId) {
    for (const testConfig of tests) {
      const session = sessionsById.get(testConfig.id);
      if (session && session.sessionId === sessionId) {
        return { testConfig, session };
      }
    }
    return null;
  }

  function respondJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...noStoreHeaders });
    res.end(JSON.stringify(payload));
  }

  function respondHtml(res, html) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noStoreHeaders });
    res.end(html);
  }

  function respondText(res, statusCode, text) {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8', ...noStoreHeaders });
    res.end(text);
  }

  function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.png') {
      return 'image/png';
    }
    if (ext === '.jpg' || ext === '.jpeg') {
      return 'image/jpeg';
    }
    if (ext === '.webp') {
      return 'image/webp';
    }
    if (ext === '.gif') {
      return 'image/gif';
    }
    return 'application/octet-stream';
  }

  const resolvedInitialTestId = (
    initialTestId && testsById.has(initialTestId)
      ? initialTestId
      : tests[0].id
  );

  const workbenchConfig = {
    initialTestId: resolvedInitialTestId,
    appHint: '`pnpm run dev:local`',
    tests: tests.map((testConfig) => buildManualWorkbenchDescriptor(testConfig)),
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url || '/', origin);
      const pathname = requestUrl.pathname;

      if (pathname === '/' || pathname === '/manual') {
        respondHtml(res, renderManualWorkbenchPage(workbenchConfig));
        return;
      }

      const formMatch = pathname.match(/^\/form\/([^/]+)$/);
      if (formMatch) {
        const testId = decodeURIComponent(formMatch[1]);
        const entry = getSession(testId);
        if (!entry) {
          respondText(res, 404, 'Unknown form test.');
          return;
        }
        respondHtml(
          res,
          renderChromeFormPage(
            `${origin}/bootstrap-state/${entry.testConfig.id}`,
            `${origin}/session-state`,
          ),
        );
        return;
      }

      const bootstrapMatch = pathname.match(/^\/bootstrap-state\/([^/]+)$/);
      if (bootstrapMatch && req.method === 'GET') {
        const testId = decodeURIComponent(bootstrapMatch[1]);
        const entry = getSession(testId);
        if (!entry) {
          respondJson(res, 404, { error: 'Unknown form test.' });
          return;
        }

        respondJson(res, 200, {
          sessionId: entry.session.sessionId,
          stateRequestId: entry.session.stateRequestId,
          closeRequested: false,
          formConfig: buildChromeSurfaceFormConfig(entry.testConfig, { includeSourceDocument: false }),
        });
        return;
      }

      if (pathname === '/session-state' && req.method === 'POST') {
        const payload = await readJsonRequestBody(req);
        const entry = getSessionBySessionId(payload?.sessionId);
        if (!entry) {
          respondJson(res, 200, { ok: true, stale: true });
          return;
        }

        if (payload?.sessionId === entry.session.sessionId) {
          entry.session.latestTaskState = payload.taskState || null;
          entry.session.latestPageDebugSnapshot = payload.pageDebugSnapshot || null;
          entry.session.latestReportedStateRequestId = Number(payload.stateRequestId) || 0;
          entry.session.updatedAt = Date.now();

          if (Array.isArray(payload.pageDebugEvents) && payload.pageDebugEvents.length > 0) {
            const seenSeqs = new Set(entry.session.latestPageDebugEvents.map((event) => event.seq));
            for (const event of payload.pageDebugEvents) {
              if (!event || typeof event !== 'object' || seenSeqs.has(event.seq)) {
                continue;
              }
              entry.session.latestPageDebugEvents.push(event);
              seenSeqs.add(event.seq);
            }
            if (entry.session.latestPageDebugEvents.length > 4000) {
              entry.session.latestPageDebugEvents = entry.session.latestPageDebugEvents.slice(-4000);
            }
          }

          if (entry.session.latestTaskState) {
            entry.session.latestTaskState.debug = {
              ...(entry.session.latestTaskState.debug || {}),
              ...(entry.session.latestPageDebugSnapshot || {}),
              jsEvents: entry.session.latestPageDebugEvents.slice(),
            };
            if (entry.session.latestPageErrors.length > 0) {
              entry.session.latestTaskState.debug.pageErrors = entry.session.latestPageErrors.slice();
            }
            writeLiveChromeSurfaceArtifacts(entry.testConfig.id, entry.session.latestTaskState);
            writeManualWorkbenchEvaluationArtifact(entry.testConfig, entry.session.latestTaskState);
          }
        }

        respondJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/session-state-error' && req.method === 'POST') {
        const payload = await readJsonRequestBody(req);
        const entry = getSessionBySessionId(payload?.sessionId);
        if (!entry) {
          respondJson(res, 200, { ok: true, stale: true });
          return;
        }

        if (payload?.sessionId === entry.session.sessionId) {
          entry.session.latestPageErrors.push({
            time: Date.now(),
            ...payload,
          });
          if (entry.session.latestPageErrors.length > 200) {
            entry.session.latestPageErrors = entry.session.latestPageErrors.slice(-200);
          }
          if (entry.session.latestTaskState) {
            entry.session.latestTaskState.debug = {
              ...(entry.session.latestTaskState.debug || {}),
              pageErrors: entry.session.latestPageErrors.slice(),
            };
            writeLiveChromeSurfaceArtifacts(entry.testConfig.id, entry.session.latestTaskState);
            writeManualWorkbenchEvaluationArtifact(entry.testConfig, entry.session.latestTaskState);
          }
        }

        respondJson(res, 200, { ok: true });
        return;
      }

      const statusMatch = pathname.match(/^\/api\/tests\/([^/]+)\/status$/);
      if (statusMatch && req.method === 'GET') {
        const testId = decodeURIComponent(statusMatch[1]);
        const entry = getSession(testId);
        if (!entry) {
          respondJson(res, 404, { error: 'Unknown form test.' });
          return;
        }
        respondJson(res, 200, buildManualWorkbenchStatus(entry.testConfig, entry.session));
        return;
      }

      const resetMatch = pathname.match(/^\/api\/tests\/([^/]+)\/reset$/);
      if (resetMatch && req.method === 'POST') {
        const testId = decodeURIComponent(resetMatch[1]);
        const entry = getSession(testId);
        if (!entry) {
          respondJson(res, 404, { error: 'Unknown form test.' });
          return;
        }
        resetManualWorkbenchSession(entry.session, entry.testConfig);
        respondJson(res, 200, buildManualWorkbenchStatus(entry.testConfig, entry.session));
        return;
      }

      const assetMatch = pathname.match(/^\/assets\/([^/]+)\/([^/]+)$/);
      if (assetMatch && req.method === 'GET') {
        const testId = decodeURIComponent(assetMatch[1]);
        const fileName = decodeURIComponent(assetMatch[2]);
        const entry = getSession(testId);
        if (!entry) {
          respondText(res, 404, 'Unknown form test.');
          return;
        }

        const imageAssetPath = entry.testConfig?.info?.document?.imageAssetPath;
        if (!imageAssetPath || path.basename(imageAssetPath) !== fileName || !fs.existsSync(imageAssetPath)) {
          respondText(res, 404, 'Asset not found.');
          return;
        }

        res.writeHead(200, { 'Content-Type': getMimeType(imageAssetPath), ...noStoreHeaders });
        res.end(fs.readFileSync(imageAssetPath));
        return;
      }

      respondText(res, 404, 'Not Found');
    })().catch((error) => {
      respondJson(res, 500, { error: error.message });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(serverPort, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  manualWorkbenchServer = server;
  return { origin };
}

function getChromeBinaryPath() {
  const explicit = process.env.FORM_TESTS_CHROME_PATH || process.env.CHROME_PATH;
  if (explicit) {
    return explicit;
  }

  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }

  if (process.platform === 'linux') {
    return 'google-chrome';
  }

  throw new Error(`Chrome form mode is unsupported on platform: ${process.platform}`);
}

function createElectronFormSurfaceSession(testConfig) {
  return new Promise((resolve, reject) => {
    const electronBinary = getElectronBinary();
    const scriptPath = path.join(__dirname, 'test-form-windows.cjs');
    const serializedConfig = JSON.stringify(testConfig);
    const inlineSourceFieldIds = getInlineSourceFieldIds(testConfig);
    let captureTaskState = false;
    let taskStateLines = [];
    let latestTaskState = null;
    let captureFormCrop = false;
    let formCropLines = [];
    let latestFormCrop = null;
    let captureWindowBounds = false;
    let windowBoundsLines = [];
    let latestWindowBounds = null;
    let submitted = false;
    let stdoutBuffer = '';
    let childReady = false;
    let readyResolve;
    let readyReject;
    const readyPromise = new Promise((resolveReady, rejectReady) => {
      readyResolve = resolveReady;
      readyReject = rejectReady;
    });
    const readyTimeout = setTimeout(() => {
      if (!childReady) {
        readyReject(new Error('Timed out waiting for form windows to become ready.'));
      }
    }, FORM_WINDOW_READY_TIMEOUT_MS);

    const child = spawn(electronBinary, [scriptPath, serializedConfig], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: process.env,
    });

    const sendFormWindowCommand = (command) => {
      if (child.connected) {
        child.send({ type: 'form-test-command', command });
        return;
      }
      child.stdin.write(`${command}\n`);
    };

    const processStdoutLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line) {
        return;
      }

      if (!captureTaskState && !captureFormCrop && !captureWindowBounds) {
        console.log(`[FormWindows] ${line}`);
      }

      if (line === '=== FORM SUBMITTED ===') {
        submitted = true;
        return;
      }

      if (line === '=== FORM WINDOWS READY ===') {
        childReady = true;
        clearTimeout(readyTimeout);
        readyResolve();
        return;
      }

      if (line === '=== TASK STATE ===') {
        captureTaskState = true;
        taskStateLines = [];
        return;
      }

      if (line === '=== FORM CROP ===') {
        captureFormCrop = true;
        formCropLines = [];
        return;
      }

      if (line === '=== FORM WINDOW BOUNDS ===') {
        captureWindowBounds = true;
        windowBoundsLines = [];
        return;
      }

      if (line === '=== END TASK STATE ===') {
        captureTaskState = false;
        latestTaskState = JSON.parse(taskStateLines.join('\n'));
        return;
      }

      if (line === '=== END FORM CROP ===') {
        captureFormCrop = false;
        latestFormCrop = JSON.parse(formCropLines.join('\n'));
        return;
      }

      if (line === '=== END FORM WINDOW BOUNDS ===') {
        captureWindowBounds = false;
        latestWindowBounds = JSON.parse(windowBoundsLines.join('\n'));
        return;
      }

      if (captureTaskState) {
        taskStateLines.push(rawLine);
        return;
      }

      if (captureFormCrop) {
        formCropLines.push(rawLine);
        return;
      }

      if (captureWindowBounds) {
        windowBoundsLines.push(rawLine);
        return;
      }
    };

    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      let newlineIndex = stdoutBuffer.search(/\r?\n/);
      while (newlineIndex !== -1) {
        const rawLine = stdoutBuffer.slice(0, newlineIndex);
        const newlineLength = stdoutBuffer[newlineIndex] === '\r' && stdoutBuffer[newlineIndex + 1] === '\n' ? 2 : 1;
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + newlineLength);
        processStdoutLine(rawLine);
        newlineIndex = stdoutBuffer.search(/\r?\n/);
      }
    });

    child.stdout.on('end', () => {
      if (stdoutBuffer.trim()) {
        processStdoutLine(stdoutBuffer);
      }
      stdoutBuffer = '';
    });

    child.stderr.on('data', (data) => {
      captureChildLogs('FormWindows', masterLogStream, data, true);
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(readyTimeout);
      if (!childReady) {
        readyReject(new Error(`Form windows exited before ready (code=${code ?? 'null'})`));
      }
      console.log(`[FormWindows] Exited with code ${code}`);
    });

    const session = normalizeFormSurfaceSession({
      kind: 'electron',
      async loadTest() {},
      async focus() {
        if (child.killed) {
          throw new Error('Form windows are not running');
        }
        sendFormWindowCommand('FOCUS_FORM_WINDOW');
      },
      async getTaskState() {
        latestTaskState = null;
        sendFormWindowCommand('GET_TASK_STATE');
        await waitForCondition('Task state capture', 5000, async () => latestTaskState || null);
        if (latestTaskState?.source) {
          latestTaskState.source.visibleFieldIds = Array.from(new Set([
            ...(latestTaskState.source.visibleFieldIds || []),
            ...inlineSourceFieldIds,
          ]));
        }
        return latestTaskState;
      },
      async captureFormCrop(bounds, padding = GUI_INSPECT_CROP_PADDING_DIP) {
        latestFormCrop = null;
        sendFormWindowCommand(`CAPTURE_FORM_CROP ${JSON.stringify({ bounds, padding })}`);
        await waitForCondition('Form crop capture', 5000, async () => latestFormCrop || null);
        return latestFormCrop;
      },
      async getWindowBounds() {
        latestWindowBounds = null;
        sendFormWindowCommand('GET_FORM_WINDOW_BOUNDS');
        await waitForCondition('Form window bounds capture', 5000, async () => latestWindowBounds || null);
        return latestWindowBounds;
      },
      isSubmitted() {
        return submitted;
      },
      async close() {
        if (!child.killed) {
          child.kill();
          await waitForChildExit(child);
        }
      },
    });

    readyPromise.then(() => resolve(session)).catch(reject);
  });
}

async function createChromeFormSurfaceSession(testConfig, options) {
  if (chromeFormSurfaceController) {
    await chromeFormSurfaceController.loadTest(testConfig);
    return chromeFormSurfaceController;
  }

  const usesSafariFormSurface = options.formSurface === 'safari';
  const chromeBinary = usesSafariFormSurface ? null : getChromeBinaryPath();
  if (!usesSafariFormSurface && path.isAbsolute(chromeBinary) && !fs.existsSync(chromeBinary)) {
    throw new Error(`Chrome binary not found at ${chromeBinary}. Set FORM_TESTS_CHROME_PATH to override it.`);
  }

  const serverPort = await findAvailablePort(CHROME_FORM_SERVER_PORT_START, CHROME_FORM_SERVER_PORT_END);
  const origin = `http://127.0.0.1:${serverPort}`;
  const runId = `form-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const formPathname = `/form/${runId}`;
  const stableFormPathname = `/form/${testConfig.id || 'current'}`;
  const currentFormPathname = '/form/current';
  const formUrl = `${origin}${formPathname}`;
  const bootstrapStateUrl = `${origin}/bootstrap-state`;
  const reportStateUrl = `${origin}/session-state`;
  const profileConfig = getChromeUserDataDir(options);
  const userDataDir = profileConfig.path;
  const usesExistingChromeApp = options.chromeProfile === 'normal' || usesSafariFormSurface;
  let currentSessionId = `form-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let currentTestConfig = testConfig;
  let latestTaskState = null;
  let latestTaskStateReceivedAt = 0;
  let latestPageDebugSnapshot = null;
  let latestPageDebugEvents = [];
  let latestPageErrors = [];
  let currentStateRequestId = 0;
  let latestReportedStateRequestId = 0;
  let closeRequested = false;
  let currentVisualProbe = null;
  const noStoreHeaders = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store',
  };
  const chromeServer = http.createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url || '/', origin);
      const pathname = requestUrl.pathname;

      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...noStoreHeaders });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (pathname === '/bootstrap-state' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...noStoreHeaders });
        res.end(JSON.stringify({
          sessionId: currentSessionId,
          stateRequestId: currentStateRequestId,
          closeRequested,
          visualProbe: currentVisualProbe,
          formConfig: currentTestConfig
            ? buildChromeSurfaceFormConfig(currentTestConfig, { includeSourceDocument: true })
            : null,
        }));
        return;
      }

      if (pathname === '/session-state' && req.method === 'POST') {
        const payload = await readJsonRequestBody(req);
        if (payload?.sessionId === currentSessionId) {
          latestTaskState = payload.taskState || null;
          if (payload.pageDebugSnapshot && typeof payload.pageDebugSnapshot === 'object') {
            latestPageDebugSnapshot = payload.pageDebugSnapshot;
          }
          if (Array.isArray(payload.pageDebugEvents) && payload.pageDebugEvents.length > 0) {
            const seenSeqs = new Set(latestPageDebugEvents.map((event) => event.seq));
            for (const event of payload.pageDebugEvents) {
              if (!event || typeof event !== 'object') {
                continue;
              }
              if (seenSeqs.has(event.seq)) {
                continue;
              }
              latestPageDebugEvents.push(event);
              seenSeqs.add(event.seq);
            }
            if (latestPageDebugEvents.length > 4000) {
              latestPageDebugEvents = latestPageDebugEvents.slice(-4000);
            }
          }
          if (latestTaskState) {
            latestTaskState.debug = {
              ...(latestTaskState.debug || {}),
              ...(latestPageDebugSnapshot || {}),
              jsEvents: latestPageDebugEvents.slice(),
            };
            if (latestPageErrors.length > 0) {
              latestTaskState.debug.pageErrors = latestPageErrors.slice();
            }
          }
          latestReportedStateRequestId = Number(payload.stateRequestId) || 0;
          latestTaskStateReceivedAt = Date.now();
          writeLiveChromeSurfaceArtifacts(currentTestConfig?.id, latestTaskState);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ...noStoreHeaders });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (pathname === '/session-state-error' && req.method === 'POST') {
        const payload = await readJsonRequestBody(req);
        if (payload?.sessionId === currentSessionId) {
          latestPageErrors.push({
            time: Date.now(),
            ...payload,
          });
          if (latestPageErrors.length > 200) {
            latestPageErrors = latestPageErrors.slice(-200);
          }
          console.error('[ChromeForm][PageError]', payload);
          if (latestTaskState) {
            latestTaskState.debug = {
              ...(latestTaskState.debug || {}),
              pageErrors: latestPageErrors.slice(),
            };
            writeLiveChromeSurfaceArtifacts(currentTestConfig?.id, latestTaskState);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ...noStoreHeaders });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (pathname === '/session-state' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...noStoreHeaders });
        res.end(JSON.stringify(latestTaskState || {}));
        return;
      }

      if (pathname === formPathname || pathname === stableFormPathname || pathname === currentFormPathname) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noStoreHeaders });
        res.end(renderChromeFormPage(bootstrapStateUrl, reportStateUrl));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    })().catch((error) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
  });

  await new Promise((resolve, reject) => {
    chromeServer.once('error', reject);
    chromeServer.listen(serverPort, '127.0.0.1', () => {
      chromeServer.off('error', reject);
      resolve();
    });
  });

  const bounds = testConfig.form || {};
  const browserWindowBounds = await resolveBrowserWindowBounds(bounds);
  const launchX = browserWindowBounds?.x ?? Math.max(0, Number(bounds.x) || 40);
  const launchY = browserWindowBounds?.y ?? Math.max(0, Number(bounds.y) || 40);
  const launchWidth = browserWindowBounds?.width ?? Math.max(900, Number(bounds.width) || 1180);
  const launchHeight = browserWindowBounds?.height ?? Math.max(720, Number(bounds.height) || 900);
  const chromeArgs = [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    `--window-position=${launchX},${launchY}`,
    `--window-size=${launchWidth},${launchHeight}`,
    formUrl,
  ];
  if (usesExistingChromeApp) {
    chromeArgs.splice(4, 0, '--profile-directory=Default');
  }

  let chromeProcess = null;
  if (usesSafariFormSurface) {
    await openSafariWindowByUrl(formUrl, bounds);
  } else if (usesExistingChromeApp) {
    await openChromeWindowByUrl(formUrl, bounds);
  } else {
    chromeProcess = spawn(chromeBinary, chromeArgs, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    chromeProcess.stdout.on('data', (data) => {
      captureChildLogs('ChromeForm', masterLogStream, data, false);
    });
    chromeProcess.stderr.on('data', (data) => {
      captureChildLogs('ChromeForm', masterLogStream, data, true);
    });
    chromeProcess.once('error', (error) => {
      console.error('[ChromeForm] Failed to start:', error);
    });
  }

  try {
    if (usesSafariFormSurface) {
      await waitForSafariTabByUrl(formUrl, 15000);
      await waitForActiveSafariTabByUrl(formUrl, 15000);
    } else {
      await waitForChromeTabByUrl(formUrl, 15000);
    }
    if (!usesSafariFormSurface && usesExistingChromeApp) {
      await waitForActiveChromeTabByUrl(formUrl, 15000);
    }

    let closed = false;
    const waitForFreshTaskState = async (label, timeoutMs) => {
      currentStateRequestId += 1;
      const requestedStateId = currentStateRequestId;
      try {
        await waitForCondition(label, timeoutMs, async () => {
          if (!latestTaskState) {
            return null;
          }
          if (latestReportedStateRequestId < requestedStateId) {
            return null;
          }
          return latestTaskState;
        });
        return latestTaskState;
      } catch (error) {
        const ageMs = latestTaskStateReceivedAt > 0 ? Date.now() - latestTaskStateReceivedAt : Number.POSITIVE_INFINITY;
        // Real browser tabs can get timer-throttled while the overlay is frontmost.
        // If we already have a recent state snapshot, prefer grading from that
        // rather than failing the whole run on a missing heartbeat tick.
        if (latestTaskState && ageMs <= 5000) {
          console.warn(`[ChromeForm] ${label} heartbeat timed out; using cached task state aged ${ageMs}ms`);
          return latestTaskState;
        }
        if (latestTaskState) {
          console.warn(`[ChromeForm] ${label} heartbeat timed out; using stale cached task state aged ${ageMs}ms`);
          return latestTaskState;
        }
        throw error;
      }
    };
    chromeFormSurfaceController = normalizeFormSurfaceSession({
      kind: usesSafariFormSurface ? 'safari' : 'chrome',
      async loadTest(nextTestConfig) {
        currentTestConfig = nextTestConfig;
        currentSessionId = `form-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        latestTaskState = null;
        latestTaskStateReceivedAt = 0;
        latestPageDebugSnapshot = null;
        latestPageDebugEvents = [];
        latestPageErrors = [];
        currentStateRequestId = 0;
        latestReportedStateRequestId = 0;
        closeRequested = false;
        currentVisualProbe = null;
        await this.focus();
        await waitForFreshTaskState('Chrome form state', 15000);
      },
      async focus() {
        if (usesSafariFormSurface) {
          await activateSafariTabByUrl(formUrl);
          await waitForActiveSafariTabByUrl(formUrl, 5000);
        } else {
          await activateChromeTabByUrl(formUrl);
          await waitForActiveChromeTabByUrl(formUrl, 5000);
        }
        await wait(300);
      },
      async getTaskState() {
        // Chrome throttles timers/network for background tabs. Reactivate the
        // real form tab before requesting a fresh state snapshot so the page
        // can observe the incremented state request id and report back.
        await this.focus();
        return waitForFreshTaskState('Chrome form state', 5000);
      },
      async setTargetVisualProbe(probe) {
        currentVisualProbe = probe;
        currentStateRequestId += 1;
        if (probe) {
          await waitForCondition('Chrome visual probe rendered', 5000, async () => {
            const state = await waitForFreshTaskState('Chrome visual probe state', 5000);
            return state?.debug?.visualProbe?.screenBounds ? state.debug.visualProbe : null;
          });
        }
      },
      async getWindowBounds() {
        await this.focus();
        return usesSafariFormSurface
          ? getActiveSafariWindowBounds()
          : getActiveChromeWindowBounds();
      },
      async isSubmittedAsync() {
        return Boolean(latestTaskState?.form?.submitted);
      },
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        closeRequested = true;
        await wait(250);

        if (usesSafariFormSurface) {
          try {
            await closeSafariTabByUrl(formUrl);
          } catch (error) {
            console.warn(`[SafariForm] Failed to close Safari form tab: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else if (usesExistingChromeApp) {
          try {
            await closeChromeTabByUrl(formUrl);
          } catch (error) {
            console.warn(`[ChromeForm] Failed to close Chrome form tab: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else if (chromeProcess) {
          await terminateChildProcess(chromeProcess, 'ChromeForm');
          await killProcessesContainingArg(`--user-data-dir=${userDataDir}`);
        }

        await new Promise((resolve) => {
          chromeServer.close(() => resolve());
        });

        if (profileConfig.temporary) {
          cleanupTemporaryDirectory(userDataDir);
        }
        chromeFormSurfaceController = null;
      },
    });
    await chromeFormSurfaceController.loadTest(testConfig);
    return chromeFormSurfaceController;
  } catch (error) {
    if (usesSafariFormSurface) {
      try {
        await closeSafariTabByUrl(formUrl);
      } catch {}
    } else if (usesExistingChromeApp) {
      try {
        await closeChromeTabByUrl(formUrl);
      } catch {}
    } else if (chromeProcess) {
      await terminateChildProcess(chromeProcess, 'ChromeForm', { force: true });
      await killProcessesContainingArg(`--user-data-dir=${userDataDir}`);
    }
    await new Promise((resolve) => {
      chromeServer.close(() => resolve());
    });
    if (profileConfig.temporary) {
      cleanupTemporaryDirectory(userDataDir);
    }
    chromeFormSurfaceController = null;
    throw error;
  }
}

async function createChromeLiveSurfaceSession(_testConfig, options) {
  const targetUrl = String(options.chromeLiveUrl || '').trim();
  if (!targetUrl) {
    throw new Error('Chrome live form mode requires --chrome-live-url <url>.');
  }
  if (options.chromeProfile !== 'normal') {
    throw new Error('Chrome live form mode requires --chrome-profile normal so it can reuse your existing Chrome app/tab.');
  }

  if (!chromeFormSurfaceController) {
    chromeFormSurfaceController = normalizeFormSurfaceSession({
      kind: 'chrome-live',
      async loadTest() {
        await this.focus();
      },
      async focus() {
        await activateChromeTabByUrl(targetUrl);
        await waitForActiveChromeTabByUrl(targetUrl, 5000);
        await wait(300);
      },
      async getTaskState() {
        await this.focus();
        return {
          form: {
            values: {},
            submitted: false,
            visibleFieldIds: [],
            visibleRequiredFieldIds: [],
            submitVisible: false,
          },
          source: {},
          liveUrl: targetUrl,
        };
      },
      async isSubmittedAsync() {
        return false;
      },
      async close() {
        chromeFormSurfaceController = null;
      },
    });
  }

  await waitForChromeTabByUrl(targetUrl, 15000);
  await waitForActiveChromeTabByUrl(targetUrl, 15000);
  await chromeFormSurfaceController.loadTest();
  return chromeFormSurfaceController;
}

async function spawnFormSurface(testConfig, options) {
  const effectiveFormSurface = resolveEffectiveFormSurface(testConfig, options);

  if (effectiveFormSurface === 'chrome' || effectiveFormSurface === 'safari') {
    formSurfaceSession = await createChromeFormSurfaceSession(testConfig, options);
    return;
  }

  if (effectiveFormSurface === 'chrome-live') {
    formSurfaceSession = await createChromeLiveSurfaceSession(testConfig, options);
    return;
  }

  formSurfaceSession = await createElectronFormSurfaceSession(testConfig);
}

async function closeFormSurfaceSession() {
  if (!formSurfaceSession) {
    return;
  }

  const session = formSurfaceSession;
  formSurfaceSession = null;
  if (session.kind === 'chrome' && chromeFormSurfaceController === session) {
    return;
  }
  await session.close();
}

async function captureContext(testId) {
  const payload = await sendDebugCommand('captureContext');
  const testOutputDir = createTestOutputDir(testId);
  fs.writeFileSync(path.join(testOutputDir, 'context.txt'), `${payload.formattedText}\n`);
  fs.writeFileSync(path.join(testOutputDir, 'context-elements.json'), `${JSON.stringify(payload.elements, null, 2)}\n`);
  if (payload.screenshotBase64) {
    fs.writeFileSync(path.join(testOutputDir, 'context-screenshot.png'), Buffer.from(payload.screenshotBase64, 'base64'));
  }
  console.log(`[Context] Saved ${payload.elementCount} elements for ${testId}`);
}

function formatAgentPerspectiveText(agentDebugContext) {
  return [
    'INITIAL USER TEXT',
    agentDebugContext.initialUserText || '',
    '',
    'LATEST STRUCTURED TEXT',
    agentDebugContext.latestStructuredText || '',
    '',
    'RUN STATUS',
    String(agentDebugContext.runStatus || ''),
    '',
    'RUN REASON',
    agentDebugContext.runReason || '',
    '',
    'FINAL TEXT',
    agentDebugContext.finalText || '',
    '',
  ].join('\n');
}

function formatAutomationTraceText(agentDebugContext) {
  const events = Array.isArray(agentDebugContext.automationDebugTrace)
    ? agentDebugContext.automationDebugTrace
    : [];

  const lines = ['AUTOMATION TRACE', ''];
  for (const event of events) {
    lines.push(`#${event.seq} @${event.timeMs} ${event.kind}`);
    for (const [key, value] of Object.entries(event.details || {})) {
      lines.push(`  ${key}: ${formatTraceScalar(value)}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function formatTranscriptTraceText(agentDebugContext) {
  const events = Array.isArray(agentDebugContext.transcriptDebugTrace)
    ? agentDebugContext.transcriptDebugTrace
    : [];

  const lines = [];
  let currentInstructions = null;
  let lastAssistantSignature = null;
  let lastToolSignature = null;

  for (const event of events) {
    if (event.kind === 'llm.request') {
      const instructions = event.payload && typeof event.payload.instructions === 'string'
        ? event.payload.instructions
        : null;
      if (instructions && instructions !== currentInstructions) {
        currentInstructions = instructions;
        lines.push('## SYSTEM', '', 'content: |');
        instructions.split('\n').forEach((line) => lines.push(`  ${line}`));
        lines.push('');
      }
      continue;
    }

    if (event.kind === 'conversation.message.append') {
      const payload = event.payload || {};
      if (payload.role === 'user' && typeof payload.content === 'string') {
        lines.push(`## USER | turn ${event.turn}`, '', 'content: |');
        payload.content.split('\n').forEach((line) => lines.push(`  ${line}`));
        lines.push('');
        continue;
      }

      if (payload.role === 'assistant') {
        const signature = JSON.stringify(payload.output ?? null);
        if (signature === lastAssistantSignature) {
          continue;
        }
        lastAssistantSignature = signature;
        lines.push(`## ASSISTANT | turn ${event.turn}`, '');
        const output = Array.isArray(payload.output) ? payload.output : [];
        output.forEach((item) => {
          lines.push(...formatAssistantTranscriptItem(item));
        });
        if (typeof payload.responseId === 'string' && payload.responseId) {
          lines.push(`responseId: ${payload.responseId}`);
        }
        lines.push('');
        continue;
      }

      if (payload.role === 'tool' && typeof payload.content === 'string') {
        const signature = JSON.stringify({
          name: payload.name || null,
          content: payload.content,
        });
        if (signature === lastToolSignature) {
          continue;
        }
        lastToolSignature = signature;
        lines.push(`## TOOL RESULT | turn ${event.turn}`, '', 'content: |');
        payload.content.split('\n').forEach((line) => lines.push(`  ${line}`));
        lines.push('');
        continue;
      }
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function formatAssistantTranscriptItem(item, indent = '') {
  if (!item || typeof item !== 'object') {
    return renderStructuredTranscriptValue(item, indent ? 1 : 0).split('\n');
  }

  const type = typeof item.type === 'string' ? item.type : 'item';
  const lines = [`- ${type}`];

  if (type === 'reasoning' && Array.isArray(item.content)) {
    const summaryTexts = item.content
      .map((entry) => (entry && typeof entry.text === 'string' ? entry.text : null))
      .filter(Boolean);
    if (summaryTexts.length > 0) {
      lines.push('  summary: |');
      summaryTexts.join('\n\n').split('\n').forEach((line) => lines.push(`    ${line}`));
    }
    return lines;
  }

  if (type === 'function_call') {
    if (typeof item.name === 'string') {
      lines.push(`  name: ${item.name}`);
    }
    if (typeof item.arguments === 'string') {
      lines.push('  arguments: |');
      item.arguments.split('\n').forEach((line) => lines.push(`    ${line}`));
    }
    return lines;
  }

  if (type === 'message' || type === 'output_text') {
    const text = typeof item.text === 'string'
      ? item.text
      : Array.isArray(item.content)
        ? item.content
            .map((entry) => (entry && typeof entry.text === 'string' ? entry.text : null))
            .filter(Boolean)
            .join('\n')
        : '';
    if (text) {
      lines.push('  text: |');
      text.split('\n').forEach((line) => lines.push(`    ${line}`));
    }
    return lines;
  }

  lines.push(...renderStructuredTranscriptValue(item, 1).split('\n'));
  return lines;
}

function formatTranscriptPayload(payload) {
  if (payload == null) {
    return '';
  }

  if (typeof payload !== 'object') {
    return renderStructuredTranscriptValue(payload);
  }

  return renderStructuredTranscriptValue(payload);
}

function renderTranscriptValue(value) {
  if (typeof value === 'string') {
    return ['```text', value, '```'].join('\n');
  }

  if (Array.isArray(value)) {
    return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
  }

  if (value && typeof value === 'object') {
    const stringEntries = Object.entries(value).filter(([, entryValue]) => typeof entryValue === 'string');
    if (stringEntries.length > 0 && Object.keys(value).every((key) => typeof value[key] === 'string' || value[key] == null)) {
      const parts = [];
      for (const [key, entryValue] of stringEntries) {
        if (!entryValue) {
          continue;
        }
        parts.push(`${humanizeTraceKey(key)}:`);
        parts.push(String(entryValue));
        parts.push('');
      }
      if (parts.length > 0) {
        return ['```text', parts.join('\n').trimEnd(), '```'].join('\n');
      }
    }
    return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
  }

  return formatMultilineScalar(value);
}

function renderStructuredTranscriptValue(value, depth = 0) {
  const indent = '  '.repeat(depth);

  if (value == null) {
    return `${indent}null`;
  }

  if (typeof value === 'string') {
    if (value.includes('\n')) {
      const body = value
        .split('\n')
        .map((line) => `${indent}  ${line}`)
        .join('\n');
      return `${indent}|\n${body}`;
    }
    return `${indent}${value}`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${indent}${String(value)}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indent}[]`;
    }

    return value.map((entry) => {
      if (entry == null || typeof entry === 'number' || typeof entry === 'boolean') {
        return `${indent}- ${String(entry)}`;
      }

      if (typeof entry === 'string') {
        if (entry.includes('\n')) {
          const body = entry
            .split('\n')
            .map((line) => `${indent}    ${line}`)
            .join('\n');
          return `${indent}- |\n${body}`;
        }
        return `${indent}- ${entry}`;
      }

      return `${indent}-\n${renderStructuredTranscriptValue(entry, depth + 1)}`;
    }).join('\n');
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return `${indent}{}`;
  }

  return entries.map(([key, entryValue]) => {
    if (entryValue == null || typeof entryValue === 'number' || typeof entryValue === 'boolean') {
      return `${indent}${key}: ${String(entryValue)}`;
    }

    if (typeof entryValue === 'string') {
      if (entryValue.includes('\n')) {
        const body = entryValue
          .split('\n')
          .map((line) => `${indent}  ${line}`)
          .join('\n');
        return `${indent}${key}: |\n${body}`;
      }
      return `${indent}${key}: ${entryValue}`;
    }

    return `${indent}${key}:\n${renderStructuredTranscriptValue(entryValue, depth + 1)}`;
  }).join('\n');
}

function humanizeTraceKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatMultilineScalar(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function formatTraceScalar(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function formatJsInteractionTrace(taskState) {
  const debug = taskState?.debug || {};
  const jsEvents = Array.isArray(debug.jsEvents) ? debug.jsEvents : [];
  const lines = [
    'FINAL PAGE DEBUG STATE',
    `activeElement: ${formatTraceScalar(debug.activeElement)}`,
    `selection: ${formatTraceScalar(debug.selection)}`,
    `openControls: ${formatTraceScalar(debug.openControls)}`,
    `visibleValues: ${formatTraceScalar(debug.visibleValues)}`,
    '',
    'JS EVENT TRACE',
  ];

  jsEvents.forEach((event) => {
    const header = `#${event.seq} @${event.timeMs}ms ${event.type}`;
    lines.push(header);

    Object.entries(event).forEach(([key, value]) => {
      if (key === 'seq' || key === 'timeMs' || key === 'type') {
        return;
      }
      lines.push(`  ${key}: ${formatTraceScalar(value)}`);
    });

    lines.push('');
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

function writeJsTraceArtifacts(testId, taskState) {
  const debug = taskState?.debug || {};
  if (!Array.isArray(debug.jsEvents) || debug.jsEvents.length === 0) {
    return;
  }

  writeTaskArtifact(testId, 'page-js-trace.json', `${JSON.stringify(debug, null, 2)}\n`);
  writeTaskArtifact(testId, 'page-js-trace.txt', formatJsInteractionTrace(taskState));
}

async function writeAgentPerspectiveArtifact(testId) {
  const agentDebugContext = await getAgentDebugContext();
  writeTaskArtifact(testId, 'final-agent-perspective.txt', formatAgentPerspectiveText(agentDebugContext));
  writeTaskArtifact(testId, 'final-agent-perspective.json', `${JSON.stringify(agentDebugContext, null, 2)}\n`);
  if (Array.isArray(agentDebugContext.automationDebugTrace) && agentDebugContext.automationDebugTrace.length > 0) {
    writeTaskArtifact(testId, 'automation-trace.txt', formatAutomationTraceText(agentDebugContext));
    writeTaskArtifact(testId, 'automation-trace.json', `${JSON.stringify(agentDebugContext.automationDebugTrace, null, 2)}\n`);
  }
  if (Array.isArray(agentDebugContext.transcriptDebugTrace) && agentDebugContext.transcriptDebugTrace.length > 0) {
    writeTaskArtifact(testId, 'conversation-history.txt', formatTranscriptTraceText(agentDebugContext));
    writeTaskArtifact(testId, 'conversation-history.json', `${JSON.stringify(agentDebugContext.transcriptDebugTrace, null, 2)}\n`);
  }
  return agentDebugContext;
}

function startAgentPerspectiveCheckpoint(testId, intervalMs = 500) {
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      await writeAgentPerspectiveArtifact(testId);
    } catch {}
    inFlight = false;
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  void tick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await tick();
    },
  };
}

async function captureNamedContextArtifact(testId, baseName) {
  const payload = await sendDebugCommand('captureContext');
  const testOutputDir = createTestOutputDir(testId);
  fs.writeFileSync(path.join(testOutputDir, `${baseName}.txt`), `${payload.formattedText}\n`);
  fs.writeFileSync(path.join(testOutputDir, `${baseName}-elements.json`), `${JSON.stringify(payload.elements, null, 2)}\n`);
  if (payload.screenshotBase64) {
    fs.writeFileSync(path.join(testOutputDir, `${baseName}.png`), Buffer.from(payload.screenshotBase64, 'base64'));
  }
  console.log(`[Context] Saved ${baseName} with ${payload.elementCount} elements for ${testId}`);
  return payload;
}

function isTitlebarChromeElement(element, scopeBounds) {
  const label = String(element?.label || element?.name || '').trim().toLowerCase();
  const role = String(element?.role || '');
  const bbox = element?.bbox || element?.bounds || null;
  const titlebarLabels = new Set([
    'close button',
    'minimize button',
    'full screen button',
    'zoom button',
  ]);
  if (titlebarLabels.has(label)) {
    return true;
  }
  if (!bbox || !scopeBounds) {
    return false;
  }
  const y = Number(bbox.y);
  const height = Number(bbox.height);
  return role === 'AXButton'
    && Number.isFinite(y)
    && Number.isFinite(height)
    && y < scopeBounds.y + 32
    && height <= 28;
}

function assertDragSelectionHasRealElements(elements, scopeBounds) {
  const list = Array.isArray(elements) ? elements : [];
  const realElements = list.filter((element) => !isTitlebarChromeElement(element, scopeBounds));
  if (realElements.length > 0) {
    return;
  }

  throw new Error(
    `Drag-selected region exposed only window chrome/titlebar elements. elementCount=${list.length} scopeBounds=${JSON.stringify(scopeBounds)}`,
  );
}

async function waitForWorldPinActive(label, timeoutMs = 5000) {
  return waitForOverlayState(label, timeoutMs, (overlayState) => (
    overlayState.mode !== 'idle'
    && overlayState.worldPinActive === true
    && overlayState.scopeBounds
  ));
}

function assertWorldPinnedReviewGeometry(overlayState) {
  if (!overlayState?.worldPinActive || !overlayState.scopeBounds) {
    return;
  }

  const scope = overlayState.scopeBounds;
  const actions = [
    overlayState.action,
    ...(Array.isArray(overlayState.ghosts) ? overlayState.ghosts : []),
  ].filter((action) => action?.hasBounds && action.bounds);
  const tolerance = 4;
  const failures = [];

  for (const action of actions) {
    const bounds = action.bounds;
    if (
      bounds.x < scope.x - tolerance
      || bounds.y < scope.y - tolerance
      || bounds.x + bounds.width > scope.x + scope.width + tolerance
      || bounds.y + bounds.height > scope.y + scope.height + tolerance
    ) {
      failures.push({
        id: action.id,
        type: action.type,
        description: action.description,
        bounds,
        scope,
      });
    }
  }

  if (failures.length > 0) {
    throw new Error(`World-pinned review geometry drifted outside the selected scope: ${JSON.stringify(failures)}`);
  }
}

async function waitForVisualProbePageBounds(testId, timeoutMs = 5000) {
  const state = await waitForCondition('Target visual probe page bounds', timeoutMs, async () => {
    const taskState = await formSurfaceSession.getTaskState();
    return taskState?.debug?.visualProbe?.screenBounds ? taskState : null;
  });
  const probe = state.debug.visualProbe;
  writeTaskArtifact(testId, 'overlay-visual-probe-page-state.json', `${JSON.stringify(probe, null, 2)}\n`);
  return probe;
}

async function captureVisualProbeDesktopArtifact(testId, label, expectedBounds) {
  const cropDip = expandBounds(expectedBounds, 32, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const buffer = await captureCompositedPng(cropDip);
  const testOutputDir = createTestOutputDir(testId);
  fs.writeFileSync(path.join(testOutputDir, `overlay-visual-probe-${label}.png`), buffer);
  const png = PNG.sync.read(buffer);
  const scaleX = png.width / cropDip.width;
  const scaleY = png.height / cropDip.height;
  return {
    png,
    localExpectedBounds: {
      x: Math.round((expectedBounds.x - cropDip.x) * scaleX),
      y: Math.round((expectedBounds.y - cropDip.y) * scaleY),
      width: Math.round(expectedBounds.width * scaleX),
      height: Math.round(expectedBounds.height * scaleY),
    },
    cropDip,
    scaleX,
    scaleY,
  };
}

async function assertOverlayProbeCoversTargetOnDesktop(testId, label, expectedBounds, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastStats = null;
  let lastOverlayBounds = null;
  let lastOverlayError = null;
  while (Date.now() < deadline) {
    const capture = await captureVisualProbeDesktopArtifact(testId, label, expectedBounds);
    lastStats = probePixelStats(capture.png, capture.localExpectedBounds, 12);
    try {
      lastOverlayBounds = findProbeBounds(capture.png, 'overlay', capture.localExpectedBounds, 48);
      lastOverlayError = null;
    } catch (error) {
      lastOverlayBounds = null;
      lastOverlayError = error instanceof Error ? error.message : String(error);
    }
    if (overlayProbeCoversTarget(lastStats)) {
      writeTaskArtifact(testId, `overlay-visual-probe-${label}.json`, `${JSON.stringify({
        label,
        expectedBounds,
        localExpectedBounds: capture.localExpectedBounds,
        cropDip: capture.cropDip,
        scale: { x: capture.scaleX, y: capture.scaleY },
        stats: lastStats,
        overlayBounds: lastOverlayBounds,
      }, null, 2)}\n`);
      return { stats: lastStats, overlayBounds: lastOverlayBounds };
    }
    await wait(250);
  }
  throw new Error(
    `Overlay visual probe did not cover target at ${label}; bounds=${JSON.stringify(expectedBounds)} stats=${JSON.stringify(lastStats)} overlayBounds=${JSON.stringify(lastOverlayBounds)} overlayError=${lastOverlayError}`,
  );
}

async function setForegroundOccluderOverBounds(bounds) {
  const x = Math.max(40, Math.round(bounds.x - 32));
  const y = Math.max(40, Math.round(bounds.y - 76));
  const width = 420;
  const height = 360;
  const scriptLines = [
    'tell application "Calculator" to reopen',
    'tell application "Calculator" to activate',
    'delay 0.4',
    `tell application "System Events" to tell process "Calculator" to set position of window 1 to {${x}, ${y}}`,
    `tell application "System Events" to tell process "Calculator" to set size of window 1 to {${width}, ${height}}`,
    'tell application "System Events" to set frontmost of process "Calculator" to true',
    'delay 0.4',
  ];
  const result = await runProcessExit('osascript', scriptLines.flatMap((line) => ['-e', line]));
  if (result.code !== 0) {
    const message = result.stderr.trim() || 'Unknown AppleScript error';
    throw new Error(`Failed to place Calculator occluder: ${message}`);
  }
}

async function dismissForegroundOccluder() {
  const result = await runProcessExit('osascript', [
    '-e',
    'tell application "System Events" to if exists process "Calculator" then tell application "Calculator" to quit',
  ]);
  if (result.code !== 0) {
    console.warn(`[OverlayVisualProbe] Failed to quit Calculator: ${result.stderr.trim()}`);
  }
}

async function restoreFormSurfaceWindowBounds(bounds) {
  if (!bounds || !formSurfaceSession) {
    return;
  }
  if (formSurfaceSession.kind === 'safari') {
    await setActiveSafariWindowBounds(bounds);
  } else if (formSurfaceSession.kind === 'chrome') {
    await setActiveChromeWindowBounds(bounds);
  }
}

async function moveFormSurfaceWindowBy(dx, dy) {
  const currentBounds = await formSurfaceSession.getWindowBounds();
  if (!currentBounds) {
    throw new Error('Overlay visual probe requires target window bounds before movement.');
  }
  const desktopBounds = await getPrimaryDesktopBounds();
  const next = {
    ...currentBounds,
    x: currentBounds.x + dx,
    y: currentBounds.y + dy,
  };
  if (desktopBounds) {
    next.x = clamp(next.x, desktopBounds.x + 24, desktopBounds.x + desktopBounds.width - currentBounds.width - 24);
    next.y = clamp(next.y, Math.max(desktopBounds.y + 32, 32), desktopBounds.y + desktopBounds.height - currentBounds.height - 24);
  }
  if (formSurfaceSession.kind === 'safari') {
    await setActiveSafariWindowBounds(next);
  } else if (formSurfaceSession.kind === 'chrome') {
    await setActiveChromeWindowBounds(next);
  } else {
    throw new Error(`Overlay visual probe window movement is not implemented for ${formSurfaceSession.kind} form surfaces.`);
  }
  await wait(700);
  return { before: currentBounds, after: next };
}

async function runOverlayVisualProbeFlow(testConfig) {
  if (process.platform !== 'darwin') {
    throw new Error('--overlay-visual-probe currently runs on macOS/Tahoe only. Windows uses demo:overlay-form:win:visual.');
  }
  if (!formSurfaceSession || typeof formSurfaceSession.setTargetVisualProbe !== 'function') {
    throw new Error('--overlay-visual-probe requires the browser-backed form surface.');
  }

  const initialWindowBounds = await formSurfaceSession.getWindowBounds();
  let movement = null;
  let initialPageProbe = null;
  let movedPageProbe = null;
  try {
    await waitForWorldPinActive('World overlay pinned after drag-select for visual probe');
    const images = await makeOverlayVisualProbeImages();
    const targetProbe = {
      id: 'form-target-underlay-qr',
      label: 'Target visual probe',
      dataUrl: images.targetDataUrl,
      bounds: {
        x: 320,
        y: 205,
        width: 168,
        height: 168,
      },
    };
    await formSurfaceSession.setTargetVisualProbe(targetProbe);
    initialPageProbe = await waitForVisualProbePageBounds(testConfig.id);

    await sendDebugCommand('setVisualProbe', {
      probe: {
        id: 'react-world-overlay-qr',
        label: 'React world overlay visual probe',
        dataUrl: images.overlayDataUrl,
        bounds: initialPageProbe.screenBounds,
      },
    });
    await waitForCondition('World visual probe health', 5000, async () => {
      const debug = await getDebugStatus();
      const health = debug?.lastWorldVisualHealth;
      return health?.source === 'world' && health.hasDebugVisualProbe && health.debugVisualProbeBounds
        ? health
        : null;
    });
    await assertOverlayProbeCoversTargetOnDesktop(testConfig.id, 'initial', initialPageProbe.screenBounds);

    movement = await moveFormSurfaceWindowBy(-90, 0);
    movedPageProbe = await waitForVisualProbePageBounds(testConfig.id);
    const actualProbeMove = Math.max(
      Math.abs(movedPageProbe.screenBounds.x - initialPageProbe.screenBounds.x),
      Math.abs(movedPageProbe.screenBounds.y - initialPageProbe.screenBounds.y),
    );
    if (actualProbeMove < 40) {
      throw new Error(
        `Overlay visual probe target window did not move enough to prove pin tracking; movement=${JSON.stringify(movement)} initial=${JSON.stringify(initialPageProbe.screenBounds)} moved=${JSON.stringify(movedPageProbe.screenBounds)}`,
      );
    }
    await assertOverlayProbeCoversTargetOnDesktop(testConfig.id, 'moved', movedPageProbe.screenBounds);

    await setForegroundOccluderOverBounds(movedPageProbe.screenBounds);
    await wait(900);
    const occludedCapture = await captureVisualProbeDesktopArtifact(testConfig.id, 'occluded', movedPageProbe.screenBounds);
    const occludedStats = probePixelStats(occludedCapture.png, occludedCapture.localExpectedBounds, 12);
    assertOverlayProbeOccluded(occludedStats, 'occluded', movedPageProbe.screenBounds);
    writeTaskArtifact(testConfig.id, 'overlay-visual-probe-occluded.json', `${JSON.stringify({
      expectedBounds: movedPageProbe.screenBounds,
      stats: occludedStats,
    }, null, 2)}\n`);

    writeTaskArtifact(testConfig.id, 'overlay-visual-probe-summary.json', `${JSON.stringify({
      initialWindowBounds,
      movement,
      initialPageProbe,
      movedPageProbe,
    }, null, 2)}\n`);
  } finally {
    await dismissForegroundOccluder();
    await restoreFormSurfaceWindowBounds(initialWindowBounds ?? movement?.before);
    await wait(600);
    await formSurfaceSession.focus();
    await formSurfaceSession.setTargetVisualProbe(null);
    await sendDebugCommand('setVisualProbe', { probe: null });
  }
}

async function captureReviewArtifacts(testId, reviewCount, overlayState, phase = 'review', focusBounds = null) {
  const payload = await sendDebugCommand('captureDebugSnapshot');
  const testOutputDir = createTestOutputDir(testId);
  const suffix = `${String(reviewCount).padStart(2, '0')}-${phase}`;
  const actionBounds = focusBounds ?? overlayState?.action?.bounds ?? null;

  fs.writeFileSync(
    path.join(testOutputDir, `gui-inspect-review-${suffix}-overlay-state.json`),
    `${JSON.stringify(overlayState, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(testOutputDir, `gui-inspect-review-${suffix}-context.txt`),
    `${payload.formattedText}\n`,
  );
  fs.writeFileSync(
    path.join(testOutputDir, `gui-inspect-review-${suffix}-elements.json`),
    `${JSON.stringify(payload.elements, null, 2)}\n`,
  );
  if (payload.screenshotBase64) {
    const screenshotBuffer = Buffer.from(payload.screenshotBase64, 'base64');
    fs.writeFileSync(
      path.join(testOutputDir, `gui-inspect-review-${suffix}-screenshot.png`),
      screenshotBuffer,
    );

    if (actionBounds && payload.displayBoundsDIP) {
      const estimatedPillBounds = estimateAttachedPillBounds(actionBounds, overlayState, payload.displayBoundsDIP);
      const focusBoundsForCrop = unionBounds(actionBounds, estimatedPillBounds);
      const afterCropDip = expandBounds(
        focusBoundsForCrop,
        GUI_INSPECT_CROP_PADDING_DIP,
        payload.displayBoundsDIP.width,
        payload.displayBoundsDIP.height,
      );
      const fullPng = PNG.sync.read(screenshotBuffer);
      const scaleX = fullPng.width / payload.displayBoundsDIP.width;
      const scaleY = fullPng.height / payload.displayBoundsDIP.height;
      const afterCropPxX = clamp(Math.floor(afterCropDip.x * scaleX), 0, Math.max(0, fullPng.width - 1));
      const afterCropPxY = clamp(Math.floor(afterCropDip.y * scaleY), 0, Math.max(0, fullPng.height - 1));
      const afterCropPxRight = clamp(Math.ceil((afterCropDip.x + afterCropDip.width) * scaleX), afterCropPxX + 1, fullPng.width);
      const afterCropPxBottom = clamp(Math.ceil((afterCropDip.y + afterCropDip.height) * scaleY), afterCropPxY + 1, fullPng.height);
      const afterCropPx = {
        x: afterCropPxX,
        y: afterCropPxY,
        width: afterCropPxRight - afterCropPxX,
        height: afterCropPxBottom - afterCropPxY,
      };
      const croppedAfter = await captureCompositedRegionPng(afterCropDip);
      fs.writeFileSync(
        path.join(testOutputDir, `gui-inspect-review-${suffix}-after-crop.png`),
        croppedAfter,
      );
      fs.writeFileSync(
        path.join(testOutputDir, `gui-inspect-review-${suffix}-crop-metadata.json`),
        `${JSON.stringify({ beforeDip: afterCropDip, afterPx: afterCropPx, source: 'macos-compositor' }, null, 2)}\n`,
      );
    }
  }

  if (actionBounds && typeof formSurfaceSession?.captureFormCrop === 'function') {
    const formCrop = await formSurfaceSession.captureFormCrop(actionBounds, GUI_INSPECT_CROP_PADDING_DIP);
    if (formCrop?.pngBase64) {
      fs.writeFileSync(
        path.join(testOutputDir, `gui-inspect-review-${suffix}-before-crop.png`),
        Buffer.from(formCrop.pngBase64, 'base64'),
      );
    }
  }

  console.log(
    `[GUI Inspect] Saved type-review artifacts for ${testId} as gui-inspect-review-${suffix}-*`,
  );
}

async function captureInputArtifacts(testId, overlayState, phase = 'typed') {
  const payload = await sendDebugCommand('captureDebugSnapshot');
  const testOutputDir = createTestOutputDir(testId);
  const suffix = `input-${phase}`;

  fs.writeFileSync(
    path.join(testOutputDir, `gui-inspect-${suffix}-overlay-state.json`),
    `${JSON.stringify(overlayState, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(testOutputDir, `gui-inspect-${suffix}-context.txt`),
    `${payload.formattedText}\n`,
  );
  fs.writeFileSync(
    path.join(testOutputDir, `gui-inspect-${suffix}-elements.json`),
    `${JSON.stringify(payload.elements, null, 2)}\n`,
  );
  if (payload.screenshotBase64) {
    const screenshotBuffer = Buffer.from(payload.screenshotBase64, 'base64');
    fs.writeFileSync(
      path.join(testOutputDir, `gui-inspect-${suffix}-screenshot.png`),
      screenshotBuffer,
    );

    if (payload.displayBoundsDIP) {
      const cropDip = getGuiInspectInputCrop(payload.displayBoundsDIP);
      const fullPng = PNG.sync.read(screenshotBuffer);
      const scaleX = fullPng.width / payload.displayBoundsDIP.width;
      const scaleY = fullPng.height / payload.displayBoundsDIP.height;
      const cropPxX = clamp(Math.floor(cropDip.x * scaleX), 0, Math.max(0, fullPng.width - 1));
      const cropPxY = clamp(Math.floor(cropDip.y * scaleY), 0, Math.max(0, fullPng.height - 1));
      const cropPxRight = clamp(Math.ceil((cropDip.x + cropDip.width) * scaleX), cropPxX + 1, fullPng.width);
      const cropPxBottom = clamp(Math.ceil((cropDip.y + cropDip.height) * scaleY), cropPxY + 1, fullPng.height);
      const cropPx = {
        x: cropPxX,
        y: cropPxY,
        width: cropPxRight - cropPxX,
        height: cropPxBottom - cropPxY,
      };
      const croppedAfter = await captureCompositedRegionPng(cropDip);
      fs.writeFileSync(
        path.join(testOutputDir, `gui-inspect-${suffix}-after-crop.png`),
        croppedAfter,
      );
      fs.writeFileSync(
        path.join(testOutputDir, `gui-inspect-${suffix}-crop-metadata.json`),
        `${JSON.stringify({ cropDip, cropPx, source: 'macos-compositor' }, null, 2)}\n`,
      );
    }
  }

  console.log(`[GUI Inspect] Saved input artifacts for ${testId} as gui-inspect-${suffix}-*`);
}

async function runTest(testConfig, options, index, total) {
  console.log('');
  console.log('========================================');
  console.log(`Test ${index + 1}/${total}: ${testConfig.name}`);
  console.log(`ID: ${testConfig.id}`);
  console.log('========================================');

  const startedAt = Date.now();
  resetTestOutputDir(testConfig.id);
  let agentPerspectiveWritten = false;
  let agentPerspectiveCheckpoint = null;
  let screenRecording = null;

  try {
    cleanupExpectedWorkspaceArtifact(testConfig);
    await spawnFormSurface(testConfig, options);
    agentPerspectiveCheckpoint = startAgentPerspectiveCheckpoint(testConfig.id);
    writeTaskArtifact(testConfig.id, 'runner-prompt.txt', `${buildRunnerPrompt(testConfig, options)}\n`);
    writeTaskArtifact(testConfig.id, 'runner-system-addendum.txt', `${buildRunnerSystemAddendum(testConfig, options)}\n`);
    await focusFormSurface();
    await captureContext(testConfig.id);
    const initialTaskState = await formSurfaceSession.getTaskState();
    writeTaskArtifact(testConfig.id, 'initial-task-state.json', `${JSON.stringify(initialTaskState, null, 2)}\n`);
    screenRecording = await startTestScreenRecording(testConfig.id, options);

    let realFlowResult = null;
    if (options.mode === 'debug') {
      await Promise.race([
        sendDebugCommand('executeAgent', {
          prompt: buildRunnerPrompt(testConfig, options),
          systemAddendum: buildRunnerSystemAddendum(testConfig, options),
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Agent timeout after ${options.timeoutMs}ms`)), options.timeoutMs);
        }),
      ]);
    } else {
      realFlowResult = await runRealInteractionFlow(testConfig, options);
    }

    await wait(2000);
    await writeAgentPerspectiveArtifact(testConfig.id);
    agentPerspectiveWritten = true;
    if (shouldRunOverlayLaunchSmoke(testConfig, options)) {
      if (realFlowResult?.runStatus === 'completed') {
        await assertOverlayRemainsDismissedAfterRun(testConfig.id);
        assertOverlayAgentToolLifecycle(testConfig);
      }
      const duration = ((Date.now() - startedAt) / 1000).toFixed(2);
      const passed = realFlowResult?.runStatus === 'completed';
      const evaluation = {
        correct: passed ? 1 : 0,
        incorrect: passed ? 0 : 1,
        total: 1,
        details: [
          'Overlay launch smoke validates normal-agent handoff only.',
          `runStatus=${realFlowResult?.runStatus ?? 'unknown'}`,
          ...(realFlowResult?.runReason ? [`runReason=${realFlowResult.runReason}`] : []),
          ...(realFlowResult?.finalText ? [`finalText=${realFlowResult.finalText}`] : []),
        ],
        submitted: false,
      };
      writeTaskArtifact(testConfig.id, 'evaluation.json', `${JSON.stringify(evaluation, null, 2)}\n`);
      testResults.push({
        id: testConfig.id,
        name: `${testConfig.name} [Overlay Launch Smoke]`,
        passed,
        duration,
        evaluation,
        submitted: false,
      });

      if (passed) {
        console.log(`✓ PASS ${testConfig.id} overlay launch smoke (${duration}s)`);
      } else {
        console.log(`✗ FAIL ${testConfig.id} overlay launch smoke (${duration}s)`);
        for (const detail of evaluation.details) {
          console.log(`  ${detail}`);
        }
      }

      return passed;
    }

    if (options.formSurface === 'chrome-live') {
      await captureNamedContextArtifact(testConfig.id, 'final-context');
      const duration = ((Date.now() - startedAt) / 1000).toFixed(2);
      const evaluation = {
        correct: realFlowResult?.runStatus === 'completed' ? 1 : 0,
        incorrect: realFlowResult?.runStatus === 'completed' ? 0 : 1,
        total: 1,
        details: [
          `Live Chrome URL: ${options.chromeLiveUrl}`,
          `runStatus=${realFlowResult?.runStatus ?? 'unknown'}`,
          ...(realFlowResult?.runReason ? [`runReason=${realFlowResult.runReason}`] : []),
          ...(realFlowResult?.finalText ? [`finalText=${realFlowResult.finalText}`] : []),
        ],
        submitted: false,
      };
      const passed = evaluation.incorrect === 0;
      writeTaskArtifact(testConfig.id, 'evaluation.json', `${JSON.stringify(evaluation, null, 2)}\n`);
      testResults.push({
        id: testConfig.id,
        name: `${testConfig.name} [Live Chrome]`,
        passed,
        duration,
        evaluation,
        submitted: false,
      });

      if (passed) {
        console.log(`✓ PASS ${testConfig.id} live Chrome (${duration}s)`);
      } else {
        console.log(`✗ FAIL ${testConfig.id} live Chrome (${duration}s)`);
        for (const detail of evaluation.details) {
          console.log(`  ${detail}`);
        }
      }

      return passed;
    }

    const taskState = await formSurfaceSession.getTaskState();
    writeTaskArtifact(testConfig.id, 'task-state.json', `${JSON.stringify(taskState, null, 2)}\n`);
    writeJsTraceArtifacts(testConfig.id, taskState);
    if (options.escOnReview !== null) {
      const overlayState = await getOverlayState();
      const aborted = Boolean(realFlowResult && realFlowResult.abortedByEsc);
      const idle = overlayState.mode === 'idle';
      const submitted = Boolean(taskState?.form?.submitted);
      const passed = aborted && idle && !submitted;
      const evaluation = {
        correct: passed ? 1 : 0,
        incorrect: passed ? 0 : 1,
        total: 1,
        details: passed ? [] : [`Expected Esc on review ${options.escOnReview} to abort the loop. aborted=${aborted} idle=${idle} submitted=${submitted}`],
        submitted,
      };
      writeTaskArtifact(testConfig.id, 'evaluation.json', `${JSON.stringify(evaluation, null, 2)}\n`);
      const duration = ((Date.now() - startedAt) / 1000).toFixed(2);

      testResults.push({
        id: testConfig.id,
        name: `${testConfig.name} [Esc Abort]`,
        passed,
        duration,
        evaluation,
        submitted,
      });

      if (passed) {
        console.log(`✓ PASS ${testConfig.id} Esc abort (${duration}s)`);
      } else {
        console.log(`✗ FAIL ${testConfig.id} Esc abort (${duration}s)`);
        for (const detail of evaluation.details) {
          console.log(`  ${detail}`);
        }
      }

      return passed;
    }

    const evaluation = testConfig?.task?.gradingMode === 'workspace-artifact'
      ? evaluateWorkspaceArtifactTask(testConfig, initialTaskState, taskState)
      : evaluateTask(testConfig, {
          ...taskState,
          source: initialTaskState?.source || taskState?.source,
        });
    writeTaskArtifact(testConfig.id, 'evaluation.json', `${JSON.stringify(evaluation, null, 2)}\n`);
    const passed = evaluation.incorrect === 0;
    const duration = ((Date.now() - startedAt) / 1000).toFixed(2);

    testResults.push({
      id: testConfig.id,
      name: testConfig.name,
      passed,
      duration,
      evaluation,
      submitted: evaluation.submitted,
    });

    if (passed) {
      console.log(`✓ PASS ${testConfig.id} (${duration}s)`);
    } else {
      console.log(`✗ FAIL ${testConfig.id} (${duration}s)`);
      for (const detail of evaluation.details) {
        console.log(`  ${detail}`);
      }
    }

    return passed;
  } catch (error) {
    if (!agentPerspectiveWritten) {
      try {
        await writeAgentPerspectiveArtifact(testConfig.id);
        agentPerspectiveWritten = true;
      } catch (artifactError) {
        console.warn(`[Artifacts] Failed to write agent transcript for ${testConfig.id}: ${artifactError.message}`);
      }
    }
    const duration = ((Date.now() - startedAt) / 1000).toFixed(2);
    testResults.push({
      id: testConfig.id,
      name: testConfig.name,
      passed: false,
      duration,
      evaluation: { correct: 0, incorrect: 0, total: 0, details: [error.message] },
      submitted: false,
    });
    console.error(`✗ ERROR ${testConfig.id}: ${error.message}`);
    return false;
  } finally {
    if (agentPerspectiveCheckpoint) {
      await agentPerspectiveCheckpoint.stop();
    }
    if (screenRecording) {
      try {
        await stopTestScreenRecording(screenRecording);
      } catch (error) {
        console.warn(`[Recording] Failed to finalize ${testConfig.id}: ${error.message}`);
      }
    }
    if (!agentPerspectiveWritten) {
      try {
        await writeAgentPerspectiveArtifact(testConfig.id);
      } catch {}
    }
    await closeFormSurfaceSession();
  }
}

function printResults() {
  console.log('');
  console.log('========================================');
  console.log('Form Tests Summary');
  console.log('========================================');
  const passedCount = testResults.filter((result) => result.passed).length;
  for (const result of testResults) {
    console.log(`${result.passed ? '✅' : '❌'} ${result.id} ${result.name} (${result.duration}s)`);
    if (!result.passed) {
      for (const detail of result.evaluation.details.slice(0, 5)) {
        console.log(`   ${detail}`);
      }
    }
  }
  console.log('');
  console.log(`Passed ${passedCount}/${testResults.length}`);
  console.log(`Master log: ${masterLogPath}`);
  console.log(`App log: ${appLogPath}`);
}

async function cleanup(options = {}) {
  if (cleanupPromise) {
    return cleanupPromise;
  }

  cleanupPromise = (async () => {
    emergencyAbortMonitor?.stop();

    await Promise.race([
      (async () => {
        if (appProcess) {
          const child = appProcess;
          appProcess = null;
          await terminateChildProcess(child, 'MainApp', { force: Boolean(options.emergency) });
        }

        await closeFormSurfaceSession();
        if (chromeFormSurfaceController) {
          const controller = chromeFormSurfaceController;
          chromeFormSurfaceController = null;
          await controller.close();
        }

        if (manualWorkbenchServer) {
          const server = manualWorkbenchServer;
          manualWorkbenchServer = null;
          await new Promise((resolve) => {
            server.close(() => resolve());
          });
        }

        await stopManagedLocalApi();

        const currentAppLogStream = appLogStream;
        appLogStream = null;
        await waitForStreamFinish(currentAppLogStream);

        const currentMasterLogStream = masterLogStream;
        masterLogStream = null;
        await waitForStreamFinish(currentMasterLogStream);
      })(),
      wait(CLEANUP_TIMEOUT_MS).then(() => {
        throw new Error(`Cleanup timed out after ${CLEANUP_TIMEOUT_MS}ms`);
      }),
    ]);
  })();

  return cleanupPromise;
}

async function main() {
  const options = parseArgs();
  setupLogging();
  if (options.skipBuild) {
    printSkipBuildWarning('start');
  }

  try {
    if (options.manual && options.manualServer) {
      throw new Error('--manual and --manual-server are separate modes. Choose one.');
    }

    if (options.guiInspect && options.mode !== 'real') {
      throw new Error('GUI inspection mode only supports --mode real. It is intentionally separate from the debug/perf paths.');
    }

    if (options.dragSelectForm && options.mode !== 'real') {
      throw new Error('--drag-select-form only supports --mode real.');
    }

    if (options.overlayLaunchSmoke && options.mode !== 'real') {
      throw new Error('--overlay-launch-smoke only supports --mode real.');
    }

    if ((options.formSurface === 'chrome' || options.formSurface === 'safari' || options.formSurface === 'chrome-live') && options.mode !== 'real') {
      throw new Error('Browser form tests must use --mode real so the harness literally drives Ctrl+Space and Ctrl approval.');
    }

    if (options.manual && options.formSurface !== 'chrome') {
      throw new Error('Manual mode currently supports the shared Chrome form surface only. Use --chrome-form --manual.');
    }

    if (options.apiMode === 'server' && options.reuseLocalApi) {
      throw new Error('--reuse-local-api cannot be combined with --server-api.');
    }

    const supportedCombination = (
      (options.formSurface === 'electron' && options.sourceContext === 'window')
      || (options.formSurface === 'chrome' && ['paste', 'window'].includes(options.sourceContext))
      || (options.formSurface === 'safari' && ['paste', 'window'].includes(options.sourceContext))
      || (options.formSurface === 'chrome-live' && options.sourceContext === 'paste')
    );
    if (!supportedCombination) {
      throw new Error('Supported combinations are electron+window (default), chrome/safari+paste/window, and chrome-live+paste (--chrome-live-url).');
    }

    if (!['temp', 'normal'].includes(options.chromeProfile)) {
      throw new Error('Chrome profile must be temp or normal.');
    }

    if (options.guiInspect && options.formSurface === 'chrome') {
      throw new Error('GUI inspection mode is not implemented for the Chrome form surface yet.');
    }

    if (options.dragSelectForm && !['electron', 'chrome', 'safari'].includes(options.formSurface)) {
      throw new Error('--drag-select-form currently supports electron, chrome, and safari form surfaces.');
    }

    if (options.overlayLaunchSmoke && options.formSurface !== 'electron') {
      throw new Error('--overlay-launch-smoke currently supports the default electron form surface only.');
    }

    if (options.formSurface === 'chrome-live' && !options.chromeLiveUrl) {
      throw new Error('Chrome live form mode requires --chrome-live-url <url>.');
    }

    if (options.guiInspect) {
      console.log('[GUI Inspect] Enabled. This mode writes screenshot artifacts with minimal settle waits.');
      console.log('[GUI Inspect] It is still slower than non-GUI runs because it captures screenshots, but it should no longer pause theatrically between actions.');
    }

    if (options.dragSelectForm) {
      console.log('[Drag Select] Enabled. The benchmark will stay in the normal graded flow, scope the overlay to the form via real mouse drag, and paste the source into the overlay input.');
    }
    if (options.dragSelectFormChaos) {
      console.log('[Drag Select Chaos] Enabled. The benchmark will dismiss/reopen the overlay, perform aggressive drag chaos, and assert the overlay never duplicates or resizes before the final form scope drag.');
    }

    if (options.formSurface === 'chrome') {
      console.log('[Chrome Form] Enabled. The benchmark will open a single real Chrome form tab and inline the source document into the prompt.');
      if (options.chromeProfile === 'normal') {
        console.log('[Chrome Form] Using the normal Chrome profile.');
      }
    }

    if (options.formSurface === 'chrome-live') {
      console.log(`[Chrome Live] Enabled. The benchmark will target the existing Chrome tab matching ${options.chromeLiveUrl}.`);
      console.log('[Chrome Live] It will not submit the live form and it will not close your checkout tab afterward.');
    }

    if (options.apiMode === 'server') {
      console.log('[API] Using hosted server path for benchmark runs.');
    }

    if (options.manualServer) {
      const tests = loadTests(null);
      if (tests.length === 0) {
        throw new Error('No tests available for the manual workbench server.');
      }
      const initialTestId = Array.isArray(options.testIds) && options.testIds.length > 0
        ? options.testIds[0]
        : tests[0].id;
      const server = await startManualWorkbenchServer(tests, initialTestId);
      const workbenchUrl = `${server.origin}/?test=${encodeURIComponent(initialTestId)}`;
      await openUrlInChrome(workbenchUrl);
      console.log(`[Manual Server] Form workbench available at ${server.origin}`);
      console.log(`[Manual Server] Opened ${workbenchUrl} in Chrome.`);
      console.log('[Manual Server] It only serves the browser harness. Run `pnpm run dev:local` separately for the app.');
      console.log('[Manual Server] Live task-state, JS traces, and evaluation artifacts update under form-tests/test-output/<test-id>/.');
      console.log('[Manual Server] Press Ctrl+C in this terminal when you are done.');
      await new Promise(() => {});
      return;
    }

    const tests = await loadTests(options.testIds);
    if (tests.length === 0) {
      throw new Error('No tests selected');
    }

    if (!options.skipBuild) {
      await buildApp();
    }

    if (options.manual) {
      if (tests.length !== 1) {
        throw new Error('Manual mode requires exactly one selected test via --test <id>.');
      }
      const manualSession = await createChromeFormSurfaceSession(tests[0], options);
      await manualSession.focus();
      console.log(`[Manual] Opened shared form-test surface for ${tests[0].id}.`);
      console.log('[Manual] Live task-state and JS traces will update under form-tests/test-output/<test-id>/ while you interact.');
      console.log('[Manual] Press Ctrl+C in this terminal when you are done.');
      await new Promise(() => {});
      return;
    }

    await assertNoRunningInterpreterApp();
    await ensureLocalApi(options);
    await startMainApp(options);

    for (let index = 0; index < tests.length; index += 1) {
      const passed = await runTest(tests[index], options, index, tests.length);
      if (appProcessExit) {
        console.log(`Stopping because hidden benchmark app exited with ${formatAppExit(appProcessExit)}.`);
        break;
      }
      if (!passed && !options.continueOnFailure) {
        console.log('Stopping after first failure. Use --continue-on-failure to run the full suite.');
        break;
      }
    }

    printResults();
    if (testResults.some((result) => !result.passed)) {
      process.exitCode = 1;
    }
  } finally {
    if (options.skipBuild) {
      printSkipBuildWarning('end');
    }
    await cleanup();
  }
}

process.on('SIGINT', async () => {
  await cleanup({ emergency: emergencyAbortRequested });
  process.exit(130);
});

process.on('SIGTERM', async () => {
  await cleanup({ emergency: emergencyAbortRequested });
  process.exit(143);
});

module.exports = {
  OUTPUT_DIR,
  TEST_WORKSPACE_DIR,
  cleanup,
  closeFormSurfaceSession,
  createChromeFormSurfaceSession,
  createTestOutputDir,
  evaluateTask,
  loadTests,
  wait,
  writeTaskArtifact,
};

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error.stack || error.message || String(error));
    await cleanup({ emergency: emergencyAbortRequested });
    process.exit(1);
  });
}
