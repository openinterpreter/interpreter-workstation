import { randomUUID } from 'node:crypto';
import { broadcastEvent } from './handlers/broadcast';

export type SimplePresentation = {
  id: string;
  kind: 'text' | 'image' | 'progress' | 'result';
  title: string;
  text: string | null;
  asset: string | null;
  createdAt: string;
};

let currentPresentation: SimplePresentation | null = null;

export function readSimplePresentation(): SimplePresentation | null {
  return currentPresentation;
}

export function publishSimplePresentation(input: Omit<SimplePresentation, 'id' | 'createdAt'>): SimplePresentation {
  currentPresentation = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  broadcastEvent('simple-presentation:changed', currentPresentation);
  return currentPresentation;
}

export function clearSimplePresentation(): void {
  currentPresentation = null;
  broadcastEvent('simple-presentation:changed', null);
}
