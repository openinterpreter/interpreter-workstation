/** App-owned design assets for the versioned, sandboxed project runtime. */
export const SIMPLE_RUNTIME_V1_STYLES = `
:root { color-scheme: dark; --interface-bg:#15181c; --interface-panel:#20252b;
  --interface-line:#343b44; --interface-text:#f1f3f5; --interface-muted:#a1aab5;
  --interface-accent:#a6c1d7; }
html, body, #root { min-height: 100%; }
body { margin:0; background:var(--interface-bg); color:var(--interface-text);
  font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
button, textarea { font:inherit; }
.interpreter-file { width:100%; display:flex; justify-content:space-between; align-items:center;
  gap:16px; padding:11px 14px; color:var(--interface-text); background:var(--interface-panel);
  border:1px solid var(--interface-line); border-radius:10px; text-align:left; cursor:pointer; }
.interpreter-file:hover { border-color:var(--interface-accent); }
.interpreter-file small { color:var(--interface-muted); }
.interpreter-folder { padding:14px; border:1px solid var(--interface-line);
  background:var(--interface-panel); border-radius:12px; }
.interpreter-folder strong { display:block; margin-bottom:10px; font-weight:600; }
.interpreter-editor { box-sizing:border-box; display:block; width:100%; min-height:110px;
  resize:vertical; padding:12px; border-radius:10px; border:1px solid var(--interface-line);
  background:var(--interface-panel); color:var(--interface-text); }
.interpreter-editor:focus { outline:2px solid var(--interface-accent); outline-offset:2px; }
`;
