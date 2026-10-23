import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cuaLockOwnerForNewCall, readCuaProcessLockCustody } from './cuaProcessLockMetadata';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-custody-test-'));
afterEach(() => { for (const file of fs.readdirSync(root)) fs.rmSync(path.join(root, file), { recursive: true, force: true }); });

test('distinguishes clear from legacy held lock with unknown action and identity', () => {
  const lock = path.join(root, 'lock');
  expect(readCuaProcessLockCustody(lock)).toMatchObject({ held: false, ownerKnown: true });
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, acquiredAt: 123 }));
  expect(readCuaProcessLockCustody(lock)).toMatchObject({ held: true, ownerKnown: true,
    action: null, threadId: null, processIdentityVerified: false });
});

test('records action and thread but never arguments or process command line', () => {
  const lock = path.join(root, 'lock');
  const owner = cuaLockOwnerForNewCall('get_app_state', '01a0d435-bb2b-7047-afe7-0a639be8e5d4');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify(owner));
  const result = readCuaProcessLockCustody(lock);
  expect(result).toMatchObject({ held: true, action: 'get_app_state', threadId: owner.threadId });
  expect(JSON.stringify(result)).not.toContain('args');
  if (process.platform === 'linux') expect(result.processIdentityVerified).toBe(true);
});

test('never follows a symlinked owner or lock directory', () => {
  const target = path.join(root, 'target');
  const lock = path.join(root, 'lock');
  fs.writeFileSync(target, JSON.stringify(cuaLockOwnerForNewCall('click')));
  fs.mkdirSync(lock);
  fs.symlinkSync(target, path.join(lock, 'owner'));
  expect(readCuaProcessLockCustody(lock)).toMatchObject({ held: true, ownerKnown: false });
  fs.rmSync(lock, { recursive: true, force: true });
  fs.symlinkSync(root, lock);
  expect(() => readCuaProcessLockCustody(lock)).toThrow('Invalid CUA lock directory');
});
