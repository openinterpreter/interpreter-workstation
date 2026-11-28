import { describe, expect, test } from 'bun:test';
import {
  blankDirectoryState, decodeDirectoryState, ServerDirectory, validateDirectoryState,
  type DirectoryState, type EnterpriseStateStore,
} from './serverDirectory';

const issuer = 'https://idp.example/a';
const domain = 'acme.example';

/** Single-tenant in-memory store with a synthetic global claim registry, so
 * domain-bound sessions (production's only session kind) can be exercised
 * without a database. The real RLS claim registry is covered by the live
 * PostgreSQL fixture. */
async function fixture() {
  let serialized = JSON.stringify(blankDirectoryState());
  let claimed = true;
  let answers: string[][] = [];
  let outage = false;
  let duringLookup: (() => void) | null = null;
  const queries: string[] = [];
  const change = async <T>(fn: (data: DirectoryState) => T): Promise<T> => {
    const data = decodeDirectoryState(serialized);
    const result = fn(data);
    validateDirectoryState(data);
    serialized = JSON.stringify(data);
    return result;
  };
  const store: EnterpriseStateStore = {
    requiresPagedAudit: true,
    read: async () => decodeDirectoryState(serialized),
    change: (fn) => change(fn),
    domainClaimStatus: async (org, claimIssuer, claimDomain) =>
      claimed && org === 'org-a' && claimIssuer === issuer && claimDomain === domain,
    changeWithDomainClaim: async (org, claimIssuer, claimDomain, fn) => {
      if (!claimed || org !== 'org-a' || claimIssuer !== issuer || claimDomain !== domain) {
        throw new Error('Verified account domain required');
      }
      return change(fn);
    },
    probeDomainRecovery: async (org, claimIssuer, claimDomain) => {
      const tenant = decodeDirectoryState(serialized).organizations[org];
      const proof = tenant?.domainProofs?.[claimDomain];
      return Boolean(org === 'org-a' && claimIssuer === tenant?.issuer && proof?.issuer === claimIssuer &&
        proof.verifiedUntil && proof.verifiedUntil <= Date.now());
    },
  };
  const directory = new ServerDirectory(store, async (name) => {
    queries.push(name);
    duringLookup?.();
    if (outage) throw new Error('Synthetic DNS outage');
    return answers;
  });
  await directory.bootstrap('org-a', 'Acme', issuer,
    { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
  const setup = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000);
  const challenge = await directory.beginDomainProof(setup.identity, domain);
  answers = [[challenge.value]];
  await directory.confirmDomainProof(setup.identity, domain);
  const bound = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000, 0, domain);
  const proof = () => decodeDirectoryState(serialized).organizations['org-a']!.domainProofs![domain]!;
  const editProof = (edit: (value: ReturnType<typeof proof>) => void) => {
    const data = decodeDirectoryState(serialized);
    edit(data.organizations['org-a']!.domainProofs![domain]!);
    serialized = JSON.stringify(data); // Only this disposable fixture simulates time passing.
  };
  return { directory, bound, queries, proof, editProof,
    recoveryCount: () => Object.values(decodeDirectoryState(serialized).sessions).filter((session) => session.recoveryOnly).length,
    dns: (values: string[][]) => { answers = values; }, outage: (value: boolean) => { outage = value; },
    duringLookup: (hook: (() => void) | null) => { duringLookup = hook; },
    claim: (value: boolean) => { claimed = value; } };
}

describe('domain lease renewal keeps domain-bound sessions usable', () => {
  test('a verified tenant creating a new challenge keeps its sessions and verifiedUntil', async () => {
    const { directory, bound, proof } = await fixture();
    const before = proof().verifiedUntil;
    expect(before).toBeGreaterThan(Date.now());
    await directory.beginDomainProof(bound.identity, domain);
    expect(proof().verifiedUntil).toBe(before);
    expect((await directory.verifySession(bound.token))?.subject).toBe('alice');
    expect((await directory.verifyBoundSession(bound.token, domain))?.subject).toBe('alice');
    expect(await directory.sessionIsActive(bound.identity)).toBe(true);
    expect(await directory.readAdmin(bound.identity, 'members')).not.toBeNull();
  });

  test('a verify whose challenge is no longer live leaves verifiedUntil unchanged', async () => {
    const { directory, bound, proof, editProof, dns, duringLookup } = await fixture();
    const before = proof().verifiedUntil;
    dns([]); // Even a negative answer does not count without a live challenge.
    duringLookup(() => editProof((value) => { value.expiresAt = Date.now() - 1; }));
    await expect(directory.confirmDomainProof(bound.identity, domain)).rejects.toThrow('Access denied');
    duringLookup(null);
    expect(proof().verifiedUntil).toBe(before);
    await expect(directory.confirmDomainProof(bound.identity, domain)).rejects.toThrow('Access denied');
    expect(proof().verifiedUntil).toBe(before);
    expect((await directory.verifySession(bound.token))?.subject).toBe('alice');
  });

  test('a verify where the resolver throws leaves verifiedUntil unchanged', async () => {
    const { directory, bound, proof, outage } = await fixture();
    const before = proof().verifiedUntil;
    outage(true);
    await expect(directory.confirmDomainProof(bound.identity, domain)).rejects.toThrow('DNS verification unavailable');
    expect(proof().verifiedUntil).toBe(before);
    expect((await directory.verifySession(bound.token))?.subject).toBe('alice');
  });

  test('a live challenge with a wrong DNS answer clears verifiedUntil', async () => {
    const { directory, bound, proof, dns } = await fixture();
    await directory.beginDomainProof(bound.identity, domain);
    expect(proof().verifiedUntil).toBeGreaterThan(Date.now());
    dns([['interpreter-workstation-verification=' + 'a'.repeat(43)]]);
    await expect(directory.confirmDomainProof(bound.identity, domain)).rejects.toThrow('Access denied');
    expect(proof().verifiedUntil).toBeUndefined();
    expect(await directory.verifySession(bound.token)).toBeNull();
    expect(await directory.domainVerified('org-a', issuer, domain)).toBe(false);
  });

  test('a successful re-verify through a domain-bound session extends verifiedUntil', async () => {
    const { directory, bound, proof, editProof, dns } = await fixture();
    const shortened = Date.now() + 1000;
    editProof((value) => { value.verifiedUntil = shortened; });
    const renewal = await directory.beginDomainProof(bound.identity, domain);
    dns([[renewal.value]]);
    await directory.confirmDomainProof(bound.identity, domain);
    expect(proof().verifiedUntil).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
    expect((await directory.verifySession(bound.token))?.subject).toBe('alice');
  });

  test('a live administrator session can renew a lapsed lease for its own bound domain only', async () => {
    const { directory, bound, proof, editProof, dns, claim } = await fixture();
    const revoked = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000, 0, domain);
    await directory.revokeSession(revoked.identity);
    editProof((value) => { value.verifiedUntil = Date.now() - 1; });
    // Ordinary use of the lapsed lease is denied.
    expect(await directory.verifySession(bound.token)).toBeNull();
    expect(await directory.verifyBoundSession(bound.token, domain)).toBeNull();
    expect(await directory.readAdmin(bound.identity, 'members')).toBeNull();
    // Renewal is not: the session is live, the member active, the claim held.
    expect((await directory.verifyBoundSessionForDomainRenewal(bound.token, domain))?.subject).toBe('alice');
    expect(await directory.verifyBoundSessionForDomainRenewal(revoked.token, domain)).toBeNull();
    expect(await directory.verifyBoundSessionForDomainRenewal(bound.token, 'other.example')).toBeNull();
    await expect(directory.beginDomainProof(bound.identity, 'other.example')).rejects.toThrow();
    const renewal = await directory.beginDomainProof(bound.identity, domain);
    expect((await directory.domainProofStatus(bound.identity, domain)).challengeExpiresAt).toBe(renewal.expiresAt);
    dns([[renewal.value]]);
    await directory.confirmDomainProof(bound.identity, domain);
    expect(proof().verifiedUntil).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
    expect((await directory.verifySession(bound.token))?.subject).toBe('alice');
    // Without the global claim there is no renewal path.
    editProof((value) => { value.verifiedUntil = Date.now() - 1; });
    claim(false);
    expect(await directory.verifyBoundSessionForDomainRenewal(bound.token, domain)).toBeNull();
    await expect(directory.beginDomainProof(bound.identity, domain)).rejects.toThrow();
  });

  test('a lapsed lease with no surviving bound administrator session needs operator recovery', async () => {
    const { directory, bound, editProof, claim, queries } = await fixture();
    const priorQueries = queries.length;
    await directory.revokeSession(bound.identity);
    editProof((value) => { value.verifiedUntil = Date.now() - 1; });
    expect(await directory.verifyBoundSessionForDomainRenewal(bound.token, domain)).toBeNull();
    expect(await directory.domainClaimVerifiedForLogin('org-a', issuer, domain)).toBe(false);
    await expect(directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000, 0, domain))
      .rejects.toThrow('Verified account domain required');
    await expect(directory.beginDomainProof(bound.identity, domain)).rejects.toThrow('Access denied');
    expect(queries).toHaveLength(priorQueries);
    claim(false);
    expect(await directory.verifyBoundSessionForDomainRenewal(bound.token, domain)).toBeNull();
  });
  test('a recovery-only administrator session cannot become an ordinary admin cookie', async () => {
    const { directory, bound, editProof, dns, proof, claim } = await fixture();
    await directory.revokeSession(bound.identity);
    editProof((value) => { value.verifiedUntil = Date.now() - 1; });
    const recovery = await directory.createDomainRecoverySession(issuer, 'org-a', 'alice',
      Date.now() + 60_000, 0, domain);
    expect(await directory.verifySession(recovery.token)).toBeNull();
    expect(await directory.verifyBoundSession(recovery.token, domain)).toBeNull();
    expect(await directory.sessionIsActive(recovery.identity)).toBe(false);
    expect(await directory.readAdmin(recovery.identity, 'members')).toBeNull();
    expect((await directory.verifyBoundSessionForDomainRenewal(recovery.token, domain))?.subject).toBe('alice');
    await expect(directory.beginDomainProof(recovery.identity, 'other.example')).rejects.toThrow('Access denied');
    const next = await directory.beginDomainProof(recovery.identity, domain);
    dns([[next.value]]);
    await directory.confirmDomainProof(recovery.identity, domain);
    expect(proof().verifiedUntil).toBeGreaterThan(Date.now());
    expect(await directory.verifySession(recovery.token)).toBeNull();
    expect((await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000, 0, domain)).identity.subject).toBe('alice');
    claim(false);
    expect(await directory.verifyBoundSessionForDomainRenewal(recovery.token, domain)).toBeNull();
  });
  test('recovery requires expired prior proof, current admin, epoch and held domain claim', async () => {
    const { directory, bound, editProof, claim } = await fixture();
    const attempt = () => directory.createDomainRecoverySession(issuer, 'org-a', 'alice', Date.now() + 60_000, 0, domain);
    await expect(attempt()).rejects.toThrow('Domain recovery is unavailable');
    editProof((value) => { value.verifiedUntil = Date.now() - 1; });
    await expect(directory.createDomainRecoverySession(issuer, 'org-a', 'alice', Date.now() + 60_000, 1, domain))
      .rejects.toThrow('Domain recovery is unavailable');
    await expect(directory.createDomainRecoverySession(issuer, 'org-a', 'alice', Date.now() + 11 * 60_000, 0, domain))
      .rejects.toThrow('Invalid recovery identity');
    claim(false);
    await expect(attempt()).rejects.toThrow('Verified account domain required');
    expect(await directory.verifySession(bound.token)).toBeNull();
  });
  test('repeated recovery exchanges remove superseded token hashes and audit rotation', async () => {
    const { directory, editProof, recoveryCount } = await fixture();
    editProof((value) => { value.verifiedUntil = Date.now() - 1; });
    let prior: string | null = null;
    for (let index = 0; index < 12; index++) {
      const session = await directory.createDomainRecoverySession(issuer, 'org-a', 'alice', Date.now() + 60_000, 0, domain);
      if (prior) expect(await directory.verifyBoundSessionForDomainRenewal(prior, domain)).toBeNull();
      expect((await directory.verifyBoundSessionForDomainRenewal(session.token, domain))?.subject).toBe('alice');
      prior = session.token;
    }
    expect(recoveryCount()).toBe(1);
    const events = await directory.auditSummary('org-a');
    expect(events.eventCount).toBeGreaterThan(12);
  });
});
