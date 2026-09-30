import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSimpleWorkspacePath, assertSimpleWorkspaceChildPath } from '../simpleWorkspace';
import type { SimpleActionEvent, SimpleBlock, SimpleInterfaceSnapshot, SimplePage } from '../../shared/simpleInterface';
import { broadcastEvent } from './broadcast';

const MAX_PAGE_BYTES = 128 * 1024;
const MAX_DATA_BYTES = 32 * 1024;
const MAX_EVENTS_BYTES = 4 * 1024 * 1024;
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ASSET = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.(png|jpe?g|webp|gif|avif)$/i;
const DEFAULT_PAGE: SimplePage = {
  version: 1,
  title: 'Interpreter',
  blocks: [
    { type: 'heading', id: 'welcome', text: 'What would you like to make?', level: 1 },
    { type: 'paragraph', id: 'intro', text: 'Ask Interpreter below, or choose a place to begin.' },
    { type: 'row', id: 'suggestions', children: [
      { type: 'button', id: 'plan', label: 'Plan my day', message: 'Help me plan my day.' },
      { type: 'button', id: 'explore', label: 'Explore an idea', message: 'Help me explore an idea.' },
    ] },
  ],
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unsupported property: ${key}`);
  }
}

function text(value: unknown, name: string, max = 4000): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000B-\u001F]/.test(value)) {
    throw new Error(`${name} must be text of at most ${max} characters`);
  }
  return value;
}

function validateBlock(value: unknown, ids: Set<string>, depth: number, count: { value: number }): SimpleBlock {
  const item = object(value);
  if (++count.value > 100 || depth > 5) throw new Error('Interface exceeds block or nesting limit');
  if (typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id)) throw new Error('Block IDs must be unique, safe identifiers');
  ids.add(item.id);
  switch (item.type) {
    case 'heading':
      exactKeys(item, ['type', 'id', 'text', 'level']);
      if (item.level !== undefined && ![1, 2, 3].includes(item.level as number)) throw new Error('Invalid heading level');
      return { type: 'heading', id: item.id, text: text(item.text, 'Heading'), level: item.level as 1 | 2 | 3 | undefined };
    case 'paragraph':
      exactKeys(item, ['type', 'id', 'text']);
      return { type: 'paragraph', id: item.id, text: text(item.text, 'Paragraph') };
    case 'card':
    case 'row':
      exactKeys(item, ['type', 'id', 'children']);
      if (!Array.isArray(item.children) || item.children.length > 50) throw new Error('Container requires at most 50 children');
      return { type: item.type, id: item.id, children: item.children.map(child => validateBlock(child, ids, depth + 1, count)) };
    case 'image':
      exactKeys(item, ['type', 'id', 'asset', 'alt', 'caption']);
      if (typeof item.asset !== 'string' || !ASSET.test(item.asset) || item.asset.includes('..')) throw new Error('Image must name an asset in interface/assets');
      return { type: 'image', id: item.id, asset: item.asset, alt: text(item.alt, 'Alt text', 300), caption: item.caption === undefined ? undefined : text(item.caption, 'Caption', 300) };
    case 'button':
      exactKeys(item, ['type', 'id', 'label', 'message']);
      return { type: 'button', id: item.id, label: text(item.label, 'Label', 120), message: text(item.message, 'Message', 2000) };
    case 'input':
      exactKeys(item, ['type', 'id', 'label', 'placeholder', 'buttonLabel', 'message']);
      if (typeof item.message !== 'string' || !item.message.includes('{{value}}')) throw new Error('Input message must include {{value}}');
      return { type: 'input', id: item.id, label: text(item.label, 'Label', 120), placeholder: item.placeholder === undefined ? undefined : text(item.placeholder, 'Placeholder', 120), buttonLabel: item.buttonLabel === undefined ? undefined : text(item.buttonLabel, 'Button label', 120), message: text(item.message, 'Message', 2000) };
    case 'divider':
      exactKeys(item, ['type', 'id']);
      return { type: 'divider', id: item.id };
    default:
      throw new Error('Unknown interface block type');
  }
}

export function validateSimplePage(value: unknown): SimplePage {
  const page = object(value);
  exactKeys(page, ['version', 'title', 'blocks']);
  if (page.version !== 1 || !Array.isArray(page.blocks) || page.blocks.length > 50) throw new Error('Expected interface version 1 with at most 50 root blocks');
  const ids = new Set<string>();
  const count = { value: 0 };
  return { version: 1, title: text(page.title, 'Title', 120), blocks: page.blocks.map(block => validateBlock(block, ids, 0, count)) };
}

async function paths(create = true) {
  const workspacePath = await getSimpleWorkspacePath();
  const directory = join(workspacePath, 'interface');
  await assertSimpleWorkspaceChildPath(workspacePath, directory);
  if (create) await mkdir(directory, { recursive: true });
  await assertSimpleWorkspaceChildPath(workspacePath, directory);
  return { workspacePath, directory };
}

async function checked(workspacePath: string, filePath: string): Promise<string> {
  await assertSimpleWorkspaceChildPath(workspacePath, filePath);
  try {
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error('Symlink interface files are not allowed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return filePath;
}

async function readBounded(filePath: string, limit: number): Promise<string | null> {
  try {
    const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if ((await file.stat()).size > limit) throw new Error('Interface file exceeds size limit');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicJson(workspacePath: string, path: string, value: unknown): Promise<void> {
  const temp = await checked(workspacePath, `${path}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await checked(workspacePath, path);
    await rename(temp, path);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(temp, { force: true });
  }
}

function revision(page: SimplePage): string {
  return createHash('sha256').update(JSON.stringify(page)).digest('hex');
}

async function lastGood(workspacePath: string, directory: string): Promise<SimplePage> {
  const path = await checked(workspacePath, join(directory, 'last-good.json'));
  const contents = await readBounded(path, MAX_PAGE_BYTES);
  if (!contents) return DEFAULT_PAGE;
  try { return validateSimplePage(JSON.parse(contents)); }
  catch { return DEFAULT_PAGE; }
}

async function stringMap(workspacePath: string, path: string): Promise<Record<string, string>> {
  const contents = await readBounded(await checked(workspacePath, path), MAX_DATA_BYTES);
  if (!contents) return {};
  const source = object(JSON.parse(contents));
  if (Object.keys(source).length > 100) throw new Error('Too many data entries');
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!ID.test(key)) throw new Error('Invalid data key');
    data[key] = text(value, `Data ${key}`, 4000);
  }
  return data;
}

/** Called after agent file edits; invalid candidates never replace the accepted page. */
export async function promoteSimpleInterfaceCandidate(): Promise<SimpleInterfaceSnapshot> {
  const { workspacePath, directory } = await paths();
  const candidatePath = await checked(workspacePath, join(directory, 'page.json'));
  const contents = await readBounded(candidatePath, MAX_PAGE_BYTES);
  let diagnostic: string | null = null;
  let page = await lastGood(workspacePath, directory);
  if (!contents) {
    if (!(await readBounded(await checked(workspacePath, join(directory, 'last-good.json')), MAX_PAGE_BYTES))) {
      await atomicJson(workspacePath, candidatePath, DEFAULT_PAGE);
      await atomicJson(workspacePath, join(directory, 'last-good.json'), DEFAULT_PAGE);
    }
  } else {
    try {
      const next = validateSimplePage(JSON.parse(contents));
      if (revision(next) !== revision(page)) {
        await atomicJson(workspacePath, join(directory, 'last-good.json'), next);
        broadcastEvent('simple-interface:changed', { revision: revision(next) });
      }
      page = next;
    } catch (error) {
      diagnostic = `Invalid interface/page.json: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const result = await snapshot(workspacePath, directory, page, diagnostic, true);
  const diagnosticPath = join(directory, 'diagnostics.json');
  const oldDiagnostic = await readBounded(await checked(workspacePath, diagnosticPath), 4096);
  let oldError: string | null = null;
  try { oldError = oldDiagnostic ? JSON.parse(oldDiagnostic).error : null; } catch { /* Replace corrupt diagnostics. */ }
  if (oldDiagnostic === null || oldError !== result.diagnostic) {
    await atomicJson(workspacePath, diagnosticPath, { error: result.diagnostic, checkedAt: new Date().toISOString() });
  }
  return result;
}

async function snapshot(workspacePath: string, directory: string, page: SimplePage, diagnostic: string | null, promoteData = false): Promise<SimpleInterfaceSnapshot> {
  let data: Record<string, string> = {};
  let inputs: Record<string, string> = {};
  try {
    data = await stringMap(workspacePath, join(directory, 'data.json'));
    if (promoteData) {
      const goodPath = join(directory, 'last-good-data.json');
      const previous = await stringMap(workspacePath, goodPath);
      if (JSON.stringify(data) !== JSON.stringify(previous)) await atomicJson(workspacePath, goodPath, data);
    }
  } catch (error) {
    diagnostic ??= `Invalid interface/data.json: ${error instanceof Error ? error.message : String(error)}`;
    try { data = await stringMap(workspacePath, join(directory, 'last-good-data.json')); }
    catch { /* The default empty map is still safe. */ }
  }
  try { inputs = await stringMap(workspacePath, join(directory, 'state.json')); }
  catch (error) { diagnostic ??= `Invalid interface/state.json: ${error instanceof Error ? error.message : String(error)}`; }
  return { page, revision: revision(page), data, inputs, diagnostic };
}

/** Read-only: remote read-only hosts never mutate the user's workspace. */
export async function readSimpleInterface(): Promise<SimpleInterfaceSnapshot> {
  const { workspacePath, directory } = await paths(false);
  const page = await lastGood(workspacePath, directory);
  let diagnostic: string | null = null;
  try {
    const error = await readBounded(await checked(workspacePath, join(directory, 'diagnostics.json')), 4096);
    if (error) diagnostic = typeof JSON.parse(error).error === 'string' ? JSON.parse(error).error : null;
  } catch { /* A broken diagnostic must not hide the accepted page. */ }
  return snapshot(workspacePath, directory, page, diagnostic);
}

function findBlock(blocks: SimpleBlock[], id: string): SimpleBlock | undefined {
  for (const block of blocks) {
    if (block.id === id) return block;
    if ((block.type === 'row' || block.type === 'card')) {
      const child = findBlock(block.children, id);
      if (child) return child;
    }
  }
  return undefined;
}

/** Bounded form edits survive page re-promotion/relaunch without running agent code. */
export async function saveSimpleInterfaceInput(request: { id: string; revision: string; value: string }): Promise<{ success: true }> {
  const { workspacePath, directory } = await paths();
  const page = await lastGood(workspacePath, directory);
  if (revision(page) !== request.revision || findBlock(page.blocks, request.id)?.type !== 'input') throw new Error('Input belongs to an outdated interface');
  const value = text(request.value, 'Input', 4000);
  const statePath = join(directory, 'state.json');
  const old = await stringMap(workspacePath, statePath);
  old[request.id] = value;
  await atomicJson(workspacePath, statePath, old);
  return { success: true };
}

/** Persist before the shell submits to the primary durable thread. No renderer-provided message is trusted. */
export async function recordSimpleInterfaceAction(request: { actionId: string; revision: string; value?: string }): Promise<SimpleActionEvent> {
  const { workspacePath, directory } = await paths();
  const page = await lastGood(workspacePath, directory);
  if (revision(page) !== request.revision) throw new Error('Action belongs to an outdated interface');
  const block = findBlock(page.blocks, request.actionId);
  if (!block || (block.type !== 'button' && block.type !== 'input')) throw new Error('Action is not present in the accepted interface');
  const value = block.type === 'input' ? text(request.value, 'Input', 4000) : undefined;
  const message = block.type === 'input' ? block.message.replaceAll('{{value}}', value ?? '') : block.message;
  if (message.length > 6000) throw new Error('Message exceeds size limit');
  const path = await checked(workspacePath, join(directory, 'events.jsonl'));
  try { if ((await stat(path)).size > MAX_EVENTS_BYTES) throw new Error('Interface event log is full; archive it before continuing'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const event: SimpleActionEvent = { id: randomUUID(), at: new Date().toISOString(), revision: request.revision, actionId: request.actionId, message, ...(value === undefined ? {} : { value }), status: 'pending' };
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await file.writeFile(`${JSON.stringify(event)}\n`); }
  finally { await file.close(); }
  broadcastEvent('simple-interface:action', { id: event.id, actionId: event.actionId });
  return event;
}

/** Explicit delivery result lets the agent diagnose failed submissions from disk. */
export async function recordSimpleInterfaceDelivery(request: { id: string; status: 'dispatched' | 'failed'; error?: string }): Promise<{ success: true }> {
  if (typeof request.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.id) || !['dispatched', 'failed'].includes(request.status)) throw new Error('Invalid delivery result');
  const { workspacePath, directory } = await paths();
  const path = await checked(workspacePath, join(directory, 'deliveries.jsonl'));
  try { if ((await stat(path)).size > MAX_EVENTS_BYTES) throw new Error('Interface delivery log is full; archive it before continuing'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await file.writeFile(`${JSON.stringify({ id: request.id, status: request.status, error: request.status === 'failed' ? text(request.error ?? 'Submission failed', 'Error', 500) : undefined, at: new Date().toISOString() })}\n`); }
  finally { await file.close(); }
  return { success: true };
}

export async function readSimpleInterfaceAsset(name: string): Promise<{ bytes: Buffer; mime: string }> {
  if (!ASSET.test(name) || name.includes('..')) throw new Error('Invalid asset name');
  const { workspacePath, directory } = await paths(false);
  const file = await checked(workspacePath, join(directory, 'assets', name));
  const ext = name.split('.').pop()!.toLowerCase();
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if ((await handle.stat()).size > 10 * 1024 * 1024) throw new Error('Image exceeds size limit');
    return { bytes: await handle.readFile(), mime: mime[ext] };
  } finally { await handle.close(); }
}
