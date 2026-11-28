import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolveTxt } from 'node:dns/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { EnterpriseDirectory, OrganizationMember, VerifiedIdentity } from './controlPlane';
import { evaluateTenantPolicy, type RuntimeAction } from './tenantPolicy';

type AuditTargetKind = 'organization' | 'domain' | 'workspace' | 'member';
type Audit = { organizationId: string; subject: string; targetSubject?: string; targetOrganizationId?: string; targetDomain?: string; targetWorkspaceId?: string;
  action: string; outcome: 'allowed' | 'denied'; at: string;
  /** Collapsed repeats only: `firstAt`..`at` and `count` occurrences, with a
   * caller-chosen target kept as a kind marker and short digest only while
   * every repeat has the same target. Never imply a count belongs to one
   * target when multiple values were attempted. */
  firstAt?: string; count?: number; targetDigest?: string; targetKind?: AuditTargetKind; mixedTargets?: boolean };
type Attempt = { organizationId: string; issuer: string; nonce: string; verifier: string; bindingHash: string; expiresAt: number; authEpoch?: number;
  purpose?: 'domain-recovery';
  /** Truncated digest of the starting client's network; quota bucket only. */
  clientHash?: string };
type Session = { organizationId: string; issuer: string; subject: string; expiresAt: number; revoked: boolean;
  accountDomain?: string; recoveryOnly?: true };
type DomainProof = { issuer: string; challengeHash: string; expiresAt: number; verifiedUntil?: number };
type WorkspaceRecord = { id: string; name: string; active: boolean; grants?: Record<string, RuntimeAction[]> };
export type DirectoryState = { version: 1 | 2; organizations: Record<string, { name: string; issuer: string;
  members: Record<string, OrganizationMember>; authEpoch?: number; domainProofs?: Record<string, DomainProof>;
  workspaces?: Record<string, WorkspaceRecord> }>;
  attempts: Record<string, Attempt>; sessions: Record<string, Session>; audit: Audit[];
  /** Version 2: persisted audit is empty; a tenant-RLS store verifies this
   * checkpoint against its separately durable append-only ledger. The store
   * may hydrate audit transiently for legacy read/export consumers. */
  auditCursor?: { count: number; lastId: number; tailDigest: string | null; latestAt: string | null };
  /** Open collapsed denials; `position` is the audit length when first seen.
   * Kept outside the append-only `audit` array so that it can count. */
  pendingAudit?: Array<{ position: number; event: Audit }> };
type Data = DirectoryState;
export const MAX_DIRECTORY_BYTES = 8_000_000;
/** Ordinary writes stop this far below MAX_DIRECTORY_BYTES. Only the writes
 * needed to recover a full tenant may use the rest: an allowed member
 * deactivation, member or organization session revocation, self sign-out,
 * an administrator sign-in (attempt start and consume, administrator session)
 * and expiry compaction. Attempts are bounded per tenant, so anonymous login
 * starts cannot exhaust it. */
export const RECOVERY_RESERVE_BYTES = 512_000;
/** Denied reads and cross-tenant denials repeat into one event per actor,
 * action, outcome and target kind in each fixed window. */
export const AUDIT_COLLAPSE_WINDOW_MS = 10 * 60_000;
type Recovery<T> = (data: DirectoryState, result: T) => boolean;
/** Bounds durable login-start state. Reaching either bound evicts an attempt
 * (see putAttempt); neither bound refuses a new login start. */
export const MAX_ACTIVE_LOGIN_ATTEMPTS_PER_ORGANIZATION = 256;
export const MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT = 32;
export type TenantAuditPage = Readonly<{ upperId: number; nextId: number | null; pendingCount: number;
  events: readonly { id: number; event: DirectoryState['audit'][number] }[] }>;
export interface EnterpriseStateStore {
  read(): Promise<DirectoryState>;
  change<T>(fn: (data: DirectoryState) => T, create?: boolean): Promise<T>;
  /** Only a store whose committed audit lives outside the directory row may
   * provide this. It must measure the exact bounded snapshot that its atomic
   * change persists, and must independently enforce MAX_DIRECTORY_BYTES.
   * Legacy/whole-history stores intentionally use the full state default. */
  snapshotBytes?(data: DirectoryState): number;
  /** v2 cannot return an incomplete array through the legacy unpaged export. */
  requiresPagedAudit?: boolean;
  /** A negative-only preflight: it must never authorize a callback. A found
   * attempt is always rechecked under the store's locked change boundary. */
  probeAttempt?(stateKey: string): Promise<DirectoryState['attempts'][string] | undefined>;
  probeDomainRecovery?(organizationId: string, issuer: string, domain: string): Promise<boolean>;
  readAuditPage?(identity: VerifiedIdentity, afterId: number, upperId?: number, limit?: number,
    purpose?: 'view' | 'export'): Promise<TenantAuditPage>;
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

/** A caller-chosen target is never stored verbatim in a collapsed event. */
const auditTarget = (kind: AuditTargetKind, value: string) => `${kind}:${digest(value).slice(0, 16)}`;
const targetKind = (event: Audit) => event.targetKind ?? event.targetDigest?.slice(0, event.targetDigest.indexOf(':')) ?? '';

/** Record a repeatable denial without growing the snapshot per request.
 * The open window's counter lives in `pendingAudit`; a closed
 * window is appended to `audit` as one event (in the RLS store, one
 * append-only ledger row) in the same transaction as the next such denial.
 * Successful mutations are never passed here. */
function appendRepeatableDenial(data: Data, organizationId: string, subject: string, action: string, targetDigest?: string): void {
  const now = Date.now();
  const window = Math.floor(now / AUDIT_COLLAPSE_WINDOW_MS);
  const pending = data.pendingAudit ??= [];
  for (let index = 0; index < pending.length;) {
    if (Math.floor(Date.parse(pending[index]!.event.firstAt!) / AUDIT_COLLAPSE_WINDOW_MS) < window) {
      data.audit.push(pending.splice(index, 1)[0]!.event);
    } else index++;
  }
  const at = new Date(now).toISOString();
  const kind = targetDigest?.slice(0, targetDigest.indexOf(':')) ?? '';
  const open = pending.find(({ event }) => event.organizationId === organizationId && event.subject === subject &&
    event.action === action && event.outcome === 'denied' && targetKind(event) === kind);
  if (open) {
    if (open.event.targetDigest !== targetDigest && !open.event.mixedTargets) {
      delete open.event.targetDigest;
      open.event.targetKind = kind as AuditTargetKind;
      open.event.mixedTargets = true;
    }
    open.event.count = (open.event.count ?? 1) + 1;
    if (at > open.event.at) open.event.at = at; // Another host's clock may be ahead.
    return;
  }
  pending.push({ position: (data.auditCursor?.count ?? 0) + data.audit.length,
    event: { organizationId, subject, action, outcome: 'denied', at,
    firstAt: at, count: 1, ...(targetDigest ? { targetDigest } : {}) } });
}

/** Normalize each new event at its call site, before any other audit helper
 * can flush an older window. Never splice a transaction's audit tail: a
 * pending event's position and the separate RLS ledger must retain order. */
export function appendScopedAudit(data: Data, event: Audit): void {
  if (event.outcome !== 'denied' || data.organizations[event.organizationId]?.members[event.subject]?.role !== 'member') {
    data.audit.push(event);
    return;
  }
  const target = event.targetDigest ?? (event.targetOrganizationId ? auditTarget('organization', event.targetOrganizationId)
    : event.targetDomain ? auditTarget('domain', event.targetDomain)
    : event.targetWorkspaceId ? auditTarget('workspace', event.targetWorkspaceId)
    : event.targetSubject ? auditTarget('member', event.targetSubject) : undefined);
  appendRepeatableDenial(data, event.organizationId, event.subject, event.action, target);
}

/** Committed events in order, each open collapsed denial where it was first seen. */
function auditView(data: Data, organizationId: string): Audit[] {
  const pending = data.pendingAudit ?? [];
  const view: Audit[] = [];
  let next = 0;
  data.audit.forEach((event, index) => {
    while (next < pending.length && pending[next]!.position <= index) view.push(pending[next++]!.event);
    view.push(event);
  });
  while (next < pending.length) view.push(pending[next++]!.event);
  return view.filter((event) => event.organizationId === organizationId);
}

function auditSummaryView(data: Data, organizationId: string): { eventCount: number; latestAt: string | null } {
  if (data.version === 1) {
    const events = auditView(data, organizationId);
    return { eventCount: events.length, latestAt: events[events.length - 1]?.at ?? null };
  }
  if (!Object.prototype.hasOwnProperty.call(data.organizations, organizationId)) {
    return { eventCount: 0, latestAt: null };
  }
  const pending = (data.pendingAudit ?? []).filter(({ event }) => event.organizationId === organizationId);
  const appended = data.audit.filter((event) => event.organizationId === organizationId);
  const latest = [data.auditCursor!.latestAt, ...pending.map(({ event }) => event.at), ...appended.map((event) => event.at)]
    .filter((at): at is string => Boolean(at)).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { eventCount: data.auditCursor!.count + pending.length + appended.length,
    latestAt: latest[latest.length - 1] ?? null };
}

export function validateDirectoryState(data: Data): void {
  if ((data.version !== 1 && data.version !== 2) || !record(data.organizations) || !record(data.sessions) ||
      !record(data.attempts) || !Array.isArray(data.audit)) throw new Error('Directory state is invalid');
  if (data.version === 1 ? data.auditCursor !== undefined :
      !record(data.auditCursor) || !Number.isSafeInteger(data.auditCursor.count) || data.auditCursor.count < 0 ||
      !Number.isSafeInteger(data.auditCursor.lastId) || data.auditCursor.lastId < 0 ||
      (data.auditCursor.tailDigest !== null && (typeof data.auditCursor.tailDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(data.auditCursor.tailDigest))) ||
      (data.auditCursor.latestAt !== null && (typeof data.auditCursor.latestAt !== 'string' ||
        !Number.isFinite(Date.parse(data.auditCursor.latestAt)))) ||
      (data.auditCursor.count === 0) !== (data.auditCursor.lastId === 0) ||
      (data.auditCursor.count === 0) !== (data.auditCursor.tailDigest === null) ||
      (data.auditCursor.count === 0) !== (data.auditCursor.latestAt === null)) {
    throw new Error('Directory audit cursor is invalid');
  }
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
        (attempt.clientHash !== undefined && (typeof attempt.clientHash !== 'string' || !/^[a-f0-9]{32}$/.test(attempt.clientHash))) ||
        (attempt.purpose !== undefined && attempt.purpose !== 'domain-recovery') ||
        (attempt.authEpoch !== undefined && (!Number.isSafeInteger(attempt.authEpoch) || attempt.authEpoch < 0))) throw new Error('Directory attempt is invalid');
  }
  for (const [hash, session] of Object.entries(data.sessions)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !record(session) || !key(session.organizationId as string) ||
        data.organizations[session.organizationId as string]?.issuer !== session.issuer ||
        !subjectIdentifier(session.subject) || !Object.prototype.hasOwnProperty.call(
          data.organizations[session.organizationId as string]?.members ?? {}, session.subject as string) ||
        typeof session.expiresAt !== 'number' || !Number.isFinite(session.expiresAt) || typeof session.revoked !== 'boolean' ||
        (session.accountDomain !== undefined && verifiedDomainName(session.accountDomain as string) !== session.accountDomain) ||
        (session.recoveryOnly !== undefined && (session.recoveryOnly !== true || !session.accountDomain))) {
      throw new Error('Directory session is invalid');
    }
  }
  const invalidAudit = (event: Audit) => !record(event) || !key(event.organizationId as string) || !data.organizations[event.organizationId as string] ||
        !subjectIdentifier(event.subject) || typeof event.action !== 'string' || !event.action ||
        (event.targetSubject !== undefined && !subjectIdentifier(event.targetSubject)) ||
        (event.targetOrganizationId !== undefined && !key(event.targetOrganizationId as string)) ||
        (event.targetDomain !== undefined && verifiedDomainName(event.targetDomain as string) !== event.targetDomain) ||
        (event.targetWorkspaceId !== undefined && !key(event.targetWorkspaceId as string)) ||
        (event.targetDigest !== undefined && (typeof event.targetDigest !== 'string' ||
          !/^(?:organization|domain|workspace|member):[a-f0-9]{16}$/.test(event.targetDigest))) ||
        (event.mixedTargets !== undefined && (event.mixedTargets !== true || event.targetDigest !== undefined ||
          !['organization', 'domain', 'workspace', 'member'].includes(event.targetKind as string))) ||
        (event.targetKind !== undefined && event.mixedTargets !== true) ||
        (event.count !== undefined && (!Number.isSafeInteger(event.count) || event.count < 1)) ||
        (event.firstAt !== undefined && (typeof event.firstAt !== 'string' || !(Date.parse(event.firstAt) <= Date.parse(event.at)))) ||
        !['allowed', 'denied'].includes(event.outcome as string) ||
        typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at));
  for (const event of data.audit) {
    if (invalidAudit(event)) throw new Error('Directory audit is invalid');
  }
  if (data.pendingAudit !== undefined) {
    if (!Array.isArray(data.pendingAudit)) throw new Error('Directory audit is invalid');
    let previous = 0;
    for (const entry of data.pendingAudit) {
      if (!record(entry) || !Number.isSafeInteger(entry.position) || entry.position < previous ||
          entry.position > (data.auditCursor?.count ?? 0) + data.audit.length ||
          invalidAudit(entry.event) || entry.event.outcome !== 'denied' ||
          entry.event.count === undefined || entry.event.firstAt === undefined) throw new Error('Directory audit is invalid');
      previous = entry.position;
    }
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
        appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject,
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

  /** Every store still enforces MAX_DIRECTORY_BYTES. Ordinary writes must
   * also leave RECOVERY_RESERVE_BYTES free; `recovery` admits a recovery
   * write (judged on its own outcome) into that reserve. */
  private bounded<T>(fn: (data: Data) => T, recovery?: Recovery<T>): (data: Data) => T {
    return (data) => {
      const result = fn(data);
      const bytes = this.store?.snapshotBytes?.(data) ?? Buffer.byteLength(JSON.stringify(data), 'utf8');
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid directory snapshot size');
      if (!recovery?.(data, result) &&
          bytes > MAX_DIRECTORY_BYTES - RECOVERY_RESERVE_BYTES) {
        throw new Error('Directory capacity reached');
      }
      return result;
    };
  }

  private async change<T>(unbounded: (data: Data) => T, create = false, recovery?: Recovery<T>): Promise<T> {
    const fn = this.bounded(unbounded, recovery);
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
  private async changeForIdentity<T>(identity: VerifiedIdentity, fn: (data: Data) => T, recovery?: Recovery<T>): Promise<T> {
    const session = (await this.read()).sessions[identity.sessionId];
    const domain = session?.organizationId === identity.organizationId && session.issuer === identity.issuer &&
      session.subject === identity.subject ? session.accountDomain : undefined;
    if (!domain) return this.change(fn, false, recovery);
    if (!this.store?.changeWithDomainClaim) throw new EnterpriseAccessDenied();
    return this.store.changeWithDomainClaim(identity.organizationId, identity.issuer, domain, this.bounded((data) => {
      if (data.sessions[identity.sessionId]?.accountDomain !== domain) throw new EnterpriseAccessDenied();
      return fn(data);
    }, recovery));
  }

  /** Explicit operator-only bootstrap. Never called by an unauthenticated HTTP route. */
  async bootstrap(organizationId: string, name: string, issuer: string, admin: OrganizationMember): Promise<void> {
    if (!key(organizationId) || !subjectIdentifier(admin.subject) || admin.organizationId !== organizationId || !admin.active || admin.role !== 'admin' || !name.trim() || !issuer) throw new Error('Invalid bootstrap');
    await this.change((data) => {
      if (data.organizations[organizationId]) throw new Error('Organization already exists');
      data.organizations[organizationId] = { name: name.trim(), issuer, members: dictionary({ [admin.subject]: admin }), authEpoch: 0 };
      appendScopedAudit(data, { organizationId, subject: admin.subject, action: 'organization.bootstrap', outcome: 'allowed', at: new Date().toISOString() });
    }, true);
  }

  async organization(organizationId: string): Promise<{ id: string; name: string; memberCount: number } | null> {
    const org = (await this.read()).organizations[organizationId];
    return org ? { id: organizationId, name: org.name, memberCount: Object.keys(org.members).length } : null;
  }

  async auditSummary(organizationId: string): Promise<{ eventCount: number; latestAt: string | null }> {
    return auditSummaryView(await this.read(), organizationId);
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
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetDomain: domain,
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
      if (!permitted) appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject,
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
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetDomain: domain,
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

  /** Negative-only anonymous preflight for an expired *previously proven*
   * domain. No ordinary login or authorization is granted by this probe;
   * the eventual session write rechecks membership, epoch and the locked
   * global claim. File, pilot and unknown stores fail closed. */
  async domainClaimHeldForRecovery(organizationId: string, issuer: string, inputDomain: string): Promise<boolean> {
    const domain = verifiedDomainName(inputDomain);
    if (!domain || domain !== inputDomain || !this.store?.probeDomainRecovery ||
        !this.store.domainClaimStatus || !this.store.changeWithDomainClaim) return false;
    if (!await this.store.probeDomainRecovery(organizationId, issuer, domain)) return false;
    return this.store.domainClaimStatus(organizationId, issuer, domain);
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
      if (!permitted) {
        appendRepeatableDenial(data, actor.organizationId, actor.subject, 'organization.domain.status', auditTarget('domain', domain));
        return null;
      }
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetDomain: domain,
        action: 'organization.domain.status', outcome: 'allowed', at: new Date().toISOString() });
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
      if (allowed) appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject,
        action: 'organization.workspaces.read', outcome: 'allowed', at: new Date().toISOString() });
      else appendRepeatableDenial(data, actor.organizationId, actor.subject, 'organization.workspaces.read');
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
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetWorkspaceId: id,
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
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
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
      if (!permitted) {
        appendRepeatableDenial(data, actor.organizationId, actor.subject, 'organization.runtime.grants.read',
          auditTarget('workspace', workspaceId));
        return null;
      }
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetWorkspaceId: workspaceId,
        action: 'organization.runtime.grants.read', outcome: 'allowed', at: new Date().toISOString() });
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
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetWorkspaceId: id,
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
          const audit = auditSummaryView(data, identity.organizationId);
          payload = {
            organization: { id: identity.organizationId, name: org.name },
            users: { total: members.length, active: members.filter((m) => m.active).length, admins: members.filter((m) => m.active && m.role === 'admin').length },
            audit,
            identity: { issuer: identity.issuer, subject: identity.subject, status: 'verified session' },
            controls: { policy: 'not enforced', provisioning: 'not configured', modelRegistry: 'not configured' },
          };
        }
      }
      if (allowed) appendScopedAudit(data, { organizationId: identity.organizationId, subject: identity.subject,
        action: `organization.${view}.read`, outcome: 'allowed', at: new Date().toISOString() });
      else appendRepeatableDenial(data, identity.organizationId, identity.subject, `organization.${view}.read`);
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
      appendScopedAudit(data, { organizationId: identity.organizationId, subject: identity.subject,
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
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetSubject: member.subject,
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
        appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
          action: 'organization.member.deactivate', outcome: 'denied', at: new Date().toISOString() });
        return false;
      }
      org.members[subject] = { ...target, active: false };
      clearRuntimeGrants(org, subject);
      for (const session of Object.values(data.sessions)) {
        if (session.organizationId === actor.organizationId && session.subject === subject) session.revoked = true;
      }
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
        action: 'organization.member.deactivate', outcome: 'allowed', at: new Date().toISOString() });
      return true;
    }, (_data, permitted) => permitted); // Recovery: only an allowed deactivation may use the reserve.
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
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
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
        appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
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
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject, targetSubject: subject,
        action: 'organization.member.sessions.revoke', outcome: 'allowed', at: new Date().toISOString() });
      return revoked;
    }, (_data, count) => count !== null); // Recovery: allowed revocation only.
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
        appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject,
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
      appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject,
        action: 'organization.sessions.revoke-all', outcome: 'allowed', at: new Date().toISOString() });
      return count;
    }, (_data, count) => count !== null); // Recovery: allowed revocation only.
    if (revoked === null) throw new EnterpriseAccessDenied();
    return revoked;
  }

  /** `clientNetwork` is the caller's transport-level network (never a
   * forwarded header); only its truncated digest is stored, with the attempt. */
  async putAttempt(state: string, attempt: Omit<Attempt, 'authEpoch' | 'clientHash'>, clientNetwork = ''): Promise<void> {
    if (!key(state) || !key(attempt.organizationId) || !attempt.nonce || !attempt.verifier || !attempt.bindingHash ||
        !Number.isFinite(attempt.expiresAt) || attempt.expiresAt > Date.now() + 5 * 60_000 ||
        typeof clientNetwork !== 'string' || clientNetwork.length > 64) throw new Error('Invalid attempt');
    const clientHash = digest(`oidc-login-client:${clientNetwork}`).slice(0, 32);
    const stateKey = digest(state); // The browser-visible state is never stored in clear.
    await this.change((data) => {
      const org = data.organizations[attempt.organizationId];
      if (org?.issuer !== attempt.issuer || data.attempts[stateKey]) throw new Error('Unknown organization, issuer, or duplicate state');
      // A public login-start request cannot grow the durable state without
      // bound, and must not let one client stop every other client from
      // starting a login. Expired attempts are pruned and never count. A full
      // client allowance evicts that client's own oldest attempt; a full
      // tenant evicts the oldest attempt of the busiest client. Neither
      // refuses. Ingress rate limiting is still a deployment requirement.
      const now = Date.now();
      const live = new Map<string, Array<[string, Attempt]>>();
      let total = 0;
      for (const [storedState, existing] of Object.entries(data.attempts)) {
        if (existing.organizationId !== attempt.organizationId) continue;
        if (existing.expiresAt <= now) { delete data.attempts[storedState]; continue; }
        const bucket = live.get(existing.clientHash ?? '') ?? [];
        bucket.push([storedState, existing]);
        live.set(existing.clientHash ?? '', bucket);
        total++;
      }
      const evictOldest = (entries: Array<[string, Attempt]>) => {
        delete data.attempts[entries.reduce((oldest, entry) => entry[1].expiresAt < oldest[1].expiresAt ? entry : oldest)[0]];
      };
      const own = live.get(clientHash) ?? [];
      if (own.length >= MAX_ACTIVE_LOGIN_ATTEMPTS_PER_CLIENT) evictOldest(own);
      else if (total >= MAX_ACTIVE_LOGIN_ATTEMPTS_PER_ORGANIZATION) {
        const busiest = Math.max(...[...live.values()].map((entries) => entries.length));
        evictOldest([...live.values()].filter((entries) => entries.length === busiest).flat());
      }
      data.attempts[stateKey] = { ...attempt, clientHash, authEpoch: org.authEpoch ?? 0 };
    }, false, () => true); // Recovery (administrator sign-in); bounded by the attempt quotas above.
  }

  /** An unknown, expired or wrongly bound state is rejected by a plain read
   * and never takes the write lock or rewrites the tenant row. A matching
   * attempt is rechecked and consumed under the lock: exactly one of two
   * concurrent callbacks for the same state can obtain it. */
  async takeAttempt(state: string, binding: string): Promise<Attempt | null> {
    if (!key(state) || !binding) return null;
    const stateKey = digest(state);
    const bindingHash = digest(binding);
    const candidate = this.store?.probeAttempt
      ? await this.store.probeAttempt(stateKey) : (await this.read()).attempts[stateKey];
    if (!candidate || candidate.expiresAt <= Date.now() || !eq(candidate.bindingHash, bindingHash)) return null;
    return this.change((data) => {
      const attempt = data.attempts[stateKey];
      delete data.attempts[stateKey];
      if (!attempt || attempt.expiresAt <= Date.now() || !eq(attempt.bindingHash, bindingHash) ||
          (attempt.authEpoch ?? 0) !== (data.organizations[attempt.organizationId]?.authEpoch ?? 0)) return null;
      return attempt;
    }, false, () => true); // Recovery: consuming an attempt only shrinks the state.
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
    }, false, () => true); // Recovery: compaction only shrinks the state.
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
      appendScopedAudit(data, { organizationId, subject, action: 'session.create', outcome: 'allowed', at: new Date().toISOString() });
    };
    // Recovery: an administrator can always sign in to a full tenant; a member cannot.
    const recovery = (data: Data) => data.organizations[organizationId]?.members[subject]?.role === 'admin';
    if (accountDomain) await this.store!.changeWithDomainClaim!(organizationId, issuer, accountDomain, this.bounded(issue, recovery));
    else await this.change(issue, false, recovery);
    return { token, identity: { issuer, organizationId, subject, sessionId } };
  }

  /** A server-verified IdP administrator identity may obtain only a short
   * domain-proof renewal session after its existing lease lapses. This is
   * not an HTTP route or an OIDC credential exchange. The caller must bind
   * issuer, subject, verified email domain and one-time login epoch before
   * invoking it; the RLS claim is locked through the atomic write. */
  async createDomainRecoverySession(issuer: string, organizationId: string, subject: string,
    expiry: number, expectedAuthEpoch: number, accountDomain: string): Promise<{ token: string; identity: VerifiedIdentity }> {
    if (!key(organizationId) || !subjectIdentifier(subject) || !issuer ||
        verifiedDomainName(accountDomain) !== accountDomain || !this.store?.changeWithDomainClaim ||
        !Number.isSafeInteger(expectedAuthEpoch) || expectedAuthEpoch < 0 ||
        expiry <= Date.now() || expiry > Date.now() + 10 * 60_000) throw new Error('Invalid recovery identity');
    const token = randomBytes(32).toString('base64url');
    const sessionId = digest(token);
    await this.store.changeWithDomainClaim(organizationId, issuer, accountDomain, this.bounded((data) => {
      const org = data.organizations[organizationId];
      const member = org?.members[subject];
      const proof = org?.domainProofs?.[accountDomain];
      if (org?.issuer !== issuer || !member?.active || member.role !== 'admin' ||
          member.organizationId !== organizationId || member.subject !== subject ||
          (org.authEpoch ?? 0) !== expectedAuthEpoch || proof?.issuer !== issuer ||
          !proof.verifiedUntil || proof.verifiedUntil > Date.now() ||
          otherActiveDomainClaim(data, organizationId, accountDomain, Date.now())) {
        throw new Error('Domain recovery is unavailable');
      }
      for (const session of Object.values(data.sessions)) {
        if (session.organizationId === organizationId && session.subject === subject && session.recoveryOnly) {
          session.revoked = true;
        }
      }
      data.sessions[sessionId] = { issuer, organizationId, subject, expiresAt: expiry, revoked: false,
        accountDomain, recoveryOnly: true };
      appendScopedAudit(data, { organizationId, subject, action: 'session.domain-recovery.create',
        outcome: 'allowed', at: new Date().toISOString() });
    }, () => true)); // Admin recovery remains possible near the snapshot cap.
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
      (!session.recoveryOnly || renewalDomain === session.accountDomain) &&
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
      appendScopedAudit(data, { organizationId: identity.organizationId, subject: identity.subject, action: 'session.revoke', outcome: 'allowed', at: new Date().toISOString() });
    }, () => true); // Recovery: each self sign-out consumes a live session, so it cannot repeat without a sign-in.
  }

  async recordAudit(event: Omit<Audit, 'at'>): Promise<void> {
    await this.change((data) => { appendScopedAudit(data, { ...event, at: new Date().toISOString() }); });
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
      // The probed identifier is caller-chosen: keep only a marked digest.
      appendRepeatableDenial(data, actor.organizationId, actor.subject, `organization.${view}.cross-tenant`,
        auditTarget('organization', targetOrganizationId));
    });
  }

  async listAuditPage(actor: VerifiedIdentity, afterId: number, upperId?: number, limit = 100,
    purpose: 'view' | 'export' = 'view'): Promise<TenantAuditPage> {
    if (!this.store?.requiresPagedAudit || !this.store.readAuditPage) throw new Error('Paged tenant audit is unavailable');
    return this.store.readAuditPage(actor, afterId, upperId, limit, purpose);
  }

  async listAudit(actor: VerifiedIdentity, purpose: 'view' | 'export' = 'view'): Promise<readonly Audit[]> {
    if (purpose !== 'view' && purpose !== 'export') throw new EnterpriseAccessDenied();
    if (this.store?.requiresPagedAudit) throw new Error('Paged tenant audit read is required');
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
      const events = allowed ? auditView(data, actor.organizationId) : null;
      const action = purpose === 'export' ? 'organization.audit.export' : 'organization.audit.read';
      if (allowed) appendScopedAudit(data, { organizationId: actor.organizationId, subject: actor.subject,
        action, outcome: 'allowed', at: new Date().toISOString() });
      else appendRepeatableDenial(data, actor.organizationId, actor.subject, action);
      return events;
    });
    if (!events) throw new EnterpriseAccessDenied();
    return events;
  }
}
