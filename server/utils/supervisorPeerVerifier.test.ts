import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { createSupervisorPeerVerifier } from './supervisorPeerVerifier';
import { parseSupervisorSignerCommand, runSignerCommand,
  supervisorSignerSetting } from './supervisorPeerSigner';

const SUPERVISOR_PROOF_HEADER = 'x-example-request-proof';

const threadId = '00000000-0000-4000-8000-000000000001';
const config = { verifyUrl: 'https://verifier.example.test/v1/supervisor-verify',
  audience: 'https://verifier.example.test', targetComputer: 'target-1' };
const grant = { issuer: 'enrolled-issuer', subject: 'source-1',
  sourceComputer: 'source-1', targetComputer: 'target-1', threadId,
  capabilities: ['goal:read'], expiresAt: Date.now() + 30_000 };
function req(path = `/threads/${threadId}/goal`, assertion = 'owned.assertion') {
  return { params: { threadId }, path,
    get: (name: string) => name === 'x-interpreter-supervisor-assertion' ? assertion : undefined } as Request;
}

describe('optional enrolled target peer verifier', () => {
  it('uses only the target identity and validates exact returned grant', async () => {
    const calls: string[] = [];
    const verify = createSupervisorPeerVerifier(config, {
      identity: async audience => { expect(audience).toBe(config.audience); return 'a.b.c'; },
      fetcher: (async (url: URL, init: RequestInit) => {
        expect(String(url)).toBe(config.verifyUrl);
        expect(init.redirect).toBe('error');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer a.b.c');
        calls.push(JSON.stringify(JSON.parse(String(init.body))));
        return new Response(JSON.stringify(grant));
      }) as typeof fetch,
    });
    expect(await verify(req())).toEqual(grant);
    expect(JSON.parse(calls[0])).toEqual({ action: 'verify', assertion: 'owned.assertion',
      targetComputer: 'target-1', threadId, capability: 'goal:read' });
    expect(await verify(req(`/threads/${threadId}/goal/resume`))).toBeNull();
    expect(await verify(req(`/threads/${threadId}/goal/create`))).toBeNull();
    expect(await verify(req(`/threads/${threadId}/goal`, 'bad assertion'))).toBeNull();
    expect(calls).toHaveLength(3);
  });
  it('denies wrong owner, stale grant, errors and late response without accepting supplied assertion', async () => {
    for (const response of [{ ...grant, threadId: '00000000-0000-4000-8000-000000000002' },
      { ...grant, expiresAt: Date.now() - 1 }, { ...grant, sourceComputer: '' }]) {
      const verify = createSupervisorPeerVerifier(config, { identity: async () => 'a.b.c',
        fetcher: (async () => new Response(JSON.stringify(response))) as typeof fetch });
      expect(await verify(req())).toBeNull();
    }
    const verify = createSupervisorPeerVerifier(config, { identity: async () => 'a.b.c',
      fetcher: (async () => { throw Error('private upstream text'); }) as typeof fetch });
    expect(await verify(req())).toBeNull();
  });
  it('keeps a machine identity until shortly before its stated expiry and drops a refused one', async () => {
    const signed = (expSeconds: number) =>
      `a.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.c`;
    let reads = 0;
    let status = 200;
    const longLived = signed(Math.floor(Date.now() / 1000) + 3600);
    const verify = createSupervisorPeerVerifier(config, {
      identity: async () => { reads++; return longLived; },
      fetcher: (async () => new Response(JSON.stringify(grant), { status })) as typeof fetch });
    expect(await verify(req())).toEqual(grant);
    expect(await verify(req())).toEqual(grant);
    expect(reads).toBe(1);
    status = 401;
    expect(await verify(req())).toBeNull();
    status = 200;
    expect(await verify(req())).toEqual(grant);
    expect(reads).toBe(2);
    // An identity about to expire, or one whose expiry cannot be read, is not kept.
    for (const token of [signed(Math.floor(Date.now() / 1000) + 60), 'a.b.c']) {
      let count = 0;
      const fresh = createSupervisorPeerVerifier(config, {
        identity: async () => { count++; return token; },
        fetcher: (async () => new Response(JSON.stringify(grant))) as typeof fetch });
      await fresh(req());
      await fresh(req());
      expect(count).toBe(2);
    }
  });
  it('asks enrolled verifier for status-update capability, not a generic Goal grant', async () => {
    const calls: string[] = [];
    const selfGrant = { ...grant, sourceComputer: 'target-1',
      capabilities: ['goal:status-update'] };
    const verify = createSupervisorPeerVerifier(config, {
      identity: async () => 'a.b.c',
      fetcher: (async (_url: URL, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)).capability);
        return new Response(JSON.stringify(selfGrant));
      }) as typeof fetch,
    });
    expect(await verify(req(`/threads/${threadId}/goal/status`))).toEqual(selfGrant);
    expect(calls).toEqual(['goal:status-update']);
  });
  it('requires separate exact Objective and Document amendment capabilities', async () => {
    const capabilities: string[] = [];
    const verify = createSupervisorPeerVerifier(config, {
      identity: async () => 'a.b.c',
      fetcher: (async (_url: URL, init: RequestInit) => {
        const capability = JSON.parse(String(init.body)).capability;
        capabilities.push(capability);
        return new Response(JSON.stringify({ ...grant, capabilities: [capability] }));
      }) as typeof fetch,
    });
    expect(await verify(req(`/threads/${threadId}/goal/objective`))).not.toBeNull();
    expect(await verify(req(`/threads/${threadId}/goal/document`))).not.toBeNull();
    expect(capabilities).toEqual(['goal:objective-update', 'goal:document-update']);
  });
  it('asks for command:read on terminal status and the terminal owners list', async () => {
    const capabilities: string[] = [];
    const verify = createSupervisorPeerVerifier(config, {
      identity: async () => 'a.b.c',
      fetcher: (async (_url: URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ action: 'verify', assertion: 'owned.assertion',
          targetComputer: 'target-1', threadId, capability: body.capability });
        capabilities.push(body.capability);
        return new Response(JSON.stringify({ ...grant, capabilities: [body.capability] }));
      }) as typeof fetch,
    });
    expect(await verify(req(`/threads/${threadId}/terminals`))).not.toBeNull();
    expect(await verify(req(`/threads/${threadId}/terminals/status`))).not.toBeNull();
    // An id that happens to read "terminals" keeps its own route's capability.
    expect(await verify(req(`/threads/${threadId}/submissions/terminals`))).not.toBeNull();
    expect(await verify(req(`/threads/${threadId}/artifacts/terminals`))).not.toBeNull();
    expect(capabilities).toEqual(['command:read', 'command:read', 'task:read', 'artifact:read']);
  });
  it('maps every supervisor peer route to a capability', async () => {
    const source = await readFile(path.join(import.meta.dir, '../routes/supervisorPeer.ts'), 'utf8');
    const routes = [...source.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)]
      .map(match => match[1]);
    expect(routes.length).toBeGreaterThan(0);
    const capabilities: string[] = [];
    const verify = createSupervisorPeerVerifier(config, {
      identity: async () => 'a.b.c',
      fetcher: (async (_url: URL, init: RequestInit) => {
        const capability = JSON.parse(String(init.body)).capability;
        capabilities.push(capability);
        return new Response(JSON.stringify({ ...grant, capabilities: [capability] }));
      }) as typeof fetch,
    });
    for (const route of routes) {
      const concrete = route.replace(':threadId', threadId).replace(/:[A-Za-z]+/g, 'id-1');
      expect({ route, verified: await verify(req(concrete)) !== null })
        .toEqual({ route, verified: true });
    }
    expect(capabilities).toHaveLength(routes.length);
  });
  it('rejects unconfigured or unsafe verification destinations', () => {
    expect(() => createSupervisorPeerVerifier({ ...config, verifyUrl: 'http://localhost:3000/' })).toThrow();
    expect(() => createSupervisorPeerVerifier({ ...config,
      audience: 'https://different.example.test' })).toThrow();
    expect(() => createSupervisorPeerVerifier({ ...config, targetComputer: '../target' })).toThrow();
  });
});

const signerArgv = ['/opt/example/signer', '--peer'];
const signedConfig = { ...config, signerCommand: signerArgv, proofHeader: SUPERVISOR_PROOF_HEADER };
const verifyPath = '/v1/supervisor-verify';
const expectedBody = JSON.stringify({ action: 'verify', assertion: 'owned.assertion',
  targetComputer: 'target-1', threadId, capability: 'goal:read' });
const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const expectedInput = JSON.stringify({ path: verifyPath,
  bodyBase64: Buffer.from(expectedBody, 'utf8').toString('base64') });
function proofFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, sourceComputer: 'target-1', instanceId: 'instance-1', controlGeneration: 3,
    audience: config.audience, method: 'POST', path: verifyPath, bodySha256: sha256(expectedBody),
    issuedAtMs: 1_700_000_000_000, nonce: 'nonce-1', signature: 'A'.repeat(86), ...overrides };
}
function recordingFetcher(response: unknown = grant) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response));
  }) as typeof fetch;
  return { calls, fetcher };
}

describe('optional local request signer', () => {
  it('sends the exact body with a fresh request-bound proof, no Authorization and no metadata call', async () => {
    const { calls, fetcher } = recordingFetcher();
    const runs: { argv: readonly string[]; input: string }[] = [];
    const verify = createSupervisorPeerVerifier(signedConfig, { fetcher,
      runSigner: async (argv, input) => { runs.push({ argv, input }); return JSON.stringify(proofFor()); } });
    expect(await verify(req())).toEqual(grant);
    expect(await verify(req())).toEqual(grant);
    // Only the verifier was contacted; the signer ran once per verification.
    expect(calls.map(call => call.url)).toEqual([config.verifyUrl, config.verifyUrl]);
    expect(runs).toEqual([{ argv: signerArgv, input: expectedInput },
      { argv: signerArgv, input: expectedInput }]);
    const { init } = calls[0];
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.body).toBe(expectedBody);
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(['Content-Type', SUPERVISOR_PROOF_HEADER].sort());
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBeUndefined();
    const encoded = headers[SUPERVISOR_PROOF_HEADER];
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).toBe(Buffer.from(JSON.stringify(proofFor()), 'utf8').toString('base64url'));
  });

  it('rejects every proof that does not match the exact request', async () => {
    const missing = proofFor();
    delete missing.nonce;
    const bad: unknown[] = [
      proofFor({ sourceComputer: 'source-1' }), proofFor({ audience: 'https://other.example.test' }),
      proofFor({ path: '/v1/other' }), proofFor({ method: 'GET' }),
      proofFor({ bodySha256: sha256('{}') }), proofFor({ bodySha256: sha256(expectedBody).toUpperCase() }),
      proofFor({ signature: 'A'.repeat(85) }), proofFor({ signature: `${'A'.repeat(85)}=` }),
      proofFor({ signature: `${'A'.repeat(85)}+` }), proofFor({ extra: 1 }), missing,
      proofFor({ version: 2 }), proofFor({ version: '1' }),
      proofFor({ instanceId: '' }), proofFor({ instanceId: 'i'.repeat(65) }),
      proofFor({ controlGeneration: -1 }), proofFor({ controlGeneration: 1.5 }),
      proofFor({ issuedAtMs: '1' }), proofFor({ issuedAtMs: Number.MAX_SAFE_INTEGER + 1 }),
      proofFor({ nonce: '' }), proofFor({ nonce: 'n'.repeat(129) }), [proofFor()], null, 'proof',
    ];
    for (const proof of bad) {
      const { calls, fetcher } = recordingFetcher();
      const verify = createSupervisorPeerVerifier(signedConfig, { fetcher,
        runSigner: async () => JSON.stringify(proof) });
      expect(await verify(req())).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it('fails closed on signer failure, malformed output, verifier failure and oversized body', async () => {
    for (const runSigner of [async () => { throw Error('signer failed'); },
      async () => 'not json', async () => '']) {
      const { calls, fetcher } = recordingFetcher();
      const verify = createSupervisorPeerVerifier(signedConfig, { fetcher, runSigner });
      expect(await verify(req())).toBeNull();
      expect(calls).toHaveLength(0);
    }
    const failing = createSupervisorPeerVerifier(signedConfig, {
      runSigner: async () => JSON.stringify(proofFor()),
      fetcher: (async () => { throw Error('upstream unavailable'); }) as typeof fetch });
    expect(await failing(req())).toBeNull();
    let runs = 0;
    const { calls, fetcher } = recordingFetcher();
    const large = createSupervisorPeerVerifier(signedConfig, { fetcher,
      runSigner: async () => { runs++; return JSON.stringify(proofFor()); } });
    // A valid assertion that makes the verification body exceed 2048 bytes.
    expect(await large(req(`/threads/${threadId}/goal`, 'a'.repeat(2_000)))).toBeNull();
    expect(runs).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses an unusable signer argv at construction', () => {
    expect(() => createSupervisorPeerVerifier({ ...config, signerCommand: ['relative-signer'] })).toThrow();
    expect(() => createSupervisorPeerVerifier({ ...config, signerCommand: [] })).toThrow();
  });

  it('parses the signer setting as absent, valid, or invalid', () => {
    expect(parseSupervisorSignerCommand(undefined)).toBeNull();
    expect(parseSupervisorSignerCommand('')).toBeNull();
    expect(parseSupervisorSignerCommand('["/usr/local/bin/example-signer","--peer"]'))
      .toEqual(['/usr/local/bin/example-signer', '--peer']);
    for (const raw of ['not json', '{}', '"/bin/example"', '[]', '["relative-signer"]',
      '["/bin/example",""]', '["/bin/example",1]', JSON.stringify(Array(9).fill('/bin/example')),
      JSON.stringify(['/bin/example', 'a\u0000b']), JSON.stringify(['/bin/example', 'x'.repeat(1_020)])]) {
      expect(parseSupervisorSignerCommand(raw)).toBe('invalid');
    }
  });

  it('requires the signer command and the proof header name together', () => {
    const command = '["/usr/local/bin/example-signer"]';
    const both = { INTERPRETER_SUPERVISOR_SIGNER_COMMAND: command,
      INTERPRETER_SUPERVISOR_PROOF_HEADER: SUPERVISOR_PROOF_HEADER };
    expect(supervisorSignerSetting({})).toBeNull();
    expect(supervisorSignerSetting(both)).toEqual({
      signerCommand: ['/usr/local/bin/example-signer'], proofHeader: SUPERVISOR_PROOF_HEADER });
    expect(supervisorSignerSetting({ INTERPRETER_SUPERVISOR_SIGNER_COMMAND: command })).toBe('invalid');
    expect(supervisorSignerSetting({ INTERPRETER_SUPERVISOR_PROOF_HEADER: SUPERVISOR_PROOF_HEADER }))
      .toBe('invalid');
    for (const header of ['authorization', 'X-Example', 'x-', 'x-bad header', 'x-a\r\nb', `x-${'a'.repeat(70)}`]) {
      expect(supervisorSignerSetting({ ...both, INTERPRETER_SUPERVISOR_PROOF_HEADER: header })).toBe('invalid');
    }
    expect(() => createSupervisorPeerVerifier({ ...config, signerCommand: signerArgv })).toThrow();
    expect(() => createSupervisorPeerVerifier({ ...config, proofHeader: SUPERVISOR_PROOF_HEADER })).toThrow();
  });
});

describe('local request signer process boundary', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  async function script(body: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'supervisor-signer-'));
    roots.push(root);
    const file = path.join(root, 'signer.js');
    await writeFile(file, body, { mode: 0o700 });
    return { root, file };
  }
  async function gone(pid: number) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(pid, 0); } catch { return true; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  }

  it('runs the real argv without a shell, writes the exact stdin document, and reads stdout', async () => {
    const { root, file } = await script(`const fs = require('node:fs');
const dir = require('node:path').dirname(process.argv[1]);
fs.writeFileSync(dir + '/args.json', JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(dir + '/stdin.json', input);
  process.stdout.write(fs.readFileSync(dir + '/proof.json'));
});
`);
    await writeFile(path.join(root, 'proof.json'), `${JSON.stringify(proofFor())}\n`);
    const { calls, fetcher } = recordingFetcher();
    const verify = createSupervisorPeerVerifier({ ...config, proofHeader: SUPERVISOR_PROOF_HEADER,
      signerCommand: [process.execPath, file, 'two words', '$HOME;exit 1'] }, { fetcher });
    expect(await verify(req())).toEqual(grant);
    expect(JSON.parse(await readFile(path.join(root, 'args.json'), 'utf8')))
      .toEqual(['two words', '$HOME;exit 1']);
    expect(await readFile(path.join(root, 'stdin.json'), 'utf8')).toBe(expectedInput);
    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>)[SUPERVISOR_PROOF_HEADER])
      .toBe(Buffer.from(JSON.stringify(proofFor()), 'utf8').toString('base64url'));
  });

  it('kills a signer that exceeds the timeout', async () => {
    const { root, file } = await script(`require('node:fs').writeFileSync(
  require('node:path').dirname(process.argv[1]) + '/pid', String(process.pid));
setInterval(() => {}, 1000);
`);
    const started = Date.now();
    await expect(runSignerCommand([process.execPath, file], '{}', { timeoutMs: 1_000 }))
      .rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await gone(Number(await readFile(path.join(root, 'pid'), 'utf8')))).toBe(true);
  });

  it('kills a signer whose output overflows the limit', async () => {
    const { root, file } = await script(`require('node:fs').writeFileSync(
  require('node:path').dirname(process.argv[1]) + '/pid', String(process.pid));
process.stdout.write('x'.repeat(4096));
setInterval(() => {}, 1000);
`);
    await expect(runSignerCommand([process.execPath, file], '{}')).rejects.toThrow('too large');
    expect(await gone(Number(await readFile(path.join(root, 'pid'), 'utf8')))).toBe(true);
  });

  it('rejects a non-zero exit, malformed output and a missing executable', async () => {
    const failed = await script(`process.stdout.write(${JSON.stringify(JSON.stringify(proofFor()))});
process.exitCode = 3;
`);
    await expect(runSignerCommand([process.execPath, failed.file], '{}')).rejects.toThrow('failed');
    const { calls, fetcher } = recordingFetcher();
    const verify = createSupervisorPeerVerifier({ ...config, proofHeader: SUPERVISOR_PROOF_HEADER,
      signerCommand: [process.execPath, failed.file] }, { fetcher });
    expect(await verify(req())).toBeNull();
    const malformed = await script(`process.stdout.write('not json');\n`);
    const verifyMalformed = createSupervisorPeerVerifier({ ...config, proofHeader: SUPERVISOR_PROOF_HEADER,
      signerCommand: [process.execPath, malformed.file] }, { fetcher });
    expect(await verifyMalformed(req())).toBeNull();
    const missing = createSupervisorPeerVerifier({ ...config, proofHeader: SUPERVISOR_PROOF_HEADER,
      signerCommand: ['/nonexistent/example-signer'] }, { fetcher });
    expect(await missing(req())).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
