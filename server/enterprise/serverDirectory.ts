import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolveTxt } from 'node:dns/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { EnterpriseDirectory, OrganizationMember, VerifiedIdentity } from './controlPlane';
import { evaluateTenantPolicy, type RuntimeAction } from './tenantPolicy';

type Audit = { organizationId: string; subject: string; targetSubject?: string; targetOrganizationId?: string; targetDomain?: string; targetWorkspaceId?: string;
  action: string; outcome: 'allowed' | 'denied'; at: string };
type Attempt = { organizationId: string; issuer: string; nonce: string; verifier: string; bindingHash: string; expiresAt: number; authEpoch?: number };
type Session = { organizationId: string; issuer: string; subject: string; expiresAt: number; revoked: boolean;
  accountDomain?: string };
type DomainProof = { issuer: string; challengeHash: string; expiresAt: number; verifiedUntil?: number };
type WorkspaceRecord = { id: string; name: string; active: boolean; grants?: Record<string, RuntimeAction[]> };
export type DirectoryState = { version: 1; organizations: Record<string, { name: string; issuer: string;
  members: Record<string, OrganizationMember>; authEpoch?: number; domainProofs?: Record<string, DomainProof>;
  workspaces?: Record<string, WorkspaceRecord> }>;
  attempts: Record<string, Attempt>; sessions: Record<string, Session>; audit: Audit[] };
type Data = DirectoryState;
export const MAX_DIRECTORY_BYTES = 8_000_000;
export const MAX_ACTIVE_LOGIN_ATTEMPTS_PER_ORGANIZATION = 64;
export interface EnterpriseStateStore {
  read(): Promise<DirectoryState>;
  change<T>(fn: (data: DirectoryState) => T, create?: boolean): Promise<T>;
  /** Optional database-wide claim check; tenant-only stores fail closed here. */
  domainClaimStatus?(organizationId: string, issuer: string, domain: string): Promise<boolean>;
  /** A separately locked domain claim and directory mutation in ONE database
   * transaction. Only the RLS tenant store may implement this activation gate. */
  changeWithDomainClaim?<T>(organizationId: string, issuer: string, domain: string,
    fn: (data: DirectoryState) => T): Promise<T>;
}

export class EnterpriseAccessDenied extends Error {
  constructor() { super('Access denied'); }
}
export class EnterpriseDomainClaimConflict extends Error {
  constructor() { super('Domain claim unavailable'); }
}

export const blankDirectoryState = (): DirectoryState => ({ version: 1, organizations: Object.create(null), attempts: Object.create(null), sessions: Object.create(null), audit: [] });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const key = (value: string) => value.length > 0 && value.length <= 160 && /^[a-zA-Z0-9._@:-]+$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
/** OIDC Core subject identifiers are opaque, case-sensitive ASCII strings up
 * to 255 characters. Do not impose the stricter tenant/URL key alphabet on
 * provider subjects; decoded member maps use null prototypes below. */
const subjectIdentifier = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 255 && /^[\x00-\x7F]+$/.test(value);
const clearRuntimeGrants = (org: Data['organizations'][string], subject: string): void => {
  for (const workspace of Object.values(org.workspaces ?? {})) {
    if (workspace.grants && Object.prototype.hasOwnProperty.call(workspace.grants, subject)) {
      delete workspace.grants[subject];
    }
  }
};
/** Exact DNS ownership name; never infer a tenant from an email suffix. */
export function verifiedDomainName(value: string): string | null {
  if (typeof value !== 'string' || value.length > 253 || value !== value.trim() || value.endsWith('.')) return null;
  const domain = value.toLowerCase();
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) &&
    /^[a-z]{2,63}$/.test(labels[labels.length - 1]!) ? domain : null;
}
const dictionary = <T>(value: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
/** Only a directory containing every organization can enforce this globally.
 * A tenant-pinned RLS row exposes only its own organization, so this check is
 * a defense for shared-state pilots, never a production domain registry.
 * A claim means a verified lease: a pending challenge reserves nothing, so
 * challenge creation cannot block or probe another tenant's domain. */
function otherActiveDomainClaim(data: Data, organizationId: string, domain: string, now: number): boolean {
  return Object.entries(data.organizations).some(([id, org]) => {
    const proof = id === organizationId ? undefined : org.domainProofs?.[domain];
    return Boolean(proof && (proof.verifiedUntil ?? 0) > now);
  });
}

export function validateDirectoryState(data: Data): void {
  if (data.version !== 1 || !record(data.organizations) || !record(data.sessions) ||
      !record(data.attempts) || !Array.isArray(data.audit)) throw new Error('Directory state is invalid');
  for (const [id, org] of Object.entries(data.organizations)) {
    if (!key(id) || !record(org) || typeof org.name !== 'string' || !org.name.trim() ||
        typeof org.issuer !== 'string' || !org.issuer || !record(org.members) ||
        (org.authEpoch !== undefined && (!Number.isSafeInteger(org.authEpoch) || org.authEpoch < 0))) throw new Error('Directory organization is invalid');
    if (org.domainProofs !== undefined) {
      if (!record(org.domainProofs) || Object.keys(org.domainProofs).length > 32) throw new Error('Directory domain proofs are invalid');
      for (const [domain, proof] of Object.entries(org.domainProofs)) {
        if (verifiedDomainName(domain) !== domain || !record(proof) || proof.issuer !== org.issuer ||
            typeof proof.challengeHash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.challengeHash) ||
            !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt < 0 ||
            (proof.verifiedUntil !== undefined && (!Number.isSafeInteger(proof.verifiedUntil) || proof.verifiedUntil < 0))) {
          throw new Error('Directory domain proof is invalid');
        }
      }
    }
    if (org.workspaces !== undefined) {
      if (!record(org.workspaces) || Object.keys(org.workspaces).length > 32) throw new Error('Directory workspaces are invalid');
      for (const [workspaceId, workspace] of Object.entries(org.workspaces)) {
        if (!key(workspaceId) || !record(workspace) || workspace.id !== workspaceId ||
            typeof workspace.name !== 'string' || workspace.name !== workspace.name.trim() ||
            !workspace.name || workspace.name.length > 128 || typeof workspace.active !== 'boolean') {
          throw new Error('Directory workspace is invalid');
        }
        if (workspace.grants !== undefined) {
          if (!record(workspace.grants) || Object.keys(workspace.grants).length > 128) throw new Error('Directory workspace grants are invalid');
          for (const [subject, actions] of Object.entries(workspace.grants)) {
            if (!subjectIdentifier(subject) || !Object.prototype.hasOwnProperty.call(org.members, subject) ||
                !Array.isArray(actions) || actions.length > 3 || new Set(actions).size !== actions.length ||
                actions.some((action) => !['agent.execute', 'tool.invoke', 'simple.execute'].includes(action))) {
              throw new Error('Directory workspace grants are invalid');
            }
          }
        }
      }
    }
    for (const [subject, member] of Object.entries(org.members)) {
      if (!subjectIdentifier(subject) || !record(member) || member.organizationId !== id || member.subject !== subject ||
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
        typeof attempt.expiresAt !== 'number' || !Number.isFinite(attempt.expiresAt) ||
        (attempt.authEpoch !== undefined && (!Number.isSafeInteger(attempt.authEpoch) || attempt.authEpoch < 0))) throw new Error('Directory attempt is invalid');
  }
  for (const [hash, session] of Object.entries(data.sessions)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !record(session) || !key(session.organizationId as string) ||
        data.organizations[session.organizationId as string]?.issuer !== session.issuer ||
        !subjectIdentifier(session.subject) || !Object.prototype.hasOwnProperty.call(
          data.organizations[session.organizationId as string]?.members ?? {}, session.subject as string) ||
        typeof session.expiresAt !== 'number' || !Number.isFinite(session.expiresAt) || typeof session.revoked !== 'boolean' ||
        (session.accountDomain !== undefined && verifiedDomainName(session.accountDomain as string) !== session.accountDomain)) {
      throw new Error('Directory session is invalid');
    }
  }
  for (const event of data.audit) {
    if (!record(event) || !key(event.organizationId as string) || !data.organizations[event.organizationId as string] ||
        !subjectIdentifier(event.subject) || typeof event.action !== 'string' || !event.action ||
        (event.targetSubject !== undefined && !subjectIdentifier(event.targetSubject)) ||
        (event.targetOrganizationId !== undefined && !key(event.targetOrganizationId as string)) ||
        (event.targetDomain !== undefined && verifiedDomainName(event.targetDomain as string) !== event.targetDomain) ||
        (event.targetWorkspaceId !== undefined && !key(event.targetWorkspaceId as string)) ||
        !['allowed', 'denied'].includes(event.outcome as string) ||
        typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Directory audit is invalid');
  }
}

export function decodeDirectoryState(serialized: string): DirectoryState {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DIRECTORY_BYTES) throw new Error('Directory state is unsafe');
  const data = JSON.parse(serialized) as Data;
  validateDirectoryState(data);
  data.organizations = dictionary(data.organizations);
  data.sessions = dictionary(data.sessions);
  data.attempts = dictionary(data.attempts);
  for (const org of Object.values(data.organizations)) org.members = dictionary(org.members);
  for (const org of Object.values(data.organizations)) {
    for (const workspace of Object.values(org.workspaces ?? {})) {
      if (workspace.grants) workspace.grants = dictionary(workspace.grants);
    }
  }
  return data;
}

/** Single-host, server-owned directory. No browser endpoint for provisioning. */
export class ServerDirectory implements EnterpriseDirectory {
  private readonly file: string;
  private readonly lock: string;
  private readonly store: EnterpriseStateStore | null;

  private async domainClaimChange<T>(actor: VerifiedIdentity, domain: string,
    action: 'organization.domain.verify', fn: (data: Data) => T): Promise<T> {
    try { return await this.changeForIdentity(actor, fn); }
    catch (error) {
      if (!(error instanceof EnterpriseDomainClaimConflict)) throw error;
      // The first transaction rolled back both the tentative proof and its
      // success audit. Record only the denied attempt in the actor's ledger.
      await this.changeForIdentity(actor, (data) => {
        const org = data.organizations[actor.organizationId];
        const member = org?.members[actor.subject];
        if (!org || org.issuer !== actor.issuer || !member?.active || !this.active(data, actor, domain)) throw new EnterpriseAccessDenied();
        data.audit.push({ organizationId: actor.organizationId, subject: actor.subject,
          targetDomain: domain, action, outcome: 'denied', at: new Date().toISOString() });
      });
      throw new EnterpriseAccessDenied();
    }
  }

  constructor(fileOrStore: string | EnterpriseStateStore,
    private readonly lookupTxt: (name: string) => Promise<string[][]> = resolveTxt) {
    this.store = typeof fileOrStore === 'string' ? null : fileOrStore;
    this.file = typeof fileOrStore === 'string' ? resolve(fileOrStore) : '';
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
      try { await handle.writeFile(JSON.stringify(blankDirectoryState())); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  private async read(): Promise<Data> {
    if (this.store) return this.store.read();
    await this.init();
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await handle.stat();
      if (!s.isFile() || (s.mode & 0o077) !== 0 || s.size > MAX_DIRECTORY_BYTES) throw new Error('Directory state is unsafe');
      return decodeDirectoryState(await handle.readFile({ encoding: 'utf8' }));
    } finally { await handle.close(); }
  }

  private async change<T>(fn: (data: Data) => T, create = false): Promise<T> {
    if (this.store) return this.store.change(fn, create);
    await this.init(create);
    // Wait briefly for another request's atomic commit. A leftover lock still
    // fails closed and requires inspection; never break it or lose audit writes.
    for (let attempt = 0; ; attempt++) {
      try { await mkdir(this.lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 39) throw error;
        await delay(25);
      }
    }
    let temp: string | null = null;
    try {
      const data = await this.read();
      const result = fn(data);
      validateDirectoryState(data);
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

  /** A previously verified session cannot authorize a later transaction
   * after its domain claim is released between HTTP verification and use.
   * Read only enough to select the session's immutable claim; the locked
   * transaction rechecks the identity, proof, policy and claim before commit. */
  private async changeForIdentity<T>(identity: VerifiedIdentity, fn: (data: Data) => T): Promise<T> {
    const session = (await this.read()).sessions[identity.sessionId];
    const domain = session?.organizationId === identity.organizationId && session.issuer === identity.issuer &&
      session.subject === identity.subject ? session.accountDomain : undefined;
    if (!domain) return this.change(fn);
    if (!this.store?.changeWithDomainClaim) throw new EnterpriseAccessDenied();
    return this.store.changeWithDomainClaim(identity.organizationId, identity.issuer, domain, (data) => {
      if (data.sessions[identity.sessionId]?.accountDomain !== domain) throw new EnterpriseAccessDenied();
      return fn(data);
    });
  }

  /** Explicit operator-only bootstrap. Never called by an unauthenticated HTTP route. */
  async bootstrap(organizationId: string, name: string, issuer: string, admin: OrganizationMember): Promise<void> {
    if (!key(organizationId) || !subjectIdentifier(admin.subject) || admin.organizationId !== organizationId || !admin.active || admin.role !== 'admin' || !name.trim() || !issuer) throw new Error('Invalid bootstrap');
    await this.change((data) => {
      if (data.organizations[organizationId]) throw new Error('Organization already exists');
      data.organizations[organizationId] = { name: name.trim(), issuer, members: dictionary({ [admin.subject]: admin }), authEpoch: 0 };
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

  /** Issue an expiring DNS challenge. This stores only its digest and cannot
   * be reached from the unmounted desktop server or an unauthenticated route.
   * A challenge reserves nothing globally and never consults another tenant's
   * claim, so its response cannot reveal who holds a name. An existing lease
   * is kept: re-proving must not end the sessions that depend on it. */
  async beginDomainProof(actor: VerifiedIdentity, inputDomain: string): Promise<{ name: string; value: string; expiresAt: number }> {
    const domain = verifiedDomainName(inputDomain);
    if (!domain || `_interpreter-workstation.${domain}`.length > 253) throw new EnterpriseAccessDenied();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 10 * 60_000;
    const allowed = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !member?.active || !this.active(data, actor, domain)) throw new EnterpriseAccessDenied();
      const permitted = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member, sessionActive: true, action: 'member.manage' }) &&
        (Boolean(org.domainProofs?.[domain]) || Object.keys(org.domainProofs ?? {}).length < 32);
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetDomain: domain,
        action: 'organization.domain.challenge', outcome: permitted ? 'allowed' : 'denied', at: new Date().toISOString() });
      if (!permitted) return false;
      org.domainProofs ??= dictionary({});
      const prior = org.domainProofs[domain];
      const verifiedUntil = prior?.issuer === org.issuer ? prior.verifiedUntil : undefined;
      org.domainProofs[domain] = { issuer: org.issuer, challengeHash: digest(token), expiresAt,
        ...(verifiedUntil !== undefined ? { verifiedUntil } : {}) };
      return true;
    });
    if (!allowed) throw new EnterpriseAccessDenied();
    return { name: `_interpreter-workstation.${domain}`, value: `interpreter-workstation-verification=${token}`, expiresAt };
  }

  /** DNS lookup is server-owned and never supplied as request JSON. Authorization,
   * challenge freshness, issuer binding and audit commit are rechecked under
   * the same tenant transaction after network IO. */
  async confirmDomainProof(actor: VerifiedIdentity, inputDomain: string): Promise<void> {
    const domain = verifiedDomainName(inputDomain);
    if (!domain || `_interpreter-workstation.${domain}`.length > 253) throw new EnterpriseAccessDenied();
    // Never make an attacker-selected DNS query before checking the current
    // session and role. Recheck after the lookup to close revocation races.
    const preflight = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !member?.active || !this.active(data, actor, domain)) throw new EnterpriseAccessDenied();
      // A privileged caller must not be able to turn verification into an
      // arbitrary DNS-query endpoint. Only a live, tenant-owned challenge may
      // leave the server; the full proof is checked again after network IO.
      const proof = org.domainProofs?.[domain];
      const permitted = Boolean(evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member, sessionActive: true, action: 'member.manage' }) &&
        proof?.issuer === org.issuer && proof.expiresAt > Date.now() &&
        !otherActiveDomainClaim(data, actor.organizationId, domain, Date.now()));
      if (!permitted) data.audit.push({ organizationId: actor.organizationId, subject: actor.subject,
        targetDomain: domain, action: 'organization.domain.verify', outcome: 'denied', at: new Date().toISOString() });
      return permitted;
    });
    if (!preflight) throw new EnterpriseAccessDenied();
    let values: string[] = [];
    let lookupFailed = false;
    try {
      const answers = await this.lookupTxt(`_interpreter-workstation.${domain}`);
      if (!Array.isArray(answers) || answers.length > 32 || answers.some((parts) =>
        !Array.isArray(parts) || parts.some((part) => typeof part !== 'string') || parts.join('').length > 512)) {
        throw new Error('DNS TXT response invalid');
      }
      values = answers.map((parts) => parts.join(''));
    } catch { lookupFailed = true; }
    const allowed = await this.domainClaimChange(actor, domain, 'organization.domain.verify', (data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !member?.active || !this.active(data, actor, domain)) throw new EnterpriseAccessDenied();
      const proof = org.domainProofs?.[domain];
      const permitted = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member, sessionActive: true, action: 'member.manage' });
      const verificationRecords = values.filter((value) => value.startsWith('interpreter-workstation-verification='));
      const matches = proof && verificationRecords.filter((value) => {
        const token = /^interpreter-workstation-verification=([A-Za-z0-9_-]{43})$/.exec(value)?.[1];
        return Boolean(token && eq(proof.challengeHash, digest(token)));
      }).length;
      const liveChallenge = Boolean(permitted && proof?.issuer === org.issuer && proof.expiresAt > Date.now());
      const verified = Boolean(liveChallenge && !lookupFailed &&
        !otherActiveDomainClaim(data, actor.organizationId, domain, Date.now()) &&
        verificationRecords.length === 1 && matches === 1);
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetDomain: domain,
        action: 'organization.domain.verify', outcome: verified ? 'allowed' : 'denied', at: new Date().toISOString() });
      // Success sets or extends the lease. In the RLS store, the global claim
      // is inserted in this same transaction; a foreign claim rolls it back.
      if (verified) proof!.verifiedUntil = Date.now() + 24 * 60 * 60_000;
      // Only a completed lookup for this tenant's own live challenge that did
      // not contain the expected value is a definitive negative. A missing or
      // expired challenge, lookup error, denial or claim conflict keeps it.
      else if (liveChallenge && !lookupFailed && matches === 0) delete proof!.verifiedUntil;
      return verified;
    });
    if (!allowed) throw lookupFailed ? new Error('DNS verification unavailable') : new EnterpriseAccessDenied();
  }

  /** Internal pilot signal only; not an activation gate. Independently scoped
   * tenant rows cannot establish global uniqueness of a domain, and DNS TXT
   * alone does not prove legal entitlement, a live IdP or TLS deployment. */
  async domainVerified(organizationId: string, issuer: string, inputDomain: string): Promise<boolean> {
    const domain = verifiedDomainName(inputDomain);
    if (!domain) return false;
    const data = await this.read();
    const org = data.organizations[organizationId];
    const proof = org?.domainProofs?.[domain];
    const observed = Boolean(org?.issuer === issuer && proof?.issuer === issuer && proof.verifiedUntil &&
      proof.verifiedUntil > Date.now() && !otherActiveDomainClaim(data, organizationId, domain, Date.now()));
    return observed && (this.store?.domainClaimStatus ? await this.store.domainClaimStatus(organizationId, issuer, domain) : true);
  }

  /** Login activation gate: a file pilot or tenant-only store cannot establish
   * database-wide domain exclusivity. Never substitute the UI status signal. */
  async domainClaimVerifiedForLogin(organizationId: string, issuer: string, inputDomain: string): Promise<boolean> {
    if (!this.store?.domainClaimStatus || !this.store.changeWithDomainClaim) return false;
    return this.domainVerified(organizationId, issuer, inputDomain);
  }

  /** Admin-only, audited status read. This exposes no challenge digest or
   * token and reports only the observed DNS lease, never SSO readiness. */
  async domainProofStatus(actor: VerifiedIdentity, inputDomain: string): Promise<{
    domain: string; challengeExpiresAt: number | null; verifiedUntil: number | null;
  }> {
    const domain = verifiedDomainName(inputDomain);
    if (!domain || `_interpreter-workstation.${domain}`.length > 253) throw new EnterpriseAccessDenied();
    const status = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !member?.active || !this.active(data, actor, domain)) throw new EnterpriseAccessDenied();
      const permitted = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member, sessionActive: true, action: 'member.manage' });
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetDomain: domain,
        action: 'organization.domain.status', outcome: permitted ? 'allowed' : 'denied', at: new Date().toISOString() });
      if (!permitted) return null;
      const proof = org.domainProofs?.[domain];
      const now = Date.now();
      const unambiguous = !otherActiveDomainClaim(data, actor.organizationId, domain, now);
      // The tenant's own pending challenge is reported regardless of another
      // tenant's claim; hiding it would reveal that claim, as a challenge must not.
      return { domain,
        challengeExpiresAt: proof && proof.expiresAt > now ? proof.expiresAt : null,
        verifiedUntil: proof && unambiguous && proof.verifiedUntil && proof.verifiedUntil > now ? proof.verifiedUntil : null };
    });
    if (!status) throw new EnterpriseAccessDenied();
    if (status.verifiedUntil && this.store?.domainClaimStatus &&
        !await this.store.domainClaimStatus(actor.organizationId, actor.issuer, domain)) status.verifiedUntil = null;
    return status;
  }

  /** Server-owned administrative inventory only. A workspace record alone
   * grants no local filesystem path or agent/tool execution; an explicit
   * per-member action grant is a separate reviewed mutation. */
  async listWorkspaces(actor: VerifiedIdentity): Promise<readonly WorkspaceRecord[]> {
    const result = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !member?.active || !this.active(data, actor)) throw new EnterpriseAccessDenied();
      const allowed = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member, sessionActive: true, action: 'organization.read' });
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject,
        action: 'organization.workspaces.read', outcome: allowed ? 'allowed' : 'denied', at: new Date().toISOString() });
      return allowed ? Object.values(org.workspaces ?? {}).map(({ id, name, active }) => ({ id, name, active })) : null;
    });
    if (!result) throw new EnterpriseAccessDenied();
    return result;
  }

  async createWorkspace(actor: VerifiedIdentity, id: string, name: string): Promise<void> {
    if (!key(id) || typeof name !== 'string' || name !== name.trim() || !name || name.length > 128) throw new EnterpriseAccessDenied();
    const allowed = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !member?.active || !this.active(data, actor)) throw new EnterpriseAccessDenied();
      const permitted = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member, sessionActive: true, action: 'member.manage' }) &&
        !org.workspaces?.[id] && Object.keys(org.workspaces ?? {}).length < 32;
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetWorkspaceId: id,
        action: 'organization.workspace.create', outcome: permitted ? 'allowed' : 'denied', at: new Date().toISOString() });
      if (!permitted) return false;
      org.workspaces ??= dictionary({});
      org.workspaces[id] = { id, name, active: true };
      return true;
    });
    if (!allowed) throw new EnterpriseAccessDenied();
  }

  /** Administrator-owned per-workspace runtime capability. Neither the member
   * role nor a provider group claim implies execution. Every change is scoped
   * and audited in the same tenant transaction as the grant update. */
  async setRuntimeGrant(actor: VerifiedIdentity, workspaceId: string, subject: string,
    action: RuntimeAction, granted: boolean): Promise<void> {
    if (!key(workspaceId) || !subjectIdentifier(subject) ||
        !['agent.execute', 'tool.invoke', 'simple.execute'].includes(action) || typeof granted !== 'boolean') {
      throw new EnterpriseAccessDenied();
    }
    const allowed = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      if (!org || !this.active(data, actor)) throw new EnterpriseAccessDenied();
      const workspace = org.workspaces?.[workspaceId];
      const target = Object.prototype.hasOwnProperty.call(org.members, subject) ? org.members[subject] : undefined;
      const current = workspace?.grants && Object.prototype.hasOwnProperty.call(workspace.grants, subject)
        ? workspace.grants[subject]! : [];
      const permitted = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member: org.members[actor.subject], sessionActive: true, action: 'member.manage' }) &&
        workspace?.active === true && target?.organizationId === actor.organizationId && target.active &&
        current.includes(action) !== granted;
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
        targetWorkspaceId: workspaceId, action: granted ? `organization.runtime.grant.${action}` : `organization.runtime.revoke.${action}`,
        outcome: permitted ? 'allowed' : 'denied', at: new Date().toISOString() });
      if (!permitted || !workspace) return false;
      workspace.grants ??= dictionary({});
      const next = granted ? [...current, action] : current.filter((value) => value !== action);
      if (next.length) workspace.grants[subject] = next;
      else delete workspace.grants[subject];
      return true;
    });
    if (!allowed) throw new EnterpriseAccessDenied();
  }

  async listWorkspaceGrants(actor: VerifiedIdentity, workspaceId: string): Promise<readonly { subject: string; actions: RuntimeAction[] }[]> {
    if (!key(workspaceId)) throw new EnterpriseAccessDenied();
    const grants = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      if (!org || !this.active(data, actor)) throw new EnterpriseAccessDenied();
      const permitted = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member: org.members[actor.subject], sessionActive: true, action: 'organization.read' }) &&
        org.workspaces?.[workspaceId]?.active === true;
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetWorkspaceId: workspaceId,
        action: 'organization.runtime.grants.read', outcome: permitted ? 'allowed' : 'denied', at: new Date().toISOString() });
      if (!permitted) return null;
      return Object.entries(org.workspaces![workspaceId]!.grants ?? {}).map(([subject, actions]) =>
        ({ subject, actions: [...actions] }));
    });
    if (!grants) throw new EnterpriseAccessDenied();
    return grants;
  }

  async deactivateWorkspace(actor: VerifiedIdentity, id: string): Promise<void> {
    if (!key(id)) throw new EnterpriseAccessDenied();
    const allowed = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !member?.active || !this.active(data, actor)) throw new EnterpriseAccessDenied();
      const permitted = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member, sessionActive: true, action: 'member.manage' }) &&
        org.workspaces?.[id]?.active === true;
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetWorkspaceId: id,
        action: 'organization.workspace.deactivate', outcome: permitted ? 'allowed' : 'denied', at: new Date().toISOString() });
      if (!permitted) return false;
      org.workspaces![id]!.active = false;
      return true;
    });
    if (!allowed) throw new EnterpriseAccessDenied();
  }

  async readAdmin(identity: VerifiedIdentity, view: 'members' | 'overview'): Promise<unknown | null> {
    return this.changeForIdentity(identity, (data) => {
      const org = data.organizations[identity.organizationId];
      // No tenant ledger exists for an unknown identifier. Deny rather than
      // creating an invalid cross-tenant audit record and turning 403 into 503.
      if (!org) return null;
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
            identity: { issuer: identity.issuer, subject: identity.subject, status: 'verified session' },
            controls: { policy: 'not enforced', provisioning: 'not configured', modelRegistry: 'not configured' },
          };
        }
      }
      data.audit.push({ organizationId: identity.organizationId, subject: identity.subject,
        action: `organization.${view}.read`, outcome: allowed ? 'allowed' : 'denied', at: new Date().toISOString() });
      return payload;
    });
  }

  /** A pre-dispatch decision for a specifically mounted execution boundary.
   * The directory/session/domain check and denied audit append commit under
   * one tenant lock. This does not bind a running tool or native IPC sender;
   * those require separate cancellation and identity propagation before any
   * execution policy can grant an action. */
  async authorizeRuntime(identity: VerifiedIdentity, action: RuntimeAction,
    workspaceId: string): Promise<boolean> {
    if (!['agent.execute', 'tool.invoke', 'simple.execute'].includes(action) ||
        !key(workspaceId)) throw new EnterpriseAccessDenied();
    return this.changeForIdentity(identity, (data) => {
      const org = data.organizations[identity.organizationId];
      if (!org || !this.active(data, identity)) throw new EnterpriseAccessDenied();
      const workspace = org.workspaces?.[workspaceId];
      const grant = workspace?.grants && Object.prototype.hasOwnProperty.call(workspace.grants, identity.subject)
        ? workspace.grants[identity.subject] : undefined;
      const permitted = evaluateTenantPolicy({ identity,
        organizationId: identity.organizationId, issuer: org.issuer,
        member: org.members[identity.subject], sessionActive: true, action,
        workspaceActive: workspace?.active, runtimeGrant: grant?.includes(action) });
      data.audit.push({ organizationId: identity.organizationId, subject: identity.subject,
        targetWorkspaceId: workspaceId, action: `runtime.${action}`, outcome: permitted ? 'allowed' : 'denied',
        at: new Date().toISOString() });
      return permitted;
    });
  }

  async getMember(organizationId: string, subject: string): Promise<OrganizationMember | null> {
    if (!key(organizationId) || !subjectIdentifier(subject)) return null;
    return (await this.read()).organizations[organizationId]?.members[subject] ?? null;
  }

  async listMembers(organizationId: string): Promise<readonly OrganizationMember[]> {
    if (!key(organizationId)) return [];
    return Object.values((await this.read()).organizations[organizationId]?.members ?? {});
  }

  async setMember(actor: VerifiedIdentity, member: OrganizationMember): Promise<void> {
    if (!subjectIdentifier(member.subject) || !member.displayName.trim() || !['admin', 'member'].includes(member.role) ||
        typeof member.active !== 'boolean' || actor.organizationId !== member.organizationId) throw new Error('Invalid member or tenant mismatch');
    await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      if (!org || !evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member: org.members[actor.subject], sessionActive: this.active(data, actor), action: 'member.manage' })) throw new Error('Access denied');
      // Keep a recoverable administrator. Revocation of an admin's sessions
      // occurs in the same durable write as the membership change.
      const next = { ...org.members, [member.subject]: member };
      if (!Object.values(next).some((item) => item.active && item.role === 'admin')) throw new Error('Last administrator');
      org.members[member.subject] = member;
      clearRuntimeGrants(org, member.subject);
      for (const session of Object.values(data.sessions)) {
        if (session.organizationId === actor.organizationId && session.subject === member.subject) session.revoked = true;
      }
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetSubject: member.subject,
        action: 'organization.member.update', outcome: 'allowed', at: new Date().toISOString() });
    });
  }

  /** Atomic, admin-only deactivation; never provisions or promotes an identity. */
  async deactivateMember(actor: VerifiedIdentity, subject: string): Promise<void> {
    if (!subjectIdentifier(subject)) throw new EnterpriseAccessDenied();
    const allowed = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const actorMember = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !actorMember?.active ||
          actorMember.organizationId !== actor.organizationId || !this.active(data, actor)) throw new EnterpriseAccessDenied();
      const canManage = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member: actorMember, sessionActive: true, action: 'member.manage' });
      const target = org.members[subject];
      const permitted = Boolean(canManage && target && target.active && target.organizationId === actor.organizationId &&
        !(target.role === 'admin' && !Object.values(org.members).some((m) => m.subject !== subject && m.active && m.role === 'admin')));
      if (!permitted || !target) {
        data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
          action: 'organization.member.deactivate', outcome: 'denied', at: new Date().toISOString() });
        return false;
      }
      org.members[subject] = { ...target, active: false };
      clearRuntimeGrants(org, subject);
      for (const session of Object.values(data.sessions)) {
        if (session.organizationId === actor.organizationId && session.subject === subject) session.revoked = true;
      }
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
        action: 'organization.member.deactivate', outcome: 'allowed', at: new Date().toISOString() });
      return true;
    });
    if (!allowed) throw new EnterpriseAccessDenied();
  }

  /** Remove a different administrator's directory role without granting a
   * replacement role or stranding the tenant. Existing sessions lose their
   * former authority in the same audited transaction. */
  async demoteAdministrator(actor: VerifiedIdentity, subject: string): Promise<void> {
    if (!subjectIdentifier(subject)) throw new EnterpriseAccessDenied();
    const allowed = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const actorMember = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !actorMember?.active ||
          actorMember.organizationId !== actor.organizationId || !this.active(data, actor)) throw new EnterpriseAccessDenied();
      const target = org.members[subject];
      const permitted = Boolean(subject !== actor.subject && target?.active && target.role === 'admin' &&
        target.organizationId === actor.organizationId &&
        evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
          issuer: org.issuer, member: actorMember, sessionActive: true, action: 'member.manage' }) &&
        Object.values(org.members).some((member) => member.subject !== subject && member.active && member.role === 'admin'));
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
        action: 'organization.member.demote', outcome: permitted ? 'allowed' : 'denied', at: new Date().toISOString() });
      if (!permitted || !target) return false;
      org.members[subject] = { ...target, role: 'member' };
      clearRuntimeGrants(org, subject);
      for (const session of Object.values(data.sessions)) {
        if (session.organizationId === actor.organizationId && session.subject === subject) session.revoked = true;
      }
      return true;
    });
    if (!allowed) throw new EnterpriseAccessDenied();
  }

  /** Revoke one existing member's sessions without changing membership. A
   * subsequent login is still possible; use deactivation to disable access. */
  async revokeMemberSessions(actor: VerifiedIdentity, subject: string): Promise<number> {
    if (!subjectIdentifier(subject)) throw new EnterpriseAccessDenied();
    const revoked = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const actorMember = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !actorMember?.active ||
          actorMember.organizationId !== actor.organizationId || !this.active(data, actor)) throw new EnterpriseAccessDenied();
      const permitted = subject !== actor.subject && evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member: actorMember, sessionActive: true, action: 'member.manage' }) &&
        org.members[subject]?.organizationId === actor.organizationId;
      if (!permitted) {
        data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
          action: 'organization.member.sessions.revoke', outcome: 'denied', at: new Date().toISOString() });
        return null;
      }
      let revoked = 0;
      for (const session of Object.values(data.sessions)) {
        if (session.organizationId === actor.organizationId && session.subject === subject && !session.revoked) {
          session.revoked = true;
          revoked++;
        }
      }
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
        action: 'organization.member.sessions.revoke', outcome: 'allowed', at: new Date().toISOString() });
      return revoked;
    });
    if (revoked === null) throw new EnterpriseAccessDenied();
    return revoked;
  }

  /** Tenant-wide emergency session kill. The initiating session is included.
   * This does not deprovision members or prevent a subsequent IdP login. */
  async revokeOrganizationSessions(actor: VerifiedIdentity): Promise<number> {
    const revoked = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !member?.active ||
          member.organizationId !== actor.organizationId || !this.active(data, actor)) throw new EnterpriseAccessDenied();
      const permitted = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member, sessionActive: true, action: 'member.manage' });
      if (!permitted) {
        data.audit.push({ organizationId: actor.organizationId, subject: actor.subject,
          action: 'organization.sessions.revoke-all', outcome: 'denied', at: new Date().toISOString() });
        return null;
      }
      const epoch = org.authEpoch ?? 0; // Legacy state without an epoch starts at zero.
      if (!Number.isSafeInteger(epoch + 1)) throw new Error('Organization login epoch exhausted');
      org.authEpoch = epoch + 1;
      // A callback which already consumed its attempt is still fenced at
      // createSession below, after its possibly slow IdP code exchange.
      for (const [state, attempt] of Object.entries(data.attempts)) {
        if (attempt.organizationId === actor.organizationId) delete data.attempts[state];
      }
      let count = 0;
      for (const session of Object.values(data.sessions)) {
        if (session.organizationId === actor.organizationId && !session.revoked) {
          session.revoked = true;
          count++;
        }
      }
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject,
        action: 'organization.sessions.revoke-all', outcome: 'allowed', at: new Date().toISOString() });
      return count;
    });
    if (revoked === null) throw new EnterpriseAccessDenied();
    return revoked;
  }

  async putAttempt(state: string, attempt: Omit<Attempt, 'authEpoch'>): Promise<void> {
    if (!key(state) || !key(attempt.organizationId) || !attempt.nonce || !attempt.verifier || !attempt.bindingHash ||
        !Number.isFinite(attempt.expiresAt) || attempt.expiresAt > Date.now() + 5 * 60_000) throw new Error('Invalid attempt');
    await this.change((data) => {
      const org = data.organizations[attempt.organizationId];
      if (org?.issuer !== attempt.issuer || data.attempts[state]) throw new Error('Unknown organization, issuer, or duplicate state');
      // A public login-start request cannot grow the durable state without
      // bound. Tenant-scoped expiry cleanup and quota are one locked write;
      // ingress rate limiting is still a separate deployment requirement.
      let live = 0;
      const now = Date.now();
      for (const [storedState, existing] of Object.entries(data.attempts)) {
        if (existing.organizationId !== attempt.organizationId) continue;
        if (existing.expiresAt <= now) delete data.attempts[storedState];
        else live++;
      }
      if (live >= MAX_ACTIVE_LOGIN_ATTEMPTS_PER_ORGANIZATION) throw new Error('OIDC login capacity reached');
      data.attempts[state] = { ...attempt, authEpoch: org.authEpoch ?? 0 };
    });
  }

  async takeAttempt(state: string, binding: string): Promise<Attempt | null> {
    if (!key(state) || !binding) return null;
    return this.change((data) => {
      const attempt = data.attempts[state];
      delete data.attempts[state]; // consume even when binding is wrong
      if (!attempt || attempt.expiresAt <= Date.now() || !eq(attempt.bindingHash, digest(binding)) ||
          (attempt.authEpoch ?? 0) !== (data.organizations[attempt.organizationId]?.authEpoch ?? 0)) return null;
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

  async createSession(issuer: string, organizationId: string, subject: string, expiry: number,
    expectedAuthEpoch = 0, accountDomain?: string): Promise<{ token: string; identity: VerifiedIdentity }> {
    if (!key(organizationId) || !subjectIdentifier(subject) || !issuer || expiry <= Date.now() || expiry > Date.now() + 8 * 60 * 60_000 ||
        !Number.isSafeInteger(expectedAuthEpoch) || expectedAuthEpoch < 0) throw new Error('Invalid session');
    const token = randomBytes(32).toString('base64url');
    const sessionId = digest(token);
    if (accountDomain !== undefined && (verifiedDomainName(accountDomain) !== accountDomain ||
        !this.store?.changeWithDomainClaim)) throw new Error('Verified account domain required');
    const issue = (data: Data) => {
      const member = data.organizations[organizationId]?.members[subject];
      if (!member?.active || member.organizationId !== organizationId || data.organizations[organizationId]?.issuer !== issuer ||
          (data.organizations[organizationId]?.authEpoch ?? 0) !== expectedAuthEpoch) throw new Error('Unprovisioned identity, issuer, or login epoch mismatch');
      if (accountDomain) {
        const proof = data.organizations[organizationId]?.domainProofs?.[accountDomain];
        if (proof?.issuer !== issuer || !proof.verifiedUntil || proof.verifiedUntil <= Date.now() ||
            otherActiveDomainClaim(data, organizationId, accountDomain, Date.now())) {
          throw new Error('Verified account domain required');
        }
      }
      data.sessions[sessionId] = { issuer, organizationId, subject, expiresAt: expiry, revoked: false,
        ...(accountDomain ? { accountDomain } : {}) };
      data.audit.push({ organizationId, subject, action: 'session.create', outcome: 'allowed', at: new Date().toISOString() });
    };
    if (accountDomain) await this.store!.changeWithDomainClaim!(organizationId, issuer, accountDomain, issue);
    else await this.change(issue);
    return { token, identity: { issuer, organizationId, subject, sessionId } };
  }

  async verifySession(token: string): Promise<VerifiedIdentity | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const sessionId = digest(token);
    const data = await this.read();
    const session = data.sessions[sessionId];
    if (!session) return null;
    const identity = { issuer: session.issuer, organizationId: session.organizationId, subject: session.subject, sessionId };
    if (!this.active(data, identity)) return null;
    if (session.accountDomain && !await this.domainClaimVerifiedForLogin(
      session.organizationId, session.issuer, session.accountDomain)) return null;
    return identity;
  }

  /** Production HTTP composition cannot accept an unbound operator/pilot
   * session, even if a caller supplies a permissive verifier. Later directory
   * actions re-lock the same claim before committing a read or mutation. */
  async verifyBoundSession(token: string, accountDomain: string): Promise<VerifiedIdentity | null> {
    if (verifiedDomainName(accountDomain) !== accountDomain || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const sessionId = digest(token);
    const data = await this.read();
    const session = data.sessions[sessionId];
    if (!session || session.accountDomain !== accountDomain) return null;
    const identity = { issuer: session.issuer, organizationId: session.organizationId, subject: session.subject, sessionId };
    return this.active(data, identity) && await this.domainClaimVerifiedForLogin(
      identity.organizationId, identity.issuer, accountDomain) ? identity : null;
  }

  /** Domain-proof routes only. Renewing a lease must not depend on that lease
   * still being current, or a lapse during DNS propagation locks every
   * administrator out. The session itself must still be live and unrevoked,
   * its member active, and the tenant must still hold the global claim; the
   * directory admits only challenge, verify and status for this exact bound
   * domain on that basis and rechecks role and claim under its lock. */
  async verifyBoundSessionForDomainRenewal(token: string, accountDomain: string): Promise<VerifiedIdentity | null> {
    if (verifiedDomainName(accountDomain) !== accountDomain || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    if (!this.store?.domainClaimStatus || !this.store.changeWithDomainClaim) return null;
    const sessionId = digest(token);
    const data = await this.read();
    const session = data.sessions[sessionId];
    if (!session || session.accountDomain !== accountDomain) return null;
    const identity = { issuer: session.issuer, organizationId: session.organizationId, subject: session.subject, sessionId };
    return this.active(data, identity, accountDomain) && await this.store.domainClaimStatus(
      identity.organizationId, identity.issuer, accountDomain) ? identity : null;
  }

  /** `renewalDomain` is passed only by the domain-proof operations. It waives
   * the lease-freshness requirement for a session bound to that same domain,
   * never for any other action or domain. */
  private active(data: Data, identity: VerifiedIdentity, renewalDomain?: string): boolean {
    const session = data.sessions[identity.sessionId];
    const org = data.organizations[identity.organizationId];
    const member = org?.members[identity.subject];
    const proof = session?.accountDomain ? org?.domainProofs?.[session.accountDomain] : undefined;
    return Boolean(session && !session.revoked && session.expiresAt > Date.now() && session.issuer === identity.issuer &&
      session.subject === identity.subject && session.organizationId === identity.organizationId &&
      org?.issuer === identity.issuer && member?.active && member.organizationId === identity.organizationId &&
      member.subject === identity.subject &&
      (!session.accountDomain || (proof?.issuer === identity.issuer && (session.accountDomain === renewalDomain ||
        (proof.verifiedUntil && proof.verifiedUntil > Date.now())))));
  }

  async sessionIsActive(identity: VerifiedIdentity): Promise<boolean> {
    const data = await this.read();
    if (!this.active(data, identity)) return false;
    const domain = data.sessions[identity.sessionId]?.accountDomain;
    return !domain || this.domainClaimVerifiedForLogin(identity.organizationId, identity.issuer, domain);
  }

  async revokeSession(identity: VerifiedIdentity): Promise<void> {
    await this.changeForIdentity(identity, (data) => {
      if (!this.active(data, identity)) throw new Error('Session inactive');
      data.sessions[identity.sessionId]!.revoked = true;
      data.audit.push({ organizationId: identity.organizationId, subject: identity.subject, action: 'session.revoke', outcome: 'allowed', at: new Date().toISOString() });
    });
  }

  async recordAudit(event: Omit<Audit, 'at'>): Promise<void> {
    await this.change((data) => { data.audit.push({ ...event, at: new Date().toISOString() }); });
  }

  /** Record a cross-tenant URL probe only in the authenticated actor's own
   * ledger. A forged/stale identity cannot attribute a denial to another org. */
  async recordTenantDenial(actor: VerifiedIdentity, targetOrganizationId: string,
    view: 'overview' | 'members' | 'activity' | 'export' | 'deactivate' | 'demote' | 'revoke-sessions' | 'revoke-all-sessions' | 'logout' | 'domain.challenge' | 'domain.verify' | 'domain.status' | 'workspace.read' | 'workspace.create' | 'workspace.deactivate' | 'workspace.grants.read' | 'workspace.grants.change'): Promise<void> {
    if (!key(targetOrganizationId) || !['overview', 'members', 'activity', 'export', 'deactivate', 'demote', 'revoke-sessions', 'revoke-all-sessions', 'logout', 'domain.challenge', 'domain.verify', 'domain.status', 'workspace.read', 'workspace.create', 'workspace.deactivate', 'workspace.grants.read', 'workspace.grants.change'].includes(view)) {
      throw new EnterpriseAccessDenied();
    }
    await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      if (!org || org.issuer !== actor.issuer || !member?.active || member.organizationId !== actor.organizationId ||
          !this.active(data, actor)) throw new EnterpriseAccessDenied();
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject, targetOrganizationId,
        action: `organization.${view}.cross-tenant`, outcome: 'denied', at: new Date().toISOString() });
    });
  }

  async listAudit(actor: VerifiedIdentity, purpose: 'view' | 'export' = 'view'): Promise<readonly Audit[]> {
    if (purpose !== 'view' && purpose !== 'export') throw new EnterpriseAccessDenied();
    const events = await this.changeForIdentity(actor, (data) => {
      const org = data.organizations[actor.organizationId];
      const member = org?.members[actor.subject];
      // Only a presently active, tenant-bound member can be attributed to this
      // ledger. Never write a forged identity's denial into another tenant.
      if (!org || org.issuer !== actor.issuer || !member?.active || member.organizationId !== actor.organizationId ||
          !this.active(data, actor)) throw new EnterpriseAccessDenied();
      const allowed = evaluateTenantPolicy({ identity: actor, organizationId: actor.organizationId,
        issuer: org.issuer, member, sessionActive: true, action: 'audit.read' });
      // Authorization, scoped snapshot and audit commit share one exclusive transaction.
      const events = allowed ? data.audit.filter((event) => event.organizationId === actor.organizationId) : null;
      data.audit.push({ organizationId: actor.organizationId, subject: actor.subject,
        action: purpose === 'export' ? 'organization.audit.export' : 'organization.audit.read',
        outcome: allowed ? 'allowed' : 'denied', at: new Date().toISOString() });
      return events;
    });
    if (!events) throw new EnterpriseAccessDenied();
    return events;
  }
}
