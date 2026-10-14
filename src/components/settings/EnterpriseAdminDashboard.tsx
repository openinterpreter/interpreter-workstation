import { useEffect, useState } from 'react';

type Overview = {
  organization: { id: string; name: string };
  users: { total: number; active: number; admins: number };
  audit: { eventCount: number; latestAt: string | null };
  identity: { issuer: string; status: string };
  controls: { policy: string; provisioning: string; modelRegistry: string };
};
type Member = { subject: string; displayName: string; role: 'admin' | 'member'; active: boolean };

/** Read-only browser UI; session remains in an HttpOnly cookie and is never a prop. Unmounted. */
export function EnterpriseAdminDashboard({ organizationId }: { organizationId: string }) {
  const [view, setView] = useState<{ overview: Overview; members: Member[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(null);
    setError(null);
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
  }, [organizationId]);

  return (
    <section className="space-y-5 rounded-2xl border border-border bg-background p-5 shadow-sm" aria-label="Organization dashboard">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Organization</p>
          <h2 className="mt-1 text-xl font-semibold text-foreground">{view?.overview.organization.name ?? 'Administration'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Identity, access and audit at a glance</p>
        </div>
        <span className="rounded-full border border-border bg-muted/30 px-3 py-1 text-xs text-muted-foreground">Read-only</span>
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
                <thead className="text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Person</th><th className="px-4 py-3 font-medium">Role</th><th className="px-4 py-3 font-medium">Status</th></tr></thead>
                <tbody>{view.members.map((member) => <tr key={member.subject} className="border-t border-border">
                  <td className="px-4 py-3 font-medium text-foreground">{member.displayName}</td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">{member.role}</td>
                  <td className="px-4 py-3 text-muted-foreground">{member.active ? 'Active' : 'Inactive'}</td>
                </tr>)}</tbody>
              </table></div>}
          </div>
          <p className="text-xs text-muted-foreground">Model registry: {view.overview.controls.modelRegistry}. Audit export and SCIM are not available in this build.</p>
        </>}
    </section>
  );
}
