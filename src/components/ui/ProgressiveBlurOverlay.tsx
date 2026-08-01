import type { CSSProperties, HTMLAttributes } from "react";

type Direction = "top" | "right" | "bottom" | "left";

export interface ProgressiveBlurOverlayProps
  extends HTMLAttributes<HTMLDivElement> {
  direction?: Direction;
  tintOpacity?: number;
}

export function buildVerticalEdgeMask({
  topFade = "0px",
  bottomFade = "0px",
}: {
  topFade?: string;
  bottomFade?: string;
}): string {
  const gradientStops =
    topFade !== "0px"
      ? [`transparent 0px`, `rgba(255, 255, 255, 1) ${topFade}`]
      : [`rgba(255, 255, 255, 1) 0px`];

  if (bottomFade !== "0px") {
    gradientStops.push(
      `rgba(255, 255, 255, 1) calc(100% - ${bottomFade})`,
      `transparent 100%`,
    );
  } else {
    gradientStops.push(`rgba(255, 255, 255, 1) 100%`);
  }

  return `linear-gradient(to bottom, ${gradientStops.join(", ")})`;
}

function buildTintGradient(direction: Direction, tintOpacity: number): string {
  if (tintOpacity <= 0) {
    return "transparent";
  }

  const lead = Math.round(Math.min(100, tintOpacity * 100));
  const mid = Math.round(Math.min(100, tintOpacity * 78));
  const tail = Math.round(Math.min(100, tintOpacity * 28));
  const surfaceColor = "var(--oa-surface-center, var(--background, rgba(247, 249, 251, 0.98)))";

  switch (direction) {
    case "top":
      return `linear-gradient(to bottom,
        color-mix(in srgb, ${surfaceColor} ${lead}%, transparent) 0%,
        color-mix(in srgb, ${surfaceColor} ${lead}%, transparent) 18%,
        color-mix(in srgb, ${surfaceColor} ${mid}%, transparent) 48%,
        color-mix(in srgb, ${surfaceColor} ${tail}%, transparent) 76%,
        transparent 100%)`;
    case "bottom":
      return `linear-gradient(to top,
        color-mix(in srgb, ${surfaceColor} ${lead}%, transparent) 0%,
        color-mix(in srgb, ${surfaceColor} ${lead}%, transparent) 18%,
        color-mix(in srgb, ${surfaceColor} ${mid}%, transparent) 48%,
        color-mix(in srgb, ${surfaceColor} ${tail}%, transparent) 76%,
        transparent 100%)`;
    case "left":
      return `linear-gradient(to right,
        color-mix(in srgb, ${surfaceColor} ${lead}%, transparent) 0%,
        color-mix(in srgb, ${surfaceColor} ${lead}%, transparent) 18%,
        color-mix(in srgb, ${surfaceColor} ${mid}%, transparent) 48%,
        color-mix(in srgb, ${surfaceColor} ${tail}%, transparent) 76%,
        transparent 100%)`;
    case "right":
      return `linear-gradient(to left,
        color-mix(in srgb, ${surfaceColor} ${lead}%, transparent) 0%,
        color-mix(in srgb, ${surfaceColor} ${lead}%, transparent) 18%,
        color-mix(in srgb, ${surfaceColor} ${mid}%, transparent) 48%,
        color-mix(in srgb, ${surfaceColor} ${tail}%, transparent) 76%,
        transparent 100%)`;
  }
}

export function ProgressiveBlurOverlay({
  direction = "bottom",
  tintOpacity = 1,
  className,
  style,
  ...props
}: ProgressiveBlurOverlayProps) {
  const overlayStyle: CSSProperties = {
    pointerEvents: "none",
    position: "absolute",
    overflow: "hidden",
    borderRadius: "inherit",
    ...style,
  };

  return (
    <div
      className={className}
      style={overlayStyle}
      {...props}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          background: buildTintGradient(direction, tintOpacity),
        }}
      />
    </div>
  );
}
