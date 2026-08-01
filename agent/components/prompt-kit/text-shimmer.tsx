import { useEffect, useState, type CSSProperties, type ElementType } from 'react';

type TextShimmerProps<T extends ElementType> = {
  text: string;
  className?: string;
  as?: T;
  active?: boolean;
  offset?: number;
};

export function TextShimmer<T extends ElementType = 'span'>(props: TextShimmerProps<T>) {
  const [run, setRun] = useState(props.active ?? true);
  const swap = 220;
  const Comp = (props.as ?? 'span') as ElementType;

  useEffect(() => {
    if (props.active ?? true) {
      setRun(true);
      return;
    }

    const timer = window.setTimeout(() => {
      setRun(false);
    }, swap);

    return () => {
      window.clearTimeout(timer);
    };
  }, [props.active]);

  return (
    <Comp
      data-component="text-shimmer"
      data-active={props.active ?? true ? 'true' : 'false'}
      className={props.className}
      aria-label={props.text}
      style={{
        '--text-shimmer-swap': `${swap}ms`,
        '--text-shimmer-index': `${props.offset ?? 0}`,
      } satisfies CSSProperties}
    >
      <span data-slot="text-shimmer-char">
        <span data-slot="text-shimmer-char-base" aria-hidden="true">
          {props.text}
        </span>
        <span data-slot="text-shimmer-char-shimmer" data-run={run ? 'true' : 'false'} aria-hidden="true">
          {props.text}
        </span>
      </span>
    </Comp>
  );
}
