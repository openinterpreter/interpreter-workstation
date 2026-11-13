/** Opaque-origin preview: untrusted project code has no file, parent, or network bridge. */
export function previewDocument(markup: string, stylesheet: string): string {
  if (new TextEncoder().encode(markup + stylesheet).byteLength > 512 * 1024) throw new Error('Preview too large');
  const safeStyle = stylesheet.replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><style>${safeStyle}</style></head><body>${markup}</body></html>`;
}

export function updatePreview(frame: HTMLIFrameElement, markup: string, stylesheet: string): void {
  frame.setAttribute('sandbox', 'allow-scripts'); // no allow-same-origin
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = previewDocument(markup, stylesheet);
}
