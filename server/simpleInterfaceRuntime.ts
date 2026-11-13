export const SIMPLE_INTERFACE_RUNTIME_MODULE = `import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const bridge = () => {
  if (!window.Interpreter) throw new Error('Interpreter interface bridge is unavailable.');
  return window.Interpreter;
};

export function sendMessage(message) {
  return bridge().sendMessage(String(message));
}

export function revealInFolder(path) {
  return bridge().files.reveal(String(path));
}

export async function runAgent({ message, system, timeoutMs, onEvent } = {}) {
  const text = String(message || '').trim();
  if (!text) throw new Error('A focused agent message is required.');
  const runId = globalThis.crypto?.randomUUID?.() || ('run-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const unsubscribe = typeof onEvent === 'function'
    ? bridge().files.on('agent-run:' + runId, onEvent)
    : () => {};
  try {
    return await bridge().agents.run({ runId, message: text, system, timeoutMs });
  } finally {
    unsubscribe();
  }
}

export function useAgentRun() {
  const [state, setState] = React.useState({ status: 'idle', events: [], result: null, error: null });
  const start = React.useCallback(async (options) => {
    setState({ status: 'running', events: [], result: null, error: null });
    try {
      const result = await runAgent({
        ...options,
        onEvent: (event) => {
          setState((current) => ({ ...current, events: [...current.events.slice(-39), event] }));
          options?.onEvent?.(event);
        },
      });
      setState((current) => ({ ...current, status: result?.completed === false ? 'failed' : 'completed', result, error: result?.error || null }));
      return result;
    } catch (error) {
      setState((current) => ({ ...current, status: 'failed', error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }, []);
  return { ...state, start };
}

function readableAgentEvent(event) {
  const value = event?.event || event;
  if (typeof value === 'string') return value;
  if (typeof value?.message === 'string') return value.message;
  if (typeof value?.text === 'string') return value.text;
  if (typeof value?.content === 'string') return value.content;
  if (typeof value?.type === 'string') return value.type.replaceAll('_', ' ');
  if (typeof event?.kind === 'string') return event.kind;
  return 'Working';
}

function readableAgentResult(result) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const candidate = message?.content ?? message?.text ?? message?.message;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate)) {
      const joined = candidate.map((item) => typeof item === 'string' ? item : item?.text || '').filter(Boolean).join('\\n');
      if (joined.trim()) return joined.trim();
    }
  }
  return result?.error || 'The focused agent completed.';
}

export function Research({ query, title = 'Research', autoStart = false, steer = true, onComplete, className = '' }) {
  const run = useAgentRun();
  const started = React.useRef(false);
  const start = React.useCallback(async () => {
    const result = await run.start({ message: 'Research this carefully and return a concise answer with source URLs:\\n\\n' + String(query || '') });
    const summary = readableAgentResult(result);
    onComplete?.(result, summary);
    if (steer) await sendMessage(title + ' finished:\\n\\n' + summary);
  }, [query, title, steer, onComplete, run.start]);
  React.useEffect(() => {
    if (autoStart && !started.current && query) { started.current = true; void start(); }
  }, [autoStart, query, start]);
  const recent = run.events.slice(-4);
  return <Card className={classes('io-research', className)}>
    <Row><Stack gap="xs"><Text as="strong" tone="primary">{title}</Text><Text>{query}</Text></Stack><Badge tone={run.status === 'failed' ? 'danger' : run.status === 'completed' ? 'success' : 'neutral'}>{run.status}</Badge></Row>
    {recent.length > 0 && <Stack gap="xs" className="io-research-stream">{recent.map((event, index) => <Text key={index}>{readableAgentEvent(event)}</Text>)}</Stack>}
    {run.error && <Text tone="danger">{run.error}</Text>}
    {run.status !== 'running' && <Button onClick={() => void start()}>{run.status === 'idle' ? 'Research' : 'Run again'}</Button>}
  </Card>;
}

export async function readState() {
  return bridge().state.get();
}

export async function writeState(next) {
  return bridge().state.set(next);
}

export function usePersistentState(key, initialValue) {
  const [value, setValue] = React.useState(initialValue);
  const [loaded, setLoaded] = React.useState(false);
  const updated = React.useRef(false);
  const updatedKey = React.useRef(key);
  if (updatedKey.current !== key) { updatedKey.current = key; updated.current = false; }
  React.useEffect(() => {
    let active = true;
    readState().then((state) => {
      if (active && !updated.current && Object.prototype.hasOwnProperty.call(state, key)) setValue(state[key]);
    }).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [key]);
  const update = React.useCallback((next) => {
    updated.current = true;
    setValue((current) => {
      const resolved = typeof next === 'function' ? next(current) : next;
      void bridge().state.update(key, resolved);
      return resolved;
    });
  }, [key]);
  return [value, update, loaded];
}

function classes(...values) { return values.filter(Boolean).join(' '); }

export function Page({ children, className = '', ...props }) {
  return <main className={classes('io-page', className)} {...props}>{children}</main>;
}

export function Stack({ children, gap = 'md', className = '', ...props }) {
  return <div className={classes('io-stack', 'io-gap-' + gap, className)} {...props}>{children}</div>;
}

export function Row({ children, gap = 'sm', wrap = false, className = '', ...props }) {
  return <div className={classes('io-row', 'io-gap-' + gap, wrap && 'io-wrap', className)} {...props}>{children}</div>;
}

export function Grid({ children, min = 240, columns, gap = 'md', className = '', style, ...props }) {
  const template = columns ? 'repeat(' + columns + ', minmax(0, 1fr))' : 'repeat(auto-fit, minmax(min(100%, var(--io-grid-min)), 1fr))';
  return <div className={classes('io-grid', 'io-gap-' + gap, className)} style={{ '--io-grid-min': min + 'px', '--io-grid-template': template, ...style }} {...props}>{children}</div>;
}

export function Section({ eyebrow, title, description, children, className = '', ...props }) {
  return <section className={classes('io-section', className)} {...props}>
    {(eyebrow || title || description) && <header className="io-section-header">
      {eyebrow && <div className="io-eyebrow">{eyebrow}</div>}
      {title && <h2 className="io-section-title">{title}</h2>}
      {description && <p className="io-section-description">{description}</p>}
    </header>}
    {children}
  </section>;
}

export function Card({ children, tone = 'default', className = '', ...props }) {
  return <div className={classes('io-card', 'io-card-' + tone, className)} {...props}>{children}</div>;
}

export function Heading({ as: Tag = 'h1', children, className = '', ...props }) {
  return <Tag className={classes('io-heading', className)} {...props}>{children}</Tag>;
}

export function Text({ as: Tag = 'p', tone = 'secondary', children, className = '', ...props }) {
  return <Tag className={classes('io-text', 'io-text-' + tone, className)} {...props}>{children}</Tag>;
}

export function Badge({ children, tone = 'neutral', className = '', ...props }) {
  return <span className={classes('io-badge', 'io-badge-' + tone, className)} {...props}>{children}</span>;
}

export function Button({ children, variant = 'primary', className = '', type = 'button', ...props }) {
  return <button type={type} className={classes('io-button', 'io-button-' + variant, className)} {...props}>{children}</button>;
}

export function TextInput({ label, hint, className = '', ...props }) {
  return <label className={classes('io-field', className)}>
    {label && <span className="io-field-label">{label}</span>}
    <input className="io-input" {...props} />
    {hint && <span className="io-field-hint">{hint}</span>}
  </label>;
}

export function Image({ alt, caption, className = '', ...props }) {
  return <figure className={classes('io-image-frame', className)}>
    <img alt={alt ?? ''} {...props} />
    {caption && <figcaption>{caption}</figcaption>}
  </figure>;
}

export function ImageGrid({ items = [], min = 180, className = '' }) {
  const [active, setActive] = React.useState(null);
  React.useEffect(() => {
    if (!active) return undefined;
    const close = (event) => { if (event.key === 'Escape') setActive(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [active]);
  const normalized = items.map((item) => typeof item === 'string' ? { src: item, alt: '' } : item);
  return <>
    <div className={classes('io-image-grid', className)} style={{ '--io-image-grid-min': min + 'px' }}>
      {normalized.map((item, index) => <button className="io-image-grid-item" type="button" key={item.src + ':' + index} onClick={() => setActive(item)} aria-label={item.alt ? 'Open ' + item.alt : 'Open image'}>
        <img src={item.src} alt={item.alt || ''} />
        {item.caption && <span>{item.caption}</span>}
      </button>)}
    </div>
    {active && <div className="io-lightbox" role="dialog" aria-modal="true" aria-label={active.alt || 'Image preview'} onClick={() => setActive(null)}>
      <div className="io-lightbox-content" onClick={(event) => event.stopPropagation()}>
        <img src={active.src} alt={active.alt || ''} />
        <Row className="io-lightbox-actions">
          {active.path && <Button variant="secondary" onClick={() => void revealInFolder(active.path)}>Show in folder</Button>}
          <Button variant="secondary" onClick={() => setActive(null)}>Close</Button>
        </Row>
      </div>
    </div>}
  </>;
}

export function FileViewer({ path, className = '', minHeight = 360, style, ...props }) {
  const id = React.useId();
  const ref = React.useRef(null);
  React.useEffect(() => {
    const element = ref.current;
    if (!element || !path) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        bridge().files.register({ id, kind: 'file', path: String(path), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('scroll', report, true);
    window.addEventListener('resize', report);
    report();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', report, true);
      window.removeEventListener('resize', report);
      bridge().files.unregister(id);
    };
  }, [id, path]);
  return <div
    ref={ref}
    className={classes('io-file-viewer', className)}
    data-interpreter-file-path={path}
    style={{ minHeight, ...style }}
    {...props}
  ><span className="io-file-viewer-label">{String(path || 'Choose a file')}</span></div>;
}

export function FolderViewer({ path = '.', onOpen, className = '', minHeight = 420, style, ...props }) {
  const id = React.useId();
  const ref = React.useRef(null);
  React.useEffect(() => bridge().files.on('file-open:' + id, (detail) => onOpen?.(detail.path)), [id, onOpen]);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        bridge().files.register({ id, kind: 'folder', path: String(path), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      });
    };
    const observer = new ResizeObserver(report); observer.observe(element);
    window.addEventListener('scroll', report, true); window.addEventListener('resize', report); report();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('scroll', report, true); window.removeEventListener('resize', report);
      bridge().files.unregister(id);
    };
  }, [id, path]);
  return <div ref={ref} className={classes('io-file-viewer', className)} data-interpreter-file-path={path} style={{ minHeight, ...style }} {...props}>
    <span className="io-file-viewer-label">{String(path || '.')}</span>
  </div>;
}

export function useFilesDropped(handler) {
  React.useEffect(() => bridge().files.on('files-dropped', handler), [handler]);
}

export function DropZone({ children, onFiles, className = '', emptyLabel = 'Drop files here', ...props }) {
  const ref = React.useRef(null);
  const [active, setActive] = React.useState(false);
  useFilesDropped(React.useCallback((detail) => {
    const rect = ref.current?.getBoundingClientRect();
    const point = detail?.point;
    if (!rect || !point || point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) return;
    onFiles?.(detail.files || []);
    setActive(false);
  }, [onFiles]));
  React.useEffect(() => {
    const enter = () => setActive(true);
    const leave = () => setActive(false);
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave); window.addEventListener('drop', leave);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', leave); };
  }, []);
  return <div ref={ref} className={classes('io-drop-zone', active && 'io-drop-zone-active', className)} {...props}>
    {children ?? <div className="io-drop-zone-empty">{emptyLabel}</div>}
  </div>;
}

export function Markdown({ children, className = '' }) {
  return <div className={classes('io-markdown', className)}>
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(children ?? '')}</ReactMarkdown>
  </div>;
}

export const componentCatalog = Object.freeze({
  layout: ['Page', 'Stack', 'Row', 'Grid', 'Section', 'Card', 'DropZone'],
  content: ['Heading', 'Text', 'Badge', 'Markdown', 'Image', 'ImageGrid', 'FileViewer', 'FolderViewer', 'Research'],
  controls: ['Button', 'TextInput'],
  state: ['usePersistentState', 'readState', 'writeState'],
  actions: ['sendMessage', 'runAgent', 'useAgentRun', 'useFilesDropped', 'revealInFolder'],
});
`;

export const SIMPLE_INTERFACE_COMPONENT_CSS = `
:root {
  color-scheme: light dark;
  --io-canvas: #f5f4f0;
  --io-surface: rgba(255, 255, 255, .78);
  --io-surface-raised: rgba(255, 255, 255, .94);
  --io-inset: rgba(27, 25, 22, .055);
  --io-ink: #1c1b19;
  --io-ink-secondary: rgba(28, 27, 25, .68);
  --io-ink-tertiary: rgba(28, 27, 25, .48);
  --io-line: rgba(28, 27, 25, .12);
  --io-line-soft: rgba(28, 27, 25, .075);
  --io-accent: #2864dc;
  --io-accent-ink: #fff;
  --io-success: #177245;
  --io-warning: #a65d08;
  --io-danger: #b42318;
  --io-radius: 18px;
  --io-shadow: 0 18px 50px rgba(45, 39, 28, .09), 0 2px 8px rgba(45, 39, 28, .05);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: geometricPrecision;
}
@media (prefers-color-scheme: dark) {
  :root {
    --io-canvas: #151615;
    --io-surface: rgba(36, 37, 35, .78);
    --io-surface-raised: rgba(43, 44, 42, .94);
    --io-inset: rgba(255, 255, 255, .055);
    --io-ink: #f3f1eb;
    --io-ink-secondary: rgba(243, 241, 235, .67);
    --io-ink-tertiary: rgba(243, 241, 235, .45);
    --io-line: rgba(243, 241, 235, .13);
    --io-line-soft: rgba(243, 241, 235, .075);
    --io-accent: #77a2ff;
    --io-accent-ink: #101522;
    --io-success: #55b986;
    --io-warning: #e4a04f;
    --io-danger: #ff8278;
    --io-shadow: 0 22px 70px rgba(0, 0, 0, .28), 0 2px 8px rgba(0, 0, 0, .18);
  }
}
* { box-sizing: border-box; }
html, body, #root { width: 100%; min-height: 100%; margin: 0; }
body { background: var(--io-canvas); color: var(--io-ink); }
button, input, textarea, select { font: inherit; }
.io-page { min-height: 100vh; padding: clamp(28px, 5vw, 76px) clamp(22px, 5vw, 80px) 180px; background: var(--io-canvas); color: var(--io-ink); }
.io-stack { display: flex; flex-direction: column; }
.io-row { display: flex; align-items: center; }
.io-wrap { flex-wrap: wrap; }
.io-gap-xs { gap: 6px; } .io-gap-sm { gap: 10px; } .io-gap-md { gap: 16px; } .io-gap-lg { gap: 26px; } .io-gap-xl { gap: 40px; }
.io-grid { display: grid; grid-template-columns: var(--io-grid-template); }
.io-section { width: min(100%, 1100px); margin-inline: auto; }
.io-section-header { margin-bottom: 18px; }
.io-eyebrow { margin-bottom: 7px; color: var(--io-ink-tertiary); font-size: 11px; font-weight: 650; letter-spacing: .105em; text-transform: uppercase; }
.io-section-title { margin: 0; font-size: clamp(24px, 3vw, 38px); line-height: 1.05; letter-spacing: -.035em; }
.io-section-description { max-width: 660px; margin: 9px 0 0; color: var(--io-ink-secondary); font-size: 14px; line-height: 1.55; }
.io-card { border: .5px solid var(--io-line); border-radius: var(--io-radius); padding: 18px; background: var(--io-surface); backdrop-filter: blur(22px) saturate(1.08); }
.io-card-raised { background: var(--io-surface-raised); box-shadow: var(--io-shadow); }
.io-card-inset { background: var(--io-inset); box-shadow: inset 0 0 0 .5px var(--io-line-soft); }
.io-heading { margin: 0; line-height: 1.04; letter-spacing: -.04em; }
.io-text { margin: 0; font-size: 14px; line-height: 1.55; }
.io-text-primary { color: var(--io-ink); } .io-text-secondary { color: var(--io-ink-secondary); } .io-text-tertiary { color: var(--io-ink-tertiary); }
.io-text-danger { color: var(--io-danger); }
.io-badge { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 8px; border: .5px solid var(--io-line); border-radius: 999px; font-size: 11px; font-weight: 600; }
.io-badge-neutral { color: var(--io-ink-secondary); background: var(--io-inset); } .io-badge-success { color: var(--io-success); } .io-badge-warning { color: var(--io-warning); } .io-badge-danger { color: var(--io-danger); }
.io-button { min-height: 36px; padding: 7px 13px; border: .5px solid transparent; border-radius: 999px; font-size: 13px; font-weight: 620; transition: transform 140ms ease, background 140ms ease, border-color 140ms ease; }
.io-button:active { transform: scale(.975); }
.io-button:focus-visible, .io-input:focus-visible { outline: 2px solid color-mix(in srgb, var(--io-accent) 72%, transparent); outline-offset: 2px; }
.io-button-primary { background: var(--io-ink); color: var(--io-canvas); }
.io-button-secondary { border-color: var(--io-line); background: var(--io-surface); color: var(--io-ink); }
.io-button-ghost { background: transparent; color: var(--io-ink-secondary); }
.io-field { display: grid; gap: 6px; }
.io-field-label { color: var(--io-ink-secondary); font-size: 12px; font-weight: 620; }
.io-field-hint { color: var(--io-ink-tertiary); font-size: 11px; }
.io-input { min-height: 40px; width: 100%; border: .5px solid var(--io-line); border-radius: 12px; padding: 8px 11px; background: var(--io-inset); color: var(--io-ink); outline: none; }
.io-image-frame { margin: 0; overflow: hidden; border: .5px solid var(--io-line); border-radius: var(--io-radius); background: var(--io-inset); }
.io-image-frame img { display: block; width: 100%; height: auto; }
.io-image-frame figcaption { padding: 9px 12px; color: var(--io-ink-tertiary); font-size: 11px; }
.io-image-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--io-image-grid-min)), 1fr)); gap: 10px; }
.io-image-grid-item { position: relative; min-height: 150px; overflow: hidden; border: .5px solid var(--io-line); border-radius: var(--io-radius); padding: 0; background: var(--io-inset); color: var(--io-ink); cursor: zoom-in; }
.io-image-grid-item img { display: block; width: 100%; height: 100%; min-height: 150px; object-fit: cover; transition: transform 220ms cubic-bezier(.16, 1, .3, 1); }
.io-image-grid-item:hover img { transform: scale(1.025); }
.io-image-grid-item span { position: absolute; inset: auto 9px 9px; width: fit-content; max-width: calc(100% - 18px); overflow: hidden; border-radius: 999px; padding: 5px 9px; background: color-mix(in srgb, var(--io-canvas) 82%, transparent); color: var(--io-ink); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; backdrop-filter: blur(14px); }
.io-lightbox { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 24px; background: rgba(0, 0, 0, .68); backdrop-filter: blur(18px); }
.io-lightbox-content { display: grid; max-width: min(1100px, 96vw); max-height: 94vh; gap: 12px; }
.io-lightbox-content img { display: block; max-width: 100%; max-height: calc(94vh - 52px); margin: auto; border-radius: 14px; box-shadow: 0 26px 90px rgba(0, 0, 0, .34); object-fit: contain; }
.io-lightbox-actions { justify-content: flex-end; }
.io-file-viewer { position: relative; overflow: hidden; border: .5px solid var(--io-line); border-radius: var(--io-radius); background: var(--io-inset); }
.io-file-viewer-label { position: absolute; inset: 0; display: grid; place-items: center; color: var(--io-ink-tertiary); font-size: 12px; }
.io-drop-zone { min-height: 120px; border-radius: var(--io-radius); transition: background 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
.io-drop-zone-active { background: color-mix(in srgb, var(--io-accent) 8%, transparent); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--io-accent) 52%, transparent); transform: scale(.998); }
.io-drop-zone-empty { min-height: 180px; display: grid; place-items: center; border: 1px dashed var(--io-line); border-radius: inherit; color: var(--io-ink-tertiary); font-size: 13px; }
.io-markdown { color: var(--io-ink-secondary); font-size: 15px; line-height: 1.67; }
.io-markdown > :first-child { margin-top: 0; } .io-markdown > :last-child { margin-bottom: 0; }
.io-markdown h1, .io-markdown h2, .io-markdown h3 { color: var(--io-ink); line-height: 1.15; letter-spacing: -.025em; }
.io-markdown h1 { font-size: 30px; } .io-markdown h2 { margin-top: 1.6em; font-size: 22px; } .io-markdown h3 { margin-top: 1.4em; font-size: 17px; }
.io-markdown a { color: var(--io-accent); text-underline-offset: 3px; }
.io-markdown code { border-radius: 6px; padding: 2px 5px; background: var(--io-inset); color: var(--io-ink); font-size: .9em; }
.io-markdown pre { overflow: auto; border: .5px solid var(--io-line); border-radius: 13px; padding: 14px; background: var(--io-inset); }
.io-markdown pre code { padding: 0; background: transparent; }
.io-markdown blockquote { margin-inline: 0; border-left: 2px solid var(--io-line); padding-left: 16px; color: var(--io-ink-tertiary); }
.io-markdown table { width: 100%; border-collapse: collapse; }
.io-markdown th, .io-markdown td { border-bottom: .5px solid var(--io-line); padding: 8px 10px; text-align: left; }
.io-motion-line { display: block; } .io-motion-segment { display: inline-block; white-space: pre; }
.io-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.io-transition-panel { position: relative; }
.io-research > .io-row { justify-content: space-between; align-items: flex-start; }
.io-research-stream { max-height: 170px; overflow: auto; margin-block: 14px; border-left: 1px solid var(--io-line); padding-left: 12px; }
.io-text-shimmer { display: inline-block; color: transparent; background-image: linear-gradient(90deg, transparent calc(50% - var(--io-shimmer-spread)), currentColor, transparent calc(50% + var(--io-shimmer-spread))), linear-gradient(var(--io-ink-tertiary), var(--io-ink-tertiary)); background-size: 250% 100%, auto; background-clip: text; background-repeat: no-repeat; }
@media (prefers-reduced-motion: reduce) { .io-button { transition: none; } }
`;
