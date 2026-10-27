import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CUA_PROCESS_LOCK_DIR = path.join(os.tmpdir(), 'interpreter-desktop-driver-call.lock');

function linuxStartTicks(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const ticks = fields[19]; // /proc stat field 22; first remaining field is 3.
    return /^\d+$/.test(ticks ?? '') ? ticks : null;
  } catch { return null; }
}

export function cuaLockOwnerForNewCall(action: string, threadId?: string) {
  return {
    pid: process.pid,
    acquiredAt: Date.now(),
    processStartTicks: linuxStartTicks(process.pid),
    nonce: randomUUID(),
    action: /^[a-z_]{1,80}$/.test(action) ? action : null,
    threadId: threadId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId) ? threadId : null,
  };
}

/** Only a dead process or a verified reused Linux PID is safe to reap.
 * Legacy live-PID records and malformed/foreign locks remain held.
 */
export function cuaLockOwnerDefinitelyGone(lockDir: string): boolean {
  try {
    const directory = fs.lstatSync(lockDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || (process.getuid && directory.uid !== process.getuid())) return false;
    if (fs.readdirSync(lockDir).join(',') !== 'owner') return false;
    const file = fs.lstatSync(path.join(lockDir, 'owner'));
    if (!file.isFile() || file.isSymbolicLink() || file.size > 1024) return false;
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')) as Record<string, unknown>;
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) return false;
    const pid = owner.pid as number;
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    const ticks = linuxStartTicks(pid);
    return typeof owner.processStartTicks === 'string'
      && ticks !== null && ticks !== owner.processStartTicks;
  } catch { return false; }
}

/** Metadata only. Unknown identity is never interpreted as a clear lock. */
export function readCuaProcessLockCustody(lockDir = CUA_PROCESS_LOCK_DIR) {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(lockDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { held: false, ownerKnown: true, pid: null, action: null, threadId: null, acquiredAt: null, processIdentityVerified: null };
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid CUA lock directory');
  const unknown = { held: true, ownerKnown: false, pid: null, action: null, threadId: null, acquiredAt: null, processIdentityVerified: false };
  try {
    const ownerPath = path.join(lockDir, 'owner');
    const ownerStat = fs.lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 1024) return unknown;
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) return unknown;
    const pid = owner.pid as number;
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') alive = true; }
    const ticks = linuxStartTicks(pid);
    const processIdentityVerified = alive && typeof owner.processStartTicks === 'string' && ticks !== null && owner.processStartTicks === ticks;
    return {
      held: true, ownerKnown: true, pid,
      action: typeof owner.action === 'string' && /^[a-z_]{1,80}$/.test(owner.action) ? owner.action : null,
      threadId: typeof owner.threadId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(owner.threadId) ? owner.threadId : null,
      acquiredAt: typeof owner.acquiredAt === 'number' && Number.isSafeInteger(owner.acquiredAt) ? owner.acquiredAt : null,
      processIdentityVerified,
    };
  } catch { return unknown; }
}
