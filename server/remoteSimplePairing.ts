/** One-use, project-scoped remote pairing. Device enrollment is deliberately separate. */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, lstatSync, mkdirSync } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PAIR_SECONDS = 120;
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_ATTEMPTS = 5;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Z2-7]{16}$/;

type Challenge = {
  id: string;
  projectId: string;
  threadId: string;
  endpoint: string;
  fingerprint: string;
  expiresAt: number;
  codeHash: string;
  attempts: number;
};
type Session = { id: string; projectId: string; threadId: string; tokenHash: string; expiresAt: number };
type StoredState = { version: 1; challenges: Challenge[]; sessions: Session[] };

export type PairingOffer = {
  /** Safe for a QR: a public challenge, never a device enrollment key or bearer credential. */
  qr: { version: 1; endpoint: string; projectId: string; threadId: string; challengeId: string; expiresAt: number; fingerprint: string };
  /** Separate locally displayed copyable code; do not log or encode in the QR. */
  code: string;
};

function endpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !url.hostname.endsWith('.ts.net') || url.hostname.split('.').length < 4
      || (url.port && url.port !== '443' && url.port !== '8443')) {
    throw new Error('Remote endpoint must use a private Tailscale Serve HTTPS name');
  }
  return url.origin;
}

function base32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits -= 5)) & 31]; }
  }
  return result;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function equalHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function valid(state: unknown): state is StoredState {
  if (!state || typeof state !== 'object') return false;
  const item = state as Partial<StoredState>;
  return item.version === 1 && Array.isArray(item.challenges) && Array.isArray(item.sessions)
    && item.challenges.length <= 128 && item.sessions.length <= 128
    && item.challenges.every(value => ID.test(value?.id) && ID.test(value?.projectId)
      && ID.test(value?.threadId) && typeof value?.fingerprint === 'string'
      && typeof value?.codeHash === 'string' && Number.isSafeInteger(value?.expiresAt)
      && Number.isSafeInteger(value?.attempts))
    && item.sessions.every(value => ID.test(value?.id) && ID.test(value?.projectId)
      && ID.test(value?.threadId) && typeof value?.tokenHash === 'string'
      && Number.isSafeInteger(value?.expiresAt));
}

/** The file is private to the host. Invalid or symlinked state fails closed. */
export class RemoteSimplePairing {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string, private readonly projectExists: (id: string) => Promise<boolean>) {}

  private async load(): Promise<StoredState> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Pairing directory must not be a symlink');
    const fileName = join(this.directory, 'sessions.json');
    try {
      const file = await open(fileName, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if ((await file.stat()).size > 128 * 1024) throw new Error('Pairing state exceeds limit');
        const state: unknown = JSON.parse(await file.readFile('utf8'));
        if (!valid(state)) throw new Error('Pairing state is invalid');
        return state;
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, challenges: [], sessions: [] };
      throw error;
    }
  }

  private async save(state: StoredState): Promise<void> {
    const fileName = join(this.directory, 'sessions.json');
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    try {
      // Prevent replacing an attacker-controlled symlink even on the first save.
      try { if (lstatSync(fileName).isSymbolicLink()) throw new Error('Pairing state must not be a symlink'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(temp, fileName);
    } finally { await rm(temp, { force: true }); }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => {}).then(action);
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  /** Stable public pin for a locally displayed QR; private key never leaves the host. */
  async identity(): Promise<{ publicKey: string; fingerprint: string }> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Pairing directory must not be a symlink');
    const fileName = join(this.directory, 'identity.pem');
    let privatePem: string;
    try {
      const file = await open(fileName, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if ((await file.stat()).size > 4096) throw new Error('Host identity exceeds limit');
        privatePem = await file.readFile('utf8');
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      privatePem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      try { await writeFile(fileName, privatePem, { flag: 'wx', mode: 0o600 }); }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
        return this.identity();
      }
    }
    const publicKey = createPublicKey(createPrivateKey(privatePem)).export({ format: 'der', type: 'spki' }).toString('base64');
    return { publicKey, fingerprint: digest(publicKey) };
  }

  async create(input: { endpoint: string; projectId: string; threadId: string }, now = Date.now()): Promise<PairingOffer> {
    const privateEndpoint = endpoint(input.endpoint);
    if (!ID.test(input.projectId) || !ID.test(input.threadId)) throw new Error('Invalid pairing identity');
    if (!(await this.projectExists(input.projectId))) throw new Error('Unknown project');
    return this.serialize(async () => {
      const state = await this.load();
      const { fingerprint } = await this.identity();
      state.challenges = state.challenges.filter(value => value.expiresAt > now);
      state.sessions = state.sessions.filter(value => value.expiresAt > now);
      if (state.challenges.length >= 64 || state.sessions.length >= 64) throw new Error('Too many remote sessions');
      const code = base32(randomBytes(10)); // 80 bits, one-use, not in QR.
      const entry: Challenge = {
        id: randomUUID(), projectId: input.projectId, threadId: input.threadId,
        endpoint: privateEndpoint, fingerprint,
        expiresAt: now + PAIR_SECONDS * 1000, codeHash: digest(code), attempts: 0,
      };
      state.challenges.push(entry);
      await this.save(state);
      return {
        qr: { version: 1, endpoint: entry.endpoint, projectId: entry.projectId,
          threadId: entry.threadId, challengeId: entry.id, expiresAt: entry.expiresAt,
          fingerprint: entry.fingerprint },
        code,
      };
    });
  }

  async redeem(input: { challengeId: string; projectId: string; code: string }, now = Date.now()): Promise<{ sessionId: string; projectId: string; threadId: string; token: string; expiresAt: number }> {
    if (!ID.test(input?.challengeId) || !ID.test(input?.projectId) || !CODE.test(input?.code)) throw new Error('Invalid pairing');
    return this.serialize(async () => {
      const state = await this.load();
      const entry = state.challenges.find(value => value.id === input.challengeId && value.projectId === input.projectId);
      if (!entry || entry.expiresAt <= now || entry.attempts >= MAX_ATTEMPTS || !(await this.projectExists(input.projectId))) throw new Error('Pairing unavailable');
      entry.attempts += 1;
      if (!equalHash(entry.codeHash, digest(input.code))) {
        if (entry.attempts >= MAX_ATTEMPTS) state.challenges = state.challenges.filter(value => value !== entry);
        await this.save(state);
        throw new Error('Pairing unavailable');
      }
      state.challenges = state.challenges.filter(value => value !== entry);
      const token = randomBytes(32).toString('base64url');
      const session: Session = {
        id: randomUUID(), projectId: entry.projectId, threadId: entry.threadId,
        tokenHash: digest(token), expiresAt: now + SESSION_SECONDS * 1000,
      };
      state.sessions.push(session);
      await this.save(state);
      return { sessionId: session.id, projectId: session.projectId, threadId: session.threadId,
        token, expiresAt: session.expiresAt };
    });
  }

  async verify(input: { token: string; projectId: string; sessionId: string }, now = Date.now()): Promise<{ projectId: string; threadId: string } | null> {
    if (!TOKEN.test(input?.token) || !ID.test(input?.projectId) || !ID.test(input?.sessionId)) return null;
    const state = await this.load();
    const entry = state.sessions.find(value => value.id === input.sessionId && value.projectId === input.projectId && value.expiresAt > now);
    if (!entry || !equalHash(entry.tokenHash, digest(input.token)) || !(await this.projectExists(entry.projectId))) return null;
    return { projectId: entry.projectId, threadId: entry.threadId };
  }

  async revoke(input: { token: string; projectId: string; sessionId: string }): Promise<boolean> {
    return this.serialize(async () => {
      if (!(await this.verify(input))) return false;
      const state = await this.load();
      state.sessions = state.sessions.filter(value => value.id !== input.sessionId);
      await this.save(state);
      return true;
    });
  }
}
