import { cn } from '@/lib/utils';

const LOGO_WIDTH = 29;
const EYE_HEIGHT = 29;
const GAP_HEIGHT = 12;
const STEM_HEIGHT = 82;
const LOGO_HEIGHT = EYE_HEIGHT + GAP_HEIGHT + STEM_HEIGHT;

interface InterpreterLogoMarkProps {
  className?: string;
  segmentClassName?: string;
  fitSquare?: boolean;
  boxWidth?: number;
  boxHeight?: number;
  size?: number;
}

/**
 * Interpreter "i" mark using the exact production proportions:
 * eye 29x29, gap 12 (gap-3), stem 29x82.
 */
export function InterpreterLogoMark({
  className,
  segmentClassName = 'bg-primary',
  fitSquare = false,
  boxWidth,
  boxHeight,
  size = 20,
}: InterpreterLogoMarkProps) {
  const renderMark = (width: number, height: number) => {
    const scale = width / LOGO_WIDTH;
    const eyeHeight = EYE_HEIGHT * scale;
    const gapHeight = GAP_HEIGHT * scale;
    const stemHeight = STEM_HEIGHT * scale;
    return (
      <div className="flex flex-col" style={{ width, height, gap: gapHeight }}>
        <div
          className={cn(segmentClassName)}
          style={{ width, height: eyeHeight, borderRadius: width / 2 }}
        />
        <div
          className={cn(segmentClassName)}
          style={{ width, height: stemHeight, borderRadius: width / 2 }}
        />
      </div>
    );
  };

  if (!fitSquare && boxWidth === undefined && boxHeight === undefined) {
    return (
      <div className={cn('inline-flex shrink-0', className)}>
        {renderMark(LOGO_WIDTH, LOGO_HEIGHT)}
      </div>
    );
  }

  const targetWidth = fitSquare ? size : (boxWidth ?? size);
  const targetHeight = fitSquare ? size : (boxHeight ?? size);
  const scale = Math.min(targetWidth / LOGO_WIDTH, targetHeight / LOGO_HEIGHT);
  const fittedWidth = LOGO_WIDTH * scale;
  const fittedHeight = LOGO_HEIGHT * scale;

  return (
    <div
      className={cn('inline-flex items-center justify-center shrink-0', className)}
      style={{ width: targetWidth, height: targetHeight }}
    >
      {renderMark(fittedWidth, fittedHeight)}
    </div>
  );
}
