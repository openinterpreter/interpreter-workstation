import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerDirectory, verifiedDomainName } from './serverDirectory';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'enterprise-domain-proof-'));
  paths.push(path);
  const file = join(path, 'private', 'directory.json');
  let answers: string[][] = [];
  let outage = false;
  const queries: string[] = [];
  const resolver = async (name: string): Promise<string[][]> => {
    queries.push(name);
    if (outage) throw new Error('DNS unavailable');
    return answers;
  };
  const first = new ServerDirectory(file, resolver);
  const second = new ServerDirectory(file, resolver);
  const issuerA = 'https://idp.example/a', issuerB = 'https://idp.example/b';
  await first.bootstrap('org-a', 'Alpha', issuerA,
    { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
  await first.bootstrap('org-b', 'Beta', issuerB,
    { organizationId: 'org-b', subject: 'bob', displayName: 'Bob', role: 'admin', active: true });
  const admin = await first.createSession(issuerA, 'org-a', 'alice', Date.now() + 60_000);
  const foreign = await first.createSession(issuerB, 'org-b', 'bob', Date.now() + 60_000);
  await first.setMember(admin.identity,
    { organizationId: 'org-a', subject: 'carol', displayName: 'Carol', role: 'member', active: true });
  const member = await first.createSession(issuerA, 'org-a', 'carol', Date.now() + 60_000);
  return { first, second, file, admin, foreign, member, issuerA, issuerB, queries,
    dns: (values: string[][]) => { answers = values; }, outage: (value: boolean) => { outage = value; } };
}

describe('unmounted operator domain-proof boundary', () => {
  test('does not resolve unchallenged, foreign or expired domains', async () => {
    const { first, second, file, admin, foreign, queries } = await fixture();
    await expect(first.confirmDomainProof(admin.identity, 'unchallenged.test')).rejects.toThrow('Access denied');
    await first.beginDomainProof(admin.identity, 'reserved.test');
    await expect(second.confirmDomainProof(foreign.identity, 'reserved.test')).rejects.toThrow('Access denied');
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.organizations['org-a'].domainProofs['reserved.test'].expiresAt = Date.now() - 1;
    await writeFile(file, JSON.stringify(state));
    await expect(second.confirmDomainProof(admin.identity, 'reserved.test')).rejects.toThrow('Access denied');
    expect(queries).toEqual([]);
    const ownDenials = (await first.listAudit(admin.identity)).filter((event) =>
      event.action === 'organization.domain.verify' && event.outcome === 'denied');
    const foreignDenials = (await first.listAudit(foreign.identity)).filter((event) =>
      event.action === 'organization.domain.verify' && event.outcome === 'denied');
    expect(ownDenials).toHaveLength(2);
    expect(foreignDenials).toHaveLength(1);
  });
  test('requires exact DNS ownership, current tenant admin and issuer; stores only a digest', async () => {
    const { first, second, file, admin, foreign, member, issuerA, issuerB, dns, queries } = await fixture();
    expect(verifiedDomainName('Acme.Example')).toBe('acme.example');
    for (const bad of ['localhost', '127.0.0.1', '*.example.com', 'example.com.', 'example..com',
      'example.com:443', 'bad/domain.com', '-bad.example', 'bad-.example', 'x'.repeat(230) + '.example']) {
      expect(verifiedDomainName(bad) === null || bad.length > 228).toBe(true);
      await expect(first.beginDomainProof(admin.identity, bad)).rejects.toThrow('Access denied');
    }
    const challenge = await first.beginDomainProof(admin.identity, 'Acme.Example');
    expect(challenge.name).toBe('_interpreter-workstation.acme.example');
    expect(challenge.value).toMatch(/^interpreter-workstation-verification=[A-Za-z0-9_-]{43}$/);
    expect(await readFile(file, 'utf8')).not.toContain(challenge.value.split('=')[1]!);
    expect(await second.domainVerified('org-a', issuerA, 'acme.example')).toBe(false);
    await expect(second.beginDomainProof(member.identity, 'acme.example')).rejects.toThrow('Access denied');
    await expect(second.confirmDomainProof(member.identity, 'acme.example')).rejects.toThrow('Access denied');
    expect(queries).toEqual([]); // A member cannot induce server DNS lookups.
    dns([[challenge.value.slice(0, 25), challenge.value.slice(25)]]); // DNS TXT chunks form one record.
    await second.confirmDomainProof(admin.identity, 'acme.example');
    expect(queries).toContain(challenge.name);
    expect(await first.domainVerified('org-a', issuerA, 'ACME.EXAMPLE')).toBe(true);
    expect(await first.domainVerified('org-a', issuerB, 'acme.example')).toBe(false);
    expect(await second.domainVerified('org-b', issuerB, 'acme.example')).toBe(false);
    expect((await first.listAudit(admin.identity)).filter((event) => event.action.startsWith('organization.domain.'))
      .map((event) => [event.targetDomain, event.outcome])).toEqual([
        ['acme.example', 'allowed'], ['acme.example', 'denied'], ['acme.example', 'denied'], ['acme.example', 'allowed'],
      ]);
    expect((await second.auditSummary('org-b')).eventCount).toBe(2); // Bootstrap and login only.
    await expect(first.confirmDomainProof({ ...foreign.identity, organizationId: 'org-a' }, 'acme.example'))
      .rejects.toThrow('Access denied');
  });

  test('rotated, expired, missing and ambiguous proofs deny; explicit DNS outage clears prior verification', async () => {
    const { first, second, file, admin, issuerA, dns, outage } = await fixture();
    const old = await first.beginDomainProof(admin.identity, 'example.test');
    const rotated = await second.beginDomainProof(admin.identity, 'example.test');
    dns([[old.value]]);
    await expect(first.confirmDomainProof(admin.identity, 'example.test')).rejects.toThrow('Access denied');
    dns([[rotated.value], [rotated.value]]);
    await expect(second.confirmDomainProof(admin.identity, 'example.test')).rejects.toThrow('Access denied');
    dns([[rotated.value], ['interpreter-workstation-verification=' + 'a'.repeat(43)]]);
    await expect(second.confirmDomainProof(admin.identity, 'example.test')).rejects.toThrow('Access denied');
    dns([[rotated.value], ['unrelated-application=present']]);
    await first.confirmDomainProof(admin.identity, 'example.test');
    expect(await second.domainVerified('org-a', issuerA, 'example.test')).toBe(true);
    outage(true);
    await expect(second.confirmDomainProof(admin.identity, 'example.test')).rejects.toThrow('DNS verification unavailable');
    expect(await first.domainVerified('org-a', issuerA, 'example.test')).toBe(false);
    outage(false);
    const fresh = await first.beginDomainProof(admin.identity, 'example.test');
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.organizations['org-a'].domainProofs['example.test'].expiresAt = Date.now() - 1;
    await writeFile(file, JSON.stringify(state)); // Only this disposable fixture simulates expiry.
    dns([[fresh.value]]);
    await expect(second.confirmDomainProof(admin.identity, 'example.test')).rejects.toThrow('Access denied');
    expect(await first.domainVerified('org-a', issuerA, 'example.test')).toBe(false);
  });

  test('a concurrent challenge rotation denies an earlier DNS response across two hosts', async () => {
    const { first, second, file, admin, issuerA } = await fixture();
    const old = await first.beginDomainProof(admin.identity, 'northstar.test');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new ServerDirectory(file, async () => {
      entered(); await gate; return [[old.value]];
    });
    const verification = waiting.confirmDomainProof(admin.identity, 'northstar.test');
    try {
      await started;
      await second.beginDomainProof(admin.identity, 'northstar.test');
    } finally { release(); }
    await expect(verification).rejects.toThrow('Access denied');
    expect(await first.domainVerified('org-a', issuerA, 'northstar.test')).toBe(false);
  });

  test('an organization session kill during DNS lookup denies the pending confirmation', async () => {
    const { first, second, file, admin, issuerA } = await fixture();
    await first.setMember(admin.identity,
      { organizationId: 'org-a', subject: 'dave', displayName: 'Dave', role: 'admin', active: true });
    const operator = await second.createSession(issuerA, 'org-a', 'dave', Date.now() + 60_000);
    const challenge = await first.beginDomainProof(admin.identity, 'northstar.test');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new ServerDirectory(file, async () => {
      entered(); await gate; return [[challenge.value]];
    });
    const verification = waiting.confirmDomainProof(admin.identity, 'northstar.test');
    try {
      await started;
      await second.revokeOrganizationSessions(operator.identity);
    } finally { release(); }
    await expect(verification).rejects.toThrow('Access denied');
    expect(await first.domainVerified('org-a', issuerA, 'northstar.test')).toBe(false);
  });

  test('one shared directory never grants overlapping organization domain leases', async () => {
    const { first, second, file, admin, foreign, issuerA, issuerB, dns } = await fixture();
    const original = await first.beginDomainProof(admin.identity, 'shared.test');
    await expect(second.beginDomainProof(foreign.identity, 'shared.test')).rejects.toThrow('Access denied');
    dns([[original.value]]);
    await second.confirmDomainProof(admin.identity, 'shared.test');
    expect(await first.domainVerified('org-a', issuerA, 'shared.test')).toBe(true);
    await expect(first.beginDomainProof(foreign.identity, 'shared.test')).rejects.toThrow('Access denied');
    // A compromised duplicate lease is not accepted even when the target
    // tenant's TXT token is present; this test alters only a throwaway file.
    const duplicate = JSON.parse(await readFile(file, 'utf8'));
    duplicate.organizations['org-b'].domainProofs = { 'shared.test': {
      issuer: issuerB, challengeHash: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    } };
    await writeFile(file, JSON.stringify(duplicate));
    expect(await second.domainVerified('org-a', issuerA, 'shared.test')).toBe(false);
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.organizations['org-a'].domainProofs['shared.test'].expiresAt = Date.now() - 1;
    state.organizations['org-a'].domainProofs['shared.test'].verifiedUntil = Date.now() - 1;
    delete state.organizations['org-b'].domainProofs;
    await writeFile(file, JSON.stringify(state));
    const transferred = await second.beginDomainProof(foreign.identity, 'shared.test');
    await expect(first.beginDomainProof(admin.identity, 'shared.test')).rejects.toThrow('Access denied');
    dns([[transferred.value]]);
    await first.confirmDomainProof(foreign.identity, 'shared.test');
    expect(await second.domainVerified('org-a', issuerA, 'shared.test')).toBe(false);
    expect(await second.domainVerified('org-b', issuerB, 'shared.test')).toBe(true);
    const foreignEvents = await second.listAudit(foreign.identity);
    expect(foreignEvents.filter((event) => event.action === 'organization.domain.challenge')
      .map((event) => event.outcome)).toEqual(['denied', 'denied', 'allowed']);
  });
  test('status is a persisted, audited admin read without the challenge or another tenant proof', async () => {
    const { first, second, admin, foreign, member, issuerA, dns } = await fixture();
    const challenge = await first.beginDomainProof(admin.identity, 'status.test');
    const pending = await second.domainProofStatus(admin.identity, 'status.test');
    expect(pending).toEqual({ domain: 'status.test', challengeExpiresAt: challenge.expiresAt, verifiedUntil: null });
    expect(JSON.stringify(pending)).not.toContain(challenge.value.split('=')[1]!);
    await expect(first.domainProofStatus(member.identity, 'status.test')).rejects.toThrow('Access denied');
    expect(await second.domainProofStatus(foreign.identity, 'status.test')).toEqual({ domain: 'status.test',
      challengeExpiresAt: null, verifiedUntil: null });
    dns([[challenge.value]]);
    await second.confirmDomainProof(admin.identity, 'status.test');
    const observed = await first.domainProofStatus(admin.identity, 'status.test');
    expect(observed.verifiedUntil).toBeGreaterThan(Date.now());
    expect(await first.domainVerified('org-a', issuerA, 'status.test')).toBe(true);
    const events = await first.listAudit(admin.identity);
    expect(events.filter((event) => event.action === 'organization.domain.status')
      .map((event) => [event.organizationId, event.outcome])).toEqual([
        ['org-a', 'allowed'], ['org-a', 'denied'], ['org-a', 'allowed'],
      ]);
    await first.revokeSession(admin.identity);
    await expect(second.domainProofStatus(admin.identity, 'status.test')).rejects.toThrow('Access denied');
  });
});
