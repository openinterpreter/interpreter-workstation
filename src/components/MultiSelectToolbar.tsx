import { useEffect, useRef } from 'react';
import { PDF_MULTI_SELECT_TOOLBAR_ID } from '../../shared/element-ids';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { formatPrimaryShortcut } from '../utils/platformShortcuts';

interface MultiSelectToolbarProps {
  selectedAnnotationCount: number;
  selectedFormFieldCount: number;
  selectedTextSpanCount: number;
  position: { x: number; y: number };
  onCopyText: () => void;
  onDeleteAnnotations: () => void;
  onClose: () => void;
}

export function MultiSelectToolbar({
  selectedAnnotationCount,
  selectedFormFieldCount,
  selectedTextSpanCount,
  position,
  onCopyText,
  onDeleteAnnotations,
  onClose
}: MultiSelectToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  const totalCount = selectedAnnotationCount + selectedFormFieldCount + selectedTextSpanCount;

  // Don't render if nothing is selected
  if (totalCount === 0) {
    return null;
  }

  // Click-outside detection to close toolbar
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;

      // Don't close if clicking on an annotation or text span
      if ((target as HTMLElement).closest?.('.pdf-annotation')) {
        return;
      }
      if ((target as HTMLElement).closest?.('.text-span-selected')) {
        return;
      }

      if (toolbarRef.current && !toolbarRef.current.contains(target)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Ensure toolbar stays within viewport
  const adjustedPosition = {
    x: Math.max(10, Math.min(position.x - 100, window.innerWidth - 250)),
    y: Math.max(10, position.y)
  };

  const toolbarStyle = {
    left: adjustedPosition.x,
    top: adjustedPosition.y,
    border:
      'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 82%, transparent)',
    background:
      'color-mix(in srgb, var(--oa-bg-app, var(--background)) 96%, var(--oa-bg-subtle, var(--muted)) 4%)',
    boxShadow:
      '0 20px 48px -28px rgba(0, 0, 0, 0.24), 0 10px 20px -16px rgba(0, 0, 0, 0.14)',
  } satisfies React.CSSProperties;

  return (
    <div
      ref={toolbarRef}
      data-testid={PDF_MULTI_SELECT_TOOLBAR_ID}
      className="fixed z-50 flex items-center gap-1.5 rounded-[14px] p-1.5 backdrop-blur-[10px]"
      style={toolbarStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Selection count */}
      <span className="px-2 text-ui-sm text-muted-foreground">
        {totalCount} item{totalCount !== 1 ? 's' : ''}
      </span>

      {/* Divider */}
      <Separator orientation="vertical" className="h-5 bg-black/[0.08] dark:bg-white/[0.1]" />

      {/* Copy Text Button - show if any text is selected */}
      {selectedTextSpanCount > 0 && (
        <Button
          onClick={onCopyText}
          variant="ghost"
          size="xs"
          className="px-2.5"
          title={`Copy selected text (${formatPrimaryShortcut('C')})`}
        >
          Copy Text
        </Button>
      )}

      {/* Delete Button - show if any annotations are selected */}
      {selectedAnnotationCount > 0 && (
        <Button
          onClick={onDeleteAnnotations}
          variant="ghost"
          size="xs"
          className="px-2.5 text-[var(--oa-danger)] hover:bg-[var(--oa-danger-soft)] hover:text-[var(--oa-danger)]"
          title="Delete selected annotations (Delete)"
        >
          Delete ({selectedAnnotationCount})
        </Button>
      )}
    </div>
  );
}
