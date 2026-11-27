// Local visual acceptance only. No OIDC issuer, credential, or production route.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EnterpriseAdminDashboard } from '../../src/components/settings/EnterpriseAdminDashboard';
import '../../src/index.css';

const organizationId = 'synthetic-org';
const members = [
  { subject: 'alice', displayName: 'Alice Admin', role: 'admin', active: true },
  { subject: 'dave', displayName: 'Dave Admin', role: 'admin', active: true },
  { subject: 'bob', displayName: 'Bob Member', role: 'member', active: true },
];
const events = [{ organizationId, subject: 'alice', action: 'organization.bootstrap', outcome: 'allowed', at: '2026-11-08T00:00:00Z' }];
let denied = sessionStorage.getItem('enterprise-fixture-denied') === '1';
let pendingDomain = '';
// A visual-only stand-in for a persisted server status across fixture reloads.
let verifiedDomain = sessionStorage.getItem('enterprise-fixture-observed-domain') ?? '';
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(`/api/enterprise/organizations/${organizationId}/`)) return originalFetch(input, init);
  if (denied) return new Response(null, { status: 403 });
  if (url.includes('/domains/status?')) {
    const domain = new URL(url, window.location.origin).searchParams.get('domain') ?? '';
    return Response.json({ domain, challengeExpiresAt: pendingDomain === domain ? Date.now() + 5 * 60_000 : null,
      verifiedUntil: verifiedDomain === domain ? Date.now() + 24 * 60 * 60_000 : null });
  }
  const suffix = url.split('/').slice(-1)[0];
  if (init?.method === 'POST' && (suffix === 'challenge' || suffix === 'verify')) {
    const domain = JSON.parse(String(init.body)).domain as string;
    if (suffix === 'challenge') {
      pendingDomain = domain;
      verifiedDomain = '';
      sessionStorage.removeItem('enterprise-fixture-observed-domain');
      events.push({ organizationId, subject: 'alice', action: 'organization.domain.challenge', outcome: 'allowed', at: new Date().toISOString() });
      return Response.json({ name: `_interpreter-workstation.${domain}`,
        value: 'interpreter-workstation-verification=' + 'a'.repeat(43), expiresAt: Date.now() + 5 * 60_000 });
    }
    if (domain !== pendingDomain) return new Response(null, { status: 403 });
    pendingDomain = '';
    verifiedDomain = domain;
    sessionStorage.setItem('enterprise-fixture-observed-domain', domain);
    events.push({ organizationId, subject: 'alice', action: 'organization.domain.verify', outcome: 'allowed', at: new Date().toISOString() });
    return new Response(null, { status: 204 });
  }
  let data: unknown;
  if (suffix === 'export') {
    data = { organizationId, events: [...events] };
    events.push({ organizationId, subject: 'alice', action: 'organization.audit.export', outcome: 'allowed', at: new Date().toISOString() });
  } else if (suffix === 'activity') data = { organizationId, events: events.slice(-20) };
  else if (suffix === 'members') data = { organizationId, members };
  else if (suffix === 'overview') data = { organization: { id: organizationId, name: 'Northstar Studio' },
    users: { total: members.length, active: members.filter((m) => m.active).length,
      admins: members.filter((m) => m.active && m.role === 'admin').length },
    audit: { eventCount: events.length, latestAt: events.at(-1)?.at ?? null },
    identity: { issuer: 'https://fixture.invalid/issuer', subject: 'alice', status: 'synthetic fixture session' },
    controls: { policy: 'not enforced', provisioning: 'not configured', modelRegistry: 'not configured' } };
  else if (init?.method === 'POST' && suffix === 'revoke-all' && url.endsWith('/sessions/revoke-all')) {
    events.push({ organizationId, subject: 'alice', action: 'organization.sessions.revoke-all', outcome: 'allowed', at: new Date().toISOString() });
    denied = true;
    sessionStorage.setItem('enterprise-fixture-denied', '1');
    return new Response(null, { status: 204 });
  } else if (init?.method === 'POST' && (suffix === 'deactivate' || suffix === 'revoke-sessions' || suffix === 'demote')) {
    const subject = decodeURIComponent(url.split('/').slice(-2)[0]!);
    const member = members.find((item) => item.subject === subject);
    if (!member || !member.active || subject === 'alice' ||
        (suffix === 'demote' && member.role !== 'admin')) return new Response(null, { status: 403 });
    if (suffix === 'deactivate') member.active = false;
    if (suffix === 'demote') member.role = 'member';
    events.push({ organizationId, subject: 'alice', action: `organization.member.${suffix}`, outcome: 'allowed', at: new Date().toISOString() });
    return new Response(null, { status: 204 });
  } else return new Response(null, { status: 404 });
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
};

createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-8">
  <div className="rounded-xl border border-border bg-muted/20 p-4 text-sm">
    <strong>Local synthetic visual fixture · not an enabled SSO or deployed admin route.</strong>
    <button type="button" className="ml-4 rounded-md border border-border px-3 py-1" onClick={() => {
      denied = !denied;
      sessionStorage.setItem('enterprise-fixture-denied', denied ? '1' : '0');
      window.location.reload();
    }}>
      Toggle denial on reload
    </button>
  </div>
  <EnterpriseAdminDashboard organizationId={organizationId} domainSetupEnabled />
</main>);
