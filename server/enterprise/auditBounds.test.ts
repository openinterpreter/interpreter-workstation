import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  AUDIT_COLLAPSE_WINDOW_MS, blankDirectoryState, decodeDirectoryState, MAX_DIRECTORY_BYTES, RECOVERY_RESERVE_BYTES,
  ServerDirectory, validateDirectoryState, type DirectoryState, type EnterpriseStateStore,
} from './serverDirectory';

const issuer = 'https://idp.example/a';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Single-row in-memory store enforcing the same hard cap as the real stores. */
function memoryStore() {
  let serialized = JSON.stringify(blankDirectoryState());
  const change = async <T>(fn: (data: DirectoryState) => T): Promise<T> => {
    const data = decodeDirectoryState(serialized);
    const result = fn(data);
    validateDirectoryState(data);
    const next = JSON.stringify(data);
    if (Buffer.byteLength(next, 'utf8') > MAX_DIRECTORY_BYTES) throw new Error('Directory capacity reached');
    serialized = next;
    return result;
  };
  const store: EnterpriseStateStore = { read: async () => decodeDirectoryState(serialized), change: (fn) => change(fn) };
  return { store, raw: () => serialized, size: () => Buffer.byteLength(serialized, 'utf8'),
    edit: (fn: (data: DirectoryState) => void) => {
      const data = decodeDirectoryState(serialized);
      fn(data);
      serialized = JSON.stringify(data); // Disposable fixture only: simulates time passing or prior growth.
    } };
}

async function setup() {
  const memory = memoryStore();
  const directory = new ServerDirectory(memory.store);
  await directory.bootstrap('org-a', 'Acme', issuer,
    { organizationId: 'org-a', subject: 'alice', displayName: 'Alice', role: 'admin', active: true });
  const admin = await directory.createSession(issuer, 'org-a', 'alice', Date.now() + 60_000);
  await directory.setMember(admin.identity,
    { organizationId: 'org-a', subject: 'carol', displayName: 'Carol', role: 'member', active: true });
  const member = await directory.createSession(issuer, 'org-a', 'carol', Date.now() + 60_000);
  return { ...memory, directory, admin, member };
}

describe('member-driven audit growth is bounded and a full tenant stays recoverable', () => {
  test('a member repeating a denied read 5,000 times grows the stored snapshot by less than a small fixed bound', async () => {
    const { directory, member, size } = await setup();
    const before = size();
    for (let i = 0; i < 5000; i++) expect(await directory.readAdmin(member.identity, 'overview')).toBeNull();
    expect(size() - before).toBeLessThan(2048); // Room for one window boundary during the loop.
  });

  test('repeated cross-tenant probes with distinct 160-character organization ids stay bounded and are not stored verbatim', async () => {
    const { directory, member, size, raw } = await setup();
    const before = size();
    for (let i = 0; i < 5000; i++) {
      await directory.recordTenantDenial(member.identity, `${i}-`.padEnd(160, 'x'), 'members');
    }
    expect(size() - before).toBeLessThan(2048);
    expect(raw()).not.toContain('x'.repeat(100));
  });

  test('the collapsed event carries the repeat count and a closed window is appended once without rewriting history', async () => {
    const { directory, admin, member, edit, raw } = await setup();
    for (let i = 0; i < 7; i++) expect(await directory.readAdmin(member.identity, 'members')).toBeNull();
    await directory.recordTenantDenial(member.identity, 'org-z', 'overview');
    const events = await directory.listAudit(admin.identity);
    const collapsed = events.filter((event) => event.action === 'organization.members.read' && event.outcome === 'denied');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({ organizationId: 'org-a', subject: 'carol', count: 7 });
    expect(Date.parse(collapsed[0]!.firstAt!)).toBeLessThanOrEqual(Date.parse(collapsed[0]!.at));
    const probe = events.find((event) => event.action === 'organization.overview.cross-tenant')!;
    expect(probe).toMatchObject({ outcome: 'denied', count: 1, targetDigest: `organization:${sha256('org-z').slice(0, 16)}` });
    expect(probe.targetOrganizationId).toBeUndefined();
    const committed = decodeDirectoryState(raw()).audit;
    edit((data) => {
      for (const entry of data.pendingAudit!) {
        entry.event.firstAt = new Date(Date.now() - AUDIT_COLLAPSE_WINDOW_MS - 1000).toISOString();
      }
    });
    expect(await directory.readAdmin(member.identity, 'members')).toBeNull();
    const state = decodeDirectoryState(raw());
    expect(JSON.stringify(state.audit.slice(0, committed.length))).toBe(JSON.stringify(committed));
    expect(state.audit.slice(committed.length).map((event) => [event.action, event.count])).toEqual([
      ['organization.members.read', 7], ['organization.overview.cross-tenant', 1],
    ]);
    expect(state.pendingAudit!.map(({ event }) => [event.action, event.count])).toEqual([['organization.members.read', 1]]);
  });

  test('real mutations and denied mutation attempts are still audited as individual events', async () => {
    const { directory, admin, member } = await setup();
    await directory.createWorkspace(admin.identity, 'alpha', 'Alpha');
    await directory.createWorkspace(admin.identity, 'beta', 'Beta');
    for (let i = 0; i < 3; i++) await expect(directory.deactivateMember(member.identity, 'alice')).rejects.toThrow('Access denied');
    await directory.revokeMemberSessions(admin.identity, 'carol');
    const events = await directory.listAudit(admin.identity);
    expect(events.filter((event) => event.action === 'organization.workspace.create')
      .map((event) => [event.targetWorkspaceId, event.outcome, event.count])).toEqual([
      ['alpha', 'allowed', undefined], ['beta', 'allowed', undefined],
    ]);
    expect(events.filter((event) => event.action === 'organization.member.deactivate' && event.outcome === 'denied')
      .map((event) => [event.subject, event.targetSubject, event.count])).toEqual([
      ['carol', 'alice', undefined], ['carol', 'alice', undefined], ['carol', 'alice', undefined],
    ]);
    expect(events.at(-1)).toMatchObject({ action: 'organization.member.sessions.revoke', subject: 'alice',
      targetSubject: 'carol', outcome: 'allowed' });
  });

  test('a snapshot filled to its cap still lets an administrator deactivate, revoke sessions and sign in', async () => {
    const { directory, admin, member, edit, size, raw } = await setup();
    await directory.setMember(admin.identity,
      { organizationId: 'org-a', subject: 'dave', displayName: 'Dave', role: 'admin', active: true });
    const ordinaryCap = MAX_DIRECTORY_BYTES - RECOVERY_RESERVE_BYTES;
    edit((data) => {
      const event = (length: number) => ({ organizationId: 'org-a', subject: 'filler', action: `filler.${'x'.repeat(length)}`,
        outcome: 'allowed' as const, at: new Date().toISOString() });
      const overhead = Buffer.byteLength(JSON.stringify(event(0))) + 1;
      let current = Buffer.byteLength(JSON.stringify(data));
      while (ordinaryCap + 1000 - current > overhead + 10_000) { data.audit.push(event(10_000)); current += overhead + 10_000; }
      data.audit.push(event(Math.max(1, ordinaryCap + 1000 - current - overhead)));
    });
    expect(size()).toBeGreaterThan(ordinaryCap);
    expect(size()).toBeLessThan(ordinaryCap + 4096);
    // Ordinary writes, including a member's denials and sign-in, cannot consume the reserve.
    await expect(directory.readAdmin(member.identity, 'members')).rejects.toThrow('Directory capacity reached');
    await expect(directory.deactivateMember(member.identity, 'alice')).rejects.toThrow('Directory capacity reached');
    await expect(directory.createWorkspace(admin.identity, 'gamma', 'Gamma')).rejects.toThrow('Directory capacity reached');
    await expect(directory.createSession(issuer, 'org-a', 'carol', Date.now() + 60_000)).rejects.toThrow('Directory capacity reached');
    // Recovery.
    expect(await directory.revokeMemberSessions(admin.identity, 'carol')).toBe(1);
    expect(await directory.verifySession(member.token)).toBeNull();
    await directory.deactivateMember(admin.identity, 'carol');
    expect((await directory.getMember('org-a', 'carol'))?.active).toBe(false);
    expect(await directory.revokeOrganizationSessions(admin.identity)).toBe(1);
    expect(await directory.verifySession(admin.token)).toBeNull();
    const binding = 'b'.repeat(43);
    await directory.putAttempt('s'.repeat(43), { organizationId: 'org-a', issuer, nonce: 'synthetic-nonce',
      verifier: 'synthetic-verifier', bindingHash: sha256(binding), expiresAt: Date.now() + 60_000 }, '203.0.113.9');
    const attempt = await directory.takeAttempt('s'.repeat(43), binding);
    expect(attempt?.authEpoch).toBe(1);
    const signedIn = await directory.createSession(issuer, 'org-a', 'dave', Date.now() + 60_000, attempt!.authEpoch);
    expect((await directory.verifySession(signedIn.token))?.subject).toBe('dave');
    expect(size()).toBeLessThan(MAX_DIRECTORY_BYTES);
    expect(decodeDirectoryState(raw()).audit.slice(-4).map((event) => [event.action, event.outcome])).toEqual([
      ['organization.member.sessions.revoke', 'allowed'], ['organization.member.deactivate', 'allowed'],
      ['organization.sessions.revoke-all', 'allowed'], ['session.create', 'allowed'],
    ]);
  }, 60_000);
});
