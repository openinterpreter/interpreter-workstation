import { useCallback, useEffect, useRef, useState } from 'react';
import { isWorkstationReadOnly } from '../../remote/workstationConnection';
import type { SimpleBlock, SimpleInterfaceSnapshot } from '../../../shared/simpleInterface';
import { simpleInterfaceClient } from './simpleInterfaceClient';

type Props = {
  /** The shell sends an accepted, disk-recorded action to its one primary conversation. */
  onMessage?: (message: string, source?: string) => Promise<void> | void;
};

function interpolate(value: string, data: Record<string, string>): string {
  return value.replace(/\{\{data\.([a-zA-Z][a-zA-Z0-9_-]{0,63})\}\}/g, (_match, key: string) => data[key] ?? '');
}

function ImageBlock({ asset, alt, caption }: { asset: string; alt: string; caption?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    simpleInterfaceClient.assetUrl(asset).then(next => { if (active) setUrl(next); }).catch(() => { if (active) setUrl(null); });
    return () => { active = false; };
  }, [asset]);
  if (!url) return null;
  return <figure style={{ margin: 0 }}><img src={url} alt={alt} loading="lazy" style={{ display: 'block', width: '100%', maxHeight: 520, objectFit: 'contain', borderRadius: 14 }} />{caption && <figcaption style={{ marginTop: 8, fontSize: 13, opacity: .6 }}>{caption}</figcaption>}</figure>;
}

export function SimpleInterface({ onMessage }: Props) {
  const [snapshot, setSnapshot] = useState<SimpleInterfaceSnapshot | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const inputTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingValues = useRef<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await simpleInterfaceClient.refresh();
        if (!active) return;
        setSnapshot(next);
        setInputs(previous => ({ ...next.inputs, ...previous, ...pendingValues.current }));
        setError(null);
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'Unable to load interface');
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
      for (const timeout of inputTimers.current.values()) clearTimeout(timeout);
      inputTimers.current.clear();
    };
  }, []);

  const saveInput = useCallback((id: string, value: string) => {
    if (!snapshot) return;
    pendingValues.current[id] = value;
    setInputs(previous => ({ ...previous, [id]: value }));
    const previous = inputTimers.current.get(id);
    if (previous) clearTimeout(previous);
    const revision = snapshot.revision;
    inputTimers.current.set(id, setTimeout(() => {
      void simpleInterfaceClient.input({ id, revision, value }).then(() => {
        if (pendingValues.current[id] === value) delete pendingValues.current[id];
      }).catch(failure => setError(failure instanceof Error ? failure.message : 'Unable to save input'));
      inputTimers.current.delete(id);
    }, 250));
  }, [snapshot]);

  const submitAction = useCallback(async (block: Extract<SimpleBlock, { type: 'button' | 'input' }>) => {
    if (!snapshot || !onMessage || working || isWorkstationReadOnly()) return;
    setWorking(block.id);
    setError(null);
    let eventId: string | null = null;
    try {
      const value = block.type === 'input' ? inputs[block.id] ?? '' : undefined;
      if (block.type === 'input') await simpleInterfaceClient.input({ id: block.id, revision: snapshot.revision, value: value ?? '' });
      const event = await simpleInterfaceClient.action({ actionId: block.id, revision: snapshot.revision, value });
      eventId = event.id;
      await onMessage(event.message, `interface:${block.id}`);
      await simpleInterfaceClient.delivery({ id: event.id, status: 'dispatched' });
    } catch (failure) {
      if (eventId) await simpleInterfaceClient.delivery({ id: eventId, status: 'failed', error: failure instanceof Error ? failure.message : 'Submission failed' }).catch(() => {});
      setError(failure instanceof Error ? failure.message : 'Unable to submit action');
    } finally { setWorking(null); }
  }, [snapshot, onMessage, inputs, working]);

  const renderBlock = (block: SimpleBlock): React.ReactNode => {
    const data = snapshot?.data ?? {};
    switch (block.type) {
      case 'heading': {
        const style = { fontSize: block.level === 3 ? 21 : block.level === 2 ? 28 : 42, fontWeight: 600, lineHeight: 1.16, letterSpacing: '-.035em', margin: 0 };
        const label = interpolate(block.text, data);
        return block.level === 3 ? <h3 key={block.id} style={style}>{label}</h3> : block.level === 2 ? <h2 key={block.id} style={style}>{label}</h2> : <h1 key={block.id} style={style}>{label}</h1>;
      }
      case 'paragraph': return <p key={block.id} style={{ margin: 0, fontSize: 16, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{interpolate(block.text, data)}</p>;
      case 'row': return <div key={block.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 12 }}>{block.children.map(renderBlock)}</div>;
      case 'card': return <section key={block.id} style={{ flex: '1 1 200px', minWidth: 180, padding: 22, display: 'grid', alignContent: 'start', gap: 15, background: 'var(--card, white)', border: 'var(--border-width, 1px) solid var(--border, #ddd)', borderRadius: 18 }}>{block.children.map(renderBlock)}</section>;
      case 'image': return <ImageBlock key={block.id} asset={block.asset} alt={interpolate(block.alt, data)} caption={block.caption && interpolate(block.caption, data)} />;
      case 'divider': return <hr key={block.id} style={{ border: 0, borderTop: 'var(--border-width, 1px) solid var(--border, #ddd)', margin: '8px 0' }} />;
      case 'button': return <button key={block.id} type="button" disabled={!onMessage || !!working || isWorkstationReadOnly()} onClick={() => void submitAction(block)} style={{ cursor: 'pointer', borderRadius: 999, padding: '11px 18px', background: 'var(--card, white)', color: 'var(--foreground, #111)', border: 'var(--border-width, 1px) solid var(--border, #ddd)', font: 'inherit', fontSize: 14, opacity: working && working !== block.id ? .5 : 1 }}>{working === block.id ? 'Sending…' : interpolate(block.label, data)}</button>;
      case 'input': return <form key={block.id} onSubmit={event => { event.preventDefault(); void submitAction(block); }} style={{ display: 'grid', gap: 9, width: 'min(100%, 560px)' }}>
        <label htmlFor={`simple-input-${block.id}`} style={{ fontSize: 14, fontWeight: 500 }}>{interpolate(block.label, data)}</label>
        <div style={{ display: 'flex', gap: 8 }}><input id={`simple-input-${block.id}`} value={inputs[block.id] ?? ''} maxLength={4000} disabled={isWorkstationReadOnly()} onChange={event => saveInput(block.id, event.target.value)} placeholder={block.placeholder && interpolate(block.placeholder, data)} style={{ flex: 1, minWidth: 0, padding: '10px 14px', borderRadius: 12, background: 'var(--card, white)', border: 'var(--border-width, 1px) solid var(--border, #ddd)', color: 'var(--foreground, #111)', font: 'inherit' }} />
          <button type="submit" disabled={!onMessage || !!working || isWorkstationReadOnly()} style={{ padding: '10px 16px', borderRadius: 12, background: 'var(--foreground, #111)', color: 'var(--background, white)', border: 0, cursor: 'pointer' }}>{working === block.id ? 'Sending…' : block.buttonLabel || 'Send'}</button></div>
      </form>;
    }
  };

  return <main aria-label="Interpreter interface" style={{ position: 'absolute', inset: 0, overflow: 'auto', background: 'var(--background, #fafafa)', color: 'var(--foreground, #1a1a1a)' }}>
    <div style={{ maxWidth: 1000, minHeight: '100%', margin: '0 auto', padding: 'clamp(72px, 12vh, 160px) clamp(24px, 5vw, 72px) 200px', display: 'grid', alignContent: 'start', gap: 24 }}>
      {snapshot ? snapshot.page.blocks.map(renderBlock) : <p role="status">Opening your interface…</p>}
      {snapshot?.diagnostic && <p role="status" style={{ maxWidth: 700, fontSize: 13, opacity: .65 }}>An interface edit needs fixing. Your last working page is still shown. See interface/diagnostics.json in your workspace.</p>}
      {error && <p role="alert" style={{ padding: 12, borderRadius: 10, background: '#fff1f0', color: '#8a1f11' }}>{error}</p>}
    </div>
  </main>;
}
