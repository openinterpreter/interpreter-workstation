import type { HTMLAttributes } from 'react';
import { cn } from '../../../src/lib/utils';
import { Markdown } from './markdown';

export function Message({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex w-full py-2', className)} {...props}>
      {children}
    </div>
  );
}

export function MessageContent({
  children,
  className,
  markdown,
  ...props
}: HTMLAttributes<HTMLDivElement> & { markdown?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-[var(--control-radius)] px-3 py-2 text-sm break-words',
        !markdown && 'whitespace-pre-wrap',
        className,
      )}
      {...props}
    >
      {markdown && typeof children === 'string' ? (
        <Markdown>{children}</Markdown>
      ) : (
        children
      )}
    </div>
  );
}
