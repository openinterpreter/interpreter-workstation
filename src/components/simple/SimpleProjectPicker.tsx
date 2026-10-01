import { useEffect, useState } from 'react';
import { openFolderDialog } from '@/ipc';
import { simpleInterfaceClient, type SimpleProject } from './simpleInterfaceClient';
import { remoteSimpleClient, type RemoteConnection } from './remoteSimpleClient';

/** A project folder is owned by the user; only its opaque ID crosses the remote protocol. */
export function SimpleProjectPicker({ windowId, onOpen, onOpenRemote }: { windowId: string; onOpen: (project: SimpleProject) => void;
  onOpenRemote?: (connection: RemoteConnection) => void }) {
  const [projects, setProjects] = useState<SimpleProject[]>([]);
  const [remote, setRemote] = useState<RemoteConnection[]>([]);
  const [name, setName] = useState('Untitled Interface');
  const [parent, setParent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void simpleInterfaceClient.projects(windowId).then(result => {
      if (alive) { setProjects(result.projects); if (result.active) onOpen(result.active); }
    }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : 'Projects unavailable'); });
    return () => { alive = false; };
  }, [windowId, onOpen]);
  useEffect(() => { let alive = true; void remoteSimpleClient.list().then(items => { if (alive) setRemote(items); })
    .catch(() => {}); return () => { alive = false; }; }, []);

  async function chooseParent() {
    const result = await openFolderDialog();
    if (!result.canceled && result.filePaths[0]) setParent(result.filePaths[0]);
  }

  async function create() {
    if (!parent || !name.trim() || busy) return;
    setBusy(true); setError(null);
    try { onOpen(await simpleInterfaceClient.createProject(windowId, parent, name.trim())); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create interface'); }
    finally { setBusy(false); }
  }

  async function open(folder?: string) {
    if (busy) return;
    let location = folder;
    if (!location) {
      const result = await openFolderDialog();
      if (result.canceled) return;
      location = result.filePaths[0];
    }
    if (!location) return;
    setBusy(true); setError(null);
    try { onOpen(await simpleInterfaceClient.openProject(windowId, location)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open interface'); }
    finally { setBusy(false); }
  }

  return <main aria-label="Interface projects" className="flex h-full items-center justify-center bg-background p-8 text-foreground">
    <div className="w-full max-w-lg space-y-5 rounded-2xl border border-border bg-background/95 p-6 shadow-lg">
      <header><h1 className="text-xl font-medium">Your interfaces</h1><p className="text-ui-sm text-muted-foreground">Each interface is its own React project folder.</p></header>
      <div className="space-y-2">{projects.map(project => <button key={project.id} type="button" disabled={busy}
        className="block w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-hover" onClick={() => void open(project.path)}>
        <span className="block">{project.name}</span><small className="block truncate text-muted-foreground">{project.path}</small>
      </button>)}</div>
      {remote.length > 0 && <div className="space-y-2 border-t border-border pt-4" aria-label="Paired remote projects">
        {remote.map(connection => <button key={connection.id} type="button" onClick={() => onOpenRemote?.(connection)}
          className="block w-full rounded-lg border border-sky-700/40 px-3 py-2 text-left hover:bg-hover">
          Remote project {connection.projectId.slice(0, 8)} · Private connection
        </button>)}
      </div>}
      <section className="space-y-2 border-t border-border pt-4" aria-label="New Interface">
        <label className="block text-ui-sm">Project name<input aria-label="Project name" value={name} onChange={event => setName(event.target.value)}
          className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label>
        <button type="button" onClick={() => void chooseParent()} disabled={busy} className="rounded-md border border-border px-3 py-2 text-ui-sm">{parent || 'Choose parent folder'}</button>
        <button type="button" onClick={() => void create()} disabled={busy || !parent || !name.trim()} className="ml-2 rounded-md border border-border px-3 py-2 text-ui-sm">New Interface</button>
      </section>
      <button type="button" onClick={() => void open()} disabled={busy} className="rounded-md border border-border px-3 py-2 text-ui-sm">Open Interface…</button>
      {error && <p role="alert" className="text-ui-sm text-destructive">{error}</p>}
    </div>
  </main>;
}
