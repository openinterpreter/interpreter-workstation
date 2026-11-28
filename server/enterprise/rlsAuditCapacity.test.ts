import { describe, expect, test } from 'bun:test';
import {
  blankDirectoryState, MAX_DIRECTORY_BYTES, ServerDirectory, validateDirectoryState,
  type DirectoryState, type EnterpriseStateStore,
} from './serverDirectory';

/** A source seam for the future ledger-only RLS store. The synthetic adapter
 * models committed audit separately from the bytes of its bounded directory
 * row; it does not prove PostgreSQL RLS, TLS, migration or disk durability. */
function ledgerOnlyFixture() {
  let state = blankDirectoryState();
  const store: EnterpriseStateStore = {
    read: async () => structuredClone(state),
    snapshotBytes: (data) => Buffer.byteLength(JSON.stringify({ ...data, audit: [] }), 'utf8'),
    change: async (fn) => {
      const next = structuredClone(state);
      const result = fn(next);
      validateDirectoryState(next);
      if (Buffer.byteLength(JSON.stringify({ ...next, audit: [] }), 'utf8') > MAX_DIRECTORY_BYTES) {
        throw new Error('Tenant directory capacity reached');
      }
      state = next;
      return result;
    },
  };
  return { directory: new ServerDirectory(store),
    appendHistoricalEvents: (organizationId: string, subject: string) => {
      const event = { organizationId, subject, action: `runtime.${'x'.repeat(10_000)}`,
        outcome: 'allowed' as const, at: new Date().toISOString() };
      const size = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
      const required = Math.ceil((MAX_DIRECTORY_BYTES + 20_000) / size);
      state.audit.push(...Array.from({ length: required }, () => ({ ...event })));
      validateDirectoryState(state);
      return { ledgerBytes: Buffer.byteLength(JSON.stringify(state.audit), 'utf8'),
        directoryBytes: Buffer.byteLength(JSON.stringify({ ...state, audit: [] }), 'utf8') };
    } };
}

async function tenant(id: string) {
  const fixture = ledgerOnlyFixture();
  const issuer = `https://idp.invalid/${id}`;
  await fixture.directory.bootstrap(id, id, issuer,
    { organizationId: id, subject: 'admin', displayName: 'Admin', role: 'admin', active: true });
  const admin = await fixture.directory.createSession(issuer, id, 'admin', Date.now() + 60_000);
  await fixture.directory.setMember(admin.identity,
    { organizationId: id, subject: 'member', displayName: 'Member', role: 'member', active: true });
  await fixture.directory.createWorkspace(admin.identity, 'w', 'Workspace');
  await fixture.directory.setRuntimeGrant(admin.identity, 'w', 'member', 'agent.execute', true);
  const member = await fixture.directory.createSession(issuer, id, 'member', Date.now() + 60_000);
  return { ...fixture, member };
}

describe('F1 ledger-only snapshot sizing contract (real RLS migration pending)', () => {
  test('a permitted member continues after audit exceeds the old snapshot cap, without affecting another tenant', async () => {
    const a = await tenant('org-a');
    const b = await tenant('org-b');
    expect(await a.directory.authorizeRuntime(a.member.identity, 'agent.execute', 'w')).toBe(true);
    expect(await b.directory.authorizeRuntime(b.member.identity, 'agent.execute', 'w')).toBe(true);
    await expect(b.directory.authorizeRuntime(a.member.identity, 'agent.execute', 'w')).rejects.toThrow('Access denied');
    const sizes = a.appendHistoricalEvents('org-a', 'member');
    expect(sizes.ledgerBytes).toBeGreaterThan(MAX_DIRECTORY_BYTES);
    expect(sizes.directoryBytes).toBeLessThan(10_000);
    expect(await a.directory.authorizeRuntime(a.member.identity, 'agent.execute', 'w')).toBe(true);
    expect(await b.directory.authorizeRuntime(b.member.identity, 'agent.execute', 'w')).toBe(true);
  });
});
