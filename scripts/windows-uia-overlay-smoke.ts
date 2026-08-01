import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import {
  callWindowsUiaTool,
  type WindowsUiaElementSummary,
  type WindowsUiaWindow,
  type WindowsUiaWindowState,
} from '../apps/interpreter-overlay/runtime/infra/windows-uia.js';

function requireElement(state: WindowsUiaWindowState, predicate: (element: WindowsUiaElementSummary) => boolean, label: string): WindowsUiaElementSummary {
  const element = state.elements.find(predicate);
  if (!element) {
    throw new Error(`Missing ${label}. Available: ${state.elements.map((candidate) => `${candidate.element_index}:${candidate.role}:${candidate.name ?? ''}`).join(' | ')}`);
  }
  return element;
}

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const result = await run();
  const durationMs = Math.round(performance.now() - startedAt);
  console.log(`${label} durationMs=${durationMs}`);
  return result;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const windows = await timed('list_windows', () => callWindowsUiaTool<WindowsUiaWindow[]>('list_windows', {}));
const targetWindow = windows.find((window) => window.title.includes('Interpreter UIA Instrumented Target'));
if (!targetWindow) {
  throw new Error(`Interpreter UIA Instrumented Target window not found. Windows: ${windows.map((window) => window.title).join(' | ')}`);
}

const state = await timed('get_window_state', () => callWindowsUiaTool<WindowsUiaWindowState>('get_window_state', {
  window_id: targetWindow.window_id,
}));

const accountName = requireElement(state, (element) => element.name === 'Account Name', 'Account Name field');
const priorityReview = requireElement(state, (element) => element.name === 'Priority review', 'Priority review radio');
const implementationPlanning = requireElement(state, (element) => element.name === 'Implementation planning', 'Implementation planning checkbox');
const submit = requireElement(state, (element) => element.name === 'Submit Instrumented Target', 'submit button');

await timed('type_text Account Name', () => callWindowsUiaTool('type_text', {
  window_id: targetWindow.window_id,
  element_index: accountName.element_index,
  text: 'Overlay Daemon Smoke',
  value: 'Overlay Daemon Smoke',
  bring_to_foreground: true,
}));
await timed('click Priority review', () => callWindowsUiaTool('click', {
  window_id: targetWindow.window_id,
  element_index: priorityReview.element_index,
}));
await timed('click Implementation planning', () => callWindowsUiaTool('click', {
  window_id: targetWindow.window_id,
  element_index: implementationPlanning.element_index,
}));
await timed('click Submit Instrumented Target', () => callWindowsUiaTool('click', {
  window_id: targetWindow.window_id,
  element_index: submit.element_index,
}));

const logPath = 'C:/Users/runner/AppData/Local/Temp/interpreter-uia-target-events.jsonl';
let submitEvent: {
  kind?: string;
  name?: string;
  value?: {
    accountName?: string;
    implementationPlanning?: boolean;
    priorityReview?: boolean;
    status?: string;
  };
} | undefined;
for (let attempt = 0; attempt < 20; attempt += 1) {
  submitEvent = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\uFEFF/, ''))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      kind?: string;
      name?: string;
      value?: {
        accountName?: string;
        implementationPlanning?: boolean;
        priorityReview?: boolean;
        status?: string;
      };
    })
    .findLast((event) => event.kind === 'click' && event.name === 'Submit Instrumented Target');
  if (submitEvent) {
    break;
  }
  await wait(50);
}
const result = submitEvent?.value as {
  accountName?: string;
  implementationPlanning?: boolean;
  priorityReview?: boolean;
  status?: string;
} | undefined;
if (
  result?.accountName !== 'Overlay Daemon Smoke'
  || result?.implementationPlanning !== true
  || result?.priorityReview !== true
  || result?.status !== 'Submitted'
) {
  throw new Error(`Instrumented target result mismatch: ${JSON.stringify(result)}`);
}

console.log('windows-uia-overlay-smoke ok=true');
