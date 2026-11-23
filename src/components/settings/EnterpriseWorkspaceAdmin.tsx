import { useEffect, useRef, useState } from 'react';
import { EnterpriseWorkspaceGrants } from './EnterpriseWorkspaceGrants';

type Workspace = { id: string; name: string; active: boolean };

/** Opt-in organization registry. Neither a local folder nor permission to
 * run agents/tools is inferred from an administrative workspace record. */
export function EnterpriseWorkspaceAdmin({ organizationId, members = [], onConfirmed, onUnavailable }:
  { organizationId: string; members?: { subject: string; displayName: string; active: boolean }[];
    onConfirmed?: (message?: string) => void; onUnavailable?: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [selectedAccess, setSelectedAccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const base = `/api/enterprise/organizations/${encodeURIComponent(organizationId)}/workspaces`;

  async function refresh(controller: AbortController) {
    const response = await fetch(base, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (response.status !== 200) throw new Error('Workspace registry unavailable');
    const data = await response.json();
    if (data?.organizationId !== organizationId || !Array.isArray(data.workspaces) || data.workspaces.length > 32 ||
        data.workspaces.some((workspace: Workspace) => typeof workspace.id !== 'string' ||
          typeof workspace.name !== 'string' || typeof workspace.active !== 'boolean')) throw new Error('Tenant mismatch');
    if (!controller.signal.aborted) setWorkspaces(data.workspaces);
  }

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setWorkspaces(null); setId(''); setName(''); setConfirmId(null); setSelectedAccess(null); setError(null); setNotice(null);
    void refresh(controller).catch(() => {
      if (!controller.signal.aborted) {
        setError('Workspace administration is unavailable. No access is shown.');
        onUnavailable?.();
      }
    });
    return () => { controller.abort(); request.current?.abort(); };
  }, [organizationId]);

  async function mutate(action: 'create' | 'deactivate', workspaceId: string) {
    if (!workspaces || busy || !organizationId || (action === 'deactivate' && confirmId !== workspaceId)) return;
    const controller = new AbortController();
    request.current?.abort(); request.current = controller;
    setBusy(true); setError(null); setNotice(null); setConfirmId(null);
    if (action === 'deactivate') setSelectedAccess(null);
    try {
      const response = await fetch(action === 'create' ? base : `${base}/${encodeURIComponent(workspaceId)}/deactivate`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Interpreter-CSRF': '1' },
        body: JSON.stringify(action === 'create' ? { id: workspaceId, name: name.trim() } : {}),
      });
      if (response.status !== 204) throw new Error('Workspace change denied');
      setWorkspaces(null); // Never present an optimistic admin mutation as authority.
      await refresh(controller);
      if (!controller.signal.aborted) {
        if (action === 'create') { setId(''); setName(''); }
        setNotice(action === 'create' ? 'Workspace registered.' : 'Workspace deactivated. Execution access was never granted by this registry.');
        onConfirmed?.(); // Parent overview and audit count must be refetched.
      }
    } catch {
      if (!controller.signal.aborted) {
        setWorkspaces(null); setNotice(null);
        setError('The workspace change could not be confirmed. Inventory is hidden.');
        onUnavailable?.();
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <section className="rounded-xl border border-border bg-muted/10 p-4" aria-label="Workspace administration">
    <h3 className="text-sm font-semibold text-foreground">Workspaces</h3>
    <p className="mt-1 text-xs text-muted-foreground">A workspace record alone grants no execution. Explicit access is separate and requires a governed runtime.</p>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {!error && !workspaces && <p role="status" className="mt-3 text-sm text-muted-foreground">Loading workspace inventory…</p>}
    {notice && <p role="status" className="mt-3 text-sm text-foreground">{notice}</p>}
    {workspaces && <>
      {workspaces.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No workspaces registered.</p> :
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-background">
          {workspaces.map((workspace) => <li key={workspace.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <div><p className="font-medium text-foreground">{workspace.name}</p><p className="text-xs text-muted-foreground">{workspace.id} · {workspace.active ? 'Active registry entry' : 'Inactive'}</p></div>
            {workspace.active && <span className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy} onClick={() => setSelectedAccess(selectedAccess === workspace.id ? null : workspace.id)}
                className="rounded-md border border-border px-2 py-1 disabled:opacity-50">{selectedAccess === workspace.id ? 'Close access' : 'Manage access'}</button>
              {confirmId === workspace.id ? <span className="flex flex-wrap items-center gap-2">
              <span>Deactivate {workspace.name}?</span>
              <button type="button" disabled={busy} onClick={() => void mutate('deactivate', workspace.id)} className="rounded-md border border-destructive/50 px-2 py-1 text-destructive disabled:opacity-50">Confirm deactivation</button>
              <button type="button" disabled={busy} onClick={() => setConfirmId(null)} className="rounded-md border border-border px-2 py-1 disabled:opacity-50">Cancel</button>
              </span> : <button type="button" disabled={busy} onClick={() => setConfirmId(workspace.id)} className="rounded-md border border-border px-2 py-1 disabled:opacity-50">Deactivate</button>}
            </span>}
          </li>)}
        </ul>}
      {selectedAccess && workspaces.some((workspace) => workspace.id === selectedAccess && workspace.active) &&
        <EnterpriseWorkspaceGrants key={selectedAccess} organizationId={organizationId} workspaceId={selectedAccess}
          members={members} onConfirmed={() => onConfirmed?.('Workspace access updated. Organization activity refreshed.')} onUnavailable={() => {
            setWorkspaces(null); setSelectedAccess(null); setError('Workspace access is unavailable. Inventory is hidden.'); onUnavailable?.();
          }} />}
      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <input aria-label="Workspace identifier" placeholder="workspace-id" value={id} disabled={busy}
          onChange={(event) => setId(event.target.value)} className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm" />
        <input aria-label="Workspace name" placeholder="Workspace name" value={name} disabled={busy}
          onChange={(event) => setName(event.target.value)} className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm" />
        <button type="button" disabled={busy || !/^[A-Za-z0-9._@:-]{1,160}$/.test(id) || !name.trim() || name.trim().length > 128}
          onClick={() => void mutate('create', id)} className="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50">Register workspace</button>
      </div>
    </>}
  </section>;
}
