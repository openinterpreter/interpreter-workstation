import { describe, expect, test } from 'bun:test';
import {
  DeviceRegistry,
  PAIRING_CODE_TTL_MS,
  parseDeviceCredential,
  type PairedDevice,
} from './deviceRegistry';

function memoryRegistry(start = Date.UTC(2026, 10, 1)) {
  let stored: PairedDevice[] = [];
  let now = start;
  const registry = new DeviceRegistry({
    read: async () => stored,
    write: async (devices) => { stored = devices; },
  }, { now: () => now });
  return {
    registry,
    stored: () => stored,
    advance: (ms: number) => { now += ms; },
  };
}

describe('device pairing codes', () => {
  test('are random, at least 128 bits, and expire after ten minutes', () => {
    const { registry } = memoryRegistry();
    const first = registry.createPairingCode({ label: 'Phone' });
    const second = registry.createPairingCode({ label: 'Phone' });
    expect(first.code).not.toBe(second.code);
    expect(Buffer.from(first.code, 'base64url').length * 8).toBeGreaterThanOrEqual(128);
    expect(Date.parse(first.expiresAt) - Date.UTC(2026, 10, 1)).toBe(PAIRING_CODE_TTL_MS);
  });

  test('can be claimed once and create a device that stores only a hash', async () => {
    const { registry, stored } = memoryRegistry();
    const { code } = registry.createPairingCode({ label: '  My   phone ', kind: 'web' });

    const claimed = await registry.claim(code);
    expect(claimed).not.toBeNull();
    expect(claimed!.device).toMatchObject({ label: 'My phone', kind: 'web' });
    expect(claimed!.device).not.toHaveProperty('secretHash');
    const secret = parseDeviceCredential(claimed!.credential)!.secret;
    expect(JSON.stringify(stored())).not.toContain(secret);
    expect(stored()[0].secretHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await registry.claim(code)).toBeNull();
  });

  test('cannot be claimed after expiry', async () => {
    const { registry, advance } = memoryRegistry();
    const { code } = registry.createPairingCode();
    advance(PAIRING_CODE_TTL_MS + 1);
    expect(await registry.claim(code)).toBeNull();
  });

  test('limits wrong-code guesses, then permits a fresh claim after the cooldown', async () => {
    const { registry, advance } = memoryRegistry();
    const { id, code } = registry.createPairingCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await registry.claim(`wrong-${attempt}`)).toBeNull();
    }
    expect(registry.isPairingCodePending(id)).toBe(true);
    expect(registry.isClaimRateLimited()).toBe(true);
    expect(await registry.claim(code)).toBeNull();
    advance(10 * 60 * 1000);
    expect(registry.isClaimRateLimited()).toBe(false);
    const fresh = registry.createPairingCode();
    expect(await registry.claim(fresh.code)).not.toBeNull();
  });

  test('does not count a successful claim against subsequent pairing codes', async () => {
    const { registry } = memoryRegistry();
    const { id, code } = registry.createPairingCode();
    expect(await registry.claim(code)).not.toBeNull();
    expect(registry.isPairingCodePending(id)).toBe(false);
    const fresh = registry.createPairingCode();
    expect(await registry.claim(fresh.code)).not.toBeNull();
  });

  test('reject malformed input without throwing', async () => {
    const { registry } = memoryRegistry();
    registry.createPairingCode();
    for (const value of [undefined, null, 42, '', 'x'.repeat(500), { code: 'x' }]) {
      expect(await registry.claim(value)).toBeNull();
    }
  });

  test('reject an unknown device kind', () => {
    const { registry } = memoryRegistry();
    expect(() => registry.createPairingCode({ kind: 'native' })).toThrow(/Device kind/);
  });
});

describe('paired devices', () => {
  test('authenticate with their credential until revoked', async () => {
    const { registry, stored } = memoryRegistry();
    const claimed = (await registry.claim(registry.createPairingCode({ label: 'Phone' }).code))!;
    const device = await registry.authenticate(claimed.credential);
    expect(device?.id).toBe(claimed.device.id);

    const { id } = parseDeviceCredential(claimed.credential)!;
    expect(await registry.authenticate(`${id}.${'A'.repeat(43)}`)).toBeNull();
    expect(await registry.authenticate('not-a-credential')).toBeNull();
    expect(await registry.authenticate(null)).toBeNull();

    expect(await registry.list()).toEqual([claimed.device]);
    expect(await registry.revoke(claimed.device.id)).toBe(true);
    expect(await registry.authenticate(claimed.credential)).toBeNull();
    expect(stored()).toEqual([]);
    expect(await registry.revoke(claimed.device.id)).toBe(false);
  });

  test('notify revoke listeners only when a device was removed', async () => {
    const { registry } = memoryRegistry();
    const claimed = (await registry.claim(registry.createPairingCode().code))!;
    const revoked: string[] = [];
    const stop = registry.onRevoke((id) => revoked.push(id));
    expect(await registry.revoke('dev_unknownunknown')).toBe(false);
    expect(await registry.revoke(claimed.device.id)).toBe(true);
    expect(revoked).toEqual([claimed.device.id]);
    stop();
  });

  test('record last activity at most every few minutes', async () => {
    const { registry, stored, advance } = memoryRegistry();
    const claimed = (await registry.claim(registry.createPairingCode().code))!;
    const firstSeen = stored()[0].lastSeenAt;
    advance(60_000);
    await registry.authenticate(claimed.credential);
    expect(stored()[0].lastSeenAt).toBe(firstSeen);
    advance(10 * 60_000);
    await registry.authenticate(claimed.credential);
    await registry.list();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored()[0].lastSeenAt).not.toBe(firstSeen);
  });
});
