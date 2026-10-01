import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteSimplePairing } from './remoteSimplePairing';

const PROJECT = '6e3cffea-849b-4088-a270-e48ca351c94c';
const OTHER = '88a4ebec-b3f5-48e0-a8e1-4c50f6853dc6';
const THREAD = '461c02a6-a5da-4253-9d82-3508acf71f73';
const host = 'https://workstation.example.ts.net';
const identity = { endpoint: host, projectId: PROJECT, threadId: THREAD };
let directory = '';
let pairing: RemoteSimplePairing;
let projectAvailable = true;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'remote-pairing-'));
  projectAvailable = true;
  pairing = new RemoteSimplePairing(directory, async id => projectAvailable && id === PROJECT);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('remote Simple pairing (no device enrollment)', () => {
  test('QR is public metadata, not a bearer secret; code is separate and only its digest is stored', async () => {
    const offer = await pairing.create(identity, 1000);
    expect(offer.qr.endpoint).toBe(host);
    expect(offer.qr.fingerprint).toBe((await pairing.identity()).fingerprint);
    expect(offer.code).toMatch(/^[A-Z2-7]{16}$/);
    expect(JSON.stringify(offer.qr)).not.toContain(offer.code);
    expect(await readFile(join(directory, 'sessions.json'), 'utf8')).not.toContain(offer.code);
    expect(await pairing.verify({ token: offer.code, projectId: PROJECT, sessionId: offer.qr.challengeId }, 1001)).toBeNull();
  });

  test('redeems exactly once; session survives manager recreation, scopes project, and expires', async () => {
    const now = Date.now();
    const offer = await pairing.create(identity, now);
    const session = await pairing.redeem({ challengeId: offer.qr.challengeId, projectId: PROJECT, code: offer.code }, now + 100);
    await expect(pairing.redeem({ challengeId: offer.qr.challengeId, projectId: PROJECT, code: offer.code }, now + 101)).rejects.toThrow();
    const reopened = new RemoteSimplePairing(directory, async id => id === PROJECT);
    expect(await reopened.verify({ token: session.token, projectId: PROJECT, sessionId: session.sessionId }, now + 200)).toEqual({ projectId: PROJECT, threadId: THREAD });
    expect(await reopened.verify({ token: session.token, projectId: OTHER, sessionId: session.sessionId }, now + 200)).toBeNull();
    expect(await reopened.revoke({ token: session.token, projectId: PROJECT, sessionId: session.sessionId })).toBe(true);
    expect(await reopened.verify({ token: session.token, projectId: PROJECT, sessionId: session.sessionId })).toBeNull();
    expect(await pairing.verify({ token: session.token, projectId: PROJECT, sessionId: session.sessionId }, session.expiresAt)).toBeNull();
  });

  test('expired, wrong-project, incorrect and five-times-guessed codes never pair', async () => {
    const offer = await pairing.create(identity, 1000);
    await expect(pairing.redeem({ challengeId: offer.qr.challengeId, projectId: OTHER, code: offer.code }, 1100)).rejects.toThrow();
    for (let n = 0; n < 5; n++) await expect(pairing.redeem({ challengeId: offer.qr.challengeId, projectId: PROJECT, code: 'AAAAAAAAAAAAAAAA' }, 1100)).rejects.toThrow();
    await expect(pairing.redeem({ challengeId: offer.qr.challengeId, projectId: PROJECT, code: offer.code }, 1100)).rejects.toThrow();
    const expired = await pairing.create(identity, 2000);
    await expect(pairing.redeem({ challengeId: expired.qr.challengeId, projectId: PROJECT, code: expired.code }, expired.qr.expiresAt)).rejects.toThrow();
    projectAvailable = false;
    await expect(pairing.create(identity, 2001)).rejects.toThrow('Unknown project');
  });

  test('rejects public endpoints, embedded credentials, path input and symlinked state', async () => {
    for (const endpoint of ['http://workstation.example.ts.net', 'https://example.com', 'https://user:pass@workstation.example.ts.net', 'https://workstation.example.ts.net/private']) {
      await expect(pairing.create({ ...identity, endpoint })).rejects.toThrow();
    }
    const path = join(directory, 'sessions.json');
    const outside = join(directory, 'outside');
    await writeFile(outside, '{}');
    await symlink(outside, path);
    await expect(pairing.create(identity)).rejects.toThrow();
  });
});
