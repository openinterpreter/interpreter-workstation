import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { EnterpriseDirectory, OrganizationMember, VerifiedIdentity } from './controlPlane';
import { evaluateTenantPolicy } from './tenantPolicy';

type Audit = { organizationId: string; subject: string; action: string; outcome: 'allowed' | 'denied'; at: string };
type Attempt = { organizationId: string; issuer: string; nonce: string; verifier: string; bindingHash: string; expiresAt: number };
type Session = { organizationId: string; issuer: string; subject: string; expiresAt: number; revoked: boolean };
type Data = { version: 1; organizations: Record<string, { name: string; issuer: string; members: Record<string, OrganizationMember> }>;
  attempts: Record<string, Attempt>; sessions: Record<string, Session>; audit: Audit[] };
const MAX_DIRECTORY_BYTES = 8_000_000;

const blank = (): Data => ({ version: 1, organizations: Object.create(null), attempts: Object.create(null), sessions: Object.create(null), audit: [] });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const key = (value: string) => value.length > 0 && value.length <= 160 && /^[a-zA-Z0-9._@:-]+$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const dictionary = <T>(value: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function validate(data: Data): void {
  if (data.version !== 1 || !record(data.organizations) || !record(data.sessions) ||
      !record(data.attempts) || !Array.isArray(data.audit)) throw new Error('Directory state is invalid');
  for (const [id, org] of Object.entries(data.organizations)) {
    if (!key(id) || !record(org) || typeof org.name !== 'string' || !org.name.trim() ||
        typeof org.issuer !== 'string' || !org.issuer || !record(org.members)) throw new Error('Directory organization is invalid');
    for (const [subject, member] of Object.entries(org.members)) {
      if (!key(subject) || !record(member) || member.organizationId !== id || member.subject !== subject ||
          typeof member.displayName !== 'string' || !member.displayName.trim() ||
          !['admin', 'member'].includes(member.role as string) || typeof member.active !== 'boolean') {
        throw new Error('Directory membership is invalid');
      }
    }
  }
  for (const [state, attempt] of Object.entries(data.attempts)) {
    if (!key(state) || !record(attempt) || !key(attempt.organizationId as string) ||
        data.organizations[attempt.organizationId as string]?.issuer !== attempt.issuer ||
        typeof attempt.nonce !== 'string' || !attempt.nonce || typeof attempt.verifier !== 'string' || !attempt.verifier ||
        typeof attempt.bindingHash !== 'string' || !/^[a-f0-9]{64}$/.test(attempt.bindingHash) ||
        typeof attempt.expiresAt !== 'number' || !Number.isFinite(attempt.expiresAt)) throw new Error('Directory attempt is invalid');
  }
  for (const [hash, session] of Object.entries(data.sessions)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !record(session) || !key(session.organizationId as string) ||
        data.organizations[session.organizationId as string]?.issuer !== session.issuer ||
        !key(session.subject as string) || !data.organizations[session.organizationId as string]?.members[session.subject as string] ||
        typeof session.expiresAt !== 'number' || !Number.isFinite(session.expiresAt) || typeof session.revoked !== 'boolean') {
      throw new Error('Directory session is invalid');
    }
  }
  for (const event of data.audit) {
    if (!record(event) || !key(event.organizationId as string) || !data.organizations[event.organizationId as string] ||
        typeof event.subject !== 'string' || !event.subject || typeof event.action !== 'string' || !event.action ||
        !['allowed', 'denied'].includes(event.outcome as string) ||
        typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Directory audit is invalid');
  }
}

/** Single-host, server-owned directory. No browser endpoint for provisioning. */
export class ServerDirectory implements EnterpriseDirectory {
  private readonly file: string;
  private readonly lock: string;

  constructor(file: string) {
    this.file = resolve(file);
    this.lock = this.file + '.lock';
  }

  private async init(create = false): Promise<void> {
    const parent = dirname(this.file);
    if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || (parentStat.mode & 0o077) !== 0) throw new Error('Directory permissions are unsafe');
    if (!create) return;
    try {
      const handle = await open(this.file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(blank())); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  private async read(): Promise<Data> {
    await this.init();
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await handle.stat();
      if (!s.isFile() || (s.mode & 0o077) !== 0 || s.size > MAX_DIRECTORY_BYTES) throw new Error('Directory state is unsafe');
      const data = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as Data;
      validate(data);
      data.organizations = dictionary(data.organizations);
      data.sessions = dictionary(data.sessions);
      data.attempts = dictionary(data.attempts);
      for (const org of Object.values(data.organizations)) org.members = dictionary(org.members);
      return data;
    } finally { await handle.close(); }
  }

  private async change<T>(fn: (data: Data) => T, create = false): Promise<T> {
    await this.init(create);
    // Cross-process exclusion: a leftover lock fails closed and requires an operator
    // to inspect it. Do not silently break a lock or lose an audit/membership write.
    await mkdir(this.lock, { mode: 0o700 });
    let temp: string | null = null;
    try {
      const data = await this.read();
      const result = fn(data);
      validate(data);
      const serialized = JSON.stringify(data);
      // Reject before replacing the last readable state. Audit capacity still
      // needs an operational retention/export policy before any live mount.
      if (Buffer.byteLength(serialized, 'utf8') > MAX_DIRECTORY_BYTES) throw new Error('Directory capacity reached');
      temp = join(dirname(this.file), `.enterprise-${randomBytes(16).toString('hex')}`);
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.file);
      temp = null;
      // Windows cannot portably open a directory handle for fsync here; do not
      // claim crash-durable Windows audit until its retained-fleet test exists.
      if (process.platform !== 'win32') {
        const dir = await open(dirname(this.file), 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
      return result;
    } finally {
      if (temp) await rm(temp, { force: true });
      await rm(this.lock, { recursive: true });
    }
  }

  /** Explicit operator-only bootstrap. Never called by an unauthenticated HTTP route. */
  async bootstrap(organizationId: string, name: string, issuer: string, admin: OrganizationMember): Promise<void> {
    if (!key(organizationId) || !key(admin.subject) || admin.organizationId !== organizationId || !admin.active || admin.role !== 'admin' || !name.trim() || !issuer) throw new Error('Invalid bootstrap');
    await this.change((data) => {
      if (data.organizations[organizationId]) throw new Error('Organization already exists');
      data.organizations[organizationId] = { name: name.trim(), issuer, members: dictionary({ [admin.subject]: admin }) };
      data.audit.push({ organizationId, subject: admin.subject, action: 'organization.bootstrap', outcome: 'allowed', at: new Date().toISOString() });
    }, true);
  }

  async organization(organizationId: string): Promise<{ id: string; name: string; memberCount: number } | null> {
    const org = (await this.read()).organizations[organizationId];
    return org ? { id: organizationId, name: org.name, memberCount: Object.keys(org.members).length } : null;
  }

  async auditSummary(organizationId: string): Promise<{ eventCount: number; latestAt: string | null }> {
    const events = (await this.read()).audit.filter((event) => event.organizationId === organizationId);
    return { eventCount: events.length, latestAt: events[events.length - 1]?.at ?? null };
  }

  async readAdmin(identity: VerifiedIdentity, view: 'members' | 'overview'): Promise<unknown | null> {
    return this.change((data) => {
      const org = data.organizations[identity.organizationId];
      const member = org?.members[identity.subject];
      const allowed = Boolean(org && evaluateTenantPolicy({ identity, organizationId: identity.organizationId,
        issuer: org.issuer, member, sessionActive: this.active(data, identity), action: 'organization.read' }));
      let payload: unknown = null;
      if (allowed && org) {
        const members = Object.values(org.members);
        if (members.some((entry) => entry.organizationId !== identity.organizationId)) throw new Error('Cross-tenant directory records');
        if (view === 'members') {
          payload = { organizationId: identity.organizationId, members: members.map(({ subject, displayName, role, active }) => ({ subject, displayName, role, active })) };
        } else {
          const events = data.audit.filter((event) => event.organizationId === identity.organizationId);
          payload = {
            organization: { id: identity.organizationId, name: org.name },
            users: { total: members.length, active: members.filter((m) => m.active).length, admins: members.filter((m) => m.active && m.role === 'admin').length },
            audit: { eventCount: events.length, latestAt: events[events.length - 1]?.at ?? null },
            identity: { issuer: identity.issuer, status: 'verified session' },
            controls: { policy: 'not enforced', provisioning: 'not configured', modelRegistry: 'not configured' },
          };
        }
      }
      data.audit.push({ organizationId: identity.organizationId, subject: identity.subject,
        action: `organization.${view}.read`, outcome: allowed ? 'allowed' : 'denied', at: new Date().toISOString() });
      return payload;
    });
  }

  async getMember(organizationId: string, subject: string): Promise<OrganizationMember | null> {
    if (!key(organizationId) || !key(subject)) return null;
    return (await this.read()).organizations[organizationId]?.members[subject] ?? null;
  }

  async listMembers(organizationId: string): Promise<readonly OrganizationMember[]> {
    if (!key(organizationId)) return [];
    return Object.values((await this.read()).organizations[organizationId]?.members ?? {});
  }

  async setMember(actor: VerifiedIdentity, member: OrganizationMember): Promise<void> {
    if (!key(member.subject) || !member.displayName.trim() || !['admin', 'member'].includes(member.role) ||
        typeof member.active !== 'boolean' || actor.organizationId !== member.organizationId) throw new Error('Invalid member or tenant mismatch');
    await this.change((data) => {
      const org = data.organizations[actor.organizationId];
      if (!org || !evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member: org.members[actor.subject], sessionActive: this.active(data, actor), action: 'member.manage' })) throw new Error('Access denied');
      // Keep a recoverable administrator. Revocation of an admin's sessions
      // occurs in the same durable write as the membership change.
      const next = { ...org.members, [member.subject]: member };
      if (!Object.values(next).some((item) => item.active && item.role === 'admin')) throw new Error('Last administrator');
      org.members[member.subject] = member;
      for (const session of Object.values(data.sessions)) {
        if (session.organizationId === actor.organizationId && session.subject === member.subject) session.revoked = true;
      }
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, action: 'organization.member.update', outcome: 'allowed', at: new Date().toISOString() });
    });
  }

  async putAttempt(state: string, attempt: Attempt): Promise<void> {
    if (!key(state) || !key(attempt.organizationId) || !attempt.nonce || !attempt.verifier || !attempt.bindingHash) throw new Error('Invalid attempt');
    await this.change((data) => {
      if (data.organizations[attempt.organizationId]?.issuer !== attempt.issuer || data.attempts[state]) throw new Error('Unknown organization, issuer, or duplicate state');
      data.attempts[state] = attempt;
    });
  }

  async takeAttempt(state: string, binding: string): Promise<Attempt | null> {
    if (!key(state) || !binding) return null;
    return this.change((data) => {
      const attempt = data.attempts[state];
      delete data.attempts[state]; // consume even when binding is wrong
      if (!attempt || attempt.expiresAt <= Date.now() || !eq(attempt.bindingHash, digest(binding))) return null;
      return attempt;
    });
  }

  /** Only transient rows may be compacted; audit events never disappear here. */
  async compactExpired(now = Date.now()): Promise<{ attempts: number; sessions: number }> {
    if (!Number.isFinite(now) || now < 0) throw new Error('Invalid maintenance clock');
    return this.change((data) => {
      let attempts = 0;
      let sessions = 0;
      for (const [state, attempt] of Object.entries(data.attempts)) {
        if (attempt.expiresAt <= now) { delete data.attempts[state]; attempts++; }
      }
      for (const [hash, session] of Object.entries(data.sessions)) {
        if (session.expiresAt <= now) { delete data.sessions[hash]; sessions++; }
      }
      return { attempts, sessions };
    });
  }

  async createSession(issuer: string, organizationId: string, subject: string, expiry: number): Promise<{ token: string; identity: VerifiedIdentity }> {
    if (!key(organizationId) || !key(subject) || !issuer || expiry <= Date.now() || expiry > Date.now() + 8 * 60 * 60_000) throw new Error('Invalid session');
    const token = randomBytes(32).toString('base64url');
    const sessionId = digest(token);
    await this.change((data) => {
      const member = data.organizations[organizationId]?.members[subject];
      if (!member?.active || member.organizationId !== organizationId || data.organizations[organizationId]?.issuer !== issuer) throw new Error('Unprovisioned identity or issuer mismatch');
      data.sessions[sessionId] = { issuer, organizationId, subject, expiresAt: expiry, revoked: false };
      data.audit.push({ organizationId, subject, action: 'session.create', outcome: 'allowed', at: new Date().toISOString() });
    });
    return { token, identity: { issuer, organizationId, subject, sessionId } };
  }

  async verifySession(token: string): Promise<VerifiedIdentity | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const sessionId = digest(token);
    const session = (await this.read()).sessions[sessionId];
    if (!session || session.revoked || session.expiresAt <= Date.now()) return null;
    return { issuer: session.issuer, organizationId: session.organizationId, subject: session.subject, sessionId };
  }

  private active(data: Data, identity: VerifiedIdentity): boolean {
    const session = data.sessions[identity.sessionId];
    return Boolean(session && !session.revoked && session.expiresAt > Date.now() && session.issuer === identity.issuer && session.subject === identity.subject && session.organizationId === identity.organizationId);
  }

  async sessionIsActive(identity: VerifiedIdentity): Promise<boolean> {
    return this.active(await this.read(), identity);
  }

  async revokeSession(identity: VerifiedIdentity): Promise<void> {
    await this.change((data) => {
      if (!this.active(data, identity)) throw new Error('Session inactive');
      data.sessions[identity.sessionId]!.revoked = true;
      data.audit.push({ organizationId: identity.organizationId, subject: identity.subject, action: 'session.revoke', outcome: 'allowed', at: new Date().toISOString() });
    });
  }

  async recordAudit(event: Omit<Audit, 'at'>): Promise<void> {
    await this.change((data) => { data.audit.push({ ...event, at: new Date().toISOString() }); });
  }

  async listAudit(actor: VerifiedIdentity): Promise<readonly Audit[]> {
    return this.change((data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      if (!org || !evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member, sessionActive: this.active(data, actor), action: 'audit.read' })) throw new Error('Access denied');
      // Authorization, scoped snapshot and audit commit share one exclusive transaction.
      const events = data.audit.filter((event) => event.organizationId === actor.organizationId);
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject,
        action: 'organization.audit.read', outcome: 'allowed', at: new Date().toISOString() });
      return events;
    });
  }
}
