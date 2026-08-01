import { BrowserWindow, type WebFrameMain } from 'electron';
import { getStudioPort, listRunningStudios } from '../../../handlers/remotion';

function findAllFrames(frame: WebFrameMain): WebFrameMain[] {
  const result: WebFrameMain[] = [frame];
  for (const child of frame.frames) {
    result.push(...findAllFrames(child));
  }
  return result;
}

function findStudioFrame(port: number): WebFrameMain | null {
  const prefix = `http://127.0.0.1:${port}`;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      const frames = findAllFrames(win.webContents.mainFrame);
      for (const frame of frames) {
        try {
          if (frame.url.startsWith(prefix)) return frame;
        } catch {
          // Frame may have been destroyed
        }
      }
    } catch {
      // Window may have been destroyed between check and access
    }
  }
  return null;
}

export async function executeInStudio<T>(viewerId: string, script: string): Promise<T> {
  const port = getStudioPort(viewerId);
  if (port === null) {
    throw new Error(`Remotion Studio is not running for viewer: ${viewerId}`);
  }
  const frame = findStudioFrame(port);
  if (!frame) {
    throw new Error('Remotion Studio frame not found. Is the viewer tab open?');
  }
  return frame.executeJavaScript(script) as Promise<T>;
}

export function resolveViewerId(rawId: string): string {
  // Strip remotion:// prefix if present (for mention-style references)
  if (rawId.startsWith('remotion://')) {
    return rawId.slice('remotion://'.length);
  }
  return rawId;
}

/**
 * Resolve the viewer_id from tool args, auto-selecting if only one studio is running.
 * Returns the resolved viewerId or an error result to return from the handler.
 */
export function resolveStudioOrError(
  args: Record<string, any>,
): { viewerId: string } | { error: { content: Array<{ type: string; text: string }>; isError: true } } {
  const viewerId = args.viewer_id ? resolveViewerId(args.viewer_id as string) : null;
  if (viewerId) return { viewerId };

  const studios = listRunningStudios();
  if (studios.length === 0) {
    return { error: { content: [{ type: 'text', text: 'No Remotion Studios are currently running.' }], isError: true } };
  }
  if (studios.length > 1) {
    const list = studios.map(s => `  - ${s.manifestPath}`).join('\n');
    return { error: { content: [{ type: 'text', text: `Multiple studios running. Specify viewer_id:\n${list}` }], isError: true } };
  }
  return { viewerId: studios[0].manifestPath };
}

export { listRunningStudios };
