import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();
const AUTH_CHANGED_EVENT = 'server-auth-changed';

export interface ServerAuthChangedEvent {
  authenticated: boolean;
}

export function emitServerAuthChanged(event: ServerAuthChangedEvent): void {
  emitter.emit(AUTH_CHANGED_EVENT, event);
}

export function onServerAuthChanged(
  listener: (event: ServerAuthChangedEvent) => void,
): () => void {
  emitter.on(AUTH_CHANGED_EVENT, listener);
  return () => emitter.off(AUTH_CHANGED_EVENT, listener);
}
