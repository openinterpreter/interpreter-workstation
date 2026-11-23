/**
 * Connect a device: create a pairing link, list paired devices, revoke one.
 *
 * One implementation serves the agent's `interpreter-app` tools and the
 * HTTP/IPC bridge. A pairing link is `<public origin>/pair#code=<code>`; the
 * code is in the fragment so it never reaches a server log. The same link is
 * returned as a QR code.
 *
 * A pairing link grants full access, so by default only the Workstation's own
 * interface receives it: the agent can create a connection, but the link and
 * QR code stay on the local bridge (`deviceConnections.create` and
 * `deviceConnections.pending`), which paired devices cannot call. An operator
 * whose agent is the one that delivers links (an unattended host) opts in
 * with INTERPRETER_DEVICE_GATEWAY_AGENT_LINKS=1.
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

export const DEVICE_GATEWAY_AGENT_LINKS_ENV = 'INTERPRETER_DEVICE_GATEWAY_AGENT_LINKS';

export const DEVICE_LINK_NOT_GIVEN_TO_AGENT_NOTE =
  'The pairing link and QR code are shown on this Workstation itself and are not given to the agent. '
  + 'Ask the person at this Workstation to open them there and scan or send the link to their own device.';

export const DEVICE_CONNECTION_FROM_DEVICE_MESSAGE =
  'A connected device cannot create device links or disconnect other devices.';

export type DeviceConnectionLink = {
  label: string;
  kind: DeviceKind;
  link: string;
  expiresAt: string;
  qrSvg: string;
};

export type AgentDeviceConnection =
  | { created: true; expiresAt: string; note: string }
  | (DeviceConnectionLink & { created: true; qrSvgPath: string });

/** The caller of a bridge method; `deviceId` is set when a paired device sent it. */
export type DeviceConnectionCaller = { deviceId: string | null };

const QR_DIRECTORY = 'device-pairing';

/** Links not yet claimed, for the local interface to show. Never persisted. */
const pendingLinks = new Map<string, DeviceConnectionLink>();

function refusalFromDevice(): Error {
  return Object.assign(new Error(DEVICE_CONNECTION_FROM_DEVICE_MESSAGE), { status: 403 });
}

export function agentDeviceLinksEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[DEVICE_GATEWAY_AGENT_LINKS_ENV]?.trim() === '1';
}

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

async function createPairingLink(input: { label?: unknown; kind?: unknown }): Promise<DeviceConnectionLink> {
  const gateway = getActiveDeviceGateway();
  if (!gateway) throw new Error(DEVICE_CONNECTIONS_UNAVAILABLE_MESSAGE);
  const label = normalizeDeviceLabel(input.label);
  const kind = normalizeDeviceKind(input.kind);
  const { id, code, expiresAt } = getDeviceRegistry().createPairingCode({ label, kind });
  const link = `${gateway.publicOrigin}/pair#code=${code}`;
  const qrSvg = await QRCode.toString(link, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  const created = { label, kind, link, expiresAt, qrSvg };
  pendingLinks.set(id, created);
  prunePendingLinks();
  return created;
}

function prunePendingLinks(): void {
  const registry = getDeviceRegistry();
  for (const id of pendingLinks.keys()) {
    if (!registry.isPairingCodePending(id)) pendingLinks.delete(id);
  }
}

/**
 * Bridge method for the Workstation's own interface. Returns the link and QR
 * code; refused for a request that came from a paired device.
 */
export async function createDeviceConnection(
  input: { label?: unknown; kind?: unknown } = {},
  caller: DeviceConnectionCaller = { deviceId: null },
): Promise<DeviceConnectionLink> {
  if (caller.deviceId) throw refusalFromDevice();
  return createPairingLink(input);
}

/** Bridge method: unclaimed, unexpired links, so the local interface can show one the agent created. */
export async function listPendingDeviceLinks(
  caller: DeviceConnectionCaller = { deviceId: null },
): Promise<{ links: DeviceConnectionLink[] }> {
  if (caller.deviceId) throw refusalFromDevice();
  prunePendingLinks();
  return { links: [...pendingLinks.values()] };
}

/**
 * The agent tool. By default the link stays on the Workstation and the agent
 * learns only that a connection was created. With
 * INTERPRETER_DEVICE_GATEWAY_AGENT_LINKS=1 the agent also receives the link
 * and its QR code (as text and as a file) so it can deliver them itself.
 */
export async function createAgentDeviceConnection(
  input: { label?: unknown; kind?: unknown } = {},
  options: { qrDirectory?: string; now?: number; environment?: NodeJS.ProcessEnv } = {},
): Promise<AgentDeviceConnection> {
  const created = await createPairingLink(input);
  if (!agentDeviceLinksEnabled(options.environment)) {
    return { created: true, expiresAt: created.expiresAt, note: DEVICE_LINK_NOT_GIVEN_TO_AGENT_NOTE };
  }
  const directory = options.qrDirectory ?? await pairingQrDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await removeExpiredQrFiles(directory, options.now ?? Date.now());
  const qrSvgPath = path.join(directory, `pair-${randomBytes(6).toString('hex')}.svg`);
  await writeFile(qrSvgPath, created.qrSvg, { mode: 0o600 });
  return { created: true, ...created, qrSvgPath };
}

/** Device metadata only; never credentials or links. */
export async function listDeviceConnections(): Promise<{ available: boolean; devices: DeviceSummary[] }> {
  return {
    available: getActiveDeviceGateway() !== null,
    devices: await getDeviceRegistry().list(),
  };
}

/** A paired device may disconnect only itself. */
export async function revokeDeviceConnection(
  id: unknown,
  caller: DeviceConnectionCaller = { deviceId: null },
): Promise<{ revoked: boolean }> {
  if (typeof id !== 'string' || !id.trim()) throw new Error('A device id is required.');
  if (caller.deviceId && caller.deviceId !== id.trim()) throw refusalFromDevice();
  return { revoked: await getDeviceRegistry().revoke(id.trim()) };
}

/** Test hook. */
export function clearPendingDeviceLinksForTests(): void {
  pendingLinks.clear();
}
