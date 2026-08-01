import * as React from 'react';
import { Button } from '../../../src/components/ui/button';
import { cn } from '@/lib/utils';

type ComposerSecondaryButtonSize = 'pill' | 'icon';

interface ComposerSecondaryButtonProps extends React.ComponentProps<typeof Button> {
  chromeSize?: ComposerSecondaryButtonSize;
}

export const ComposerSecondaryButton = React.forwardRef<HTMLButtonElement, ComposerSecondaryButtonProps>(
  ({ chromeSize = 'pill', className, size, variant = 'utility', ...props }, ref) => (
    <Button
      ref={ref}
      variant={variant}
      size={size ?? (chromeSize === 'icon' ? 'icon-sm' : 'sm')}
      className={cn(
        chromeSize === 'icon'
          ? 'size-9 rounded-full'
          : 'h-8 min-w-0 rounded-full px-2.5 text-ui-sm',
        className,
      )}
      {...props}
    />
  ),
);

ComposerSecondaryButton.displayName = 'ComposerSecondaryButton';
