export interface RendererElementSnapshot {
  selector: string;
  present: boolean;
  text: string | null;
  rect: { x: number; y: number; width: number; height: number } | null;
  style: {
    display: string;
    visibility: string;
    opacity: string;
    pointerEvents: string;
  } | null;
}

export interface RendererDomSnapshot {
  rootChildCount: number;
  rootDescendantElements: { count: number; truncated: boolean };
  activeElementTag: string | null;
  activeElementClass: string | null;
  viewport: {
    width: number;
    height: number;
  };
  selectors: RendererElementSnapshot[];
}

export function countDescendantElements(root: HTMLElement | null, limit = 2_000): { count: number; truncated: boolean } {
  if (!root) {
    return { count: 0, truncated: false };
  }

  const nodeFilter = root.ownerDocument.defaultView?.NodeFilter;
  if (!nodeFilter) {
    throw new Error('NodeFilter unavailable');
  }

  const walker = root.ownerDocument.createTreeWalker(root, nodeFilter.SHOW_ELEMENT);
  let count = 0;
  while (walker.nextNode()) {
    count += 1;
    if (count >= limit) {
      return { count, truncated: true };
    }
  }

  return { count, truncated: false };
}

type RendererWindow = Window & typeof globalThis;

function snapshotElement(document: Document, window: RendererWindow, selector: string): RendererElementSnapshot {
  const element = document.querySelector(selector);
  const htmlElement = element instanceof window.HTMLElement ? element : null;
  if (!htmlElement) {
    return {
      selector,
      present: false,
      text: null,
      rect: null,
      style: null,
    };
  }

  const rect = htmlElement.getBoundingClientRect();
  const style = window.getComputedStyle(htmlElement);
  return {
    selector,
    present: true,
    text: htmlElement.textContent?.trim().slice(0, 160) ?? null,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    style: {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
    },
  };
}

export function getRendererDomSnapshot(document: Document, window: RendererWindow): RendererDomSnapshot {
  const root = document.getElementById('root');
  const activeElement = document.activeElement;
  const activeHtmlElement = activeElement instanceof window.HTMLElement ? activeElement : null;
  return {
    rootChildCount: root?.childElementCount ?? 0,
    rootDescendantElements: countDescendantElements(root),
    activeElementTag: activeElement?.tagName ?? null,
    activeElementClass: activeHtmlElement?.className ?? null,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    selectors: [
      '.overlay-root',
      '.scope-selection-frame',
      '.scope-selection-highlight',
      '.scope-selection-thinking-layer',
      '.scope-selection-spark',
      '.pill-container',
      '.pill-shell',
      '.pill-input-field',
      '.input-panel-field',
      '.pill-execution-status',
      '.approval-review-button',
      '.overlay-agent-marker',
      '.overlay-agent-marker-inline',
    ].map((selector) => snapshotElement(document, window, selector)),
  };
}
