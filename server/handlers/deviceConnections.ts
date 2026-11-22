/**
 * Connect a device: create a pairing link, list paired devices, revoke one.
 *
 * One implementation serves the agent's `interpreter-app` tools and the
 * HTTP/IPC bridge. A pairing link is `<public origin>/pair#code=<code>`; the
 * code is in the fragment so it never reaches a server log. The same link is
 * returned as a QR code.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { getActiveDeviceGateway } from '../deviceConnections/gatewayTrust';
import {
  getDeviceRegistry,
  normalizeDeviceKind,
  normalizeDeviceLabel,
  PAIRING_CODE_TTL_MS,
  type DeviceKind,
  type DeviceSummary,
} from '../deviceConnections/deviceRegistry';
import {
  DEVICE_GATEWAY_PORT_ENV,
  DEVICE_GATEWAY_PUBLIC_ORIGIN_ENV,
} from '../deviceConnections/deviceGateway';

export const DEVICE_CONNECTIONS_UNAVAILABLE_MESSAGE =
  `Connect a device is not set up on this Workstation. Start the Workstation server with ${DEVICE_GATEWAY_PORT_ENV} and ${DEVICE_GATEWAY_PUBLIC_ORIGIN_ENV} (an https origin that an HTTPS tunnel or reverse proxy maps to that port), then try again.`;

export type DeviceConnectionLink = {
  label: string;
  kind: DeviceKind;
  link: string;
  expiresAt: string;
  qrSvg: string;
  qrSvgPath: string;
};

const QR_DIRECTORY = 'device-pairing';

async function pairingQrDirectory(): Promise<string> {
  const { getInterpreterAppDataDir } = await import('../configStore');
  return path.join(getInterpreterAppDataDir(), QR_DIRECTORY);
}

/** QR files hold a live link; remove any whose code has expired. */
async function removeExpiredQrFiles(directory: string, now: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(entries.filter((name) => name.endsWith('.svg')).map(async (name) => {
    const file = path.join(directory, name);
    try {
      if (now - (await stat(file)).mtimeMs > PAIRING_CODE_TTL_MS) await rm(file, { force: true });
    } catch {
      // Another process may have removed it.
    }
  }));
}

export async function createDeviceConnection(
  input: { label?: unknown; kind?: unknown } = {},
  options: { qrDirectory?: string; now?: number } = {},
): Promise<DeviceConnectionLink> {
  const gateway = getActiveDeviceGateway();
  if (!gateway) throw new Error(DEVICE_CONNECTIONS_UNAVAILABLE_MESSAGE);
  const label = normalizeDeviceLabel(input.label);
  const kind = normalizeDeviceKind(input.kind);
  const { code, expiresAt } = getDeviceRegistry().createPairingCode({ label, kind });
  const link = `${gateway.publicOrigin}/pair#code=${code}`;
  const qrSvg = await QRCode.toString(link, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });

  const directory = options.qrDirectory ?? await pairingQrDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await removeExpiredQrFiles(directory, options.now ?? Date.now());
  const qrSvgPath = path.join(directory, `pair-${randomBytes(6).toString('hex')}.svg`);
  await writeFile(qrSvgPath, qrSvg, { mode: 0o600 });

  return { label, kind, link, expiresAt, qrSvg, qrSvgPath };
}

export async function listDeviceConnections(): Promise<{ available: boolean; devices: DeviceSummary[] }> {
  return {
    available: getActiveDeviceGateway() !== null,
    devices: await getDeviceRegistry().list(),
  };
}

export async function revokeDeviceConnection(id: unknown): Promise<{ revoked: boolean }> {
  if (typeof id !== 'string' || !id.trim()) throw new Error('A device id is required.');
  return { revoked: await getDeviceRegistry().revoke(id.trim()) };
}
