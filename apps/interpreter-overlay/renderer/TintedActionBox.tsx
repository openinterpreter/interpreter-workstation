import type { CSSProperties, ReactNode } from 'react';

type TintedActionBoxStyle = CSSProperties & {
  '--action-tint-color': string;
  '--trace-color': string;
  '--trace-index': string;
  '--spark-index': string;
};

interface TintedActionBoxProps {
  className?: string;
  color: string;
  left: number;
  top: number;
  width: number;
  height: number;
  index?: number;
  children?: ReactNode;
}

export function TintedActionBox({
  className = '',
  color,
  left,
  top,
  width,
  height,
  index = 0,
  children,
}: TintedActionBoxProps) {
  const style: TintedActionBoxStyle = {
    left,
    top,
    width,
    height,
    '--action-tint-color': color,
    '--trace-color': color,
    '--trace-index': String(index),
    '--spark-index': String(index),
  };

  return (
    <div className={`action-tint-box ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}
