import Image from '@tiptap/extension-image';
import { openExternal } from '@/ipc';
import { resolveLocalLinkTarget } from '../utils/localLinkDetection';
import { openMentionTarget } from '../../agent/components/mentions/openMentionTarget';
import { showFileReferenceContextMenu } from '../utils/fileReferenceContextMenu';

/** Resolve function: given the raw src from markdown, return a displayable URL. */
export type ResolveImageSrc = (src: string) => Promise<string> | string;

function isExternalUrl(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

/**
 * Resizable Image extension.
 *
 * Extends the built-in Image with:
 *  - A `width` attribute (CSS value, default "50%") persisted in JSON/HTML.
 *  - A custom node view with a bottom-right resize handle.
 *  - An optional `resolveImageSrc` callback stored in extension storage
 *    that maps a raw file path to a displayable URL. The raw path stays
 *    in the document JSON; only the <img> element's src is swapped.
 *
 * Set the resolver after editor creation:
 *   editor.storage.resizableImage.resolveImageSrc = myResolver;
 * Or pass it via the configure helper that reads from storage.
 */
export const ResizableImage = Image.extend({
  name: 'image', // keep same name so it replaces the built-in

  addStorage() {
    return {
      resolveImageSrc: null as ResolveImageSrc | null,
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: '50%',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-width') || el.style.width || '50%',
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-width': attrs.width,
          style: `width: ${attrs.width}`,
        }),
      },
      href: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-href'),
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.href) return {};
          return { 'data-href': attrs.href };
        },
      },
    };
  },

  addNodeView() {
    // Capture `this.storage` so the node view factory can read the resolver
    const storage = this.storage as { resolveImageSrc: ResolveImageSrc | null };

    return ({ node, getPos, editor }) => {
      const wrapper = document.createElement('span');
      wrapper.style.display = 'inline-block';
      wrapper.style.position = 'relative';
      wrapper.style.width = node.attrs.width || '50%';
      wrapper.style.maxWidth = '100%';
      wrapper.style.verticalAlign = 'bottom';
      wrapper.style.lineHeight = '0';
      wrapper.classList.add('resizable-image-wrapper');
      if (node.attrs.href) {
        wrapper.setAttribute('data-href', node.attrs.href);
        wrapper.style.cursor = 'pointer';
      }

      const img = document.createElement('img');
      img.alt = node.attrs.alt || '';
      if (node.attrs.title) img.title = node.attrs.title;
      img.style.width = '100%';
      img.style.height = 'auto';
      img.style.display = 'block';
      img.style.borderRadius = 'var(--control-radius)';
      img.draggable = false;

      // Resolve the src for display — raw path stays in the document JSON.
      // If the resolver isn't registered yet (race on first mount), retry
      // until it appears so images always resolve once the editor is ready.
      const applySrc = (src: string) => {
        if (!src) return;
        const resolver = storage.resolveImageSrc;
        if (isExternalUrl(src)) {
          img.src = src;
        } else if (resolver) {
          const result = resolver(src);
          if (typeof result === 'string') {
            img.src = result;
          } else {
            result.then((url) => { img.src = url; });
          }
        } else {
          // Resolver not yet available — retry until it is
          setTimeout(() => applySrc(src), 50);
        }
      };
      applySrc(node.attrs.src || '');

      // Resize handle (bottom-right corner)
      const handle = document.createElement('span');
      handle.contentEditable = 'false';
      handle.style.cssText = `
        position: absolute; bottom: 4px; right: 4px;
        width: 14px; height: 14px; cursor: nwse-resize;
        background: var(--primary);
        border-radius: 2px; opacity: 0;
        transition: opacity 120ms ease;
        display: flex; align-items: center; justify-content: center;
      `;
      handle.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none" style="pointer-events:none">
        <path d="M7 1L1 7M7 4L4 7" stroke="var(--on-primary)" stroke-width="1.2" stroke-linecap="round"/>
      </svg>`;

      // Click handler for linked images (href attribute)
      wrapper.addEventListener('click', (e) => {
        const href = wrapper.getAttribute('data-href');
        if (href && !dragging) {
          e.preventDefault();
          e.stopPropagation();
          const localTarget = resolveLocalLinkTarget(href);
          if (localTarget) {
            openMentionTarget(localTarget);
          } else {
            void openExternal(href).catch((error) => {
              console.error('[ResizableImage] Failed to open external link:', error);
            });
          }
        }
      });

      wrapper.addEventListener('contextmenu', (e) => {
        const srcTarget = resolveLocalLinkTarget(node.attrs.src || '');
        const hrefTarget = wrapper.getAttribute('data-href')
          ? resolveLocalLinkTarget(wrapper.getAttribute('data-href') || '')
          : null;
        const targetPath = srcTarget?.path || hrefTarget?.path;
        if (!targetPath) return;

        e.preventDefault();
        e.stopPropagation();
        void showFileReferenceContextMenu(targetPath, 'tiptap_image');
      });

      wrapper.addEventListener('mouseenter', () => { handle.style.opacity = '1'; });
      wrapper.addEventListener('mouseleave', () => { if (!dragging) handle.style.opacity = '0'; });

      let dragging = false;

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;

        const startX = e.clientX;
        const startWidth = wrapper.getBoundingClientRect().width;
        const parentWidth = wrapper.parentElement?.getBoundingClientRect().width || startWidth;

        const onMove = (ev: MouseEvent) => {
          const delta = ev.clientX - startX;
          const newPx = Math.max(60, startWidth + delta);
          const clampedPx = Math.min(newPx, parentWidth);
          const pct = Math.round((clampedPx / parentWidth) * 100);
          wrapper.style.width = `${pct}%`;
        };

        const onUp = () => {
          dragging = false;
          handle.style.opacity = '0';
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);

          if (typeof getPos === 'function') {
            const pos = getPos();
            if (typeof pos === 'number') {
              editor.chain()
                .command(({ tr }) => {
                  tr.setNodeMarkup(pos, undefined, {
                    ...node.attrs,
                    width: wrapper.style.width,
                  });
                  return true;
                })
                .run();
            }
          }
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      wrapper.appendChild(img);
      wrapper.appendChild(handle);

      return {
        dom: wrapper,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'image') return false;
          if (updatedNode.attrs.src !== node.attrs.src) {
            applySrc(updatedNode.attrs.src || '');
          }
          img.alt = updatedNode.attrs.alt || '';
          if (updatedNode.attrs.title) img.title = updatedNode.attrs.title;
          wrapper.style.width = updatedNode.attrs.width || '50%';
          if (updatedNode.attrs.href) {
            wrapper.setAttribute('data-href', updatedNode.attrs.href);
            wrapper.style.cursor = 'pointer';
          } else {
            wrapper.removeAttribute('data-href');
            wrapper.style.cursor = '';
          }
          node = updatedNode;
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
});
