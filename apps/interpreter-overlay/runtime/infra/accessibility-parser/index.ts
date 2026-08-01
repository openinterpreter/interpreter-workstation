import { spawn } from 'node:child_process';
import WsWebSocket from 'ws';
import type { SegmentedOCRResult, ScreenElement, BBox } from '../ocr-segmentation/index.js';
import { getInterpreterOverlayNativeHelperPath } from '../native-helper-paths.js';
import type { Bounds } from '../../../shared/types.js';
import { boundsIntersect } from '../../../shared/scope.js';
import {
  callWindowsUiaTool,
  makeWindowsUiaElementId,
  type WindowsUiaElementSummary,
  type WindowsUiaWindow,
  type WindowsUiaWindowState,
} from '../windows-uia.js';

const ACCESSIBILITY_PARSER_TIMEOUT_MS = process.env.FORM_TESTS_MODE === 'true' ? 60000 : 15000;
const FOCUSED_SELECTION_TIMEOUT_MS = 1200;

function getAccessibilityTreeBinaryPath(): string {
  return getInterpreterOverlayNativeHelperPath('accessibility-tree');
}

interface SwiftElement {
  id: string;
  role: string;
  name?: string;
  role_description?: string;
  description?: string;
  label?: string;
  value?: unknown;
  title?: string;
  enabled?: boolean;
  focused?: boolean;
  visible: boolean;
  position?: string;
  size?: string;
  bbox?: [number, number, number, number];
  visible_bbox?: [number, number, number, number];
  absolute_position?: string;
  children?: SwiftElement[];
}

interface SwiftOutput {
  elements: SwiftElement[];
  formatted_text: string;
}

interface SwiftSelectionOutput {
  selection_context?: {
    text?: string;
    bbox?: [number, number, number, number];
    source_kind?: string;
    source_app_name?: string;
    source_app_bundle_identifier?: string;
    source_app_pid?: number;
  } | null;
}

interface PerformSegmentedOCROptions {
  scopeBounds?: Bounds | null;
  targetPid?: number | null;
  targetWindowId?: number | string | null;
  windowsViewMode?: 'control' | 'raw' | 'interactive';
}

interface BrowserCdpPageTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface BrowserDomElement {
  id: string;
  role: string;
  label: string;
  value?: string;
  bbox: BBox;
  checked?: boolean;
  selected?: boolean;
}

interface NormalizeSwiftElementsContext {
  standaloneMenuSignatures: Set<string>;
  insideDropdown: boolean;
}

function swiftBBoxToScreenBBox(bbox: [number, number, number, number]): BBox {
  const [x1, y1, x2, y2] = bbox;
  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  };
}

function extractLabel(element: SwiftElement): string {
  const valueLabel = formatLabelValue(element.value);
  return (
    element.label ||
    element.name ||
    element.title ||
    element.description ||
    valueLabel ||
    element.role_description ||
    element.id ||
    ''
  );
}

function formatLabelValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : '';
  }

  return '';
}

function flattenSwiftElements(swiftElements: SwiftElement[]): ScreenElement[] {
  const result: ScreenElement[] = [];

  function traverse(
    element: SwiftElement,
    parentBBox?: SwiftElement['bbox'],
    parentVisibleBBox?: SwiftElement['visible_bbox'],
  ) {
    const label = extractLabel(element);
    const isCellWithContent = element.role === 'AXCell' && label.trim().length > 0;
    const shouldInclude = element.visible || isCellWithContent;

    if (!shouldInclude) {
      for (const child of element.children || []) {
        traverse(
          child,
          element.bbox || parentBBox,
          element.visible_bbox || parentVisibleBBox,
        );
      }
      return;
    }

    const bbox = element.bbox || element.visible_bbox || parentBBox || parentVisibleBBox || [0, 0, 1, 1];
    result.push({
      id: element.id,
      role: element.role,
      label,
      value: typeof element.value === 'string' ? element.value : undefined,
      focused: element.focused === true,
      bbox: swiftBBoxToScreenBBox(bbox),
    });

    for (const child of element.children || []) {
      traverse(
        child,
        element.bbox || parentBBox,
        element.visible_bbox || parentVisibleBBox,
      );
    }
  }

  for (const element of swiftElements) {
    traverse(element);
  }

  return result;
}

function normalizeComparableText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function getElementDisplayText(element: SwiftElement): string | null {
  return (
    trimOptionalString(formatLabelValue(element.value))
    || trimOptionalString(element.label)
    || trimOptionalString(element.name)
    || trimOptionalString(element.title)
    || trimOptionalString(element.description)
    || null
  );
}

function collectMenuItemTexts(element: SwiftElement): string[] {
  const texts: string[] = [];

  if (element.role === 'AXMenuItem') {
    const text = normalizeComparableText(getElementDisplayText(element));
    if (text) {
      texts.push(text);
    }
  }

  for (const child of element.children || []) {
    texts.push(...collectMenuItemTexts(child));
  }

  return texts;
}

function getMenuSignature(element: SwiftElement): string | null {
  if (element.role !== 'AXMenu') {
    return null;
  }

  const itemTexts = collectMenuItemTexts(element);
  return itemTexts.length > 0 ? itemTexts.join('\u0001') : null;
}

function collectStandaloneMenuSignatures(
  swiftElements: SwiftElement[],
  insideDropdown = false,
  signatures = new Set<string>(),
): Set<string> {
  for (const element of swiftElements) {
    const nextInsideDropdown = insideDropdown || element.role === 'AXPopUpButton';
    if (element.role === 'AXMenu' && !insideDropdown) {
      const signature = getMenuSignature(element);
      if (signature) {
        signatures.add(signature);
      }
    }

    collectStandaloneMenuSignatures(element.children || [], nextInsideDropdown, signatures);
  }

  return signatures;
}

function normalizeDropdownChildren(
  element: SwiftElement,
  children: SwiftElement[],
  standaloneMenuSignatures: Set<string>,
): SwiftElement[] {
  const dropdownValue = normalizeComparableText(getElementDisplayText(element));
  return children.filter((child) => {
    if (child.role === 'AXMenuItem') {
      const childText = normalizeComparableText(getElementDisplayText(child));
      if (dropdownValue && childText === dropdownValue) {
        return false;
      }
    }

    if (child.role === 'AXMenu') {
      const signature = getMenuSignature(child);
      if (signature && standaloneMenuSignatures.has(signature)) {
        return false;
      }
    }

    return true;
  });
}

function normalizeSwiftElement(
  element: SwiftElement,
  context: NormalizeSwiftElementsContext,
): SwiftElement {
  const childContext: NormalizeSwiftElementsContext = {
    standaloneMenuSignatures: context.standaloneMenuSignatures,
    insideDropdown: context.insideDropdown || element.role === 'AXPopUpButton',
  };

  let children = (element.children || []).map((child) => normalizeSwiftElement(child, childContext));
  if (element.role === 'AXPopUpButton') {
    children = normalizeDropdownChildren(element, children, context.standaloneMenuSignatures);
  }

  return {
    ...element,
    children: children.length > 0 ? children : undefined,
  };
}

export function normalizeSwiftElements(swiftElements: SwiftElement[]): SwiftElement[] {
  const standaloneMenuSignatures = collectStandaloneMenuSignatures(swiftElements);
  return swiftElements.map((element) => normalizeSwiftElement(element, {
    standaloneMenuSignatures,
    insideDropdown: false,
  }));
}

function trimOptionalString(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getSerializationName(element: SwiftElement, includeRoleFallback = false): string | null {
  const name = trimOptionalString(element.name);
  if (name && name.length <= 100) {
    return name;
  }

  if (includeRoleFallback) {
    const roleDescription = trimOptionalString(element.role_description);
    if (roleDescription && roleDescription.length <= 100) {
      return roleDescription;
    }
  }

  return null;
}

function escapeXML(value: string): string {
  return value
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split('\'').join('&#39;');
}

function windowsUiaRoleToAxRole(role: string): string {
  switch (role) {
    case 'button':
      return 'AXButton';
    case 'edit':
      return 'AXTextField';
    case 'comboBox':
    case 'combobox':
      return 'AXComboBox';
    case 'menuItem':
    case 'menuitem':
    case 'listItem':
    case 'listitem':
      return 'AXMenuItem';
    case 'checkBox':
    case 'checkbox':
      return 'AXCheckBox';
    case 'radioButton':
    case 'radiobutton':
      return 'AXRadioButton';
    case 'hyperlink':
      return 'AXLink';
    case 'slider':
      return 'AXSlider';
    case 'window':
      return 'AXWindow';
    case 'document':
      return 'AXWebArea';
    case 'tabItem':
    case 'tabitem':
      return 'AXButton';
    default:
      return `UIA:${role}`;
  }
}

function windowsUiaRoleToTag(role: string): string {
  switch (role) {
    case 'button':
      return 'button';
    case 'edit':
      return 'input';
    case 'comboBox':
    case 'combobox':
      return 'combobox';
    case 'menuItem':
    case 'menuitem':
      return 'menuitem';
    case 'checkBox':
    case 'checkbox':
      return 'checkbox';
    case 'radioButton':
    case 'radiobutton':
      return 'radio';
    case 'hyperlink':
      return 'link';
    case 'slider':
      return 'slider';
    default:
      return 'div';
  }
}

function windowsUiaElementLabel(element: WindowsUiaElementSummary): string {
  return (
    trimOptionalString(element.name ?? undefined)
    || trimOptionalString(element.automation_id ?? undefined)
    || trimOptionalString(element.value ?? undefined)
    || element.role
  );
}

function renderWindowsUiaElementText(
  windowId: string,
  element: WindowsUiaElementSummary,
): string {
  const tag = windowsUiaRoleToTag(element.role);
  const id = makeWindowsUiaElementId(windowId, element.element_index, element.native_handle);
  const attributes = [`id="${escapeXML(id)}"`];
  const name = trimOptionalString(element.name ?? undefined);
  if (name) {
    attributes.push(`name="${escapeXML(name)}"`);
  }
  const value = trimOptionalString(element.value ?? undefined);
  if (value && (tag === 'slider')) {
    attributes.push(`value="${escapeXML(value)}"`);
  }
  if (element.states?.includes('focused')) {
    attributes.push('focused');
    if (tag === 'input' || tag === 'combobox') {
      attributes.push('caret');
    }
  }
  if (element.states?.includes('checked')) {
    attributes.push('checked');
  }
  if (element.states?.includes('unchecked')) {
    attributes.push('unchecked');
  }
  if (element.states?.includes('selected')) {
    attributes.push('selected');
  }

  const attrString = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
  if (tag === 'input' || tag === 'combobox') {
    return `  <${tag}${attrString}>${value ? escapeXML(value) : ''}</${tag}>\n`;
  }
  const text = value || name || trimOptionalString(element.automation_id ?? undefined);
  if (!text) {
    return `  <${tag}${attrString}/>\n`;
  }
  return `  <${tag}${attrString}>${escapeXML(text)}</${tag}>\n`;
}

function scaleWindowsUiaBounds(bounds: Bounds, displayScale: number): Bounds {
  const scale = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;
  return {
    x: bounds.x / scale,
    y: bounds.y / scale,
    width: bounds.width / scale,
    height: bounds.height / scale,
  };
}

function windowsUiaBoundsToBBox(bounds: WindowsUiaElementSummary['bounds'], displayScale: number): BBox {
  const scaled = scaleWindowsUiaBounds({
    x: bounds?.x ?? 0,
    y: bounds?.y ?? 0,
    width: bounds?.width ?? 1,
    height: bounds?.height ?? 1,
  }, displayScale);
  return {
    x: scaled.x,
    y: scaled.y,
    width: scaled.width,
    height: scaled.height,
  };
}

export function windowsUiaElementIntersectsScope(
  element: WindowsUiaElementSummary,
  scopeBounds: Bounds | null | undefined,
  displayScale: number,
  windowBounds?: Bounds | null,
): boolean {
  if (!scopeBounds) {
    return true;
  }
  if (!element.bounds) {
    return false;
  }

  const screenBounds = windowsUiaBoundsToBBox(element.bounds, displayScale);
  if (boundsIntersect(screenBounds, scopeBounds)) {
    return true;
  }
  if (!windowBounds) {
    return false;
  }
  const localScope = {
    x: scopeBounds.x - windowBounds.x,
    y: scopeBounds.y - windowBounds.y,
    width: scopeBounds.width,
    height: scopeBounds.height,
  };
  return boundsIntersect(screenBounds, localScope);
}

function isInterpreterOverlayWindow(window: WindowsUiaWindow): boolean {
  const title = trimOptionalString(window.title)?.toLowerCase() ?? '';
  return title === 'interpreter overlay' || title === 'interpreter world overlay';
}

function isLikelySystemUtilityWindow(window: WindowsUiaWindow): boolean {
  const appName = trimOptionalString(window.app_name)?.toLowerCase() ?? '';
  const title = trimOptionalString(window.title)?.toLowerCase() ?? '';
  if (appName === 'prl_tools_service') {
    return true;
  }
  if (/^[a-z]:\\program files\\.*\.exe$/i.test(title)) {
    return true;
  }
  return false;
}

function windowsUiaWindowIntersectsScope(
  window: WindowsUiaWindow,
  scopeBounds: Bounds,
  displayScale: number,
): boolean {
  if (!window.bounds) {
    return false;
  }
  return boundsIntersect(scaleWindowsUiaBounds(window.bounds, displayScale), scopeBounds)
    || boundsIntersect(window.bounds, scopeBounds);
}

function windowsUiaCoordinateScaleForScope(
  bounds: Bounds | null | undefined,
  scopeBounds: Bounds | null | undefined,
  displayScale: number,
): number {
  if (!bounds || !scopeBounds) {
    return displayScale;
  }

  const scaledBounds = scaleWindowsUiaBounds(bounds, displayScale);
  if (boundsIntersect(scaledBounds, scopeBounds)) {
    return displayScale;
  }
  if (boundsIntersect(bounds, scopeBounds)) {
    return 1;
  }
  return displayScale;
}

export function windowsUiaWindowId(value: number | string | null | undefined): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Number.isInteger(value) || value === null || value === undefined || value <= 0) {
    return null;
  }
  return `hwnd-${value.toString(16)}`;
}

async function performWindowsUiaSegmentedOCR(
  displayScale: number,
  options?: PerformSegmentedOCROptions,
): Promise<SegmentedOCRResult> {
  if (options?.scopeBounds) {
    try {
      const browserResult = await performBrowserCdpSegmentedOCR(options.scopeBounds);
      if (browserResult && browserResult.elements.length > 0) {
        console.log('[AccessibilityParser] using browser CDP scoped elements', {
          count: browserResult.elements.length,
          textLength: browserResult.formattedText.length,
        });
        return browserResult;
      }
    } catch (error) {
      console.warn('[AccessibilityParser] browser CDP scoped parse failed; using Windows UIA', error);
    }
  }

  const states: Array<{ state: WindowsUiaWindowState; displayScale: number; source: string }> = [];
  const windowsViewMode = options?.windowsViewMode ?? 'interactive';
  const targetWindowId = windowsUiaWindowId(options?.targetWindowId);
  if (options?.scopeBounds && targetWindowId) {
    const state = await callWindowsUiaTool<WindowsUiaWindowState>('get_window_state', {
      window_id: targetWindowId,
      max_depth: 30,
      max_elements: 5000,
      view_mode: windowsViewMode,
    }, ACCESSIBILITY_PARSER_TIMEOUT_MS);
    const stateBounds = state.bounds
      ? { x: state.bounds.x, y: state.bounds.y, width: state.bounds.width, height: state.bounds.height }
      : null;
    states.push({
      state,
      displayScale: windowsUiaCoordinateScaleForScope(stateBounds, options.scopeBounds, displayScale),
      source: 'scope-target-window-id',
    });
  } else if (options?.scopeBounds && options?.targetPid) {
    const state = await callWindowsUiaTool<WindowsUiaWindowState>('get_window_state_for_pid', {
      pid: options.targetPid,
      max_depth: 30,
      max_elements: 5000,
      view_mode: windowsViewMode,
    }, ACCESSIBILITY_PARSER_TIMEOUT_MS);
    const stateBounds = state.bounds
      ? { x: state.bounds.x, y: state.bounds.y, width: state.bounds.width, height: state.bounds.height }
      : null;
    states.push({
      state,
      displayScale: windowsUiaCoordinateScaleForScope(stateBounds, options.scopeBounds, displayScale),
      source: 'scope-target-window',
    });
  } else if (options?.scopeBounds) {
    const targetWindows = (await callWindowsUiaTool<WindowsUiaWindow[]>('list_windows', {}, ACCESSIBILITY_PARSER_TIMEOUT_MS))
      .filter((window) => !isInterpreterOverlayWindow(window))
      .filter((window) => !isLikelySystemUtilityWindow(window))
      .filter((window) => windowsUiaWindowIntersectsScope(window, options.scopeBounds!, displayScale))
      .slice(0, 3);
    for (const window of targetWindows) {
      const windowBounds = window.bounds
        ? { x: window.bounds.x, y: window.bounds.y, width: window.bounds.width, height: window.bounds.height }
        : null;
      const windowCoordinateScale = windowsUiaCoordinateScaleForScope(windowBounds, options.scopeBounds, displayScale);
      const state = await callWindowsUiaTool<WindowsUiaWindowState>('get_window_state', {
        window_id: window.window_id,
        max_depth: 30,
        max_elements: 5000,
        view_mode: windowsViewMode,
      }, ACCESSIBILITY_PARSER_TIMEOUT_MS);
      states.push({ state, displayScale: windowCoordinateScale, source: 'scope-window-intersection' });
    }
  } else {
    const targetWindows = (await callWindowsUiaTool<WindowsUiaWindow[]>('list_windows', {}, ACCESSIBILITY_PARSER_TIMEOUT_MS))
      .filter((window) => !isInterpreterOverlayWindow(window))
      .filter((window) => !isLikelySystemUtilityWindow(window))
      .slice(0, 1);
    for (const window of targetWindows) {
      const state = await callWindowsUiaTool<WindowsUiaWindowState>('get_window_state', {
        window_id: window.window_id,
        max_depth: 30,
        max_elements: 5000,
        view_mode: windowsViewMode,
      }, 60_000);
      states.push({ state, displayScale, source: 'list-windows' });
    }
  }

  const elements: ScreenElement[] = [];
  const formattedParts: string[] = [];
  for (const entry of states) {
    const { state } = entry;
    const windowName = trimOptionalString(state.title) || trimOptionalString(state.app) || 'Window';
    const windowBounds = state.bounds
      ? scaleWindowsUiaBounds(state.bounds, entry.displayScale)
      : undefined;
    const scopedElements = state.elements.filter((element) => (
      windowsUiaElementIntersectsScope(element, options?.scopeBounds, entry.displayScale, windowBounds ?? null)
    ));
    if (options?.scopeBounds && scopedElements.length === 0) {
      console.log('[AccessibilityParser] scoped Windows UIA state had no elements', {
        source: entry.source,
        windowName,
        windowBounds,
        scopeBounds: options.scopeBounds,
      });
      continue;
    }

    formattedParts.push(`<window name="${escapeXML(windowName)}">\n`);
    for (const element of scopedElements) {
      const id = makeWindowsUiaElementId(state.window_id, element.element_index, element.native_handle);
      elements.push({
        id,
        role: windowsUiaRoleToAxRole(element.role),
        label: windowsUiaElementLabel(element),
        value: typeof element.value === 'string' ? element.value : undefined,
        focused: element.states?.includes('focused') === true,
        bbox: windowsUiaBoundsToBBox(element.bounds, entry.displayScale),
        windowBounds,
      });
      formattedParts.push(renderWindowsUiaElementText(state.window_id, element));
    }
    formattedParts.push('</window>\n');
  }

  return {
    formattedText: formattedParts.join(''),
    elements,
  };
}

async function sendBrowserCdpCommand(
  ws: any,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 5000,
): Promise<any> {
  const id = Math.floor(Math.random() * 1_000_000_000);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMessage);
      reject(new Error(`CDP ${method} timed out`));
    }, timeoutMs);
    const onMessage = (raw: unknown) => {
      const message = JSON.parse(String(raw));
      if (message.id !== id) {
        return;
      }
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)));
        return;
      }
      resolve(message.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function withBrowserCdpPage<T>(callback: (ws: any, page: BrowserCdpPageTarget) => Promise<T>): Promise<T | null> {
  const portText = process.env.INTERPRETER_OVERLAY_BROWSER_CDP_PORT;
  const port = portText ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }

  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`Browser CDP target list failed: ${response.status}`);
  }
  const pages = await response.json() as BrowserCdpPageTarget[];
  const preferredUrlNeedle = process.env.INTERPRETER_OVERLAY_BROWSER_CDP_TARGET_URL_CONTAINS;
  const availablePages = pages.filter((candidate) => (
    candidate.type === 'page'
    && candidate.webSocketDebuggerUrl
    && !String(candidate.url ?? '').startsWith('devtools://')
  ));
  const page = (
    preferredUrlNeedle
      ? availablePages.find((candidate) => String(candidate.url ?? '').includes(preferredUrlNeedle))
      : null
  ) ?? availablePages[0];
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`No browser CDP page target available on port ${port}.`);
  }

  const ws = new WsWebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  try {
    return await callback(ws, page);
  } finally {
    ws.close();
  }
}

function browserDomRoleToTag(role: string): string {
  switch (role) {
    case 'AXTextField':
    case 'AXTextArea':
    case 'AXSearchField':
    case 'AXDateField':
    case 'AXTimeField':
      return 'input';
    case 'AXCheckBox':
      return 'checkbox';
    case 'AXRadioButton':
      return 'radio';
    case 'AXPopUpButton':
    case 'AXComboBox':
      return 'combobox';
    case 'AXButton':
      return 'button';
    case 'AXLink':
      return 'link';
    default:
      return 'div';
  }
}

function renderBrowserDomElementText(element: BrowserDomElement): string {
  const tag = browserDomRoleToTag(element.role);
  const attributes = [`id="${escapeXML(element.id)}"`];
  if (element.label) {
    attributes.push(`name="${escapeXML(element.label)}"`);
  }
  if (element.checked) {
    attributes.push('checked');
  }
  if (element.selected) {
    attributes.push('selected');
  }
  const attrString = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
  const value = trimOptionalString(element.value);
  if (tag === 'input' || tag === 'combobox') {
    return `  <${tag}${attrString}>${value ? escapeXML(value) : ''}</${tag}>\n`;
  }
  const text = value || element.label;
  if (!text) {
    return `  <${tag}${attrString}/>\n`;
  }
  return `  <${tag}${attrString}>${escapeXML(text)}</${tag}>\n`;
}

async function performBrowserCdpSegmentedOCR(scopeBounds: Bounds): Promise<SegmentedOCRResult | null> {
  return await withBrowserCdpPage<SegmentedOCRResult | null>(async (ws, page) => {
    await sendBrowserCdpCommand(ws, 'Page.bringToFront', {}, 5000);
    const result = await sendBrowserCdpCommand(ws, 'Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const absolute = ${JSON.stringify({
          x: scopeBounds.x,
          y: scopeBounds.y,
          width: scopeBounds.width,
          height: scopeBounds.height,
        })};
        const chromeX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
        const chromeTop = Math.max(0, (window.outerHeight - window.innerHeight) - chromeX);
        const viewport = {
          left: absolute.x - window.screenX - chromeX,
          top: absolute.y - window.screenY - chromeTop,
          right: absolute.x - window.screenX - chromeX + absolute.width,
          bottom: absolute.y - window.screenY - chromeTop + absolute.height,
        };
        const intersects = (rect) => (
          rect.width > 0
          && rect.height > 0
          && rect.right >= viewport.left
          && rect.left <= viewport.right
          && rect.bottom >= viewport.top
          && rect.top <= viewport.bottom
        );
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') <= 0) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const textOf = (node) => String(node?.textContent || '').replace(/\\s+/g, ' ').trim();
        const explicitLabel = (element) => {
          const ariaLabel = element.getAttribute('aria-label');
          if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
          const labelledBy = element.getAttribute('aria-labelledby');
          if (labelledBy) {
            const text = labelledBy.split(/\\s+/).map((id) => textOf(document.getElementById(id))).filter(Boolean).join(' ');
            if (text.trim()) return text.trim();
          }
          if (element.id) {
            const labels = Array.from(document.querySelectorAll('label[for]')).filter((label) => label.getAttribute('for') === element.id);
            const text = labels.map(textOf).filter(Boolean).join(' ');
            if (text.trim()) return text.trim();
          }
          if ('labels' in element && element.labels && element.labels.length > 0) {
            const text = Array.from(element.labels).map(textOf).filter(Boolean).join(' ');
            if (text.trim()) return text.trim();
          }
          const placeholder = element.getAttribute('placeholder');
          if (placeholder && placeholder.trim()) return placeholder.trim();
          const title = element.getAttribute('title');
          if (title && title.trim()) return title.trim();
          const name = element.getAttribute('name');
          if (name && name.trim()) return name.trim();
          return '';
        };
        const roleOf = (element) => {
          const role = (element.getAttribute('role') || '').toLowerCase();
          if (element instanceof HTMLTextAreaElement) return 'AXTextArea';
          if (element instanceof HTMLSelectElement) return 'AXPopUpButton';
          if (element instanceof HTMLButtonElement) return 'AXButton';
          if (element instanceof HTMLAnchorElement && element.href) return 'AXLink';
          if (element instanceof HTMLInputElement) {
            const type = element.type.toLowerCase();
            if (type === 'checkbox') return 'AXCheckBox';
            if (type === 'radio') return 'AXRadioButton';
            if (type === 'button' || type === 'submit' || type === 'reset') return 'AXButton';
            if (type === 'search') return 'AXSearchField';
            if (type === 'date') return 'AXDateField';
            if (type === 'time') return 'AXTimeField';
            return 'AXTextField';
          }
          if (role === 'button') return 'AXButton';
          if (role === 'checkbox') return 'AXCheckBox';
          if (role === 'radio') return 'AXRadioButton';
          if (role === 'combobox' || role === 'listbox') return 'AXComboBox';
          if (role === 'link') return 'AXLink';
          if (element.isContentEditable) return 'AXTextArea';
          return '';
        };
        const valueOf = (element) => {
          if (element instanceof HTMLSelectElement) return element.selectedOptions[0]?.textContent?.trim() || element.value || '';
          if (element instanceof HTMLInputElement) {
            const type = element.type.toLowerCase();
            if (type === 'checkbox' || type === 'radio') return element.checked ? 'checked' : '';
            if (type === 'button' || type === 'submit' || type === 'reset') return element.value || textOf(element);
            return element.value || '';
          }
          if (element instanceof HTMLTextAreaElement) return element.value || '';
          if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement) return textOf(element);
          if (element.isContentEditable) return textOf(element);
          return textOf(element);
        };
        const selectors = [
          'input',
          'textarea',
          'select',
          'button',
          'a[href]',
          '[contenteditable="true"]',
          '[role="button"]',
          '[role="checkbox"]',
          '[role="radio"]',
          '[role="combobox"]',
          '[role="listbox"]',
          '[role="link"]'
        ].join(',');
        const elements = [];
        const seen = new Set();
        for (const element of Array.from(document.querySelectorAll(selectors)).slice(0, 2000)) {
          if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
          const rect = element.getBoundingClientRect();
          if (!intersects(rect)) continue;
          const role = roleOf(element);
          if (!role) continue;
          const label = explicitLabel(element) || valueOf(element);
          const value = valueOf(element);
          if (!label && !value) continue;
          const key = [role, Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height), label, value].join(':');
          if (seen.has(key)) continue;
          seen.add(key);
          const idBase = element.id || element.getAttribute('name') || element.getAttribute('data-field-id') || element.getAttribute('aria-label') || role;
          const idSlug = String(idBase).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'element';
          elements.push({
            id: 'browserdom:' + elements.length + ':' + idSlug,
            role,
            label,
            value,
            checked: element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio') ? element.checked : false,
            selected: element instanceof HTMLOptionElement ? element.selected : false,
            bbox: {
              x: window.screenX + chromeX + rect.left,
              y: window.screenY + chromeTop + rect.top,
              width: rect.width,
              height: rect.height
            }
          });
        }
        elements.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
        return {
          url: window.location.href,
          title: document.title,
          elements,
          viewport,
          screen: { x: window.screenX, y: window.screenY, chromeX, chromeTop }
        };
      })()`,
    }, 2500);
    const value = result?.result?.value as {
      elements?: BrowserDomElement[];
      url?: string;
      title?: string;
    } | undefined;
    const elements = Array.isArray(value?.elements)
      ? value.elements.filter((element): element is BrowserDomElement => (
          element
          && typeof element.id === 'string'
          && typeof element.role === 'string'
          && typeof element.label === 'string'
          && element.bbox
          && Number.isFinite(element.bbox.x)
          && Number.isFinite(element.bbox.y)
          && Number.isFinite(element.bbox.width)
          && Number.isFinite(element.bbox.height)
        ))
      : [];
    if (elements.length === 0) {
      return null;
    }
    const formattedText = [
      `<window title="${escapeXML(value?.title || page.url || 'Browser')}" source="browser-cdp">`,
      ...elements.map(renderBrowserDomElementText).map((line) => line.trimEnd()),
      '</window>',
      '',
    ].join('\n');
    return { formattedText, elements };
  });
}

function formatTextValue(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? escapeXML(trimmed) : '';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : '';
  }

  return '';
}

function isCheckedValue(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }

  return false;
}

function effectiveSwiftBBox(
  element: SwiftElement,
  parentBBox?: SwiftElement['bbox'],
  parentVisibleBBox?: SwiftElement['visible_bbox'],
): SwiftElement['bbox'] {
  return element.bbox || element.visible_bbox || parentBBox || parentVisibleBBox;
}

function filterSwiftElementsByScope(
  swiftElements: SwiftElement[],
  scopeBounds: Bounds,
  parentBBox?: SwiftElement['bbox'],
  parentVisibleBBox?: SwiftElement['visible_bbox'],
): SwiftElement[] {
  const result: SwiftElement[] = [];

  for (const element of swiftElements) {
    const children = filterSwiftElementsByScope(
      element.children || [],
      scopeBounds,
      element.bbox || parentBBox,
      element.visible_bbox || parentVisibleBBox,
    );
    const label = extractLabel(element);
    const isCellWithContent = element.role === 'AXCell' && label.trim().length > 0;
    const shouldIncludeSelf = element.visible || isCellWithContent;
    const bbox = effectiveSwiftBBox(element, parentBBox, parentVisibleBBox);
    const intersectsScope = bbox ? boundsIntersect(swiftBBoxToScreenBBox(bbox), scopeBounds) : false;

    if (shouldIncludeSelf && (intersectsScope || children.length > 0)) {
      result.push({
        ...element,
        children: children.length > 0 ? children : undefined,
      });
      continue;
    }

    if (children.length > 0) {
      if (element.visible) {
        result.push({
          ...element,
          children,
        });
      } else {
        result.push(...children);
      }
    }
  }

  return result;
}

function renderCompactText(
  element: SwiftElement,
  indent = 0,
  parentTag = '',
): string {
  if (
    element.role === 'AXIncrementor'
    || element.role === 'AXScrollBar'
    || element.role === 'AXValueIndicator'
  ) {
    return '';
  }

  const indentStr = '  '.repeat(indent);
  const children = element.children || [];
  const visibleChildren = children.filter((child) => child.visible || (child.children?.length ?? 0) > 0);

  if ((element.role === 'AXGroup' || element.role === 'AXScrollArea') && visibleChildren.length === 1) {
    const [child] = visibleChildren;
    const hasUsefulInfo = Boolean(trimOptionalString(element.name) || trimOptionalString(element.description));
    if ((child.role === 'AXGroup' || child.role === 'AXScrollArea') && !hasUsefulInfo) {
      return renderCompactText(child, indent, parentTag);
    }
  }

  let tag = 'div';
  let isInteractive = false;
  switch (element.role) {
    case 'AXButton':
      tag = 'button';
      isInteractive = true;
      break;
    case 'AXTextField':
    case 'AXTextArea':
    case 'AXSearchField':
    case 'AXSecureTextField':
      tag = 'input';
      isInteractive = true;
      break;
    case 'AXPopUpButton':
      tag = 'dropdown';
      isInteractive = true;
      break;
    case 'AXComboBox':
      tag = 'combobox';
      isInteractive = true;
      break;
    case 'AXStaticText':
      tag = 'text';
      break;
    case 'AXMenu':
    case 'AXMenuBar':
      tag = 'menu';
      break;
    case 'AXMenuItem':
      tag = 'menuitem';
      isInteractive = true;
      break;
    case 'AXMenuBarItem':
    case 'AXMenuButton':
      tag = 'menubutton';
      isInteractive = true;
      break;
    case 'AXCheckBox':
      tag = 'checkbox';
      isInteractive = true;
      break;
    case 'AXRadioButton':
      tag = 'radio';
      isInteractive = true;
      break;
    case 'AXLink':
      tag = 'link';
      isInteractive = true;
      break;
    case 'AXSlider':
      tag = 'slider';
      isInteractive = true;
      break;
    case 'AXProgressIndicator':
      tag = 'progress';
      break;
    case 'AXDateField':
      tag = 'date';
      isInteractive = true;
      break;
    case 'AXTimeField':
      tag = 'time';
      isInteractive = true;
      break;
    case 'AXTable':
      tag = 'table';
      break;
    case 'AXRow':
      tag = 'tr';
      break;
    case 'AXCell':
      tag = 'td';
      break;
    case 'AXWindow':
      tag = 'window';
      break;
    case 'AXWebArea':
      tag = 'webarea';
      break;
    case 'AXHeading': {
      const level = typeof element.value === 'number' && element.value >= 1 && element.value <= 6
        ? Math.trunc(element.value)
        : null;
      tag = level ? `h${level}` : 'h';
      break;
    }
    default:
      tag = 'div';
  }

  const isHeading = tag.startsWith('h');
  const attributes: string[] = [];
  if (isInteractive) {
    attributes.push(`id="${escapeXML(element.id)}"`);
  }

  if (!isHeading) {
    const serializationName = getSerializationName(element, isInteractive);
    if (serializationName) {
      attributes.push(`name="${escapeXML(serializationName)}"`);
    }
  }

  const description = trimOptionalString(element.description);
  if (description) {
    attributes.push(`alt="${escapeXML(description)}"`);
  }

  if ((tag === 'slider' || tag === 'progress') && (typeof element.value === 'number' || typeof element.value === 'string')) {
    const numericValue = formatTextValue(element.value);
    if (numericValue) {
      attributes.push(`value="${numericValue}"`);
    }
  }

  if ((tag === 'radio' || tag === 'checkbox') && isCheckedValue(element.value)) {
    attributes.push('checked');
  }

  if (element.focused === true) {
    attributes.push('focused');
    if (tag === 'input' || tag === 'combobox' || tag === 'date' || tag === 'time') {
      attributes.push('caret');
    }
  }

  const attrString = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';

  let textContent = '';
  if (isHeading) {
    const name = trimOptionalString(element.name);
    if (name) {
      textContent = escapeXML(name);
    }
  } else if (!['slider', 'progress', 'radio', 'checkbox'].includes(tag)) {
    textContent = formatTextValue(element.value);
  }

  if ((element.role === 'AXGroup' || element.role === 'AXScrollArea') && !textContent) {
    const name = trimOptionalString(element.name);
    if (name && name.length > 100) {
      textContent = escapeXML(name);
    }
  }

  if (tag === 'div' && visibleChildren.length === 0 && !textContent) {
    const hasUsefulAttrs = attributes.some((attribute) => !attribute.startsWith('id="'));
    if (!hasUsefulAttrs) {
      return '';
    }
  }

  if (tag === 'date' || tag === 'time') {
    return `${indentStr}<${tag}${attrString}/>\n`;
  }

  if (isHeading) {
    return `${indentStr}<${tag}>${textContent}</${tag}>\n`;
  }

  if (['radio', 'checkbox', 'button', 'slider', 'progress'].includes(tag)) {
    if (!textContent) {
      return `${indentStr}<${tag}${attrString}/>\n`;
    }
    return `${indentStr}<${tag}${attrString}>${textContent}</${tag}>\n`;
  }

  if (visibleChildren.length === 0 && !textContent) {
    return `${indentStr}<${tag}${attrString}/>\n`;
  }

  if (visibleChildren.length === 0) {
    return `${indentStr}<${tag}${attrString}>${textContent}</${tag}>\n`;
  }

  let output = `${indentStr}<${tag}${attrString}>\n`;
  if (textContent) {
    output += `${indentStr}  ${textContent}\n`;
  }

  for (const child of visibleChildren) {
    output += renderCompactText(child, indent + 1, tag);
  }

  output += `${indentStr}</${tag}>\n`;
  return output;
}

export async function performSegmentedOCR(
  imageBuffer: Buffer,
  displayScale = 1.0,
  options?: PerformSegmentedOCROptions,
): Promise<SegmentedOCRResult> {
  void imageBuffer;
  if (process.platform === 'win32') {
    return performWindowsUiaSegmentedOCR(displayScale, options);
  }

  const logParserStderr = process.env.INTERPRETER_OVERLAY_AX_LOG === '1';
  const child = spawn(getAccessibilityTreeBinaryPath(), [], {
    env: {
      ...process.env,
      INTERPRETER_OVERLAY_EXCLUDED_PID: String(process.pid),
      ...(options?.scopeBounds
        ? {
            INTERPRETER_OVERLAY_SCOPE_BOUNDS: [
              options.scopeBounds.x,
              options.scopeBounds.y,
              options.scopeBounds.width,
              options.scopeBounds.height,
            ].join(','),
          }
        : {}),
      ...(options?.targetPid
        ? {
            INTERPRETER_OVERLAY_TARGET_PID: String(options.targetPid),
          }
        : {}),
    },
    stdio: ['ignore', 'pipe', logParserStderr ? 'pipe' : 'ignore'],
  });

  let stdout = '';
  let stderr = '';

  if (!child.stdout) {
    throw new Error('Accessibility parser stdout pipe was not created.');
  }

  child.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  child.stderr?.on('data', (data) => {
    stderr += data.toString();
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout after ${ACCESSIBILITY_PARSER_TIMEOUT_MS / 1000} seconds`));
    }, ACCESSIBILITY_PARSER_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`Accessibility parser exited with code ${exitCode}`);
  }

  if (stderr) {
    const debugLines = stderr.split('\n').filter((line) => line.trim());
    for (const line of debugLines) {
      console.log(`[Accessibility Parser] ${line}`);
    }
  }

  const swiftOutput: SwiftOutput = JSON.parse(stdout);
  const normalizedElements = normalizeSwiftElements(swiftOutput.elements);
  const scopedElements = options?.scopeBounds
    ? filterSwiftElementsByScope(normalizedElements, options.scopeBounds)
    : normalizedElements;

  return {
    formattedText: scopedElements.map((element) => renderCompactText(element)).join(''),
    elements: flattenSwiftElements(scopedElements),
  };
}

export interface FocusedSelectionContext {
  text: string | null;
  bounds: Bounds | null;
  sourceKind: 'selected_text' | 'selected_children' | 'focused_element' | 'unknown';
  sourceAppName: string | null;
  sourceAppBundleIdentifier: string | null;
  sourceAppPid: number | null;
}

export async function getFocusedSelectionContext(): Promise<FocusedSelectionContext | null> {
  const logParserStderr = process.env.INTERPRETER_OVERLAY_AX_LOG === '1';
  const child = spawn(getAccessibilityTreeBinaryPath(), [], {
    env: {
      ...process.env,
      INTERPRETER_OVERLAY_EXCLUDED_PID: String(process.pid),
      INTERPRETER_OVERLAY_SELECTION_ONLY: '1',
    },
    stdio: ['ignore', 'pipe', logParserStderr ? 'pipe' : 'ignore'],
  });

  let stdout = '';
  let stderr = '';

  if (!child.stdout) {
    throw new Error('Accessibility parser selection stdout pipe was not created.');
  }

  child.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  child.stderr?.on('data', (data) => {
    stderr += data.toString();
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout after ${FOCUSED_SELECTION_TIMEOUT_MS / 1000} seconds`));
    }, FOCUSED_SELECTION_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`Accessibility parser selection query exited with code ${exitCode}`);
  }

  if (stderr) {
    const debugLines = stderr.split('\n').filter((line) => line.trim());
    for (const line of debugLines) {
      console.log(`[Accessibility Parser][selection] ${line}`);
    }
  }

  const swiftOutput: SwiftSelectionOutput = JSON.parse(stdout);
  const selection = swiftOutput.selection_context;
  if (!selection) {
    return null;
  }

  const text = typeof selection.text === 'string'
    ? selection.text.trim() || null
    : null;
  const bounds = Array.isArray(selection.bbox)
    ? swiftBBoxToScreenBBox(selection.bbox)
    : null;

  if (!text && !bounds) {
    return null;
  }

  return {
    text,
    bounds,
    sourceKind: selection.source_kind === 'selected_text'
      || selection.source_kind === 'selected_children'
      || selection.source_kind === 'focused_element'
      ? selection.source_kind
      : 'unknown',
    sourceAppName: typeof selection.source_app_name === 'string'
      ? selection.source_app_name
      : null,
    sourceAppBundleIdentifier: typeof selection.source_app_bundle_identifier === 'string'
      ? selection.source_app_bundle_identifier
      : null,
    sourceAppPid: typeof selection.source_app_pid === 'number'
      ? selection.source_app_pid
      : null,
  };
}

export type { SegmentedOCRResult, ScreenElement, BBox } from '../ocr-segmentation/index.js';
