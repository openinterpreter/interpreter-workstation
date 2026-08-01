/**
 * VisionScreen (Screen 9)
 *
 * Compact manifesto-style copy for the Interpreter vision page.
 * Content stays bucket-aware, but intentionally brief.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '../../ui/button';
import { OnboardingHeading, OnboardingScreenShell } from '../components/OnboardingScreenShell';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Bucket = 'non-developer' | 'developer' | 'developer-local-ai';

export interface Persona {
  bucket: Bucket;
  subCategories: string[];
  detectedTools?: string[];
}

interface VisionScreenProps {
  bucket: Bucket;
  persona: Persona;
  onNext: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pick the human-readable names of detected tools that match any of the given keywords. */
function matchDetectedTools(
  detectedTools: string[] | undefined,
  keywords: string[],
): string[] {
  if (!detectedTools || detectedTools.length === 0) return [];
  const lower = keywords.map((k) => k.toLowerCase());
  return detectedTools.filter((t) =>
    lower.some((kw) => t.toLowerCase().includes(kw)),
  );
}

function formatToolList(tools: string[]): string {
  if (tools.length === 0) return '';
  if (tools.length === 1) return tools[0];
  if (tools.length === 2) return `${tools[0]} and ${tools[1]}`;
  return `${tools.slice(0, -1).join(', ')}, and ${tools[tools.length - 1]}`;
}

const GENERAL_TOOL_KEYWORDS = [
  'vscode', 'vs code', 'docker', 'git', 'figma', 'blender', 'premiere',
  'excel', 'word', 'pdf', 'notion', 'obsidian', 'ableton', 'xcode',
];

function buildToolAppendage(t: TFunction, detectedTools: string[] | undefined): string[] {
  const matched = Array.from(
    new Set(matchDetectedTools(detectedTools, GENERAL_TOOL_KEYWORDS)),
  );
  if (matched.length === 0) return [];

  return [
    t('onboarding.vision.toolAppendage', { tools: formatToolList(matched.slice(0, 3)) }),
  ];
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

interface VisionContent {
  heading: string;
  paragraphs: string[];
  appendages: string[];
}

function buildNonDeveloperVision(t: TFunction, persona: Persona): VisionContent {
  const appendages = buildToolAppendage(t, persona.detectedTools);
  return {
    heading: t('onboarding.vision.nonDev.heading'),
    paragraphs: [
      t('onboarding.vision.nonDev.paragraph1'),
      t('onboarding.vision.nonDev.paragraph2'),
    ],
    appendages,
  };
}

function buildDeveloperVision(t: TFunction, persona: Persona): VisionContent {
  const appendages = buildToolAppendage(t, persona.detectedTools);
  return {
    heading: t('onboarding.vision.dev.heading'),
    paragraphs: [
      t('onboarding.vision.dev.paragraph1'),
      t('onboarding.vision.dev.paragraph2'),
    ],
    appendages,
  };
}

function buildDeveloperLocalAIVision(t: TFunction, persona: Persona): VisionContent {
  const appendages = buildToolAppendage(t, persona.detectedTools);

  return {
    heading: t('onboarding.vision.devLocal.heading'),
    paragraphs: [
      t('onboarding.vision.devLocal.paragraph1'),
      t('onboarding.vision.devLocal.paragraph2'),
    ],
    appendages,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VisionScreen({ bucket, persona, onNext }: VisionScreenProps) {
  const { t } = useTranslation();

  const content = useMemo(() => {
    switch (bucket) {
      case 'non-developer':
        return buildNonDeveloperVision(t, persona);
      case 'developer':
        return buildDeveloperVision(t, persona);
      case 'developer-local-ai':
        return buildDeveloperLocalAIVision(t, persona);
      default:
        return buildDeveloperVision(t, persona);
    }
  }, [bucket, persona, t]);

  return (
    <OnboardingScreenShell size="medium" align="top" className="overflow-auto py-12 sm:py-16">
      <div className="space-y-5">
        <OnboardingHeading
          title={t('onboarding.vision.title')}
          description={content.heading}
          align="left"
        />

        <div className="space-y-4">
          {content.paragraphs.map((paragraph, i) => (
            <p
              key={i}
              className="text-[14px] leading-6 text-[var(--oa-text-muted)]"
            >
              {paragraph}
            </p>
          ))}

          {content.appendages.map((appendage, i) => (
            <p
              key={`appendage-${i}`}
              className="text-[14px] leading-6 text-[var(--oa-text-muted)]"
            >
              {appendage}
            </p>
          ))}
        </div>

        <div className="flex items-center gap-2.5 pt-1">
          <Button
            onClick={onNext}
            size="lg"
            className="rounded-full px-6"
          >
            {t('onboarding.common.continue')}
          </Button>
          <span className="text-ui-xs text-[var(--oa-text-muted)]">
            {t('onboarding.common.pressEnter')}
          </span>
        </div>
      </div>
    </OnboardingScreenShell>
  );
}
