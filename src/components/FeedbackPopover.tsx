import { useState, useRef, useEffect } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Bug, Loader2, X, Paperclip } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { isBrowserDevMode } from '@/ipc';
import { FEEDBACK_BUTTON_ID, FEEDBACK_POPOVER_ID } from '../../shared/element-ids';
import { FEEDBACK_BUTTON_FLASH_EVENT, FEEDBACK_POPOVER_OPEN_EVENT } from '../utils/feedback';
import { isMeaningfulFeedbackMessage } from '../utils/feedbackValidation';
import { trackFeedbackSubmitted, trackFeedbackOpened } from '../utils/telemetry';
import { cn } from '@/lib/utils';
import { formatPrimaryShortcut } from '../utils/platformShortcuts';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './ui/popover';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { SIDEBAR_FOOTER_SECONDARY_BUTTON_CLASSNAME } from './sidebarFooterButtonStyles';

interface FeedbackPopoverProps {
  className?: string;
}

const DEFAULT_INCLUDE_LOGS = true;

export function FeedbackPopover({ className }: FeedbackPopoverProps) {
  const { session } = useAuth();
  const { dismissToast, showToast } = useToast();
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [isOpen, setIsOpen] = useState(false);
  const [showPulse, setShowPulse] = useState(false);
  const [email, setEmail] = useState('');

  useEffect(() => {
    const handleFlash = () => {
      setShowPulse(false);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setShowPulse(true);
        });
      });
    };

    window.addEventListener(FEEDBACK_BUTTON_FLASH_EVENT, handleFlash);

    return () => {
      window.removeEventListener(FEEDBACK_BUTTON_FLASH_EVENT, handleFlash);
    };
  }, []);

  useEffect(() => {
    const handleOpen = () => {
      setIsOpen(true);
      trackFeedbackOpened();
    };

    window.addEventListener(FEEDBACK_POPOVER_OPEN_EVENT, handleOpen);

    return () => {
      window.removeEventListener(FEEDBACK_POPOVER_OPEN_EVENT, handleOpen);
    };
  }, []);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!email && session?.user?.email) {
      setEmail(session.user.email);
    }
  }, [session?.user?.email]);
  const [includeLogs, setIncludeLogs] = useState(DEFAULT_INCLUDE_LOGS);
  const [images, setImages] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const feedbackMessagePlaceholder = t('feedback.messagePlaceholder', {
    shortcut: formatPrimaryShortcut('V'),
  });

  useEffect(() => {
    if (!wasOpenRef.current && isOpen && message.trim().length === 0 && images.length === 0) {
      setIncludeLogs(DEFAULT_INCLUDE_LOGS);
    }
    wasOpenRef.current = isOpen;
  }, [images.length, isOpen, message]);

  const addImages = (files: File[]) => {
    setImages(prev => [...prev, ...files]);
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      addImages([file]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const newFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          newFiles.push(new File([file], `screenshot-${Date.now()}.png`, { type: file.type }));
        }
      }
    }
    if (newFiles.length > 0) {
      addImages(newFiles);
      e.preventDefault();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const newFiles: File[] = [];
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type.startsWith('image/')) {
        newFiles.push(file);
      }
    }
    if (newFiles.length > 0) {
      addImages(newFiles);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedMessage = message.trim();

    if (!trimmedEmail || !trimmedMessage) {
      setSubmitError(t('feedback.errorRequired'));
      return;
    }

    if (!isMeaningfulFeedbackMessage(trimmedMessage)) {
      setSubmitError(t('feedback.errorMoreDetails'));
      return;
    }

    if (isBrowserDevMode() || !window.electron?.feedback) {
      setSubmitError(t('feedback.errorDesktopOnly'));
      return;
    }

    const imagesToSubmit = images;
    const includeLogsToSubmit = includeLogs;
    setIsSubmitting(true);
    setSubmitError(null);
    const sendingToastId = showToast(t('feedback.sendingToast'), 'info');
    setIsOpen(false);
    setMessage('');
    setImages([]);
    setIncludeLogs(DEFAULT_INCLUDE_LOGS);

    try {
      let encodedImages: Array<{ data: string; name: string }> | undefined;

      if (imagesToSubmit.length > 0) {
        // NOTE(victor): btoa(String.fromCharCode(...bytes)) causes stack overflow on large images
        encodedImages = await Promise.all(
          imagesToSubmit.map(
            (img) =>
              new Promise<{ data: string; name: string }>((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = reject;
                reader.onload = () => {
                  const dataUrl = reader.result as string;
                  resolve({
                    data: dataUrl.replace('data:', '').replace(/^.+,/, ''),
                    name: img.name,
                  });
                };
                reader.readAsDataURL(img);
              })
          )
        );
      }

      const result = await window.electron.feedback.submit({
        email: trimmedEmail,
        message: trimmedMessage,
        includeLogs: includeLogsToSubmit,
        images: encodedImages,
      });

      if (result.success) {
        trackFeedbackSubmitted({
          hasImages: imagesToSubmit.length > 0,
          includedLogs: includeLogsToSubmit,
          messageLength: trimmedMessage.length,
        });
        dismissToast(sendingToastId);
        showToast(t('feedback.success'), 'success', 4000);
      } else {
        let errorMessage = result.error;
        if (!errorMessage) {
          errorMessage = t('feedback.errorSendFailed');
        }
        dismissToast(sendingToastId);
        showToast(errorMessage, 'error', 8000);
      }
    } catch (err: any) {
      let errorMsg = t('feedback.errorSendFailed');
      if (err?.message) {
        errorMsg = err.message;
      }
      console.error('[FEEDBACK] Submit error:', errorMsg, err);
      dismissToast(sendingToastId);
      showToast(errorMsg, 'error', 8000);
    }

    setIsSubmitting(false);
  };



  return (
// we use the popover component here over dropdownmenu as it is makes we the form fields keyboard navigatable
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <PopoverTrigger asChild>
              <Button
                asChild
                data-testid={FEEDBACK_BUTTON_ID}
                variant="ghost"
                size="sm"
                className={cn(
                  SIDEBAR_FOOTER_SECONDARY_BUTTON_CLASSNAME,
                  className,
                  showPulse && 'feedback-button-onboarding-pulse',
                )}
                onAnimationEnd={() => setShowPulse(false)}
                data-help-title={t('feedback.helpTitle')}
                data-help-description={t('feedback.helpDescription')}
              >
                <motion.button
                  whileTap={reducedMotion ? undefined : { scale: 0.982 }}
                  transition={reducedMotion ? { duration: 0.12 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Bug />
                  {t('feedback.button')}
                </motion.button>
              </Button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        {!isOpen && (
          <TooltipContent side="top">{t('feedback.tooltip')}</TooltipContent>
        )}
      </Tooltip>
      <PopoverContent
        data-testid={FEEDBACK_POPOVER_ID}
        align="center"
        side="top"
        sideOffset={8}
        className="z-50 w-[22rem] overflow-hidden rounded-[18px] p-0"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <form onSubmit={handleSubmit} onDrop={handleDrop} onDragOver={handleDragOver}>
          <div
            className="flex items-start justify-between gap-3 px-4 pb-2.5 pt-4"
            style={{
              borderBottom:
                'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 74%, transparent)',
            }}
          >
            <span className="text-[13px] font-medium leading-5 text-[var(--oa-text-strong, var(--foreground))]">
              {t('feedback.title')}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="mt-[-2px] text-muted-foreground hover:bg-black/[0.03] hover:text-foreground dark:hover:bg-white/[0.05]"
              onClick={() => setIsOpen(false)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>

          <div className="space-y-3.5 px-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="feedback-email" className="text-ui-sm text-muted-foreground">{t('feedback.emailLabel')}</Label>
              <Input
                id="feedback-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('feedback.emailPlaceholder')}
                className="h-9 rounded-[12px] text-ui-sm shadow-none"
                style={{
                  border:
                    'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 76%, transparent)',
                  backgroundColor:
                    'color-mix(in srgb, var(--oa-bg-app, var(--background)) 86%, var(--oa-bg-subtle, var(--muted)) 14%)',
                }}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="feedback-message" className="text-ui-sm text-muted-foreground">{t('feedback.messageLabel')}</Label>
              <textarea
                id="feedback-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onPaste={handlePaste}
                placeholder={feedbackMessagePlaceholder}
                className="w-full resize-none rounded-[12px] px-3 py-2.5 text-ui-sm leading-5 focus:outline-none focus:ring-1 focus:ring-ring"
                style={{
                  border:
                    'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 76%, transparent)',
                  backgroundColor:
                    'color-mix(in srgb, var(--oa-bg-app, var(--background)) 86%, var(--oa-bg-subtle, var(--muted)) 14%)',
                  minHeight: 'calc(var(--unit-element-height) * 3.2)',
                }}
                required
              />
            </div>

            <div
              className="space-y-1.5 rounded-[12px] px-3 py-2.5"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--oa-bg-app, var(--background)) 78%, var(--oa-bg-subtle, var(--muted)) 22%)',
              }}
            >
              <Label htmlFor="include-logs" className="flex min-w-0 flex-1 items-center gap-2.5 text-ui-sm font-normal text-[var(--oa-text-strong, var(--foreground))]">
                <Checkbox
                  id="include-logs"
                  checked={includeLogs}
                  onCheckedChange={(checked) => setIncludeLogs(checked === true)}
                />
                <span className="truncate">
                  {t('feedback.includeLogs')}
                </span>
              </Label>
              <p className="pl-6 text-ui-xs leading-snug text-muted-foreground">
                {t('feedback.logsWarningDescription')}
              </p>
            </div>

            <div className="space-y-[var(--unit-padding-small)]">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageSelect}
                className="hidden"
              />
              <Button
                type="button"
                variant="ghost"
                size="default"
                className="h-auto w-full items-start justify-start gap-2.5 rounded-[12px] px-3 py-2.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--oa-bg-app, var(--background)) 78%, var(--oa-bg-subtle, var(--muted)) 22%)',
                }}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
                <span className="whitespace-normal leading-snug">
                  {images.length > 0
                    ? (images.length === 1
                      ? t('feedback.imageAttached', { count: 1 })
                      : t('feedback.imagesAttached', { count: images.length }))
                    : t('feedback.attachImage')}
                </span>
              </Button>
              {images.length > 0 && (
                <div
                  className="space-y-1 rounded-[12px] p-2.5"
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, var(--oa-bg-app, var(--background)) 74%, var(--oa-bg-subtle, var(--muted)) 26%)',
                  }}
                >
                  {images.map((img, i) => (
                    <div key={i} className="flex items-center justify-between gap-[var(--unit-padding-small)] text-ui-sm text-muted-foreground">
                      <span className="truncate flex-1">{img.name}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setImages(prev => prev.filter((_, idx) => idx !== i))}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {submitError && (
              <div
                className="rounded-[12px] p-2.5 text-ui-sm text-destructive"
                style={{
                  border:
                    'var(--border-width) solid color-mix(in srgb, var(--oa-danger, var(--destructive)) 28%, transparent)',
                  backgroundColor: 'color-mix(in srgb, var(--oa-danger, var(--destructive)) 9%, transparent)',
                }}
              >
                {submitError}
                <div className="mt-1 text-muted-foreground">
                  {t('feedback.orEmailUs')}{' '}
                  <a
                    href="mailto:help@openinterpreter.com"
                    className="underline hover:text-foreground"
                  >
                    help@openinterpreter.com
                  </a>
                </div>
              </div>
            )}
          </div>

          <div
            className="flex items-center justify-end px-4 pb-4 pt-2.5"
            style={{
              borderTop:
                'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 74%, transparent)',
            }}
          >
            <Button
              type="submit"
              size="sm"
              className="min-w-[120px] font-medium disabled:bg-muted disabled:text-muted-foreground disabled:border-border disabled:opacity-100"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  {t('feedback.sending')}
                </>
              ) : (
                t('feedback.sendButton')
              )}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
