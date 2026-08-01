/**
 * Send Button with Hover Menu
 *
 * Enhanced send button that changes behavior based on state:
 * - Not streaming, no input: disabled send button
 * - Not streaming, has input: send button
 * - Streaming, no input: stop button
 * - Streaming, has input: interrupt and send immediately by default, hover
 *   reveals non-interrupting after-next-tool and end-of-turn options
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, CornerDownRight, Square, Clock3 } from 'lucide-react';
import { MAIN_COMPOSER_SEND_BUTTON_ID, SEND_BUTTON_ICON_ID } from '../../../shared/element-ids';
import { ButtonWithHoverMenu, type HoverMenuItem } from './ButtonWithHoverMenu';
import { cn } from '@/lib/utils';

interface SendButtonWithMenuProps {
  isStreaming: boolean;
  hasInput: boolean;
  hasQueue: boolean;
  onSend: () => void;
  onSendAfterNextTool: () => void;
  onQueueForEndOfTurn: () => void;
  onInterruptAndSendImmediately: () => void;
  onStop: () => void;
  disabled?: boolean;
  showOnboardingPulse?: boolean;
  onOnboardingPulseEnd?: () => void;
}

export function SendButtonWithMenu({
  isStreaming,
  hasInput,
  hasQueue,
  onSend,
  onSendAfterNextTool,
  onQueueForEndOfTurn,
  onInterruptAndSendImmediately,
  onStop,
  disabled,
  showOnboardingPulse = false,
  onOnboardingPulseEnd,
}: SendButtonWithMenuProps) {
  const { t } = useTranslation();
  const isStopMode = isStreaming && !hasInput;
  const isSendWhileStreaming = isStreaming && hasInput;

  const handleClick = useCallback(() => {
    if (disabled && !isStopMode) return;
    if (isStopMode) {
      onStop();
    } else if (isSendWhileStreaming) {
      onInterruptAndSendImmediately();
    } else {
      onSend();
    }
  }, [disabled, isSendWhileStreaming, isStopMode, onInterruptAndSendImmediately, onSend, onStop]);

  const menuItems = useMemo<HoverMenuItem[]>(() => [
    {
      key: 'after-next-tool',
      icon: <CornerDownRight className="size-4" />,
      label: t('composer.sendMenu.afterNextToolCall'),
      helpTitle: t('composer.sendMenu.afterNextToolCall'),
      helpDescription: t('composer.sendMenu.afterNextToolCallDescription'),
      onClick: onSendAfterNextTool,
    },
    {
      key: 'queue-end-of-turn',
      icon: <Clock3 className="size-4" />,
      label: t('composer.sendMenu.endOfTurn'),
      helpTitle: t('composer.sendMenu.endOfTurn'),
      helpDescription: t('composer.sendMenu.endOfTurnDescription'),
      onClick: onQueueForEndOfTurn,
    },
  ], [onQueueForEndOfTurn, onSendAfterNextTool, t]);

  const isButtonDisabled = isStopMode ? false : disabled;

  const buttonIcon = (
    <span data-testid={SEND_BUTTON_ICON_ID}>
      {isStopMode ? (
        <Square className="size-4 fill-current" />
      ) : isSendWhileStreaming ? (
        <span className="relative flex size-4 items-center justify-center">
          <ArrowUp className="size-4" />
          <CornerDownRight
            className="absolute -bottom-1 -right-1 size-3 rounded-full p-[1px]"
            style={{
              background: 'var(--brand-accent-foreground, var(--oa-primary-foreground, var(--background)))',
              color: 'var(--brand-accent, var(--oa-primary, var(--foreground)))',
            }}
          />
        </span>
      ) : (
        <ArrowUp className="size-4" />
      )}
    </span>
  );

  const tooltip = isStopMode
    ? t('help.composer.stop.title')
    : isSendWhileStreaming
      ? t('composer.sendMenu.immediate')
      : (
      <span className="flex items-center gap-1.5">
        <span>{t('help.composer.send.title')}</span>
        <span className="opacity-60">↵</span>
      </span>
    );

  const buttonStyle: React.CSSProperties = {
    background: isButtonDisabled
      ? 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 78%, var(--oa-bg-app, var(--background)) 22%)'
      : 'var(--brand-accent, var(--oa-primary, var(--foreground)))',
    color: isButtonDisabled
      ? 'var(--oa-text-faint, var(--text-muted))'
      : 'var(--brand-accent-foreground, var(--oa-primary-foreground, var(--background)))',
    boxShadow: isButtonDisabled
      ? 'none'
      : '0 1px 2px rgba(15, 23, 42, 0.08), 0 8px 18px rgba(15, 23, 42, 0.06)',
  };

  const badge = hasQueue ? (
    <span
      className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full"
      style={{
        background: 'var(--brand-accent, var(--oa-primary, var(--foreground)))',
        boxShadow: '0 0 0 2px var(--oa-bg-app, var(--background))',
      }}
    />
  ) : undefined;

  return (
    <span
      className={cn(
        'inline-flex rounded-full p-1',
        showOnboardingPulse && !isButtonDisabled && 'onboarding-feedback-button-shell feedback-button-onboarding-pulse-twice',
      )}
      onAnimationEnd={showOnboardingPulse ? onOnboardingPulseEnd : undefined}
    >
      <ButtonWithHoverMenu
        menuItems={menuItems}
        menuEnabled={isSendWhileStreaming}
        hoverDelayMs={400}
        buttonIcon={buttonIcon}
        onButtonClick={handleClick}
        disabled={isButtonDisabled}
        testId={MAIN_COMPOSER_SEND_BUTTON_ID}
        tooltip={tooltip}
        helpTitle={
          isStopMode
            ? t('help.composer.stop.title')
            : isSendWhileStreaming
              ? t('composer.sendMenu.immediate')
              : t('help.composer.send.title')
        }
        helpDescription={
          isStopMode
            ? t('help.composer.stop.description')
            : isSendWhileStreaming
              ? t('composer.sendMenu.immediateDescription')
              : t('help.composer.send.description')
        }
        buttonStyle={buttonStyle}
        badge={badge}
      />
    </span>
  );
}
