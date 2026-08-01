/**
 * FeatureCard Component
 *
 * A card displaying a preview image (or placeholder), title, description,
 * and an optional "Experimental" badge. Used on the Feature Cards screen
 * to showcase what Interpreter can do.
 */

import { ReactNode } from 'react';
import { ExperimentalBadge } from './ExperimentalBadge';

interface FeatureCardProps {
  /** Title displayed beneath the image */
  title: string;
  /** Short description of the feature */
  description: string;
  /** If true, an "Experimental" badge is shown */
  experimental?: boolean;
  /** Optional preview image URL. When absent a colored placeholder is rendered. */
  imageUrl?: string;
  /** Icon element rendered inside the placeholder when no imageUrl is provided */
  placeholderIcon?: ReactNode;
  /** Background color class for the placeholder (e.g. "bg-blue-500/10") */
  placeholderColor?: string;
}

export function FeatureCard({
  title,
  description,
  experimental,
  imageUrl,
  placeholderIcon,
  placeholderColor = 'bg-muted/50',
}: FeatureCardProps) {
  return (
    <div className="flex flex-col gap-2.5">
      {/* Image / Placeholder */}
      <div
        className={`relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-[16px] ${placeholderColor}`}
        style={{
          border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 34%, transparent)',
          backgroundColor: imageUrl
            ? 'color-mix(in oklch, var(--oa-bg-app) 90%, var(--oa-bg-input) 10%)'
            : 'color-mix(in oklch, var(--oa-bg-app) 84%, var(--oa-bg-subtle) 16%)',
        }}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={title}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
            {placeholderIcon ?? (
              <span className="text-3xl opacity-40">{title.charAt(0)}</span>
            )}
          </div>
        )}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8"
          style={{
            background: 'linear-gradient(to top, color-mix(in oklch, var(--oa-bg-app) 10%, transparent), transparent)',
          }}
        />
      </div>

      {/* Content */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-medium text-[var(--oa-text-strong)]">{title}</span>
          {experimental && <ExperimentalBadge />}
        </div>
        <p className="text-[13px] leading-5 text-[var(--oa-text-muted)]">{description}</p>
      </div>
    </div>
  );
}
