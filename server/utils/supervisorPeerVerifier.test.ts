import { describe, expect, it } from 'bun:test';
import type { Request } from 'express';
import { createSupervisorPeerVerifier } from './supervisorPeerVerifier';

const threadId = '00000000-0000-4000-8000-000000000001';
const config = { verifyUrl: 'https://verifier.example.test/v1/peer-supervisor-claim',
  audience: 'https://verifier.example.test', targetComputer: 'target-1' };
const grant = { issuer: 'interpreter-blue-enrolled-peer', subject: 'source-1',
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
  it('rejects unconfigured or unsafe verification destinations', () => {
    expect(() => createSupervisorPeerVerifier({ ...config, verifyUrl: 'http://localhost:3000/' })).toThrow();
    expect(() => createSupervisorPeerVerifier({ ...config,
      audience: 'https://different.example.test' })).toThrow();
    expect(() => createSupervisorPeerVerifier({ ...config, targetComputer: '../target' })).toThrow();
  });
});
