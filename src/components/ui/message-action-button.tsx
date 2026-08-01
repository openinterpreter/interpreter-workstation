import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useCallback, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { copyTextToClipboard } from '../../utils/clipboard';

type MessageActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: ReactNode;
};

export function MessageActionButton({
  label,
  icon,
  className,
  type = 'button',
  ...props
}: MessageActionButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-full border text-muted-foreground transition-[color,background-color,border-color,transform] duration-150',
        'border-transparent bg-[color:color-mix(in_srgb,var(--oa-bg-subtle)_14%,transparent)]',
        'hover:border-[color:color-mix(in_srgb,var(--oa-border-strong)_82%,transparent)] hover:bg-[var(--oa-bg-hover)] hover:text-foreground',
        'active:scale-[0.97] disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-[color:color-mix(in_srgb,var(--oa-bg-subtle)_14%,transparent)]',
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none flex items-center justify-center [&_svg]:size-3.5">
        {icon}
      </span>
    </button>
  );
}

export function AnimatedCopyButton({
  text,
  label = 'Copy',
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const reducedMotion = useReducedMotion();

  const handleCopy = useCallback(async () => {
    const didCopy = await copyTextToClipboard(text);
    if (!didCopy) {
      return;
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }, [text]);

  return (
    <MessageActionButton
      label={label}
      onClick={handleCopy}
      className={className}
      icon={(
        <AnimatePresence initial={false} mode="wait">
          <motion.span
            key={copied ? 'copied' : 'copy'}
            initial={reducedMotion ? false : { opacity: 0, scale: 0.82, rotate: -8 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, rotate: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.82, rotate: 8 }}
            transition={{ duration: reducedMotion ? 0.12 : 0.18, ease: 'easeOut' }}
            className="flex items-center justify-center"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </motion.span>
        </AnimatePresence>
      )}
    />
  );
}
