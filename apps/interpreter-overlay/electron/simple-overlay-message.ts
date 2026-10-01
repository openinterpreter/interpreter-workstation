import type { OverlayContextItem } from '../shared/ipc';

/** Preserve the origin of a Simple overlay turn without exposing raw screenshot data. */
export function buildSimpleOverlayMessage(text: string, contextItems: OverlayContextItem[]): string {
  const lines = contextItems.slice(0, 8).map((item) => {
    if (item.kind === 'file') {
      return `- Selected file: ${item.filePath ?? item.name}`.slice(0, 2000);
    }
    return `- ${item.role === 'target' ? 'Selected target' : 'Screen selection'}: ${item.previewText || item.appIconLabel || 'region selected'}`.slice(0, 2000);
  });
  return [
    '[Message from the Simple desktop overlay]',
    ...lines,
    text.trim().slice(0, 20000),
  ].filter(Boolean).join('\n');
}
