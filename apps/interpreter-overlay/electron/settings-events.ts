import { EventEmitter } from 'node:events';
import type { InterpreterOverlaySettings } from '../shared/settings.js';

const emitter = new EventEmitter();
const SETTINGS_CHANGED_EVENT = 'interpreter-overlay-settings-changed';

export function emitInterpreterOverlaySettingsChanged(settings: InterpreterOverlaySettings): void {
  emitter.emit(SETTINGS_CHANGED_EVENT, settings);
}

export function onInterpreterOverlaySettingsChanged(
  listener: (settings: InterpreterOverlaySettings) => void,
): () => void {
  emitter.on(SETTINGS_CHANGED_EVENT, listener);
  return () => emitter.off(SETTINGS_CHANGED_EVENT, listener);
}
