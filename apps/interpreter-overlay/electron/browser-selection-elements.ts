import type {
  BrowserControlPageElement,
  BrowserControlPageElementFrame,
  BrowserControlPageElementInventory,
} from '../../../shared/types/browserControl';
import type { OverlayContextItem, OverlayRegionContextItem, OverlaySelectionElement } from '../shared/ipc.js';
import { intersectBounds, toLocalBounds } from '../shared/scope.js';
import { buildCurrentSelectionContext, type OverlayTargetIdentity } from '../shared/target-identity.js';
import type { Bounds, DisplayInfo } from '../shared/types.js';

function browserElementLabel(element: BrowserControlPageElement): string {
  return element.name.trim()
    || element.value?.trim()
    || element.text.trim()
    || element.tagName;
}

function browserElementAbsoluteBounds(
  frame: BrowserControlPageElementFrame,
  element: BrowserControlPageElement,
): Bounds | null {
  const viewportBounds = frame.viewport.screenBounds;
  if (!viewportBounds) {
    return null;
  }
  const absoluteBounds = {
    x: viewportBounds.x + element.bounds.x,
    y: viewportBounds.y + element.bounds.y,
    width: element.bounds.width,
    height: element.bounds.height,
  };
  return intersectBounds(absoluteBounds, viewportBounds);
}

function buildBrowserPageTargetIdentity(input: {
  tabRef: string;
  chromeTabId: number;
  browserWindowId: number | null;
  browserProfilePolicyId: string;
  frame: BrowserControlPageElementFrame;
  origin: string | null;
}): Record<string, unknown> {
  return {
    kind: 'browser-page',
    browser_profile_policy_id: input.browserProfilePolicyId,
    tab_ref: input.tabRef,
    chrome_tab_id: input.chromeTabId,
    browser_window_id: input.browserWindowId,
    frame_id: input.frame.frameId,
    chrome_document_id: input.frame.chromeDocumentId,
    document_revision: input.frame.documentRevision,
    origin: input.origin,
    url: input.frame.url,
    coordinate_space: 'browser-viewport-css-px',
    ref_lifetime: 'current_document_revision',
    ref_invalidation_rules: [
      'browser_profile_mismatch',
      'browser_tab_mismatch',
      'browser_frame_mismatch',
      'browser_document_revision_mismatch',
    ],
  };
}

function boundsApproximatelyEqual(left: Bounds, right: Bounds): boolean {
  return Math.abs(left.x - right.x) < 1
    && Math.abs(left.y - right.y) < 1
    && Math.abs(left.width - right.width) < 1
    && Math.abs(left.height - right.height) < 1;
}

export function buildOverlayBrowserSelectionElements(input: {
  display: DisplayInfo;
  absoluteBounds: Bounds;
  inventory: BrowserControlPageElementInventory;
  browserWindowId?: number | null;
}): OverlaySelectionElement[] {
  const selectableElements: OverlaySelectionElement[] = [];
  for (const frame of input.inventory.frames) {
    for (const element of frame.elements) {
      const absoluteElementBounds = browserElementAbsoluteBounds(frame, element);
      if (!absoluteElementBounds || !intersectBounds(absoluteElementBounds, input.absoluteBounds)) {
        continue;
      }
      const clippedToDisplay = intersectBounds(absoluteElementBounds, input.display.boundsDIP);
      if (!clippedToDisplay) {
        continue;
      }
      selectableElements.push({
        id: element.refId,
        role: element.role,
        label: browserElementLabel(element),
        bounds: toLocalBounds(clippedToDisplay, input.display.boundsDIP),
        browser: {
          tabRef: input.inventory.tabRef,
          chromeTabId: input.inventory.chromeTabId,
          browserWindowId: input.browserWindowId ?? null,
          frameId: frame.frameId,
          chromeDocumentId: frame.chromeDocumentId,
          refId: element.refId,
          browserProfilePolicyId: input.inventory.browserProfilePolicyId,
          documentRevision: frame.documentRevision,
          origin: input.inventory.origin,
          url: frame.url,
          targetIdentity: buildBrowserPageTargetIdentity({
            tabRef: input.inventory.tabRef,
            chromeTabId: input.inventory.chromeTabId,
            browserWindowId: input.browserWindowId ?? null,
            browserProfilePolicyId: input.inventory.browserProfilePolicyId,
            frame,
            origin: input.inventory.origin,
          }),
        },
      });
    }
  }
  return selectableElements;
}

export function mergeBrowserSelectionIntoTargetContextItems(input: {
  contextItems: OverlayContextItem[];
  absoluteBounds: Bounds;
  browser: OverlayTargetIdentity['browser'];
  selectableElements: OverlaySelectionElement[];
  previewText: string | null;
}): OverlayContextItem[] {
  return input.contextItems.map((item) => {
    if (
      item.kind !== 'region'
      || item.role !== 'target'
      || !boundsApproximatelyEqual(item.bounds, input.absoluteBounds)
    ) {
      return item;
    }

    const targetIdentity = input.browser
      ? {
          ...item.targetIdentity,
          browser: input.browser,
          document: {
            id: input.browser.tabId === null ? null : String(input.browser.tabId),
            title: input.browser.title,
            url: input.browser.url,
            filePath: null,
            appSpecificId: input.browser.tabId,
          },
        }
      : item.targetIdentity;
    const updatedItem: OverlayRegionContextItem = {
      ...item,
      targetIdentity,
      previewText: input.previewText,
      selectableElements: input.selectableElements,
      snapshot: buildCurrentSelectionContext({
        targetIdentity,
        contextItemIds: item.snapshot.contextItemIds.length > 0
          ? item.snapshot.contextItemIds
          : [item.id],
        selectableRefs: input.selectableElements.map((element) => ({
          id: element.id,
          role: element.role,
          label: element.label,
          bounds: { ...element.bounds },
          nativeCua: element.nativeCua
            ? {
                app: element.nativeCua.app,
                elementIndex: element.nativeCua.elementIndex,
                targetIdentity: element.nativeCua.targetIdentity
                  ? { ...element.nativeCua.targetIdentity }
                  : undefined,
              }
            : undefined,
          browser: element.browser ? { ...element.browser } : undefined,
        })),
      }),
    };
    return updatedItem;
  });
}
