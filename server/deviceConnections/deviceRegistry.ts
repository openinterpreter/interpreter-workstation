/**
 * Paired devices and one-time pairing codes.
 *
 * A paired device is persisted with a hash of its secret, never the secret.
 * The device holds `<id>.<secret>` in an HttpOnly cookie; presenting it proves
 * possession and is checked against the stored hash on every request, so
 * revoking a device takes effect immediately.
 *
 * Pairing codes live only in memory: random (144 bits), single use,
 * short-lived, and compared by hash in constant time. Wrong codes never lock
 * out or discard valid ones: guessing 144 bits is not feasible, while a
 * lockout would let anyone who can reach the claim endpoint block pairing.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeviceId } from './gatewayTrust';

export const DEVICE_KINDS = ['web'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export type PairedDevice = {
  id: string;
  label: string;
  kind: DeviceKind;
  createdAt: string;
  lastSeenAt: string | null;
  secretHash: string;
};

export type DeviceSummary = Omit<PairedDevice, 'secretHash'>;

export type DevicePersistence = {
  read: () => Promise<PairedDevice[]>;
  write: (devices: PairedDevice[]) => Promise<void>;
};

export type PairingCode = { id: string; code: string; expiresAt: string };

type PendingCode = { id: string; hash: Buffer; label: string; kind: DeviceKind; expiresAt: number };

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CODES = 20;
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_LABEL_LENGTH = 80;
const MAX_CODE_LENGTH = 128;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function summary(device: PairedDevice): DeviceSummary {
  return {
    id: device.id,
    label: device.label,
    kind: device.kind,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
}

export function normalizeDeviceLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!label) return 'Phone';
  return label.slice(0, MAX_LABEL_LENGTH);
}

export function normalizeDeviceKind(value: unknown): DeviceKind {
  if (value === undefined || value === null || value === '') return 'web';
  if ((DEVICE_KINDS as readonly unknown[]).includes(value)) return value as DeviceKind;
  throw new Error(`Device kind must be one of: ${DEVICE_KINDS.join(', ')}.`);
}

/** Splits a device credential into its id and secret, or null when malformed. */
export function parseDeviceCredential(value: string | null | undefined): { id: string; secret: string } | null {
  if (!value) return null;
  const separator = value.indexOf('.');
  if (separator < 0) return null;
  const id = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (!isDeviceId(id) || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return null;
  return { id, secret };
}

export class DeviceRegistry {
  private readonly persistence: DevicePersistence;
  private readonly now: () => number;
  private readonly pending: PendingCode[] = [];
  private devices: PairedDevice[] | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly lastSeenWrittenAt = new Map<string, number>();
  private readonly revokeListeners = new Set<(id: string) => void>();

  constructor(persistence: DevicePersistence, options: { now?: () => number } = {}) {
    this.persistence = persistence;
    this.now = options.now ?? Date.now;
  }

  createPairingCode(input: { label?: unknown; kind?: unknown } = {}): PairingCode {
    const now = this.now();
    this.prune(now);
    const code = randomBytes(18).toString('base64url');
    const expiresAt = now + PAIRING_CODE_TTL_MS;
    const id = randomBytes(9).toString('base64url');
    this.pending.push({
      id,
      hash: sha256(code),
      label: normalizeDeviceLabel(input.label),
      kind: normalizeDeviceKind(input.kind),
      expiresAt,
    });
    while (this.pending.length > MAX_PENDING_CODES) this.pending.shift();
    return { id, code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Whether the pairing code with this id is still unclaimed and unexpired. */
  isPairingCodePending(id: string): boolean {
    this.prune(this.now());
    return this.pending.some((entry) => entry.id === id);
  }

  /** Calls `listener` with a device id whenever that device is revoked. */
  onRevoke(listener: (id: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => { this.revokeListeners.delete(listener); };
  }

  /** Consumes a pairing code and creates its device; null for any invalid code. */
  async claim(code: unknown): Promise<{ device: DeviceSummary; credential: string } | null> {
    const now = this.now();
    this.prune(now);
    const supplied = typeof code === 'string' && code.length > 0 && code.length <= MAX_CODE_LENGTH
      ? sha256(code)
      : null;
    let matchIndex = -1;
    for (let index = 0; index < this.pending.length; index += 1) {
      // Compare every pending code so timing does not depend on which matched.
      if (supplied && timingSafeEqual(supplied, this.pending[index].hash) && matchIndex < 0) {
        matchIndex = index;
      }
    }
    if (matchIndex < 0) return null;
    const [pending] = this.pending.splice(matchIndex, 1);
    const secret = randomBytes(32).toString('base64url');
    const device: PairedDevice = {
      id: `dev_${randomBytes(12).toString('base64url')}`,
      label: pending.label,
      kind: pending.kind,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      secretHash: sha256(secret).toString('hex'),
    };
    await this.update((devices) => [...devices, device]);
    this.lastSeenWrittenAt.set(device.id, now);
    return { device: summary(device), credential: `${device.id}.${secret}` };
  }

  /** The device a credential belongs to, or null when unknown, revoked, or wrong. */
  async authenticate(credential: string | null | undefined): Promise<DeviceSummary | null> {
    const parsed = parseDeviceCredential(credential);
    if (!parsed) return null;
    const device = (await this.load()).find((entry) => entry.id === parsed.id);
    if (!device) return null;
    const expected = Buffer.from(device.secretHash, 'hex');
    const actual = sha256(parsed.secret);
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) return null;
    this.touch(device.id);
    return summary(device);
  }

  async get(id: string): Promise<DeviceSummary | null> {
    const device = (await this.load()).find((entry) => entry.id === id);
    return device ? summary(device) : null;
  }

  async list(): Promise<DeviceSummary[]> {
    return (await this.load()).map(summary);
  }

  async revoke(id: string): Promise<boolean> {
    let removed = false;
    await this.update((devices) => devices.filter((device) => {
      if (device.id !== id) return true;
      removed = true;
      return false;
    }));
    this.lastSeenWrittenAt.delete(id);
    if (removed) {
      for (const listener of this.revokeListeners) {
        try {
          listener(id);
        } catch {
          // A listener failure must not undo or hide the revocation.
        }
      }
    }
    return removed;
  }

  private prune(now: number): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index].expiresAt <= now) this.pending.splice(index, 1);
    }
  }

  private async load(): Promise<PairedDevice[]> {
    if (!this.devices) {
      const stored = await this.persistence.read();
      this.devices = Array.isArray(stored) ? stored.filter((device) => isDeviceId(device?.id)) : [];
    }
    return this.devices;
  }

  private update(change: (devices: PairedDevice[]) => PairedDevice[]): Promise<void> {
    const next = this.writes.then(async () => {
      const updated = change(await this.load());
      this.devices = updated;
      await this.persistence.write(updated);
    });
    this.writes = next.catch(() => undefined);
    return next;
  }

  private touch(id: string): void {
    const now = this.now();
    const last = this.lastSeenWrittenAt.get(id) ?? 0;
    if (now - last < LAST_SEEN_INTERVAL_MS) return;
    this.lastSeenWrittenAt.set(id, now);
    const seenAt = new Date(now).toISOString();
    void this.update((devices) => devices.map((device) => (
      device.id === id ? { ...device, lastSeenAt: seenAt } : device
    ))).catch(() => undefined);
  }
}

/** Persists paired devices in the app config under `connectedDevices`. */
export function configDevicePersistence(): DevicePersistence {
  return {
    read: async () => {
      const { loadConfig } = await import('../configStore');
      return (await loadConfig()).connectedDevices ?? [];
    },
    write: async (devices) => {
      const { loadConfig, saveConfig } = await import('../configStore');
      const config = await loadConfig();
      await saveConfig({ ...config, connectedDevices: devices });
    },
  };
}

let defaultRegistry: DeviceRegistry | null = null;

export function getDeviceRegistry(): DeviceRegistry {
  defaultRegistry ??= new DeviceRegistry(configDevicePersistence());
  return defaultRegistry;
}

/** Test hook: replaces the process registry. */
export function setDeviceRegistryForTests(registry: DeviceRegistry | null): void {
  defaultRegistry = registry;
}
