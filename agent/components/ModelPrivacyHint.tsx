import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { cn } from '../../src/lib/utils';
import { needsRedactionForProvider } from '../../src/lib/pii/redaction';

interface ModelPrivacyHintProps {
  provider: string;
  className?: string;
}

export function ModelPrivacyHint({ provider, className }: ModelPrivacyHintProps) {
  const { t } = useTranslation();

  const needsRedaction = needsRedactionForProvider(provider);
  if (!needsRedaction) return null;

  return (
    <span
      className={cn(
        'flex items-center gap-1 px-1 py-0.5 text-ui-xs text-muted-foreground',
        className,
      )}
    >
      <Lock className="size-2.5 shrink-0" />
      <span>{t('basemind.privacyHint')}</span>
    </span>
  );
}
