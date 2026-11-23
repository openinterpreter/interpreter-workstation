import { useEffect, useRef, useState } from 'react';

type Action = 'agent.execute' | 'tool.invoke' | 'simple.execute';
type Grant = { subject: string; actions: Action[] };
type Member = { subject: string; displayName: string; active: boolean };
const actions: { id: Action; label: string }[] = [
  { id: 'agent.execute', label: 'Run agents' },
  { id: 'tool.invoke', label: 'Invoke tools' },
  { id: 'simple.execute', label: 'Run Simple workflows' },
];

/** An explicit, administrator-reviewed directory grant. The product does not
 * mount this UI or execution policy until its identity and runtime are proven. */
export function EnterpriseWorkspaceGrants({ organizationId, workspaceId, members, onConfirmed, onUnavailable }:
  { organizationId: string; workspaceId: string; members: Member[]; onConfirmed?: () => void; onUnavailable?: () => void }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [subject, setSubject] = useState('');
  const [action, setAction] = useState<Action>('agent.execute');
  const [pending, setPending] = useState<{ subject: string; action: Action; granted: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const url = `/api/enterprise/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/grants`;

  async function refresh(controller: AbortController) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (response.status !== 200) throw new Error('Unavailable');
    const payload = await response.json();
    if (payload?.organizationId !== organizationId || payload.workspaceId !== workspaceId ||
        !Array.isArray(payload.grants) || payload.grants.length > 128 ||
        payload.grants.some((grant: Grant) => typeof grant.subject !== 'string' ||
          !members.some((member) => member.subject === grant.subject) || !Array.isArray(grant.actions) ||
          grant.actions.length > 3 || new Set(grant.actions).size !== grant.actions.length ||
          grant.actions.some((value) => !actions.some(({ id }) => id === value))) ||
        new Set(payload.grants.map((grant: Grant) => grant.subject)).size !== payload.grants.length) {
      throw new Error('Tenant mismatch');
    }
    if (!controller.signal.aborted) setGrants(payload.grants);
  }

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setGrants(null); setPending(null); setSubject(''); setError(null); setNotice(null);
    void refresh(controller).catch(() => {
      if (!controller.signal.aborted) { setGrants(null); setError('Workspace grants are unavailable. Access is hidden.'); onUnavailable?.(); }
    });
    return () => { controller.abort(); request.current?.abort(); };
  }, [organizationId, workspaceId]);

  async function confirm() {
    if (!pending || !grants || !selected || busy) return;
    const change = pending;
    const controller = new AbortController();
    request.current?.abort(); request.current = controller;
    setBusy(true); setPending(null); setError(null); setNotice(null);
    try {
      const response = await fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Interpreter-CSRF': '1' },
        body: JSON.stringify(change) });
      if (response.status !== 204) throw new Error('Denied');
      setGrants(null); // A 204 alone is not authoritative access state.
      await refresh(controller);
      if (!controller.signal.aborted) {
        setNotice(change.granted ? 'Grant confirmed and directory refreshed.' : 'Grant revoked and directory refreshed.');
        onConfirmed?.();
      }
    } catch {
      if (!controller.signal.aborted) {
        setGrants(null); setError('Grant change could not be confirmed. Access is hidden.'); onUnavailable?.();
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  const active = members.filter((member) => member.active);
  const selected = active.find((member) => member.subject === subject);
  const hasGrant = Boolean(grants?.some((grant) => grant.subject === subject && grant.actions.includes(action)));
  return <section className="mt-3 rounded-lg border border-border bg-background p-3" aria-label={`Access for ${workspaceId}`}>
    <h4 className="text-sm font-semibold text-foreground">Workspace access · {workspaceId}</h4>
    <p className="mt-1 text-xs text-muted-foreground">Explicit directory grants only. Agent, tool and Simple execution require a separately enforced runtime; this inventory is not an execution lease.</p>
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    {!error && !grants && <p role="status" className="mt-2 text-sm text-muted-foreground">Loading access…</p>}
    {notice && <p role="status" className="mt-2 text-sm text-foreground">{notice}</p>}
    {grants && <>
      {grants.length ? <ul className="mt-3 grid gap-2 text-xs text-foreground">
        {grants.map((grant) => <li key={grant.subject} className="min-w-0 rounded-md border border-border p-2 break-words">
          {members.find((member) => member.subject === grant.subject)?.displayName ?? grant.subject} · {grant.actions.map((value) => actions.find(({ id }) => id === value)?.label).join(', ')}
        </li>)}
      </ul> : <p className="mt-3 text-xs text-muted-foreground">No execution grants for this workspace.</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <select aria-label="Grant member" value={subject} disabled={busy} onChange={(event) => { setSubject(event.target.value); setPending(null); }}
          className="min-w-0 rounded-md border border-border bg-background px-2 py-2 text-sm">
          <option value="">Select an active person</option>
          {active.map((member) => <option key={member.subject} value={member.subject}>{member.displayName} · {member.subject}</option>)}
        </select>
        <select aria-label="Grant capability" value={action} disabled={busy} onChange={(event) => { setAction(event.target.value as Action); setPending(null); }}
          className="min-w-0 rounded-md border border-border bg-background px-2 py-2 text-sm">
          {actions.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
        <button type="button" disabled={busy || !selected} onClick={() => setPending({ subject, action, granted: !hasGrant })}
          className="rounded-md border border-border px-3 py-2 text-xs font-medium disabled:opacity-50">{hasGrant ? 'Revoke access' : 'Review grant'}</button>
      </div>
      {pending && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-xs">
        <span>{pending.granted ? 'Grant' : 'Revoke'} {actions.find(({ id }) => id === pending.action)?.label} for {selected?.displayName}?</span>
        <button type="button" disabled={busy} onClick={() => void confirm()} className="rounded-md border border-border px-2 py-1 font-medium disabled:opacity-50">Confirm {pending.granted ? 'grant' : 'revocation'}</button>
        <button type="button" disabled={busy} onClick={() => setPending(null)} className="rounded-md border border-border px-2 py-1 disabled:opacity-50">Cancel</button>
      </div>}
    </>}
  </section>;
}
