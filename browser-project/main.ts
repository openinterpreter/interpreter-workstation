import { applyApprovedEdit, exportProject, MemoryProjectFiles, OpfsProjectFiles, type ProjectFiles } from '../src/browser-project/project';
import { updatePreview } from '../src/browser-project/preview';
import { BrowserWorkerHost } from '../src/browser-project/workerHost';
import sampleWorkerUrl from './sample.worker.ts?worker&url';
import './style.css';

const source = document.querySelector<HTMLTextAreaElement>('#source')!;
const preview = document.querySelector<HTMLIFrameElement>('#frame')!;
const status = document.querySelector<HTMLElement>('#status')!;
const revision = document.querySelector<HTMLElement>('#revision')!;
const storage = document.querySelector<HTMLElement>('#storage')!;
const proposed = document.querySelector<HTMLElement>('#proposal')!;
const approve = document.querySelector<HTMLButtonElement>('#approve')!;
const workerState = document.querySelector<HTMLElement>('#worker-state')!;
const initial = `<main class="scene"><div class="orb"></div><p>LOCAL PROJECT · 001</p><h1>Build in your browser.</h1><span>Change this markup and save to see it live.</span></main>`;
const style = `<style>body{margin:0;background:#091923;color:#e6eee9;font:16px system-ui}.scene{min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;text-align:center;padding:20px;box-sizing:border-box}.orb{width:96px;height:96px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#e4e897,#5ac2ac 55%,#0c5367);box-shadow:0 0 80px #5ac2ac66}.scene p{font-size:11px;letter-spacing:.24em;color:#9ccbbc}.scene h1{font-size:clamp(28px,5vw,52px);font-weight:500;margin:0}.scene span{color:#a1b6b8}</style>`;
let files: ProjectFiles;
let currentRevision: string | null = null;
let pending: { content: string; expectedRevision: string | null } | null = null;

function notice(message: string) { status.textContent = message; }
function render() { updatePreview(preview, source.value, ''); revision.textContent = currentRevision?.slice(0, 9) ?? 'New file'; }
async function init() {
  try { files = await OpfsProjectFiles.open('default'); storage.textContent = 'Saved on this device · OPFS'; }
  catch { files = new MemoryProjectFiles(); storage.textContent = 'Temporary browser memory'; notice('Persistent browser storage unavailable. Export before leaving this page.'); }
  const saved = await files.read('index.html');
  source.value = saved?.content ?? `${style}\n${initial}`;
  currentRevision = saved?.revision ?? null;
  render();
  const worker = new BrowserWorkerHost(new URL(sampleWorkerUrl, location.href));
  const created = await worker.request('create', { seed: 1 });
  workerState.textContent = created.ok ? 'Sequence 0' : 'Unavailable';
  document.querySelector<HTMLButtonElement>('#step')!.onclick = async () => {
    const reply = await worker.request('step', { amount: 1 });
    workerState.textContent = reply.ok ? `Sequence ${(reply.payload as { sequence: number }).sequence}` : 'Worker error';
  };
}
document.querySelector<HTMLButtonElement>('#save')!.onclick = async () => {
  try { currentRevision = await files.write('index.html', source.value, currentRevision); render(); notice('Saved to local project and preview updated.'); }
  catch (error) { notice(error instanceof Error ? error.message : 'Could not save project'); }
};
document.querySelector<HTMLButtonElement>('#propose')!.onclick = () => {
  pending = { content: source.value.replace('Build in your browser.', 'Make it yours.'), expectedRevision: currentRevision };
  proposed.textContent = 'Suggested text change ready. Review before approving; nothing has been written.';
  approve.disabled = false;
};
approve.onclick = async () => {
  if (!pending) return;
  try {
    currentRevision = await applyApprovedEdit(files, { name: 'index.html', ...pending, approved: true });
    source.value = pending.content; pending = null; approve.disabled = true;
    render(); proposed.textContent = 'Approved edit saved to your local project.';
  } catch (error) { notice(error instanceof Error ? error.message : 'Could not apply edit'); }
};
document.querySelector<HTMLButtonElement>('#export')!.onclick = async () => {
  const data = new Blob([await exportProject(files)], { type: 'application/json' });
  const href = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = href; link.download = 'interpreter-project.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
  notice('Exported a local backup. Keep it somewhere you control.');
};
void init().catch(error => notice(error instanceof Error ? error.message : 'Project unavailable'));
