import type { MouseEventHandler, PointerEventHandler, ReactNode } from 'react';
import { FileText, Image as ImageIcon, X } from 'lucide-react';
import { tr } from '../../../../src/i18n';
import type { ComposerAttachmentKind } from './types';

interface AttachmentChipBodyProps {
  kind: ComposerAttachmentKind;
  label: string;
  leadingVisual?: ReactNode;
  hideLabel?: boolean;
  suppressDefaultIcon?: boolean;
  onRemoveClick?: MouseEventHandler<HTMLButtonElement>;
  onRemoveMouseDown?: MouseEventHandler<HTMLButtonElement>;
  onRemovePointerDown?: PointerEventHandler<HTMLButtonElement>;
  removeButtonDataAttributes?: Record<string, string>;
}

export function AttachmentChipBody({
  kind,
  label,
  leadingVisual,
  hideLabel = false,
  suppressDefaultIcon = false,
  onRemoveClick,
  onRemoveMouseDown,
  onRemovePointerDown,
  removeButtonDataAttributes,
}: AttachmentChipBodyProps) {
  const isImage = kind === 'pasted-image' || kind === 'file-image';
  const Icon = isImage ? ImageIcon : FileText;

  return (
    <>
      {leadingVisual ?? (suppressDefaultIcon ? null : <Icon size={12} aria-hidden="true" className="composer-attachment-chip__icon" />)}
      {hideLabel ? null : <span className="composer-attachment-chip__label">{label}</span>}
      {onRemoveClick || onRemoveMouseDown || onRemovePointerDown ? (
        <button
          type="button"
          className="composer-attachment-chip__remove"
          aria-label={tr('composer.attachments.removeAria', { label })}
          onClick={onRemoveClick}
          onMouseDown={onRemoveMouseDown}
          onPointerDown={onRemovePointerDown}
          tabIndex={-1}
          {...removeButtonDataAttributes}
        >
          <X size={10} aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}
