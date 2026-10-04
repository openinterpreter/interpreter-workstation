import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CANDIDATES = process.platform === 'darwin'
  ? [
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
    ]
  : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];

type TailscaleStatusJson = {
  BackendState?: string;
  Self?: {
    DNSName?: string;
    TailscaleIPs?: string[];
    HostName?: string;
    Online?: boolean;
  };
};

export type TailscaleRemoteStatus = {
  installed: boolean;
  running: boolean;
  online: boolean;
  backendState: string;
  hostName: string | null;
  dnsName: string | null;
  endpoint: string | null;
  ips: string[];
  error: string | null;
};

function binary(): string | null {
  return CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function socketArguments(): string[] {
  const candidates = [
    process.env.TAILSCALE_SOCKET,
    join(homedir(), '.tailscale-codex', 'tailscaled.sock'),
    process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, 'tailscale', 'tailscaled.sock') : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const socket = candidates.find((candidate) => existsSync(candidate));
  return socket ? [`--socket=${socket}`] : [];
}

async function run(args: string[]): Promise<string> {
  const command = binary();
  if (!command) throw new Error('Tailscale is not installed on this computer.');
  const { stdout } = await execFileAsync(command, [...socketArguments(), ...args], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  return stdout;
}

function message(error: unknown): string {
  const value = error as { stderr?: string; stdout?: string; message?: string };
  return value.stderr?.trim() || value.stdout?.trim() || value.message || String(error);
}

export async function inspectTailscaleRemote(): Promise<TailscaleRemoteStatus> {
  if (!binary()) {
    return {
      installed: false, running: false, online: false, backendState: 'Missing',
      hostName: null, dnsName: null, endpoint: null, ips: [],
      error: 'Install Tailscale to connect privately to this Workstation.',
    };
  }
  try {
    const parsed = JSON.parse(await run(['status', '--json'])) as TailscaleStatusJson;
    const dnsName = parsed.Self?.DNSName?.replace(/\.$/, '') || null;
    const backendState = parsed.BackendState || 'Unknown';
    return {
      installed: true,
      running: backendState !== 'Stopped' && backendState !== 'NoState',
      online: parsed.Self?.Online === true && backendState === 'Running',
      backendState,
      hostName: parsed.Self?.HostName || null,
      dnsName,
      endpoint: dnsName ? `https://${dnsName}` : null,
      ips: parsed.Self?.TailscaleIPs ?? [],
      error: null,
    };
  } catch (error) {
    return {
      installed: true, running: false, online: false, backendState: 'Unavailable',
      hostName: null, dnsName: null, endpoint: null, ips: [], error: message(error),
    };
  }
}

export async function enableTailscaleServe(port: number): Promise<TailscaleRemoteStatus> {
  const status = await inspectTailscaleRemote();
  if (!status.online || !status.endpoint) {
    throw new Error(status.error || 'Open Tailscale and sign in before enabling private access.');
  }
  await run(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);
  return inspectTailscaleRemote();
}

export async function disableTailscaleServe(): Promise<void> {
  if (!binary()) return;
  await run(['serve', 'reset']);
}
