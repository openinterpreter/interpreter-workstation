import { useEffect, useState } from 'react';

type Overview = {
  organization: { id: string; name: string };
  users: { total: number; active: number; admins: number };
  audit: { eventCount: number; latestAt: string | null };
  identity: { issuer: string; status: string };
  controls: { policy: string; provisioning: string; modelRegistry: string };
};
type Member = { subject: string; displayName: string; role: 'admin' | 'member'; active: boolean };

/** Same-origin browser admin UI; the HttpOnly session is never a prop. Unmounted. */
export function EnterpriseAdminDashboard({ organizationId }: { organizationId: string }) {
  const [view, setView] = useState<{ overview: Overview; members: Member[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSubject, setPendingSubject] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setView(null);
    setError(null);
    setPendingSubject(null);
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
    return () => controller.abort();
  }, [organizationId, revision]);

  async function deactivate(subject: string) {
    if (!view || busy || pendingSubject !== subject ||
        !view.members.some((member) => member.subject === subject && member.active && member.role === 'member')) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/enterprise/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(subject)}/deactivate`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Interpreter-CSRF': '1' }, body: '{}',
      });
      if (response.status !== 204) throw new Error('Access denied');
      setRevision((value) => value + 1); // Refetch authoritative tenant and session state.
    } catch {
      setView(null); // Do not retain a stale directory after revocation or outage.
      setError('The change was not confirmed. Organization data is unavailable.');
    } finally {
      setPendingSubject(null);
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5 rounded-2xl border border-border bg-background p-5 shadow-sm" aria-label="Organization dashboard">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Organization</p>
          <h2 className="mt-1 text-xl font-semibold text-foreground">{view?.overview.organization.name ?? 'Administration'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Identity, access and audit at a glance</p>
        </div>
        <span className="rounded-full border border-border bg-muted/30 px-3 py-1 text-xs text-muted-foreground">{view ? 'Session verified' : 'Verified organization session required'}</span>
      </header>
      {error ? <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-foreground">{error}</div> :
        !view ? <p role="status" className="text-sm text-muted-foreground">Checking organization access…</p> : <>
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
                <thead className="text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Person</th><th className="px-4 py-3 font-medium">Role</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Access</th></tr></thead>
                <tbody>{view.members.map((member) => <tr key={member.subject} className="border-t border-border">
                  <td className="px-4 py-3 font-medium text-foreground">{member.displayName}</td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">{member.role}</td>
                  <td className="px-4 py-3 text-muted-foreground">{member.active ? 'Active' : 'Inactive'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{member.active && member.role === 'member' ?
                    pendingSubject === member.subject ? <span className="inline-flex flex-wrap items-center gap-2">
                      <span>Remove {member.displayName}'s access?</span>
                      <button type="button" disabled={busy} className="rounded-md border border-destructive/50 px-2 py-1 text-destructive disabled:opacity-50"
                        onClick={() => void deactivate(member.subject)}>Confirm deactivation</button>
                      <button type="button" disabled={busy} className="rounded-md border border-border px-2 py-1 disabled:opacity-50"
                        onClick={() => setPendingSubject(null)}>Cancel</button>
                    </span> : <button type="button" disabled={busy} className="rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
                      onClick={() => setPendingSubject(member.subject)}>Deactivate</button> : '—'}</td>
                </tr>)}</tbody>
              </table></div>}
          </div>
          <p className="text-xs text-muted-foreground">Model registry: {view.overview.controls.modelRegistry}. Audit export and SCIM are not available in this build.</p>
        </>}
    </section>
  );
}
