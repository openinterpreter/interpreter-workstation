import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getInterpreterAppDataDir } from '../configStore';
import type { AgentThreadBinding } from '../agentTabManager';

// A native OIX thread can retain its shell environment while the Workstation
// process restarts. Retain the *scope*, not the bearer token, on this host.
// The token must still be presented by the running thread for every lookup.
type StoredBinding = {
  version: 1;
  tokenHash: string;
  agentId: string;
  threadId: string;
  workspacePath: string;
  allowedToolNames?: string[];
  toolProfileId?: string;
  model?: { provider: string; modelId: string; profileId?: string };
};

const MAX_BYTES = 8192;
const TOKEN = /^agtok_[a-zA-Z0-9_-]{8,160}$/;
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const SHA = /^[0-9a-f]{64}$/;
const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function directory(root: string): string {
  return path.join(root, 'native-caller-bindings');
}

function secureDirectory(root: string, create: boolean): string {
  const dir = directory(root);
  if (create) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const parent = lstatSync(root);
    // The application data root can legitimately be traversable; the new
    // child directory is the mode-0700 confidentiality boundary.
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()) {
      throw new Error('Native caller binding parent is not owned by this runtime');
    }
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('Native caller binding directory is not private');
  }
  return dir;
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function validRecord(value: unknown, hash: string): value is StoredBinding {
  if (!value || typeof value !== 'object') return false;
  const record = value as StoredBinding;
  return record.version === 1 && record.tokenHash === hash && SHA.test(record.tokenHash)
    && ID.test(record.agentId) && ID.test(record.threadId)
    && typeof record.workspacePath === 'string' && path.isAbsolute(record.workspacePath)
    && record.workspacePath.length <= 4096
    && (!record.allowedToolNames || (Array.isArray(record.allowedToolNames)
      && record.allowedToolNames.length <= 64
      && record.allowedToolNames.every(name => typeof name === 'string' && name.length <= 160)))
    && (!record.toolProfileId || (typeof record.toolProfileId === 'string' && record.toolProfileId.length <= 160))
    && (!record.model || (typeof record.model.provider === 'string' && typeof record.model.modelId === 'string'
      && record.model.modelId.length <= 160 && (!record.model.profileId || typeof record.model.profileId === 'string')));
}

export function persistNativeCallerBinding(binding: AgentThreadBinding, root = getInterpreterAppDataDir()): void {
  // Linux headless hosts use native persistent OIX threads. Other desktop
  // platforms retain their existing in-memory caller lifetime unchanged.
  if (process.platform !== 'linux') return;
  // Window-scoped and delegated callers must never survive their live owner.
  if (!binding.threadId || !binding.workspacePath || !path.isAbsolute(binding.workspacePath)
    || !TOKEN.test(binding.callerToken) || !ID.test(binding.threadId) || !ID.test(binding.agentId)
    || binding.windowSessionKey || binding.parentOwner) return;
  const hash = digest(binding.callerToken);
  const record: StoredBinding = {
    version: 1, tokenHash: hash, agentId: binding.agentId,
    threadId: binding.threadId, workspacePath: binding.workspacePath,
    ...(binding.allowedToolNames ? { allowedToolNames: binding.allowedToolNames } : {}),
    ...(binding.toolProfileId ? { toolProfileId: binding.toolProfileId } : {}),
    ...(binding.modelConfig ? { model: {
      provider: binding.modelConfig.provider, modelId: binding.modelConfig.modelId,
      ...(binding.modelConfig.profileId ? { profileId: binding.modelConfig.profileId } : {}),
    } } : {}),
  };
  if (!validRecord(record, hash)) throw new Error('Invalid native caller binding scope');
  const dir = secureDirectory(root, true);
  const target = path.join(dir, `${hash}.json`);
  const temp = path.join(dir, `.${hash}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const bytes = JSON.stringify(record);
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Native caller binding scope too large');
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, target);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

export function recoverNativeCallerBinding(token: string, root = getInterpreterAppDataDir()): AgentThreadBinding | undefined {
  if (process.platform !== 'linux') return undefined;
  if (!TOKEN.test(token)) return undefined;
  const hash = digest(token);
  try {
    const file = path.join(secureDirectory(root, false), `${hash}.json`);
    const fd = openSync(file, FLAGS);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) return undefined;
      const record: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!validRecord(record, hash)) return undefined;
      return {
        agentId: record.agentId, callerToken: token, threadId: record.threadId,
        workspacePath: record.workspacePath,
        ...(record.allowedToolNames ? { allowedToolNames: record.allowedToolNames } : {}),
        ...(record.toolProfileId ? { toolProfileId: record.toolProfileId } : {}),
        ...(record.model ? { modelConfig: record.model as AgentThreadBinding['modelConfig'] } : {}),
      };
    } finally { closeSync(fd); }
  } catch { return undefined; }
}

export function revokeNativeCallerBinding(token: string, root = getInterpreterAppDataDir()): void {
  if (process.platform !== 'linux') return;
  if (!TOKEN.test(token)) return;
  try { unlinkSync(path.join(secureDirectory(root, false), `${digest(token)}.json`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
