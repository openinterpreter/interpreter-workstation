import { useEffect, useRef, useState } from 'react';

type Overview = {
  organization: { id: string; name: string };
  users: { total: number; active: number; admins: number };
  audit: { eventCount: number; latestAt: string | null };
  identity: { issuer: string; status: string };
  controls: { policy: string; provisioning: string; modelRegistry: string };
};
type Member = { subject: string; displayName: string; role: 'admin' | 'member'; active: boolean };
type Activity = { organizationId: string; subject: string; targetSubject?: string; targetOrganizationId?: string;
  action: string; outcome: 'allowed' | 'denied'; at: string };

/** Same-origin browser admin UI; the HttpOnly session is never a prop. Unmounted. */
export function EnterpriseAdminDashboard({ organizationId }: { organizationId: string }) {
  const [view, setView] = useState<{ overview: Overview; members: Member[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ subject: string; kind: 'deactivate' | 'revoke-sessions' } | null>(null);
  const [pendingOrganizationKill, setPendingOrganizationKill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [exporting, setExporting] = useState(false);
  const activityRequest = useRef<AbortController | null>(null);
  const exportRequest = useRef<AbortController | null>(null);

  useEffect(() => setNotice(null), [organizationId]);

  useEffect(() => {
    setView(null);
    setActivity(null);
    setLoadingActivity(false);
    setExporting(false);
    setError(null);
    setPendingAction(null);
    setPendingOrganizationKill(false);
    if (!organizationId) {
      setError('A verified organization session is required.');
      return;
    }
    const controller = new AbortController();
    const get = async (suffix: string) => {
      const response = await fetch(`/api/enterprise/organizations/${encodeURIComponent(organizationId)}/${suffix}`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Unavailable');
      return response.json();
    };
    Promise.all([get('overview'), get('members')])
      .then(([overview, directory]) => {
        if (controller.signal.aborted) return;
        if (overview?.organization?.id !== organizationId || directory?.organizationId !== organizationId || !Array.isArray(directory.members)) {
          throw new Error('Tenant mismatch');
        }
        setView({ overview, members: directory.members });
      })
      .catch(() => { if (!controller.signal.aborted) setError('Organization data is unavailable. Access was not granted.'); });
    return () => { controller.abort(); activityRequest.current?.abort(); exportRequest.current?.abort(); };
  }, [organizationId, revision]);

  async function exportAudit() {
    if (!view || busy || exporting) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExporting(true);
    setError(null);
    try {
      const response = await fetch(`/api/enterprise/organizations/${encodeURIComponent(organizationId)}/activity/export`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 9_000_000) throw new Error('Unavailable');
      const body = await response.text();
      if (body.length > 9_000_000) throw new Error('Export too large');
      const payload = JSON.parse(body);
      if (payload?.organizationId !== organizationId || !Array.isArray(payload.events) ||
          payload.events.some((event: Activity) => event.organizationId !== organizationId ||
            typeof event.subject !== 'string' || typeof event.action !== 'string' ||
            !['allowed', 'denied'].includes(event.outcome) || typeof event.at !== 'string')) throw new Error('Invalid export');
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = 'organization-audit.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
      setNotice('Organization audit export prepared. Keep this sensitive file in an approved location.');
      setRevision((value) => value + 1); // Refresh the export audit event and current session authority.
    } catch {
      if (!controller.signal.aborted) {
        setView(null);
        setActivity(null);
        setNotice(null);
        setError('Audit export could not be verified. Organization data is hidden.');
      }
    } finally {
      if (!controller.signal.aborted) setExporting(false);
    }
  }

  async function loadActivity() {
    if (!view || busy || exporting || loadingActivity) return;
    const controller = new AbortController();
    activityRequest.current?.abort();
    activityRequest.current = controller;
    setLoadingActivity(true);
    try {
      const response = await fetch(`/api/enterprise/organizations/${encodeURIComponent(organizationId)}/activity`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Unavailable');
      const payload = await response.json();
      if (payload?.organizationId !== organizationId || !Array.isArray(payload.events) || payload.events.length > 20 ||
          payload.events.some((event: Activity) => event.organizationId !== organizationId ||
            typeof event.action !== 'string' || typeof event.subject !== 'string' ||
            !['allowed', 'denied'].includes(event.outcome) || typeof event.at !== 'string')) throw new Error('Invalid activity');
      if (!controller.signal.aborted) setActivity(payload.events);
    } catch {
      if (!controller.signal.aborted) {
        setActivity(null);
        setView(null); // A denied or unavailable audit cannot leave a stale tenant directory visible.
        setError('Organization activity is unavailable. Access was not granted.');
      }
    } finally {
      if (!controller.signal.aborted) setLoadingActivity(false);
    }
  }

  async function changeAccess(subject: string, kind: 'deactivate' | 'revoke-sessions') {
    if (!view || busy || exporting || pendingAction?.subject !== subject || pendingAction.kind !== kind ||
        !view.members.some((member) => member.subject === subject && member.active && member.role === 'member')) return;
    setBusy(true);
    activityRequest.current?.abort();
    setActivity(null);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/enterprise/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(subject)}/${kind}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Interpreter-CSRF': '1' }, body: '{}',
      });
      if (response.status !== 204) throw new Error('Access denied');
      setNotice(kind === 'deactivate' ? 'Member access deactivated.' : 'Sessions ended. This member can sign in again until access is deactivated.');
      setRevision((value) => value + 1); // Refetch authoritative tenant and session state.
    } catch {
      setView(null); // Do not retain a stale directory after revocation or outage.
      setNotice(null);
      setError('The change was not confirmed. Organization data is unavailable.');
    } finally {
      setPendingAction(null);
      setBusy(false);
    }
  }

  async function signOut() {
    if (!view || busy || exporting) return;
    setBusy(true);
    activityRequest.current?.abort();
    setActivity(null);
    setPendingAction(null);
    setView(null); // Hide sensitive directory data while revocation is pending.
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/enterprise/organizations/${encodeURIComponent(organizationId)}/session/logout`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Interpreter-CSRF': '1' }, body: '{}',
      });
      if (response.status !== 204) throw new Error('Revocation not confirmed');
      setError('Signed out of this organization session.');
    } catch {
      setError('Sign-out could not be confirmed. Organization data is hidden; try again or contact your administrator.');
    } finally {
      setBusy(false);
    }
  }

  async function endOrganizationSessions() {
    if (!view || !pendingOrganizationKill || busy || exporting) return;
    setBusy(true);
    activityRequest.current?.abort();
    setActivity(null);
    setPendingAction(null);
    setPendingOrganizationKill(false);
    setView(null); // The initiating admin session will also be revoked; do not refetch with it.
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/enterprise/organizations/${encodeURIComponent(organizationId)}/sessions/revoke-all`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Interpreter-CSRF': '1' }, body: '{}',
      });
      if (response.status !== 204) throw new Error('Revocation not confirmed');
      setNotice('All current organization sessions ended, including yours. Members can sign in again until access is deactivated.');
    } catch {
      setError('Organization-wide session revocation could not be confirmed. Organization data is hidden; contact your administrator.');
    } finally { setBusy(false); }
  }

  return (
    <section className="space-y-5 rounded-2xl border border-border bg-background p-5 shadow-sm" aria-label="Organization dashboard">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Organization</p>
          <h2 className="mt-1 text-xl font-semibold text-foreground">{view?.overview.organization.name ?? 'Administration'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Identity, access and audit at a glance</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-border bg-muted/30 px-3 py-1 text-xs text-muted-foreground">{view ? 'Session verified' : 'Verified organization session required'}</span>
          {view && <button type="button" disabled={busy || exporting} onClick={() => void signOut()}
            className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50">Sign out</button>}
        </div>
      </header>
      {notice && <p role="status" className="rounded-xl border border-border bg-muted/30 p-3 text-sm text-foreground">{notice}</p>}
      {error ? <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-foreground">{error}</div> :
        !view ? notice ? null : <p role="status" className="text-sm text-muted-foreground">Checking organization access…</p> : <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['People', view.overview.users.total], ['Active', view.overview.users.active],
              ['Admins', view.overview.users.admins], ['Audit events', view.overview.audit.eventCount],
            ].map(([label, value]) => <div key={label} className="rounded-xl border border-border bg-muted/20 p-4">
              <p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
            </div>)}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['Identity', view.overview.identity.status], ['Policy', view.overview.controls.policy],
              ['Provisioning', view.overview.controls.provisioning],
            ].map(([label, value]) => <div key={label} className="rounded-xl border border-border p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="mt-2 text-sm font-medium text-foreground">{value}</p>
            </div>)}
          </div>
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="border-b border-border bg-muted/20 px-4 py-3"><h3 className="text-sm font-semibold">Directory</h3></div>
            {view.members.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No members in this organization.</p> :
              <div className="overflow-x-auto"><table className="w-full text-left text-sm">
                <thead className="hidden text-xs text-muted-foreground sm:table-header-group"><tr><th className="px-4 py-3 font-medium">Person</th><th className="px-4 py-3 font-medium">Role</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Access</th></tr></thead>
                <tbody>{view.members.map((member) => <tr key={member.subject} className="grid gap-1 border-t border-border p-4 sm:table-row sm:p-0">
                  <td className="block py-1 font-medium text-foreground sm:table-cell sm:px-4 sm:py-3">{member.displayName}</td>
                  <td className="block py-1 capitalize text-muted-foreground sm:table-cell sm:px-4 sm:py-3"><span className="mr-2 text-xs font-semibold uppercase sm:hidden">Role</span>{member.role}</td>
                  <td className="block py-1 text-muted-foreground sm:table-cell sm:px-4 sm:py-3"><span className="mr-2 text-xs font-semibold uppercase sm:hidden">Status</span>{member.active ? 'Active' : 'Inactive'}</td>
                  <td className="block py-1 text-muted-foreground sm:table-cell sm:px-4 sm:py-3">{member.active && member.role === 'member' ?
                    pendingAction?.subject === member.subject ? <span className="flex flex-wrap items-center gap-2">
                      <span>{pendingAction.kind === 'deactivate' ? `Remove ${member.displayName}'s access?` : `End ${member.displayName}'s current sessions? They can sign in again.`}</span>
                      <button type="button" disabled={busy || exporting} className="rounded-md border border-destructive/50 px-2 py-1 text-destructive disabled:opacity-50"
                        onClick={() => void changeAccess(member.subject, pendingAction.kind)}>{pendingAction.kind === 'deactivate' ? 'Confirm deactivation' : 'Confirm end sessions'}</button>
                      <button type="button" disabled={busy || exporting} className="rounded-md border border-border px-2 py-1 disabled:opacity-50"
                        onClick={() => setPendingAction(null)}>Cancel</button>
                    </span> : <span className="inline-flex flex-wrap gap-2">
                      <button type="button" disabled={busy || exporting} className="rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
                        onClick={() => setPendingAction({ subject: member.subject, kind: 'revoke-sessions' })}>End sessions</button>
                      <button type="button" disabled={busy || exporting} className="rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
                        onClick={() => setPendingAction({ subject: member.subject, kind: 'deactivate' })}>Deactivate</button>
                    </span> : '—'}</td>
                </tr>)}</tbody>
              </table></div>}
          </div>
          <section className="rounded-xl border border-destructive/30 bg-destructive/5 p-4" aria-label="Organization session controls">
            <h3 className="text-sm font-semibold text-foreground">Organization sessions</h3>
            <p className="mt-1 text-xs text-muted-foreground">End all current sessions for this organization, including yours. This does not deactivate members or prevent a new sign-in.</p>
            {pendingOrganizationKill ? <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm text-foreground">End every current organization session?</span>
              <button type="button" disabled={busy || exporting} onClick={() => void endOrganizationSessions()}
                className="rounded-md border border-destructive/50 px-3 py-2 text-xs font-medium text-destructive disabled:opacity-50">Confirm end all sessions</button>
              <button type="button" disabled={busy || exporting} onClick={() => setPendingOrganizationKill(false)}
                className="rounded-md border border-border px-3 py-2 text-xs font-medium disabled:opacity-50">Cancel organization action</button>
            </div> : <button type="button" disabled={busy || exporting} onClick={() => { setPendingAction(null); setPendingOrganizationKill(true); }}
              className="mt-3 rounded-md border border-destructive/50 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">End all organization sessions</button>}
          </section>
          <section className="rounded-xl border border-border p-4" aria-label="Recent organization activity">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h3 className="text-sm font-semibold text-foreground">Recent activity</h3>
                <p className="mt-1 text-xs text-muted-foreground">Up to 20 tenant-scoped events. Full export is a sensitive JSON file.</p></div>
              <button type="button" disabled={busy || exporting || loadingActivity} onClick={() => void loadActivity()}
                className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50">
                {loadingActivity ? 'Loading activity…' : activity ? 'Refresh activity' : 'View recent activity'}
              </button>
            </div>
            {activity && (activity.length ? <ol className="mt-4 divide-y divide-border text-sm">
              {activity.map((event, index) => <li key={`${event.at}-${index}`} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-foreground">{event.subject} · {event.action}{event.targetSubject ? ` · ${event.targetSubject}` : ''}
                  {event.targetOrganizationId ? ` · attempted ${event.targetOrganizationId}` : ''}</span>
                <span className="text-muted-foreground">{event.outcome} · {event.at}</span>
              </li>)}
            </ol> : <p className="mt-3 text-sm text-muted-foreground">No activity yet.</p>)}
          </section>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 p-4">
            <div><h3 className="text-sm font-semibold text-foreground">Full audit export</h3>
              <p className="mt-1 text-xs text-muted-foreground">Includes member identifiers. Store the JSON file only in an approved location; retention is not configured.</p></div>
            <button type="button" disabled={busy || exporting} onClick={() => void exportAudit()}
              className="rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50">
              {exporting ? 'Preparing export…' : 'Export audit JSON'}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">Model registry: {view.overview.controls.modelRegistry}. SCIM is not available in this build.</p>
        </>}
    </section>
  );
}
