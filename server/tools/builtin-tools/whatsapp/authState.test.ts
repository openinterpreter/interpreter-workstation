import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWhatsAppAuthState } from './authState';

const createdDirs: string[] = [];
async function testAuthDir() {
  const dir = await mkdtemp(join(tmpdir(), 'workstation-whatsapp-auth-test-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('WhatsApp pairing authentication state', () => {
  test('a fresh folder loads the native store without requiring legacy credentials', async () => {
    const dir = await testAuthDir();
    const { state } = await loadWhatsAppAuthState(dir);
    expect(state.store).toBeDefined();
    expect(state.creds).toBeDefined();
    expect(await readFile(join(dir, 'creds.json')).then(() => true).catch(() => false)).toBe(false);
  });

  test('an existing legacy session stays on the legacy loader without losing its stored identity', async () => {
    const dir = await testAuthDir();
    await writeFile(join(dir, 'creds.json'), JSON.stringify({ me: { id: '15550000000@s.whatsapp.net' } }));
    const { state } = await loadWhatsAppAuthState(dir);
    expect(state.store).toBeUndefined();
    expect(state.creds.me?.id).toBe('15550000000@s.whatsapp.net');
  });
});
