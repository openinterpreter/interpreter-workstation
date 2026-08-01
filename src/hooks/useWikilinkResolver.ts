import { useEffect } from 'react';
import { resolveWikilink } from '../api';

type WikilinkOpenDetail = {
  target: string;
  display?: string;
  fragment?: string;
  resolvedPath?: string;
};

/**
 * Listens for `wikilink:open` custom events dispatched by the markdown renderer
 * when a user clicks an Obsidian-style [[wikilink]]. Resolves the target to an
 * absolute file path within the current workspace and opens it via the
 * windowingAPI. No-ops when there is no workspace set.
 */
export function useWikilinkResolver(workspacePath: string | null): void {
  "use no memo";

  useEffect(() => {
    if (typeof window === 'undefined') return;

    function handler(event: Event) {
      const detail = (event as CustomEvent<WikilinkOpenDetail>).detail;
      if (!detail || !detail.target) return;

      void (async () => {
        try {
          const resolvedPath = detail.resolvedPath ?? (
            workspacePath
              ? (await resolveWikilink(detail.target))?.path
              : null
          );

          if (!resolvedPath) {
            if (!workspacePath) {
              console.warn('[wikilink] ignored, no workspace set', { target: detail.target });
              return;
            }

            console.warn('[wikilink] unresolved', { target: detail.target, workspacePath });
            window.dispatchEvent(new CustomEvent('wikilink:unresolved', {
              detail: { target: detail.target, display: detail.display },
            }));
            return;
          }

          const windowingAPI = (window as any).windowingAPI;
          windowingAPI?.openFile?.(resolvedPath);

          if (detail.fragment) {
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('mention:scroll-to', {
                detail: { path: resolvedPath, fragment: detail.fragment },
              }));
            }, 300);
          }
        } catch (error) {
          console.error('[wikilink] resolve failed', { target: detail.target, error });
        }
      })();
    }

    window.addEventListener('wikilink:open', handler);
    return () => window.removeEventListener('wikilink:open', handler);
  }, [workspacePath]);
}
