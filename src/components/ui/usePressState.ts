import * as React from 'react';

interface PressStateResult<T> {
  pressed: boolean;
  pressProps: {
    onPointerDown: React.PointerEventHandler<T>;
    onPointerUp: React.PointerEventHandler<T>;
    onPointerLeave: React.PointerEventHandler<T>;
    onPointerCancel: React.PointerEventHandler<T>;
    onKeyDown: React.KeyboardEventHandler<T>;
    onKeyUp: React.KeyboardEventHandler<T>;
    onBlur: React.FocusEventHandler<T>;
  };
}

export function usePressState<T extends HTMLElement>(disabled: boolean = false): PressStateResult<T> {
  const [pressed, setPressed] = React.useState(false);

  const release = React.useCallback(() => {
    setPressed(false);
  }, []);

  React.useEffect(() => {
    if (disabled) {
      setPressed(false);
    }
  }, [disabled]);

  const pressProps = React.useMemo(() => ({
    onPointerDown: (event: React.PointerEvent<T>) => {
      if (disabled || event.button !== 0) return;
      setPressed(true);
    },
    onPointerUp: () => {
      release();
    },
    onPointerLeave: () => {
      release();
    },
    onPointerCancel: () => {
      release();
    },
    onKeyDown: (event: React.KeyboardEvent<T>) => {
      if (disabled || event.repeat) return;
      if (event.key === 'Enter' || event.key === ' ') {
        setPressed(true);
      }
    },
    onKeyUp: (event: React.KeyboardEvent<T>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        release();
      }
    },
    onBlur: () => {
      release();
    },
  }), [disabled, release]);

  return { pressed, pressProps };
}
