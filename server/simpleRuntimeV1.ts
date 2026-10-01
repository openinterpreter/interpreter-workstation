/** Versioned, app-owned bridge bundled into independently located interface projects. */
export const SIMPLE_RUNTIME_V1 = `import React from 'react';

export const useState = React.useState;
export const useReducer = React.useReducer;

export function sendMessage(message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 6000) throw new Error('Invalid action');
  parent.postMessage({ type: 'interpreter-simple-action', message }, '*');
}
export const send = sendMessage;
export const runAgent = sendMessage;

export function FileView({ name, size, onOpen }) {
  return React.createElement('button', { type: 'button', onClick: onOpen, className: 'interpreter-file' },
    React.createElement('span', null, name), size != null && React.createElement('small', null, String(size)));
}
export function FolderView({ name, children }) {
  return React.createElement('section', { className: 'interpreter-folder', 'aria-label': name },
    React.createElement('strong', null, name), children);
}
export function EditorView({ value, onChange, label = 'Editor' }) {
  return React.createElement('textarea', { className: 'interpreter-editor', 'aria-label': label, value, onChange: event => onChange?.(event.target.value) });
}
export function Motion({ children, as = 'div', duration = 180, ...props }) {
  return React.createElement(as, { ...props, style: { transition: 'all ' + Math.max(0, Math.min(duration, 2000)) + 'ms ease', ...props.style } }, children);
}
`;
