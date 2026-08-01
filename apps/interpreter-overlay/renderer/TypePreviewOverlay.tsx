import type { CSSProperties } from 'react';
import type { ReviewAction } from '../shared/ipc.js';

type TypePreviewStyle = CSSProperties & {
  '--ghost-bg': string;
  '--ghost-text-color': string;
  '--ghost-text-opacity': string;
  '--ghost-font-size': string;
  '--ghost-line-height': string;
  '--ghost-radius': string;
  '--ghost-shell-inset-x': string;
  '--ghost-shell-inset-y': string;
  '--ghost-shell-radius': string;
  '--ghost-fill-opacity': string;
  '--ghost-mask-opacity': string;
  '--ghost-content-opacity': string;
  '--ghost-accent': string;
  '--ghost-text-offset-x': string;
  '--ghost-align-items': string;
  '--ghost-self-align': string;
  '--ghost-content-white-space': string;
  '--ghost-word-break': string;
  '--ghost-overflow-wrap': string;
  '--ghost-text-display': string;
  '--ghost-text-align-items': string;
  '--trace-index': string;
};

interface TypePreviewOverlayProps {
  action: ReviewAction;
  ghost?: boolean;
  active?: boolean;
  pressed?: boolean;
  executing?: boolean;
  elevated?: boolean;
  traceIndex?: number;
  primaryColor?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  if (!color.startsWith('#')) {
    return null;
  }

  const hex = color.slice(1);
  const normalized = hex.length === 3
    ? hex.split('').map((part) => `${part}${part}`).join('')
    : hex;
  if (normalized.length !== 6) {
    return null;
  }

  const num = Number.parseInt(normalized, 16);
  if (Number.isNaN(num)) {
    return null;
  }

  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

function getPlaceholderTextColor(color: string): string {
  const parsed = parseHexColor(color);
  if (!parsed) {
    console.warn('[InterpreterOverlay][TypePreviewOverlay] Invalid sampled placeholder color', { color });
    return 'rgba(95, 111, 134, 0.92)';
  }

  const perceivedBrightness = ((parsed.r * 299) + (parsed.g * 587) + (parsed.b * 114)) / 1000;
  return perceivedBrightness >= 170
    ? 'rgba(40, 50, 64, 0.96)'
    : 'rgba(210, 220, 235, 0.96)';
}

function estimateLineCount(text: string, contentWidth: number, fontSize: number): number {
  const averageGlyphWidth = fontSize * 0.62;
  const charsPerLine = Math.max(1, Math.floor(contentWidth / averageGlyphWidth));
  return text
    .split('\n')
    .reduce((sum, line) => {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return sum + 1;
      let lines = 1;
      let lineLength = 0;
      for (const word of words) {
        const nextLength = lineLength === 0 ? word.length : lineLength + 1 + word.length;
        if (nextLength > charsPerLine && lineLength > 0) {
          lines += 1;
          lineLength = word.length;
        } else {
          lineLength = nextLength;
        }
      }
      return sum + lines;
    }, 0);
}

export function TypePreviewOverlay({
  action,
  ghost = false,
  active = false,
  pressed = false,
  executing = false,
  elevated = false,
  traceIndex = 0,
  primaryColor = '#2f7cff',
}: TypePreviewOverlayProps) {
  const isTypeAction = action.type === 'type';
  const previewText = isTypeAction ? (action.text ?? '') : '';
  const backgroundColor = isTypeAction ? (action.centerColor ?? '#ffffff') : '';
  const hasRenderablePreview = isTypeAction && previewText.length > 0;

  if (executing) {
    return null;
  }

  if (!action.hasBounds) {
    return null;
  }

  const width = Math.max(action.bounds.width, 8);
  const height = Math.max(action.bounds.height, 8);
  const left = action.bounds.x;
  const top = action.bounds.y;
  const textColor = getPlaceholderTextColor(backgroundColor);
  const coverText = (action.currentValue || '').length > previewText.length
    ? action.currentValue || previewText
    : previewText;
  const shellInsetX = Math.round(clamp(height * 0.08, 3, 6));
  const shellInsetY = Math.round(clamp(height * 0.08, 3, 6));
  const singleLineInnerInsetX = shellInsetY;
  const singleLineContentWidth = Math.max(width - singleLineInnerInsetX * 2, 16);
  const singleLineBaseFontSize = Math.min(20, height * 0.36);
  const singleLineFits = (previewText.length * singleLineBaseFontSize * 0.62) <= singleLineContentWidth;
  const isMultiline = height >= 52 || previewText.includes('\n') || !singleLineFits;
  const innerInsetX = isMultiline
    ? shellInsetX + Math.round(clamp(height * 0.14, 16, 24))
    : shellInsetY;
  const innerInsetY = shellInsetY + Math.round(isMultiline ? clamp(height * 0.11, 12, 20) : 0);
  const contentWidth = Math.max(width - innerInsetX * 2, 16);
  const lineHeight = isMultiline ? 1.35 : 1.25;
  const shellHeight = Math.max(height - innerInsetY * 2, 8);
  const textLines = previewText.split('\n');
  const longestLineLength = Math.max(
    1,
    ...textLines.map((line) => line.trim().length),
  );
  const baseFontSize = isMultiline ? Math.min(18, height * 0.23) : singleLineBaseFontSize;
  const estimatedWrappedLines = isMultiline ? estimateLineCount(previewText, contentWidth, baseFontSize) : 1;
  const heightLimitedFontSize = shellHeight / (estimatedWrappedLines * lineHeight);
  const widthLimitedFontSize = isMultiline
    ? baseFontSize
    : (contentWidth * 1.6) / longestLineLength;
  const fontSize = Math.round(clamp(
    Math.min(baseFontSize, heightLimitedFontSize, widthLimitedFontSize),
    isMultiline ? 11 : 13,
    isMultiline ? 18 : 28,
  ));
  const whiteoutWidth = Math.max(width - shellInsetX * 2, 8);
  const whiteoutHeight = Math.max(height - shellInsetY * 2, 8);
  const radius = Math.round(clamp(height * 0.2, 10, 12));
  const shellRadius = Math.max(radius - 2, 8);
  const targetStateClass = executing
    ? 'ghost-type-box-executing'
    : active
      ? 'ghost-type-box-reviewing'
      : '';
  const hidePlaceholder = pressed || executing;
  let ghostContentOpacity = '1';
  if (hidePlaceholder) {
    ghostContentOpacity = '0';
  } else if (ghost) {
    ghostContentOpacity = '0.74';
  }

  if (!hasRenderablePreview) {
    return null;
  }

  const previewStyle: TypePreviewStyle = {
    position: 'absolute',
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    zIndex: elevated ? 1 : 0,
    '--ghost-bg': backgroundColor,
    '--ghost-text-color': textColor,
    '--ghost-text-opacity': ghost ? '0.74' : '1',
    '--ghost-font-size': `${fontSize}px`,
    '--ghost-line-height': `${lineHeight}`,
    '--ghost-radius': `${radius}px`,
    '--ghost-shell-inset-x': `${shellInsetX}px`,
    '--ghost-shell-inset-y': `${shellInsetY}px`,
    '--ghost-shell-radius': `${shellRadius}px`,
    '--ghost-fill-opacity': hidePlaceholder ? '0' : '1',
    '--ghost-mask-opacity': hidePlaceholder ? '0' : '1',
    '--ghost-content-opacity': ghostContentOpacity,
    '--ghost-accent': primaryColor,
    '--ghost-text-offset-x': '0px',
    '--ghost-align-items': isMultiline ? 'flex-start' : 'center',
    '--ghost-self-align': isMultiline ? 'start' : 'center',
    '--ghost-content-white-space': isMultiline ? 'pre-wrap' : 'nowrap',
    '--ghost-word-break': 'normal',
    '--ghost-overflow-wrap': 'break-word',
    '--ghost-text-display': isMultiline ? 'block' : 'flex',
    '--ghost-text-align-items': isMultiline ? 'flex-start' : 'center',
    '--trace-index': String(traceIndex),
    transition: 'left 180ms cubic-bezier(0.22, 1, 0.36, 1), top 180ms cubic-bezier(0.22, 1, 0.36, 1), width 180ms cubic-bezier(0.22, 1, 0.36, 1), height 180ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease, box-shadow 75ms ease-out, background-color 75ms ease-out',
  };

  return (
    <div
      className={
        elevated && (active || executing)
          ? `ghost-type-box ghost-type-box-active-target pushable-surface ${pressed ? 'pushable-surface-pressed ghost-type-box-pressed' : ''} ${targetStateClass}`.trim()
          : ghost
            ? 'ghost-type-box ghost-type-box-ghost'
            : 'ghost-type-box ghost-type-box-active'
      }
      style={previewStyle}
    >
      <div
        className="ghost-field-whiteout"
        aria-hidden="true"
        style={{
          left: `${shellInsetX}px`,
          top: `${shellInsetY}px`,
          width: `${whiteoutWidth}px`,
          height: `${whiteoutHeight}px`,
        }}
      />
      <div
        className={active || executing ? 'ghost-content-row ghost-content-row-active' : 'ghost-content-row'}
        style={{
          left: `${innerInsetX}px`,
          top: `${innerInsetY}px`,
          width: `${contentWidth}px`,
          height: `${shellHeight}px`,
        }}
      >
        <div
          className="ghost-text-shell"
          style={{
            width: `${contentWidth}px`,
            height: `${shellHeight}px`,
          }}
        >
          <div className="ghost-text-mask" aria-hidden="true">
            {coverText}
          </div>
          <div
            className="ghost-text-content"
            style={{
              color: textColor,
            }}
          >
            {previewText}
          </div>
        </div>
      </div>
      <div className="ghost-type-box-chrome" aria-hidden="true" />
    </div>
  );
}
