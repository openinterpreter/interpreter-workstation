import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react';
import { useEffect, useRef, useState } from 'react';
import { AudioLines, ChevronDown, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReviewAction } from '../shared/ipc.js';
import type { PillMode } from '../shared/types.js';
import { AgentMarker, OVERLAY_AGENT_MARKER_LAYOUT_ID } from './AgentMarker.js';

type PillShellStyle = CSSProperties & {
  '--pill-accent': string;
};

interface PillInputState {
  value: string;
  isRecording: boolean;
  isExpanded: boolean;
  placeholder: string;
  buttonMode: 'send' | 'voice' | 'dismiss';
  canSubmit: boolean;
  inputRef: Ref<HTMLTextAreaElement>;
  onChange: (value: string) => void;
  onPrimaryAction: () => void;
  onSubmit: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onFocusChange: (focused: boolean) => void;
}

export interface PillExecutionProgress {
  label: string;
  current: number;
  total: number;
}

interface PillProps {
  mode: PillMode;
  onAccept: () => void;
  onAcceptAllSession?: () => void;
  onReject: () => void;
  ctrlPressed?: boolean; // Track if ctrl is currently being held
  reviewAction?: ReviewAction | null;
  reviewActionCount?: number;
  executionProgress?: PillExecutionProgress | null;
  attachedToTarget?: boolean;
  inputState?: PillInputState | null;
  inlineMarkerVariant?: 'dot' | 'send' | null;
  disableInitialContentAnimation?: boolean;
  fixedShellSize?: { width: number; height: number } | null;
  primaryColor?: string;
}

const PILL_LAYOUT_TRANSITION = {
  type: 'spring',
  stiffness: 420,
  damping: 34,
  mass: 0.82,
} as const;

const PILL_CONTENT_EASE = [0.16, 1, 0.3, 1] as const;
const PILL_CONTENT_DURATION_S = 0.1;

function getContentKey(
  mode: PillMode,
  inputState: PillInputState | null,
): string {
  if (inputState) {
    return 'input';
  }

  if (mode.kind === 'review') {
    return mode.hotkeyLabel ? 'review-hotkey' : 'review';
  }

  if (mode.kind === 'loading') {
    return 'executing';
  }

  if (mode.kind === 'error') {
    return 'error';
  }

  return mode.kind;
}

function getShellRadius(mode: PillMode): number {
  if (mode.kind === 'review') return 0;
  return mode.kind === 'error' || mode.kind === 'message' ? 20 : 999;
}

export function Pill({
  mode,
  onAccept,
  onAcceptAllSession,
  onReject,
  ctrlPressed = false,
  reviewAction = null,
  reviewActionCount = 0,
  executionProgress = null,
  inputState = null,
  inlineMarkerVariant = null,
  disableInitialContentAnimation = false,
  fixedShellSize = null,
  primaryColor = '#2f7cff',
}: PillProps) {
  const contentKey = getContentKey(mode, inputState);
  const [acceptMenuOpen, setAcceptMenuOpen] = useState(false);
  const acceptMenuRef = useRef<HTMLDivElement | null>(null);
  const shellRadius = getShellRadius(mode);
  const shouldReduceMotion = false;
  const isInputPill = inputState !== null;

  useEffect(() => {
    if (!acceptMenuOpen) {
      return;
    }

    const closeMenu = (event: MouseEvent) => {
      if (acceptMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setAcceptMenuOpen(false);
    };

    document.addEventListener('mousedown', closeMenu, true);
    return () => document.removeEventListener('mousedown', closeMenu, true);
  }, [acceptMenuOpen]);

  const isExecutingPill = mode.kind === 'loading' && executionProgress !== null;
  if (
    !isInputPill
    && !isExecutingPill
    && mode.kind !== 'message'
    && (mode.kind !== 'review' || reviewAction === null)
  ) {
    return null;
  }
  const isExpandedInput = inputState?.isExpanded === true;
  const isTargetAttachedReview = mode.kind === 'review' && reviewAction !== null && reviewAction.type !== 'hotkey';
  const shouldRenderInlineMarker = inlineMarkerVariant !== null;
  const pillClassName = [
    'pill',
    isInputPill ? 'pill-input-mode' : `pill-${mode.kind}`,
    isInputPill ? 'pill-input' : '',
    isExpandedInput ? 'pill-input-multiline' : '',
    isTargetAttachedReview ? 'pill-review-attached' : '',
  ].filter(Boolean).join(' ');

  const renderInlineMarker = (): ReactNode => (
    inlineMarkerVariant ? (
      <AgentMarker
        className="overlay-agent-marker-inline"
        layoutId={OVERLAY_AGENT_MARKER_LAYOUT_ID}
        variant={inlineMarkerVariant}
        size={inlineMarkerVariant === 'send' ? 'input' : 'compact'}
      />
    ) : null
  );

  const acceptAllSessionLabel = 'Accept all for this session';
  const handleAcceptClick = () => {
    setAcceptMenuOpen(false);
    onAccept();
  };
  const handleAcceptMenuToggle = () => {
    setAcceptMenuOpen((open) => !open);
  };
  const handleAcceptAllSession = () => {
    setAcceptMenuOpen(false);
    onAcceptAllSession?.();
  };
  const inputButtonLabel = inputState
    ? (
        inputState.buttonMode === 'voice'
          ? 'Start voice input'
          : inputState.buttonMode === 'dismiss'
            ? 'Exit voice mode'
            : 'Send request'
      )
    : '';

  const renderContent = (pillMode: PillMode): ReactNode => {
    if (inputState) {
      return (
        <motion.div
          layout="position"
          className={`pill-input-shell${isExpandedInput ? ' pill-input-shell-multiline' : ''}`}
        >
          <textarea
            ref={inputState.inputRef}
            autoFocus
            rows={1}
            data-overlay-selection-tooltip-suppress="true"
            value={inputState.value}
            readOnly={inputState.isRecording}
            aria-readonly={inputState.isRecording || undefined}
            onChange={(event) => inputState.onChange(event.target.value)}
            onKeyDown={inputState.onKeyDown}
            onFocus={() => inputState.onFocusChange(true)}
            onBlur={() => inputState.onFocusChange(false)}
            placeholder={inputState.placeholder}
            className="pill-input-field"
          />
          <button
            className={`pill-input-send-hit-target${isExpandedInput ? ' pill-input-send-hit-target-multiline' : ''}`}
            onClick={inputState.onPrimaryAction}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            data-overlay-selection-tooltip-suppress="true"
            data-overlay-hover-tooltip={
              inputState.buttonMode === 'voice'
                ? 'Start voice mode'
                : inputState.buttonMode === 'dismiss'
                  ? 'Exit voice mode'
                : 'Send'
            }
            data-overlay-hover-tooltip-shortcut={
              inputState.buttonMode === 'voice' ? 'CTRL+SPACE' : undefined
            }
            data-overlay-hover-tooltip-shortcut-prefix={
              inputState.buttonMode === 'voice' ? 'Hold' : undefined
            }
            aria-label={inputButtonLabel}
            style={{
              opacity: inputState.buttonMode === 'send' && !inputState.canSubmit ? 0.5 : 1,
            }}
          >
            {inputState.buttonMode === 'dismiss' ? (
              <X
                className="pill-input-send-icon"
                size={16}
                strokeWidth={2.25}
                aria-hidden="true"
              />
            ) : inputState.buttonMode === 'voice' ? (
              <AudioLines
                className="pill-input-send-icon"
                size={16}
                strokeWidth={2}
                aria-hidden="true"
                style={{
                  transform: 'scaleY(1)',
                  opacity: 1,
                  transition: 'transform 100ms ease-out, opacity 100ms ease-out',
                }}
              />
            ) : (
              <svg
                className="pill-input-send-icon"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M8 11V4.5M5.25 7.25L8 4.5L10.75 7.25"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.55"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </motion.div>
      );
    }

    if (pillMode.kind === 'message') {
      return (
        <div className="pill-message" data-overlay-message-pill="true">
          {pillMode.message}
        </div>
      );
    }

    if (pillMode.kind === 'loading') {
      if (!executionProgress) {
        return null;
      }
      return (
        <div className="pill-execution-status" data-overlay-execution-pill="true">
          <span className="pill-execution-label">{executionProgress.label}</span>
          <span className="pill-execution-separator" aria-hidden="true">·</span>
          <span className="pill-execution-progress">
            {executionProgress.current}/{executionProgress.total}
          </span>
        </div>
      );
    }

    if (pillMode.kind === 'review') {
      return (
        <div className="approval-review-control">
          {shouldRenderInlineMarker ? renderInlineMarker() : null}
          <motion.div layout="position" className="approval-review-action approval-review-accept-action">
            <div className="approval-review-accept-group" ref={acceptMenuRef}>
            <button
              className={`approval-review-button approval-review-accept approval-review-accept-primary${ctrlPressed ? ' approval-review-button-pressed' : ''}`}
              onClick={handleAcceptClick}
              onMouseDown={(e) => e.stopPropagation()}
              data-interactive="true"
              data-overlay-review-accept="true"
            >
              <span className={`approval-review-keycap${ctrlPressed ? ' approval-review-keycap-pressed' : ''}`}>⌃ Ctrl</span>
              <span>to approve</span>
              {reviewActionCount > 0 ? (
                <span className="approval-review-count">
                  {`· ${reviewActionCount} ${reviewActionCount === 1 ? 'action' : 'actions'}`}
                </span>
              ) : null}
            </button>
            <button
              className={`approval-review-button approval-review-accept-menu-button${acceptMenuOpen ? ' approval-review-menu-open' : ''}`}
              onClick={handleAcceptMenuToggle}
              onMouseDown={(e) => e.stopPropagation()}
              data-interactive="true"
              aria-label="Accept options"
              aria-expanded={acceptMenuOpen}
              aria-haspopup="menu"
            >
              <ChevronDown size={15} strokeWidth={2.4} aria-hidden="true" />
            </button>
            {acceptMenuOpen ? (
              <div
                className="approval-review-menu"
                role="menu"
                data-interactive="true"
              >
                <button
                  type="button"
                  className="approval-review-menu-item"
                  role="menuitem"
                  onClick={handleAcceptAllSession}
                  onMouseDown={(e) => e.stopPropagation()}
                  data-interactive="true"
                >
                  {acceptAllSessionLabel}
                </button>
              </div>
            ) : null}
            </div>
          </motion.div>
          <motion.div layout="position" className="approval-review-action">
            <button
              className="approval-review-button approval-review-reject"
              onClick={onReject}
              onMouseDown={(e) => e.stopPropagation()}
              data-interactive="true"
            >
              <span className="approval-review-keycap">Esc</span>
              <span>to deny</span>
            </button>
          </motion.div>
        </div>
      );
    }
    return null;
  };

  const resolvedShellRadius = isInputPill
    ? (isExpandedInput ? 16 : 999)
    : shellRadius;
  const shellStyle: PillShellStyle = {
    '--pill-accent': primaryColor,
    borderRadius: resolvedShellRadius,
    minWidth: fixedShellSize ? `${fixedShellSize.width}px` : undefined,
    minHeight: fixedShellSize ? `${fixedShellSize.height}px` : undefined,
  };

  return (
    <motion.div
      layout
      className={`pill-shell pill-shell-${mode.kind}`}
      style={shellStyle}
      transition={shouldReduceMotion ? { duration: 0 } : { layout: PILL_LAYOUT_TRANSITION }}
    >
      <AnimatePresence initial={false}>
        <motion.div
          key={contentKey}
          layout="position"
          className={pillClassName}
          initial={shouldReduceMotion || disableInitialContentAnimation ? false : { opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -3 }}
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : {
                  layout: PILL_LAYOUT_TRANSITION,
                  opacity: { duration: PILL_CONTENT_DURATION_S, ease: PILL_CONTENT_EASE },
                  y: { duration: PILL_CONTENT_DURATION_S, ease: PILL_CONTENT_EASE },
                }
          }
        >
          {renderContent(mode)}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}
