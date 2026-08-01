import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { AudioLines, X } from 'lucide-react';
import { INTERPRETER_OVERLAY_STRIP_RATIO } from '../shared/layout.js';
import { INTERPRETER_OVERLAY_FULLSCREEN_DIM_COLOR } from '../shared/design.js';
import type { OverlayContextItem, OverlayRegionContextItem } from '../shared/ipc.js';
import { AttachmentPreviewPopover } from '../../../agent/components/composer/attachment/AttachmentPreviewPopover';
import { AttachmentChipBody } from '../../../agent/components/composer/attachment/AttachmentChipBody';
import type {
  ComposerAttachmentKind,
  ComposerAttachmentRecord,
  SerializedComposerSubmission,
} from '../../../agent/components/composer/attachment/types';
import { readBlobAsDataUrl, MAX_IMAGE_DATA_URL_BYTES } from '../../../agent/components/composer/attachment/composerPaste';
import { useAttachmentPreviewTrigger } from '../../../agent/components/composer/attachment/useAttachmentPreviewTrigger';
import '../../../agent/components/composer/attachment/attachment.css';

interface InputPanelProps {
  visible: boolean;
  shown: boolean;
  screenshot: string | null;
  transcript: string;
  isRecording: boolean;
  amplitude: number;
  contextItems: OverlayContextItem[];
  selectionInteractionActive: boolean;
  onInputFocusChange: (focused: boolean) => void;
  onDraftChange: (text: string) => void;
  onClearInputContext: () => void;
  onRemoveContextItem: (id: string) => void;
  onFilesDropped: (files: OverlayContextItem[]) => void;
  onSubmit: (submission: SerializedComposerSubmission) => void;
  onVoiceToggle: () => void;
  onDismiss: () => void;
}

type TextScale = 'large' | 'medium' | 'compact';

const TEXT_SCALE_STYLES: Record<TextScale, { fontSize: number; lineHeight: number }> = {
  large: { fontSize: 32, lineHeight: 38 },
  medium: { fontSize: 28, lineHeight: 34 },
  compact: { fontSize: 24, lineHeight: 30 },
};

const MAX_INPUT_HEIGHT = 220;
const MEDIUM_SCALE_ENTER_HEIGHT = 112;
const COMPACT_SCALE_ENTER_HEIGHT = 144;
const OVERLAY_CONTROL_SIZE_PX = 44;

/**
 * Pick the next text scale given the current scale and the measured editor
 * height at that scale. While content is present we only compact the text as
 * the prompt grows; we reset to large once the composer is cleared. Letting
 * the scale bounce back up mid-typing can create a render loop because the
 * narrower line wrapping changes the measured height again on the next frame.
 */
function nextTextScale(current: TextScale, measuredHeight: number, hasContent: boolean): TextScale {
  if (!hasContent) {
    return 'large';
  }

  if (current === 'large') {
    return measuredHeight > MEDIUM_SCALE_ENTER_HEIGHT ? 'medium' : 'large';
  }
  if (current === 'medium') {
    return measuredHeight > COMPACT_SCALE_ENTER_HEIGHT ? 'compact' : 'medium';
  }

  return 'compact';
}

function shouldRenderContextChipIconOnly(item: OverlayContextItem | undefined): boolean {
  return Boolean(
    item?.kind === 'region'
      && item.scopeKind === 'active-app'
      && item.appIconDataUrl,
  );
}

function shouldSuppressContextChipDefaultIcon(item: OverlayContextItem | undefined): boolean {
  return Boolean(
    item?.kind === 'region'
      && item.scopeKind === 'active-app'
      && !item.appIconDataUrl,
  );
}

function shouldHighlightContextChip(item: OverlayContextItem | undefined, highlightedIds: Set<string>): boolean {
  if (!item || !highlightedIds.has(item.id)) {
    return false;
  }

  return !(item.kind === 'region' && item.scopeKind === 'active-app');
}

/**
 * Enter submits, Shift+Enter inserts a newline, and in-flight IME composition
 * never submits. Used both by the textarea's own keydown handler and by the
 * window-level backstop that submits when Enter lands elsewhere in the
 * overlay window (the textarea can lose DOM focus to non-focusable overlay
 * surfaces while the typed draft is still pending).
 */
function isComposerSubmitKeydown(event: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

/**
 * The window-level backstop must not hijack Enter from elements that consume
 * it themselves (the composer textarea, buttons, links, other inputs). It
 * only submits when Enter falls through to a non-interactive target such as
 * document.body after the textarea lost focus.
 */
function shouldWindowEnterBackstopSubmit(target: EventTarget | null, editor: HTMLTextAreaElement | null): boolean {
  if (target !== null && target === editor) {
    return false;
  }
  if (target instanceof HTMLElement
    && target.closest('button, a, input, textarea, select, [contenteditable="true"]')) {
    return false;
  }
  return true;
}

type FocusRetryScheduler = (handler: () => void, delayMs: number) => number;

function scheduleUniqueFocusRetry(
  focusRetryTimers: Map<number, number>,
  delayMs: number,
  scheduler: FocusRetryScheduler,
  callback: () => void,
): void {
  if (focusRetryTimers.has(delayMs)) {
    return;
  }
  const timerId = scheduler(() => {
    focusRetryTimers.delete(delayMs);
    callback();
  }, delayMs);
  focusRetryTimers.set(delayMs, timerId);
}

export const __test__ = {
  nextTextScale,
  fileToOverlayContextItem,
  shouldRenderContextChipIconOnly,
  shouldSuppressContextChipDefaultIcon,
  shouldHighlightContextChip,
  scheduleUniqueFocusRetry,
  isComposerSubmitKeydown,
  shouldWindowEnterBackstopSubmit,
};

function supportsOverlayFileContext(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    file.type.startsWith('image/')
    || file.type === 'application/pdf'
    || file.type.startsWith('text/')
    || name.endsWith('.txt')
    || name.endsWith('.md')
    || name.endsWith('.csv')
    || name.endsWith('.tsv')
    || name.endsWith('.json')
    || name.endsWith('.docx')
    || name.endsWith('.xls')
    || name.endsWith('.xlsm')
    || name.endsWith('.xlsx')
  );
}

async function fileToOverlayContextItem(file: File): Promise<OverlayContextItem | null> {
  if (!supportsOverlayFileContext(file)) {
    console.warn('[InterpreterOverlay] Dropped unsupported file type', {
      name: file.name,
      type: file.type,
      size: file.size,
    });
    return null;
  }

  const id = `overlay-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fileWithPath = file as File & { path?: string };
  const mimeType = file.type || 'application/octet-stream';
  const base = {
    id,
    kind: 'file' as const,
    role: 'reference' as const,
    name: file.name || 'Dropped file',
    mimeType,
    sizeBytes: file.size,
    filePath: fileWithPath.path || null,
    sourceKind: 'dropped-file' as const,
    sourceLabel: 'Dropped file',
  };

  if (mimeType.startsWith('image/') || mimeType === 'application/pdf' || !fileWithPath.path) {
    const dataUrl = await readBlobAsDataUrl(file);
    if (mimeType.startsWith('image/') && dataUrl.length > MAX_IMAGE_DATA_URL_BYTES) {
      console.warn('[InterpreterOverlay] Dropped image is too large for overlay context', {
        name: file.name,
        size: file.size,
      });
      return null;
    }
    return { ...base, dataUrl };
  }

  return base;
}

interface InputPanelContextChipProps {
  attachmentId: string;
  kind: ComposerAttachmentKind;
  label: string;
  appIconDataUrl?: string | null;
  appIconLabel?: string | null;
  iconOnly?: boolean;
  suppressDefaultIcon?: boolean;
  isHighlighted: boolean;
  onClear: () => void;
}

function InputPanelContextChip({
  attachmentId,
  kind,
  label,
  appIconDataUrl,
  appIconLabel,
  iconOnly = false,
  suppressDefaultIcon = false,
  isHighlighted,
  onClear,
}: InputPanelContextChipProps) {
  const {
    wrapperRef,
    previewSourceKey,
    handleMouseEnter,
    handleMouseLeave,
  } = useAttachmentPreviewTrigger<HTMLSpanElement>({
    id: attachmentId,
    kind,
    label,
  });

  const clearContext = useCallback((event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onClear();
  }, [onClear]);

  const handleRemoveClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onClear();
  }, [onClear]);

  const handleContextChipPointerDown = useCallback((event: PointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <span
      ref={wrapperRef}
      data-attachment-preview-key={previewSourceKey}
      data-attachment-kind={kind}
      data-overlay-context-chip-id={attachmentId}
      data-overlay-context-chip-highlighted={isHighlighted ? 'true' : 'false'}
      data-overlay-selection-tooltip-suppress="true"
      aria-label={iconOnly ? label : undefined}
      className={`composer-attachment-chip overlay-input-context-chip${isHighlighted ? ' overlay-input-context-chip-highlight' : ''}`}
      data-overlay-context-chip-icon-only={iconOnly ? 'true' : 'false'}
      onPointerDown={handleContextChipPointerDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <AttachmentChipBody
        kind={kind}
        label={label}
        leadingVisual={appIconDataUrl ? (
          <img
            className="composer-attachment-chip__icon overlay-input-context-chip-app-icon"
            src={appIconDataUrl}
            alt=""
            aria-label={appIconLabel ?? label}
          />
        ) : undefined}
        hideLabel={iconOnly}
        suppressDefaultIcon={suppressDefaultIcon}
        onRemoveClick={handleRemoveClick}
        onRemoveMouseDown={clearContext}
        onRemovePointerDown={clearContext}
        removeButtonDataAttributes={{ 'data-overlay-context-chip-remove-id': attachmentId }}
      />
    </span>
  );
}

export function InputPanel({
  visible,
  shown,
  transcript,
  isRecording,
  amplitude,
  contextItems,
  selectionInteractionActive,
  onInputFocusChange,
  onDraftChange,
  onClearInputContext,
  onRemoveContextItem,
  onFilesDropped,
  onSubmit,
  onVoiceToggle,
  onDismiss,
}: InputPanelProps) {
  const [inputValue, setInputValue] = useState('');
  const [hasComposerContent, setHasComposerContent] = useState(false);
  const [textScale, setTextScale] = useState<TextScale>('medium');
  const [fieldHeight, setFieldHeight] = useState(TEXT_SCALE_STYLES.medium.lineHeight);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const visibleRef = useRef(visible);
  const requestEditorFocusRef = useRef<(() => void) | null>(null);
  const lastSubmitRef = useRef<{ text: string; at: number } | null>(null);
  const pendingLocalDraftRef = useRef(false);
  const [contextAttachments, setContextAttachments] = useState<ComposerAttachmentRecord[]>([]);
  const previousContextItemIdsRef = useRef<Set<string>>(new Set());
  const [highlightedContextItemIds, setHighlightedContextItemIds] = useState<Set<string>>(new Set());
  const highlightedContextAttachmentIds = useMemo(
    () => highlightedContextItemIds,
    [highlightedContextItemIds],
  );
  const resolveAttachmentRecord = useCallback(
    (attachmentId: string) => {
      const contextAttachment = contextAttachments.find((attachment) => attachment.id === attachmentId);
      if (contextAttachment) {
        return contextAttachment;
      }
      return undefined;
    },
    [contextAttachments],
  );
  const stripHeight = `${INTERPRETER_OVERLAY_STRIP_RATIO * 100}%`;
  const panelOpacity = selectionInteractionActive ? 0.03 : 1;
  const targetRegion = contextItems.find(
    (item): item is OverlayRegionContextItem => item.kind === 'region' && item.role === 'target',
  );
  const hasActiveAppTarget = targetRegion?.label.startsWith('Active app:') === true;
  const placeholderText = targetRegion
    ? hasActiveAppTarget
      ? (isRecording ? 'Say what to do...' : 'Ask Interpreter anything...')
      : (isRecording ? 'Say what to do with this region...' : 'Describe what to do with this region...')
    : (isRecording ? 'Say what to do...' : 'Ask Interpreter anything...');
  const hasDraftText = hasComposerContent;
  const buttonMode = isRecording ? 'dismiss' : (hasDraftText ? 'send' : 'voice');
  const { fontSize, lineHeight } = TEXT_SCALE_STYLES[textScale];
  useLayoutEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useLayoutEffect(() => {
    const focusRetryTimers = new Map<number, number>();
    const clearFocusRetryTimers = () => {
      for (const timerId of focusRetryTimers.values()) {
        window.clearTimeout(timerId);
      }
      focusRetryTimers.clear();
    };

    const focusInput = () => {
      if (!visibleRef.current) {
        return false;
      }
      const editor = editorRef.current;
      if (!editor) return false;
      editor.focus();
      clearFocusRetryTimers();
      onInputFocusChange(true);
      return true;
    };

    const scheduleFocusAttempt = (delayMs: number) => {
      scheduleUniqueFocusRetry(
        focusRetryTimers,
        delayMs,
        window.setTimeout,
        requestFocus,
      );
    };

    const requestFocus = () => {
      if (focusInput()) {
        return;
      }

      requestAnimationFrame(() => {
        if (focusInput()) {
          return;
        }

        for (const delayMs of [16, 48, 96, 180, 320, 640, 960, 1280, 1600, 2000]) {
          scheduleFocusAttempt(delayMs);
        }
      });
    };

    requestFocus();

    const handleWindowFocus = () => {
      requestFocus();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestFocus();
      }
    };

    const unsubscribe = window.overlay.onRequestInputFocus(() => {
      requestFocus();
    });

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    requestEditorFocusRef.current = requestFocus;

    return () => {
      requestEditorFocusRef.current = null;
      unsubscribe();
      clearFocusRetryTimers();
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [onInputFocusChange]);

  useLayoutEffect(() => {
    if (!visible) {
      return;
    }

    requestEditorFocusRef.current?.();
  }, [visible]);

  useEffect(() => {
    if (visible) {
      return;
    }

    editorRef.current?.blur();
    onInputFocusChange(false);
  }, [onInputFocusChange, visible]);

  useEffect(() => {
    if (!visible) {
      setInputValue('');
      setHasComposerContent(false);
      setTextScale('medium');
      setFieldHeight(TEXT_SCALE_STYLES.medium.lineHeight);
      lastSubmitRef.current = null;
      pendingLocalDraftRef.current = false;
    }
  }, [visible]);

  useEffect(() => {
    if (contextItems.length === 0) {
      setContextAttachments([]);
      previousContextItemIdsRef.current = new Set();
      return;
    }

    const previousIds = previousContextItemIdsRef.current;
    const currentIds = new Set(contextItems.map((item) => item.id));
    const addedIds = contextItems
      .filter((item) => !previousIds.has(item.id))
      .filter((item) => !(item.kind === 'region' && item.scopeKind === 'active-app'))
      .map((item) => item.id);
    previousContextItemIdsRef.current = currentIds;

    // The computer-state (active-app) card renders at the end of the chip
    // row; reference and file chips come first. Display order only — the
    // service's contextItems order (packet order) is unchanged.
    const displayOrderedItems = [
      ...contextItems.filter((item) => !(item.kind === 'region' && item.scopeKind === 'active-app')),
      ...contextItems.filter((item) => item.kind === 'region' && item.scopeKind === 'active-app'),
    ];
    setContextAttachments(displayOrderedItems.map((item): ComposerAttachmentRecord => {
      if (item.kind === 'region') {
        return {
          id: item.id,
          kind: 'pasted-text',
          label: item.role === 'target' ? item.label : item.label,
          mimeType: item.previewImageDataUrl ? 'image/png' : 'text/plain',
          text: item.previewText ?? undefined,
          dataUrl: item.previewImageDataUrl ?? undefined,
        };
      }
      return {
        id: item.id,
        kind: item.mimeType.startsWith('image/') ? 'file-image' : 'pasted-text',
        label: item.name,
        mimeType: item.mimeType,
        size: item.sizeBytes,
        dataUrl: item.dataUrl,
      };
    }));

    if (addedIds.length > 0) {
      setHighlightedContextItemIds((current) => new Set([...current, ...addedIds]));
      const timeoutId = window.setTimeout(() => {
        setHighlightedContextItemIds((current) => {
          const next = new Set(current);
          for (const id of addedIds) {
            next.delete(id);
          }
          return next;
        });
      }, 900);
      return () => window.clearTimeout(timeoutId);
    }
  }, [contextItems]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    if (pendingLocalDraftRef.current && !isRecording) {
      if (transcript === inputValue) {
        pendingLocalDraftRef.current = false;
      } else {
        return;
      }
    }

    if (transcript !== inputValue) {
      setInputValue(transcript);
      setHasComposerContent(transcript.trim().length > 0);
    }
  }, [inputValue, isRecording, transcript, visible]);

  const submitIfFresh = useCallback(
    (submission: SerializedComposerSubmission | undefined) => {
      const trimmedText = submission?.text.trim() || inputValue.trim();
      const attachments = submission?.attachments ?? [];
      if (!trimmedText && attachments.length === 0) return;

      const now = Date.now();
      const signature = `${trimmedText}|${attachments.map((a) => a.id).join(',')}`;
      if (
        lastSubmitRef.current
        && lastSubmitRef.current.text === signature
        && now - lastSubmitRef.current.at < 250
      ) {
        return;
      }

      lastSubmitRef.current = { text: signature, at: now };
      pendingLocalDraftRef.current = false;
      onSubmit({
        text: trimmedText,
        attachments,
      });
    },
    [inputValue, onSubmit],
  );

  const handleSubmit = useCallback(() => {
    submitIfFresh({ text: inputValue, attachments: [] });
  }, [inputValue, submitIfFresh]);

  // Window-level Enter backstop: the textarea can lose DOM focus to
  // non-focusable overlay surfaces (context chips, panel padding, the
  // selection capture layer) while the typed draft is still pending. The
  // input panel owns Enter-to-submit in input mode, so submit whenever an
  // unclaimed Enter reaches the window. The textarea's own keydown handler
  // keeps handling Enter/Shift+Enter while it is focused.
  useEffect(() => {
    if (!visible) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (!isComposerSubmitKeydown(event)) {
        return;
      }
      if (!shouldWindowEnterBackstopSubmit(event.target, editorRef.current)) {
        return;
      }
      event.preventDefault();
      handleSubmit();
    };

    window.addEventListener('keydown', handleWindowKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true);
    };
  }, [handleSubmit, visible]);

  const handleFilesDropped = useCallback(async (files: File[]) => {
    const contextFiles = (await Promise.all(files.map(fileToOverlayContextItem)))
      .filter((item): item is OverlayContextItem => item !== null);
    if (contextFiles.length > 0) {
      onFilesDropped(contextFiles);
    }
  }, [onFilesDropped]);

  const handleNativeFileDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleNativeFileDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void handleFilesDropped(files);
  }, [handleFilesDropped]);

  useEffect(() => {
    if (!shown || selectionInteractionActive) {
      return;
    }

    const handleDocumentDragOver = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    };

    const handleDocumentDrop = (event: globalThis.DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void handleFilesDropped(files);
    };

    document.addEventListener('dragover', handleDocumentDragOver, true);
    document.addEventListener('drop', handleDocumentDrop, true);
    return () => {
      document.removeEventListener('dragover', handleDocumentDragOver, true);
      document.removeEventListener('drop', handleDocumentDrop, true);
    };
  }, [handleFilesDropped, selectionInteractionActive, shown]);

  const handleComposerChange = useCallback(
    (nextText: string) => {
      pendingLocalDraftRef.current = true;
      setInputValue(nextText);
      setHasComposerContent(nextText.trim().length > 0);
      // onDraftChange carries the display text (for voice transcript merging
      // and service-side state); overlay file context stays in context chips.
      onDraftChange(nextText);
    },
    [onDraftChange],
  );

  const handleComposerHeightChange = useCallback(
    () => {
      const editor = editorRef.current;
      const measuredHeight = editor?.scrollHeight ?? lineHeight;
      const nextHeight = Math.min(Math.max(measuredHeight, lineHeight), MAX_INPUT_HEIGHT);
      setFieldHeight(nextHeight);
    },
    [lineHeight],
  );

  useLayoutEffect(() => {
    handleComposerHeightChange();
  }, [handleComposerHeightChange, inputValue, textScale]);

  const handlePrimaryAction = () => {
    if (buttonMode === 'dismiss') {
      onDismiss();
      return;
    }

    if (buttonMode === 'voice') {
      onVoiceToggle();
      return;
    }

    handleSubmit();
  };

  const handleButtonMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      <style>{`
        .input-panel-field::placeholder {
          color: rgba(255, 255, 255, 0.6);
        }

        .input-panel-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          pointer-events: none;
          color: rgba(255, 255, 255, 0.56);
          font-size: 32px;
          font-weight: 470;
          letter-spacing: -0.02em;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .input-panel-placeholder-text {
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .input-panel-placeholder-keycap {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 24px;
          padding: 0 8px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.06);
          color: rgba(255, 255, 255, 0.72);
          font-size: 15px;
          font-weight: 600;
          letter-spacing: 0;
          flex: 0 0 auto;
          transform: translateY(4px);
        }

        .overlay-input-context-chip {
          flex: 0 0 auto;
          max-width: min(18rem, 28vw);
          min-height: 0;
          margin: 0 0 4px;
          padding: 3px 7px 3px 6px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.22);
          background: rgba(255, 255, 255, 0.14);
          color: rgba(255, 255, 255, 0.92);
          line-height: 1.15;
          vertical-align: middle;
          transform: translateY(-0.15em);
          box-shadow: none;
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
        }

        .overlay-input-context-chip:hover {
          background: rgba(255, 255, 255, 0.18);
          border-color: rgba(255, 255, 255, 0.28);
          color: rgba(255, 255, 255, 0.96);
        }

        .overlay-input-context-chip-highlight {
          animation: overlay-context-chip-highlight 620ms ease-out 1;
        }

        @keyframes overlay-context-chip-highlight {
          0% {
            opacity: 1;
            border-color: rgba(255, 255, 255, 0.38);
            background: rgba(255, 255, 255, 0.22);
            box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.16);
          }
          45% {
            border-color: rgba(255, 255, 255, 0.32);
            background: rgba(255, 255, 255, 0.2);
            box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.08);
          }
          100% {
            opacity: 1;
            border-color: rgba(255, 255, 255, 0.22);
            background: rgba(255, 255, 255, 0.14);
            box-shadow: 0 0 0 0 rgba(255, 255, 255, 0);
          }
        }

        .overlay-input-context-chip .composer-attachment-chip__icon,
        .overlay-input-context-chip .composer-attachment-chip__remove {
          color: rgba(255, 255, 255, 0.78);
        }

        .overlay-input-context-chip-app-icon {
          width: 16px;
          height: 16px;
          border-radius: 4px;
          object-fit: cover;
          filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.24));
        }

        .overlay-input-context-chip .composer-attachment-chip__label {
          font-size: inherit;
          font-weight: 500;
          letter-spacing: 0;
        }

        .overlay-input-context-chip[data-overlay-context-chip-icon-only='true'] {
          padding: 4px;
          gap: 0;
        }

        .overlay-input-context-chip[data-overlay-context-chip-icon-only='true'] .composer-attachment-chip__label {
          position: absolute;
          width: 1px;
          height: 1px;
          overflow: hidden;
          clip: rect(0 0 0 0);
          white-space: nowrap;
        }

        .overlay-input-context-chip[data-overlay-context-chip-icon-only='true'] .overlay-input-context-chip-app-icon {
          width: 22px;
          height: 22px;
          border-radius: 6px;
        }

        .overlay-input-context-chip[data-overlay-context-chip-icon-only='true'] .composer-attachment-chip__remove {
          position: absolute;
          top: -7px;
          right: -7px;
          width: 15px;
          height: 15px;
          margin-left: 0;
          border-radius: 999px;
        }

        .overlay-input-context-chip .composer-attachment-chip__remove {
          width: 20px;
          height: 20px;
          margin-left: 4px;
          border-radius: 7px;
          opacity: 1;
          color: rgba(255, 255, 255, 0.96);
          background: rgba(255, 255, 255, 0.16);
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
          cursor: pointer;
        }

        .overlay-input-context-chip .composer-attachment-chip__remove:hover {
          background: rgba(255, 255, 255, 0.24);
          color: #ffffff;
        }

        .overlay-primary-button {
          display: flex;
          align-items: center;
          justify-content: center;
          width: ${OVERLAY_CONTROL_SIZE_PX}px;
          height: ${OVERLAY_CONTROL_SIZE_PX}px;
          flex: 0 0 ${OVERLAY_CONTROL_SIZE_PX}px;
          padding: 0;
          border-radius: 999px;
          box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
          transition:
            opacity 150ms ease,
            transform 150ms ease,
            background-color 150ms ease,
            border-color 150ms ease,
            color 150ms ease;
        }

      `}</style>

      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: '100%',
          height: stripHeight,
          pointerEvents: 'none',
          zIndex: 1,
          opacity: shown ? panelOpacity : 0,
          transition: 'opacity 100ms ease-out',
          background: 'linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.64) 18%, rgba(0,0,0,0.44) 40%, rgba(0,0,0,0.20) 68%, rgba(0,0,0,0) 100%)',
        }}
      >
        {/* Screenshot strip intentionally disabled; keep this as a pure bottom readability ramp. */}
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: INTERPRETER_OVERLAY_FULLSCREEN_DIM_COLOR,
          pointerEvents: 'none',
          zIndex: 2,
          opacity: shown ? 1 : 0,
          transition: 'opacity 100ms ease-out',
        }}
      />

      {isRecording && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            width: '100%',
            height: stripHeight,
            background: 'linear-gradient(to top, rgba(255, 255, 255, 0.8) 0%, rgba(255, 255, 255, 0) 100%)',
            pointerEvents: 'none',
            zIndex: 2,
            transform: `translateY(${20 - amplitude * 20}px)`,
            opacity: shown ? (0.3 + amplitude * 0.7) * panelOpacity : 0,
            transition: 'transform 27ms ease-out, opacity 100ms ease-out',
          }}
        />
      )}

      <div
        data-interactive
        data-overlay-selection-tooltip-suppress="true"
        style={{
          position: 'absolute',
          left: '40px',
          bottom: '50px',
          right: '40px',
          pointerEvents: selectionInteractionActive ? 'none' : 'auto',
          zIndex: 3,
          display: 'flex',
          alignItems: 'flex-end',
          gap: '16px',
          opacity: shown ? panelOpacity : 0,
          transform: shown ? 'translateY(0)' : 'translateY(10px)',
          transition: 'opacity 100ms ease-out, transform 100ms ease-out',
        }}
        onClick={(event) => event.stopPropagation()}
        onDragOver={handleNativeFileDragOver}
        onDrop={handleNativeFileDrop}
      >
        <div
          data-overlay-selection-tooltip-suppress="true"
          style={{
            display: 'flex',
            flex: 1,
            minWidth: 0,
            alignItems: 'flex-end',
            gap: '12px',
            minHeight: `${fieldHeight}px`,
          }}
        >
          <div
            style={{
              display: 'flex',
              flex: 1,
              minWidth: 0,
              position: 'relative',
              alignItems: 'flex-end',
              minHeight: `${fieldHeight}px`,
            }}
          >
            {!inputValue && (
              <div className="input-panel-placeholder">
                <span className="input-panel-placeholder-text">{placeholderText}</span>
              </div>
            )}
            <div
              className="input-panel-field"
              data-overlay-editor-area="true"
              data-overlay-selection-tooltip-suppress="true"
              style={{
                flex: 1,
                minHeight: `${lineHeight}px`,
                height: `${fieldHeight}px`,
                color: 'white',
                fontWeight: 500,
                paddingRight: '12px',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              }}
            >
              <textarea
                ref={editorRef}
                className="overlay-fast-text-input"
                readOnly={isRecording}
                aria-readonly={isRecording || undefined}
                value={inputValue}
                spellCheck={false}
                rows={1}
                data-overlay-selection-tooltip-suppress="true"
                onChange={(event) => handleComposerChange(event.target.value)}
                onInput={handleComposerHeightChange}
                onFocus={() => onInputFocusChange(true)}
                onBlur={() => onInputFocusChange(false)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Backspace'
                    && !event.shiftKey
                    && !event.metaKey
                    && !event.ctrlKey
                    && !event.altKey
                    && !inputValue.trim()
                    && contextAttachments.length > 0
                  ) {
                    onClearInputContext();
                    return;
                  }

                  if (isComposerSubmitKeydown({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent.isComposing,
                  })) {
                    event.preventDefault();
                    handleSubmit();
                  }
                }}
                style={{
                  width: '100%',
                  height: `${fieldHeight}px`,
                  maxHeight: `${MAX_INPUT_HEIGHT}px`,
                  resize: 'none',
                  overflowY: fieldHeight >= MAX_INPUT_HEIGHT ? 'auto' : 'hidden',
                  border: 0,
                  outline: 'none',
                  padding: 0,
                  margin: 0,
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  fontSize: `${fontSize}px`,
                  lineHeight: `${lineHeight}px`,
                  caretColor: 'white',
                }}
              />
            </div>
          </div>

          {contextAttachments.map((contextAttachment) => {
            const contextItem = contextItems.find((item) => item.id === contextAttachment.id);
            return (
              <InputPanelContextChip
                key={contextAttachment.id}
                attachmentId={contextAttachment.id}
                kind={contextAttachment.kind}
                label={contextAttachment.label}
                appIconDataUrl={contextItem?.kind === 'region' ? contextItem.appIconDataUrl : null}
                appIconLabel={contextItem?.kind === 'region' ? contextItem.appIconLabel : null}
                iconOnly={shouldRenderContextChipIconOnly(contextItem)}
                suppressDefaultIcon={shouldSuppressContextChipDefaultIcon(contextItem)}
                isHighlighted={shouldHighlightContextChip(contextItem, highlightedContextAttachmentIds)}
                onClear={() => onRemoveContextItem(contextAttachment.id)}
              />
            );
          })}
        </div>

        <button
          className="overlay-primary-button"
          onClick={handlePrimaryAction}
          onMouseDown={handleButtonMouseDown}
          data-overlay-primary-action="true"
          data-overlay-selection-tooltip-suppress="true"
          data-overlay-hover-tooltip={
            buttonMode === 'voice'
              ? 'Start voice mode'
              : buttonMode === 'dismiss'
                ? 'Exit voice mode'
                : 'Send'
          }
          data-overlay-hover-tooltip-shortcut={
            buttonMode === 'voice' && !isRecording ? 'CTRL+SPACE' : undefined
          }
          data-overlay-hover-tooltip-shortcut-prefix={
            buttonMode === 'voice' && !isRecording ? 'Hold' : undefined
          }
          aria-label={
            buttonMode === 'voice'
              ? 'Start voice input'
              : buttonMode === 'dismiss'
                ? 'Exit voice mode'
                : 'Send request'
          }
          style={{
            background: 'rgba(255, 255, 255, 0.92)',
            border: '1px solid rgba(255, 255, 255, 0.96)',
            color: 'rgba(17, 20, 24, 0.94)',
            cursor: 'default',
            opacity: buttonMode === 'send' && !hasDraftText ? 0.5 : 1,
          }}
        >
          {buttonMode === 'dismiss' ? (
            <X size={20} strokeWidth={2.25} aria-hidden="true" style={{ pointerEvents: 'none' }} />
          ) : buttonMode === 'voice' ? (
            <AudioLines
              size={20}
              strokeWidth={2}
              aria-hidden="true"
              style={{
                pointerEvents: 'none',
                transform: 'scaleY(1)',
                opacity: 1,
                transition: 'transform 90ms ease-out, opacity 90ms ease-out',
              }}
            />
          ) : (
            <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ pointerEvents: 'none' }}>
              <path d="M8 11V4.5M5.25 7.25L8 4.5L10.75 7.25" />
            </svg>
          )}
        </button>
      </div>

      <AttachmentPreviewPopover resolveRecord={resolveAttachmentRecord} />
    </>
  );
}
