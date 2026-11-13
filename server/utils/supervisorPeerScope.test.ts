import { describe, expect, it } from 'bun:test';
import { authorizeSupervisorPeer, type VerifiedSupervisorGrant } from './supervisorPeerScope';

const now = 1_000_000;
const threadId = '00000000-0000-4000-8000-000000000001';
const target = { sourceComputer: 'source-1', targetComputer: 'target-1', threadId,
  capability: 'goal:read' as const };
const grant: VerifiedSupervisorGrant = { issuer: 'enrolled-issuer', subject: 'supervisor-1',
  sourceComputer: 'source-1', targetComputer: 'target-1', threadId,
  capabilities: ['goal:read'], expiresAt: now + 1000 };

describe('verified supervisor peer scope', () => {
  it('requires an enrolled verifier and exact current scope', () => {
    expect(authorizeSupervisorPeer(null, target, now)).toBe('identity_unavailable');
    expect(authorizeSupervisorPeer(grant, target, now)).toBe('allowed');
    expect(authorizeSupervisorPeer(grant, { ...target, threadId: '00000000-0000-4000-8000-000000000002' }, now)).toBe('scope_denied');
    expect(authorizeSupervisorPeer(grant, { ...target, targetComputer: 'target-2' }, now)).toBe('scope_denied');
    expect(authorizeSupervisorPeer(grant, { ...target, capability: 'artifact:read' }, now)).toBe('scope_denied');
    expect(authorizeSupervisorPeer({ ...grant, expiresAt: now }, target, now)).toBe('scope_denied');
    expect(authorizeSupervisorPeer({ ...grant, subject: '' }, target, now)).toBe('scope_denied');
  });
});
