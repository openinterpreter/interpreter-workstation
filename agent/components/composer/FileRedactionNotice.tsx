import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { needsRedactionForProvider } from '../../../src/lib/pii/redaction';

interface FileRedactionNoticeProps {
  modelProvider: string | null | undefined;
  hasAttachments: boolean;
  className?: string;
}

/**
 * File-redaction notice: visible only while attachments are staged and the
 * active provider requires basemind redaction. Unknown provider fails closed
 * (notice shown).
 */
export function FileRedactionNotice({
  modelProvider,
  hasAttachments,
  className,
}: FileRedactionNoticeProps) {
  const { t } = useTranslation();

  if (!hasAttachments || !needsRedactionForProvider(modelProvider)) return null;

  return (
    <span
      className={`flex items-center gap-1 px-1 py-0.5 text-ui-xs text-muted-foreground${className ? ` ${className}` : ''}`}
    >
      <Lock className="size-2.5 shrink-0" />
      <span>{t('basemind.filesWillBeRedacted', { provider: modelProvider || 'the model' })}</span>
    </span>
  );
}
