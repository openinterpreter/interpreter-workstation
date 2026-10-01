import { useEffect, useRef, useState } from 'react';
import { isWorkstationReadOnly } from '../../remote/workstationConnection';
import { simpleInterfaceClient, type SimpleProjectSnapshot } from './simpleInterfaceClient';
import { SIMPLE_RUNTIME_V1_STYLES } from '../../../shared/simpleRuntimeV1Styles';

type Props = { projectId: string; windowId: string; onMessage?: (message: string, source?: string) => Promise<void> | void };

/** Project JavaScript lives only in an opaque-origin sandbox, never in the app renderer. */
export function projectDocument(bundle: string): string {
  // Escaping the HTML script terminator matters even in a sandboxed frame.
  const safeBundle = bundle.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${SIMPLE_RUNTIME_V1_STYLES}</style></head><body><div id="root"></div><script>addEventListener('pointerdown', () => parent.postMessage({type:'interpreter-simple-interact'}, '*'), {capture:true});</script><script>${safeBundle}</script></body></html>`;
}

export function SimpleInterface({ onMessage, projectId, windowId }: Props) {
  const [snapshot, setSnapshot] = useState<SimpleProjectSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const active = useRef<SimpleProjectSnapshot | null>(null);
  active.current = snapshot;

  useEffect(() => {
    let alive = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await simpleInterfaceClient.projectRefresh(windowId, projectId);
        if (alive) {
          setSnapshot(previous => previous?.revision === next.revision && previous.projectPath === next.projectPath
            ? { ...previous, diagnostic: next.diagnostic } : next);
          setError(null);
        }
      } catch (failure) { if (alive) setError(failure instanceof Error ? failure.message : 'Could not load the interface project'); }
      finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [projectId, windowId]);

  useEffect(() => {
    const handleAction = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !active.current?.bundle || !onMessage || isWorkstationReadOnly()) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object') return;
      if ((data as Record<string, unknown>).type === 'interpreter-simple-interact') {
        window.dispatchEvent(new Event('simple-interface:interact'));
        return;
      }
      if ((data as Record<string, unknown>).type !== 'interpreter-simple-action') return;
      const message = (data as Record<string, unknown>).message;
      if (typeof message !== 'string' || !message.trim() || message.length > 6000) return;
      window.dispatchEvent(new Event('simple-interface:interact'));
      let id: string | undefined;
      try {
        const action = await simpleInterfaceClient.projectAction({ windowId, projectId, revision: active.current.revision, message });
        id = action.id;
        await onMessage(action.message, `project:${action.id}`);
        await simpleInterfaceClient.projectDelivery({ windowId, projectId, id, status: 'dispatched' });
        setError(null);
      } catch (failure) {
        if (id) void simpleInterfaceClient.projectDelivery({ windowId, projectId, id, status: 'failed' }).catch(() => {});
        setError(failure instanceof Error ? failure.message : 'Could not send interface action');
      }
    };
    window.addEventListener('message', handleAction);
    return () => window.removeEventListener('message', handleAction);
  }, [onMessage, projectId, windowId]);

  return <main aria-label="Interpreter interface" className="absolute inset-0 bg-background">
    {snapshot?.bundle ? <iframe key={`${snapshot.projectPath}:${snapshot.revision}`} ref={frame} title="Generated interface"
      sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={projectDocument(snapshot.bundle)}
      className="h-full w-full border-0" /> : <div className="px-8 pt-24" role="status">Opening your React interface…</div>}
    {snapshot?.diagnostic && <p role="status" className="absolute left-4 top-12 rounded-lg bg-background px-3 py-2 text-ui-sm shadow">Interface edit needs fixing; last working version remains visible. See .interpreter/diagnostics.json in your project.</p>}
    {error && <p role="alert" className="absolute left-4 top-12 rounded-lg bg-background px-3 py-2 text-ui-sm text-destructive shadow">{error}</p>}
  </main>;
}
