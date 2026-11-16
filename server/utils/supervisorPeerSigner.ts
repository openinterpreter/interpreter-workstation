import { spawn } from 'node:child_process';
import path from 'node:path';

/** Optional local request signer for supervisor-peer verification.
 *
 * When `INTERPRETER_SUPERVISOR_SIGNER_COMMAND` holds a JSON argv array, the
 * command runs without a shell once per verification. It receives
 * `{"path":"<verify URL pathname>","bodyBase64":"<request body>"}` on standard
 * input and prints one JSON proof bound to those exact request bytes. That proof
 * replaces the cloud instance identity when calling the configured verifier. */
export const SUPERVISOR_SIGNER_SETTING = 'INTERPRETER_SUPERVISOR_SIGNER_COMMAND';
/** Names the HTTP header in which the configured verifier expects the proof.
 * It is deployment configuration, not a constant of this application. */
export const SUPERVISOR_PROOF_HEADER_SETTING = 'INTERPRETER_SUPERVISOR_PROOF_HEADER';
const PROOF_HEADER = /^x-[a-z0-9]+(?:-[a-z0-9]+){0,7}$/;

/** A lowercase `x-` extension header name of bounded length. */
export function validateProofHeader(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && PROOF_HEADER.test(value);
}
export const SIGNER_BODY_LIMIT = 2_048;
export const SIGNER_OUTPUT_LIMIT = 2_048;
export const SIGNER_TIMEOUT_MS = 8_000;
const ARGV_MAX_PARTS = 8;
const ARGV_MAX_LENGTH = 1_024;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PROOF_KEYS = ['version', 'sourceComputer', 'instanceId', 'controlGeneration', 'audience',
  'method', 'path', 'bodySha256', 'issuedAtMs', 'nonce', 'signature'] as const;

export type SignerProof = Readonly<{
  version: 1;
  sourceComputer: string;
  instanceId: string;
  controlGeneration: number;
  audience: string;
  method: 'POST';
  path: string;
  bodySha256: string;
  issuedAtMs: number;
  nonce: string;
  signature: string;
}>;
/** Runs the signer argv with `input` on stdin; resolves stdout or rejects. */
export type SignerRunner = (argv: readonly string[], input: string) => Promise<string>;

/** 1-8 non-empty argv strings without NUL, an absolute executable, bounded length. */
export function validateSignerCommand(argv: unknown): argv is readonly string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > ARGV_MAX_PARTS) return false;
  let total = 0;
  for (const part of argv) {
    if (typeof part !== 'string' || part.length === 0 || part.includes('\u0000')) return false;
    total += part.length;
  }
  return total <= ARGV_MAX_LENGTH && path.isAbsolute(argv[0] as string);
}

/** The raw setting: null when unset or blank, 'invalid' when present but unusable. */
export function parseSupervisorSignerCommand(raw: string | undefined): readonly string[] | null | 'invalid' {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const argv = JSON.parse(raw) as unknown;
    return validateSignerCommand(argv) ? Object.freeze([...argv]) : 'invalid';
  } catch { return 'invalid'; }
}

/** Spawn without a shell; kill on timeout or oversized stdout; require exit 0. */
export function runSignerCommand(argv: readonly string[], input: string,
  limits: Readonly<{ timeoutMs?: number; maxOutputBytes?: number }> = {}): Promise<string> {
  const timeoutMs = limits.timeoutMs ?? SIGNER_TIMEOUT_MS;
  const maxOutputBytes = limits.maxOutputBytes ?? SIGNER_OUTPUT_LIMIT;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { shell: false, stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true });
    } catch (error) { reject(error); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | null, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        reject(error);
      } else resolve(output ?? '');
    };
    const timer = setTimeout(() => finish(new Error('Signer timed out.')), timeoutMs);
    child.on('error', error => finish(error));
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) { finish(new Error('Signer output too large.')); return; }
      chunks.push(chunk);
    });
    child.on('close', code => {
      if (code === 0) finish(null, Buffer.concat(chunks).toString('utf8'));
      else finish(new Error('Signer failed.'));
    });
    child.stdin!.on('error', () => { /* a signer may exit before reading; the exit code decides */ });
    child.stdin!.end(input);
  });
}

const safeNonNegative = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const boundedString = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** Strictly validate signer stdout against the exact request being verified. */
export function parseSignerProof(stdout: string, expected: Readonly<{ sourceComputer: string;
  audience: string; path: string; bodySha256: string }>): SignerProof | null {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proof = value as Record<string, unknown>;
  const keys = Object.keys(proof);
  if (keys.length !== PROOF_KEYS.length || !PROOF_KEYS.every(key => Object.prototype.hasOwnProperty.call(proof, key))) return null;
  if (!SHA256_HEX.test(expected.bodySha256)) return null;
  return proof.version === 1 &&
    proof.sourceComputer === expected.sourceComputer &&
    proof.audience === expected.audience &&
    proof.method === 'POST' &&
    proof.path === expected.path &&
    proof.bodySha256 === expected.bodySha256 &&
    typeof proof.signature === 'string' && SIGNATURE.test(proof.signature) &&
    boundedString(proof.instanceId, 64) &&
    safeNonNegative(proof.controlGeneration) &&
    safeNonNegative(proof.issuedAtMs) &&
    boundedString(proof.nonce, 128) ? proof as unknown as SignerProof : null;
}

/** Header value: unpadded base64url of the proof's JSON serialization. */
export function encodeSignerProof(proof: SignerProof): string {
  return Buffer.from(JSON.stringify(proof), 'utf8').toString('base64url');
}

export type SupervisorSigner = Readonly<{ signerCommand: readonly string[]; proofHeader: string }>;

/** Read the signer settings once from the given environment. A signer command
 * needs a valid proof header name; a header name without a command, or either
 * value malformed, is invalid. Null when neither is set. */
export function supervisorSignerSetting(
  source: Readonly<Record<string, string | undefined>> = process.env,
): SupervisorSigner | null | 'invalid' {
  const command = parseSupervisorSignerCommand(source[SUPERVISOR_SIGNER_SETTING]);
  const rawHeader = source[SUPERVISOR_PROOF_HEADER_SETTING];
  const header = rawHeader === undefined || rawHeader.trim() === '' ? null : rawHeader;
  if (command === 'invalid') return 'invalid';
  if (command === null) return header === null ? null : 'invalid';
  return validateProofHeader(header) ? { signerCommand: command, proofHeader: header } : 'invalid';
}
