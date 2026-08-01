import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { PDF_ANNOTATION_TOOLBAR_ID } from '../../shared/element-ids';
import { Button } from './ui/button';
import { NativeSelect } from './ui/NativeSelect';
import { Separator } from './ui/separator';

interface AnnotationToolbarProps {
  fontSize: number;
  color: { r: number; g: number; b: number };
  position: { x: number; y: number };
  onFontSizeChange: (size: number) => void;
  onColorChange: (color: { r: number; g: number; b: number }) => void;
  onDelete: () => void;
  onClose: () => void;
  isImageAnnotation?: boolean;
}

const FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32];

export function AnnotationToolbar({
  fontSize,
  color,
  position,
  onFontSizeChange,
  onColorChange,
  onDelete,
  onClose,
  isImageAnnotation = false
}: AnnotationToolbarProps) {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Click-outside detection to close toolbar
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;

      // Don't close if clicking on an annotation
      if ((target as HTMLElement).closest?.('.pdf-annotation')) {
        return;
      }

      if (toolbarRef.current && !toolbarRef.current.contains(target)) {
        onClose();
      }
    };

    // Use mousedown instead of click to handle before the annotation click
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Convert RGB to hex for color input
  const colorHex = `#${[color.r, color.g, color.b]
    .map(c => Math.round(c).toString(16).padStart(2, '0'))
    .join('')}`;

  // Parse hex to RGB
  const handleColorChange = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    onColorChange({ r, g, b });
  };

  // Ensure toolbar stays within viewport
  const adjustedPosition = {
    x: Math.max(10, Math.min(position.x, window.innerWidth - 250)),
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
      data-testid={PDF_ANNOTATION_TOOLBAR_ID}
      className="fixed z-50 flex items-center gap-1.5 rounded-[14px] p-1.5 backdrop-blur-[10px]"
      style={toolbarStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Text annotation controls (font size & color) */}
      {!isImageAnnotation && (
        <>
          <div
            data-help-title={t('help.annotation.fontSize.title')}
            data-help-description={t('help.annotation.fontSize.description')}
          >
            <NativeSelect
              value={fontSize.toString()}
              onValueChange={(value) => onFontSizeChange(Number(value))}
              items={FONT_SIZES.map(size => ({ label: `${size}pt`, value: size.toString() }))}
              size="sm"
              className="!h-7 !w-[72px] !rounded-[10px] !border-black/[0.07] !bg-transparent !py-0 dark:!border-white/[0.1] dark:!bg-transparent"
            />
          </div>

          {/* Color Picker */}
          <input
            type="color"
            value={colorHex}
            onChange={(e) => handleColorChange(e.target.value)}
            className="size-7 overflow-hidden rounded-[10px] bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-none"
            title={t('help.annotation.color.title')}
            data-help-title={t('help.annotation.color.title')}
            data-help-description={t('help.annotation.color.description')}
            style={{
              border:
                'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 76%, transparent)',
            }}
          />

          {/* Divider */}
          <Separator orientation="vertical" className="h-5 bg-black/[0.08] dark:bg-white/[0.1]" />
        </>
      )}

      {/* Image annotation label */}
      {isImageAnnotation && (
        <span
          className="px-1.5 text-ui-sm text-muted-foreground"
          data-help-title={t('help.annotation.image.title')}
          data-help-description={t('help.annotation.image.description')}
        >
          {t('annotation.image')}
        </span>
      )}

      {/* Delete Button */}
      <Button
        onClick={onDelete}
        variant="ghost"
        size="xs"
        className="text-[var(--oa-danger)] hover:bg-[var(--oa-danger-soft)] hover:text-[var(--oa-danger)]"
        title={t('help.annotation.delete.title')}
        data-help-title={t('help.annotation.delete.title')}
        data-help-description={t('help.annotation.delete.description')}
      >
        {t('annotation.delete')}
      </Button>
    </div>
  );
}
