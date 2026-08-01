import { useRef, useEffect, type InputHTMLAttributes } from 'react';

import { Input } from '../../ui/input';

interface OnboardingInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Whether to autofocus the input on mount (default: true) */
  autoFocusOnMount?: boolean;
}

export function OnboardingInput({
  autoFocusOnMount = true,
  ...props
}: OnboardingInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocusOnMount && inputRef.current) {
      // Small delay to ensure the element is mounted and visible
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [autoFocusOnMount]);

  return (
    <Input
      ref={inputRef}
      {...props}
    />
  );
}
