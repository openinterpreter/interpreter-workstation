import { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import * as pdfjsLib from 'pdfjs-dist';
import { AnnotationMode } from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';
import { PDF_VIEWER_ID, PDF_ADD_ANNOTATION_BUTTON_ID, PDF_SAVE_BUTTON_ID } from '../../shared/element-ids';
import { AnnotationToolbar } from './AnnotationToolbar';
import { Button } from './ui/button';
import { getFileUrl, getApiUrl, pdf, pathBasename, isAbsolutePath, openExternal } from '@/ipc';
import { openFeedbackPopover } from '../utils/feedback';
import { useFileRefresh } from '../hooks/useFileRefresh';
import { tokenizeForTyping, valuesEqual } from '../utils/pdfFormFieldAnimation';
import {
  DEFAULT_IMAGE_ANNOTATION_HEIGHT,
  DEFAULT_IMAGE_ANNOTATION_WIDTH,
  clampImageAnnotationDimension,
  getInitialImageAnnotationSize,
} from '../utils/pdfImageAnnotationSizing';
import {
  reconcileSavedAnnotationState,
} from '../utils/pdfAnnotationIdRemap';
import { isWorkstationReadOnly } from '../remote/workstationConnection';

// Configure PDF.js worker using Vite-compatible URL resolution
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
}


interface PDFViewerProps {
  filePath: string;
  initialPage?: number;
}

interface FormField {
  id?: string;
  index: number;
  name: string;
  type: string;
  value: any;
  page: number;
  element?: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}

type FormFieldMetadata = {
  id?: string;
  fieldName: string;
  index?: number;
  page?: number;
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

interface LocalAnnotation {
  id: string;              // "a0", "a1" or "local-{timestamp}" for new
  page: number;
  x: number;               // Top-left origin (points)
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  color: { r: number; g: number; b: number };
  isDirty: boolean;
  originalId?: string;     // For tracking updates (remove old + add new)
  // Image annotation fields
  annotationType?: string; // "FreeText", "Stamp", etc.
  imagePath?: string;      // Path to image file (for Stamp/image annotations)
  imageDataUrl?: string;   // Base64 data URL for rendering (loaded from imagePath)
}

const LOADING_DELAY_MS = 150;
const SAVE_DEBOUNCE_MS = 1500;
const MIN_TEXT_ANNOTATION_WIDTH = 80;
const MIN_TEXT_ANNOTATION_HEIGHT = 20;
const RESIZE_HANDLE_SIZE_PX = 12;
// Token typing and field stagger: random delay in this range per cycle.
const FORM_TYPING_MIN_DELAY_MS = 30;
const FORM_TYPING_MAX_DELAY_MS = 100;
// How long all red-deleted values are shown before clearing.
const FORM_TYPING_DELETION_DISPLAY_MS = 400;

async function removePdfAnnotations(filePath: string, annotationIds: string[]): Promise<void> {
  const removeUrl = await getApiUrl('/api/pdf/annotations/remove');
  const response = await fetch(removeUrl, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, annotationIds }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `PDF annotation removal failed (${response.status})`);
  }
}


/**
 * Check if an annotation is an image annotation
 */
function isImageAnnotation(annotation: LocalAnnotation): boolean {
  return annotation.annotationType === 'Stamp' && !!annotation.imagePath;
}

/**
 * Editable annotations are app-managed FreeText plus image-backed Stamp.
 * Native PDF annotation types (Link, Highlight, Popup, etc.) are rendered
 * by PDF.js and must not enter the editable overlay/save pipeline.
 */
function isEditableAnnotation(annotation: LocalAnnotation): boolean {
  return annotation.annotationType === 'FreeText' || isImageAnnotation(annotation);
}

function clampTextAnnotationWidth(value: number): number {
  return Math.max(MIN_TEXT_ANNOTATION_WIDTH, value);
}

function clampTextAnnotationHeight(value: number): number {
  return Math.max(MIN_TEXT_ANNOTATION_HEIGHT, value);
}

function matchesSavedLocalAnnotation(liveAnnotation: LocalAnnotation, savedAnnotation: LocalAnnotation): boolean {
  return liveAnnotation.id === savedAnnotation.id
    && liveAnnotation.originalId === savedAnnotation.originalId
    && liveAnnotation.isDirty === savedAnnotation.isDirty
    && liveAnnotation.page === savedAnnotation.page
    && liveAnnotation.x === savedAnnotation.x
    && liveAnnotation.y === savedAnnotation.y
    && liveAnnotation.width === savedAnnotation.width
    && liveAnnotation.height === savedAnnotation.height
    && liveAnnotation.text === savedAnnotation.text
    && liveAnnotation.fontSize === savedAnnotation.fontSize
    && liveAnnotation.color.r === savedAnnotation.color.r
    && liveAnnotation.color.g === savedAnnotation.color.g
    && liveAnnotation.color.b === savedAnnotation.color.b
    && liveAnnotation.annotationType === savedAnnotation.annotationType
    && liveAnnotation.imagePath === savedAnnotation.imagePath;
}

/**
 * Parse a raw annotation element from the PDF structure into a LocalAnnotation
 */
function parseAnnotationElement(el: any): LocalAnnotation {
  const contents = el.contents || '';
  const annotationType = el.annotationType || 'FreeText';

  // Parse image path from Stamp annotations with "Image: path" contents
  let imagePath: string | undefined;
  if (annotationType === 'Stamp' && contents.startsWith('Image: ')) {
    imagePath = contents.substring(7); // Remove "Image: " prefix
  }

  return {
    id: el.id,
    page: el.page,
    x: el.bbox.x,
    y: el.bbox.y,
    width: el.bbox.width,
    height: el.bbox.height,
    text: imagePath ? '' : contents, // Clear text for image annotations
    fontSize: el.fontSize ?? 12,
    color: el.color ?? { r: 0, g: 0, b: 0 },
    isDirty: false,
    originalId: el.id,
    annotationType,
    imagePath
  };
}

function parseEditableAnnotations(elements: any[]): LocalAnnotation[] {
  return elements
    .filter((el: any) => el.type === 'annotation')
    .map(parseAnnotationElement)
    .filter(isEditableAnnotation);
}

export function PDFViewer({ filePath, initialPage }: PDFViewerProps) {
  const readOnlyRemote = isWorkstationReadOnly();
  "use no memo";

  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const currentPageRef = useRef(1);
  const [scale, setScale] = useState(1.0);
  const baseScaleRef = useRef<number>(1.0); // Computed fit-to-container scale (= "100%")
  const baseScaleComputedRef = useRef(false); // Whether we've computed the initial fit scale
  const pdfPageDimensionsRef = useRef<{ width: number; height: number } | null>(null);
  const renderGenRef = useRef(0); // Generation counter to prevent stale async renders
  const lastSelfWriteRef = useRef(0);

  // Annotation state
  const [annotations, setAnnotations] = useState<LocalAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [toolbarPosition, setToolbarPosition] = useState<{ x: number; y: number } | null>(null);
  const [flashAnnotationIds, setFlashAnnotationIds] = useState<Set<string>>(new Set()); // IDs of annotations to flash (new or updated by agent)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'unsaved' | 'saving' | 'saved'>('idle');
  const [layersReady, setLayersReady] = useState(0); // Counter to trigger re-render when layers are created
  const editingAnnotationIdRef = useRef<string | null>(null); // Track annotation being edited (to skip re-render)

  // Multi-selection state (marquee selection)
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<Set<string>>(new Set());
  const [, setSelectedFormFieldNames] = useState<Set<string>>(new Set());
  const [selectedTextSpans, setSelectedTextSpans] = useState<Set<HTMLSpanElement>>(new Set());
  const [isMarqueeActive, setIsMarqueeActive] = useState(false);
  const [marqueeStart, setMarqueeStart] = useState<{ x: number; y: number; pageNum: number } | null>(null);
  const [marqueeEnd, setMarqueeEnd] = useState<{ x: number; y: number } | null>(null);
  const saveStatusTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const pageContainerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const formFieldsRef = useRef<Map<string, FormField>>(new Map());
  const formFieldMetadataRef = useRef<FormFieldMetadata[]>([]);
  const allFormFieldsRef = useRef<FormField[]>([]);
  const loadingTimerRef = useRef<number | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const formFieldSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const dirtyFormFieldsRef = useRef<Map<string, any>>(new Map()); // Track dirty form fields
  const annotationLayersRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const isInitialLoadRef = useRef(true); // Track if this is the first annotation load
  const previousAnnotationIdsRef = useRef<Set<string>>(new Set()); // Track previous annotation IDs
  const saveAnnotationsRef = useRef<() => Promise<void>>(() => Promise.resolve()); // Ref to latest save function
  const annotationsRef = useRef<LocalAnnotation[]>([]);
  const selectedAnnotationIdRef = useRef<string | null>(null);
  const selectedAnnotationIdsRef = useRef<Set<string>>(new Set()); // Ref for multi-move drag handler access
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const annotationBlinkTimeoutsRef = useRef<Set<number>>(new Set());
  const formFieldTypingRef = useRef<{ runId: number; timeouts: number[] }>({ runId: 0, timeouts: [] });
  // Persistent snapshot of form field values that survives across render generations.
  // Prevents data loss when rapid resizes cause overlapping async renders.
  const formFieldValueSnapshotRef = useRef<Map<string, any>>(new Map());

  const cacheFormFieldMetadata = useCallback((elements: any[]) => {
    const metadata: FormFieldMetadata[] = [];
    for (const element of elements) {
      if (element?.type !== 'formField' || typeof element.fieldName !== 'string') {
        continue;
      }
      const bbox = element.bbox
        && typeof element.bbox.x === 'number'
        && typeof element.bbox.y === 'number'
        && typeof element.bbox.width === 'number'
        && typeof element.bbox.height === 'number'
        ? {
            x: element.bbox.x,
            y: element.bbox.y,
            width: element.bbox.width,
            height: element.bbox.height,
          }
        : undefined;
      metadata.push({
        id: typeof element.id === 'string' ? element.id : undefined,
        fieldName: element.fieldName,
        index: typeof element.fieldIndex === 'number' ? element.fieldIndex : undefined,
        page: typeof element.page === 'number' ? element.page : undefined,
        bbox,
      });
    }
    formFieldMetadataRef.current = metadata;
  }, []);

  const findFormFieldMetadata = useCallback((params: {
    fieldName: string;
    page: number;
    rect?: number[];
  }): FormFieldMetadata | undefined => {
    const candidates = formFieldMetadataRef.current.filter((metadata) => (
      metadata.fieldName === params.fieldName
      && (metadata.page === undefined || metadata.page === params.page)
    ));
    if (candidates.length <= 1 || !Array.isArray(params.rect) || params.rect.length < 4) {
      return candidates[0];
    }

    const left = Math.min(params.rect[0] ?? 0, params.rect[2] ?? 0);
    const top = Math.min(params.rect[1] ?? 0, params.rect[3] ?? 0);
    const width = Math.abs((params.rect[2] ?? 0) - (params.rect[0] ?? 0));
    const height = Math.abs((params.rect[3] ?? 0) - (params.rect[1] ?? 0));
    const centerX = left + width / 2;
    const centerY = top + height / 2;

    return [...candidates].sort((a, b) => {
      const score = (metadata: FormFieldMetadata): number => {
        if (!metadata.bbox) return Number.POSITIVE_INFINITY;
        const metadataCenterX = metadata.bbox.x + metadata.bbox.width / 2;
        const metadataCenterY = metadata.bbox.y + metadata.bbox.height / 2;
        return Math.abs(metadataCenterX - centerX)
          + Math.abs(metadataCenterY - centerY)
          + Math.abs(metadata.bbox.width - width)
          + Math.abs(metadata.bbox.height - height);
      };
      return score(a) - score(b);
    })[0];
  }, []);

  // Virtualization: only render visible pages + buffer to prevent OOM on large PDFs.
  // For a 51-page form at 2x DPR, rendering all pages consumes ~700MB+ in canvas memory.
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const renderingPagesRef = useRef<Set<number>>(new Set());
  const visiblePagesRef = useRef<Set<number>>(new Set([1]));
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null);
  const VIRT_RENDER_BUFFER = 2;   // Render this many pages above/below visible area
  const VIRT_CLEAR_DISTANCE = 5;  // Clear pages this far from any visible page
  const VIRT_LARGE_PDF_THRESHOLD = 10; // Enable virtualization for PDFs with more pages than this

  // Pinch-to-zoom: use CSS transform for smooth visual scaling, debounce re-render
  const [zoomTransform, setZoomTransform] = useState(1);
  const zoomTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingScaleRef = useRef<number | null>(null);

  const cancelFormFieldTyping = useCallback(() => {
    formFieldTypingRef.current.runId += 1;
    formFieldTypingRef.current.timeouts.forEach(timeoutId => window.clearTimeout(timeoutId));
    formFieldTypingRef.current.timeouts = [];
    // Clean up any lingering typing overlays and restore input visibility.
    // Also ensure element values match the snapshot — during animation the
    // element may hold a partial value (accumulated tokens so far).
    document.querySelectorAll('.pdf-typing-overlay').forEach(el => el.remove());
    document.querySelectorAll<HTMLElement>('.annotationLayer input, .annotationLayer textarea').forEach(el => {
      if (el.style.color === 'transparent') {
        el.style.color = '#000';
        el.style.caretColor = '';
        // Restore the correct value from the snapshot
        const fieldName = (el as HTMLInputElement).name;
        if (fieldName && formFieldValueSnapshotRef.current.has(fieldName)) {
          const snapshotVal = formFieldValueSnapshotRef.current.get(fieldName);
          if ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio') {
            // handled by checked property, not value
          } else {
            (el as HTMLInputElement).value = String(snapshotVal ?? '');
          }
        }
      }
    });
  }, []);

  const clearAnnotationBlinkTimeouts = useCallback(() => {
    annotationBlinkTimeoutsRef.current.forEach(timeoutId => window.clearTimeout(timeoutId));
    annotationBlinkTimeoutsRef.current.clear();
  }, []);

  const dispatchPdfSelection = useCallback((field: FormField | null) => {
    if (!field) {
      window.dispatchEvent(new CustomEvent('selection:changed', { detail: null }));
      return;
    }

    window.dispatchEvent(new CustomEvent('selection:changed', {
      detail: {
        type: 'pdf',
        kind: 'formField',
        filePath,
        fieldId: field.id,
        fieldName: field.name,
        fieldType: field.type,
        fieldIndex: field.index,
        page: field.page,
        value: field.value ?? null,
      },
    }));
  }, [filePath]);

  const selectFormField = useCallback((field: FormField) => {
    setSelectedAnnotationIds(new Set());
    setSelectedTextSpans(new Set());
    setSelectedAnnotationId(null);
    setToolbarPosition(null);
    setSelectedFormFieldNames(new Set([field.name]));

    document.querySelectorAll('.text-span-selected').forEach(el => {
      el.classList.remove('text-span-selected');
    });
    document.querySelectorAll('.form-field-selected').forEach(el => {
      el.classList.remove('form-field-selected');
    });

    const section = field.element?.parentElement;
    if (section) {
      section.classList.add('form-field-selected');
    }

    dispatchPdfSelection(field);
  }, [dispatchPdfSelection]);

  const queueAnnotationBlinkTimeout = useCallback((callback: () => void, delayMs: number) => {
    const timeoutId = window.setTimeout(() => {
      annotationBlinkTimeoutsRef.current.delete(timeoutId);
      callback();
    }, delayMs);
    annotationBlinkTimeoutsRef.current.add(timeoutId);
  }, []);

  const scheduleAnnotationBlink = useCallback((annotationId: string) => {
    queueAnnotationBlinkTimeout(() => {
      if (typeof document === 'undefined') {
        return;
      }

      const annotationDiv = document.querySelector<HTMLDivElement>(`[data-annotation-id="${annotationId}"]`);
      if (!annotationDiv) {
        return;
      }

      const opacitySteps = [
        { delayMs: 0, opacity: '0.3' },
        { delayMs: 100, opacity: '1' },
        { delayMs: 200, opacity: '0.3' },
        { delayMs: 300, opacity: '1' },
      ] as const;

      opacitySteps.forEach(({ delayMs, opacity }) => {
        queueAnnotationBlinkTimeout(() => {
          annotationDiv.style.opacity = opacity;
        }, delayMs);
      });
    }, 50);
  }, [queueAnnotationBlinkTimeout]);

  const scheduleFormFieldTyping = useCallback((
    entries: Array<{ field: FormField; element: HTMLInputElement | HTMLTextAreaElement; value: string; oldValue?: string }>
  ) => {
    if (entries.length === 0) return;

    cancelFormFieldTyping();
    const runId = formFieldTypingRef.current.runId;

    console.log('[PDFViewer] [Anim] scheduleFormFieldTyping called, runId:', runId, 'entries:', entries.length,
      entries.map(e => ({ name: e.field.name, value: e.value, oldValue: e.oldValue, connected: e.element.parentElement?.isConnected })));

    // Sort fields by reading order: page, then top→left, then field index
    const ordered = [...entries].sort((a, b) => {
      if (a.field.page !== b.field.page) return a.field.page - b.field.page;
      const aRect = a.element.getBoundingClientRect();
      const bRect = b.element.getBoundingClientRect();
      if (aRect.top !== bRect.top) return aRect.top - bRect.top;
      if (aRect.left !== bRect.left) return aRect.left - bRect.left;
      return a.field.index - b.field.index;
    });

    // IMMEDIATELY hide all text fields synchronously so the user doesn't
    // see a flash of the final value (which refreshFromDisk already set).
    // The animation will reveal text via an overlay.
    for (const entry of ordered) {
      entry.element.style.color = 'transparent';
      entry.element.style.caretColor = 'transparent';
    }

    /** Random delay in [FORM_TYPING_MIN_DELAY_MS, FORM_TYPING_MAX_DELAY_MS]. */
    const randomDelay = () =>
      Math.round(FORM_TYPING_MIN_DELAY_MS + Math.random() * (FORM_TYPING_MAX_DELAY_MS - FORM_TYPING_MIN_DELAY_MS));

    /** Random very light pastel color for field flash effect. */
    const randomPastelColor = () => {
      const hue = Math.floor(Math.random() * 360);
      return `hsl(${hue}, 70%, 92%)`;
    };

    /** Apply pastel flash to a field's parent section. */
    const applyFlash = (element: HTMLElement) => {
      const section = element.parentElement;
      if (!section) return;
      section.style.transition = 'background-color 0.4s ease-in-out';
      section.style.backgroundColor = randomPastelColor();
    };

    /** Remove pastel flash from a field's parent section. */
    const removeFlash = (element: HTMLElement) => {
      const section = element.parentElement;
      if (!section) return;
      section.style.backgroundColor = 'transparent';
    };

    /**
     * Create a typing overlay that sits on top of the hidden input.
     * Copies computed styles to match text position exactly.
     * Returns null if the element is detached or has no parent.
     */
    function createOverlay(element: HTMLInputElement | HTMLTextAreaElement): {
      overlay: HTMLDivElement;
      cleanup: () => void;
    } | null {
      const section = element.parentElement;
      if (!section || !section.isConnected) {
        console.warn('[PDFViewer] [Anim] createOverlay FAILED: element detached', { hasParent: !!section, isConnected: section?.isConnected });
        return null;
      }

      const computed = window.getComputedStyle(element);

      // Hide the real input text (keep the element for focus/sizing)
      element.style.color = 'transparent';
      element.style.caretColor = 'transparent';

      const overlay = document.createElement('div');
      overlay.className = 'pdf-typing-overlay';
      overlay.style.fontSize = computed.fontSize;
      overlay.style.fontFamily = computed.fontFamily;
      overlay.style.fontWeight = computed.fontWeight;
      overlay.style.letterSpacing = computed.letterSpacing;
      overlay.style.lineHeight = computed.lineHeight;
      overlay.style.padding = computed.padding;

      if (element instanceof HTMLTextAreaElement) {
        overlay.style.alignItems = 'flex-start';
        overlay.style.whiteSpace = 'pre-wrap';
      } else {
        overlay.style.alignItems = 'center';
        overlay.style.whiteSpace = 'pre';
      }

      section.appendChild(overlay);

      const cleanup = () => {
        element.style.color = '#000';
        element.style.caretColor = '';
        if (overlay.parentElement) {
          overlay.parentElement.removeChild(overlay);
        }
      };

      return { overlay, cleanup };
    }

    /**
     * Render tokens into the overlay.
     * While typing: all tokens orange.  On completion: all tokens black.
     */
    function renderOverlay(overlay: HTMLDivElement, tokens: string[], upToIndex: number, isComplete: boolean) {
      overlay.innerHTML = '';
      for (let i = 0; i <= upToIndex && i < tokens.length; i++) {
        const span = document.createElement('span');
        span.textContent = tokens[i];
        span.className = isComplete ? 'pdf-token' : 'pdf-token-leading';
        overlay.appendChild(span);
      }
    }

    /**
     * Ensure a field shows its final value.
     * Called when animation cannot proceed (error, canceled, detached).
     */
    function ensureValueVisible(entry: typeof ordered[0]) {
      entry.element.value = entry.value;
      entry.element.style.color = '#000';
      entry.element.style.caretColor = '';
    }

    // --- Phase 1: ALL deletions happen simultaneously (no stagger) ---
    const deletionEntries: Array<{ entry: typeof ordered[0]; overlay: HTMLDivElement; cleanup: () => void }> = [];
    const additionEntries: typeof ordered = [];
    let hasDeletions = false;

    ordered.forEach(entry => {
      const hasOldValue = !!entry.oldValue && entry.oldValue !== '';
      if (hasOldValue) {
        const delResult = createOverlay(entry.element);
        if (!delResult) {
          console.warn('[PDFViewer] [Anim] Deletion overlay failed for', entry.field.name, '— showing value directly');
          ensureValueVisible(entry);
          return;
        }
        const delSpan = document.createElement('span');
        delSpan.textContent = entry.oldValue!;
        delSpan.className = 'pdf-token-deleted';
        delResult.overlay.appendChild(delSpan);
        deletionEntries.push({ entry, overlay: delResult.overlay, cleanup: delResult.cleanup });
        hasDeletions = true;
      }
      // All entries (with or without old value) get queued for addition
      additionEntries.push(entry);
    });

    console.log('[PDFViewer] [Anim] Phase setup: deletions:', deletionEntries.length, 'additions:', additionEntries.length, 'hasDeletions:', hasDeletions);

    /** Start staggered addition phase for all fields. */
    const startAdditions = () => {
      if (formFieldTypingRef.current.runId !== runId) {
        console.log('[PDFViewer] [Anim] startAdditions: CANCELED (runId mismatch)');
        additionEntries.forEach(ensureValueVisible);
        return;
      }

      console.log('[PDFViewer] [Anim] startAdditions: starting', additionEntries.length, 'fields');

      additionEntries.forEach((entry) => {
        // Stagger flash onset randomly so fields light up at different times
        const flashDelay = Math.round(Math.random() * 300);
        const typingDelay = flashDelay + 350; // Start typing after flash has been visible briefly

        // Flash the field immediately (staggered)
        const flashId = window.setTimeout(() => {
          applyFlash(entry.element);
        }, flashDelay);
        formFieldTypingRef.current.timeouts.push(flashId);

        const timeoutId = window.setTimeout(() => {
          try {
            if (formFieldTypingRef.current.runId !== runId) {
              console.log('[PDFViewer] [Anim] Addition timeout canceled for', entry.field.name);
              removeFlash(entry.element);
              ensureValueVisible(entry);
              return;
            }

            const hasNewValue = !!entry.value && entry.value !== '';
            if (!hasNewValue) {
              removeFlash(entry.element);
              ensureValueVisible(entry);
              return;
            }

            const tokens = tokenizeForTyping(entry.value);
            if (tokens.length === 0) {
              console.warn('[PDFViewer] [Anim] No tokens for', entry.field.name, '— showing value directly');
              removeFlash(entry.element);
              ensureValueVisible(entry);
              return;
            }

            const result = createOverlay(entry.element);
            if (!result) {
              console.warn('[PDFViewer] [Anim] Addition overlay failed for', entry.field.name, '— showing value directly');
              removeFlash(entry.element);
              ensureValueVisible(entry);
              return;
            }
            const { overlay, cleanup: rawCleanup } = result;
            // Wrap cleanup to also remove flash
            const cleanup = () => {
              rawCleanup();
              removeFlash(entry.element);
            };
            // Clear the input text — the overlay handles the visual typing.
            // The real value was already set by refreshFromDisk; we'll restore it
            // on cleanup or cancellation.
            entry.element.value = '';

            console.log('[PDFViewer] [Anim] Typing field', entry.field.name, ':', tokens.length, 'tokens');

            let tokenIdx = 0;
            let accumulated = '';

            const step = () => {
              try {
                if (formFieldTypingRef.current.runId !== runId) {
                  cleanup();
                  ensureValueVisible(entry);
                  return;
                }

                accumulated += tokens[tokenIdx];
                entry.element.value = accumulated;
                renderOverlay(overlay, tokens, tokenIdx, false);
                tokenIdx += 1;

                if (tokenIdx < tokens.length) {
                  const nextId = window.setTimeout(step, randomDelay());
                  formFieldTypingRef.current.timeouts.push(nextId);
                } else {
                  const finishId = window.setTimeout(() => {
                    try {
                      entry.element.value = entry.value;
                      renderOverlay(overlay, tokens, tokens.length - 1, true);
                      const removeId = window.setTimeout(() => {
                        cleanup();
                        console.log('[PDFViewer] [Anim] Completed field', entry.field.name);
                      }, 30);
                      formFieldTypingRef.current.timeouts.push(removeId);
                    } catch (err) {
                      console.error('[PDFViewer] [Anim] Error in finish step for', entry.field.name, err);
                      cleanup();
                      ensureValueVisible(entry);
                    }
                  }, randomDelay());
                  formFieldTypingRef.current.timeouts.push(finishId);
                }
              } catch (err) {
                console.error('[PDFViewer] [Anim] Error in typing step for', entry.field.name, err);
                cleanup();
                ensureValueVisible(entry);
              }
            };

            step();
          } catch (err) {
            console.error('[PDFViewer] [Anim] Error starting addition for', entry.field.name, err);
            removeFlash(entry.element);
            ensureValueVisible(entry);
          }
        }, typingDelay);
        formFieldTypingRef.current.timeouts.push(timeoutId);
      });
    };

    if (hasDeletions) {
      // Show all deletions in red simultaneously, then clear all at once
      const clearAllId = window.setTimeout(() => {
        try {
          if (formFieldTypingRef.current.runId !== runId) {
            deletionEntries.forEach(d => {
              d.cleanup();
              ensureValueVisible(d.entry);
            });
            return;
          }
          deletionEntries.forEach(d => {
            d.cleanup();
            d.entry.element.value = '';
          });
          startAdditions();
        } catch (err) {
          console.error('[PDFViewer] [Anim] Error in deletion clear phase', err);
          deletionEntries.forEach(d => {
            try { d.cleanup(); } catch (_) { /* ignore */ }
            ensureValueVisible(d.entry);
          });
        }
      }, FORM_TYPING_DELETION_DISPLAY_MS);
      formFieldTypingRef.current.timeouts.push(clearAllId);
    } else {
      startAdditions();
    }
  }, [cancelFormFieldTyping]);

  const [reloadTrigger, setReloadTrigger] = useState(0);

  useEffect(() => {
    getFileUrl(filePath).then(url => {
      setPdfUrl(reloadTrigger > 0 ? url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now() : url);
    });
  }, [filePath, reloadTrigger]);

  useEffect(() => {
    if (!pdfUrl) return;
    loadPDF();

    return () => {
      if (loadingTimerRef.current !== null) {
        clearTimeout(loadingTimerRef.current);
      }
    };
  }, [pdfUrl]);

  // Compute fit-to-container base scale synchronously before paint.
  // Uses cached page dimensions (set in loadPDF) so no async needed.
  useLayoutEffect(() => {
    if (baseScaleComputedRef.current || numPages === 0 || !pdfPageDimensionsRef.current) return;

    const container = containerRef.current;
    if (!container) return;

    const { width: pageWidth } = pdfPageDimensionsRef.current;
    const padding = 16; // matches p-4 (16px on each side)
    const availableWidth = container.clientWidth - padding * 2;

    // Always fit to container width so 100% zoom means the page fills the
    // pane horizontally.  The user scrolls vertically for tall pages — this
    // is standard PDF-viewer behaviour and prevents pages from overflowing
    // narrow panes (e.g. 3 documents side-by-side).
    let fitScale = availableWidth / pageWidth;
    fitScale = Math.min(fitScale, 5.0);

    baseScaleRef.current = fitScale;
    baseScaleComputedRef.current = true;
    setScale(fitScale);
  }, [numPages]);

  // Navigate to initialPage when it changes (e.g. from interpreter_set page property)
  // Track the last scrolled-to page so we don't re-scroll when numPages changes
  const lastScrolledPageRef = useRef<number | null>(null);
  useEffect(() => {
    if (initialPage && initialPage >= 1 && initialPage <= numPages) {
      // Only scroll if the target page actually changed
      if (lastScrolledPageRef.current === initialPage) return;
      lastScrolledPageRef.current = initialPage;
      setCurrentPage(initialPage);
      const pageContainer = pageContainerRefs.current[initialPage - 1];
      if (pageContainer) {
        pageContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, [initialPage, numPages]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  // Virtualization: IntersectionObserver tracks which pages are in/near the viewport.
  // When a page enters the viewport, render it if not already rendered.
  // When pages move far from the viewport, clear them to free canvas memory.
  useEffect(() => {
    if (numPages === 0) return;

    // Disconnect previous observer if any
    if (intersectionObserverRef.current) {
      intersectionObserverRef.current.disconnect();
    }

    const totalPages = pdfDocRef.current?.numPages ?? numPages;
    if (totalPages <= VIRT_LARGE_PDF_THRESHOLD) return; // No virtualization for small PDFs

    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        entries.forEach(entry => {
          const el = entry.target as HTMLDivElement;
          const pageIndex = pageContainerRefs.current.indexOf(el);
          if (pageIndex === -1) return;
          const pageNum = pageIndex + 1;

          if (entry.isIntersecting) {
            if (!visiblePagesRef.current.has(pageNum)) {
              visiblePagesRef.current.add(pageNum);
              changed = true;
            }
          } else {
            if (visiblePagesRef.current.has(pageNum)) {
              visiblePagesRef.current.delete(pageNum);
              changed = true;
            }
          }
        });

        if (changed && pdfDocRef.current) {
          // Render newly visible pages
          for (const visible of visiblePagesRef.current) {
            for (let p = visible - VIRT_RENDER_BUFFER; p <= visible + VIRT_RENDER_BUFFER; p++) {
              if (p >= 1 && p <= totalPages && !renderedPagesRef.current.has(p)) {
                renderNewlyVisiblePage(p);
              }
            }
          }
          // Clear distant pages to free memory
          clearDistantPages();
        }
      },
      { rootMargin: '800px' } // Pre-render 800px ahead of viewport
    );

    intersectionObserverRef.current = observer;

    pageContainerRefs.current.forEach(el => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [numPages, scale]);

  // On container resize, maintain the current zoom percentage.
  // E.g. if at 100% (fit-to-width), resizing the container re-fits the PDF.
  // If at 150%, resizing keeps it at 150% of the new fit scale.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0 || !pdfPageDimensionsRef.current) return;

    let resizeRafId: number | null = null;
    const observer = new ResizeObserver(() => {
      // Debounce via rAF so we only compute once per frame during continuous resize
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        const dims = pdfPageDimensionsRef.current;
        if (!dims) return;
        const oldBase = baseScaleRef.current;
        const padding = 16;
        const availableWidth = container.clientWidth - padding * 2;
        let newBase = availableWidth / dims.width;
        newBase = Math.min(newBase, 5.0);

        if (Math.abs(newBase - oldBase) > 0.001) {
          // Preserve the user's zoom percentage: scale = newBase * (oldScale / oldBase)
          const ratio = newBase / oldBase;
          baseScaleRef.current = newBase;
          setScale(prev => prev * ratio);
        }
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
    };
  }, [numPages]);

  useEffect(() => {
    if (pdfDocRef.current && numPages > 0) {
      // Increment generation to invalidate any in-flight async renders
      renderGenRef.current += 1;
      const gen = renderGenRef.current;
      // Ensure page container refs are ready before rendering
      const rafId = requestAnimationFrame(() => {
        renderAllPages(gen);
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [scale, numPages]);

  async function loadPDF() {
    if (!pdfUrl) return;

    // NOTE(victor): On reload (pdfDocRef already set), skip the loading state
    // to preserve existing canvas content. setLoading(true) causes an early
    // return in the JSX that destroys all page containers, and if numPages is
    // unchanged the render effect never re-fires, leaving a black screen.
    const isReload = pdfDocRef.current !== null;

    try {
      if (!isReload) {
        setLoading(true);
        setShowLoading(false);

        if (loadingTimerRef.current !== null) {
          clearTimeout(loadingTimerRef.current);
        }
        loadingTimerRef.current = window.setTimeout(() => {
          setShowLoading(true);
        }, LOADING_DELAY_MS);
      }
      setError(null);

      const loadingTask = pdfjsLib.getDocument({
        url: pdfUrl,
        enableXfa: true,
      });
      const pdfDoc = await loadingTask.promise;
      pdfDocRef.current = pdfDoc;

      try {
        const structure = await pdf.readStructure(filePath);
        if (structure) {
          cacheFormFieldMetadata(structure.elements);
        }
      } catch (structureErr) {
        console.warn('[PDFViewer] Failed to cache PDF form field metadata before render:', structureErr);
      }

      // Cache first page dimensions for synchronous fit-to-container computation
      try {
        const firstPage = await pdfDoc.getPage(1);
        const vp = firstPage.getViewport({ scale: 1.0 });
        pdfPageDimensionsRef.current = { width: vp.width, height: vp.height };
      } catch { /* ignore, will fall back to scale=1.0 */ }

      setNumPages(pdfDoc.numPages);
      console.log('PDF loaded successfully, pages:', pdfDoc.numPages);

      if (isReload) {
        renderGenRef.current += 1;
        const gen = renderGenRef.current;
        requestAnimationFrame(() => {
          renderAllPages(gen);
        });
      }
    } catch (err: any) {
      console.error('Failed to load PDF:', err);
      setError(err.message || 'Failed to load PDF file');
    } finally {
      if (loadingTimerRef.current !== null) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      if (!isReload) {
        setLoading(false);
        setShowLoading(false);
      }
    }
  }

  // Load annotations from PDF using IPC
  const loadAnnotations = useCallback(async () => {
    try {
      const structure = await pdf.readStructure(filePath);

      if (!structure) {
        console.log('[PDFViewer] Failed to read PDF structure for annotations');
        return;
      }

      cacheFormFieldMetadata(structure.elements);
      const loadedAnnotations: LocalAnnotation[] = parseEditableAnnotations(structure.elements);

      console.log('[PDFViewer] Loaded annotations:', loadedAnnotations.length);

      // Detect new annotations (only after initial load)
      if (!isInitialLoadRef.current) {
        const currentIds = new Set(loadedAnnotations.map(a => a.id));
        const newIds = new Set<string>();

        // Find IDs that weren't in the previous set
        currentIds.forEach(id => {
          if (!previousAnnotationIdsRef.current.has(id)) {
            newIds.add(id);
          }
        });

        if (newIds.size > 0) {
          console.log('[PDFViewer] New annotations detected:', Array.from(newIds));
          setFlashAnnotationIds(newIds);

          // Clear the flash effect after animation completes
          setTimeout(() => {
            setFlashAnnotationIds(new Set());
          }, 1500);
        }

        // Update previous IDs
        previousAnnotationIdsRef.current = currentIds;
      } else {
        // First load - just store the IDs, no blink
        previousAnnotationIdsRef.current = new Set(loadedAnnotations.map(a => a.id));
        isInitialLoadRef.current = false;
      }

      setAnnotations(loadedAnnotations);
    } catch (err) {
      console.error('[PDFViewer] Error loading annotations:', err);
    }
  }, [filePath, cacheFormFieldMetadata]);

  // Schedule debounced save
  const scheduleSave = useCallback(() => {
    setSaveStatus('unsaved');
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      // Use ref to always call the latest version of saveAnnotations
      saveAnnotationsRef.current();
    }, SAVE_DEBOUNCE_MS);
  }, []);

  // Save annotations to PDF (remove old + add new)
  const saveAnnotations = useCallback(async () => {
    const dirtyAnnotations = annotations.filter(a => a.isDirty && isEditableAnnotation(a));
    if (dirtyAnnotations.length === 0) return;

    console.log('[PDFViewer] Saving annotations:', dirtyAnnotations.length);
    setSaveStatus('saving');

    // Clear any pending "Saved" timeout
    if (saveStatusTimeoutRef.current) {
      clearTimeout(saveStatusTimeoutRef.current);
    }

    try {
      // Separate text and image annotations
      const dirtyTextAnnotations = dirtyAnnotations.filter(a => a.annotationType === 'FreeText');
      const dirtyImageAnnotations = dirtyAnnotations.filter(isImageAnnotation);

      // 1. Remove annotations that have been modified (have originalId)
      const toRemove = dirtyAnnotations
        .filter(a => a.originalId && !a.id.startsWith('local-'))
        .map(a => a.originalId!);

      if (toRemove.length > 0) {
        console.log('[PDFViewer] Removing old annotations:', toRemove);
        lastSelfWriteRef.current = Date.now();
        const removeUrl = await getApiUrl('/api/pdf/annotations/remove');
        await fetch(removeUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, annotationIds: toRemove })
        });
      }

      let createdTextIds: string[] = [];
      let createdImageIds: string[] = [];

      // 2. Add text annotations
      if (dirtyTextAnnotations.length > 0) {
        const toAddText = dirtyTextAnnotations.map(a => ({
          page: a.page,
          x: a.x,
          y: a.y,
          width: a.width,
          height: a.height,
          text: a.text,
          fontSize: a.fontSize,
          color: a.color
        }));

        console.log('[PDFViewer] Adding text annotations:', toAddText.length);
        lastSelfWriteRef.current = Date.now();
        const addUrl = await getApiUrl('/api/pdf/annotations/add');
        const addResponse = await fetch(addUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, annotations: toAddText })
        });
        const addResult = await addResponse.json();
        createdTextIds = addResult.createdIds || [];
      }

      // 3. Add image annotations
      if (dirtyImageAnnotations.length > 0) {
        const toAddImages = dirtyImageAnnotations.map(a => ({
          page: a.page,
          x: a.x,
          y: a.y,
          width: a.width,
          height: a.height,
          imagePath: a.imagePath!
        }));

        console.log('[PDFViewer] Adding image annotations:', toAddImages.length);
        lastSelfWriteRef.current = Date.now();
        const addImageUrl = await getApiUrl('/api/pdf/annotations/add-image');
        const addResponse = await fetch(addImageUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, annotations: toAddImages })
        });
        const addResult = await addResponse.json();
        createdImageIds = addResult.createdIds || [];
      }

      console.log('[PDFViewer] Created annotation IDs:', {
        text: createdTextIds,
        image: createdImageIds
      });

      const createdIdBatches = [
        {
          savedAnnotations: dirtyTextAnnotations,
          createdIds: createdTextIds
        },
        {
          savedAnnotations: dirtyImageAnnotations,
          createdIds: createdImageIds
        }
      ];

      const reconciled = reconcileSavedAnnotationState({
        annotations: annotationsRef.current,
        removedOriginalIds: toRemove,
        createdIdBatches,
        selectedAnnotationId: selectedAnnotationIdRef.current,
        selectedAnnotationIds: selectedAnnotationIdsRef.current,
        matchesSavedAnnotation: matchesSavedLocalAnnotation,
      });

      setAnnotations(reconciled.annotations);
      setSelectedAnnotationId(reconciled.selectedAnnotationId);
      setSelectedAnnotationIds(reconciled.selectedAnnotationIds);

      // Show "Saved" briefly, then hide
      setSaveStatus('saved');
      saveStatusTimeoutRef.current = setTimeout(() => {
        setSaveStatus('idle');
      }, 2000);

    } catch (err) {
      console.error('[PDFViewer] Error saving annotations:', err);
      setSaveStatus('idle');
    }
  }, [annotations, filePath]);

  // Keep ref updated so scheduleSave always calls latest version
  useEffect(() => {
    saveAnnotationsRef.current = saveAnnotations;
  }, [saveAnnotations]);

  // Save form fields to PDF (debounced)
  const saveFormFields = useCallback(async () => {
    const dirtyFields = dirtyFormFieldsRef.current;
    if (dirtyFields.size === 0) return;

    console.log('[PDFViewer] Saving form fields:', dirtyFields.size);
    setSaveStatus('saving');

    try {
      const fields = Array.from(dirtyFields.entries()).map(([name, value]) => ({
        name,
        value
      }));

      lastSelfWriteRef.current = Date.now();
      const saveUrl = await getApiUrl('/api/pdf/formfields/save');
      const response = await fetch(saveUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, fields })
      });

      if (response.ok) {
        // Clear dirty fields after successful save
        dirtyFormFieldsRef.current.clear();
        console.log('[PDFViewer] Form fields saved successfully');
        setSaveStatus('saved');
        if (saveStatusTimeoutRef.current) {
          clearTimeout(saveStatusTimeoutRef.current);
        }
        saveStatusTimeoutRef.current = setTimeout(() => {
          setSaveStatus('idle');
        }, 1500);
      } else {
        console.error('[PDFViewer] Failed to save form fields:', await response.text());
        setSaveStatus('idle');
      }
    } catch (err) {
      console.error('[PDFViewer] Error saving form fields:', err);
      setSaveStatus('idle');
    }
  }, [filePath]);

  // Schedule debounced form field save
  const scheduleFormFieldSave = useCallback(() => {
    if (formFieldSaveTimeoutRef.current) {
      clearTimeout(formFieldSaveTimeoutRef.current);
    }
    formFieldSaveTimeoutRef.current = setTimeout(() => {
      saveFormFields();
    }, SAVE_DEBOUNCE_MS);
  }, [saveFormFields]);

  const flushPendingSaves = useCallback(async () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (formFieldSaveTimeoutRef.current) {
      clearTimeout(formFieldSaveTimeoutRef.current);
      formFieldSaveTimeoutRef.current = null;
    }
    await saveAnnotationsRef.current();
    await saveFormFields();
  }, [saveFormFields]);

  // Keep live annotation state refs in sync for async save reconciliation and drag handlers.
  useEffect(() => {
    annotationsRef.current = annotations;
    selectedAnnotationIdRef.current = selectedAnnotationId;
    selectedAnnotationIdsRef.current = selectedAnnotationIds;
  }, [annotations, selectedAnnotationId, selectedAnnotationIds]);

  // Clear all multi-selection state
  const clearSelection = useCallback(() => {
    setSelectedAnnotationIds(new Set());
    setSelectedFormFieldNames(new Set());
    setSelectedTextSpans(new Set());
    setSelectedAnnotationId(null);
    setToolbarPosition(null);

    document.querySelectorAll('.text-span-selected').forEach(el => {
      el.classList.remove('text-span-selected');
    });

    document.querySelectorAll('.form-field-selected').forEach(el => {
      el.classList.remove('form-field-selected');
    });
    dispatchPdfSelection(null);
  }, [dispatchPdfSelection]);

  // Update a single annotation
  const updateAnnotation = useCallback((id: string, updates: Partial<LocalAnnotation>) => {
    setAnnotations(prev => prev.map(a =>
      a.id === id
        ? { ...a, ...updates, isDirty: true }
        : a
    ));
    scheduleSave();
  }, [scheduleSave]);

  // Update multiple annotations at once (for multi-move)
  const updateAnnotations = useCallback((updates: Map<string, Partial<LocalAnnotation>>) => {
    setAnnotations(prev => prev.map(a => {
      const update = updates.get(a.id);
      return update ? { ...a, ...update, isDirty: true } : a;
    }));
    scheduleSave();
  }, [scheduleSave]);

  // Create a new annotation
  const createAnnotation = useCallback((page: number, x: number, y: number) => {
    const newAnnotation: LocalAnnotation = {
      id: `local-${Date.now()}`,
      page,
      x,
      y,
      width: 100,
      height: 20,
      text: 'New annotation',
      fontSize: 12,
      color: { r: 0, g: 0, b: 0 },
      isDirty: true,
      originalId: undefined,
      annotationType: 'FreeText'
    };

    setAnnotations(prev => prev.concat(newAnnotation));
    setSelectedAnnotationIds(new Set([newAnnotation.id]));
    setSelectedFormFieldNames(new Set());
    setSelectedTextSpans(new Set());
    setSelectedAnnotationId(newAnnotation.id);
    scheduleSave();

    scheduleAnnotationBlink(newAnnotation.id);
  }, [scheduleAnnotationBlink, scheduleSave]);

  // Create a new image annotation (same pattern as text annotations)
  const createImageAnnotation = useCallback(async (page: number, x: number, y: number, imagePath: string) => {
    // Get image dimensions to calculate appropriate size
    let width = DEFAULT_IMAGE_ANNOTATION_WIDTH;
    let height = DEFAULT_IMAGE_ANNOTATION_HEIGHT;

    try {
      const imgUrl = await getFileUrl(imagePath);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = imgUrl;
      });

      const initialSize = getInitialImageAnnotationSize(img.naturalWidth, img.naturalHeight);
      width = initialSize.width;
      height = initialSize.height;
    } catch (err) {
      console.warn('[PDFViewer] Could not get image dimensions, using defaults:', err);
    }

    const newAnnotation: LocalAnnotation = {
      id: `local-img-${Date.now()}`,
      page,
      x,
      y,
      width,
      height,
      text: '',
      fontSize: 12,
      color: { r: 0, g: 0, b: 0 },
      isDirty: true,
      originalId: undefined,
      annotationType: 'Stamp',
      imagePath
    };

    setAnnotations(prev => prev.concat(newAnnotation));
    setSelectedAnnotationIds(new Set([newAnnotation.id]));
    setSelectedFormFieldNames(new Set());
    setSelectedTextSpans(new Set());
    setSelectedAnnotationId(newAnnotation.id);
    scheduleSave(); // Use same save pattern as text annotations

    scheduleAnnotationBlink(newAnnotation.id);
  }, [scheduleAnnotationBlink, scheduleSave]);

  // Handle drag over for image drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if dragging files (images)
    const hasFiles = e.dataTransfer.types.includes('Files') ||
                     e.dataTransfer.types.includes('text/plain') ||
                     e.dataTransfer.types.includes('application/json');

    if (hasFiles) {
      setIsDragOver(true);
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  // Handle drag leave
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  // Extract file path from drop event (supports JSON, text, and file drops)
  const getDroppedImagePath = useCallback((e: React.DragEvent): string | null => {
    // Try JSON data first (internal file explorer drag)
    try {
      const jsonData = e.dataTransfer.getData('application/json');
      if (jsonData) {
        const data = JSON.parse(jsonData);
        if (data.path) return data.path;
      }
    } catch { /* ignore */ }

    // Try text/plain (file path as string)
    const textData = e.dataTransfer.getData('text/plain');
    if (textData && (isAbsolutePath(textData) || textData.includes('/') || textData.includes('\\'))) {
      return textData;
    }

    // Try file drop (Electron provides .path on File objects)
    if (e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const filePath = (file as any).path;
      if (filePath) return filePath;
    }

    return null;
  }, []);

  // Get drop position on PDF page
  const getDropPosition = useCallback((e: React.DragEvent): { page: number; x: number; y: number } | null => {
    for (let i = 0; i < numPages; i++) {
      const pageContainer = pageContainerRefs.current[i];
      if (pageContainer) {
        const rect = pageContainer.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          return {
            page: i + 1,
            x: (e.clientX - rect.left) / scale,
            y: (e.clientY - rect.top) / scale
          };
        }
      }
    }
    return null;
  }, [numPages, scale]);

  // Handle drop of images
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const imagePath = getDroppedImagePath(e);
    if (!imagePath) return;

    // Validate image extension
    const ext = imagePath.toLowerCase().split('.').pop() || '';
    if (!['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
      console.log('[PDFViewer] Dropped file is not an image:', imagePath);
      return;
    }

    const pos = getDropPosition(e);
    if (!pos) return;

    await createImageAnnotation(pos.page, pos.x, pos.y, imagePath);
  }, [getDroppedImagePath, getDropPosition, createImageAnnotation]);

  // Add annotation in center of visible area
  const addAnnotationInCenter = useCallback(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;

    // Find which page is most visible in the viewport
    const containerRect = container.getBoundingClientRect();
    const containerCenterY = containerRect.top + containerRect.height / 2;

    let targetPage = 1;
    let bestDistance = Infinity;

    for (let i = 0; i < numPages; i++) {
      const pageContainer = pageContainerRefs.current[i];
      if (pageContainer) {
        const pageRect = pageContainer.getBoundingClientRect();
        const pageCenterY = pageRect.top + pageRect.height / 2;
        const distance = Math.abs(pageCenterY - containerCenterY);
        if (distance < bestDistance) {
          bestDistance = distance;
          targetPage = i + 1;
        }
      }
    }

    // Calculate center position within that page
    const pageContainer = pageContainerRefs.current[targetPage - 1];
    if (!pageContainer) return;

    const pageRect = pageContainer.getBoundingClientRect();
    const centerX = (containerRect.left + containerRect.width / 2 - pageRect.left) / scale;
    const centerY = (containerRect.top + containerRect.height / 2 - pageRect.top) / scale;

    // Clamp to page bounds
    const x = Math.max(50, Math.min(centerX - 50, (pageRect.width / scale) - 150));
    const y = Math.max(20, Math.min(centerY - 10, (pageRect.height / scale) - 40));

    createAnnotation(targetPage, x, y);
  }, [numPages, scale, createAnnotation]);

  // Delete selected annotation
  const deleteSelectedAnnotation = useCallback(async () => {
    if (!selectedAnnotationId) return;

    const annotation = annotations.find(a => a.id === selectedAnnotationId);
    if (!annotation) return;

    // If it has an originalId (was saved), remove from PDF
    if (annotation.originalId && !annotation.id.startsWith('local-')) {
      try {
        await removePdfAnnotations(filePath, [annotation.originalId]);
      } catch (err) {
        console.error('[PDFViewer] Error deleting annotation:', err);
      }
    }

    setAnnotations(prev => prev.filter(a => a.id !== selectedAnnotationId));
    clearSelection();
  }, [selectedAnnotationId, annotations, clearSelection, filePath]);

  // Get selected annotation
  const selectedAnnotation = annotations.find(a => a.id === selectedAnnotationId);

  // Load annotations when PDF is loaded
  useEffect(() => {
    if (numPages > 0) {
      loadAnnotations();
    }
  }, [numPages, loadAnnotations]);

  // Diff-based refresh: compare current state with disk, only update what changed
  const refreshFromDisk = useCallback(async () => {
    console.log('[PDFViewer] Refreshing from disk (diff-based)');

    try {
      const structure = await pdf.readStructure(filePath);

      if (!structure) {
        console.log('[PDFViewer] Failed to read PDF structure');
        return;
      }

      cacheFormFieldMetadata(structure.elements);
      // === COMPARE EDITABLE ANNOTATIONS ===
      const diskAnnotations = parseEditableAnnotations(structure.elements);

      const currentIds = new Set<string>(annotations.map(a => a.id));
      const diskIds = new Set<string>(diskAnnotations.map((a: LocalAnnotation) => a.id));

      // Find new annotation IDs (on disk but not in current state)
      const newIds = new Set<string>();
      diskIds.forEach(id => {
        if (!currentIds.has(id)) {
          newIds.add(id);
        }
      });

      // Check if annotations actually changed and track which ones
      const deletedIds = new Set<string>();
      const modifiedIds = new Set<string>(); // Annotations that were modified (not new, but changed)
      annotations.forEach(a => {
        if (!diskAnnotations.find((d: LocalAnnotation) => d.id === a.id)) {
          deletedIds.add(a.id);
        }
      });

      // Check each disk annotation for changes
      diskAnnotations.forEach((diskA: LocalAnnotation) => {
        const currentA = annotations.find(a => a.id === diskA.id);
        if (currentA) {
          // Existing annotation - check if it changed
          const changed = diskA.text !== currentA.text ||
                 diskA.x !== currentA.x ||
                 diskA.y !== currentA.y ||
                 diskA.width !== currentA.width ||
                 diskA.height !== currentA.height ||
                 diskA.page !== currentA.page ||
                 diskA.fontSize !== currentA.fontSize ||
                 diskA.color.r !== currentA.color.r ||
                 diskA.color.g !== currentA.color.g ||
                 diskA.color.b !== currentA.color.b;
          if (changed) {
            modifiedIds.add(diskA.id);
          }
        }
      });

      const annotationsChanged =
        newIds.size > 0 ||
        deletedIds.size > 0 ||
        modifiedIds.size > 0 ||
        diskAnnotations.length !== annotations.length;

      if (deletedIds.size > 0) {
        console.log('[PDFViewer] Deleted annotations:', Array.from(deletedIds));
      }
      if (modifiedIds.size > 0) {
        console.log('[PDFViewer] Modified annotations:', Array.from(modifiedIds));
      }

      if (annotationsChanged) {
        console.log('[PDFViewer] Annotations changed, updating');

        if (!isInitialLoadRef.current) {
          // Flash new and modified annotations
          const allFlashIds = new Set([...newIds, ...modifiedIds]);
          if (allFlashIds.size > 0) {
            console.log('[PDFViewer] Flash annotations:', Array.from(allFlashIds));
            setFlashAnnotationIds(allFlashIds);
            setTimeout(() => setFlashAnnotationIds(new Set()), 1500);
          }
        }

        previousAnnotationIdsRef.current = diskIds;
        setAnnotations(diskAnnotations);
      } else {
        console.log('[PDFViewer] Annotations unchanged');
      }

      // Mark initial load as complete BEFORE form field processing.
      // This ensures that agent updates (which arrive after pages have rendered)
      // trigger the typing animation instead of silently setting values.
      const wasInitialLoad = isInitialLoadRef.current;
      if (isInitialLoadRef.current) {
        isInitialLoadRef.current = false;
        previousAnnotationIdsRef.current = diskIds;
      }

      // === COMPARE FORM FIELDS ===
      const diskFormFields = structure.elements.filter((el: any) => el.type === 'formField');
      const changedFieldNames = new Set<string>();
      const changedTextFields: Array<{
        field: FormField;
        element: HTMLInputElement | HTMLTextAreaElement;
        value: string;
        oldValue?: string;
      }> = [];

      console.log('[PDFViewer] Comparing form fields:', {
        diskFieldCount: diskFormFields.length,
        currentFieldCount: formFieldsRef.current.size,
        diskFieldNames: diskFormFields.map((f: any) => f.fieldName),
        currentFieldNames: Array.from(formFieldsRef.current.keys())
      });

      diskFormFields.forEach((diskField: any) => {
        const currentField = formFieldsRef.current.get(diskField.fieldName);
        if (currentField && currentField.element) {
          // Skip updating fields the user is currently editing (has unsaved changes)
          const isDirty = dirtyFormFieldsRef.current.has(diskField.fieldName);
          if (isDirty) {
            console.log(`[PDFViewer] Skipping dirty field "${diskField.fieldName}" - user has unsaved edits`);
            return;  // Use 'return' not 'continue' - this is inside forEach callback
          }

          const currentValue = currentField.value;
          const diskValue = diskField.fieldValue;

          if (!valuesEqual(currentValue, diskValue)) {
            console.log(`[PDFViewer] Form field "${diskField.fieldName}" changed: "${currentValue}" → "${diskValue}"`);
            changedFieldNames.add(diskField.fieldName);

            // Update the DOM element
            const element = currentField.element;
            if (element instanceof HTMLInputElement) {
              if (element.type === 'checkbox') {
                const diskBool = typeof diskValue === 'boolean'
                  ? diskValue
                  : ['yes', 'true', 'on', 'checked', '1', 'x'].includes(String(diskValue).toLowerCase().trim());
                element.checked = diskBool;
              } else if (element.type === 'radio') {
                // Update all radios in this group. Avoid attribute selectors with
                // raw names because PDF field names can include selector-breaking chars.
                const allRadios = document.querySelectorAll<HTMLInputElement>('input[type="radio"]');
                allRadios.forEach(radio => {
                  if (radio.name === element.name) {
                    radio.checked = String(radio.value) === String(diskValue);
                  }
                });
              } else if (element.type !== 'file' && element.type !== 'hidden') {
                // Text, number, date, etc.
                // ALWAYS set element.value immediately so the value is
                // present even if the typing animation fails.  The
                // animation will hide this text (color: transparent) and
                // overlay its own visual typing, so this won't flash.
                element.value = String(diskValue ?? '');
                if (!wasInitialLoad) {
                  changedTextFields.push({ field: currentField, element, value: String(diskValue ?? ''), oldValue: String(currentValue ?? '') });
                }
              }
            } else if (element instanceof HTMLSelectElement) {
              element.value = String(diskValue ?? '');
            } else if (element instanceof HTMLTextAreaElement) {
              // ALWAYS set element.value immediately (same rationale as text inputs).
              element.value = String(diskValue ?? '');
              if (!wasInitialLoad) {
                changedTextFields.push({ field: currentField, element, value: String(diskValue ?? ''), oldValue: String(currentValue ?? '') });
              }
            }

            // Update our ref and the persistent snapshot so values
            // survive any re-render triggered by resize/zoom.
            currentField.value = diskValue;
            formFieldValueSnapshotRef.current.set(diskField.fieldName, diskValue);
          }
        } else {
          // Field's page is not currently rendered (virtualized out).
          // Update the snapshot directly so the value is restored when the page
          // becomes visible and gets rendered.
          const diskValue = diskField.fieldValue;
          if (diskValue !== undefined) {
            formFieldValueSnapshotRef.current.set(diskField.fieldName, diskValue);
          }
        }
      });

      // Log updated form fields
      if (changedFieldNames.size > 0) {
        console.log('[PDFViewer] Form fields changed:', Array.from(changedFieldNames), { wasInitialLoad, changedTextFieldCount: changedTextFields.length });
        if (!wasInitialLoad && changedTextFields.length > 0) {
          console.log('[PDFViewer] Scheduling typing animation for', changedTextFields.length, 'fields');
          scheduleFormFieldTyping(changedTextFields);
        }
      }

    } catch (err) {
      console.error('[PDFViewer] Error during diff-based refresh:', err);
    }
  }, [filePath, annotations, scheduleFormFieldTyping, cacheFormFieldMetadata]);

  useFileRefresh(filePath, {
    onExternalRefresh: () => {
      if (Date.now() - lastSelfWriteRef.current < 2000) return;
      setReloadTrigger(t => t + 1);
    },
    onAgentRefresh: () => {
      console.log('[PDFViewer] File refreshed, running diff-based refresh');
      refreshFromDisk();
    },
  });

  // Cleanup save timeouts on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (formFieldSaveTimeoutRef.current) {
        clearTimeout(formFieldSaveTimeoutRef.current);
      }
      if (zoomTimeoutRef.current) {
        clearTimeout(zoomTimeoutRef.current);
      }
      clearAnnotationBlinkTimeouts();
      cancelFormFieldTyping();
    };
  }, [cancelFormFieldTyping, clearAnnotationBlinkTimeouts]);

  // Re-render annotations when they change or selection changes
  useEffect(() => {
    // Skip re-render while user is editing an annotation (prevents input from being destroyed)
    if (editingAnnotationIdRef.current) {
      return;
    }
    // Render annotations for all pages that have layers
    // (renderAnnotationsForPage handles missing layers gracefully)
    if (numPages > 0) {
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        renderAnnotationsForPage(pageNum, scale);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, selectedAnnotationId, selectedAnnotationIds, scale, numPages, flashAnnotationIds, layersReady]);

  // --- Virtualization helpers ---

  /** Determine which pages should be rendered based on current visibility. */
  function getPagesToRender(): Set<number> {
    const totalPages = pdfDocRef.current?.numPages ?? numPages;

    // Small PDFs: render everything (no virtualization needed)
    if (totalPages <= VIRT_LARGE_PDF_THRESHOLD) {
      return new Set(Array.from({ length: totalPages }, (_, i) => i + 1));
    }

    const pages = new Set<number>();
    for (const visible of visiblePagesRef.current) {
      for (let p = visible - VIRT_RENDER_BUFFER; p <= visible + VIRT_RENDER_BUFFER; p++) {
        if (p >= 1 && p <= totalPages) pages.add(p);
      }
    }
    // Always include initialPage if set (agent may navigate here)
    if (initialPage && initialPage >= 1 && initialPage <= totalPages) {
      for (let p = initialPage - VIRT_RENDER_BUFFER; p <= initialPage + VIRT_RENDER_BUFFER; p++) {
        if (p >= 1 && p <= totalPages) pages.add(p);
      }
    }
    // Guarantee at least page 1
    if (pages.size === 0) pages.add(1);
    return pages;
  }

  /** Clear a rendered page's DOM content to free canvas/text layer memory. */
  function clearPageContent(pageNum: number) {
    const container = pageContainerRefs.current[pageNum - 1];
    if (!container || !renderedPagesRef.current.has(pageNum)) return;

    // Save form field values to snapshot before clearing
    formFieldsRef.current.forEach((field, name) => {
      if (field.page === pageNum && field.element) {
        const el = field.element;
        let val: any;
        if (el instanceof HTMLInputElement) {
          val = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
        } else {
          val = el.value;
        }
        formFieldValueSnapshotRef.current.set(name, val);
      }
    });

    // Remove form field refs for this page
    formFieldsRef.current.forEach((field, name) => {
      if (field.page === pageNum) {
        formFieldsRef.current.delete(name);
      }
    });
    allFormFieldsRef.current = allFormFieldsRef.current.filter(f => f.page !== pageNum);

    // Preserve placeholder dimensions so scroll position stays correct
    const dims = pdfPageDimensionsRef.current;
    if (dims) {
      container.style.width = `${dims.width * scale}px`;
      container.style.height = `${dims.height * scale}px`;
    }

    container.innerHTML = '';
    annotationLayersRef.current.delete(pageNum);
    renderedPagesRef.current.delete(pageNum);
  }

  /** Clear pages that are far from any visible page. */
  function clearDistantPages() {
    const totalPages = pdfDocRef.current?.numPages ?? numPages;
    if (totalPages <= VIRT_LARGE_PDF_THRESHOLD) return; // No virtualization for small PDFs

    const visible = visiblePagesRef.current;
    for (const pageNum of Array.from(renderedPagesRef.current)) {
      let minDist = Infinity;
      for (const v of visible) {
        minDist = Math.min(minDist, Math.abs(pageNum - v));
      }
      if (minDist > VIRT_CLEAR_DISTANCE) {
        console.log(`[PDFViewer] Clearing distant page ${pageNum} (distance: ${minDist})`);
        clearPageContent(pageNum);
      }
    }
  }

  /** Restore a single form field element's value from a snapshot value. */
  function restoreFieldValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: any) {
    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox') {
        const boolVal = typeof value === 'boolean' ? value
          : ['yes', 'true', 'on', 'checked', '1', 'x'].includes(String(value).toLowerCase().trim());
        element.checked = boolVal;
      } else if (element.type === 'radio') {
        // Update all radios in this group without relying on raw name selectors.
        const allRadios = document.querySelectorAll<HTMLInputElement>('input[type="radio"]');
        allRadios.forEach(radio => {
          if (radio.name === element.name) {
            radio.checked = String(radio.value) === String(value);
          }
        });
      } else if (element.type !== 'file' && element.type !== 'hidden') {
        element.value = String(value ?? '');
      }
    } else if (element instanceof HTMLSelectElement) {
      element.value = String(value ?? '');
    } else if (element instanceof HTMLTextAreaElement) {
      element.value = String(value ?? '');
    }
  }

  /** Render a single page that just became visible (called from IntersectionObserver). */
  async function renderNewlyVisiblePage(pageNum: number) {
    if (renderedPagesRef.current.has(pageNum)) return;
    if (!pdfDocRef.current) return;

    const gen = renderGenRef.current;
    console.log(`[PDFViewer] Rendering newly visible page ${pageNum}`);

    const didRender = await renderPage(pageNum, gen);
    if (!didRender) return;
    if (gen !== renderGenRef.current) return; // Stale

    renderedPagesRef.current.add(pageNum);

    // Restore form field values for this page from snapshot
    formFieldValueSnapshotRef.current.forEach((value, name) => {
      const field = formFieldsRef.current.get(name);
      if (field && field.page === pageNum && field.element) {
        restoreFieldValue(field.element, value);
        field.value = value;
      }
    });

    // Re-render annotations for this page
    renderAnnotationsForPage(pageNum, scale);
  }

  async function renderAllPages(gen?: number) {
    if (!pdfDocRef.current) return;
    // If a newer render has been requested, skip this stale one
    if (gen !== undefined && gen !== renderGenRef.current) return;

    const pdf = pdfDocRef.current;
    const pagesToRender = getPagesToRender();
    console.log('Rendering pages:', Array.from(pagesToRender).sort((a, b) => a - b), 'of', pdf.numPages, 'scale:', scale, 'gen:', gen);

    // Cancel any in-flight typing animations — their DOM elements are about
    // to be destroyed so the timeouts would fire on detached nodes.
    cancelFormFieldTyping();

    // Merge only user-edited (dirty) fields into the persistent snapshot.
    // The snapshot already has agent-set values (from refreshFromDisk) and
    // user-set values (from handleFieldChange).  Do NOT merge formFieldsRef
    // here — during rapid resizes, a partially-completed prior render may
    // have populated formFieldsRef with stale annotation defaults from the
    // in-memory PDF, which would overwrite the correct refreshed values.
    dirtyFormFieldsRef.current.forEach((value, name) => {
      formFieldValueSnapshotRef.current.set(name, value);
    });

    // Clear form field refs only for pages we're about to re-render.
    // For pages we won't render (virtualized out), their refs were already
    // cleared when the page was cleared, so this is safe.
    for (const pageNum of pagesToRender) {
      formFieldsRef.current.forEach((field, name) => {
        if (field.page === pageNum) {
          formFieldsRef.current.delete(name);
        }
      });
    }
    allFormFieldsRef.current = allFormFieldsRef.current.filter(
      f => !pagesToRender.has(f.page)
    );

    // Clear pages that were previously rendered but are no longer needed
    for (const pageNum of Array.from(renderedPagesRef.current)) {
      if (!pagesToRender.has(pageNum)) {
        clearPageContent(pageNum);
      }
    }

    // Set placeholder dimensions for all non-rendered pages
    const dims = pdfPageDimensionsRef.current;
    if (dims) {
      for (let i = 0; i < pdf.numPages; i++) {
        if (!pagesToRender.has(i + 1)) {
          const container = pageContainerRefs.current[i];
          if (container && container.children.length === 0) {
            container.style.width = `${dims.width * scale}px`;
            container.style.height = `${dims.height * scale}px`;
          }
        }
      }
    }

    const BATCH_SIZE = 4;
    const pageNumbers = Array.from(pagesToRender).sort((a, b) => a - b);
    const renderedPagesThisPass = new Set<number>();

    for (let i = 0; i < pageNumbers.length; i += BATCH_SIZE) {
      // Check generation before each batch to abort stale renders early
      if (gen !== undefined && gen !== renderGenRef.current) return;
      const batch = pageNumbers.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (pageNum) => {
        const didRender = await renderPage(pageNum, gen);
        if (didRender) {
          renderedPagesThisPass.add(pageNum);
        }
      }));
    }

    // Before restoring, verify this is still the latest render.
    // A newer render will redo the snapshot/restore cycle itself.
    if (gen !== undefined && gen !== renderGenRef.current) return;

    // Track which pages are now rendered
    for (const pageNum of renderedPagesThisPass) {
      renderedPagesRef.current.add(pageNum);
    }

    // Restore saved form field values into the newly created DOM elements
    formFieldValueSnapshotRef.current.forEach((value, name) => {
      const field = formFieldsRef.current.get(name);
      if (field && field.element) {
        restoreFieldValue(field.element, value);
        field.value = value;
      }
    });

    // Signal that layers are ready - this triggers annotation re-render
    setLayersReady(prev => prev + 1);
  }

  function getFieldType(annotation: any): string {
    if (annotation.checkBox) return 'checkbox';
    if (annotation.radioButton) return 'radio';
    if (annotation.comboBox) return 'dropdown';
    if (annotation.listBox) return 'listbox';
    if (annotation.multiLine) return 'textarea';
    return 'text';
  }

  function createFormField(annotation: any, viewport: any, refFontHeight?: number): HTMLElement | null {
    const fieldRect = viewport.convertToViewportRectangle(annotation.rect);

    // Ensure we have min/max values (viewport conversion might not guarantee order)
    const left = Math.min(fieldRect[0], fieldRect[2]);
    const top = Math.min(fieldRect[1], fieldRect[3]);
    const right = Math.max(fieldRect[0], fieldRect[2]);
    const bottom = Math.max(fieldRect[1], fieldRect[3]);

    const section = document.createElement('section');
    section.className = 'pdf-form-field';
    section.dataset.pdfFormField = 'true';
    section.dataset.fieldName = annotation.fieldName || '';
    section.style.position = 'absolute';
    section.style.left = left + 'px';
    section.style.top = top + 'px';
    section.style.width = (right - left) + 'px';
    section.style.height = (bottom - top) + 'px';
    section.style.display = 'flex';

    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

    if (annotation.checkBox) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = annotation.fieldValue === annotation.exportValue;
      input = checkbox;
    } else if (annotation.radioButton) {
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = annotation.fieldName;
      radio.value = annotation.buttonValue || '';
      radio.checked = annotation.fieldValue === annotation.buttonValue;
      input = radio;
    } else if (annotation.comboBox || annotation.listBox) {
      const select = document.createElement('select');
      if (annotation.listBox && annotation.multiSelect) {
        select.multiple = true;
      }

      if (annotation.options) {
        annotation.options.forEach((option: any) => {
          const optionElement = document.createElement('option');
          optionElement.value = option.exportValue;
          optionElement.textContent = option.displayValue;
          if (annotation.fieldValue && annotation.fieldValue.includes(option.exportValue)) {
            optionElement.selected = true;
          }
          select.appendChild(optionElement);
        });
      }
      input = select;
    } else if (annotation.multiLine) {
      const textarea = document.createElement('textarea');
      // Only use fieldValue, ignore defaultFieldValue to prevent showing defaults as filled
      const actualValue = annotation.fieldValue;
      if (actualValue !== null && actualValue !== undefined && actualValue !== '') {
        textarea.value = actualValue;
      }
      // Use defaultFieldValue as placeholder if available
      if (annotation.defaultFieldValue && (!actualValue || actualValue === '')) {
        textarea.placeholder = annotation.defaultFieldValue;
      }
      input = textarea;
    } else {
      const textInput = document.createElement('input');
      textInput.type = 'text';
      // Only use fieldValue, ignore defaultFieldValue to prevent showing defaults as filled
      const actualValue = annotation.fieldValue;
      if (actualValue !== null && actualValue !== undefined && actualValue !== '') {
        textInput.value = actualValue;
      }
      // Use defaultFieldValue as placeholder if available
      if (annotation.defaultFieldValue && (!actualValue || actualValue === '')) {
        textInput.placeholder = annotation.defaultFieldValue;
      }
      input = textInput;
    }

    input.name = annotation.fieldName || '';
    input.title = annotation.alternativeText || '';
    if (annotation.readOnly) {
      input.disabled = true;
    }

    // Apply styles — no inline backgroundColor so CSS :hover works
    const fieldHeight = bottom - top;
    // Use reference height (tallest single-line input) for font sizing so
    // textareas don't get absurdly large text proportional to their full height.
    const fontRefHeight = refFontHeight ?? fieldHeight;
    const fontSize = Math.max(7, Math.min(16, Math.round(fontRefHeight * 0.45)));
    section.style.overflow = 'hidden';
    input.style.boxSizing = 'border-box';
    input.style.lineHeight = '1.2';
    input.style.height = '100%';
    input.style.width = '100%';
    input.style.margin = '0';
    input.style.color = '#000';

    if (input instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'radio')) {
      input.style.border = 'none';
      input.style.padding = '0';
      // Size the checkmark relative to the actual field box
      input.style.fontSize = Math.max(8, Math.round(fieldHeight * 0.7)) + 'px';
    } else {
      input.style.border = '1px solid transparent';
      input.style.fontSize = fontSize + 'px';
      input.style.padding = '0 4px';
    }

    if (input instanceof HTMLTextAreaElement) {
      section.style.alignItems = 'flex-start';
      input.style.paddingTop = '2px';
    } else {
      section.style.alignItems = 'center';
    }

    section.appendChild(input);
    return section;
  }

  function handleFieldChange(fieldName: string, element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
    const field = formFieldsRef.current.get(fieldName);
    if (!field) return;
    cancelFormFieldTyping();

    let newValue: any;

    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox') {
        newValue = element.checked;
      } else if (element.type === 'radio') {
        newValue = element.value;
      } else {
        newValue = element.value;
      }
    } else if (element instanceof HTMLSelectElement) {
      if (element.multiple) {
        newValue = Array.from(element.selectedOptions).map(opt => opt.value);
      } else {
        newValue = element.value;
      }
    } else {
      newValue = element.value;
    }

    field.value = newValue;
    formFieldValueSnapshotRef.current.set(fieldName, newValue);

    // Track dirty form field and schedule save
    dirtyFormFieldsRef.current.set(fieldName, newValue);
    setSaveStatus('unsaved');
    scheduleFormFieldSave();

    notifyFormDataUpdate();
  }

  function notifyFormDataUpdate() {
    const fields = Array.from(formFieldsRef.current.values()).map(field => ({
      name: field.name,
      type: field.type,
      value: field.value
    }));

    pdf.updateFormData(filePath, { fields });
  }

  function clampPageNumber(pageNum: number): number {
    const totalPages = pdfDocRef.current?.numPages ?? numPages;
    if (totalPages <= 0) return 1;
    return Math.max(1, Math.min(Math.round(pageNum), totalPages));
  }

  function navigateToPage(pageNum: number): void {
    const targetPage = clampPageNumber(pageNum);
    setCurrentPage(targetPage);
    currentPageRef.current = targetPage;

    const pageContainer = pageContainerRefs.current[targetPage - 1];
    if (!pageContainer) return;
    pageContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function resolveDestinationPage(destination: string | any[]): Promise<number | null> {
    const pdfDoc = pdfDocRef.current;
    if (!pdfDoc) return null;

    let explicitDestination: any = destination;
    if (typeof destination === 'string') {
      explicitDestination = await pdfDoc.getDestination(destination);
    }
    if (!Array.isArray(explicitDestination) || explicitDestination.length === 0) {
      return null;
    }

    const pageTarget = explicitDestination[0];
    if (typeof pageTarget === 'number' && Number.isFinite(pageTarget)) {
      // Explicit destinations use zero-based page indexes.
      return clampPageNumber(pageTarget + 1);
    }

    if (pageTarget && typeof pageTarget === 'object') {
      try {
        const pageIndex = await pdfDoc.getPageIndex(pageTarget as any);
        return clampPageNumber(pageIndex + 1);
      } catch {
        return null;
      }
    }

    return null;
  }

  function parsePageNumberFromHash(hash: string): number | null {
    const normalizedHash = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!normalizedHash) return null;

    const params = new URLSearchParams(normalizedHash);
    const pageParam = params.get('page');
    if (pageParam) {
      const pageNumber = Number(pageParam);
      return Number.isFinite(pageNumber) ? clampPageNumber(pageNumber) : null;
    }

    const directPageNumber = Number(normalizedHash);
    return Number.isFinite(directPageNumber) ? clampPageNumber(directPageNumber) : null;
  }

  function createPdfLinkService(): any {
    return {
      externalLinkEnabled: true,
      get pagesCount() {
        return pdfDocRef.current?.numPages ?? numPages;
      },
      set page(value: number) {
        navigateToPage(value);
      },
      get page() {
        return currentPageRef.current;
      },
      set rotation(_value: number) {},
      get rotation() {
        return 0;
      },
      get isInPresentationMode() {
        return false;
      },
      goToDestination: async (destination: string | any[]) => {
        const pageNumber = await resolveDestinationPage(destination);
        if (pageNumber !== null) {
          navigateToPage(pageNumber);
        }
      },
      goToPage: (value: number | string) => {
        const pageNumber = typeof value === 'string' ? Number(value) : value;
        if (Number.isFinite(pageNumber)) {
          navigateToPage(pageNumber);
        }
      },
      goToXY: (pageNumber: number) => {
        navigateToPage(pageNumber);
      },
      addLinkAttributes: (link: HTMLAnchorElement, url: string, newWindow?: boolean) => {
        link.href = url;
        link.rel = 'noopener noreferrer';
        if (newWindow) {
          link.target = '_blank';
        }
        link.addEventListener('click', (event: MouseEvent) => {
          event.preventDefault();
          void openExternal(url).catch((error) => {
            console.error('[PDFViewer] Failed to open external PDF link:', error);
          });
        });
      },
      getDestinationHash: (_destination: any) => '#',
      getAnchorUrl: (hash: any) => (typeof hash === 'string' ? `#${hash}` : '#'),
      setHash: (hash: string) => {
        const pageNumber = parsePageNumberFromHash(hash);
        if (pageNumber !== null) {
          navigateToPage(pageNumber);
        }
      },
      executeNamedAction: (action: string) => {
        switch (action) {
          case 'NextPage':
            navigateToPage(currentPageRef.current + 1);
            break;
          case 'PrevPage':
            navigateToPage(currentPageRef.current - 1);
            break;
          case 'FirstPage':
            navigateToPage(1);
            break;
          case 'LastPage':
            navigateToPage(pdfDocRef.current?.numPages ?? numPages);
            break;
          default:
            break;
        }
      },
      executeSetOCGState: (_action: object) => {}
    };
  }

  async function renderNativePdfAnnotations(
    annotationLayerDiv: HTMLDivElement,
    page: any,
    pageAnnotations: any[],
    viewport: any
  ): Promise<void> {
    const nativeAnnotations = pageAnnotations.filter(annotation => annotation.subtype !== 'Widget');
    if (nativeAnnotations.length === 0) return;
    const linkService = createPdfLinkService();

    const annotationLayer = new (pdfjsLib as any).AnnotationLayer({
      div: annotationLayerDiv,
      accessibilityManager: null,
      annotationCanvasMap: null,
      annotationEditorUIManager: null,
      page,
      viewport: viewport.clone({ dontFlip: true }),
      structTreeLayer: null,
      commentManager: null,
      linkService,
      annotationStorage: null,
    });

    await annotationLayer.render({
      annotations: nativeAnnotations,
      imageResourcesPath: '',
      renderForms: false,
      enableScripting: false,
      hasJSActions: false,
      fieldObjects: null,
      viewport: viewport.clone({ dontFlip: true }),
      div: annotationLayerDiv,
      page,
      linkService,
    });
  }

  async function renderPage(pageNum: number, gen?: number): Promise<boolean> {
    if (!pdfDocRef.current) return false;

    while (renderingPagesRef.current.has(pageNum)) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (gen !== undefined && gen !== renderGenRef.current) return false;
    }

    if (!pdfDocRef.current) return false;
    renderingPagesRef.current.add(pageNum);

    try {
      const page = await pdfDocRef.current.getPage(pageNum);

      // After async getPage: abort if a newer render generation started
      if (gen !== undefined && gen !== renderGenRef.current) return false;

      // Cap DPR at 1 for large PDFs to reduce canvas memory usage.
      // A 51-page PDF at 2x DPR uses ~700MB in canvas memory alone.
      const totalPages = pdfDocRef.current?.numPages ?? numPages;
      const devicePixelRatio = totalPages > VIRT_LARGE_PDF_THRESHOLD
        ? 1
        : (window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: scale * devicePixelRatio });

      const pageContainer = pageContainerRefs.current[pageNum - 1];
      if (!pageContainer) {
        console.warn(`Page container ${pageNum} not found`);
        return false;
      }

      // Don't clear pageContainer yet — we build the new content off-screen
      // in a wrapper and only swap it in at the end, so stale renders that
      // abort at a gen check don't leave the page blank.

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.style.position = 'relative';
      wrapper.style.width = `${viewport.width / devicePixelRatio}px`;
      wrapper.style.height = `${viewport.height / devicePixelRatio}px`;
      wrapper.style.backgroundColor = '#ffffff';

      // Create canvas for PDF page
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) {
        console.error('Failed to get canvas context');
        return false;
      }

      canvas.height = viewport.height;
      canvas.width = viewport.width;
      canvas.style.width = `${viewport.width / devicePixelRatio}px`;
      canvas.style.height = `${viewport.height / devicePixelRatio}px`;
      canvas.className = 'border border-border';
      canvas.style.display = 'block';

      // Render PDF page on canvas
      // AnnotationMode.DISABLE - don't render annotations on canvas
      // Native annotations are rendered into a separate annotation layer.
      const renderContext = {
        canvasContext: context,
        viewport: viewport,
        annotationMode: AnnotationMode.DISABLE,
        canvas: canvas,
      };

      await page.render(renderContext).promise;

      // After async render: abort if a newer render generation started
      if (gen !== undefined && gen !== renderGenRef.current) return false;

      // Wait for canvas to be painted before adding form fields
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      // After async rAF: abort if a newer render generation started
      if (gen !== undefined && gen !== renderGenRef.current) return false;

      // Create text layer for text selection
      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'textLayer';
      textLayerDiv.style.position = 'absolute';
      textLayerDiv.style.top = '0';
      textLayerDiv.style.left = '0';
      textLayerDiv.style.width = `${viewport.width / devicePixelRatio}px`;
      textLayerDiv.style.height = `${viewport.height / devicePixelRatio}px`;
      textLayerDiv.style.zIndex = '1';

      // Render text layer - create text spans for selection
      const textContent = await page.getTextContent();

      // After async getTextContent: abort if stale
      if (gen !== undefined && gen !== renderGenRef.current) return false;

      const textViewport = page.getViewport({ scale });

      textContent.items.forEach((item: any) => {
        if (!item.str) return;

        const span = document.createElement('span');
        span.textContent = item.str;
        span.style.position = 'absolute';
        span.style.whiteSpace = 'pre';
        span.style.transformOrigin = 'left bottom';

        // Apply viewport transformation to convert PDF coordinates to screen coordinates
        const tx = pdfjsLib.Util.transform(
          textViewport.transform,
          item.transform
        );

        const fontSize = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
        span.style.left = tx[4] + 'px';
        span.style.top = (tx[5] - fontSize) + 'px';
        span.style.fontSize = fontSize + 'px';
        span.style.fontFamily = item.fontName || 'sans-serif';

        textLayerDiv.appendChild(span);
      });

      // Create annotation layer for form fields
      const annotationLayerDiv = document.createElement('div');
      annotationLayerDiv.className = 'annotationLayer';
      annotationLayerDiv.style.position = 'absolute';
      annotationLayerDiv.style.top = '0';
      annotationLayerDiv.style.left = '0';
      annotationLayerDiv.style.width = `${viewport.width / devicePixelRatio}px`;
      annotationLayerDiv.style.height = `${viewport.height / devicePixelRatio}px`;
      annotationLayerDiv.style.pointerEvents = 'none';
      annotationLayerDiv.style.zIndex = '2';

      // Get page annotations. Native non-widget annotations are rendered by
      // PDF.js; widget annotations are still rendered via our custom form layer.
      const pageAnnotations = await page.getAnnotations({ intent: 'display' });

      // After async getAnnotations: abort if stale
      if (gen !== undefined && gen !== renderGenRef.current) return false;

      console.log(`Page ${pageNum} has ${pageAnnotations.length} annotations`);

      // Use unscaled viewport for form field positioning
      const formViewport = page.getViewport({ scale });

      try {
        await renderNativePdfAnnotations(annotationLayerDiv, page, pageAnnotations, formViewport);
      } catch (error) {
        console.error(`[PDFViewer] Failed to render native annotations on page ${pageNum}:`, error);
      }

      // After async native annotation render: abort if stale
      if (gen !== undefined && gen !== renderGenRef.current) return false;

      // First pass: find the tallest single-line input height to use as
      // a font size reference. This prevents textareas from getting enormous
      // text proportional to their full (much taller) height.
      let maxSingleLineHeight = 0;
      for (const annotation of pageAnnotations) {
        if (annotation.subtype === 'Widget' && annotation.fieldType) {
          // Single-line text inputs: not multiLine, not checkbox, not radio, not combo/list
          const isSingleLine = !annotation.multiLine && !annotation.checkBox &&
            !annotation.radioButton && !annotation.comboBox && !annotation.listBox;
          if (isSingleLine) {
            const rect = formViewport.convertToViewportRectangle(annotation.rect);
            const h = Math.abs(rect[3] - rect[1]);
            if (h > maxSingleLineHeight) maxSingleLineHeight = h;
          }
        }
      }

      for (const annotation of pageAnnotations) {
        if (annotation.subtype === 'Widget' && annotation.fieldType) {
          const fieldElement = createFormField(annotation, formViewport, maxSingleLineHeight || undefined);
          if (fieldElement && annotation.fieldName) {
            annotationLayerDiv.appendChild(fieldElement);

            const inputElement = fieldElement.firstChild as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
            const metadata = findFormFieldMetadata({
              fieldName: annotation.fieldName,
              page: pageNum,
              rect: annotation.rect,
            });

            const fieldData: FormField = {
              id: metadata?.id,
              index: metadata?.index ?? allFormFieldsRef.current.length,
              name: annotation.fieldName,
              type: getFieldType(annotation),
              page: metadata?.page ?? pageNum,
              value: annotation.fieldValue || '',
              element: inputElement
            };

            formFieldsRef.current.set(annotation.fieldName, fieldData);
            allFormFieldsRef.current.push(fieldData);

            // Add event listeners
            inputElement.addEventListener('input', () => {
              handleFieldChange(annotation.fieldName, inputElement);
            });

            inputElement.addEventListener('change', () => {
              handleFieldChange(annotation.fieldName, inputElement);
            });

            inputElement.addEventListener('focus', () => {
              selectFormField(fieldData);
            });

            inputElement.addEventListener('click', () => {
              selectFormField(fieldData);
            });
          }
        }
      }

      // Create FreeText annotation layer for our custom annotations
      const freeTextLayerDiv = document.createElement('div');
      freeTextLayerDiv.className = 'freeTextAnnotationLayer';
      freeTextLayerDiv.style.position = 'absolute';
      freeTextLayerDiv.style.top = '0';
      freeTextLayerDiv.style.left = '0';
      freeTextLayerDiv.style.width = `${viewport.width / devicePixelRatio}px`;
      freeTextLayerDiv.style.height = `${viewport.height / devicePixelRatio}px`;
      freeTextLayerDiv.style.pointerEvents = 'none'; // Allow click-through by default
      freeTextLayerDiv.style.zIndex = '10';

      // Store ref to layer for later annotation rendering
      annotationLayersRef.current.set(pageNum, freeTextLayerDiv);

      // Final gen check before committing to the DOM — if a newer render
      // started while we were building the wrapper, discard this work.
      if (gen !== undefined && gen !== renderGenRef.current) return false;

      wrapper.appendChild(canvas);
      wrapper.appendChild(textLayerDiv);
      wrapper.appendChild(annotationLayerDiv);
      wrapper.appendChild(freeTextLayerDiv);

      // Now swap: clear old content and insert new content atomically.
      pageContainer.innerHTML = '';
      pageContainer.setAttribute('data-page-number', String(pageNum));
      pageContainer.appendChild(wrapper);

      // Render annotations for this page
      renderAnnotationsForPage(pageNum, scale);
      return true;
    } catch (err) {
      console.error(`Failed to render page ${pageNum}:`, err);
      return false;
    } finally {
      renderingPagesRef.current.delete(pageNum);
    }
  }

  // Render annotations for a specific page
  function renderAnnotationsForPage(pageNum: number, currentScale: number) {
    const layer = annotationLayersRef.current.get(pageNum);
    if (!layer) return;

    layer.querySelectorAll<HTMLElement>('.pdf-annotation').forEach((el) => {
      const cleanup = (el as any)._dragCleanup;
      if (typeof cleanup === 'function') {
        cleanup();
      }
    });

    // Clear existing annotation elements
    layer.innerHTML = '';

    // Get annotations for this page
    const pageAnnotations = annotations.filter(a => a.page === pageNum);

    pageAnnotations.forEach(annotation => {
      const isImage = isImageAnnotation(annotation);
      const shouldFlash = flashAnnotationIds.has(annotation.id);
      const isSelected = selectedAnnotationIds.has(annotation.id) || annotation.id === selectedAnnotationId;

      const div = document.createElement('div');
      div.className = shouldFlash ? 'pdf-annotation file-refreshed-flash' : 'pdf-annotation';
      div.dataset.annotationId = annotation.id;
      div.dataset.annotationKind = isImage ? 'image' : 'text';
      div.dataset.selected = isSelected ? 'true' : 'false';
      div.style.position = 'absolute';
      div.style.left = `${annotation.x * currentScale}px`;
      div.style.top = `${annotation.y * currentScale}px`;
      div.style.width = `${annotation.width * currentScale}px`;
      div.style.height = `${annotation.height * currentScale}px`;
      div.style.pointerEvents = 'auto';
      div.style.cursor = 'move';
      div.style.boxSizing = 'border-box';
      div.style.borderRadius = isImage ? '4px' : '8px';
      div.style.userSelect = 'none';

      if (!isImage) {
        div.style.padding = '2px 4px';
      }

      if (isImage) {
        const img = document.createElement('img');
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        img.style.pointerEvents = 'none';
        img.draggable = false;

        (async () => {
          try {
            img.src = await getFileUrl(annotation.imagePath!);
          } catch (err) {
            console.error('[PDFViewer] Error loading image annotation:', err);
            img.alt = 'Image not found';
          }
        })();

        div.appendChild(img);
      } else {
        const textSpan = document.createElement('span');
        textSpan.textContent = annotation.text;
        textSpan.style.fontSize = `${annotation.fontSize * currentScale}px`;
        textSpan.style.color = `rgb(${annotation.color.r}, ${annotation.color.g}, ${annotation.color.b})`;
        textSpan.style.fontFamily = 'Helvetica, Arial, sans-serif';
        textSpan.style.whiteSpace = 'pre-wrap';
        textSpan.style.wordBreak = 'break-word';
        textSpan.style.pointerEvents = 'none';
        div.appendChild(textSpan);

        div.addEventListener('dblclick', (e) => {
          const target = e.target as HTMLElement;
          if (target.closest('.pdf-annotation-handle')) return;
          e.stopPropagation();
          enterEditMode(div, textSpan, annotation);
        });
      }

      // Click handler for selection (works for both image and text)
      div.addEventListener('click', (e) => {
        e.stopPropagation();

        if (e.shiftKey) {
          // Shift+click: add to multi-selection
          setSelectedAnnotationIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(annotation.id)) {
              newSet.delete(annotation.id);
            } else {
              newSet.add(annotation.id);
            }
            return newSet;
          });
          // Clear single selection
          setSelectedAnnotationId(null);
          setToolbarPosition(null);
        } else {
          // Normal click: single selection (clears multi-selection)
          setSelectedAnnotationIds(new Set([annotation.id]));
          setSelectedFormFieldNames(new Set());
          setSelectedTextSpans(new Set());
          setSelectedAnnotationId(annotation.id);

          // Calculate toolbar position
          const rect = div.getBoundingClientRect();
          setToolbarPosition({
            x: rect.left,
            y: rect.top - 45 // Position above the annotation
          });
        }
      });

      if (isSelected) {
        const dragHandle = document.createElement('div');
        dragHandle.className = 'pdf-annotation-handle pdf-annotation-drag-handle';
        dragHandle.title = 'Drag annotation';
        dragHandle.style.position = 'absolute';
        dragHandle.style.top = `-${RESIZE_HANDLE_SIZE_PX + 2}px`;
        dragHandle.style.left = '50%';
        dragHandle.style.transform = 'translateX(-50%)';
        dragHandle.style.cursor = 'grab';
        dragHandle.style.zIndex = '12';
        dragHandle.textContent = '::';
        div.appendChild(dragHandle);

        setupResizeHandles(div, annotation, currentScale);
      }

      // Drag handlers (works for both image and text)
      setupDragHandlers(div, annotation, currentScale);

      layer.appendChild(div);
    });
  }

  // Enter inline edit mode for an annotation
  function enterEditMode(
    div: HTMLDivElement,
    textSpan: HTMLSpanElement,
    annotation: LocalAnnotation
  ) {
    // Track that we're editing this annotation (skip re-renders while editing)
    editingAnnotationIdRef.current = annotation.id;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = annotation.text;
    input.style.width = '100%';
    input.style.minWidth = '100px';
    input.style.height = '100%';
    input.style.fontSize = textSpan.style.fontSize;
    input.style.color = textSpan.style.color;
    input.style.fontFamily = textSpan.style.fontFamily;
    input.style.backgroundColor = 'transparent';
    input.style.border = 'none';
    input.style.outline = 'none';
    input.style.padding = '0';
    input.style.margin = '0';

    const originalText = annotation.text;

    input.addEventListener('blur', () => {
      // Clear editing state first
      editingAnnotationIdRef.current = null;
      const newText = input.value.trim() || originalText;
      updateAnnotation(annotation.id, { text: newText });
      // Re-render will happen via state change
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = originalText;
        input.blur();
      }
      e.stopPropagation();
    });

    div.replaceChild(input, textSpan);
    input.focus();
    input.select();
  }

  type ResizeDirection = 'nw' | 'ne' | 'sw' | 'se';

  function setupResizeHandles(
    div: HTMLDivElement,
    annotation: LocalAnnotation,
    currentScale: number
  ) {
    const isImage = isImageAnnotation(annotation);
    const minWidth = isImage ? clampImageAnnotationDimension(0) : MIN_TEXT_ANNOTATION_WIDTH;
    const minHeight = isImage ? clampImageAnnotationDimension(0) : MIN_TEXT_ANNOTATION_HEIGHT;

    const handleConfigs: Array<{
      direction: ResizeDirection;
      cursor: string;
      x: 'left' | 'right';
      y: 'top' | 'bottom';
    }> = [
      { direction: 'nw', cursor: 'nwse-resize', x: 'left', y: 'top' },
      { direction: 'ne', cursor: 'nesw-resize', x: 'right', y: 'top' },
      { direction: 'sw', cursor: 'nesw-resize', x: 'left', y: 'bottom' },
      { direction: 'se', cursor: 'nwse-resize', x: 'right', y: 'bottom' },
    ];

    const clampWidth = (value: number) => {
      if (isImage) return Math.max(minWidth, clampImageAnnotationDimension(value));
      return clampTextAnnotationWidth(value);
    };

    const clampHeight = (value: number) => {
      if (isImage) return Math.max(minHeight, clampImageAnnotationDimension(value));
      return clampTextAnnotationHeight(value);
    };

    const resolveResize = (
      direction: ResizeDirection,
      deltaX: number,
      deltaY: number
    ): Pick<LocalAnnotation, 'x' | 'y' | 'width' | 'height'> => {
      let nextX = annotation.x;
      let nextY = annotation.y;
      let nextWidth = annotation.width;
      let nextHeight = annotation.height;

      if (direction.includes('e')) {
        nextWidth = clampWidth(annotation.width + deltaX);
      }
      if (direction.includes('w')) {
        const rawWidth = annotation.width - deltaX;
        nextWidth = clampWidth(rawWidth);
        nextX = annotation.x + (annotation.width - nextWidth);
      }
      if (direction.includes('s')) {
        nextHeight = clampHeight(annotation.height + deltaY);
      }
      if (direction.includes('n')) {
        const rawHeight = annotation.height - deltaY;
        nextHeight = clampHeight(rawHeight);
        nextY = annotation.y + (annotation.height - nextHeight);
      }

      return { x: nextX, y: nextY, width: nextWidth, height: nextHeight };
    };

    handleConfigs.forEach((config) => {
      const handle = document.createElement('div');
      handle.className = 'pdf-annotation-handle pdf-annotation-resize-handle';
      handle.dataset.handleDirection = config.direction;
      handle.style.position = 'absolute';
      handle.style.width = `${RESIZE_HANDLE_SIZE_PX}px`;
      handle.style.height = `${RESIZE_HANDLE_SIZE_PX}px`;
      handle.style.cursor = config.cursor;
      handle.style.zIndex = '12';
      handle.style.left = config.x === 'left' ? `-${RESIZE_HANDLE_SIZE_PX / 2}px` : '';
      handle.style.right = config.x === 'right' ? `-${RESIZE_HANDLE_SIZE_PX / 2}px` : '';
      handle.style.top = config.y === 'top' ? `-${RESIZE_HANDLE_SIZE_PX / 2}px` : '';
      handle.style.bottom = config.y === 'bottom' ? `-${RESIZE_HANDLE_SIZE_PX / 2}px` : '';

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startY = e.clientY;

        const onMouseMove = (moveEvent: MouseEvent) => {
          const deltaX = (moveEvent.clientX - startX) / currentScale;
          const deltaY = (moveEvent.clientY - startY) / currentScale;
          const resized = resolveResize(config.direction, deltaX, deltaY);

          div.style.left = `${resized.x * currentScale}px`;
          div.style.top = `${resized.y * currentScale}px`;
          div.style.width = `${resized.width * currentScale}px`;
          div.style.height = `${resized.height * currentScale}px`;
        };

        const onMouseUp = (upEvent: MouseEvent) => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);

          const deltaX = (upEvent.clientX - startX) / currentScale;
          const deltaY = (upEvent.clientY - startY) / currentScale;
          const resized = resolveResize(config.direction, deltaX, deltaY);

          if (
            Math.abs(resized.x - annotation.x) < 0.01
            && Math.abs(resized.y - annotation.y) < 0.01
            && Math.abs(resized.width - annotation.width) < 0.01
            && Math.abs(resized.height - annotation.height) < 0.01
          ) {
            return;
          }

          updateAnnotation(annotation.id, resized);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });

      div.appendChild(handle);
    });
  }

  // Setup drag handlers for annotation repositioning
  function setupDragHandlers(
    div: HTMLDivElement,
    annotation: LocalAnnotation,
    currentScale: number
  ) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    // Edge scroll settings
    const EDGE_THRESHOLD = 60; // Pixels from edge to start scrolling
    const MAX_SCROLL_SPEED = 20; // Max pixels per frame
    let scrollIntervalId: number | null = null;
    let currentMouseX = 0;
    let currentMouseY = 0;

    // Calculate scroll speed based on distance from edge (closer = faster)
    function getScrollSpeed(distanceFromEdge: number): number {
      if (distanceFromEdge >= EDGE_THRESHOLD) return 0;
      // Exponential curve: closer to edge = much faster
      const ratio = 1 - (distanceFromEdge / EDGE_THRESHOLD);
      return Math.round(MAX_SCROLL_SPEED * ratio * ratio);
    }

    // Edge scroll function called on interval
    function performEdgeScroll() {
      if (!containerRef.current || !isDragging) return;

      const container = containerRef.current;
      const rect = container.getBoundingClientRect();

      // Calculate distances from each edge
      const distFromLeft = currentMouseX - rect.left;
      const distFromRight = rect.right - currentMouseX;
      const distFromTop = currentMouseY - rect.top;
      const distFromBottom = rect.bottom - currentMouseY;

      let scrollX = 0;
      let scrollY = 0;

      // Horizontal scrolling
      if (distFromLeft < EDGE_THRESHOLD && distFromLeft > 0) {
        scrollX = -getScrollSpeed(distFromLeft);
      } else if (distFromRight < EDGE_THRESHOLD && distFromRight > 0) {
        scrollX = getScrollSpeed(distFromRight);
      }

      // Vertical scrolling
      if (distFromTop < EDGE_THRESHOLD && distFromTop > 0) {
        scrollY = -getScrollSpeed(distFromTop);
      } else if (distFromBottom < EDGE_THRESHOLD && distFromBottom > 0) {
        scrollY = getScrollSpeed(distFromBottom);
      }

      // Apply scroll
      if (scrollX !== 0 || scrollY !== 0) {
        container.scrollLeft += scrollX;
        container.scrollTop += scrollY;
      }
    }

    // Start edge scroll interval
    function startEdgeScroll() {
      if (scrollIntervalId !== null) return;
      scrollIntervalId = window.setInterval(performEdgeScroll, 16); // ~60fps
    }

    // Stop edge scroll interval
    function stopEdgeScroll() {
      if (scrollIntervalId !== null) {
        clearInterval(scrollIntervalId);
        scrollIntervalId = null;
      }
    }

    let activeMoveListener: ((e: MouseEvent) => void) | null = null;
    let activeUpListener: ((e: MouseEvent) => void) | null = null;

    const clearDragListeners = () => {
      stopEdgeScroll();
      if (activeMoveListener) {
        document.removeEventListener('mousemove', activeMoveListener);
        activeMoveListener = null;
      }
      if (activeUpListener) {
        document.removeEventListener('mouseup', activeUpListener);
        activeUpListener = null;
      }
      isDragging = false;
      div.style.opacity = '1';
      div.style.zIndex = '';
    };

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.pdf-annotation-resize-handle')) return;
      if (target.tagName === 'INPUT' || target.closest('input, textarea, select')) return;

      const canDragFromTarget =
        target === div
        || target.tagName === 'SPAN'
        || target.tagName === 'IMG'
        || !!target.closest('.pdf-annotation-drag-handle');

      if (!canDragFromTarget) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      currentMouseX = e.clientX;
      currentMouseY = e.clientY;
      origLeft = annotation.x * currentScale;
      origTop = annotation.y * currentScale;
      div.style.opacity = '0.8';
      div.style.zIndex = '100';
      startEdgeScroll();
      e.preventDefault();

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDragging) return;
        currentMouseX = moveEvent.clientX;
        currentMouseY = moveEvent.clientY;

        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        div.style.left = `${origLeft + deltaX}px`;
        div.style.top = `${origTop + deltaY}px`;
      };

      const handleMouseUp = (upEvent: MouseEvent) => {
        if (!isDragging) {
          clearDragListeners();
          return;
        }

        const deltaX = upEvent.clientX - startX;
        const deltaY = upEvent.clientY - startY;
        clearDragListeners();

        if (Math.abs(deltaX) <= 2 && Math.abs(deltaY) <= 2) return;

        const currentSelectedIds = selectedAnnotationIdsRef.current;
        if (currentSelectedIds.has(annotation.id) && currentSelectedIds.size > 1) {
          const updates = new Map<string, Partial<LocalAnnotation>>();
          currentSelectedIds.forEach(id => {
            const ann = annotations.find(a => a.id === id);
            if (ann) {
              updates.set(id, {
                x: ann.x + deltaX / currentScale,
                y: ann.y + deltaY / currentScale
              });
            }
          });
          updateAnnotations(updates);
          return;
        }

        updateAnnotation(annotation.id, {
          x: annotation.x + deltaX / currentScale,
          y: annotation.y + deltaY / currentScale
        });
      };

      activeMoveListener = handleMouseMove;
      activeUpListener = handleMouseUp;
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    };

    div.addEventListener('mousedown', onMouseDown);

    (div as any)._dragCleanup = () => {
      div.removeEventListener('mousedown', onMouseDown);
      clearDragListeners();
    };
  }

  // Listen for fill field requests from backend (works in both Electron and browser mode)
  useEffect(() => {
    const cleanup = pdf.onFillField((data: { filePath: string; identifier: string | number; value: any }) => {
      if (data.filePath !== filePath) return;

      let field: FormField | undefined;

      if (typeof data.identifier === 'number') {
        field = allFormFieldsRef.current[data.identifier];
      } else {
        field = formFieldsRef.current.get(data.identifier);
      }

      if (!field || !field.element) return;

      const element = field.element;

      if (element instanceof HTMLInputElement) {
        if (element.type === 'checkbox') {
          element.checked = normalizeBoolean(data.value);
        } else {
          element.value = String(data.value);
        }
      } else if (element instanceof HTMLSelectElement) {
        if (Array.isArray(data.value)) {
          Array.from(element.options).forEach(option => {
            option.selected = data.value.includes(option.value);
          });
        } else {
          element.value = String(data.value);
        }
      } else {
        element.value = String(data.value);
      }

      element.dispatchEvent(new Event('change', { bubbles: true }));
    });

    return cleanup;
  }, [filePath]);

  function normalizeBoolean(value: any): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lower = value.toLowerCase().trim();
      return ['yes', 'true', 'on', 'checked', '1', 'x'].includes(lower);
    }
    if (typeof value === 'number') return value !== 0;
    return false;
  }

  const zoomIn = () => {
    setScale(prev => Math.min(prev * 1.2, 3.0));
  };

  const zoomOut = () => {
    setScale(prev => prev / 1.2);
  };

  const resetZoom = () => {
    setScale(baseScaleRef.current);
  };

  // Handle pinch-to-zoom (trackpad) and ctrl+scroll (mouse)
  // Uses CSS transform for smooth visual scaling, then debounces the actual re-render
  const handleWheel = useCallback((e: WheelEvent) => {
    // Pinch gestures on macOS trackpad trigger wheel events with ctrlKey: true
    // Ctrl+scroll on mouse also triggers this
    if (!e.ctrlKey && !e.metaKey) return;

    e.preventDefault();

    const container = containerRef.current;
    if (!container) return;

    // Calculate zoom factor based on delta magnitude
    const delta = -e.deltaY;
    const sensitivity = 0.01;
    const zoomFactor = 1 + Math.max(-0.5, Math.min(0.5, delta * sensitivity));

    // Update the CSS transform for instant visual feedback (no re-render)
    setZoomTransform(prev => {
      const newTransform = Math.min(prev * zoomFactor, 5.0 / scale);
      pendingScaleRef.current = scale * newTransform;
      return newTransform;
    });

    // Clear existing timeout
    if (zoomTimeoutRef.current) {
      clearTimeout(zoomTimeoutRef.current);
    }

    // Debounce: after 150ms of no pinching, commit the final scale
    zoomTimeoutRef.current = setTimeout(() => {
      const finalScale = pendingScaleRef.current;
      if (finalScale !== null) {
        setScale(finalScale);
        setZoomTransform(1);
        pendingScaleRef.current = null;
      }
    }, 150);
  }, [scale]);

  // Attach wheel listener for pinch-to-zoom
  // Must depend on `loading` so the listener is attached after the container renders
  // Must depend on `handleWheel` which changes when `scale` changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Use passive: false to allow preventDefault
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [handleWheel, loading]);

  // Utility function for rectangle intersection
  function rectsIntersect(
    rect1: { left: number; top: number; right: number; bottom: number },
    rect2: { left: number; top: number; right: number; bottom: number }
  ): boolean {
    return !(
      rect1.right < rect2.left ||
      rect1.left > rect2.right ||
      rect1.bottom < rect2.top ||
      rect1.top > rect2.bottom
    );
  }

  // Delete all selected annotations
  const deleteSelectedAnnotations = useCallback(async () => {
    if (selectedAnnotationIds.size === 0) return;

    const toDelete = annotations.filter(a => selectedAnnotationIds.has(a.id));
    const originalIds = toDelete
      .filter(a => a.originalId && !a.id.startsWith('local-'))
      .map(a => a.originalId!);

    if (originalIds.length > 0) {
      try {
        await removePdfAnnotations(filePath, originalIds);
      } catch (err) {
        console.error('[PDFViewer] Error deleting annotations:', err);
      }
    }

    setAnnotations(prev => prev.filter(a => !selectedAnnotationIds.has(a.id)));
    clearSelection();
  }, [selectedAnnotationIds, annotations, filePath, clearSelection]);

  // Copy selected text to clipboard
  const copySelectedText = useCallback(() => {
    const textParts: string[] = [];
    selectedTextSpans.forEach(span => {
      if (span.textContent) {
        textParts.push(span.textContent);
      }
    });

    const text = textParts.join(' ');
    if (text) {
      navigator.clipboard.writeText(text);
      console.log('[PDFViewer] Copied text to clipboard:', text.substring(0, 50) + '...');
    }
  }, [selectedTextSpans]);

  // Keyboard shortcuts for selection operations
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Delete key - delete selected annotations
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedAnnotationIds.size > 0 && !editingAnnotationIdRef.current) {
          deleteSelectedAnnotations();
          e.preventDefault();
        }
      }

      // Cmd/Ctrl+C - copy selected text
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        if (selectedTextSpans.size > 0) {
          copySelectedText();
          e.preventDefault();
        }
      }

      // Escape - clear selection
      if (e.key === 'Escape') {
        clearSelection();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedAnnotationIds, selectedTextSpans, deleteSelectedAnnotations, copySelectedText, clearSelection]);

  // Update selection based on marquee rectangle
  const updateSelectionFromMarquee = useCallback(() => {
    if (!marqueeStart || !marqueeEnd || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const scrollLeft = containerRef.current.scrollLeft;
    const scrollTop = containerRef.current.scrollTop;

    // Normalize marquee rectangle (handle drag in any direction)
    const marqueeRect = {
      left: Math.min(marqueeStart.x, marqueeEnd.x),
      top: Math.min(marqueeStart.y, marqueeEnd.y),
      right: Math.max(marqueeStart.x, marqueeEnd.x),
      bottom: Math.max(marqueeStart.y, marqueeEnd.y),
    };

    const newSelectedAnnotations = new Set<string>();
    const newSelectedFormFields = new Set<string>();
    const newSelectedTextSpans = new Set<HTMLSpanElement>();

    // 1. Check annotations
    annotations.forEach(annotation => {
      const layer = annotationLayersRef.current.get(annotation.page);
      if (!layer) return;

      const annotationEl = layer.querySelector(`[data-annotation-id="${annotation.id}"]`);
      if (!annotationEl) return;

      const rect = annotationEl.getBoundingClientRect();
      const elementRect = {
        left: rect.left - containerRect.left + scrollLeft,
        top: rect.top - containerRect.top + scrollTop,
        right: rect.right - containerRect.left + scrollLeft,
        bottom: rect.bottom - containerRect.top + scrollTop,
      };

      if (rectsIntersect(marqueeRect, elementRect)) {
        newSelectedAnnotations.add(annotation.id);
      }
    });

    // 2. Check form fields
    allFormFieldsRef.current.forEach(field => {
      if (!field.element) return;
      const section = field.element.parentElement;
      if (!section) return;

      const rect = section.getBoundingClientRect();
      const elementRect = {
        left: rect.left - containerRect.left + scrollLeft,
        top: rect.top - containerRect.top + scrollTop,
        right: rect.right - containerRect.left + scrollLeft,
        bottom: rect.bottom - containerRect.top + scrollTop,
      };

      if (rectsIntersect(marqueeRect, elementRect)) {
        newSelectedFormFields.add(field.name);
      }
    });

    // 3. Check text spans (on the starting page)
    const pageContainer = pageContainerRefs.current[marqueeStart.pageNum - 1];
    if (pageContainer) {
      const textLayer = pageContainer.querySelector('.textLayer');
      if (textLayer) {
        textLayer.querySelectorAll('span').forEach((span: Element) => {
          const rect = span.getBoundingClientRect();
          const elementRect = {
            left: rect.left - containerRect.left + scrollLeft,
            top: rect.top - containerRect.top + scrollTop,
            right: rect.right - containerRect.left + scrollLeft,
            bottom: rect.bottom - containerRect.top + scrollTop,
          };

          if (rectsIntersect(marqueeRect, elementRect)) {
            newSelectedTextSpans.add(span as HTMLSpanElement);
          }
        });
      }
    }

    setSelectedAnnotationIds(newSelectedAnnotations);
    setSelectedFormFieldNames(newSelectedFormFields);
    setSelectedTextSpans(newSelectedTextSpans);

    // Apply visual styles to text spans
    document.querySelectorAll('.text-span-selected').forEach(el => {
      el.classList.remove('text-span-selected');
    });
    newSelectedTextSpans.forEach(span => {
      span.classList.add('text-span-selected');
    });

    // Apply visual styles to form fields
    document.querySelectorAll('.form-field-selected').forEach(el => {
      el.classList.remove('form-field-selected');
    });
    newSelectedFormFields.forEach(name => {
      const field = formFieldsRef.current.get(name);
      if (field?.element) {
        const section = field.element.parentElement;
        if (section) {
          section.classList.add('form-field-selected');
        }
      }
    });
  }, [marqueeStart, marqueeEnd, annotations]);

  // Mouse down handler for marquee selection
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    // Skip if clicking on an annotation (allow drag-to-move)
    if (target.closest('.pdf-annotation')) {
      return;
    }

    // Skip if clicking on form fields (allow interaction)
    if (target.closest('.annotationLayer section')) {
      return;
    }

    // Let PDF text behave like native PDF text selection.
    if (target.closest('.textLayer')) {
      return;
    }

    // Find the page container
    const pageContainer = target.closest('[data-page-number]') as HTMLElement;
    if (!pageContainer) return;

    const pageNum = parseInt(pageContainer.getAttribute('data-page-number') || '1', 10);
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;

    // Calculate position relative to scroll container
    const x = e.clientX - containerRect.left + (containerRef.current?.scrollLeft || 0);
    const y = e.clientY - containerRect.top + (containerRef.current?.scrollTop || 0);

    setMarqueeStart({ x, y, pageNum });
    setMarqueeEnd({ x, y });
    setIsMarqueeActive(true);

    // Clear previous selection unless Shift is held
    if (!e.shiftKey) {
      clearSelection();
    }

    e.preventDefault();
  }, [clearSelection]);

  // Mouse move handler for marquee
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isMarqueeActive || !marqueeStart) return;

    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;

    const x = e.clientX - containerRect.left + (containerRef.current?.scrollLeft || 0);
    const y = e.clientY - containerRect.top + (containerRef.current?.scrollTop || 0);

    setMarqueeEnd({ x, y });
  }, [isMarqueeActive, marqueeStart]);

  // Mouse up handler for marquee
  const handleMouseUp = useCallback(() => {
    if (!isMarqueeActive) return;

    // Finalize selection
    updateSelectionFromMarquee();

    setIsMarqueeActive(false);
    setMarqueeStart(null);
    setMarqueeEnd(null);
  }, [isMarqueeActive, marqueeStart, marqueeEnd, updateSelectionFromMarquee]);

  // Effect to update selection during marquee drag
  useEffect(() => {
    if (isMarqueeActive && marqueeStart && marqueeEnd) {
      updateSelectionFromMarquee();
    }
  }, [isMarqueeActive, marqueeStart, marqueeEnd, updateSelectionFromMarquee]);

  const goToPage = (page: number) => {
    navigateToPage(page);
  };

  if (loading && showLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-2">
          <div className="text-ui-base font-normal truncate text-muted-foreground" title={filePath}>
            {pathBasename(filePath)}
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          {t('pdf.loading')}
        </div>
      </div>
    );
  }

  if (loading && !showLoading) {
    return (
      <div className="flex flex-col h-full bg-[var(--oa-surface-center)]">
        <div className="voice-focus-content-toolbar px-2 flex items-center" style={{ height: 'var(--unit-height)' }}>
          <div className="text-ui-base font-normal truncate" title={filePath}>
            {pathBasename(filePath)}
          </div>
        </div>
        <div className="voice-focus-content-surface flex-1" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-2 flex items-center" style={{ height: 'var(--unit-height)' }}>
          <div className="text-ui-base font-normal truncate text-muted-foreground" title={filePath}>
            {pathBasename(filePath)}
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="text-muted-foreground">{t('pdf.errorLoad')}</div>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => loadPDF()}
                className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                {t('common.tryAgain')}
              </button>
                <button
                  onClick={() => openFeedbackPopover()}
                  className="px-3 py-1.5 text-ui-base rounded-control bg-muted hover:bg-muted/80 text-foreground transition-colors"
                >
                  {t('common.reportBug')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Handle click on PDF background to deselect annotation
  const handleContainerClick = (e: React.MouseEvent) => {
    // Only deselect if clicking directly on container or page wrapper, not on annotation
    const target = e.target as HTMLElement;
    if (target.closest('.pdf-annotation')) return;

    // Deselect
    clearSelection();
  };

  return (
    <div className="flex flex-col h-full bg-[var(--oa-surface-center)]">
      {/* Toolbar - uses universal row height */}
      <div className="voice-focus-content-toolbar px-2 flex items-center justify-between" style={{ height: 'var(--unit-height)' }}>
        <div className="text-ui-base font-normal truncate flex-1 text-muted-foreground" title={filePath}>
          {pathBasename(filePath)}
        </div>
        <div className="ml-4 flex items-center gap-1.5">
          {!readOnlyRemote ? <>
          {/* Add Annotation Button */}
          <Button
            data-testid={PDF_ADD_ANNOTATION_BUTTON_ID}
            onClick={addAnnotationInCenter}
            variant="outline"
            size="xs"
            className="px-2 font-normal"
            title={t('help.pdf.addAnnotation.title')}
            data-help-title={t('help.pdf.addAnnotation.title')}
            data-help-description={t('help.pdf.addAnnotation.description')}
          >
            {t('pdf.addAnnotation')}
          </Button>

          <Button
            data-testid={PDF_SAVE_BUTTON_ID}
            onClick={() => {
              void flushPendingSaves();
            }}
            variant="outline"
            size="xs"
            disabled={saveStatus === 'saving'}
            title={t('help.pdf.saveNow.title')}
            data-help-title={t('help.pdf.saveNow.title')}
            data-help-description={t('help.pdf.saveNow.description')}
          >
            {t('pdf.saveNow')}
          </Button>

          {/* Save status indicator */}
          {saveStatus === 'unsaved' && (
            <div className="flex items-center gap-1 text-ui-sm text-muted-foreground">
              <div className="w-2 h-2 rounded-full bg-current opacity-50" />
              {t('pdf.status.unsaved')}
            </div>
          )}
          {saveStatus === 'saving' && (
            <div className="text-ui-sm text-muted-foreground">
              {t('pdf.status.saving')}
            </div>
          )}
          {saveStatus === 'saved' && (
            <div className="flex items-center gap-1 text-ui-sm text-muted-foreground">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {t('pdf.status.saved')}
            </div>
          )}
          </> : null}

          <div className="w-px h-4 bg-muted" />

          <Button
            onClick={zoomOut}
            variant="ghost"
            size="xs"
            title={t('help.pdf.zoomOut.title')}
            data-help-title={t('help.pdf.zoomOut.title')}
            data-help-description={t('help.pdf.zoomOut.description')}
          >
            -
          </Button>
          <span className="text-ui-sm min-w-[3rem] text-center text-muted-foreground">
            {Math.round((scale / baseScaleRef.current) * 100)}%
          </span>
          <Button
            onClick={zoomIn}
            variant="ghost"
            size="xs"
            title={t('help.pdf.zoomIn.title')}
            data-help-title={t('help.pdf.zoomIn.title')}
            data-help-description={t('help.pdf.zoomIn.description')}
          >
            +
          </Button>
          <Button
            onClick={resetZoom}
            variant="ghost"
            size="xs"
            title={t('help.pdf.resetZoom.title')}
            data-help-title={t('help.pdf.resetZoom.title')}
            data-help-description={t('help.pdf.resetZoom.description')}
          >
            {t('pdf.resetZoom')}
          </Button>
          <div className="flex items-center gap-1 ml-2">
            <Button
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              variant="ghost"
              size="xs"
              title={t('help.pdf.previousPage.title')}
              data-help-title={t('help.pdf.previousPage.title')}
              data-help-description={t('help.pdf.previousPage.description')}
            >
              ←
            </Button>
            <span className="text-ui-sm px-2 text-muted-foreground">
              {currentPage} / {numPages}
            </span>
            <Button
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= numPages}
              variant="ghost"
              size="xs"
              title={t('help.pdf.nextPage.title')}
              data-help-title={t('help.pdf.nextPage.title')}
              data-help-description={t('help.pdf.nextPage.description')}
            >
              →
            </Button>
          </div>
        </div>
      </div>

      {/* PDF viewer */}
      <div
        ref={containerRef}
        className={`pdf-viewer voice-focus-content-surface flex-1 overflow-auto relative ${isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
        data-pdf-viewer="true"
        data-file-path={filePath}
        data-testid={PDF_VIEWER_ID}
        onClick={handleContainerClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{ cursor: isMarqueeActive ? 'crosshair' : isDragOver ? 'copy' : 'default' }}
      >
        <div
          className="p-4 flex flex-col items-center gap-4"
          style={{
            transform: zoomTransform !== 1 ? `scale(${zoomTransform})` : undefined,
            transformOrigin: 'center top',
            willChange: zoomTransform !== 1 ? 'transform' : undefined,
          }}
        >
          {Array.from({ length: numPages }, (_, i) => {
            // Set placeholder dimensions for unrendered pages so scroll position is correct.
            const dims = pdfPageDimensionsRef.current;
            const placeholderStyle = dims ? {
              width: `${dims.width * scale}px`,
              height: `${dims.height * scale}px`,
            } : undefined;
            return (
              <div
                key={i}
                ref={(el) => {
                  pageContainerRefs.current[i] = el;
                }}
                className="pdf-page-placeholder relative shadow-lg"
                style={placeholderStyle}
              />
            );
          })}
        </div>

        {/* Marquee selection rectangle */}
        {isMarqueeActive && marqueeStart && marqueeEnd && (
          <div
            className="marquee-selection-box"
            style={{
              position: 'absolute',
              left: Math.min(marqueeStart.x, marqueeEnd.x),
              top: Math.min(marqueeStart.y, marqueeEnd.y),
              width: Math.abs(marqueeEnd.x - marqueeStart.x),
              height: Math.abs(marqueeEnd.y - marqueeStart.y),
              border: '1px dashed rgb(59, 130, 246)',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              pointerEvents: 'none',
              zIndex: 100,
            }}
          />
        )}
      </div>

      {/* Annotation Toolbar */}
      {selectedAnnotation && toolbarPosition && (
        <AnnotationToolbar
          fontSize={selectedAnnotation.fontSize}
          color={selectedAnnotation.color}
          position={toolbarPosition}
          onFontSizeChange={(size) => updateAnnotation(selectedAnnotation.id, { fontSize: size })}
          onColorChange={(color) => updateAnnotation(selectedAnnotation.id, { color })}
          onDelete={deleteSelectedAnnotation}
          onClose={() => {
            setSelectedAnnotationId(null);
            setToolbarPosition(null);
          }}
          isImageAnnotation={isImageAnnotation(selectedAnnotation)}
        />
      )}

    </div>
  );
}
