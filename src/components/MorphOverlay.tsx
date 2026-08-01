import { useState, useEffect, useRef } from 'react';

interface OverlayRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface MorphOverlayData {
  clone: HTMLElement;
  rect: OverlayRect;
  composerClone: HTMLElement | null;
  composerRect: OverlayRect | null;
  text: string;
}

// PersistentLayer insets each overlay div by this many px on each side
const PANE_INSET = 2;
const MORPH_TARGET_SELECTOR = '[data-morph-composer-target="true"]';

function getMorphTargetRect(): OverlayRect | null {
  const target = Array.from(document.querySelectorAll<HTMLElement>(MORPH_TARGET_SELECTOR))
    .find((node) => node.closest('[data-persistent-visible]'));
  if (!target) return null;

  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

export function MorphOverlay() {
  const [overlay, setOverlay] = useState<MorphOverlayData | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: CustomEvent<MorphOverlayData>) => {
      setOverlay(e.detail);
    };
    window.addEventListener('morph:start', handler as EventListener);
    return () => window.removeEventListener('morph:start', handler as EventListener);
  }, []);

  // Page clone: hide composer inside it, then fade out
  useEffect(() => {
    if (!overlay || !pageRef.current) return;
    const el = pageRef.current;
    el.innerHTML = '';
    el.appendChild(overlay.clone);

    const rootClone = el.firstElementChild;
    if (rootClone instanceof HTMLElement) {
      rootClone.style.background = 'transparent';
      rootClone.style.boxShadow = 'none';
    }

    // Hide the composer in the page clone — the separate composer overlay handles it
    const composerInClone = el.querySelector('.new-tab-composer-wrapper');
    if (composerInClone) {
      (composerInClone as HTMLElement).style.visibility = 'hidden';
    }

    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.opacity = '0';
      });
    });

    const timer = setTimeout(() => setOverlay(null), 400);
    return () => { cancelAnimationFrame(id); clearTimeout(timer); };
  }, [overlay]);

  // Composer clone (with text still in it): animate down to agent composer position
  useEffect(() => {
    if (!overlay?.composerClone || !overlay.composerRect || !composerRef.current) return;
    const el = composerRef.current;
    el.innerHTML = '';
    el.appendChild(overlay.composerClone);
    let rafId = 0;

    const animateToTarget = (attemptsRemaining: number) => {
      const targetRect = getMorphTargetRect();
      if (!targetRect) {
        if (attemptsRemaining <= 0) return;
        rafId = requestAnimationFrame(() => animateToTarget(attemptsRemaining - 1));
        return;
      }

      rafId = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.style.top = `${targetRect.top}px`;
          el.style.left = `${targetRect.left}px`;
          el.style.width = `${targetRect.width}px`;
          el.style.height = `${targetRect.height}px`;
          el.style.opacity = '0';
        });
      });
    };

    animateToTarget(12);

    return () => { cancelAnimationFrame(rafId); };
  }, [overlay]);

  // Text bubble: animate from composer position up-right toward user message position
  useEffect(() => {
    if (!overlay?.composerRect || !overlay.text || !textRef.current) return;
    const el = textRef.current;

    // Calculate target: where the first user message renders in the agent thread
    const paneLeft = overlay.rect.left + PANE_INSET;
    const paneWidth = overlay.rect.width - PANE_INSET * 2;
    const paneTop = overlay.rect.top + PANE_INSET;

    const threadMaxWidth = 896; // 56rem
    const wrapperWidth = Math.min(threadMaxWidth, paneWidth);
    const sidePad = paneWidth > 500 ? 13 : 0;

    // Right edge of the message area
    const messageAreaRight = paneLeft + (paneWidth + wrapperWidth) / 2 - sidePad;

    // Target: top of thread area, right-aligned like a user message
    // pt-10 = 40px from top of thread content
    const targetTop = paneTop + 40 + 8;
    const textWidth = el.offsetWidth;
    const targetLeft = messageAreaRight - textWidth;

    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.top = `${targetTop}px`;
        el.style.left = `${targetLeft}px`;
        el.style.opacity = '0';
      });
    });

    return () => { cancelAnimationFrame(id); };
  }, [overlay]);

  if (!overlay) return null;

  return (
    <>
      {/* Page content clone — fades out */}
      <div
        ref={pageRef}
        style={{
          position: 'fixed',
          top: overlay.rect.top,
          left: overlay.rect.left,
          width: overlay.rect.width,
          height: overlay.rect.height,
          zIndex: 25,
          pointerEvents: 'none',
          opacity: 1,
          transition: 'opacity 250ms ease-out',
          overflow: 'hidden',
          background: 'transparent',
        }}
      />

      {/* Composer clone — animates down + wider + fades out */}
      {overlay.composerClone && overlay.composerRect && (
        <div
          ref={composerRef}
          style={{
            position: 'fixed',
            top: overlay.composerRect.top,
            left: overlay.composerRect.left,
            width: overlay.composerRect.width,
            height: overlay.composerRect.height,
            zIndex: 26,
            pointerEvents: 'none',
            opacity: 1,
            transition: 'top 300ms cubic-bezier(0.4, 0, 0.2, 1), left 300ms cubic-bezier(0.4, 0, 0.2, 1), width 300ms cubic-bezier(0.4, 0, 0.2, 1), height 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 280ms ease-out',
            overflow: 'hidden',
          }}
        />
      )}

      {/* Text bubble — animates up-right toward user message position */}
      {overlay.text && overlay.composerRect && (
        <div
          ref={textRef}
          style={{
            position: 'fixed',
            top: overlay.composerRect.top,
            left: overlay.composerRect.left,
            zIndex: 27,
            pointerEvents: 'none',
            opacity: 1,
            transition: 'top 300ms cubic-bezier(0.4, 0, 0.2, 1), left 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 260ms ease-out',
            maxWidth: Math.min(overlay.composerRect.width, 500),
            backgroundColor: 'color-mix(in srgb, var(--oa-surface-center, var(--popover)) 94%, transparent)',
            border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 70%, transparent)',
            borderRadius: 'var(--control-radius-lg)',
            boxShadow: 'var(--oa-shadow-sm)',
            padding: '8px 12px',
            fontSize: 'var(--text-ui-sm, 0.875rem)',
            lineHeight: '1.5rem',
            color: 'var(--oa-text, var(--foreground))',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {overlay.text}
        </div>
      )}
    </>
  );
}
