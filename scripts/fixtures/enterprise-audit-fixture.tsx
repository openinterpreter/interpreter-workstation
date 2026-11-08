// Local visual acceptance only. No OIDC issuer, credential, or production route.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EnterpriseAdminDashboard } from '../../src/components/settings/EnterpriseAdminDashboard';
import '../../src/index.css';

const organizationId = 'synthetic-org';
const members = [
  { subject: 'alice', displayName: 'Alice Admin', role: 'admin', active: true },
  { subject: 'bob', displayName: 'Bob Member', role: 'member', active: true },
];
const events = [{ organizationId, subject: 'alice', action: 'organization.bootstrap', outcome: 'allowed', at: '2026-11-08T00:00:00Z' }];
let denied = sessionStorage.getItem('enterprise-fixture-denied') === '1';
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(`/api/enterprise/organizations/${organizationId}/`)) return originalFetch(input, init);
  if (denied) return new Response(null, { status: 403 });
  const suffix = url.split('/').slice(-1)[0];
  let data: unknown;
  if (suffix === 'export') {
    data = { organizationId, events: [...events] };
    events.push({ organizationId, subject: 'alice', action: 'organization.audit.export', outcome: 'allowed', at: new Date().toISOString() });
  } else if (suffix === 'activity') data = { organizationId, events: events.slice(-20) };
  else if (suffix === 'members') data = { organizationId, members };
  else if (suffix === 'overview') data = { organization: { id: organizationId, name: 'Northstar Studio' },
    users: { total: members.length, active: members.filter((m) => m.active).length, admins: 1 },
    audit: { eventCount: events.length, latestAt: events.at(-1)?.at ?? null },
    identity: { issuer: 'https://fixture.invalid/issuer', status: 'synthetic fixture session' },
    controls: { policy: 'not enforced', provisioning: 'not configured', modelRegistry: 'not configured' } };
  else if (init?.method === 'POST' && (suffix === 'deactivate' || suffix === 'revoke-sessions')) {
    const subject = decodeURIComponent(url.split('/').slice(-2)[0]!);
    const member = members.find((item) => item.subject === subject);
    if (!member || member.role !== 'member') return new Response(null, { status: 403 });
    if (suffix === 'deactivate') member.active = false;
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
  <EnterpriseAdminDashboard organizationId={organizationId} />
</main>);
