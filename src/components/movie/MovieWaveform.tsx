import { cn } from '@/lib/utils';

export function MovieWaveform({
  samples,
  className,
  stroke = 'rgba(244,244,245,0.78)',
  fill = 'rgba(244,244,245,0.18)',
}: {
  samples: number[];
  className?: string;
  stroke?: string;
  fill?: string;
}) {
  if (samples.length === 0) {
    return (
      <div
        className={cn('h-full w-full rounded-[10px] bg-white/[0.04]', className)}
      />
    );
  }

  const step = samples.length > 1 ? 100 / (samples.length - 1) : 100;
  const topPoints = samples.map((sample, index) => {
    const x = index * step;
    const y = 50 - (Math.max(0, Math.min(1, sample)) * 42);
    return `${x},${y}`;
  });
  const bottomPoints = samples
    .map((sample, index) => {
      const x = index * step;
      const y = 50 + (Math.max(0, Math.min(1, sample)) * 42);
      return `${x},${y}`;
    })
    .reverse();

  const polygonPoints = [...topPoints, ...bottomPoints].join(' ');
  const polylinePoints = topPoints.join(' ');

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={cn('h-full w-full overflow-hidden rounded-[10px]', className)}
      aria-hidden="true"
    >
      <polygon points={polygonPoints} fill={fill} />
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={bottomPoints.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
