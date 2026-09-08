import type { ReactNode } from 'react';

export function ThreadAccessoryStack({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`.trim()} data-thread-accessory-stack="true">
      {children}
    </div>
  );
}
